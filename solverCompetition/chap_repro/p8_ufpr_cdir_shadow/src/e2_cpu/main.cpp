#include <Highs.h>
#include <gurobi_c.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <mutex>
#include <numeric>
#include <optional>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>
#include <unistd.h>

#include "../fpr/lp_fixing_strategy.hpp"

namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;

constexpr double kConstraintTolerance = 1e-6;
constexpr double kIntegerTolerance = 1e-5;
constexpr double kBoundTolerance = 1e-9;
constexpr double kFiniteThreshold = 1e20;
constexpr double kRepairNoise = 0.75;
constexpr int kRepairIterationLimit = 200;

std::atomic<int64_t> g_repair_calls{0};
std::atomic<int64_t> g_successful_repairs{0};
std::atomic<int64_t> g_backtracks{0};
std::atomic<int64_t> g_repair_event_id{0};
std::atomic<int64_t> g_printed_repair_events{0};
std::mutex g_repair_log_mutex;
bool g_p7c_domain_debug = false;

struct RuntimeFprMetrics {
  int64_t propagation_calls = 0;
  int64_t repair_iterations = 0;
  int64_t repair_max_iterations = 0;
  int64_t trail_push_count = 0;
  int64_t backtrack_calls = 0;
  int64_t rollback_domain_changes = 0;
  int64_t max_trail_depth = 0;
  double propagation_time_sec = 0.0;
  double repair_time_sec = 0.0;
  double backtracking_time_sec = 0.0;
};

thread_local RuntimeFprMetrics* g_runtime_fpr_metrics = nullptr;

enum class VarType { Continuous, Integer, Binary, SemiContinuous, SemiInteger };
enum class CandidateSource { LP, FPR, FEASPUMP, CPU_TABU };
enum class FprStrategy { MostIntegral, LpConfidence, ReducedCostAware };

const char* sourceName(CandidateSource source) {
  switch (source) {
    case CandidateSource::LP: return "LP";
    case CandidateSource::FPR: return "FPR";
    case CandidateSource::FEASPUMP: return "FEASPUMP";
    case CandidateSource::CPU_TABU: return "CPU_TABU";
  }
  return "UNKNOWN";
}

bool finiteLower(double value) { return std::isfinite(value) && value > -kFiniteThreshold; }
bool finiteUpper(double value) { return std::isfinite(value) && value < kFiniteThreshold; }

struct Evaluation {
  double objective = 0.0;
  double max_row_violation = 0.0;
  double sum_row_violation = 0.0;
  double max_bound_violation = 0.0;
  double sum_bound_violation = 0.0;
  double max_integrality_violation = 0.0;
  int64_t violated_rows = 0;
  int64_t fractional_integer_variables = 0;
  bool integer_feasible = false;
  bool row_feasible = false;

  double totalViolation() const {
    return sum_row_violation + sum_bound_violation + max_integrality_violation;
  }
};

struct MIPModel {
  int64_t n_rows = 0;
  int64_t n_cols = 0;
  bool minimize = true;
  double objective_offset = 0.0;
  std::vector<double> obj;
  std::vector<double> lb;
  std::vector<double> ub;
  std::vector<double> row_lb;
  std::vector<double> row_ub;
  std::vector<VarType> var_type;
  std::vector<std::string> col_names;
  std::vector<std::string> row_names;
  std::vector<HighsInt> row_start;
  std::vector<HighsInt> row_index;
  std::vector<double> row_value;
  std::vector<int> integer_columns;
  HighsModel highs_model;
};

struct CandidateSolution {
  std::vector<double> x;
  Evaluation eval;
  CandidateSource source = CandidateSource::LP;
  int64_t iteration = 0;
  double timestamp = 0.0;
};

class SolutionPool {
 public:
  SolutionPool(bool minimize, size_t capacity) : minimize_(minimize), capacity_(capacity) {}

  void insert(CandidateSolution candidate) {
    std::lock_guard<std::mutex> lock(mutex_);
    candidates_.push_back(std::move(candidate));
    if (candidates_.size() > capacity_) {
      auto worst = std::max_element(candidates_.begin(), candidates_.end(), [&](const auto& a, const auto& b) {
        return better(a, b);
      });
      if (worst != candidates_.end()) candidates_.erase(worst);
    }
  }

  std::optional<CandidateSolution> bestFeasible() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::optional<CandidateSolution> best;
    for (const auto& candidate : candidates_) {
      if (!candidate.eval.integer_feasible || !candidate.eval.row_feasible) continue;
      if (!best || objectiveBetter(candidate.eval.objective, best->eval.objective)) best = candidate;
    }
    return best;
  }

  std::optional<CandidateSolution> bestInfeasible() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::optional<CandidateSolution> best;
    for (const auto& candidate : candidates_) {
      if (candidate.eval.integer_feasible && candidate.eval.row_feasible) continue;
      if (!best || candidate.eval.totalViolation() < best->eval.totalViolation() - 1e-12 ||
          (std::abs(candidate.eval.totalViolation() - best->eval.totalViolation()) <= 1e-12 &&
           objectiveBetter(candidate.eval.objective, best->eval.objective))) {
        best = candidate;
      }
    }
    return best;
  }

  size_t size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return candidates_.size();
  }

  std::vector<CandidateSolution> snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return candidates_;
  }

 private:
  bool objectiveBetter(double lhs, double rhs) const { return minimize_ ? lhs < rhs : lhs > rhs; }

  bool better(const CandidateSolution& lhs, const CandidateSolution& rhs) const {
    const bool lhs_feasible = lhs.eval.integer_feasible && lhs.eval.row_feasible;
    const bool rhs_feasible = rhs.eval.integer_feasible && rhs.eval.row_feasible;
    if (lhs_feasible != rhs_feasible) return lhs_feasible;
    if (lhs_feasible) return objectiveBetter(lhs.eval.objective, rhs.eval.objective);
    if (lhs.eval.totalViolation() != rhs.eval.totalViolation())
      return lhs.eval.totalViolation() < rhs.eval.totalViolation();
    return objectiveBetter(lhs.eval.objective, rhs.eval.objective);
  }

  bool minimize_;
  size_t capacity_;
  mutable std::mutex mutex_;
  std::vector<CandidateSolution> candidates_;
};

MIPModel loadModel(const std::string& filename) {
  Highs reader;
  reader.setOptionValue("output_flag", false);
  if (reader.readModel(filename) != HighsStatus::kOk) throw std::runtime_error("HiGHS failed to read model");

  MIPModel model;
  model.highs_model = reader.getModel();
  HighsLp lp = model.highs_model.lp_;
  lp.ensureRowwise();
  model.n_rows = lp.num_row_;
  model.n_cols = lp.num_col_;
  model.minimize = lp.sense_ == ObjSense::kMinimize;
  model.objective_offset = lp.offset_;
  model.obj = lp.col_cost_;
  model.lb = lp.col_lower_;
  model.ub = lp.col_upper_;
  model.row_lb = lp.row_lower_;
  model.row_ub = lp.row_upper_;
  model.col_names = lp.col_names_;
  model.row_names = lp.row_names_;
  if (model.col_names.size() != static_cast<size_t>(model.n_cols)) {
    model.col_names.resize(model.n_cols);
    for (int64_t j = 0; j < model.n_cols; ++j) {
      if (model.col_names[j].empty()) model.col_names[j] = "x" + std::to_string(j);
    }
  }
  model.row_start = lp.a_matrix_.start_;
  model.row_index = lp.a_matrix_.index_;
  model.row_value = lp.a_matrix_.value_;
  model.var_type.assign(model.n_cols, VarType::Continuous);

  for (int64_t j = 0; j < model.n_cols; ++j) {
    HighsVarType highs_type = HighsVarType::kContinuous;
    if (lp.integrality_.size() == static_cast<size_t>(model.n_cols)) highs_type = lp.integrality_[j];
    switch (highs_type) {
      case HighsVarType::kInteger:
      case HighsVarType::kImplicitInteger:
        if (model.lb[j] >= -kIntegerTolerance && model.ub[j] <= 1.0 + kIntegerTolerance)
          model.var_type[j] = VarType::Binary;
        else
          model.var_type[j] = VarType::Integer;
        model.integer_columns.push_back(static_cast<int>(j));
        break;
      case HighsVarType::kSemiInteger:
        model.var_type[j] = VarType::SemiInteger;
        model.integer_columns.push_back(static_cast<int>(j));
        break;
      case HighsVarType::kSemiContinuous:
        model.var_type[j] = VarType::SemiContinuous;
        break;
      case HighsVarType::kContinuous:
        break;
    }
  }
  return model;
}

bool integralType(VarType type) {
  return type == VarType::Integer || type == VarType::Binary || type == VarType::SemiInteger;
}

struct CanonicalDomainUpdate {
  bool feasible = true;
  bool canonicalized = false;
  double lower = 0.0;
  double upper = 0.0;
  double pre_canonical_crossing = 0.0;
};

CanonicalDomainUpdate canonicalizeDomainUpdate(VarType type, double new_lower,
                                                double new_upper) {
  CanonicalDomainUpdate result;
  result.lower = new_lower;
  result.upper = new_upper;
  if (std::isnan(result.lower) || std::isnan(result.upper)) {
    result.feasible = false;
    return result;
  }

  // Preserve the existing integer propagation semantics: integer bounds are
  // rounded before deciding whether the resulting interval is contradictory.
  if (integralType(type)) {
    if (finiteLower(result.lower))
      result.lower = std::ceil(result.lower - 1e-12);
    if (finiteUpper(result.upper))
      result.upper = std::floor(result.upper + 1e-12);
  }

  if (result.lower <= result.upper) return result;
  result.pre_canonical_crossing = result.lower - result.upper;
  if (integralType(type) ||
      !std::isfinite(result.pre_canonical_crossing) ||
      result.pre_canonical_crossing > kBoundTolerance) {
    result.feasible = false;
    return result;
  }

  // Engineering-only numerical invariant repair for continuous domains. The
  // comparison is inclusive: crossing <= kBoundTolerance is canonicalized.
  const double midpoint = std::midpoint(result.lower, result.upper);
  if (!std::isfinite(midpoint)) {
    result.feasible = false;
    return result;
  }
  result.lower = midpoint;
  result.upper = midpoint;
  result.canonicalized = true;
  return result;
}

#include "fpr_profile.hpp"

Evaluation evaluateSolution(const MIPModel& model, const std::vector<double>& x) {
  if (x.size() != static_cast<size_t>(model.n_cols)) throw std::runtime_error("candidate dimension mismatch");
  Evaluation result;
  result.objective = model.objective_offset;
  for (int64_t j = 0; j < model.n_cols; ++j) {
    result.objective += model.obj[j] * x[j];
    double violation = 0.0;
    if (finiteLower(model.lb[j]) && x[j] < model.lb[j]) violation = model.lb[j] - x[j];
    if (finiteUpper(model.ub[j]) && x[j] > model.ub[j]) violation = std::max(violation, x[j] - model.ub[j]);
    result.max_bound_violation = std::max(result.max_bound_violation, violation);
    result.sum_bound_violation += violation;
    if (integralType(model.var_type[j])) {
      double integer_violation = std::abs(x[j] - std::round(x[j]));
      result.max_integrality_violation = std::max(result.max_integrality_violation, integer_violation);
      if (integer_violation > kIntegerTolerance) ++result.fractional_integer_variables;
    }
  }

  for (int64_t i = 0; i < model.n_rows; ++i) {
    double activity = 0.0;
    for (HighsInt p = model.row_start[i]; p < model.row_start[i + 1]; ++p)
      activity += model.row_value[p] * x[model.row_index[p]];
    double violation = 0.0;
    if (finiteLower(model.row_lb[i]) && activity < model.row_lb[i])
      violation = model.row_lb[i] - activity;
    if (finiteUpper(model.row_ub[i]) && activity > model.row_ub[i])
      violation = std::max(violation, activity - model.row_ub[i]);
    result.max_row_violation = std::max(result.max_row_violation, violation);
    result.sum_row_violation += violation;
    if (violation > kConstraintTolerance) ++result.violated_rows;
  }
  result.integer_feasible = result.max_integrality_violation <= kIntegerTolerance;
  result.row_feasible = result.max_row_violation <= kConstraintTolerance &&
                        result.max_bound_violation <= kConstraintTolerance;
  return result;
}

enum class LpSolveStatus {
  OPTIMAL,
  INFEASIBLE,
  UNBOUNDED,
  TIME_LIMIT,
  ITERATION_LIMIT,
  NUMERICAL_FAILURE,
  SOLVER_ERROR,
  UNKNOWN
};

const char* lpSolveStatusName(LpSolveStatus status) {
  switch (status) {
    case LpSolveStatus::OPTIMAL: return "OPTIMAL";
    case LpSolveStatus::INFEASIBLE: return "INFEASIBLE";
    case LpSolveStatus::UNBOUNDED: return "UNBOUNDED";
    case LpSolveStatus::TIME_LIMIT: return "TIME_LIMIT";
    case LpSolveStatus::ITERATION_LIMIT: return "ITERATION_LIMIT";
    case LpSolveStatus::NUMERICAL_FAILURE: return "NUMERICAL_FAILURE";
    case LpSolveStatus::SOLVER_ERROR: return "SOLVER_ERROR";
    case LpSolveStatus::UNKNOWN: return "UNKNOWN";
  }
  return "UNKNOWN";
}

LpSolveStatus classifyHighsLpStatus(HighsStatus run_status,
                                   HighsModelStatus model_status) {
  switch (model_status) {
    case HighsModelStatus::kOptimal: return LpSolveStatus::OPTIMAL;
    case HighsModelStatus::kInfeasible:
      return LpSolveStatus::INFEASIBLE;
    case HighsModelStatus::kUnbounded:
      return LpSolveStatus::UNBOUNDED;
    case HighsModelStatus::kUnboundedOrInfeasible:
      return LpSolveStatus::UNKNOWN;
    case HighsModelStatus::kTimeLimit: return LpSolveStatus::TIME_LIMIT;
    case HighsModelStatus::kIterationLimit:
      return LpSolveStatus::ITERATION_LIMIT;
    case HighsModelStatus::kPresolveError:
    case HighsModelStatus::kSolveError:
    case HighsModelStatus::kPostsolveError:
      return LpSolveStatus::NUMERICAL_FAILURE;
    case HighsModelStatus::kLoadError:
    case HighsModelStatus::kModelError:
      return LpSolveStatus::SOLVER_ERROR;
    default:
      return run_status == HighsStatus::kError
          ? LpSolveStatus::SOLVER_ERROR : LpSolveStatus::UNKNOWN;
  }
}

struct LpResult {
  bool optimal = false;
  LpSolveStatus lp_status = LpSolveStatus::UNKNOWN;
  std::vector<double> x;
  double objective = 0.0;
  std::string status;
  double elapsed_sec = 0.0;
  int pass_model_status = -1;
  int run_status = -1;
  int64_t simplex_iterations = 0;
  int64_t ipm_iterations = 0;
  int64_t primal_infeasibilities = 0;
  double max_primal_infeasibility = 0.0;
  std::string backend = "HIGHS";
  int raw_solver_status = -1;
  int num_rows = 0;
  int num_cols = 0;
  int num_nonzeros = 0;
  int num_integer_vars = 0;
  int num_binary_vars = 0;
  int method_parameter = -1;
  int threads_parameter = 1;
  int presolve_parameter = -1;
  int seed_parameter = 0;
  double time_limit_parameter = 0.0;
  double feasibility_tolerance = std::numeric_limits<double>::quiet_NaN();
  double optimality_tolerance = std::numeric_limits<double>::quiet_NaN();
  int64_t barrier_iterations = 0;
  double node_count = 0.0;
  double bound_violation = std::numeric_limits<double>::quiet_NaN();
  double constraint_violation = std::numeric_limits<double>::quiet_NaN();
  double dual_violation = std::numeric_limits<double>::quiet_NaN();
  double solver_runtime_sec = 0.0;
};

struct GurobiCompletionContext {
  bool active = false;
  uint64_t task_id = 0;
  uint64_t source_candidate_id = 0;
  std::string source_type = "UNKNOWN";
  int64_t root_checkpoint = -1;
  std::string parent_chain = "UNKNOWN";
  Clock::time_point global_start{};
};

struct GurobiCompletionAudit {
  uint64_t call_id = 0;
  uint64_t task_id = 0;
  uint64_t source_candidate_id = 0;
  std::string source_type;
  int64_t root_checkpoint = -1;
  std::string parent_chain;
  double start_time_sec = std::numeric_limits<double>::quiet_NaN();
  double duration_sec = 0.0;
  int raw_status = -1;
  LpSolveStatus mapped_status = LpSolveStatus::UNKNOWN;
  int num_rows = 0;
  int num_cols = 0;
  int num_nonzeros = 0;
  int num_integer_vars = 0;
  int num_binary_vars = 0;
  int method_parameter = -1;
  std::string actual_algorithm = "UNKNOWN";
  int threads_parameter = 1;
  int presolve_parameter = -1;
  int seed_parameter = 0;
  double time_limit_parameter = 0.0;
  double feasibility_tolerance = std::numeric_limits<double>::quiet_NaN();
  double optimality_tolerance = std::numeric_limits<double>::quiet_NaN();
  int64_t simplex_iterations = 0;
  int64_t barrier_iterations = 0;
  double node_count = 0.0;
  double objective = std::numeric_limits<double>::quiet_NaN();
  double bound_violation = std::numeric_limits<double>::quiet_NaN();
  double constraint_violation = std::numeric_limits<double>::quiet_NaN();
  double dual_violation = std::numeric_limits<double>::quiet_NaN();
};

thread_local GurobiCompletionContext g_gurobi_completion_context;
std::atomic<uint64_t> g_gurobi_completion_call_id{0};
std::atomic<uint64_t> g_gurobi_temp_id{0};
std::mutex g_gurobi_completion_audit_mutex;
std::vector<GurobiCompletionAudit> g_gurobi_completion_audits;

void setGurobiCompletionContext(uint64_t task_id,
                                 uint64_t source_candidate_id,
                                 std::string source_type,
                                 int64_t root_checkpoint,
                                 std::string parent_chain,
                                 Clock::time_point global_start) {
  g_gurobi_completion_context = {
      true, task_id, source_candidate_id, std::move(source_type),
      root_checkpoint, std::move(parent_chain), global_start};
}

void clearGurobiCompletionContext() {
  g_gurobi_completion_context = {};
}

std::vector<GurobiCompletionAudit> gurobiCompletionAuditSnapshot() {
  std::lock_guard<std::mutex> lock(g_gurobi_completion_audit_mutex);
  return g_gurobi_completion_audits;
}

LpSolveStatus classifyGurobiLpStatus(int status) {
  switch (status) {
    case GRB_OPTIMAL: return LpSolveStatus::OPTIMAL;
    case GRB_INFEASIBLE: return LpSolveStatus::INFEASIBLE;
    case GRB_UNBOUNDED: return LpSolveStatus::UNBOUNDED;
    case GRB_TIME_LIMIT: return LpSolveStatus::TIME_LIMIT;
    case GRB_ITERATION_LIMIT: return LpSolveStatus::ITERATION_LIMIT;
    case GRB_NUMERIC:
    case GRB_SUBOPTIMAL: return LpSolveStatus::NUMERICAL_FAILURE;
    case GRB_INF_OR_UNBD: return LpSolveStatus::UNKNOWN;
    default: return LpSolveStatus::UNKNOWN;
  }
}

LpResult solveGurobiCompletionLp(const MIPModel& model,
                                 const std::vector<double>& lower,
                                 const std::vector<double>& upper,
                                 double time_limit_sec) {
  const auto solve_start = Clock::now();
  LpResult result;
  result.backend = "GUROBI";
  result.time_limit_parameter = time_limit_sec;
  const uint64_t call_id = g_gurobi_completion_call_id.fetch_add(1) + 1;
  const double start_time_sec = g_gurobi_completion_context.active
      ? std::chrono::duration<double>(solve_start -
                                     g_gurobi_completion_context.global_start).count()
      : std::numeric_limits<double>::quiet_NaN();

  GRBenv* env = nullptr;
  GRBmodel* grb_model = nullptr;
  std::string temp_model_path;
  auto cleanup = [&]() {
    if (grb_model) GRBfreemodel(grb_model);
    if (env) GRBfreeenv(env);
    if (!temp_model_path.empty()) {
      std::error_code ignored;
      fs::remove(temp_model_path, ignored);
    }
  };
  auto fail = [&](const std::string& status) {
    result.lp_status = LpSolveStatus::SOLVER_ERROR;
    result.status = status;
    result.elapsed_sec =
        std::chrono::duration<double>(Clock::now() - solve_start).count();
  };
  auto grb_error = [&](int code, const std::string& operation) {
    std::string message = operation + "_ERROR_" + std::to_string(code);
    if (env) {
      const char* detail = GRBgeterrormsg(env);
      if (detail && *detail) message += ":" + std::string(detail);
    }
    fail(message);
  };

  if (time_limit_sec <= 0.0) {
    result.lp_status = LpSolveStatus::TIME_LIMIT;
    result.status = lpSolveStatusName(result.lp_status);
    return result;
  }
  if (lower.size() != static_cast<size_t>(model.n_cols) ||
      upper.size() != static_cast<size_t>(model.n_cols)) {
    fail("BOUND_DIMENSION_MISMATCH");
    return result;
  }

  const char* temp_root_env = std::getenv("P8_GUROBI_TMPDIR");
  const fs::path temp_root = temp_root_env && *temp_root_env
      ? fs::path(temp_root_env) : fs::path("/dev/shm");
  const uint64_t temp_id = g_gurobi_temp_id.fetch_add(1) + 1;
  temp_model_path =
      (temp_root / ("chap_p8_gc_" + std::to_string(getpid()) + "_" +
                    std::to_string(temp_id) + ".mps")).string();

  HighsModel working = model.highs_model;
  HighsLp& lp = working.lp_;
  lp.integrality_.assign(lp.num_col_, HighsVarType::kContinuous);
  lp.col_lower_ = lower;
  lp.col_upper_ = upper;
  Highs writer;
  writer.setOptionValue("output_flag", false);
  const HighsStatus pass_status = writer.passModel(std::move(working));
  result.pass_model_status = static_cast<int>(pass_status);
  if (pass_status != HighsStatus::kOk ||
      writer.writeModel(temp_model_path) != HighsStatus::kOk) {
    fail("COMPLETION_MPS_BRIDGE_FAILED");
    cleanup();
    return result;
  }

  int error = GRBemptyenv(&env);
  if (error) {
    grb_error(error, "GRBEMPTYENV");
    cleanup();
    return result;
  }
  const char* isv_key = std::getenv("P8_GUROBI_ISV_KEY");
  if (!isv_key || !*isv_key) {
    fail("P8_GUROBI_ISV_KEY_NOT_SET");
    cleanup();
    return result;
  }
  if ((error = GRBsetintparam(env, "OutputFlag", 1)) ||
      (error = GRBsetintparam(env, "GURO_PAR_ISVEXPIRATION", 0)) ||
      (error = GRBsetstrparam(env, "GURO_PAR_ISVNAME", "Musk")) ||
      (error = GRBsetstrparam(env, "GURO_PAR_ISVAPPNAME", "X")) ||
      (error = GRBsetstrparam(env, "GURO_PAR_ISVKEY", isv_key)) ||
      (error = GRBstartenv(env))) {
    grb_error(error, "GRB_ISV_ENV_START");
    cleanup();
    return result;
  }
  error = GRBreadmodel(env, temp_model_path.c_str(), &grb_model);
  {
    std::error_code ignored;
    fs::remove(temp_model_path, ignored);
    temp_model_path.clear();
  }
  if (error) {
    grb_error(error, "GRB_READ_COMPLETION_MODEL");
    cleanup();
    return result;
  }

  GRBenv* model_env = GRBgetenv(grb_model);
  GRBgetintattr(grb_model, GRB_INT_ATTR_NUMCONSTRS, &result.num_rows);
  GRBgetintattr(grb_model, GRB_INT_ATTR_NUMVARS, &result.num_cols);
  GRBgetintattr(grb_model, GRB_INT_ATTR_NUMNZS, &result.num_nonzeros);
  GRBgetintattr(grb_model, GRB_INT_ATTR_NUMINTVARS, &result.num_integer_vars);
  GRBgetintattr(grb_model, GRB_INT_ATTR_NUMBINVARS, &result.num_binary_vars);
  if (result.num_integer_vars != 0 || result.num_binary_vars != 0) {
    fail("COMPLETION_MODEL_NOT_PURE_LP");
    cleanup();
    return result;
  }

  const double setup_elapsed =
      std::chrono::duration<double>(Clock::now() - solve_start).count();
  const double optimize_limit = std::max(0.0, time_limit_sec - setup_elapsed);
  if (optimize_limit <= 0.0) {
    result.lp_status = LpSolveStatus::TIME_LIMIT;
    result.status = lpSolveStatusName(result.lp_status);
    result.elapsed_sec = setup_elapsed;
    cleanup();
    return result;
  }
  if ((error = GRBsetintparam(model_env, GRB_INT_PAR_THREADS, 1)) ||
      (error = GRBsetintparam(model_env, GRB_INT_PAR_SEED, 0)) ||
      (error = GRBsetdblparam(model_env, GRB_DBL_PAR_TIMELIMIT,
                              optimize_limit))) {
    grb_error(error, "GRB_SET_COMPLETION_PARAMETERS");
    cleanup();
    return result;
  }
  GRBgetintparam(model_env, GRB_INT_PAR_METHOD, &result.method_parameter);
  GRBgetintparam(model_env, GRB_INT_PAR_THREADS, &result.threads_parameter);
  GRBgetintparam(model_env, GRB_INT_PAR_PRESOLVE, &result.presolve_parameter);
  GRBgetintparam(model_env, GRB_INT_PAR_SEED, &result.seed_parameter);
  GRBgetdblparam(model_env, GRB_DBL_PAR_TIMELIMIT,
                 &result.time_limit_parameter);
  GRBgetdblparam(model_env, GRB_DBL_PAR_FEASIBILITYTOL,
                 &result.feasibility_tolerance);
  GRBgetdblparam(model_env, GRB_DBL_PAR_OPTIMALITYTOL,
                 &result.optimality_tolerance);

  error = GRBoptimize(grb_model);
  if (error) {
    grb_error(error, "GRB_OPTIMIZE_COMPLETION");
    cleanup();
    return result;
  }
  GRBgetintattr(grb_model, GRB_INT_ATTR_STATUS, &result.raw_solver_status);
  if (result.raw_solver_status == GRB_INF_OR_UNBD) {
    const double elapsed =
        std::chrono::duration<double>(Clock::now() - solve_start).count();
    const double disambiguation_limit = std::max(0.0, time_limit_sec - elapsed);
    if (disambiguation_limit > 0.0 &&
        GRBsetintparam(model_env, GRB_INT_PAR_DUALREDUCTIONS, 0) == 0 &&
        GRBsetdblparam(model_env, GRB_DBL_PAR_TIMELIMIT,
                       disambiguation_limit) == 0 &&
        GRBreset(grb_model, 0) == 0 && GRBoptimize(grb_model) == 0) {
      GRBgetintattr(grb_model, GRB_INT_ATTR_STATUS,
                    &result.raw_solver_status);
    }
  }
  result.run_status = result.raw_solver_status;
  result.lp_status = classifyGurobiLpStatus(result.raw_solver_status);
  result.status = lpSolveStatusName(result.lp_status);

  double iterations = 0.0;
  GRBgetdblattr(grb_model, GRB_DBL_ATTR_ITERCOUNT, &iterations);
  result.simplex_iterations = static_cast<int64_t>(std::llround(iterations));
  int barrier_iterations = 0;
  GRBgetintattr(grb_model, GRB_INT_ATTR_BARITERCOUNT, &barrier_iterations);
  result.barrier_iterations = barrier_iterations;
  GRBgetdblattr(grb_model, GRB_DBL_ATTR_NODECOUNT, &result.node_count);
  GRBgetdblattr(grb_model, GRB_DBL_ATTR_RUNTIME, &result.solver_runtime_sec);

  int solution_count = 0;
  GRBgetintattr(grb_model, GRB_INT_ATTR_SOLCOUNT, &solution_count);
  if (solution_count > 0) {
    result.x.resize(result.num_cols);
    if (GRBgetdblattrarray(grb_model, GRB_DBL_ATTR_X, 0, result.num_cols,
                           result.x.data()) != 0) {
      result.x.clear();
    } else {
      GRBgetdblattr(grb_model, GRB_DBL_ATTR_OBJVAL, &result.objective);
      GRBgetdblattr(grb_model, GRB_DBL_ATTR_BOUND_VIO,
                    &result.bound_violation);
      GRBgetdblattr(grb_model, GRB_DBL_ATTR_CONSTR_VIO,
                    &result.constraint_violation);
      GRBgetdblattr(grb_model, GRB_DBL_ATTR_DUAL_VIO,
                    &result.dual_violation);
      result.primal_infeasibilities =
          (result.bound_violation > result.feasibility_tolerance ? 1 : 0) +
          (result.constraint_violation > result.feasibility_tolerance ? 1 : 0);
      result.max_primal_infeasibility =
          std::max(result.bound_violation, result.constraint_violation);
    }
  }
  result.optimal = result.raw_solver_status == GRB_OPTIMAL && !result.x.empty();
  result.elapsed_sec =
      std::chrono::duration<double>(Clock::now() - solve_start).count();

  GurobiCompletionAudit audit;
  audit.call_id = call_id;
  audit.task_id = g_gurobi_completion_context.task_id;
  audit.source_candidate_id =
      g_gurobi_completion_context.source_candidate_id;
  audit.source_type = g_gurobi_completion_context.source_type;
  audit.root_checkpoint = g_gurobi_completion_context.root_checkpoint;
  audit.parent_chain = g_gurobi_completion_context.parent_chain;
  audit.start_time_sec = start_time_sec;
  audit.duration_sec = result.elapsed_sec;
  audit.raw_status = result.raw_solver_status;
  audit.mapped_status = result.lp_status;
  audit.num_rows = result.num_rows;
  audit.num_cols = result.num_cols;
  audit.num_nonzeros = result.num_nonzeros;
  audit.num_integer_vars = result.num_integer_vars;
  audit.num_binary_vars = result.num_binary_vars;
  audit.method_parameter = result.method_parameter;
  audit.actual_algorithm = result.barrier_iterations > 0
      ? "BARRIER" : (result.simplex_iterations > 0 ? "SIMPLEX_DEFAULT" : "NONE");
  audit.threads_parameter = result.threads_parameter;
  audit.presolve_parameter = result.presolve_parameter;
  audit.seed_parameter = result.seed_parameter;
  audit.time_limit_parameter = result.time_limit_parameter;
  audit.feasibility_tolerance = result.feasibility_tolerance;
  audit.optimality_tolerance = result.optimality_tolerance;
  audit.simplex_iterations = result.simplex_iterations;
  audit.barrier_iterations = result.barrier_iterations;
  audit.node_count = result.node_count;
  if (!result.x.empty()) audit.objective = result.objective;
  audit.bound_violation = result.bound_violation;
  audit.constraint_violation = result.constraint_violation;
  audit.dual_violation = result.dual_violation;
  {
    std::lock_guard<std::mutex> lock(g_gurobi_completion_audit_mutex);
    g_gurobi_completion_audits.push_back(audit);
  }
  std::cout << std::setprecision(17)
            << "GUROBI_COMPLETION_CALL call_id=" << audit.call_id
            << " task_id=" << audit.task_id
            << " source_candidate_id=" << audit.source_candidate_id
            << " source_type=" << audit.source_type
            << " root_checkpoint=" << audit.root_checkpoint
            << " parent_chain=\"" << audit.parent_chain << "\""
            << " start_time_sec=" << audit.start_time_sec
            << " duration_sec=" << audit.duration_sec
            << " GUROBI_STATUS_RAW=" << audit.raw_status
            << " P8_STATUS_MAPPED=" << lpSolveStatusName(audit.mapped_status)
            << " NumRows=" << audit.num_rows
            << " NumCols=" << audit.num_cols
            << " NumNZs=" << audit.num_nonzeros
            << " NumIntVars=" << audit.num_integer_vars
            << " NumBinVars=" << audit.num_binary_vars
            << " Method=" << audit.method_parameter
            << " actual_algorithm=" << audit.actual_algorithm
            << " Threads=" << audit.threads_parameter
            << " Presolve=" << audit.presolve_parameter
            << " Seed=" << audit.seed_parameter
            << " TimeLimit=" << audit.time_limit_parameter
            << " FeasibilityTol=" << audit.feasibility_tolerance
            << " OptimalityTol=" << audit.optimality_tolerance
            << " SimplexIterations=" << audit.simplex_iterations
            << " BarrierIterations=" << audit.barrier_iterations
            << " NodeCount=" << audit.node_count
            << " Objective=" << audit.objective
            << " max_bound_violation=" << audit.bound_violation
            << " max_constraint_violation=" << audit.constraint_violation
            << " max_dual_violation=" << audit.dual_violation
            << '\n' << std::flush;
  cleanup();
  return result;
}

LpResult solveCpuLp(const MIPModel& model, const std::vector<double>* lower,
                    const std::vector<double>* upper, const std::vector<double>* costs,
                    bool projection_objective, double time_limit_sec) {
  const auto solve_start = Clock::now();
  LpResult result;
  if (time_limit_sec <= 0.0) {
    result.lp_status = LpSolveStatus::TIME_LIMIT;
    result.status = lpSolveStatusName(result.lp_status);
    return result;
  }
  HighsModel working = model.highs_model;
  HighsLp& lp = working.lp_;
  lp.integrality_.assign(lp.num_col_, HighsVarType::kContinuous);
  if (lower) lp.col_lower_ = *lower;
  if (upper) lp.col_upper_ = *upper;
  if (costs) lp.col_cost_ = *costs;
  if (projection_objective) {
    lp.sense_ = ObjSense::kMinimize;
    lp.offset_ = 0.0;
  }

  Highs highs;
  highs.setOptionValue("output_flag", false);
  highs.setOptionValue("threads", 1);
  highs.setOptionValue("time_limit", time_limit_sec);
  const HighsStatus pass_status = highs.passModel(std::move(working));
  result.pass_model_status = static_cast<int>(pass_status);
  if (pass_status != HighsStatus::kOk) {
    result.lp_status = LpSolveStatus::SOLVER_ERROR;
    result.status = "PASS_MODEL_FAILED";
    result.elapsed_sec =
        std::chrono::duration<double>(Clock::now() - solve_start).count();
    return result;
  }
  const HighsStatus run_status = highs.run();
  result.run_status = static_cast<int>(run_status);
  const HighsModelStatus model_status = highs.getModelStatus();
  result.lp_status = classifyHighsLpStatus(run_status, model_status);
  result.status = lpSolveStatusName(result.lp_status);
  const HighsInfo& info = highs.getInfo();
  result.simplex_iterations = info.simplex_iteration_count;
  result.ipm_iterations = info.ipm_iteration_count;
  result.primal_infeasibilities = info.num_primal_infeasibilities;
  result.max_primal_infeasibility = info.max_primal_infeasibility;
  const auto& solution = highs.getSolution();
  result.optimal = run_status == HighsStatus::kOk && model_status == HighsModelStatus::kOptimal &&
                   solution.value_valid;
  if (solution.value_valid) {
    result.x = solution.col_value;
    result.objective = highs.getObjectiveValue();
  }
  result.elapsed_sec =
      std::chrono::duration<double>(Clock::now() - solve_start).count();
  return result;
}

struct PropagationResult {
  bool feasible = true;
  bool time_limit = false;
  int rounds = 0;
  int64_t rows_visited = 0;
  int64_t tightened_bounds = 0;
};

struct RowDomainActivity {
  double min_finite = 0.0;
  double max_finite = 0.0;
  int min_inf_count = 0;
  int max_inf_count = 0;
};

struct DomainTrailEntry {
  int column = -1;
  double old_lower = 0.0;
  double old_upper = 0.0;
  int old_change_step = -1;
};

struct ColumnRowEntry {
  int row = -1;
  double coefficient = 0.0;
};

class ReversibleDomains {
 public:
  explicit ReversibleDomains(const MIPModel& model)
      : model_(model), lower_(model.lb), upper_(model.ub), activities_(model.n_rows),
        column_rows_(model.n_cols), last_change_step_(model.n_cols, -1),
        pending_row_(model.n_rows, 0), current_stamp_(model.n_rows, 0),
        next_stamp_(model.n_rows, 0) {
    pending_rows_.reserve(model.n_rows);
    queue_heap_.reserve(model.n_rows);
    queue_next_.reserve(model.n_rows);
    queue_new_.reserve(model.n_rows);
    for (int64_t i = 0; i < model_.n_rows; ++i) {
      for (HighsInt p = model_.row_start[i]; p < model_.row_start[i + 1]; ++p) {
        const int j = model_.row_index[p];
        const double a = model_.row_value[p];
        column_rows_[j].push_back({static_cast<int>(i), a});
        addContribution(activities_[i], a, lower_[j], upper_[j], 1.0);
      }
    }
  }

  size_t trailPointer() const { return trail_.size(); }
  const std::vector<double>& lower() const { return lower_; }
  const std::vector<double>& upper() const { return upper_; }
  double lower(int j) const { return lower_[j]; }
  double upper(int j) const { return upper_[j]; }
  int lastChangeStep(int j) const { return last_change_step_[j]; }
  const std::vector<ColumnRowEntry>& columnRows(int j) const { return column_rows_[j]; }
  const std::vector<DomainTrailEntry>& trailEntries() const { return trail_; }
  int64_t canonicalizedDomainCount() const {
    return canonicalized_domain_count_;
  }
  double maxPreCanonicalCrossing() const {
    return max_pre_canonical_crossing_;
  }
  int64_t invalidDomainCount() const {
    int64_t invalid = 0;
    for (int64_t j = 0; j < model_.n_cols; ++j)
      if (lower_[j] > upper_[j]) ++invalid;
    return invalid;
  }

  void enqueueAllRows() {
    clearPending();
    for (int64_t i = 0; i < model_.n_rows; ++i) {
      pending_row_[i] = 1;
      pending_rows_.push_back(static_cast<int>(i));
    }
  }

  void clearPending() {
    for (int row : pending_rows_) pending_row_[row] = 0;
    pending_rows_.clear();
  }

  std::vector<int> takePendingRows() {
    std::vector<int> rows;
    rows.swap(pending_rows_);
    for (int row : rows) pending_row_[row] = 0;
    pending_rows_.reserve(model_.n_rows);
    return rows;
  }

  void drainPendingTo(std::vector<int>& out) {
    out.insert(out.end(), pending_rows_.begin(), pending_rows_.end());
    for (int row : pending_rows_) pending_row_[row] = 0;
    pending_rows_.clear();
  }
  std::vector<int>& queueHeap() { return queue_heap_; }
  std::vector<int>& queueNext() { return queue_next_; }
  std::vector<int>& queueNew() { return queue_new_; }

  void requeueRows(const std::vector<int>& rows) {
    for (int row : rows) {
      if (!pending_row_[row]) {
        pending_row_[row] = 1;
        pending_rows_.push_back(row);
      }
    }
  }

  uint32_t beginQueueEpoch() {
    ++queue_epoch_;
    if (queue_epoch_ == 0) {
      std::fill(current_stamp_.begin(), current_stamp_.end(), 0);
      std::fill(next_stamp_.begin(), next_stamp_.end(), 0);
      queue_epoch_ = 1;
    }
    return queue_epoch_;
  }
  bool markCurrent(int row, uint32_t epoch) {
    if (current_stamp_[row] == epoch) return false;
    current_stamp_[row] = epoch;
    return true;
  }
  bool markedCurrent(int row, uint32_t epoch) const {
    return current_stamp_[row] == epoch;
  }
  bool markNext(int row, uint32_t epoch) {
    if (next_stamp_[row] == epoch) return false;
    next_stamp_[row] = epoch;
    return true;
  }

  double rowMin(int i) const {
    return activities_[i].min_inf_count
               ? -std::numeric_limits<double>::infinity()
               : activities_[i].min_finite;
  }

  double rowMax(int i) const {
    return activities_[i].max_inf_count
               ? std::numeric_limits<double>::infinity()
               : activities_[i].max_finite;
  }

  double rowMinExcluding(int i, double a, double lower, double upper) const {
    const double min_bound = a >= 0.0 ? lower : upper;
    const bool current_infinite = (a >= 0.0 && !finiteLower(min_bound)) ||
                                  (a < 0.0 && !finiteUpper(min_bound));
    const int other_infinite =
        activities_[i].min_inf_count - (current_infinite ? 1 : 0);
    if (other_infinite) return -std::numeric_limits<double>::infinity();
    return activities_[i].min_finite -
           (current_infinite ? 0.0 : a * min_bound);
  }

  double rowMaxExcluding(int i, double a, double lower, double upper) const {
    const double max_bound = a >= 0.0 ? upper : lower;
    const bool current_infinite = (a >= 0.0 && !finiteUpper(max_bound)) ||
                                  (a < 0.0 && !finiteLower(max_bound));
    const int other_infinite =
        activities_[i].max_inf_count - (current_infinite ? 1 : 0);
    if (other_infinite) return std::numeric_limits<double>::infinity();
    return activities_[i].max_finite -
           (current_infinite ? 0.0 : a * max_bound);
  }

  double rowViolation(int i) const {
    double violation = 0.0;
    if (finiteLower(model_.row_lb[i]))
      violation = std::max(violation, model_.row_lb[i] - rowMax(i));
    if (finiteUpper(model_.row_ub[i]))
      violation = std::max(violation, rowMin(i) - model_.row_ub[i]);
    return std::max(0.0, violation);
  }

  double shiftedRowViolation(int i, double activity_delta) const {
    double min_activity = rowMin(i);
    double max_activity = rowMax(i);
    if (std::isfinite(min_activity)) min_activity += activity_delta;
    if (std::isfinite(max_activity)) max_activity += activity_delta;
    double violation = 0.0;
    if (finiteLower(model_.row_lb[i]))
      violation = std::max(violation, model_.row_lb[i] - max_activity);
    if (finiteUpper(model_.row_ub[i]))
      violation = std::max(violation, min_activity - model_.row_ub[i]);
    return std::max(0.0, violation);
  }

  std::vector<int> violatedRows() const {
    std::vector<int> rows;
    for (int64_t i = 0; i < model_.n_rows; ++i)
      if (rowViolation(static_cast<int>(i)) > kConstraintTolerance)
        rows.push_back(static_cast<int>(i));
    return rows;
  }

  double totalViolation() const {
    double total = 0.0;
    for (int64_t i = 0; i < model_.n_rows; ++i)
      total += rowViolation(static_cast<int>(i));
    return total;
  }

  bool setDomain(int j, double new_lower, double new_upper, int change_step) {
    const auto profile_start = chap_profile::g_profile
        ? Clock::now() : Clock::time_point{};
    if (finiteLower(model_.lb[j])) new_lower = std::max(new_lower, model_.lb[j]);
    if (finiteUpper(model_.ub[j])) new_upper = std::min(new_upper, model_.ub[j]);
    const double pre_normalize_lower = new_lower;
    const double pre_normalize_upper = new_upper;
    const CanonicalDomainUpdate normalized = canonicalizeDomainUpdate(
        model_.var_type[j], new_lower, new_upper);
    if (!normalized.feasible) return false;
    new_lower = normalized.lower;
    new_upper = normalized.upper;
    if (normalized.canonicalized) {
      ++canonicalized_domain_count_;
      max_pre_canonical_crossing_ = std::max(
          max_pre_canonical_crossing_, normalized.pre_canonical_crossing);
      if (g_p7c_domain_debug) {
        std::lock_guard<std::mutex> lock(g_repair_log_mutex);
        std::cout << std::setprecision(17)
                  << "P7C_CANONICALIZATION step=" << change_step
                  << " column=" << j
                  << " old_lower=" << lower_[j]
                  << " old_upper=" << upper_[j]
                  << " proposed_lower=" << pre_normalize_lower
                  << " proposed_upper=" << pre_normalize_upper
                  << " crossing=" << normalized.pre_canonical_crossing
                  << " canonical=" << normalized.lower << '\n';
      }
    }
    if (std::abs(new_lower - lower_[j]) <= kBoundTolerance &&
        std::abs(new_upper - upper_[j]) <= kBoundTolerance)
      return true;
    const size_t old_capacity = trail_.capacity();
    trail_.push_back({j, lower_[j], upper_[j], last_change_step_[j]});
    if (g_runtime_fpr_metrics) {
      ++g_runtime_fpr_metrics->trail_push_count;
      g_runtime_fpr_metrics->max_trail_depth = std::max<int64_t>(
          g_runtime_fpr_metrics->max_trail_depth,
          static_cast<int64_t>(trail_.size()));
    }
    if (chap_profile::g_profile)
      chap_profile::g_profile->onTrailPush(trail_.capacity() != old_capacity,
                                           trail_.size());
    applyWithoutTrail(j, new_lower, new_upper, change_step);
    if (chap_profile::g_profile)
      chap_profile::g_profile->onDomainSet(
          std::chrono::duration<double>(Clock::now() - profile_start).count());
    return true;
  }

  void backtrack(size_t pointer) {
    const bool measure_runtime = g_runtime_fpr_metrics != nullptr;
    const auto profile_start = (chap_profile::g_profile || measure_runtime)
        ? Clock::now() : Clock::time_point{};
    chap_profile::ScopedPhase profile_phase(chap_profile::Phase::Backtrack);
    int64_t popped = 0;
    int64_t rows = 0;
    std::set<int> levels;
    clearPending();
    while (trail_.size() > pointer) {
      const DomainTrailEntry entry = trail_.back();
      trail_.pop_back();
      ++popped;
      rows += static_cast<int64_t>(column_rows_[entry.column].size());
      levels.insert(entry.old_change_step);
      applyWithoutTrail(entry.column, entry.old_lower, entry.old_upper,
                        entry.old_change_step);
    }
    if (chap_profile::g_profile)
      chap_profile::g_profile->onBacktrack(
          popped, static_cast<int64_t>(levels.size()), rows,
          std::chrono::duration<double>(Clock::now() - profile_start).count());
    if (measure_runtime)
    {
      ++g_runtime_fpr_metrics->backtrack_calls;
      g_runtime_fpr_metrics->rollback_domain_changes += popped;
      g_runtime_fpr_metrics->backtracking_time_sec +=
          std::chrono::duration<double>(Clock::now() - profile_start).count();
    }
  }

 private:
  static void addContribution(RowDomainActivity& activity, double a, double lower,
                              double upper, double sign) {
    const double min_bound = a >= 0.0 ? lower : upper;
    const double max_bound = a >= 0.0 ? upper : lower;
    const bool min_infinite = (a >= 0.0 && !finiteLower(min_bound)) ||
                              (a < 0.0 && !finiteUpper(min_bound));
    const bool max_infinite = (a >= 0.0 && !finiteUpper(max_bound)) ||
                              (a < 0.0 && !finiteLower(max_bound));
    if (min_infinite)
      activity.min_inf_count += static_cast<int>(sign);
    else
      activity.min_finite += sign * a * min_bound;
    if (max_infinite)
      activity.max_inf_count += static_cast<int>(sign);
    else
      activity.max_finite += sign * a * max_bound;
  }

  void applyWithoutTrail(int j, double new_lower, double new_upper,
                         int change_step) {
    const double old_lower = lower_[j];
    const double old_upper = upper_[j];
    const auto activity_start = chap_profile::g_profile
        ? Clock::now() : Clock::time_point{};
    for (const ColumnRowEntry& entry : column_rows_[j]) {
      if (chap_profile::g_profile) chap_profile::g_profile->touchRow(entry.row);
      addContribution(activities_[entry.row], entry.coefficient, lower_[j],
                      upper_[j], -1.0);
      addContribution(activities_[entry.row], entry.coefficient, new_lower,
                      new_upper, 1.0);
    }
    const double activity_sec =
        std::chrono::duration<double>(Clock::now() - activity_start).count();
    lower_[j] = new_lower;
    upper_[j] = new_upper;
    if (lower_[j] > upper_[j])
      throw std::logic_error("domain invariant violated after update");
    last_change_step_[j] = change_step;
    enqueueIncidentRows(j);
    if (chap_profile::g_profile)
      chap_profile::g_profile->onDomainApplied(
          j, old_lower, old_upper, new_lower, new_upper,
          static_cast<int64_t>(column_rows_[j].size()), activity_sec);
  }

  void enqueueIncidentRows(int j) {
    for (const ColumnRowEntry& entry : column_rows_[j]) {
      if (!pending_row_[entry.row]) {
        pending_row_[entry.row] = 1;
        pending_rows_.push_back(entry.row);
      }
    }
  }

  const MIPModel& model_;
  std::vector<double> lower_;
  std::vector<double> upper_;
  std::vector<RowDomainActivity> activities_;
  std::vector<std::vector<ColumnRowEntry>> column_rows_;
  std::vector<int> last_change_step_;
  std::vector<DomainTrailEntry> trail_;
  std::vector<char> pending_row_;
  std::vector<int> pending_rows_;
  std::vector<uint32_t> current_stamp_;
  std::vector<uint32_t> next_stamp_;
  uint32_t queue_epoch_ = 0;
  std::vector<int> queue_heap_;
  std::vector<int> queue_next_;
  std::vector<int> queue_new_;
  int64_t canonicalized_domain_count_ = 0;
  double max_pre_canonical_crossing_ = 0.0;
};

// UC-aware additions are deliberately kept outside ReversibleDomains.  They
// only tighten domains when the corresponding implication is exact in the
// M3 formulation, and use the existing trail/backtrack machinery.
#include "cdir_metrics.hpp"

struct UfprMetrics {
  CdirMetrics cdir;
  int64_t a_propagations = 0;
  int64_t a_u_propagations = 0;
  int64_t a_v_propagations = 0;
  int64_t a_w_propagations = 0;
  int64_t a_minup_propagations = 0;
  int64_t a_mindown_propagations = 0;
  int64_t a_contradictions = 0;
  int64_t a_backtracks = 0;
  double a_time_sec = 0.0;
  int64_t b_segments_attempted = 0;
  int64_t b_segments_accepted = 0;
  int64_t b_segments_rejected = 0;
  int64_t b_segments_fallback_to_single = 0;
  int64_t b_segment_length_total = 0;
  int64_t b_segment_length_max = 0;
  int64_t b_variables_fixed = 0;
  int64_t b_on_segments = 0;
  int64_t b_off_segments = 0;
  int64_t b_contradictions = 0;
  double b_time_sec = 0.0;
  double b_anchor_guidance_time_sec = 0.0;
  double b_segment_construction_time_sec = 0.0;
  double b_domain_inspection_time_sec = 0.0;
  double b_tentative_fixing_time_sec = 0.0;
  double b_generic_propagation_time_sec = 0.0;
  double b_contradiction_check_time_sec = 0.0;
  double b_repairwalk_time_sec = 0.0;
  double b_backtrack_rollback_time_sec = 0.0;
  double b_single_fallback_time_sec = 0.0;
  double b_metadata_time_sec = 0.0;
  int64_t b_generic_propagation_calls = 0;
  int64_t b_propagation_rounds = 0;
  int64_t b_max_propagation_rounds = 0;
  int64_t b_rows_visited = 0;
  int64_t b_domain_changes_from_propagation = 0;
  int64_t b_propagated_fixes = 0;
  int64_t b_no_op_segments = 0;
  int64_t b_propagation_after_no_op = 0;
  double b_time_after_no_op_sec = 0.0;
  int64_t b_intra_task_duplicates = 0;
  int64_t b_identical_local_state_repeats = 0;
  int64_t b_repeated_anchor_selections = 0;
  int64_t b_reject_opposite_fixed = 0;
  int64_t b_reject_propagation_contradiction = 0;
  int64_t b_reject_domain_empty = 0;
  int64_t b_reject_other = 0;
  std::array<int64_t, 5> b_segment_length_counts{};
  std::array<int64_t, 5> b_new_fix_counts{};
  std::vector<double> b_propagation_call_times_sec;
  std::vector<double> b_segment_construction_times_sec;
  std::unordered_map<uint64_t, int64_t> b_fingerprint_counts;
  std::unordered_map<uint64_t, int64_t> b_local_state_counts;
  std::unordered_map<uint64_t, int64_t> b_anchor_counts;
  bool c1_reference_available = true;
  bool c1_mapping_validated = false;
  int64_t c1_segments_checked = 0;
  int64_t c1_off_segments_checked = 0;
  int64_t c1_on_segments_checked = 0;
  int64_t c1_segments_pass = 0;
  int64_t c1_segments_shadow_reject = 0;
  int64_t c1_off_reject_count = 0;
  int64_t c1_on_reject_count = 0;
  int64_t c1_energy_reject_count = 0;
  int64_t c1_reserve_reject_count = 0;
  int64_t c1_both_energy_reserve_reject_count = 0;
  int64_t c1_period_checks = 0;
  int64_t c1_off_period_fails = 0;
  int64_t c1_on_period_fails = 0;
  int64_t c1_reject_and_later_contradiction = 0;
  int64_t c1_reject_but_no_contradiction = 0;
  int64_t c1_pass_but_later_contradiction = 0;
  int64_t c1_rejects_associated_with_repairwalk_failures = 0;
  double c1_total_time_sec = 0.0;
  double c1_max_time_per_segment_sec = 0.0;
  double c1_repairwalk_time_after_pass_sec = 0.0;
  double c1_repairwalk_time_after_reject_sec = 0.0;
  double c1_delta_off_total = 0.0;
  double c1_thermal_up_total = 0.0;
  double c1_storage_up_total = 0.0;
  double c1_delta_on_total = 0.0;
  double c1_thermal_down_total = 0.0;
  double c1_storage_down_total = 0.0;
  std::vector<double> c1_m_off;
  std::vector<double> c1_m_on;
  std::vector<double> c1_reserve_margin_off;
  int64_t c_guard_checks = 0;
  int64_t c_infeasible_states = 0;
  int64_t c_backtracks_avoiding_completion = 0;
  double c_time_sec = 0.0;
  double c_margin_min = std::numeric_limits<double>::infinity();
};

struct UcModelMap {
  int thermal_units = 0;
  int periods = 0;
  int storage_units = 0;
  std::vector<std::vector<int>> commitment;  // alpha[i,t]
  std::vector<std::vector<int>> startup;     // u[i,t]
  std::vector<std::vector<int>> shutdown;    // d[i,t]
  std::vector<std::vector<int>> dispatch;    // P[i,t]
  std::vector<std::vector<int>> generation_upper_row;
  std::vector<std::vector<int>> generation_lower_row;
  std::vector<std::vector<int>> ramp_up_row;
  std::vector<std::vector<int>> ramp_down_row;
  std::vector<std::vector<double>> pmax;
  std::vector<std::vector<double>> pmin;
  std::vector<int> reserve_row;
  std::vector<double> reserve_requirement;
  std::vector<std::vector<int>> storage_dispatch;  // P_gen[s,t]
  std::vector<std::vector<int>> storage_gen_mode;  // x_gen[s,t]
  std::vector<std::vector<int>> storage_pump_mode; // x_pump[s,t]
  std::vector<std::vector<double>> storage_pmax;
  std::vector<std::vector<double>> storage_pump_capacity;
  std::vector<int> min_up;
  std::vector<int> min_down;
  std::vector<int> col_unit;
  std::vector<int> col_time;
  std::vector<char> col_kind;  // c=commitment, v=startup, w=shutdown
  std::vector<int> capacity_rows;
  bool storage_present = false;
  bool power_transfer_mapping_validated = false;
  bool reserve_thermal_only = false;
};

bool parseUcIndexedName(const std::string& name, const std::string& prefix,
                        int& unit, int& time) {
  if (name.rfind(prefix, 0) != 0) return false;
  char tail = '\0';
  return std::sscanf(name.c_str() + prefix.size(), "[%d,%d]%c", &unit, &time,
                     &tail) == 2 && unit > 0 && time > 0;
}

UcModelMap buildUcModelMap(const MIPModel& model) {
  UcModelMap map;
  int max_unit = 0, max_time = 0, max_storage = 0;
  for (const std::string& name : model.col_names) {
    int i = 0, t = 0;
    if (parseUcIndexedName(name, "alpha", i, t) ||
        parseUcIndexedName(name, "u", i, t) ||
        parseUcIndexedName(name, "d", i, t) ||
        parseUcIndexedName(name, "P", i, t)) {
      max_unit = std::max(max_unit, i);
      max_time = std::max(max_time, t);
    }
    if (parseUcIndexedName(name, "x_gen", i, t) ||
        parseUcIndexedName(name, "P_gen", i, t) ||
        parseUcIndexedName(name, "x_pump", i, t)) {
      max_storage = std::max(max_storage, i);
      max_time = std::max(max_time, t);
      map.storage_present = true;
    }
  }
  map.thermal_units = max_unit;
  map.periods = max_time;
  map.storage_units = max_storage;
  map.commitment.assign(max_unit, std::vector<int>(max_time, -1));
  map.startup.assign(max_unit, std::vector<int>(max_time, -1));
  map.shutdown.assign(max_unit, std::vector<int>(max_time, -1));
  map.dispatch.assign(max_unit, std::vector<int>(max_time, -1));
  map.generation_upper_row.assign(max_unit, std::vector<int>(max_time, -1));
  map.generation_lower_row.assign(max_unit, std::vector<int>(max_time, -1));
  map.ramp_up_row.assign(max_unit, std::vector<int>(max_time, -1));
  map.ramp_down_row.assign(max_unit, std::vector<int>(max_time, -1));
  map.pmax.assign(max_unit, std::vector<double>(max_time, 0.0));
  map.pmin.assign(max_unit, std::vector<double>(max_time, 0.0));
  map.reserve_row.assign(max_time, -1);
  map.reserve_requirement.assign(max_time, 0.0);
  map.storage_dispatch.assign(max_storage, std::vector<int>(max_time, -1));
  map.storage_gen_mode.assign(max_storage, std::vector<int>(max_time, -1));
  map.storage_pump_mode.assign(max_storage, std::vector<int>(max_time, -1));
  map.storage_pmax.assign(max_storage, std::vector<double>(max_time, 0.0));
  map.storage_pump_capacity.assign(max_storage,
                                   std::vector<double>(max_time, 0.0));
  map.min_up.assign(max_unit, 1);
  map.min_down.assign(max_unit, 1);
  map.col_unit.assign(model.n_cols, -1);
  map.col_time.assign(model.n_cols, -1);
  map.col_kind.assign(model.n_cols, 0);
  for (int j = 0; j < model.n_cols; ++j) {
    int i = 0, t = 0;
    char kind = 0;
    std::vector<std::vector<int>>* target = nullptr;
    if (parseUcIndexedName(model.col_names[j], "alpha", i, t)) {
      kind = 'c'; target = &map.commitment;
    } else if (parseUcIndexedName(model.col_names[j], "u", i, t)) {
      kind = 'v'; target = &map.startup;
    } else if (parseUcIndexedName(model.col_names[j], "d", i, t)) {
      kind = 'w'; target = &map.shutdown;
    } else if (parseUcIndexedName(model.col_names[j], "P", i, t) &&
               i <= max_unit && t <= max_time) {
      map.dispatch[i - 1][t - 1] = j;
    } else if (parseUcIndexedName(model.col_names[j], "P_gen", i, t) &&
               i <= max_storage && t <= max_time) {
      map.storage_dispatch[i - 1][t - 1] = j;
    } else if (parseUcIndexedName(model.col_names[j], "x_gen", i, t) &&
               i <= max_storage && t <= max_time) {
      map.storage_gen_mode[i - 1][t - 1] = j;
    } else if (parseUcIndexedName(model.col_names[j], "x_pump", i, t) &&
               i <= max_storage && t <= max_time) {
      map.storage_pump_mode[i - 1][t - 1] = j;
    }
    if (target && i <= max_unit && t <= max_time) {
      (*target)[i - 1][t - 1] = j;
      map.col_unit[j] = i - 1;
      map.col_time[j] = t - 1;
      map.col_kind[j] = kind;
    }
  }
  for (int r = 0; r < model.n_rows; ++r) {
    const std::string& name = model.row_names[r];
    int i = 0, t = 0;
    if (parseUcIndexedName(name, "thermal_generation_upper", i, t) &&
        i <= max_unit && t <= max_time) {
      map.generation_upper_row[i - 1][t - 1] = r;
      double p_coefficient = 0.0, alpha_coefficient = 0.0;
      for (HighsInt p = model.row_start[r]; p < model.row_start[r + 1]; ++p) {
        const int column = model.row_index[p];
        if (column == map.dispatch[i - 1][t - 1])
          p_coefficient += model.row_value[p];
        if (column == map.commitment[i - 1][t - 1])
          alpha_coefficient += model.row_value[p];
      }
      if (std::abs(p_coefficient) > 1e-15)
        map.pmax[i - 1][t - 1] = -alpha_coefficient / p_coefficient;
    }
    if (parseUcIndexedName(name, "thermal_generation_lower", i, t) &&
        i <= max_unit && t <= max_time) {
      map.generation_lower_row[i - 1][t - 1] = r;
      double p_coefficient = 0.0, alpha_coefficient = 0.0;
      for (HighsInt p = model.row_start[r]; p < model.row_start[r + 1]; ++p) {
        const int column = model.row_index[p];
        if (column == map.dispatch[i - 1][t - 1])
          p_coefficient += model.row_value[p];
        if (column == map.commitment[i - 1][t - 1])
          alpha_coefficient += model.row_value[p];
      }
      if (std::abs(p_coefficient) > 1e-15)
        map.pmin[i - 1][t - 1] = -alpha_coefficient / p_coefficient;
    }
    if ((parseUcIndexedName(name, "thermal_ramp_up", i, t) ||
         parseUcIndexedName(name, "thermal_ramp_up_initial", i, t)) &&
        i <= max_unit && t <= max_time)
      map.ramp_up_row[i - 1][t - 1] = r;
    if ((parseUcIndexedName(name, "thermal_ramp_down", i, t) ||
         parseUcIndexedName(name, "thermal_ramp_down_initial", i, t)) &&
        i <= max_unit && t <= max_time)
      map.ramp_down_row[i - 1][t - 1] = r;
    if (parseUcIndexedName(name, "psh_generation_upper", i, t) &&
        i <= max_storage && t <= max_time) {
      double p_coefficient = 0.0, mode_coefficient = 0.0;
      for (HighsInt p = model.row_start[r]; p < model.row_start[r + 1]; ++p) {
        const int column = model.row_index[p];
        if (column == map.storage_dispatch[i - 1][t - 1])
          p_coefficient += model.row_value[p];
        if (column == map.storage_gen_mode[i - 1][t - 1])
          mode_coefficient += model.row_value[p];
      }
      if (std::abs(p_coefficient) > 1e-15)
        map.storage_pmax[i - 1][t - 1] =
            -mode_coefficient / p_coefficient;
    }
    if (parseUcIndexedName(name, "system_reserve", i, t)) {
      // A single-index row is parsed as i with t left at zero.
    }
    int single_time = 0;
    char single_tail = '\0';
    if (std::sscanf(name.c_str(), "system_reserve[%d]%c", &single_time,
                    &single_tail) == 1 &&
        single_time > 0 && single_time <= max_time) {
      map.reserve_row[single_time - 1] = r;
      map.reserve_requirement[single_time - 1] = model.row_lb[r];
    }
    if (std::sscanf(name.c_str(), "system_balance[%d]%c", &single_time,
                    &single_tail) == 1 &&
        single_time > 0 && single_time <= max_time) {
      for (HighsInt p = model.row_start[r]; p < model.row_start[r + 1]; ++p) {
        const int column = model.row_index[p];
        int storage = 0, period = 0;
        if (parseUcIndexedName(model.col_names[column], "x_pump", storage,
                               period) &&
            storage <= max_storage && period == single_time)
          map.storage_pump_capacity[storage - 1][period - 1] =
              -model.row_value[p];
      }
    }
    if (parseUcIndexedName(name, "thermal_minimum_up", i, t) &&
        i <= max_unit) {
      int count = 0;
      for (HighsInt p = model.row_start[r]; p < model.row_start[r + 1]; ++p)
        if (map.col_kind[model.row_index[p]] == 'v' &&
            map.col_unit[model.row_index[p]] == i - 1 &&
            model.row_value[p] > 0.0)
          ++count;
      map.min_up[i - 1] = std::max(map.min_up[i - 1], count);
    }
    if (parseUcIndexedName(name, "thermal_minimum_down", i, t) &&
        i <= max_unit) {
      int count = 0;
      for (HighsInt p = model.row_start[r]; p < model.row_start[r + 1]; ++p)
        if (map.col_kind[model.row_index[p]] == 'w' &&
            map.col_unit[model.row_index[p]] == i - 1 &&
            model.row_value[p] > 0.0)
          ++count;
      map.min_down[i - 1] = std::max(map.min_down[i - 1], count);
    }
    if (name.rfind("system_balance[", 0) == 0 ||
        name.rfind("system_reserve[", 0) == 0)
      map.capacity_rows.push_back(r);
  }
  bool complete_thermal = max_unit > 0 && max_time > 0;
  for (int i = 0; i < max_unit && complete_thermal; ++i)
    for (int t = 0; t < max_time; ++t)
      if (map.commitment[i][t] < 0 || map.startup[i][t] < 0 ||
          map.shutdown[i][t] < 0 || map.dispatch[i][t] < 0 ||
          map.generation_upper_row[i][t] < 0 ||
          map.generation_lower_row[i][t] < 0 ||
          map.ramp_up_row[i][t] < 0 || map.ramp_down_row[i][t] < 0 ||
          !(map.pmax[i][t] >= map.pmin[i][t])) {
        complete_thermal = false;
        break;
      }
  bool complete_storage = max_storage > 0;
  for (int s = 0; s < max_storage && complete_storage; ++s)
    for (int t = 0; t < max_time; ++t)
      if (map.storage_dispatch[s][t] < 0 ||
          map.storage_gen_mode[s][t] < 0 ||
          map.storage_pump_mode[s][t] < 0 ||
          map.storage_pmax[s][t] <= 0.0 ||
          map.storage_pump_capacity[s][t] <= 0.0) {
        complete_storage = false;
        break;
      }
  bool reserve_thermal_only = true;
  for (int t = 0; t < max_time; ++t) {
    const int row = map.reserve_row[t];
    if (row < 0) {
      reserve_thermal_only = false;
      break;
    }
    for (HighsInt p = model.row_start[row]; p < model.row_start[row + 1]; ++p) {
      const std::string& column_name = model.col_names[model.row_index[p]];
      int unit = 0, period = 0;
      if (!parseUcIndexedName(column_name, "P", unit, period) &&
          !parseUcIndexedName(column_name, "alpha", unit, period)) {
        reserve_thermal_only = false;
        break;
      }
    }
  }
  map.reserve_thermal_only = reserve_thermal_only;
  map.power_transfer_mapping_validated =
      complete_thermal && complete_storage && reserve_thermal_only;
  return map;
}

const UcModelMap& cachedUcModelMap(const MIPModel& model) {
  thread_local std::unordered_map<const MIPModel*, UcModelMap> cache;
  auto it = cache.find(&model);
  if (it == cache.end()) it = cache.emplace(&model, buildUcModelMap(model)).first;
  return it->second;
}

struct C1ShadowDecision {
  bool checked = false;
  bool pass = true;
  bool energy_reject = false;
  bool reserve_reject = false;
};

double c1ReferenceValue(const std::vector<double>& reference,
                        const ReversibleDomains& domains, int column) {
  if (column < 0 || column >= static_cast<int>(reference.size())) return 0.0;
  return std::max(domains.lower(column),
                  std::min(domains.upper(column), reference[column]));
}

double c1RampBound(const MIPModel& model, const UcModelMap& map,
                   const ReversibleDomains& domains,
                   const std::vector<double>& reference, int row,
                   int target_column) {
  if (row < 0 || target_column < 0 || !finiteUpper(model.row_ub[row]))
    return std::numeric_limits<double>::quiet_NaN();
  double target_coefficient = 0.0;
  double other_activity = 0.0;
  for (HighsInt p = model.row_start[row]; p < model.row_start[row + 1]; ++p) {
    const int column = model.row_index[p];
    const double coefficient = model.row_value[p];
    if (column == target_column) {
      target_coefficient += coefficient;
      continue;
    }
    double value = 0.0;
    if (column >= 0 && column < static_cast<int>(map.col_kind.size()) &&
        map.col_kind[column] != 0) {
      value = coefficient < 0.0 ? domains.upper(column)
                                : domains.lower(column);
    } else {
      value = c1ReferenceValue(reference, domains, column);
    }
    other_activity += coefficient * value;
  }
  if (std::abs(target_coefficient) <= 1e-15)
    return std::numeric_limits<double>::quiet_NaN();
  return (model.row_ub[row] - other_activity) / target_coefficient;
}

C1ShadowDecision evaluateC1ShadowSegment(
    const MIPModel& model, const UcModelMap& map,
    const ReversibleDomains& domains, const std::vector<double>& reference,
    const std::vector<int>& segment_columns, int target,
    UfprMetrics& metrics) {
  C1ShadowDecision decision;
  if (!map.power_transfer_mapping_validated ||
      reference.size() != static_cast<size_t>(model.n_cols)) {
    metrics.c1_reference_available = false;
    return decision;
  }
  decision.checked = true;
  metrics.c1_mapping_validated = true;
  ++metrics.c1_segments_checked;
  if (target == 0)
    ++metrics.c1_off_segments_checked;
  else
    ++metrics.c1_on_segments_checked;

  for (int selected_column : segment_columns) {
    if (selected_column < 0 ||
        selected_column >= static_cast<int>(map.col_unit.size()))
      continue;
    const int selected_unit = map.col_unit[selected_column];
    const int period = map.col_time[selected_column];
    if (selected_unit < 0 || period < 0) continue;
    ++metrics.c1_period_checks;

    if (target == 0) {
      const int selected_dispatch = map.dispatch[selected_unit][period];
      const double delta = std::max(
          0.0, c1ReferenceValue(reference, domains, selected_dispatch));
      double thermal_up = 0.0;
      double thermal_reference_total = 0.0;
      double optimistic_capacity = 0.0;
      for (int unit = 0; unit < map.thermal_units; ++unit) {
        const int p_column = map.dispatch[unit][period];
        const int alpha_column = map.commitment[unit][period];
        const double p_reference =
            c1ReferenceValue(reference, domains, p_column);
        thermal_reference_total += p_reference;
        if (unit == selected_unit) continue;
        const double alpha_upper = std::max(
            0.0, std::min(1.0, domains.upper(alpha_column)));
        optimistic_capacity += map.pmax[unit][period] * alpha_upper;
        double maximum_output = std::min(
            domains.upper(p_column), map.pmax[unit][period] * alpha_upper);
        const double ramp_maximum = c1RampBound(
            model, map, domains, reference, map.ramp_up_row[unit][period],
            p_column);
        if (std::isfinite(ramp_maximum))
          maximum_output = std::min(maximum_output, ramp_maximum);
        thermal_up += std::max(0.0, maximum_output - p_reference);
      }
      double storage_up = 0.0;
      for (int storage = 0; storage < map.storage_units; ++storage) {
        const int p_column = map.storage_dispatch[storage][period];
        const int gen_mode = map.storage_gen_mode[storage][period];
        const int pump_mode = map.storage_pump_mode[storage][period];
        const double p_reference =
            c1ReferenceValue(reference, domains, p_column);
        const double pump_reference =
            map.storage_pump_capacity[storage][period] *
            std::max(0.0, std::min(1.0,
                c1ReferenceValue(reference, domains, pump_mode)));
        const double maximum_discharge = std::min(
            domains.upper(p_column),
            map.storage_pmax[storage][period] *
                std::max(0.0, std::min(1.0, domains.upper(gen_mode))));
        storage_up += std::max(0.0, maximum_discharge - p_reference) +
                      pump_reference;
      }
      const double energy_margin = thermal_up + storage_up - delta;
      const double storage_transfer = std::min(storage_up, delta);
      const double thermal_transfer = std::max(0.0, delta - storage_transfer);
      const double post_thermal_generation = std::max(
          0.0, thermal_reference_total - delta + thermal_transfer);
      const double post_fix_reserve =
          optimistic_capacity - post_thermal_generation;
      const double reserve_margin =
          post_fix_reserve - map.reserve_requirement[period];
      const bool energy_pass = energy_margin >= -kConstraintTolerance;
      const bool reserve_pass = reserve_margin >= -kConstraintTolerance;
      metrics.c1_delta_off_total += delta;
      metrics.c1_thermal_up_total += thermal_up;
      metrics.c1_storage_up_total += storage_up;
      metrics.c1_m_off.push_back(energy_margin);
      metrics.c1_reserve_margin_off.push_back(reserve_margin);
      if (!energy_pass || !reserve_pass) {
        ++metrics.c1_off_period_fails;
        decision.pass = false;
      }
      decision.energy_reject = decision.energy_reject || !energy_pass;
      decision.reserve_reject = decision.reserve_reject || !reserve_pass;
    } else {
      const int selected_dispatch = map.dispatch[selected_unit][period];
      const double selected_reference =
          c1ReferenceValue(reference, domains, selected_dispatch);
      const double delta = std::max(
          0.0, map.pmin[selected_unit][period] - selected_reference);
      double thermal_down = 0.0;
      for (int unit = 0; unit < map.thermal_units; ++unit) {
        if (unit == selected_unit) continue;
        const int p_column = map.dispatch[unit][period];
        const int alpha_column = map.commitment[unit][period];
        const double p_reference =
            c1ReferenceValue(reference, domains, p_column);
        const double alpha_lower = std::max(
            0.0, std::min(1.0, domains.lower(alpha_column)));
        double minimum_output = std::max(
            domains.lower(p_column), map.pmin[unit][period] * alpha_lower);
        const double ramp_minimum = c1RampBound(
            model, map, domains, reference, map.ramp_down_row[unit][period],
            p_column);
        if (std::isfinite(ramp_minimum))
          minimum_output = std::max(minimum_output, ramp_minimum);
        thermal_down += std::max(0.0, p_reference - minimum_output);
      }
      double storage_down = 0.0;
      for (int storage = 0; storage < map.storage_units; ++storage) {
        const int p_column = map.storage_dispatch[storage][period];
        const int pump_mode = map.storage_pump_mode[storage][period];
        const double p_reference =
            c1ReferenceValue(reference, domains, p_column);
        const double pump_reference =
            map.storage_pump_capacity[storage][period] *
            std::max(0.0, std::min(1.0,
                c1ReferenceValue(reference, domains, pump_mode)));
        const double maximum_pumping =
            map.storage_pump_capacity[storage][period] *
            std::max(0.0, std::min(1.0, domains.upper(pump_mode)));
        storage_down += p_reference +
                        std::max(0.0, maximum_pumping - pump_reference);
      }
      const double energy_margin = thermal_down + storage_down - delta;
      const bool energy_pass = energy_margin >= -kConstraintTolerance;
      metrics.c1_delta_on_total += delta;
      metrics.c1_thermal_down_total += thermal_down;
      metrics.c1_storage_down_total += storage_down;
      metrics.c1_m_on.push_back(energy_margin);
      if (!energy_pass) {
        ++metrics.c1_on_period_fails;
        decision.pass = false;
      }
      decision.energy_reject = decision.energy_reject || !energy_pass;
    }
  }
  if (decision.pass) {
    ++metrics.c1_segments_pass;
  } else {
    ++metrics.c1_segments_shadow_reject;
    if (target == 0) ++metrics.c1_off_reject_count;
    else ++metrics.c1_on_reject_count;
    if (decision.energy_reject) ++metrics.c1_energy_reject_count;
    if (decision.reserve_reject) ++metrics.c1_reserve_reject_count;
    if (decision.energy_reject && decision.reserve_reject)
      ++metrics.c1_both_energy_reserve_reject_count;
  }
  return decision;
}

bool fixedBinary(const ReversibleDomains& domains, int column, int& value) {
  if (column < 0 || std::abs(domains.lower(column) - domains.upper(column)) >
                        kBoundTolerance)
    return false;
  value = static_cast<int>(std::llround(domains.lower(column)));
  return value == 0 || value == 1;
}

bool ufprFix(ReversibleDomains& domains, int column, int value, int step,
             int64_t& category, UfprMetrics& metrics, bool& changed) {
  if (column < 0) return true;
  const bool was_fixed = std::abs(domains.lower(column) - domains.upper(column)) <=
                         kBoundTolerance;
  if (!domains.setDomain(column, value, value, step)) {
    ++metrics.a_contradictions;
    return false;
  }
  if (!was_fixed) {
    ++category;
    ++metrics.a_propagations;
    changed = true;
  }
  return true;
}

bool applyUfprTemporal(const UcModelMap& map, ReversibleDomains& domains,
                       int step, UfprMetrics& metrics, bool& any_changed) {
  any_changed = false;
  for (int pass = 0; pass < std::max(1, map.periods); ++pass) {
    bool changed = false;
    for (int i = 0; i < map.thermal_units; ++i) {
      for (int t = 1; t < map.periods; ++t) {
        int previous = 0, current = 0;
        if (!fixedBinary(domains, map.commitment[i][t - 1], previous) ||
            !fixedBinary(domains, map.commitment[i][t], current) ||
            previous == current)
          continue;
        if (previous == 0 && current == 1) {
          if (!ufprFix(domains, map.startup[i][t], 1, step,
                       metrics.a_v_propagations, metrics, changed) ||
              !ufprFix(domains, map.shutdown[i][t], 0, step,
                       metrics.a_w_propagations, metrics, changed))
            return false;
        } else {
          if (!ufprFix(domains, map.startup[i][t], 0, step,
                       metrics.a_v_propagations, metrics, changed) ||
              !ufprFix(domains, map.shutdown[i][t], 1, step,
                       metrics.a_w_propagations, metrics, changed))
            return false;
        }
      }
      for (int t = 0; t < map.periods; ++t) {
        int value = 0;
        if (fixedBinary(domains, map.startup[i][t], value) && value == 1) {
          for (int q = t; q < std::min(map.periods, t + map.min_up[i]); ++q) {
            const int64_t before = metrics.a_u_propagations;
            if (!ufprFix(domains, map.commitment[i][q], 1, step,
                         metrics.a_u_propagations, metrics, changed))
              return false;
            if (metrics.a_u_propagations > before)
              ++metrics.a_minup_propagations;
          }
        }
        if (fixedBinary(domains, map.shutdown[i][t], value) && value == 1) {
          for (int q = t; q < std::min(map.periods, t + map.min_down[i]); ++q) {
            const int64_t before = metrics.a_u_propagations;
            if (!ufprFix(domains, map.commitment[i][q], 0, step,
                         metrics.a_u_propagations, metrics, changed))
              return false;
            if (metrics.a_u_propagations > before)
              ++metrics.a_mindown_propagations;
          }
        }
      }
    }
    any_changed = any_changed || changed;
    if (!changed) break;
  }
  return true;
}

bool applyUfprCapacityGuard(const MIPModel& model, const UcModelMap& map,
                            const ReversibleDomains& domains,
                            UfprMetrics& metrics) {
  const auto start = Clock::now();
  bool feasible = true;
  for (int row : map.capacity_rows) {
    ++metrics.c_guard_checks;
    double margin = std::numeric_limits<double>::infinity();
    if (finiteLower(model.row_lb[row]))
      margin = std::min(margin, domains.rowMax(row) - model.row_lb[row]);
    if (finiteUpper(model.row_ub[row]))
      margin = std::min(margin, model.row_ub[row] - domains.rowMin(row));
    metrics.c_margin_min = std::min(metrics.c_margin_min, margin);
    if (domains.rowViolation(row) > kConstraintTolerance) {
      ++metrics.c_infeasible_states;
      feasible = false;
      break;
    }
  }
  metrics.c_time_sec +=
      std::chrono::duration<double>(Clock::now() - start).count();
  return feasible;
}

std::vector<int> ufprSegmentColumns(const UcModelMap& map, int selected,
                                    const std::vector<double>& guidance,
                                    int target, int lmax,
                                    const ReversibleDomains* domains = nullptr) {
  if (selected < 0 || selected >= static_cast<int>(map.col_kind.size()) ||
      map.col_kind[selected] != 'c')
    return {selected};
  const int unit = map.col_unit[selected];
  const int time = map.col_time[selected];
  auto same = [&](int t) {
    const int column = map.commitment[unit][t];
    if (column < 0 || static_cast<int>(std::llround(guidance[column])) != target)
      return false;
    if (domains && std::abs(domains->lower(column) - domains->upper(column)) <=
                       kBoundTolerance &&
        static_cast<int>(std::llround(domains->lower(column))) != target)
      return false;
    return true;
  };
  std::vector<int> columns;
  columns.push_back(selected);
  for (int distance = 1;
       static_cast<int>(columns.size()) < lmax &&
       (time - distance >= 0 || time + distance < map.periods);
       ++distance) {
    if (static_cast<int>(columns.size()) < lmax && time - distance >= 0 &&
        same(time - distance))
      columns.push_back(map.commitment[unit][time - distance]);
    if (static_cast<int>(columns.size()) < lmax && time + distance < map.periods &&
        same(time + distance))
      columns.push_back(map.commitment[unit][time + distance]);
  }
  return columns;
}

uint64_t ufprProfileHashMix(uint64_t hash, uint64_t value) {
  value += 0x9e3779b97f4a7c15ULL;
  value = (value ^ (value >> 30)) * 0xbf58476d1ce4e5b9ULL;
  value = (value ^ (value >> 27)) * 0x94d049bb133111ebULL;
  value ^= value >> 31;
  return hash ^ (value + (hash << 6) + (hash >> 2));
}

uint64_t ufprSegmentFingerprint(const UcModelMap& map,
                                const std::vector<int>& columns,
                                int target) {
  if (columns.empty()) return 0;
  const int unit = map.col_unit[columns.front()];
  int first = map.col_time[columns.front()];
  int last = first;
  for (int column : columns) {
    first = std::min(first, map.col_time[column]);
    last = std::max(last, map.col_time[column]);
  }
  uint64_t hash = 0xcbf29ce484222325ULL;
  hash = ufprProfileHashMix(hash, static_cast<uint32_t>(unit));
  hash = ufprProfileHashMix(hash, static_cast<uint32_t>(first));
  hash = ufprProfileHashMix(hash, static_cast<uint32_t>(last));
  hash = ufprProfileHashMix(hash, static_cast<uint32_t>(target));
  return hash;
}

uint64_t ufprLocalStateSignature(const ReversibleDomains& domains,
                                 const std::vector<int>& columns,
                                 uint64_t fingerprint) {
  uint64_t hash = fingerprint;
  for (int column : columns) {
    int state = 3;
    const double lower = domains.lower(column);
    const double upper = domains.upper(column);
    if (std::abs(lower - upper) > kBoundTolerance) state = 0;
    else if (std::abs(lower) <= kBoundTolerance) state = 1;
    else if (std::abs(lower - 1.0) <= kBoundTolerance) state = 2;
    hash = ufprProfileHashMix(hash, static_cast<uint32_t>(column));
    hash = ufprProfileHashMix(hash, static_cast<uint32_t>(state));
  }
  return hash;
}

bool runUfprBUnitTests() {
  std::array<bool, 12> tests{};
  auto check = [&](int index, const std::vector<int>& got,
                   const std::vector<int>& expected) {
    tests[index] = got == expected;
  };
  UcModelMap map;
  map.thermal_units = 1;
  map.periods = 8;
  map.col_kind.assign(8, 'c');
  map.col_unit.assign(8, 0);
  map.col_time.resize(8);
  map.commitment.assign(1, std::vector<int>(8));
  for (int t = 0; t < 8; ++t) {
    map.commitment[0][t] = t;
    map.col_time[t] = t;
  }
  std::vector<double> guidance{0, 0, 0, 1, 1, 1, 1, 0};
  check(0, ufprSegmentColumns(map, 4, guidance, 1, 4), {4, 3, 5, 6});
  check(1, ufprSegmentColumns(map, 1, guidance, 0, 4), {1, 0, 2, 7});
  check(2, ufprSegmentColumns(map, 4, guidance, 1, 4), {4, 3, 5, 6});
  check(3, ufprSegmentColumns(map, 0, guidance, 0, 4), {0, 1, 2, 7});
  check(4, ufprSegmentColumns(map, 3, guidance, 1, 4), {3, 4, 5, 6});
  MIPModel test_model;
  test_model.n_cols = 8;
  test_model.obj.assign(8, 0.0);
  test_model.lb.assign(8, 0.0);
  test_model.ub.assign(8, 1.0);
  test_model.var_type.assign(8, VarType::Binary);
  test_model.row_start = {0};
  ReversibleDomains fixed_domains(test_model);
  fixed_domains.setDomain(5, 0.0, 0.0, 1);
  check(5, ufprSegmentColumns(map, 4, guidance, 1, 4, &fixed_domains),
        {4, 3, 6});
  fixed_domains.setDomain(3, 1.0, 1.0, 1);
  check(6, ufprSegmentColumns(map, 4, guidance, 1, 4, &fixed_domains),
        {4, 3, 6});
  tests[7] = !ufprSegmentColumns(map, 4, guidance, 0, 4).empty();
  const size_t pointer = fixed_domains.trailPointer();
  const bool segment_fix = fixed_domains.setDomain(4, 1.0, 1.0, 2) &&
                           fixed_domains.setDomain(3, 1.0, 1.0, 2);
  tests[8] = segment_fix;
  fixed_domains.backtrack(pointer);
  tests[9] = std::abs(fixed_domains.lower(4) - fixed_domains.upper(4)) >
             kBoundTolerance;
  std::vector<double> repair_guidance = guidance;
  repair_guidance[4] = 0.0;
  tests[10] = ufprSegmentColumns(map, 4, guidance, 1, 4) !=
              ufprSegmentColumns(map, 4, repair_guidance, 0, 4);
  tests[11] = ufprSegmentColumns(map, 4, repair_guidance, 0, 4).front() == 4;
  bool pass = true;
  for (size_t i = 0; i < tests.size(); ++i) {
    std::cout << "UFPR_B_UNIT_TEST_" << (i + 1) << '='
              << (tests[i] ? "PASS" : "FAIL") << '\n';
    pass = pass && tests[i];
  }
  std::cout << "UFPR_B_UNIT_TESTS_PASS=" << (pass ? "YES" : "NO") << '\n'
            << "UNSOUND_UFPR_B_PRUNING_DETECTED="
            << (pass ? "NO" : "YES") << '\n';
  return pass;
}

PropagationResult propagateDomainsBaseline(const MIPModel& model,
                                           ReversibleDomains& domains,
                                           int max_rounds,
                                           int change_step) {
  domains.clearPending();
  const auto profile_start = Clock::now();
  chap_profile::ScopedPhase profile_phase(chap_profile::Phase::Propagation);
  PropagationResult result;
  if (chap_profile::g_profile) chap_profile::g_profile->beginPropagation(change_step);
  auto finish_profile = [&]() {
    domains.clearPending();
    if (chap_profile::g_profile)
      chap_profile::g_profile->endPropagation(
          std::chrono::duration<double>(Clock::now() - profile_start).count());
  };
  for (int round = 0; round < max_rounds; ++round) {
    bool changed = false;
    ++result.rounds;
    if (chap_profile::g_profile) chap_profile::g_profile->onPropagationRound();
    for (int64_t i = 0; i < model.n_rows; ++i) {
      if (chap_profile::g_profile) {
        if ((i & 1023) == 0) {
          chap_profile::g_profile->propagationHeartbeat(static_cast<int>(i));
          if (chap_profile::g_profile->deadlineReached()) {
            result.time_limit = true;
            finish_profile();
            return result;
          }
        }
        chap_profile::g_profile->onRowScan(model.row_start[i + 1] - model.row_start[i]);
      }
      if (domains.rowViolation(static_cast<int>(i)) > kConstraintTolerance) {
        if (chap_profile::g_profile) chap_profile::g_profile->onInfeasibleRow(static_cast<int>(i));
        result.feasible = false;
        finish_profile();
        return result;
      }
      if (chap_profile::g_profile) {
        const bool lower_ok = !finiteLower(model.row_lb[i]) ||
                              domains.rowMin(static_cast<int>(i)) >= model.row_lb[i] - kConstraintTolerance;
        const bool upper_ok = !finiteUpper(model.row_ub[i]) ||
                              domains.rowMax(static_cast<int>(i)) <= model.row_ub[i] + kConstraintTolerance;
        if (lower_ok && upper_ok) chap_profile::g_profile->onRedundantRow();
      }
      for (HighsInt p = model.row_start[i]; p < model.row_start[i + 1]; ++p) {
        const int j = model.row_index[p];
        const double a = model.row_value[p];
        if (std::abs(a) <= 1e-15) continue;

        const double current_lower = domains.lower(j);
        const double current_upper = domains.upper(j);
        const double other_min = domains.rowMinExcluding(
            static_cast<int>(i), a, current_lower, current_upper);
        const double other_max = domains.rowMaxExcluding(
            static_cast<int>(i), a, current_lower, current_upper);

        double new_lower = current_lower;
        double new_upper = current_upper;
        if (finiteUpper(model.row_ub[i]) && std::isfinite(other_min)) {
          const double implied = (model.row_ub[i] - other_min) / a;
          if (a > 0.0)
            new_upper = std::min(new_upper, implied);
          else
            new_lower = std::max(new_lower, implied);
        }
        if (finiteLower(model.row_lb[i]) && std::isfinite(other_max)) {
          const double implied = (model.row_lb[i] - other_max) / a;
          if (a > 0.0)
            new_lower = std::max(new_lower, implied);
          else
            new_upper = std::min(new_upper, implied);
        }
        if (integralType(model.var_type[j])) {
          if (finiteLower(new_lower))
            new_lower = std::ceil(new_lower - 1e-12);
          if (finiteUpper(new_upper))
            new_upper = std::floor(new_upper + 1e-12);
        }
        if (new_lower > new_upper + kBoundTolerance) {
          if (chap_profile::g_profile) chap_profile::g_profile->onInfeasibleRow(static_cast<int>(i));
          result.feasible = false;
          finish_profile();
          return result;
        }
        if (new_lower > current_lower + kBoundTolerance ||
            new_upper < current_upper - kBoundTolerance) {
          if (!domains.setDomain(j, new_lower, new_upper, change_step)) {
            if (chap_profile::g_profile) chap_profile::g_profile->onInfeasibleRow(static_cast<int>(i));
            result.feasible = false;
            finish_profile();
            return result;
          }
          if (chap_profile::g_profile)
            chap_profile::g_profile->onBoundTightening(
                j, static_cast<int>(i), current_lower, current_upper,
                new_lower, new_upper);
          if (new_lower > current_lower + kBoundTolerance)
            ++result.tightened_bounds;
          if (new_upper < current_upper - kBoundTolerance)
            ++result.tightened_bounds;
          changed = true;
        }
      }
    }
    if (!changed) {
      finish_profile();
      return result;
    }
  }
  finish_profile();
  return result;
}

PropagationResult propagateDomains(const MIPModel& model,
                                   ReversibleDomains& domains, int max_rounds,
                                   int change_step) {
  const bool measure_runtime = g_runtime_fpr_metrics != nullptr;
  const auto profile_start = (chap_profile::g_profile || measure_runtime)
      ? Clock::now() : Clock::time_point{};
  chap_profile::ScopedPhase profile_phase(chap_profile::Phase::Propagation);
  PropagationResult result;
  if (chap_profile::g_profile) chap_profile::g_profile->beginPropagation(change_step);
  auto finish_profile = [&]() {
    const double measured_sec = (chap_profile::g_profile || measure_runtime)
        ? std::chrono::duration<double>(Clock::now() - profile_start).count()
        : 0.0;
    if (chap_profile::g_profile)
      chap_profile::g_profile->endPropagation(measured_sec);
    if (measure_runtime) {
      ++g_runtime_fpr_metrics->propagation_calls;
      g_runtime_fpr_metrics->propagation_time_sec += measured_sec;
    }
  };
  auto& heap = domains.queueHeap();
  auto& next = domains.queueNext();
  auto& newly_dirty = domains.queueNew();
  heap.clear();
  next.clear();
  newly_dirty.clear();
  uint32_t epoch = domains.beginQueueEpoch();
  const auto queue_init_start = chap_profile::g_profile
      ? Clock::now() : Clock::time_point{};
  domains.drainPendingTo(newly_dirty);
  for (int row : newly_dirty) {
    if (domains.markCurrent(row, epoch)) {
      heap.push_back(row);
      if (chap_profile::g_profile)
        chap_profile::g_profile->onRowEnqueued(heap.size());
    }
  }
  newly_dirty.clear();
  std::make_heap(heap.begin(), heap.end(), std::greater<int>());
  if (chap_profile::g_profile)
    chap_profile::g_profile->addQueueTime(
        std::chrono::duration<double>(Clock::now() - queue_init_start).count());

  for (int round = 0; round < max_rounds && !heap.empty(); ++round) {
    ++result.rounds;
    if (chap_profile::g_profile) chap_profile::g_profile->onPropagationRound();
    while (!heap.empty()) {
      const auto pop_start = chap_profile::g_profile
          ? Clock::now() : Clock::time_point{};
      std::pop_heap(heap.begin(), heap.end(), std::greater<int>());
      const int i = heap.back();
      heap.pop_back();
      ++result.rows_visited;
      if (chap_profile::g_profile) {
        chap_profile::g_profile->addQueueTime(
            std::chrono::duration<double>(Clock::now() - pop_start).count());
        chap_profile::g_profile->onRowDequeued(
            i, model.row_start[i + 1] - model.row_start[i], heap.size());
        chap_profile::g_profile->propagationHeartbeat(i);
        if (chap_profile::g_profile->deadlineReached()) {
          result.time_limit = true;
          domains.requeueRows(heap);
          domains.requeueRows(next);
          finish_profile();
          return result;
        }
      }

      if (domains.rowViolation(i) > kConstraintTolerance) {
        if (chap_profile::g_profile) chap_profile::g_profile->onInfeasibleRow(i);
        result.feasible = false;
        domains.requeueRows(heap);
        domains.requeueRows(next);
        finish_profile();
        return result;
      }
      if (chap_profile::g_profile) {
        const bool lower_ok = !finiteLower(model.row_lb[i]) ||
                              domains.rowMin(i) >= model.row_lb[i] - kConstraintTolerance;
        const bool upper_ok = !finiteUpper(model.row_ub[i]) ||
                              domains.rowMax(i) <= model.row_ub[i] + kConstraintTolerance;
        if (lower_ok && upper_ok) chap_profile::g_profile->onRedundantRow();
      }

      for (HighsInt p = model.row_start[i]; p < model.row_start[i + 1]; ++p) {
        const int j = model.row_index[p];
        const double a = model.row_value[p];
        if (std::abs(a) <= 1e-15) continue;
        const double current_lower = domains.lower(j);
        const double current_upper = domains.upper(j);
        const double other_min = domains.rowMinExcluding(
            i, a, current_lower, current_upper);
        const double other_max = domains.rowMaxExcluding(
            i, a, current_lower, current_upper);
        double new_lower = current_lower;
        double new_upper = current_upper;
        if (finiteUpper(model.row_ub[i]) && std::isfinite(other_min)) {
          const double implied = (model.row_ub[i] - other_min) / a;
          if (a > 0.0) new_upper = std::min(new_upper, implied);
          else new_lower = std::max(new_lower, implied);
        }
        if (finiteLower(model.row_lb[i]) && std::isfinite(other_max)) {
          const double implied = (model.row_lb[i] - other_max) / a;
          if (a > 0.0) new_lower = std::max(new_lower, implied);
          else new_upper = std::min(new_upper, implied);
        }
        if (integralType(model.var_type[j])) {
          if (finiteLower(new_lower)) new_lower = std::ceil(new_lower - 1e-12);
          if (finiteUpper(new_upper)) new_upper = std::floor(new_upper + 1e-12);
        }
        if (chap_profile::g_profile)
          chap_profile::g_profile->onBoundTighteningAttempt();
        if (new_lower > new_upper + kBoundTolerance) {
          if (chap_profile::g_profile) chap_profile::g_profile->onInfeasibleRow(i);
          result.feasible = false;
          domains.requeueRows(heap);
          domains.requeueRows(next);
          finish_profile();
          return result;
        }
        if (new_lower > current_lower + kBoundTolerance ||
            new_upper < current_upper - kBoundTolerance) {
          if (!domains.setDomain(j, new_lower, new_upper, change_step)) {
            if (chap_profile::g_profile) chap_profile::g_profile->onInfeasibleRow(i);
            result.feasible = false;
            domains.requeueRows(heap);
            domains.requeueRows(next);
            finish_profile();
            return result;
          }
          if (chap_profile::g_profile)
            chap_profile::g_profile->onBoundTightening(
                j, i, current_lower, current_upper, new_lower, new_upper);
          if (new_lower > current_lower + kBoundTolerance) ++result.tightened_bounds;
          if (new_upper < current_upper - kBoundTolerance) ++result.tightened_bounds;
        }
      }

      const auto queue_add_start = chap_profile::g_profile
          ? Clock::now() : Clock::time_point{};
      domains.drainPendingTo(newly_dirty);
      for (int row : newly_dirty) {
        if (row > i) {
          if (domains.markCurrent(row, epoch)) {
            heap.push_back(row);
            std::push_heap(heap.begin(), heap.end(), std::greater<int>());
            if (chap_profile::g_profile)
              chap_profile::g_profile->onRowEnqueued(heap.size());
          }
        } else if (domains.markNext(row, epoch)) {
          next.push_back(row);
          if (chap_profile::g_profile)
            chap_profile::g_profile->onRowEnqueued(heap.size() + next.size());
        }
      }
      newly_dirty.clear();
      if (chap_profile::g_profile)
        chap_profile::g_profile->addQueueTime(
            std::chrono::duration<double>(Clock::now() - queue_add_start).count());
    }

    if (next.empty()) {
      finish_profile();
      return result;
    }
    if (round + 1 >= max_rounds) {
      domains.requeueRows(next);
      finish_profile();
      return result;
    }
    epoch = domains.beginQueueEpoch();
    for (int row : next) {
      domains.markCurrent(row, epoch);
      heap.push_back(row);
    }
    next.clear();
    std::make_heap(heap.begin(), heap.end(), std::greater<int>());
  }
  finish_profile();
  return result;
}

PropagationResult runUfprClosure(const MIPModel& model, const UcModelMap& map,
                                 ReversibleDomains& domains, int max_rounds,
                                 int change_step, bool temporal_on,
                                 bool capacity_guard_on, UfprMetrics& metrics) {
  PropagationResult total;
  for (int pass = 0; pass < 4; ++pass) {
    bool temporal_changed = false;
    if (temporal_on &&
        !applyUfprTemporal(map, domains, change_step, metrics,
                           temporal_changed)) {
      total.feasible = false;
      return total;
    }
    if (capacity_guard_on &&
        !applyUfprCapacityGuard(model, map, domains, metrics)) {
      total.feasible = false;
      ++metrics.c_backtracks_avoiding_completion;
      return total;
    }
    PropagationResult pass_result =
        propagateDomains(model, domains, max_rounds, change_step);
    total.rounds += pass_result.rounds;
    total.rows_visited += pass_result.rows_visited;
    total.tightened_bounds += pass_result.tightened_bounds;
    total.time_limit = total.time_limit || pass_result.time_limit;
    if (!pass_result.feasible || pass_result.time_limit) {
      total.feasible = pass_result.feasible;
      return total;
    }
    // A second pass lets exact implications exposed by generic row propagation
    // enter the named UC fast path.  Stop after a stable A pass.
    if (!temporal_on || (!temporal_changed && pass > 0)) break;
  }
  return total;
}

PropagationResult propagateBounds(const MIPModel& model, std::vector<double>& lower,
                                  std::vector<double>& upper, int max_rounds) {
  PropagationResult result;
  for (int round = 0; round < max_rounds; ++round) {
    bool changed = false;
    ++result.rounds;
    for (int64_t i = 0; i < model.n_rows; ++i) {
      double min_finite = 0.0;
      double max_finite = 0.0;
      int min_inf_count = 0;
      int max_inf_count = 0;

      for (HighsInt p = model.row_start[i]; p < model.row_start[i + 1]; ++p) {
        const int j = model.row_index[p];
        const double a = model.row_value[p];
        const double min_bound = a >= 0.0 ? lower[j] : upper[j];
        const double max_bound = a >= 0.0 ? upper[j] : lower[j];
        if ((a >= 0.0 && !finiteLower(min_bound)) || (a < 0.0 && !finiteUpper(min_bound)))
          ++min_inf_count;
        else
          min_finite += a * min_bound;
        if ((a >= 0.0 && !finiteUpper(max_bound)) || (a < 0.0 && !finiteLower(max_bound)))
          ++max_inf_count;
        else
          max_finite += a * max_bound;
      }

      const double min_activity = min_inf_count ? -std::numeric_limits<double>::infinity() : min_finite;
      const double max_activity = max_inf_count ? std::numeric_limits<double>::infinity() : max_finite;
      if ((finiteUpper(model.row_ub[i]) && min_activity > model.row_ub[i] + kConstraintTolerance) ||
          (finiteLower(model.row_lb[i]) && max_activity < model.row_lb[i] - kConstraintTolerance)) {
        result.feasible = false;
        return result;
      }

      for (HighsInt p = model.row_start[i]; p < model.row_start[i + 1]; ++p) {
        const int j = model.row_index[p];
        const double a = model.row_value[p];
        if (std::abs(a) <= 1e-15) continue;
        const double min_bound = a >= 0.0 ? lower[j] : upper[j];
        const double max_bound = a >= 0.0 ? upper[j] : lower[j];
        const bool current_min_inf = (a >= 0.0 && !finiteLower(min_bound)) ||
                                     (a < 0.0 && !finiteUpper(min_bound));
        const bool current_max_inf = (a >= 0.0 && !finiteUpper(max_bound)) ||
                                     (a < 0.0 && !finiteLower(max_bound));
        const int other_min_inf = min_inf_count - (current_min_inf ? 1 : 0);
        const int other_max_inf = max_inf_count - (current_max_inf ? 1 : 0);
        const double other_min = other_min_inf ? -std::numeric_limits<double>::infinity()
                                               : min_finite - (current_min_inf ? 0.0 : a * min_bound);
        const double other_max = other_max_inf ? std::numeric_limits<double>::infinity()
                                               : max_finite - (current_max_inf ? 0.0 : a * max_bound);

        double new_lower = lower[j];
        double new_upper = upper[j];
        if (finiteUpper(model.row_ub[i]) && std::isfinite(other_min)) {
          const double implied = (model.row_ub[i] - other_min) / a;
          if (a > 0.0)
            new_upper = std::min(new_upper, implied);
          else
            new_lower = std::max(new_lower, implied);
        }
        if (finiteLower(model.row_lb[i]) && std::isfinite(other_max)) {
          const double implied = (model.row_lb[i] - other_max) / a;
          if (a > 0.0)
            new_lower = std::max(new_lower, implied);
          else
            new_upper = std::min(new_upper, implied);
        }
        if (integralType(model.var_type[j])) {
          if (finiteLower(new_lower)) new_lower = std::ceil(new_lower - 1e-12);
          if (finiteUpper(new_upper)) new_upper = std::floor(new_upper + 1e-12);
        }
        if (new_lower > new_upper + kBoundTolerance) {
          result.feasible = false;
          return result;
        }
        if (new_lower > lower[j] + kBoundTolerance) {
          lower[j] = new_lower;
          changed = true;
          ++result.tightened_bounds;
        }
        if (new_upper < upper[j] - kBoundTolerance) {
          upper[j] = new_upper;
          changed = true;
          ++result.tightened_bounds;
        }
      }
    }
    if (!changed) return result;
  }
  return result;
}

double clampedIntegerTarget(const MIPModel& model, int j, double value) {
  double target = std::round(value);
  if (finiteLower(model.lb[j])) target = std::max(target, std::ceil(model.lb[j] - 1e-12));
  if (finiteUpper(model.ub[j])) target = std::min(target, std::floor(model.ub[j] + 1e-12));
  return target;
}

std::optional<double> alternateTarget(const MIPModel& model, int j, double lp_value, double primary,
                                      double lower, double upper) {
  std::vector<double> candidates;
  if (model.var_type[j] == VarType::Binary) {
    candidates.push_back(primary < 0.5 ? 1.0 : 0.0);
  } else {
    candidates.push_back(std::floor(lp_value));
    candidates.push_back(std::ceil(lp_value));
    candidates.push_back(primary - 1.0);
    candidates.push_back(primary + 1.0);
  }
  for (double candidate : candidates) {
    if (std::abs(candidate - primary) <= kIntegerTolerance) continue;
    if (candidate >= lower - kBoundTolerance && candidate <= upper + kBoundTolerance) return candidate;
  }
  return std::nullopt;
}

int chooseIntegerVariable(const MIPModel& model, const std::vector<double>& lp_x,
                          const std::vector<char>& fixed, FprStrategy strategy,
                          const std::vector<double>* reduced_cost = nullptr) {
  int best = -1;
  double best_score = strategy == FprStrategy::MostIntegral
                          ? std::numeric_limits<double>::infinity()
                          : -std::numeric_limits<double>::infinity();
  for (int j : model.integer_columns) {
    if (fixed[j]) continue;
    const double fractionality = std::abs(lp_x[j] - std::round(lp_x[j]));
    double score = fractionality;
    if (strategy == FprStrategy::LpConfidence || strategy == FprStrategy::ReducedCostAware) {
      if (strategy == FprStrategy::ReducedCostAware && reduced_cost &&
          reduced_cost->size() == static_cast<size_t>(model.n_cols))
        score = std::abs((*reduced_cost)[j]) / (1.0 + fractionality);
      else
        score = model.var_type[j] == VarType::Binary ? std::abs(lp_x[j] - 0.5) : 0.5 - fractionality;
      if (score > best_score) {
        best_score = score;
        best = j;
      }
    } else if (score < best_score) {
      best_score = score;
      best = j;
    }
  }
  return best;
}

struct RepairCandidate {
  int column = -1;
  double shift = 0.0;
  double damage = 0.0;
  double selected_violation_after = 0.0;
  bool modifies_earlier_domain = false;
};

struct RepairWalkResult {
  bool feasible = false;
  int iterations = 0;
  int moves = 0;
  int backtracks = 0;
  bool modified_earlier_domain = false;
};

struct RepairEventDiagnostic {
  int64_t event_id = 0;
  int row = -1;
  double violation_before = 0.0;
  int column = -1;
  double shift = 0.0;
  double damage = 0.0;
  bool modifies_earlier_domain = false;
  double violation_after = 0.0;
  bool first_move = false;
};

double candidateDamage(const ReversibleDomains& domains, int column,
                       double shift, int selected_row) {
  double damage = 0.0;
  const auto& entries = domains.columnRows(column);
  for (size_t first = 0; first < entries.size();) {
    const int row = entries[first].row;
    double coefficient = 0.0;
    size_t next = first;
    while (next < entries.size() && entries[next].row == row) {
      coefficient += entries[next].coefficient;
      ++next;
    }
    if (row != selected_row) {
      const double before = domains.rowViolation(row);
      const double after = domains.shiftedRowViolation(row, coefficient * shift);
      if (after > before) damage += after - before;
    }
    first = next;
  }
  return damage;
}

RepairWalkResult repairWalk(const MIPModel& model, ReversibleDomains& domains,
                            int trigger_column, int trigger_step,
                            int64_t repair_call_id, std::mt19937_64& rng) {
  const bool measure_runtime = g_runtime_fpr_metrics != nullptr;
  const auto runtime_start = measure_runtime
      ? Clock::now() : Clock::time_point{};
  chap_profile::ScopedPhase profile_phase(chap_profile::Phase::Repair);
  RepairWalkResult result;
  std::vector<RepairEventDiagnostic> diagnostics;
  size_t best_pointer = domains.trailPointer();
  double best_violation = domains.totalViolation();
  if (chap_profile::g_profile)
    chap_profile::g_profile->beginRepair(repair_call_id, trigger_column,
                                         best_violation);

  for (int iteration = 0; iteration < kRepairIterationLimit; ++iteration) {
    ++result.iterations;
    if (measure_runtime) ++g_runtime_fpr_metrics->repair_iterations;
    if (chap_profile::g_profile && chap_profile::g_profile->deadlineReached()) break;
    std::vector<int> violated = domains.violatedRows();
    if (violated.empty()) {
      result.feasible = true;
      break;
    }
    std::uniform_int_distribution<size_t> row_pick(0, violated.size() - 1);
    const int row = violated[row_pick(rng)];
    const double violation_before = domains.rowViolation(row);
    const double min_activity = domains.rowMin(row);
    const double max_activity = domains.rowMax(row);

    std::unordered_map<int, double> row_coefficients;
    for (HighsInt p = model.row_start[row]; p < model.row_start[row + 1]; ++p)
      row_coefficients[model.row_index[p]] += model.row_value[p];

    std::vector<RepairCandidate> candidates;
    int candidate_reallocations = 0;
    const auto candidate_start = chap_profile::g_profile
        ? Clock::now() : Clock::time_point{};
    for (const auto& [j, a] : row_coefficients) {
      if (std::abs(a) <= 1e-15) continue;
      double shift = 0.0;
      if (finiteUpper(model.row_ub[row]) &&
          min_activity > model.row_ub[row] + kConstraintTolerance) {
        shift = (model.row_ub[row] - min_activity) / a;
      } else if (finiteLower(model.row_lb[row]) &&
                 max_activity < model.row_lb[row] - kConstraintTolerance) {
        shift = (model.row_lb[row] - max_activity) / a;
      } else {
        continue;
      }

      double min_shift = -std::numeric_limits<double>::infinity();
      double max_shift = std::numeric_limits<double>::infinity();
      if (finiteLower(model.lb[j]) && finiteLower(domains.lower(j)))
        min_shift = model.lb[j] - domains.lower(j);
      if (finiteUpper(model.ub[j]) && finiteUpper(domains.upper(j)))
        max_shift = model.ub[j] - domains.upper(j);
      if (integralType(model.var_type[j])) {
        shift = shift > 0.0 ? std::floor(shift + 1e-12)
                            : std::ceil(shift - 1e-12);
        if (std::isfinite(min_shift)) min_shift = std::ceil(min_shift - 1e-12);
        if (std::isfinite(max_shift)) max_shift = std::floor(max_shift + 1e-12);
      }
      shift = std::max(min_shift, std::min(max_shift, shift));
      if (std::abs(shift) <= kBoundTolerance) continue;

      const double violation_after =
          domains.shiftedRowViolation(row, a * shift);
      if (violation_after >= violation_before - kConstraintTolerance) continue;
      const double damage = candidateDamage(domains, j, shift, row);
      const int previous_step = domains.lastChangeStep(j);
      const size_t old_capacity = candidates.capacity();
      candidates.push_back(
          {j, shift, damage, violation_after,
           previous_step >= 0 && previous_step < trigger_step});
      if (candidates.capacity() != old_capacity) ++candidate_reallocations;
    }
    const double candidate_sec =
        std::chrono::duration<double>(Clock::now() - candidate_start).count();
    if (candidates.empty()) {
      if (chap_profile::g_profile)
        chap_profile::g_profile->onRepairIteration(
            row, 0, candidate_reallocations, candidate_sec, best_violation);
      break;
    }

    std::vector<size_t> selectable;
    double minimum_damage = std::numeric_limits<double>::infinity();
    for (size_t k = 0; k < candidates.size(); ++k) {
      minimum_damage = std::min(minimum_damage, candidates[k].damage);
      if (candidates[k].damage <= kConstraintTolerance) selectable.push_back(k);
    }
    if (selectable.empty()) {
      std::bernoulli_distribution random_walk(kRepairNoise);
      if (random_walk(rng)) {
        selectable.resize(candidates.size());
        std::iota(selectable.begin(), selectable.end(), 0);
      } else {
        for (size_t k = 0; k < candidates.size(); ++k)
          if (candidates[k].damage <= minimum_damage + kConstraintTolerance)
            selectable.push_back(k);
      }
    }
    std::uniform_int_distribution<size_t> candidate_pick(0, selectable.size() - 1);
    const RepairCandidate chosen = candidates[selectable[candidate_pick(rng)]];
    const double new_lower = domains.lower(chosen.column) + chosen.shift;
    const double new_upper = domains.upper(chosen.column) + chosen.shift;
    if (!domains.setDomain(chosen.column, new_lower, new_upper, trigger_step)) break;
    ++result.moves;
    if (chap_profile::g_profile)
      chap_profile::g_profile->onRepairMove(chosen.modifies_earlier_domain);
    result.modified_earlier_domain =
        result.modified_earlier_domain || chosen.modifies_earlier_domain;

    const double violation_after = domains.rowViolation(row);
    const double total_violation = domains.totalViolation();
    const bool move_succeeded = total_violation <= kConstraintTolerance;
    if (total_violation + 1e-12 < best_violation) {
      best_violation = total_violation;
      best_pointer = domains.trailPointer();
    }
    if (chap_profile::g_profile)
      chap_profile::g_profile->onRepairIteration(
          row, static_cast<int>(candidates.size()), candidate_reallocations,
          candidate_sec, total_violation);

    diagnostics.push_back({++g_repair_event_id, row, violation_before,
                           chosen.column, chosen.shift, chosen.damage,
                           chosen.modifies_earlier_domain, violation_after,
                           iteration == 0});
    if (move_succeeded) {
      result.feasible = true;
      break;
    }
  }

  if (domains.trailPointer() > best_pointer) {
    domains.backtrack(best_pointer);
    ++result.backtracks;
  }
  const double final_violation = domains.totalViolation();
  result.feasible = final_violation <= kConstraintTolerance;
  if (chap_profile::g_profile)
    chap_profile::g_profile->endRepair(result.feasible, final_violation);
  for (const RepairEventDiagnostic& event : diagnostics) {
    const bool interesting = event.first_move || event.modifies_earlier_domain;
    const int64_t printed =
        interesting ? g_printed_repair_events.fetch_add(1) : 1000;
    if (!interesting || printed >= 200) continue;
    std::lock_guard<std::mutex> lock(g_repair_log_mutex);
    std::cout << std::setprecision(12)
              << "FPR_REPAIR_EVENT repair_event_id=" << event.event_id
              << " repair_call_id=" << repair_call_id
              << " trigger_fixing=" << trigger_column
              << " violated_row=" << event.row
              << " violation_before=" << event.violation_before
              << " repair_variable=" << event.column
              << " repair_shift=" << event.shift
              << " damage=" << event.damage
              << " earlier_domain_modified="
              << (event.modifies_earlier_domain ? "YES" : "NO")
              << " violation_after=" << event.violation_after
              << " repair_success=" << (result.feasible ? "YES" : "NO")
              << '\n';
  }
  if (measure_runtime)
  {
    g_runtime_fpr_metrics->repair_max_iterations = std::max<int64_t>(
        g_runtime_fpr_metrics->repair_max_iterations, result.iterations);
    g_runtime_fpr_metrics->repair_time_sec +=
        std::chrono::duration<double>(Clock::now() - runtime_start).count();
  }
  return result;
}

struct Decision {
  int column = -1;
  double lp_value = 0.0;
  double target = 0.0;
};

struct FprResult {
  bool feasible = false;
  std::vector<double> candidate;
  int64_t decisions = 0;
  int64_t tightened_bounds = 0;
  int repairs = 0;
  int backtracks = 0;
  int64_t explicit_fixings = 0;
  int64_t propagated_fixings = 0;
  int repair_calls = 0;
  int successful_repairs = 0;
  int final_lp_calls = 0;
  double final_lp_time_sec = 0.0;
  double fpr_time_sec = 0.0;
  int64_t propagation_calls = 0;
  int64_t repair_iterations = 0;
  int64_t repair_max_iterations = 0;
  int64_t trail_push_count = 0;
  int64_t backtrack_calls = 0;
  int64_t rollback_domain_changes = 0;
  int64_t max_trail_depth = 0;
  double propagation_time_sec = 0.0;
  double repair_time_sec = 0.0;
  double backtracking_time_sec = 0.0;
  int64_t canonicalized_domain_count = 0;
  double max_pre_canonical_crossing = 0.0;
  int64_t invalid_bounds_before_completion = -1;
  int completion_pass_model_status = -1;
  int completion_run_status = -1;
  LpSolveStatus completion_lp_status = LpSolveStatus::UNKNOWN;
  std::string completion_model_status = "NOT_RUN";
  std::string completion_backend = "NOT_RUN";
  int completion_raw_solver_status = -1;
  int64_t completion_simplex_iterations = 0;
  int64_t completion_ipm_iterations = 0;
  int64_t completion_barrier_iterations = 0;
  double completion_bound_violation =
      std::numeric_limits<double>::quiet_NaN();
  double completion_constraint_violation =
      std::numeric_limits<double>::quiet_NaN();
  double completion_dual_violation =
      std::numeric_limits<double>::quiet_NaN();
  int64_t completion_primal_infeasibilities = 0;
  double completion_max_primal_infeasibility = 0.0;
  double completion_objective = std::numeric_limits<double>::quiet_NaN();
  bool complete_integer_target = false;
  int64_t uc_minup_violations_before_completion = -1;
  int64_t uc_mindown_violations_before_completion = -1;
  int64_t uc_transition_violations_before_completion = -1;
  UfprMetrics ufpr;
  std::string termination = "UNKNOWN";
};

void copyDomainInvariantMetrics(FprResult& result,
                                const ReversibleDomains& domains) {
  result.canonicalized_domain_count = domains.canonicalizedDomainCount();
  result.max_pre_canonical_crossing = domains.maxPreCanonicalCrossing();
}

void copyRuntimeMetrics(FprResult& result,
                        const RuntimeFprMetrics& metrics) {
  result.propagation_calls = metrics.propagation_calls;
  result.repair_iterations = metrics.repair_iterations;
  result.repair_max_iterations = metrics.repair_max_iterations;
  result.trail_push_count = metrics.trail_push_count;
  result.backtrack_calls = metrics.backtrack_calls;
  result.rollback_domain_changes = metrics.rollback_domain_changes;
  result.max_trail_depth = metrics.max_trail_depth;
  result.propagation_time_sec = metrics.propagation_time_sec;
  result.repair_time_sec = metrics.repair_time_sec;
  result.backtracking_time_sec = metrics.backtracking_time_sec;
}

int64_t countSingletonIntegers(const MIPModel& model,
                               const ReversibleDomains& domains);

FprResult runFpr(const MIPModel& model, const std::vector<double>& lp_x, FprStrategy strategy,
                 CandidateSource source, SolutionPool& pool, const Clock::time_point start,
                 int max_repairs, double lp_time_limit_sec, uint64_t seed) {
  const auto fpr_start = Clock::now();
  ReversibleDomains domains(model);
  std::vector<char> fixed(model.n_cols, 0);
  std::vector<Decision> decisions;
  std::mt19937_64 rng(seed);
  FprResult result;
  result.candidate = lp_x;

  domains.enqueueAllRows();
  auto initial_prop = propagateDomains(model, domains, 20, 0);
  result.tightened_bounds += initial_prop.tightened_bounds;
  if (!initial_prop.feasible) {
    result.fpr_time_sec =
        std::chrono::duration<double>(Clock::now() - fpr_start).count();
    return result;
  }
  result.propagated_fixings = countSingletonIntegers(model, domains);
  bool construction_failed = false;

  while (decisions.size() < model.integer_columns.size()) {
    const int j = chooseIntegerVariable(model, lp_x, fixed, strategy);
    if (j < 0) break;
    const double primary = clampedIntegerTarget(model, j, lp_x[j]);
    const int64_t singleton_before = countSingletonIntegers(model, domains);
    const int trigger_step = static_cast<int>(decisions.size()) + 1;
    const size_t fix_pointer = domains.trailPointer();
    PropagationResult prop;
    if (primary < domains.lower(j) - kBoundTolerance ||
        primary > domains.upper(j) + kBoundTolerance ||
        !domains.setDomain(j, primary, primary, trigger_step)) {
      prop.feasible = false;
    } else {
      prop = propagateDomains(model, domains, 20, trigger_step);
    }
    result.tightened_bounds += prop.tightened_bounds;
    double accepted = primary;

    auto invoke_repair = [&]() {
      ++result.repair_calls;
      const int64_t repair_call_id = ++g_repair_calls;
      RepairWalkResult repair =
          repairWalk(model, domains, j, trigger_step, repair_call_id, rng);
      result.backtracks += repair.backtracks;
      g_backtracks += repair.backtracks;
      if (repair.feasible) {
        ++result.repairs;
        ++result.successful_repairs;
        ++g_successful_repairs;
      }
      return repair.feasible;
    };

    if (!prop.feasible) {
      if (!invoke_repair()) {
        domains.backtrack(fix_pointer);
        ++result.backtracks;
        ++g_backtracks;
        auto alternate = alternateTarget(model, j, lp_x[j], primary,
                                         domains.lower(j), domains.upper(j));
        if (!alternate ||
            !domains.setDomain(j, *alternate, *alternate, trigger_step)) {
          construction_failed = true;
          break;
        }
        prop = propagateDomains(model, domains, 20, trigger_step);
        result.tightened_bounds += prop.tightened_bounds;
        if (!prop.feasible && !invoke_repair()) {
          domains.backtrack(fix_pointer);
          ++result.backtracks;
          ++g_backtracks;
          construction_failed = true;
          break;
        }
      }
    }

    if (std::abs(domains.lower(j) - domains.upper(j)) <= kBoundTolerance)
      accepted = domains.lower(j);
    for (Decision& decision : decisions) {
      if (std::abs(domains.lower(decision.column) - domains.upper(decision.column)) <=
          kBoundTolerance) {
        decision.target = domains.lower(decision.column);
        result.candidate[decision.column] = decision.target;
      }
    }
    fixed[j] = 1;
    decisions.push_back({j, lp_x[j], accepted});
    ++result.explicit_fixings;
    const int64_t singleton_after = countSingletonIntegers(model, domains);
    result.propagated_fixings +=
        std::max<int64_t>(0, singleton_after - singleton_before - 1);
    result.candidate[j] = accepted;
  }
  result.decisions = static_cast<int64_t>(decisions.size());

  auto solve_fixed = [&](const std::vector<double>& trial_lower, const std::vector<double>& trial_upper,
                         int repair_index) -> bool {
    ++result.final_lp_calls;
    const auto final_lp_start = Clock::now();
    LpResult fixed_lp = solveCpuLp(model, &trial_lower, &trial_upper, nullptr, false, lp_time_limit_sec);
    result.final_lp_time_sec +=
        std::chrono::duration<double>(Clock::now() - final_lp_start).count();
    if (!fixed_lp.optimal) return false;
    result.candidate = fixed_lp.x;
    Evaluation eval = evaluateSolution(model, fixed_lp.x);
    CandidateSolution candidate{fixed_lp.x, eval, source, repair_index,
                                std::chrono::duration<double>(Clock::now() - start).count()};
    pool.insert(candidate);
    result.feasible = eval.integer_feasible && eval.row_feasible;
    return result.feasible;
  };

  if (!construction_failed && decisions.size() == model.integer_columns.size() &&
      solve_fixed(domains.lower(), domains.upper(), 0)) {
    result.fpr_time_sec =
        std::chrono::duration<double>(Clock::now() - fpr_start).count();
    return result;
  }

  for (int repair = 1; !construction_failed && repair <= max_repairs &&
                       repair <= static_cast<int>(decisions.size());
       ++repair) {
    const size_t flip_index = decisions.size() - repair;
    std::vector<double> trial_lower = model.lb;
    std::vector<double> trial_upper = model.ub;
    bool conflict = false;
    for (size_t k = 0; k < decisions.size(); ++k) {
      const Decision& decision = decisions[k];
      double target = decision.target;
      if (k == flip_index) {
        auto alternate = alternateTarget(model, decision.column, decision.lp_value, decision.target,
                                         trial_lower[decision.column], trial_upper[decision.column]);
        if (!alternate) {
          conflict = true;
          break;
        }
        target = *alternate;
      }
      trial_lower[decision.column] = trial_upper[decision.column] = target;
      auto prop = propagateBounds(model, trial_lower, trial_upper, 20);
      result.tightened_bounds += prop.tightened_bounds;
      if (!prop.feasible) {
        conflict = true;
        break;
      }
    }
    if (!conflict && solve_fixed(trial_lower, trial_upper, repair)) {
      result.repairs = repair;
      result.fpr_time_sec =
          std::chrono::duration<double>(Clock::now() - fpr_start).count();
      return result;
    }
  }

  // Global repair fallback: rebuild from original bounds, fix the complete
  // rounded integer target, and on subsequent attempts flip one of the most
  // fractional integer variables before propagation and the continuous LP.
  std::vector<int> repair_order = model.integer_columns;
  std::sort(repair_order.begin(), repair_order.end(), [&](int a, int b) {
    return std::abs(lp_x[a] - std::round(lp_x[a])) >
           std::abs(lp_x[b] - std::round(lp_x[b]));
  });
  for (int attempt = 0; attempt <= max_repairs; ++attempt) {
    std::vector<double> trial_lower = model.lb;
    std::vector<double> trial_upper = model.ub;
    bool valid_target = true;
    for (int j : model.integer_columns) {
      double target = clampedIntegerTarget(model, j, lp_x[j]);
      if (attempt > 0 && !repair_order.empty() &&
          j == repair_order[(attempt - 1) % repair_order.size()]) {
        auto alternate = alternateTarget(model, j, lp_x[j], target, trial_lower[j], trial_upper[j]);
        if (!alternate) {
          valid_target = false;
          break;
        }
        target = *alternate;
      }
      trial_lower[j] = trial_upper[j] = target;
    }
    if (!valid_target) continue;
    auto prop = propagateBounds(model, trial_lower, trial_upper, 20);
    result.tightened_bounds += prop.tightened_bounds;
    if (!prop.feasible) continue;
    if (solve_fixed(trial_lower, trial_upper, max_repairs + 1 + attempt)) {
      result.repairs = max_repairs + 1 + attempt;
      result.fpr_time_sec =
          std::chrono::duration<double>(Clock::now() - fpr_start).count();
      return result;
    }
  }

  Evaluation eval = evaluateSolution(model, result.candidate);
  pool.insert({result.candidate, eval, source, -1,
               std::chrono::duration<double>(Clock::now() - start).count()});
  result.fpr_time_sec =
      std::chrono::duration<double>(Clock::now() - fpr_start).count();
  return result;
}

#include "cdir_shadow.hpp"

struct LpFixingRunConfig {
  int64_t checkpoint = 0;
  chap::lpfix::Strategy strategy = chap::lpfix::Strategy::Frac;
  uint64_t seed = 0;
  bool frac_closest_first = true;
  bool debug_trace = false;
  int debug_trace_limit = 4;
  bool ufpr_temporal = false;
  bool ufpr_segment = false;
  bool ufpr_c1_shadow = false;
  bool cdir_shadow = false;
  bool cdir_reference_required = false;
  bool ufpr_capacity_guard = false;
  bool ufpr_trajectory_repair = false;
  int ufpr_segment_lmax = 4;
};

void countUcViolations(const UcModelMap& map,
                       const ReversibleDomains& domains, FprResult& result) {
  result.uc_transition_violations_before_completion = 0;
  result.uc_minup_violations_before_completion = 0;
  result.uc_mindown_violations_before_completion = 0;
  for (int i = 0; i < map.thermal_units; ++i) {
    for (int t = 1; t < map.periods; ++t) {
      int previous = 0, current = 0, startup = 0, shutdown = 0;
      if (fixedBinary(domains, map.commitment[i][t - 1], previous) &&
          fixedBinary(domains, map.commitment[i][t], current) &&
          fixedBinary(domains, map.startup[i][t], startup) &&
          fixedBinary(domains, map.shutdown[i][t], shutdown) &&
          current - previous != startup - shutdown)
        ++result.uc_transition_violations_before_completion;
    }
    for (int t = 0; t < map.periods; ++t) {
      int event = 0;
      if (fixedBinary(domains, map.startup[i][t], event) && event == 1)
        for (int q = t; q < std::min(map.periods, t + map.min_up[i]); ++q) {
          int committed = 0;
          if (fixedBinary(domains, map.commitment[i][q], committed) && !committed) {
            ++result.uc_minup_violations_before_completion;
            break;
          }
        }
      if (fixedBinary(domains, map.shutdown[i][t], event) && event == 1)
        for (int q = t; q < std::min(map.periods, t + map.min_down[i]); ++q) {
          int committed = 0;
          if (fixedBinary(domains, map.commitment[i][q], committed) && committed) {
            ++result.uc_mindown_violations_before_completion;
            break;
          }
        }
    }
  }
}

int64_t countSingletonIntegers(const MIPModel& model,
                               const ReversibleDomains& domains) {
  const auto profile_start = chap_profile::g_profile
      ? Clock::now() : Clock::time_point{};
  int64_t count = 0;
  for (int j : model.integer_columns)
    if (std::abs(domains.lower(j) - domains.upper(j)) <= kBoundTolerance)
      ++count;
  if (chap_profile::g_profile) {
    ++chap_profile::g_profile->singleton_scan_calls;
    chap_profile::g_profile->t_singleton_scans +=
        std::chrono::duration<double>(Clock::now() - profile_start).count();
  }
  return count;
}

FprResult runLpGuidedFpr(const MIPModel& model,
                         const std::vector<double>& lp_x,
                         const std::vector<double>& dual,
                         const std::vector<double>& reduced_cost,
                         const LpFixingRunConfig& config,
                         CandidateSource source, SolutionPool& pool,
                         const Clock::time_point global_start,
                         double lp_time_limit_sec,
                         std::vector<double>* integer_target_out = nullptr,
                         const std::vector<double>* c1_reference = nullptr) {
  const auto fpr_start = Clock::now();
  RuntimeFprMetrics runtime_metrics;
  RuntimeFprMetrics* previous_runtime_metrics = g_runtime_fpr_metrics;
  g_runtime_fpr_metrics = &runtime_metrics;
  struct RuntimeMetricsGuard {
    RuntimeFprMetrics* previous;
    ~RuntimeMetricsGuard() { g_runtime_fpr_metrics = previous; }
  } runtime_metrics_guard{previous_runtime_metrics};
  const auto initialization_start = chap_profile::g_profile
      ? Clock::now() : Clock::time_point{};
  chap::lpfix::SnapshotView snapshot{config.checkpoint, &lp_x, &dual,
                                    &reduced_cost};
  const std::vector<int> row_start(model.row_start.begin(), model.row_start.end());
  const std::vector<int> row_index(model.row_index.begin(), model.row_index.end());
  chap::lpfix::SparseRowsView rows{
      model.n_rows, model.n_cols, &row_start, &row_index};
  std::vector<chap::lpfix::IntegerKind> kinds(
      model.n_cols, chap::lpfix::IntegerKind::General);
  for (int j : model.integer_columns)
    if (model.var_type[j] == VarType::Binary)
      kinds[j] = chap::lpfix::IntegerKind::Binary;
  if (chap_profile::g_profile)
    chap_profile::g_profile->t_initialization +=
        std::chrono::duration<double>(Clock::now() - initialization_start).count();
  const auto ranking_start = chap_profile::g_profile
      ? Clock::now() : Clock::time_point{};
  const std::vector<chap::lpfix::OrderEntry> order =
      chap::lpfix::buildOrder(config.strategy, snapshot, rows,
                             model.integer_columns, kinds,
                             config.frac_closest_first);
  if (chap_profile::g_profile)
    chap_profile::g_profile->t_ranking +=
        std::chrono::duration<double>(Clock::now() - ranking_start).count();

  const auto domains_start = chap_profile::g_profile
      ? Clock::now() : Clock::time_point{};
  ReversibleDomains domains(model);
  const UcModelMap& uc_map = cachedUcModelMap(model);
  if (chap_profile::g_profile)
    chap_profile::g_profile->t_initialization +=
        std::chrono::duration<double>(Clock::now() - domains_start).count();
  std::mt19937_64 rng(config.seed);
  FprResult result;
  if (config.ufpr_segment) {
    result.ufpr.b_propagation_call_times_sec.reserve(50000);
    result.ufpr.b_segment_construction_times_sec.reserve(50000);
    result.ufpr.b_fingerprint_counts.reserve(50000);
    result.ufpr.b_local_state_counts.reserve(50000);
    result.ufpr.b_anchor_counts.reserve(50000);
  }
  if (config.ufpr_c1_shadow) {
    result.ufpr.c1_m_off.reserve(300000);
    result.ufpr.c1_m_on.reserve(300000);
    result.ufpr.c1_reserve_margin_off.reserve(300000);
  }
  result.candidate = lp_x;
  const std::vector<double>* c1_reference_state =
      c1_reference ? c1_reference : &lp_x;
  const std::vector<double>* cdir_reference_state =
      config.cdir_reference_required ? c1_reference : c1_reference_state;
  const auto cdir_setup_start = Clock::now();
  const CdirContext cdir_context = config.cdir_shadow
      ? CdirContext(model, uc_map, cdir_reference_state) : CdirContext(model, UcModelMap{}, nullptr);
  if (config.cdir_shadow) {
    result.ufpr.cdir.model_validated = cdir_context.validated;
    result.ufpr.cdir.reference_available = cdir_context.reference_available;
    result.ufpr.cdir.events.reserve(50000);
    result.ufpr.cdir.total_time += std::chrono::duration<double>(
        Clock::now()-cdir_setup_start).count();
  }
  result.ufpr.c1_reference_available =
      !config.ufpr_c1_shadow ||
      c1_reference_state->size() == static_cast<size_t>(model.n_cols);
  domains.enqueueAllRows();
  auto initial_prop = runUfprClosure(
      model, uc_map, domains, 20, 0, config.ufpr_temporal,
      config.ufpr_capacity_guard, result.ufpr);
  result.tightened_bounds += initial_prop.tightened_bounds;
  if (initial_prop.time_limit || !initial_prop.feasible) {
    result.fpr_time_sec =
        std::chrono::duration<double>(Clock::now() - fpr_start).count();
    const int64_t fixed = countSingletonIntegers(model, domains);
    if (chap_profile::g_profile)
      chap_profile::g_profile->finish(result.fpr_time_sec, false, fixed, 0,
                                      fixed, domains.trailPointer(), 0, 0, 0.0);
    result.termination = initial_prop.time_limit
        ? "TIME_LIMIT" : "ROOT_INFEASIBLE";
    copyDomainInvariantMetrics(result, domains);
    copyRuntimeMetrics(result, runtime_metrics);
    return result;
  }
  result.propagated_fixings = countSingletonIntegers(model, domains);

  bool construction_failed = false;
  int trace_count = 0;
  int64_t step = 0;
  const int64_t step_limit =
      std::max<int64_t>(100, 8 * static_cast<int64_t>(model.integer_columns.size()));
  while (countSingletonIntegers(model, domains) <
             static_cast<int64_t>(model.integer_columns.size()) &&
         step < step_limit) {
    if (chap_profile::g_profile && chap_profile::g_profile->deadlineReached()) {
      construction_failed = true;
      break;
    }
    const chap::lpfix::OrderEntry* selected = nullptr;
    for (const auto& entry : order) {
      if (std::abs(domains.lower(entry.column) - domains.upper(entry.column)) >
          kBoundTolerance) {
        selected = &entry;
        break;
      }
    }
    if (!selected) break;
    const int j = selected->column;
    ++step;
    const chap::lpfix::ValueChoice value = chap::lpfix::chooseValue(
        lp_x[j], domains.lower(j), domains.upper(j), kIntegerTolerance, rng);
    const auto branch_generation_start = chap_profile::g_profile
        ? Clock::now() : Clock::time_point{};
    const std::vector<chap::lpfix::Branch> branches =
        chap::lpfix::buildBranches(domains.lower(j), domains.upper(j),
                                   value.preferred, model.obj[j],
                                   model.minimize);
    if (chap_profile::g_profile)
      chap_profile::g_profile->t_branch_generation +=
          std::chrono::duration<double>(Clock::now() - branch_generation_start).count();
    bool accepted = false;
    const int cdir_event_index = config.cdir_shadow
        ? cdirObserve(cdir_context, uc_map, domains, j,
            static_cast<int>(std::llround(branches.front().lower)),
            result.backtracks, result.ufpr.cdir) : -1;
    for (size_t branch_index = 0; branch_index < branches.size(); ++branch_index) {
      if (cdir_event_index >= 0 && branch_index > 0)
        result.ufpr.cdir.events[cdir_event_index].opposite_tried = true;
      const chap::lpfix::Branch& branch = branches[branch_index];
      if (chap_profile::g_profile)
        chap_profile::g_profile->beginFix(
            j, value.preferred,
            branch_index == 0 ? static_cast<int64_t>(branches.size()) : 0);
      const size_t pointer = domains.trailPointer();
      const int64_t singleton_before = countSingletonIntegers(model, domains);
      const int64_t a_contradictions_before = result.ufpr.a_contradictions;
      bool repair_invoked = false;
      bool repair_succeeded = false;
      double segment_repair_time_sec = 0.0;
      int64_t explicit_set_count = 0;
      int64_t segment_new_fix_count = 0;
      bool segment_attempt = false;
      bool segment_accepted = false;
      bool segment_fallback = false;
      bool segment_domains_ok = true;
      bool b_later_contradiction = false;
      C1ShadowDecision c1_decision;
      std::vector<int> segment_columns{j};
      const auto segment_start = Clock::now();
      if (config.ufpr_segment &&
          branch.kind == chap::lpfix::BranchKind::Fix &&
          j >= 0 && j < static_cast<int>(uc_map.col_kind.size()) &&
          uc_map.col_kind[j] == 'c') {
        segment_attempt = true;
        const auto anchor_start = Clock::now();
        const int target = static_cast<int>(std::llround(branch.lower));
        const int anchor_unit = uc_map.col_unit[j];
        const int anchor_period = uc_map.col_time[j];
        result.ufpr.b_anchor_guidance_time_sec +=
            std::chrono::duration<double>(Clock::now() - anchor_start).count();
        const auto construction_start = Clock::now();
        segment_columns = ufprSegmentColumns(
            uc_map, j, lp_x, target,
            config.ufpr_segment_lmax, &domains);
        const double construction_sec = std::chrono::duration<double>(
            Clock::now() - construction_start).count();
        result.ufpr.b_segment_construction_time_sec += construction_sec;
        result.ufpr.b_segment_construction_times_sec.push_back(construction_sec);
        const auto metadata_start = Clock::now();
        ++result.ufpr.b_segments_attempted;
        if (target != 0)
          ++result.ufpr.b_on_segments;
        else
          ++result.ufpr.b_off_segments;
        const size_t segment_length = std::min<size_t>(
            4, segment_columns.size());
        ++result.ufpr.b_segment_length_counts[segment_length];
        const uint64_t fingerprint =
            ufprSegmentFingerprint(uc_map, segment_columns, target);
        const uint64_t local_signature =
            ufprLocalStateSignature(domains, segment_columns, fingerprint);
        const uint64_t anchor_key =
            (static_cast<uint64_t>(static_cast<uint32_t>(anchor_unit)) << 32) |
            static_cast<uint32_t>(anchor_period);
        if (result.ufpr.b_fingerprint_counts[fingerprint]++ > 0)
          ++result.ufpr.b_intra_task_duplicates;
        if (result.ufpr.b_local_state_counts[local_signature]++ > 0)
          ++result.ufpr.b_identical_local_state_repeats;
        if (result.ufpr.b_anchor_counts[anchor_key]++ > 0)
          ++result.ufpr.b_repeated_anchor_selections;
        result.ufpr.b_metadata_time_sec += std::chrono::duration<double>(
            Clock::now() - metadata_start).count();
        if (config.ufpr_c1_shadow) {
          const auto c1_start = Clock::now();
          c1_decision = evaluateC1ShadowSegment(
              model, uc_map, domains, *c1_reference_state,
              segment_columns, target, result.ufpr);
          const double c1_sec = std::chrono::duration<double>(
              Clock::now() - c1_start).count();
          result.ufpr.c1_total_time_sec += c1_sec;
          result.ufpr.c1_max_time_per_segment_sec = std::max(
              result.ufpr.c1_max_time_per_segment_sec, c1_sec);
        }
      }
      PropagationResult prop;
      {
        chap_profile::ScopedPhase direct_phase(chap_profile::Phase::DirectFix);
        bool domains_ok = true;
        const auto domain_loop_start = segment_attempt
            ? Clock::now() : Clock::time_point{};
        double fixing_sec = 0.0;
        for (int column : segment_columns) {
          if (std::abs(domains.lower(column) - domains.upper(column)) <=
              kBoundTolerance)
            continue;
          const double lower = column == j ? branch.lower : branch.lower;
          const double upper = column == j ? branch.upper : branch.upper;
          const auto fixing_start = segment_attempt
              ? Clock::now() : Clock::time_point{};
          if (!domains.setDomain(column, lower, upper,
                                 static_cast<int>(step))) {
            if (segment_attempt)
              fixing_sec += std::chrono::duration<double>(
                  Clock::now() - fixing_start).count();
            domains_ok = false;
            break;
          }
          if (segment_attempt)
            fixing_sec += std::chrono::duration<double>(
                Clock::now() - fixing_start).count();
          ++explicit_set_count;
        }
        segment_domains_ok = domains_ok;
        if (segment_attempt) {
          const double loop_sec = std::chrono::duration<double>(
              Clock::now() - domain_loop_start).count();
          result.ufpr.b_tentative_fixing_time_sec += fixing_sec;
          result.ufpr.b_domain_inspection_time_sec +=
              std::max(0.0, loop_sec - fixing_sec);
          segment_new_fix_count = explicit_set_count;
          const auto metadata_start = Clock::now();
          ++result.ufpr.b_new_fix_counts[std::min<int64_t>(4,
                                                           segment_new_fix_count)];
          if (segment_new_fix_count == 0) ++result.ufpr.b_no_op_segments;
          result.ufpr.b_metadata_time_sec += std::chrono::duration<double>(
              Clock::now() - metadata_start).count();
        }
        if (!domains_ok) {
          prop.feasible = false;
        } else {
          const auto propagation_start = segment_attempt
              ? Clock::now() : Clock::time_point{};
          prop = runUfprClosure(
              model, uc_map, domains, 20, static_cast<int>(step),
              config.ufpr_temporal, config.ufpr_capacity_guard, result.ufpr);
          if (segment_attempt) {
            const double propagation_sec = std::chrono::duration<double>(
                Clock::now() - propagation_start).count();
            ++result.ufpr.b_generic_propagation_calls;
            result.ufpr.b_generic_propagation_time_sec += propagation_sec;
            result.ufpr.b_propagation_call_times_sec.push_back(propagation_sec);
            result.ufpr.b_propagation_rounds += prop.rounds;
            result.ufpr.b_max_propagation_rounds = std::max<int64_t>(
                result.ufpr.b_max_propagation_rounds, prop.rounds);
            result.ufpr.b_rows_visited += prop.rows_visited;
            result.ufpr.b_domain_changes_from_propagation +=
                prop.tightened_bounds;
            if (segment_new_fix_count == 0) {
              ++result.ufpr.b_propagation_after_no_op;
              result.ufpr.b_time_after_no_op_sec += propagation_sec;
            }
          }
        }
      }
      result.tightened_bounds += prop.tightened_bounds;
      if (cdir_event_index >= 0 && branch_index == 0 && !prop.time_limit) {
        auto& event = result.ufpr.cdir.events[cdir_event_index];
        event.propagation_ok = prop.feasible;
        event.contradiction = !prop.feasible;
      }
      if (prop.time_limit ||
          (chap_profile::g_profile && chap_profile::g_profile->deadlineReached())) {
        if (chap_profile::g_profile) chap_profile::g_profile->endFix(false);
        construction_failed = true;
        break;
      }
      bool needs_repair = false;
      if (!prop.feasible) {
        const auto contradiction_start = segment_attempt
            ? Clock::now() : Clock::time_point{};
        needs_repair = domains.totalViolation() > kConstraintTolerance;
        if (segment_attempt)
          result.ufpr.b_contradiction_check_time_sec +=
              std::chrono::duration<double>(
                  Clock::now() - contradiction_start).count();
      }
      if (needs_repair) {
        repair_invoked = true;
        ++result.repair_calls;
        const int64_t repair_call_id = ++g_repair_calls;
        const auto repair_start = (segment_attempt || cdir_event_index >= 0)
            ? Clock::now() : Clock::time_point{};
        RepairWalkResult repair = repairWalk(
            model, domains, j, static_cast<int>(step), repair_call_id, rng);
        if (cdir_event_index >= 0 && branch_index == 0) {
          auto& event = result.ufpr.cdir.events[cdir_event_index];
          event.repairwalk = true;
          event.repairwalk_time += std::chrono::duration<double>(
              Clock::now()-repair_start).count();
          event.backtracked = repair.backtracks > 0;
        }
        if (segment_attempt) {
          segment_repair_time_sec = std::chrono::duration<double>(
              Clock::now() - repair_start).count();
          result.ufpr.b_repairwalk_time_sec += segment_repair_time_sec;
          if (c1_decision.checked && c1_decision.pass)
            result.ufpr.c1_repairwalk_time_after_pass_sec +=
                segment_repair_time_sec;
          else if (c1_decision.checked)
            result.ufpr.c1_repairwalk_time_after_reject_sec +=
                segment_repair_time_sec;
        }
        result.backtracks += repair.backtracks;
        g_backtracks += repair.backtracks;
        repair_succeeded = repair.feasible;
        if (repair_succeeded &&
            (config.ufpr_temporal || config.ufpr_capacity_guard)) {
          PropagationResult post_repair = runUfprClosure(
              model, uc_map, domains, 20, static_cast<int>(step),
              config.ufpr_temporal, config.ufpr_capacity_guard, result.ufpr);
          result.tightened_bounds += post_repair.tightened_bounds;
          repair_succeeded = post_repair.feasible && !post_repair.time_limit;
        }
        if (repair_succeeded) {
          ++result.successful_repairs;
          ++g_successful_repairs;
        }
        if (segment_attempt && c1_decision.checked &&
            !c1_decision.pass && !repair_succeeded)
          ++result.ufpr.c1_rejects_associated_with_repairwalk_failures;
        if (chap_profile::g_profile && chap_profile::g_profile->deadlineReached()) {
          chap_profile::g_profile->endFix(false);
          construction_failed = true;
          break;
        }
      }
      bool branch_feasible = prop.feasible || repair_succeeded;
      if (segment_attempt && !branch_feasible) {
        const auto fallback_start = Clock::now();
        const auto rollback_start = Clock::now();
        domains.backtrack(pointer);
        const double rollback_sec = std::chrono::duration<double>(
            Clock::now() - rollback_start).count();
        result.ufpr.b_backtrack_rollback_time_sec += rollback_sec;
        const bool fallback_ok = domains.setDomain(
            j, branch.lower, branch.upper, static_cast<int>(step));
        PropagationResult fallback_prop;
        double fallback_propagation_sec = 0.0;
        if (fallback_ok) {
          const auto propagation_start = Clock::now();
          fallback_prop = runUfprClosure(
              model, uc_map, domains, 20, static_cast<int>(step),
              config.ufpr_temporal, config.ufpr_capacity_guard, result.ufpr);
          fallback_propagation_sec = std::chrono::duration<double>(
              Clock::now() - propagation_start).count();
          ++result.ufpr.b_generic_propagation_calls;
          result.ufpr.b_generic_propagation_time_sec += fallback_propagation_sec;
          result.ufpr.b_propagation_call_times_sec.push_back(
              fallback_propagation_sec);
          result.ufpr.b_propagation_rounds += fallback_prop.rounds;
          result.ufpr.b_max_propagation_rounds = std::max<int64_t>(
              result.ufpr.b_max_propagation_rounds, fallback_prop.rounds);
          result.ufpr.b_rows_visited += fallback_prop.rows_visited;
          result.ufpr.b_domain_changes_from_propagation +=
              fallback_prop.tightened_bounds;
        }
        branch_feasible = fallback_ok && fallback_prop.feasible &&
                          !fallback_prop.time_limit;
        const double fallback_total_sec = std::chrono::duration<double>(
            Clock::now() - fallback_start).count();
        result.ufpr.b_single_fallback_time_sec += std::max(
            0.0, fallback_total_sec - rollback_sec - fallback_propagation_sec);
        if (branch_feasible) {
          ++result.ufpr.b_segments_fallback_to_single;
          segment_fallback = true;
          explicit_set_count = 1;
        } else {
          ++result.ufpr.b_contradictions;
          b_later_contradiction = true;
          if (!segment_domains_ok || !fallback_ok)
            ++result.ufpr.b_reject_domain_empty;
          else if (!prop.feasible || !fallback_prop.feasible)
            ++result.ufpr.b_reject_propagation_contradiction;
          else
            ++result.ufpr.b_reject_other;
        }
      }
      if (segment_attempt && c1_decision.checked) {
        if (!c1_decision.pass && b_later_contradiction)
          ++result.ufpr.c1_reject_and_later_contradiction;
        else if (!c1_decision.pass)
          ++result.ufpr.c1_reject_but_no_contradiction;
        else if (b_later_contradiction)
          ++result.ufpr.c1_pass_but_later_contradiction;
      }
      if (config.debug_trace &&
          (trace_count < config.debug_trace_limit ||
           branch.kind != chap::lpfix::BranchKind::Fix)) {
        std::lock_guard<std::mutex> lock(g_repair_log_mutex);
        std::cout << std::setprecision(12)
                  << "LP_FIX_TRACE checkpoint=" << config.checkpoint
                  << " strategy=" << chap::lpfix::strategyName(config.strategy)
                  << " seed=" << config.seed << " selected_var=" << j
                  << " xLP=" << value.x_lp << " floor=" << value.low
                  << " ceil=" << value.high
                  << " fractional_part=" << value.fractional_part
                  << " fractionality="
                  << chap::lpfix::fractionality(value.x_lp)
                  << " reduced_cost=" << reduced_cost[j]
                  << " selected_row=" << selected->selected_row
                  << " dual_value="
                  << (selected->selected_row >= 0
                          ? dual[selected->selected_row]
                          : std::numeric_limits<double>::quiet_NaN())
                  << " variable_type="
                  << (model.var_type[j] == VarType::Binary ? "BINARY"
                                                           : "INTEGER")
                  << " random_draw=" << value.random_draw
                  << " preferred_value=" << value.preferred
                  << " branch=" << chap::lpfix::branchName(branch.kind)
                  << " branch_lower=" << branch.lower
                  << " branch_upper=" << branch.upper
                  << " propagation_result="
                  << (prop.feasible ? "FEASIBLE" : "INFEASIBLE")
                  << " repair_invoked=" << (repair_invoked ? "YES" : "NO")
                  << " repair_success=" << (repair_succeeded ? "YES" : "NO")
                  << '\n';
        ++trace_count;
      }
      if (branch_feasible) {
        segment_accepted = segment_attempt && !segment_fallback;
        if (segment_accepted) {
          const auto metadata_start = Clock::now();
          ++result.ufpr.b_segments_accepted;
          result.ufpr.b_segment_length_total += explicit_set_count;
          result.ufpr.b_segment_length_max = std::max(
              result.ufpr.b_segment_length_max, explicit_set_count);
          result.ufpr.b_variables_fixed += explicit_set_count;
          result.ufpr.b_metadata_time_sec += std::chrono::duration<double>(
              Clock::now() - metadata_start).count();
        }
        const int64_t singleton_after = countSingletonIntegers(model, domains);
        if (branch.kind == chap::lpfix::BranchKind::Fix &&
            std::abs(domains.lower(j) - domains.upper(j)) <= kBoundTolerance)
          result.explicit_fixings += explicit_set_count;
        const int64_t newly_singleton =
            std::max<int64_t>(0, singleton_after - singleton_before);
        if (newly_singleton > 0) {
          const int64_t explicit_increment =
              branch.kind == chap::lpfix::BranchKind::Fix
                  ? explicit_set_count : 0;
          result.propagated_fixings +=
              std::max<int64_t>(0, newly_singleton - explicit_increment);
          if (segment_attempt)
            result.ufpr.b_propagated_fixes += std::max<int64_t>(
                0, newly_singleton - explicit_increment);
        }
        accepted = true;
        if (segment_attempt)
          result.ufpr.b_time_sec += std::chrono::duration<double>(
              Clock::now() - segment_start).count();
        if (chap_profile::g_profile) chap_profile::g_profile->endFix(true);
        break;
      }
      if (segment_attempt) {
        const auto metadata_start = Clock::now();
        ++result.ufpr.b_segments_rejected;
        if (segment_domains_ok && prop.feasible)
          ++result.ufpr.b_reject_other;
        result.ufpr.b_metadata_time_sec += std::chrono::duration<double>(
            Clock::now() - metadata_start).count();
      }
      if (result.ufpr.a_contradictions > a_contradictions_before)
        ++result.ufpr.a_backtracks;
      const auto rejected_backtrack_start = segment_attempt
          ? Clock::now() : Clock::time_point{};
      domains.backtrack(pointer);
      if (cdir_event_index >= 0 && branch_index == 0)
        result.ufpr.cdir.events[cdir_event_index].backtracked = true;
      if (segment_attempt)
        result.ufpr.b_backtrack_rollback_time_sec +=
            std::chrono::duration<double>(
                Clock::now() - rejected_backtrack_start).count();
      ++result.backtracks;
      ++g_backtracks;
      if (chap_profile::g_profile) chap_profile::g_profile->endFix(false);
      if (segment_attempt)
        result.ufpr.b_time_sec += std::chrono::duration<double>(
            Clock::now() - segment_start).count();
    }
    if (chap_profile::g_profile && chap_profile::g_profile->time_limit) break;
    if (!accepted) {
      construction_failed = true;
      break;
    }
  }

  result.decisions = result.explicit_fixings;
  const bool complete_integer_target =
      !construction_failed &&
      !(chap_profile::g_profile && chap_profile::g_profile->time_limit) &&
      countSingletonIntegers(model, domains) ==
          static_cast<int64_t>(model.integer_columns.size());
  result.complete_integer_target = complete_integer_target;
  if (complete_integer_target) countUcViolations(uc_map, domains, result);
  if (integer_target_out) {
    integer_target_out->clear();
    if (complete_integer_target) {
      *integer_target_out = lp_x;
      for (int j : model.integer_columns)
        (*integer_target_out)[j] = domains.lower(j);
    }
  }
  if (complete_integer_target) {
    const double construction_elapsed =
        std::chrono::duration<double>(Clock::now() - fpr_start).count();
    const double completion_limit =
        std::max(0.0, lp_time_limit_sec - construction_elapsed);
    if (completion_limit <= 0.0) {
      result.completion_lp_status = LpSolveStatus::TIME_LIMIT;
      result.completion_model_status =
          lpSolveStatusName(result.completion_lp_status);
    } else {
      ++result.final_lp_calls;
      if (chap_profile::g_profile)
        chap_profile::g_profile->completion_start_time =
            chap_profile::g_profile->elapsed();
      const auto final_lp_start = Clock::now();
      result.invalid_bounds_before_completion = domains.invalidDomainCount();
      LpResult fixed_lp = solveGurobiCompletionLp(
          model, domains.lower(), domains.upper(), completion_limit);
      result.final_lp_time_sec = std::chrono::duration<double>(
                                     Clock::now() - final_lp_start)
                                     .count();
      result.completion_pass_model_status = fixed_lp.pass_model_status;
      result.completion_run_status = fixed_lp.run_status;
      result.completion_lp_status = fixed_lp.lp_status;
      result.completion_model_status = fixed_lp.status;
      result.completion_backend = fixed_lp.backend;
      result.completion_raw_solver_status = fixed_lp.raw_solver_status;
      result.completion_simplex_iterations = fixed_lp.simplex_iterations;
      result.completion_ipm_iterations = fixed_lp.ipm_iterations;
      result.completion_barrier_iterations = fixed_lp.barrier_iterations;
      result.completion_bound_violation = fixed_lp.bound_violation;
      result.completion_constraint_violation = fixed_lp.constraint_violation;
      result.completion_dual_violation = fixed_lp.dual_violation;
      result.completion_primal_infeasibilities = fixed_lp.primal_infeasibilities;
      result.completion_max_primal_infeasibility =
          fixed_lp.max_primal_infeasibility;
      result.completion_objective = fixed_lp.objective;
      if (chap_profile::g_profile) {
        chap_profile::g_profile->completion_status = fixed_lp.status;
        if (!fixed_lp.x.empty())
          chap_profile::g_profile->completion_objective = fixed_lp.objective;
      }
      if (fixed_lp.optimal) {
        result.candidate = fixed_lp.x;
        Evaluation eval = evaluateSolution(model, fixed_lp.x);
        pool.insert({fixed_lp.x, eval, source, config.checkpoint,
                     std::chrono::duration<double>(Clock::now() - global_start)
                         .count()});
        result.feasible = eval.integer_feasible && eval.row_feasible;
      }
    }
    std::cout << std::setprecision(17)
              << "COMPLETION_LP_STATUS="
              << lpSolveStatusName(result.completion_lp_status) << '\n'
              << "COMPLETION_BACKEND=" << result.completion_backend << '\n'
              << "GUROBI_STATUS_RAW="
              << result.completion_raw_solver_status << '\n'
              << "COMPLETION_LP_TIME_SEC=" << result.final_lp_time_sec << '\n'
              << "COMPLETION_LP_ITERATIONS="
              << (result.completion_simplex_iterations +
                  result.completion_ipm_iterations) << '\n'
              << "COMPLETION_LP_BARRIER_ITERATIONS="
              << result.completion_barrier_iterations << '\n'
              << "COMPLETION_LP_MAX_BOUND_VIOLATION="
              << result.completion_bound_violation << '\n'
              << "COMPLETION_LP_MAX_CONSTRAINT_VIOLATION="
              << result.completion_constraint_violation << '\n'
              << std::flush;
  }
  if (!result.feasible) {
    const auto evaluation_start = chap_profile::g_profile
        ? Clock::now() : Clock::time_point{};
    Evaluation eval = evaluateSolution(model, result.candidate);
    if (chap_profile::g_profile)
      chap_profile::g_profile->t_final_evaluation +=
          std::chrono::duration<double>(Clock::now() - evaluation_start).count();
    pool.insert({result.candidate, eval, source, config.checkpoint,
                 std::chrono::duration<double>(Clock::now() - global_start)
                     .count()});
  }
  result.fpr_time_sec =
      std::chrono::duration<double>(Clock::now() - fpr_start).count();
  if (result.feasible)
    result.termination = "FEASIBLE";
  else if (complete_integer_target)
    result.termination = std::string("COMPLETION_LP_") +
        lpSolveStatusName(result.completion_lp_status);
  else if (construction_failed)
    result.termination = "CONSTRUCTION_FAILED";
  else if (step >= step_limit)
    result.termination = "STEP_LIMIT";
  else
    result.termination = "INCOMPLETE";
  copyDomainInvariantMetrics(result, domains);
  copyRuntimeMetrics(result, runtime_metrics);
  if (chap_profile::g_profile) {
    const int64_t fixed = countSingletonIntegers(model, domains);
    const int64_t direct = result.explicit_fixings;
    const int64_t propagated = std::max<int64_t>(0, fixed - direct);
    chap_profile::g_profile->finish(
        result.fpr_time_sec, result.feasible, fixed, direct, propagated,
        domains.trailPointer(), step, result.final_lp_calls,
        result.final_lp_time_sec);
  }
  return result;
}

std::string integerSignature(const MIPModel& model, const std::vector<double>& x) {
  std::ostringstream out;
  for (int j : model.integer_columns) out << static_cast<int64_t>(std::llround(x[j])) << ',';
  return out.str();
}

void runFeasibilityPump(const MIPModel& model, const std::vector<double>& initial_lp,
                        SolutionPool& pool, const Clock::time_point start, int max_iterations,
                        int max_repairs, double lp_time_limit_sec, uint64_t seed) {
  std::vector<double> lp_x = initial_lp;
  std::unordered_set<std::string> seen;
  std::mt19937_64 rng(seed);

  for (int iteration = 0; iteration < max_iterations; ++iteration) {
    FprResult fpr = runFpr(model, lp_x, iteration % 2 ? FprStrategy::LpConfidence : FprStrategy::MostIntegral,
                           CandidateSource::FEASPUMP, pool, start, max_repairs,
                           lp_time_limit_sec, seed + static_cast<uint64_t>(iteration));
    if (fpr.feasible) return;

    std::vector<double> target = fpr.candidate.empty() ? lp_x : fpr.candidate;
    for (int j : model.integer_columns) target[j] = clampedIntegerTarget(model, j, target[j]);
    std::string signature = integerSignature(model, target);
    if (!seen.insert(signature).second && !model.integer_columns.empty()) {
      const int perturbations = std::min<int>(5, model.integer_columns.size());
      for (int k = 0; k < perturbations; ++k) {
        int j = model.integer_columns[rng() % model.integer_columns.size()];
        auto alternate = alternateTarget(model, j, lp_x[j], target[j], model.lb[j], model.ub[j]);
        if (alternate) target[j] = *alternate;
      }
    }

    std::vector<double> projection_cost(model.n_cols, 0.0);
    for (int j : model.integer_columns) {
      if (model.var_type[j] == VarType::Binary)
        projection_cost[j] = target[j] < 0.5 ? 1.0 : -1.0;
      else
        projection_cost[j] = lp_x[j] <= target[j] ? -1.0 : 1.0;
    }
    LpResult projection = solveCpuLp(model, nullptr, nullptr, &projection_cost, true, lp_time_limit_sec);
    if (!projection.optimal) return;
    lp_x = std::move(projection.x);
    Evaluation eval = evaluateSolution(model, lp_x);
    pool.insert({lp_x, eval, CandidateSource::LP, iteration + 1,
                 std::chrono::duration<double>(Clock::now() - start).count()});
  }
}

void runCpuTabu(const MIPModel& model, const std::vector<double>& initial_lp, SolutionPool& pool,
                const Clock::time_point start, int max_iterations, int tenure, int neighborhood,
                double lp_time_limit_sec, uint64_t seed) {
  std::vector<double> current = initial_lp;
  for (int j : model.integer_columns) current[j] = clampedIntegerTarget(model, j, current[j]);
  Evaluation current_eval = evaluateSolution(model, current);
  pool.insert({current, current_eval, CandidateSource::CPU_TABU, 0,
               std::chrono::duration<double>(Clock::now() - start).count()});
  std::vector<int> tabu_until(model.n_cols, -1);
  std::mt19937_64 rng(seed);
  double best_violation = current_eval.totalViolation();

  for (int iteration = 1; iteration <= max_iterations; ++iteration) {
    if (auto shared = pool.bestInfeasible(); shared && shared->eval.totalViolation() + 1e-12 < current_eval.totalViolation()) {
      current = shared->x;
      for (int j : model.integer_columns) current[j] = clampedIntegerTarget(model, j, current[j]);
      current_eval = evaluateSolution(model, current);
    }

    std::vector<int> columns = model.integer_columns;
    std::shuffle(columns.begin(), columns.end(), rng);
    if (columns.size() > static_cast<size_t>(neighborhood)) columns.resize(neighborhood);
    std::optional<std::vector<double>> best_neighbor;
    Evaluation best_eval;
    int best_column = -1;

    for (int j : columns) {
      std::vector<double> neighbor = current;
      std::vector<double> moves;
      if (model.var_type[j] == VarType::Binary) {
        moves.push_back(current[j] < 0.5 ? 1.0 : 0.0);
      } else {
        if (!finiteUpper(model.ub[j]) || current[j] + 1.0 <= model.ub[j] + kBoundTolerance)
          moves.push_back(current[j] + 1.0);
        if (!finiteLower(model.lb[j]) || current[j] - 1.0 >= model.lb[j] - kBoundTolerance)
          moves.push_back(current[j] - 1.0);
      }
      for (double move : moves) {
        neighbor[j] = move;
        Evaluation eval = evaluateSolution(model, neighbor);
        const bool aspiration = eval.totalViolation() + 1e-12 < best_violation ||
                                (eval.integer_feasible && eval.row_feasible);
        if (tabu_until[j] > iteration && !aspiration) continue;
        if (!best_neighbor || eval.totalViolation() < best_eval.totalViolation() - 1e-12 ||
            (std::abs(eval.totalViolation() - best_eval.totalViolation()) <= 1e-12 &&
             (model.minimize ? eval.objective < best_eval.objective : eval.objective > best_eval.objective))) {
          best_neighbor = neighbor;
          best_eval = eval;
          best_column = j;
        }
      }
    }
    if (!best_neighbor) break;
    current = std::move(*best_neighbor);
    current_eval = best_eval;
    tabu_until[best_column] = iteration + tenure;
    best_violation = std::min(best_violation, current_eval.totalViolation());
    if (iteration % 5 == 0 || (current_eval.integer_feasible && current_eval.row_feasible)) {
      pool.insert({current, current_eval, CandidateSource::CPU_TABU, iteration,
                   std::chrono::duration<double>(Clock::now() - start).count()});
    }

    if (iteration % 20 == 0 || current_eval.row_feasible) {
      std::vector<double> lower = model.lb;
      std::vector<double> upper = model.ub;
      for (int j : model.integer_columns) lower[j] = upper[j] = clampedIntegerTarget(model, j, current[j]);
      auto prop = propagateBounds(model, lower, upper, 20);
      if (prop.feasible) {
        LpResult fixed_lp = solveCpuLp(model, &lower, &upper, nullptr, false, lp_time_limit_sec);
        if (fixed_lp.optimal) {
          Evaluation eval = evaluateSolution(model, fixed_lp.x);
          pool.insert({fixed_lp.x, eval, CandidateSource::CPU_TABU, iteration,
                       std::chrono::duration<double>(Clock::now() - start).count()});
          if (eval.integer_feasible && eval.row_feasible) return;
        }
      }
    }
  }
}

void writeSolution(const MIPModel& model, const CandidateSolution& candidate, const fs::path& path) {
  std::ofstream out(path);
  if (!out) throw std::runtime_error("cannot open solution output");
  out << std::setprecision(17);
  out << "=obj= " << candidate.eval.objective << '\n';
  for (int64_t j = 0; j < model.n_cols; ++j) out << model.col_names[j] << ' ' << candidate.x[j] << '\n';
}

void writeSummary(const MIPModel& model, const CandidateSolution& candidate, const SolutionPool& pool,
                  const fs::path& path, double elapsed_sec, const std::string& lp_status,
                  const std::vector<std::string>& choices) {
  std::ofstream out(path);
  if (!out) throw std::runtime_error("cannot open summary output");
  out << std::setprecision(17);
  out << "status=" << (candidate.eval.integer_feasible && candidate.eval.row_feasible ? "FEASIBLE" : "NO_FEASIBLE_INCUMBENT") << '\n';
  out << "source=" << sourceName(candidate.source) << '\n';
  out << "objective=" << candidate.eval.objective << '\n';
  out << "max_row_violation=" << candidate.eval.max_row_violation << '\n';
  out << "sum_row_violation=" << candidate.eval.sum_row_violation << '\n';
  out << "max_bound_violation=" << candidate.eval.max_bound_violation << '\n';
  out << "max_integrality_violation=" << candidate.eval.max_integrality_violation << '\n';
  out << "violated_rows=" << candidate.eval.violated_rows << '\n';
  out << "fractional_integer_variables=" << candidate.eval.fractional_integer_variables << '\n';
  out << "n_rows=" << model.n_rows << '\n';
  out << "n_cols=" << model.n_cols << '\n';
  out << "n_integer=" << model.integer_columns.size() << '\n';
  out << "pool_size=" << pool.size() << '\n';
  out << "cpu_lp_status=" << lp_status << '\n';
  out << "elapsed_sec=" << elapsed_sec << '\n';
  out << "constraint_tolerance=" << kConstraintTolerance << '\n';
  out << "integer_tolerance=" << kIntegerTolerance << '\n';
  for (const auto& choice : choices) out << "reproduction_choice=" << choice << '\n';
}

void writePoolAudit(const SolutionPool& pool, const fs::path& path) {
  std::ofstream out(path);
  if (!out) throw std::runtime_error("cannot open pool audit output");
  out << "source\titeration\ttimestamp\tobjective\ttotal_violation\tmax_row_violation"
         "\tmax_integrality_violation\tinteger_feasible\trow_feasible\n";
  out << std::setprecision(17);
  for (const auto& candidate : pool.snapshot()) {
    out << sourceName(candidate.source) << '\t' << candidate.iteration << '\t' << candidate.timestamp << '\t'
        << candidate.eval.objective << '\t' << candidate.eval.totalViolation() << '\t'
        << candidate.eval.max_row_violation << '\t' << candidate.eval.max_integrality_violation << '\t'
        << candidate.eval.integer_feasible << '\t' << candidate.eval.row_feasible << '\n';
  }
}

struct Options {
  std::string model;
  std::string output_dir;
  int fp_iterations = 12;
  int fpr_repairs = 8;
  int tabu_iterations = 200;
  int tabu_tenure = 7;
  int tabu_neighborhood = 64;
  double lp_time_limit = 30.0;
  uint64_t seed = 20260917;
};

Options parseOptions(int argc, char** argv) {
  Options options;
  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    auto value = [&]() -> std::string {
      if (++i >= argc) throw std::runtime_error("missing value for " + arg);
      return argv[i];
    };
    if (arg == "--model") options.model = value();
    else if (arg == "--output-dir") options.output_dir = value();
    else if (arg == "--fp-iterations") options.fp_iterations = std::stoi(value());
    else if (arg == "--fpr-repairs") options.fpr_repairs = std::stoi(value());
    else if (arg == "--tabu-iterations") options.tabu_iterations = std::stoi(value());
    else if (arg == "--tabu-tenure") options.tabu_tenure = std::stoi(value());
    else if (arg == "--tabu-neighborhood") options.tabu_neighborhood = std::stoi(value());
    else if (arg == "--lp-time-limit") options.lp_time_limit = std::stod(value());
    else if (arg == "--seed") options.seed = std::stoull(value());
    else if (arg == "--help") {
      std::cout << "Usage: chap_e2_cpu --model FILE --output-dir DIR [options]\n";
      std::exit(0);
    } else {
      throw std::runtime_error("unknown option: " + arg);
    }
  }
  if (options.model.empty() || options.output_dir.empty())
    throw std::runtime_error("--model and --output-dir are required");
  return options;
}

int main(int argc, char** argv) {
  try {
    const Options options = parseOptions(argc, argv);
    const auto start = Clock::now();
    fs::create_directories(options.output_dir);
    MIPModel model = loadModel(options.model);
    std::cout << "E2 pure CPU model: rows=" << model.n_rows << " cols=" << model.n_cols
              << " integer=" << model.integer_columns.size() << '\n';
    std::cout << "CPU LP backend: HiGHS 1.14.0; all integrality cleared before every backend solve\n";

    LpResult relaxation = solveCpuLp(model, nullptr, nullptr, nullptr, false, options.lp_time_limit);
    if (!relaxation.optimal) throw std::runtime_error("root CPU LP failed: " + relaxation.status);

    SolutionPool pool(model.minimize, 256);
    Evaluation lp_eval = evaluateSolution(model, relaxation.x);
    pool.insert({relaxation.x, lp_eval, CandidateSource::LP, 0,
                 std::chrono::duration<double>(Clock::now() - start).count()});

    std::thread fpr_integral([&] {
      runFpr(model, relaxation.x, FprStrategy::MostIntegral, CandidateSource::FPR, pool, start,
             options.fpr_repairs, options.lp_time_limit, options.seed + 101);
    });
    std::thread fpr_confidence([&] {
      runFpr(model, relaxation.x, FprStrategy::LpConfidence, CandidateSource::FPR, pool, start,
             options.fpr_repairs, options.lp_time_limit, options.seed + 202);
    });
    std::thread feasibility_pump([&] {
      runFeasibilityPump(model, relaxation.x, pool, start, options.fp_iterations, options.fpr_repairs,
                         options.lp_time_limit, options.seed + 1);
    });
    std::thread tabu([&] {
      runCpuTabu(model, relaxation.x, pool, start, options.tabu_iterations, options.tabu_tenure,
                 options.tabu_neighborhood, options.lp_time_limit, options.seed + 2);
    });

    fpr_integral.join();
    fpr_confidence.join();
    feasibility_pump.join();
    tabu.join();

    auto best = pool.bestFeasible();
    if (!best) best = pool.bestInfeasible();
    if (!best) throw std::runtime_error("solution pool is empty");
    const double elapsed_sec = std::chrono::duration<double>(Clock::now() - start).count();
    double first_feasible_time = std::numeric_limits<double>::infinity();
    for (const CandidateSolution& candidate : pool.snapshot()) {
      if (candidate.eval.integer_feasible && candidate.eval.row_feasible)
        first_feasible_time = std::min(first_feasible_time, candidate.timestamp);
    }

    const fs::path output_dir(options.output_dir);
    writeSolution(model, *best, output_dir / "best_candidate.sol");
    writePoolAudit(pool, output_dir / "solution_pool.tsv");
    std::vector<std::string> choices = {
        "cpu_workers=4 (two FPR strategies, one feasibility pump, one CPU tabu)",
        "fpr_max_repairs=" + std::to_string(options.fpr_repairs),
        "feasibility_pump_iterations=" + std::to_string(options.fp_iterations),
        "tabu_iterations=" + std::to_string(options.tabu_iterations),
        "tabu_tenure=" + std::to_string(options.tabu_tenure),
        "tabu_neighborhood=" + std::to_string(options.tabu_neighborhood),
        "random_seed=" + std::to_string(options.seed),
        "propagation_round_limit=20",
        "fpr_repair_variant=RepairWalk",
        "fpr_repair_noise=0.75",
        "fpr_repair_iteration_limit=200",
        "fpr_domains_and_row_activities=reversible_incremental_trail",
        "HiGHS replaces paper Xpress for continuous LP subproblems",
    };
    writeSummary(model, *best, pool, output_dir / "e2_summary.txt", elapsed_sec, relaxation.status, choices);

    std::cout << std::setprecision(12)
              << "Best candidate source=" << sourceName(best->source)
              << " objective=" << best->eval.objective
              << " max_row_violation=" << best->eval.max_row_violation
              << " max_integrality_violation=" << best->eval.max_integrality_violation
              << " pool_size=" << pool.size() << " elapsed_sec=" << elapsed_sec << '\n';
    std::cout << "FPR_REPAIR_CALLS=" << g_repair_calls.load() << '\n'
              << "FPR_SUCCESSFUL_REPAIRS=" << g_successful_repairs.load() << '\n'
              << "FPR_BACKTRACKS=" << g_backtracks.load() << '\n';
    if (std::isfinite(first_feasible_time))
      std::cout << "E2_FIRST_FEASIBLE_TIME_SEC=" << first_feasible_time << '\n';
    else
      std::cout << "E2_FIRST_FEASIBLE_TIME_SEC=NA\n";
    const bool feasible = best->eval.integer_feasible && best->eval.row_feasible;
    std::cout << "E2_INTERNAL_FEASIBLE=" << (feasible ? "YES" : "NO") << '\n';
    return feasible ? 0 : 2;
  } catch (const std::exception& error) {
    std::cerr << "ERROR: " << error.what() << '\n';
    return 1;
  }
}
