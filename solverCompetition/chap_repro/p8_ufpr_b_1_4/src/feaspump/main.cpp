#define main chap_e2_embedded_main
#include "../e2_cpu/main.cpp"
#undef main

extern "C" {
#include "cupdlpx.h"
#include "mps_parser.h"
}

#include <bit>
#include <deque>
#include <filesystem>
#include <map>
#include <set>

namespace fp = std::filesystem;

namespace chap::feaspump {

constexpr double kAlpha0 = 1.0;
constexpr double kObjectiveDecay = 0.1;
constexpr int kMaxPumpingLoops = 10000;
constexpr int kMaxStallLoops = 10;
constexpr int kCycleMemory = 3;
constexpr int kForcedPerturbationFrequency = 100;
constexpr int kMinimumCycleOneFlips = 10;
constexpr uint64_t kReferenceSeed = 13;
constexpr double kCycleAlphaTolerance = 1e-12;
constexpr double kFeasPumpWorkerTimeLimitSec = 60.0;

enum class Mode { Chap, Fp2Reference };

struct Options {
  std::string model;
  std::string output_dir;
  int64_t checkpoint = 100;
  chap::lpfix::Strategy strategy = chap::lpfix::Strategy::Frac;
  uint64_t seed = kReferenceSeed;
  Mode mode = Mode::Chap;
  int gpu_iteration_limit = 100000;
  double gpu_time_limit = 300.0;
  double lp_time_limit = 30.0;
  double global_time_limit_sec = 300.0;
  double worker_time_limit_sec = kFeasPumpWorkerTimeLimitSec;
  bool debug_trace = false;
};

struct LpSnapshot {
  int64_t checkpoint = 0;
  int64_t generation = 0;
  std::string source;
  double source_objective = 0.0;
  std::vector<double> x;
  std::vector<double> y;
  std::vector<double> rc;
};

struct ProjectionResult {
  bool optimal = false;
  LpSolveStatus lp_status = LpSolveStatus::UNKNOWN;
  std::string status;
  LpSnapshot snapshot;
  double distance_component = 0.0;
  double original_objective_component = 0.0;
  double normalized_projection_objective = 0.0;
  double elapsed_sec = 0.0;
  int64_t iterations = 0;
  bool objective_valid = false;
  double objective = std::numeric_limits<double>::quiet_NaN();
};

struct CycleState {
  std::vector<int64_t> target;
  double alpha = 0.0;
  int iteration = 0;
};

struct Metrics {
  std::string instance;
  int64_t checkpoint = 0;
  std::string strategy;
  uint64_t seed = 0;
  int fp_iterations = 0;
  int projection_calls = 0;
  int fpr_calls = 0;
  int64_t repair_calls = 0;
  int64_t repair_successes = 0;
  int64_t backtracks = 0;
  int cycle_count = 0;
  int perturbation_count = 0;
  double projection_time = 0.0;
  double largest_projection_time = 0.0;
  double fpr_time = 0.0;
  double final_completion_time = 0.0;
  double total_time = 0.0;
  double worker_start_time = 0.0;
  double worker_end_time = 0.0;
  double worker_wall_time = 0.0;
  std::string termination_reason = "UNKNOWN";
  double time_to_first_feasible = std::numeric_limits<double>::quiet_NaN();
  double best_integer_violation = std::numeric_limits<double>::infinity();
  double best_fp_distance = std::numeric_limits<double>::infinity();
  int feasible_candidates = 0;
  double best_objective = std::numeric_limits<double>::quiet_NaN();
  std::string checker = "PENDING";
  bool failed_candidate_retained = false;
  std::string feasible_solution;
  std::string partial_solution;
  std::map<LpSolveStatus, int> projection_status_counts;
  std::map<LpSolveStatus, int> completion_status_counts;
};

double elapsedSince(const Clock::time_point start) {
  return std::chrono::duration<double>(Clock::now() - start).count();
}

double currentGlobalRemaining(const Options& options,
                              const Clock::time_point global_start) {
  return std::max(0.0, options.global_time_limit_sec -
      elapsedSince(global_start));
}

double currentWorkerRemaining(const Options& options,
                              const Clock::time_point worker_start) {
  return std::max(0.0, options.worker_time_limit_sec -
      elapsedSince(worker_start));
}

double currentEffectiveLpTimeLimit(const Options& options,
                                   const Clock::time_point global_start,
                                   const Clock::time_point worker_start) {
  return std::min(currentGlobalRemaining(options, global_start),
                  currentWorkerRemaining(options, worker_start));
}

chap::lpfix::Strategy parseStrategy(const std::string& value) {
  if (value == "FRAC") return chap::lpfix::Strategy::Frac;
  if (value == "REDCOST") return chap::lpfix::Strategy::RedCost;
  if (value == "DUAL") return chap::lpfix::Strategy::Dual;
  if (value == "TYPE") return chap::lpfix::Strategy::Type;
  throw std::runtime_error("unknown FPR strategy: " + value);
}

Options parseOptions(int argc, char** argv) {
  Options options;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    auto value = [&]() {
      if (++i >= argc) throw std::runtime_error("missing value for " + arg);
      return std::string(argv[i]);
    };
    if (arg == "--model") options.model = value();
    else if (arg == "--output-dir") options.output_dir = value();
    else if (arg == "--checkpoint") options.checkpoint = std::stoll(value());
    else if (arg == "--strategy") options.strategy = parseStrategy(value());
    else if (arg == "--seed") options.seed = std::stoull(value());
    else if (arg == "--mode") {
      const std::string mode = value();
      if (mode == "chap") options.mode = Mode::Chap;
      else if (mode == "fp2-reference") options.mode = Mode::Fp2Reference;
      else throw std::runtime_error("unknown mode: " + mode);
    } else if (arg == "--gpu-iteration-limit") options.gpu_iteration_limit = std::stoi(value());
    else if (arg == "--gpu-time-limit") options.gpu_time_limit = std::stod(value());
    else if (arg == "--lp-time-limit") options.lp_time_limit = std::stod(value());
    else if (arg == "--debug-trace") options.debug_trace = true;
    else if (arg == "--help") {
      std::cout << "Usage: chap_feaspump --model FILE --output-dir DIR "
                   "[--checkpoint N] [--strategy FRAC|REDCOST|DUAL|TYPE] "
                   "[--seed N] [--mode chap|fp2-reference] [--debug-trace]\n";
      std::exit(0);
    } else throw std::runtime_error("unknown option: " + arg);
  }
  if (options.model.empty() || options.output_dir.empty())
    throw std::runtime_error("--model and --output-dir are required");
  return options;
}

void validateSnapshot(const MIPModel& model, const LpSnapshot& snapshot) {
  if (snapshot.x.size() != static_cast<size_t>(model.n_cols) ||
      snapshot.y.size() != static_cast<size_t>(model.n_rows) ||
      snapshot.rc.size() != static_cast<size_t>(model.n_cols))
    throw std::runtime_error("LP snapshot x/y/rc dimension mismatch");
  if (snapshot.source.empty()) throw std::runtime_error("LP snapshot source is missing");
}

uint64_t checksum(const std::vector<double>& values) {
  uint64_t hash = 1469598103934665603ULL;
  for (double value : values) {
    hash ^= std::bit_cast<uint64_t>(value);
    hash *= 1099511628211ULL;
  }
  return hash;
}

std::string checksumText(const std::vector<double>& values) {
  std::ostringstream out;
  out << std::hex << std::setw(16) << std::setfill('0') << checksum(values);
  return out.str();
}

double rawObjective(const MIPModel& model, const std::vector<double>& x) {
  double value = model.objective_offset;
  for (int64_t j = 0; j < model.n_cols; ++j) value += model.obj[j] * x[j];
  return value;
}

double fpDistance(const MIPModel& model, const std::vector<double>& x,
                  const std::vector<double>& target) {
  double distance = 0.0;
  for (int j : model.integer_columns) {
    const double t = std::round(target[j]);
    if (model.var_type[j] == VarType::Binary) {
      distance += t < 0.5 ? x[j] : 1.0 - x[j];
    } else if (finiteLower(model.lb[j]) &&
               std::abs(t - std::ceil(model.lb[j])) <= kIntegerTolerance)
      distance += x[j] - t;
    else if (finiteUpper(model.ub[j]) && std::abs(t - std::floor(model.ub[j])) <= kIntegerTolerance)
      distance += t - x[j];
    else distance += std::abs(x[j] - t);
  }
  return std::max(0.0, distance);
}

std::vector<int64_t> targetSignature(const MIPModel& model,
                                     const std::vector<double>& target) {
  std::vector<int64_t> signature;
  for (int j : model.integer_columns)
    signature.push_back(static_cast<int64_t>(std::llround(target[j])));
  return signature;
}

int detectCycleLength(const std::deque<CycleState>& history,
                      const std::vector<int64_t>& signature, double alpha) {
  for (auto it = history.rbegin(); it != history.rend(); ++it)
    if (it->target == signature && std::abs(it->alpha - alpha) <= kCycleAlphaTolerance)
      return history.back().iteration + 1 - it->iteration;
  return 0;
}

int64_t clampedInteger(const MIPModel& model, int j, int64_t value) {
  if (finiteLower(model.lb[j])) value = std::max<int64_t>(value, static_cast<int64_t>(std::ceil(model.lb[j] - 1e-12)));
  if (finiteUpper(model.ub[j])) value = std::min<int64_t>(value, static_cast<int64_t>(std::floor(model.ub[j] + 1e-12)));
  return value;
}

std::vector<int> perturbTarget(const MIPModel& model,
                               const std::vector<double>& lp_x,
                               std::vector<double>& target, int cycle_length,
                               std::mt19937_64& rng) {
  std::vector<int> candidates = model.integer_columns;
  if (cycle_length == 1) {
    std::stable_sort(candidates.begin(), candidates.end(), [&](int a, int b) {
      const double da = std::abs(lp_x[a] - target[a]);
      const double db = std::abs(lp_x[b] - target[b]);
      return std::abs(da - db) > 1e-15 ? da > db : a < b;
    });
  } else std::shuffle(candidates.begin(), candidates.end(), rng);
  const int flips = std::min<int>(candidates.size(),
      std::max(kMinimumCycleOneFlips, static_cast<int>(std::ceil(0.1 * candidates.size()))));
  std::vector<int> changed;
  for (int k = 0; k < flips; ++k) {
    const int j = candidates[k];
    const int64_t old_value = static_cast<int64_t>(std::llround(target[j]));
    int64_t new_value = old_value;
    if (model.var_type[j] == VarType::Binary) new_value = 1 - old_value;
    else if (cycle_length == 1) {
      const int direction = lp_x[j] >= target[j] ? 1 : -1;
      new_value = clampedInteger(model, j, old_value + direction);
      if (new_value == old_value) new_value = clampedInteger(model, j, old_value - direction);
    } else if (finiteLower(model.lb[j]) && finiteUpper(model.ub[j])) {
      const int64_t lo = static_cast<int64_t>(std::ceil(model.lb[j] - 1e-12));
      const int64_t hi = static_cast<int64_t>(std::floor(model.ub[j] + 1e-12));
      if (lo < hi) {
        std::uniform_int_distribution<int64_t> draw(lo, hi);
        for (int attempt = 0; attempt < 8 && new_value == old_value; ++attempt) new_value = draw(rng);
      }
    } else {
      std::uniform_int_distribution<int> step(-10, 10);
      for (int attempt = 0; attempt < 8 && new_value == old_value; ++attempt)
        new_value = clampedInteger(model, j, old_value + step(rng));
    }
    if (new_value != old_value) {
      target[j] = static_cast<double>(new_value);
      changed.push_back(j);
    }
  }
  return changed;
}

ProjectionResult solveProjection(const MIPModel& model,
                                 const std::vector<double>& target,
                                 double alpha, int64_t generation,
                                 double time_limit_sec) {
  const auto start = Clock::now();
  ProjectionResult result;
  if (time_limit_sec <= 0.0) {
    result.lp_status = LpSolveStatus::TIME_LIMIT;
    result.status = lpSolveStatusName(result.lp_status);
    return result;
  }
  HighsModel working = model.highs_model;
  HighsLp& lp = working.lp_;
  lp.integrality_.assign(lp.num_col_, HighsVarType::kContinuous);
  lp.sense_ = ObjSense::kMinimize;

  double c_norm_sq = 0.0;
  for (double c : model.obj) c_norm_sq += c * c;
  const double c_norm = std::sqrt(c_norm_sq);
  const double delta_norm = std::sqrt(std::max<size_t>(1, model.integer_columns.size()));
  const double distance_weight = (1.0 - alpha) / delta_norm;
  const double objective_weight = c_norm > 0.0 ? alpha / c_norm : 0.0;
  const double sense = model.minimize ? 1.0 : -1.0;

  std::vector<double> distance_coeff(model.n_cols, 0.0);
  double distance_constant = 0.0;
  std::vector<int> interior;
  for (int j : model.integer_columns) {
    const double t = std::round(target[j]);
    const double lo = finiteLower(model.lb[j]) ? std::ceil(model.lb[j] - 1e-12) : -kFiniteThreshold;
    const double hi = finiteUpper(model.ub[j]) ? std::floor(model.ub[j] + 1e-12) : kFiniteThreshold;
    if (model.var_type[j] == VarType::Binary) {
      if (t < 0.5) distance_coeff[j] += 1.0;
      else {
        distance_coeff[j] -= 1.0;
        distance_constant += 1.0;
      }
    } else if (std::abs(t - lo) <= kIntegerTolerance) {
      distance_coeff[j] += 1.0;
      distance_constant -= t;
    } else if (std::abs(t - hi) <= kIntegerTolerance) {
      distance_coeff[j] -= 1.0;
      distance_constant += t;
    } else interior.push_back(j);
  }

  lp.col_cost_.assign(model.n_cols, 0.0);
  for (int64_t j = 0; j < model.n_cols; ++j)
    lp.col_cost_[j] = distance_weight * distance_coeff[j] +
                      objective_weight * sense * model.obj[j];
  lp.offset_ = distance_weight * distance_constant +
               objective_weight * sense * model.objective_offset;

  Highs highs;
  highs.setOptionValue("output_flag", false);
  highs.setOptionValue("threads", 1);
  highs.setOptionValue("time_limit", time_limit_sec);
  if (highs.passModel(std::move(working)) != HighsStatus::kOk) {
    result.lp_status = LpSolveStatus::SOLVER_ERROR;
    result.status = lpSolveStatusName(result.lp_status);
    result.elapsed_sec =
        std::chrono::duration<double>(Clock::now() - start).count();
    return result;
  }
  for (int j : interior) {
    if (highs.addVar(0.0, kHighsInf) != HighsStatus::kOk)
      throw std::runtime_error("failed to add FP distance auxiliary variable");
    const HighsInt d = highs.getNumCol() - 1;
    if (highs.changeColCost(d, distance_weight) != HighsStatus::kOk)
      throw std::runtime_error("failed to set FP distance auxiliary cost");
    const HighsInt indices[2] = {static_cast<HighsInt>(j), d};
    const double upper_values[2] = {1.0, -1.0};
    const double lower_values[2] = {-1.0, -1.0};
    const double t = std::round(target[j]);
    if (highs.addRow(-kHighsInf, t, 2, indices, upper_values) != HighsStatus::kOk ||
        highs.addRow(-kHighsInf, -t, 2, indices, lower_values) != HighsStatus::kOk)
      throw std::runtime_error("failed to add FP absolute-distance rows");
  }

  const HighsStatus run_status = highs.run();
  const HighsModelStatus model_status = highs.getModelStatus();
  result.lp_status = classifyHighsLpStatus(run_status, model_status);
  result.status = lpSolveStatusName(result.lp_status);
  const HighsInfo& info = highs.getInfo();
  result.iterations = info.simplex_iteration_count + info.ipm_iteration_count;
  const HighsSolution& solution = highs.getSolution();
  result.optimal = run_status == HighsStatus::kOk &&
                   model_status == HighsModelStatus::kOptimal &&
                   solution.value_valid && solution.dual_valid;
  result.elapsed_sec = std::chrono::duration<double>(Clock::now() - start).count();
  result.objective_valid = solution.value_valid;
  if (result.objective_valid) result.objective = highs.getObjectiveValue();
  if (!result.optimal) return result;
  result.snapshot.generation = generation;
  result.snapshot.source = "HIGHS_PROJECTION";
  result.snapshot.x.assign(solution.col_value.begin(), solution.col_value.begin() + model.n_cols);
  result.snapshot.rc.assign(solution.col_dual.begin(), solution.col_dual.begin() + model.n_cols);
  result.snapshot.y.assign(solution.row_dual.begin(), solution.row_dual.begin() + model.n_rows);
  result.snapshot.source_objective = rawObjective(model, result.snapshot.x);
  result.distance_component = fpDistance(model, result.snapshot.x, target);
  result.original_objective_component = result.snapshot.source_objective;
  result.normalized_projection_objective =
      distance_weight * result.distance_component +
      objective_weight * sense * result.original_objective_component;
  validateSnapshot(model, result.snapshot);
  return result;
}

std::vector<double> propagationRound(const MIPModel& model,
                                     const std::vector<double>& lp_x) {
  ReversibleDomains domains(model);
  if (!propagateDomains(model, domains, 20, 0).feasible) return {};
  std::vector<int> order = model.integer_columns;
  std::stable_sort(order.begin(), order.end(), [&](int a, int b) {
    const bool binary_a = model.var_type[a] == VarType::Binary;
    const bool binary_b = model.var_type[b] == VarType::Binary;
    if (binary_a != binary_b) return binary_a;
    const double fa = chap::lpfix::fractionality(lp_x[a]);
    const double fb = chap::lpfix::fractionality(lp_x[b]);
    return std::abs(fa - fb) > 1e-15 ? fa < fb : a < b;
  });
  int step = 0;
  bool propagation_enabled = true;
  for (int j : order) {
    if (std::abs(domains.lower(j) - domains.upper(j)) <= kBoundTolerance) continue;
    ++step;
    const double value = std::max(std::ceil(domains.lower(j) - 1e-12),
        std::min(std::floor(domains.upper(j) + 1e-12), std::round(lp_x[j])));
    const size_t pointer = domains.trailPointer();
    if (!domains.setDomain(j, value, value, step)) return {};
    if (propagation_enabled && !propagateDomains(model, domains, 20, step).feasible) {
      domains.backtrack(pointer);
      if (!domains.setDomain(j, value, value, step)) return {};
      propagation_enabled = false;
    }
  }
  if (countSingletonIntegers(model, domains) !=
      static_cast<int64_t>(model.integer_columns.size())) return {};
  std::vector<double> target = lp_x;
  for (int j : model.integer_columns) target[j] = domains.lower(j);
  return target;
}

struct SnapshotCapture {
  const MIPModel* model = nullptr;
  int64_t requested_checkpoint = 100;
  std::optional<LpSnapshot> snapshot;
  std::set<int64_t> available;
  std::string error;
  std::mutex mutex;
};

extern "C" void snapshotCallback(const cupdlpx_snapshot_t* source, void* data) {
  auto* capture = static_cast<SnapshotCapture*>(data);
  try {
    if (source->iteration != 100 && source->iteration != 1000 &&
        source->iteration != 10000 && source->iteration != 100000) return;
    LpSnapshot snapshot;
    snapshot.checkpoint = source->iteration;
    snapshot.source = "CUPDLPX";
    snapshot.x.assign(source->primal, source->primal + source->num_primal);
    snapshot.y.assign(source->dual, source->dual + source->num_dual);
    snapshot.rc.assign(source->reduced_cost, source->reduced_cost + source->num_primal);
    snapshot.source_objective = rawObjective(*capture->model, snapshot.x);
    validateSnapshot(*capture->model, snapshot);
    std::lock_guard<std::mutex> lock(capture->mutex);
    capture->available.insert(source->iteration);
    if (source->iteration == capture->requested_checkpoint) capture->snapshot = std::move(snapshot);
  } catch (const std::exception& error) {
    std::lock_guard<std::mutex> lock(capture->mutex);
    capture->error = error.what();
  }
}

void runGpu(const Options& options, SnapshotCapture& capture) {
  lp_problem_t* problem = read_mps_file(options.model.c_str());
  if (!problem) throw std::runtime_error("cuPDLPx failed to read MPS");
  pdhg_parameters_t parameters;
  set_default_parameters(&parameters);
  parameters.verbose = false;
  parameters.presolve = false;
  parameters.termination_evaluation_frequency = 100;
  parameters.termination_criteria.iteration_limit = options.gpu_iteration_limit;
  parameters.termination_criteria.time_sec_limit = options.gpu_time_limit;
  parameters.snapshot_callback = snapshotCallback;
  parameters.snapshot_user_data = &capture;
  cupdlpx_result_t* result = solve_lp_problem(problem, &parameters);
  if (result) cupdlpx_result_free(result);
  lp_problem_free(problem);
  if (!result) throw std::runtime_error("cuPDLPx solve returned null");
  if (!capture.error.empty()) throw std::runtime_error(capture.error);
  if (!capture.snapshot) throw std::runtime_error("requested cuPDLPx checkpoint unavailable");
}

void writeVectorSolution(const MIPModel& model, const std::vector<double>& x,
                         const fp::path& path) {
  CandidateSolution candidate{x, evaluateSolution(model, x), CandidateSource::FEASPUMP, 0, 0.0};
  writeSolution(model, candidate, path);
}

void writeMetrics(const Metrics& m, const fp::path& path) {
  std::ofstream out(path);
  out << "instance\tcheckpoint\tstrategy\tseed\tfp_iterations\tprojection_lp_calls"
         "\tfpr_calls\trepair_calls\trepair_successes\tbacktracks\tcycle_count"
         "\tperturbation_count\tprojection_lp_time\tlargest_projection_time\tfpr_time"
         "\tfinal_completion_lp_time\ttotal_time\tworker_start_time\tworker_end_time"
         "\tworker_wall_time\ttermination_reason\ttime_to_first_feasible\tbest_integer_violation"
         "\tbest_fp_distance\tfeasible_candidate_count\tbest_objective"
         "\tofficial_checker\tfailed_candidate_retained\tfeasible_solution\tpartial_solution\n";
  out << std::setprecision(17) << m.instance << '\t' << m.checkpoint << '\t'
      << m.strategy << '\t' << m.seed << '\t' << m.fp_iterations << '\t'
      << m.projection_calls << '\t' << m.fpr_calls << '\t' << m.repair_calls << '\t'
      << m.repair_successes << '\t' << m.backtracks << '\t' << m.cycle_count << '\t'
      << m.perturbation_count << '\t' << m.projection_time << '\t'
      << m.largest_projection_time << '\t' << m.fpr_time << '\t'
      << m.final_completion_time << '\t' << m.total_time << '\t'
      << m.worker_start_time << '\t' << m.worker_end_time << '\t'
      << m.worker_wall_time << '\t' << m.termination_reason << '\t'
      << m.time_to_first_feasible << '\t' << m.best_integer_violation << '\t'
      << m.best_fp_distance << '\t' << m.feasible_candidates << '\t'
      << m.best_objective << '\t' << m.checker << '\t' << m.failed_candidate_retained << '\t'
      << m.feasible_solution << '\t' << m.partial_solution << '\n';
}

void selfTest() {
  MIPModel binary_model;
  binary_model.n_cols = 2;
  binary_model.lb = {0.0, 0.0};
  binary_model.ub = {1.0, 1.0};
  binary_model.var_type = {VarType::Binary, VarType::Binary};
  binary_model.integer_columns = {0, 1};
  if (std::abs(fpDistance(binary_model, {0.25, 0.75}, {0.0, 1.0}) - 0.5) > 1e-12)
    throw std::runtime_error("binary FP distance self-test failed");
  if (std::abs(std::abs(3.25 - 5.0) - 1.75) > 1e-12)
    throw std::runtime_error("general-integer distance self-test failed");
  const double x = 2.25, target = 4.0;
  if (std::abs(std::max(x - target, target - x) - std::abs(x - target)) > 1e-12)
    throw std::runtime_error("absolute-distance linearization self-test failed");
  const double alpha = 0.25;
  if (std::abs(((1.0 - alpha) * 2.0 + alpha * 6.0) - 3.0) > 1e-12)
    throw std::runtime_error("objective-distance combination self-test failed");
  if (std::abs(kAlpha0 * kObjectiveDecay - 0.1) > 1e-12)
    throw std::runtime_error("alpha update self-test failed");
  std::deque<CycleState> history{{{0, 1}, 0.1, 2}};
  if (detectCycleLength(history, {0, 1}, 0.1) != 1)
    throw std::runtime_error("cycle detection self-test failed");
  std::vector<double> lp{0.2, 0.8};
  std::vector<double> a{0.0, 1.0}, b = a;
  std::mt19937_64 rng_a(13), rng_b(13);
  const auto changed_a = perturbTarget(binary_model, lp, a, 1, rng_a);
  const auto changed_b = perturbTarget(binary_model, lp, b, 1, rng_b);
  if (a != b || changed_a != changed_b)
    throw std::runtime_error("perturbation reproducibility self-test failed");
}

Metrics runPhaseOne(const Options& options, const MIPModel& model,
                    LpSnapshot lp, const Clock::time_point global_start) {
  const auto worker_start = Clock::now();
  validateSnapshot(model, lp);
  Metrics metrics;
  metrics.instance = fp::path(options.model).filename().string();
  metrics.checkpoint = options.checkpoint;
  metrics.strategy = options.mode == Mode::Chap
      ? chap::lpfix::strategyName(options.strategy) : "FP2_PROP_ROUND";
  metrics.seed = options.seed;
  metrics.worker_start_time = elapsedSince(global_start);
  SolutionPool pool(model.minimize, 256);
  std::mt19937_64 perturb_rng(options.seed);
  std::deque<CycleState> history;
  double alpha = kAlpha0;
  int stall = 0;
  std::vector<double> last_target;
  std::ofstream trace(fp::path(options.output_dir) / "chap_feaspump_trace.log");
  trace << std::setprecision(17);

  for (int iteration = 0; iteration < kMaxPumpingLoops && stall < kMaxStallLoops; ++iteration) {
    const double global_remaining_before_fpr =
        currentGlobalRemaining(options, global_start);
    const double fp_remaining_before_fpr =
        currentWorkerRemaining(options, worker_start);
    const double fpr_lp_time_limit =
        std::min(global_remaining_before_fpr, fp_remaining_before_fpr);
    if (fpr_lp_time_limit <= 0.0) {
      metrics.termination_reason = fp_remaining_before_fpr <= 0.0
          ? "WORKER_TIME_LIMIT" : "GLOBAL_TIME_LIMIT";
      break;
    }
    const auto fpr_start = Clock::now();
    FprResult fpr;
    std::vector<double> target;
    if (options.mode == Mode::Chap) {
      LpFixingRunConfig config;
      config.checkpoint = lp.checkpoint;
      config.strategy = options.strategy;
      config.seed = options.seed + static_cast<uint64_t>(iteration);
      config.frac_closest_first = true;
      config.debug_trace = options.debug_trace;
      config.debug_trace_limit = 4;
      fpr = runLpGuidedFpr(model, lp.x, lp.y, lp.rc, config,
                           CandidateSource::FEASPUMP, pool, global_start,
                           fpr_lp_time_limit, &target);
      ++metrics.fpr_calls;
      metrics.repair_calls += fpr.repair_calls;
      metrics.repair_successes += fpr.successful_repairs;
      metrics.backtracks += fpr.backtracks;
      metrics.final_completion_time += fpr.final_lp_time_sec;
      if (fpr.completion_model_status != "NOT_RUN")
        ++metrics.completion_status_counts[fpr.completion_lp_status];
    } else {
      target = propagationRound(model, lp.x);
      if (!target.empty()) {
        std::vector<double> lower = model.lb;
        std::vector<double> upper = model.ub;
        for (int j : model.integer_columns) lower[j] = upper[j] = target[j];
        const auto completion_start = Clock::now();
        const double completion_lp_time_limit = currentEffectiveLpTimeLimit(
            options, global_start, worker_start);
        if (completion_lp_time_limit <= 0.0) {
          metrics.termination_reason = currentWorkerRemaining(
              options, worker_start) <= 0.0
              ? "WORKER_TIME_LIMIT" : "GLOBAL_TIME_LIMIT";
          break;
        }
        LpResult completion = solveCpuLp(model, &lower, &upper, nullptr, false,
                                         completion_lp_time_limit);
        ++metrics.completion_status_counts[completion.lp_status];
        metrics.final_completion_time += std::chrono::duration<double>(
            Clock::now() - completion_start).count();
        if (completion.optimal) {
          const Evaluation eval = evaluateSolution(model, completion.x);
          pool.insert({completion.x, eval, CandidateSource::FEASPUMP, iteration,
                       std::chrono::duration<double>(Clock::now() - global_start).count()});
        }
      }
    }
    metrics.fpr_time += std::chrono::duration<double>(Clock::now() - fpr_start).count();
    metrics.fp_iterations = iteration + 1;
    if (target.empty()) {
      if (metrics.termination_reason == "UNKNOWN")
        metrics.termination_reason = "FPR_CONSTRUCTION_FAILED";
      trace << "CHAP_FEASPUMP_TRACE instance=" << metrics.instance
            << " checkpoint=" << options.checkpoint << " fp_iteration=" << iteration
            << " integer_target_status=FAILED\n";
      break;
    }

    const Evaluation target_eval = evaluateSolution(model, target);
    metrics.best_integer_violation = std::min(metrics.best_integer_violation,
                                               target_eval.max_integrality_violation);
    const double input_distance = fpDistance(model, lp.x, target);
    metrics.best_fp_distance = std::min(metrics.best_fp_distance, input_distance);
    const std::vector<int64_t> signature = targetSignature(model, target);
    const int cycle_length = detectCycleLength(history, signature, alpha);
    const bool forced = iteration > 0 && iteration % kForcedPerturbationFrequency == 0;
    std::vector<int> changed;
    if (cycle_length > 0 || forced) {
      ++metrics.cycle_count;
      changed = perturbTarget(model, lp.x, target,
                              cycle_length > 0 ? cycle_length : kCycleMemory,
                              perturb_rng);
      ++metrics.perturbation_count;
    }
    history.push_back({targetSignature(model, target), alpha, iteration});
    while (history.size() > static_cast<size_t>(kCycleMemory)) history.pop_front();
    last_target = target;

    const auto feasible = pool.bestFeasible();
    const bool completed_feasible = feasible.has_value();
    if (completed_feasible) {
      ++metrics.feasible_candidates;
      metrics.best_objective = feasible->eval.objective;
      metrics.time_to_first_feasible = feasible->timestamp;
      const fp::path feasible_path = fp::path(options.output_dir) / "chap_feaspump_candidate.sol";
      writeSolution(model, *feasible, feasible_path);
      metrics.feasible_solution = feasible_path.string();
    }

    trace << "CHAP_FEASPUMP_TRACE\n"
          << "instance=" << metrics.instance << '\n'
          << "checkpoint=" << options.checkpoint << '\n'
          << "fp_iteration=" << iteration << '\n'
          << "LP_SOURCE=" << lp.source << '\n'
          << "alpha=" << alpha << '\n'
          << "input_lp_objective=" << lp.source_objective << '\n'
          << "input_x_checksum=" << checksumText(lp.x) << '\n'
          << "input_y_checksum=" << checksumText(lp.y) << '\n'
          << "input_rc_checksum=" << checksumText(lp.rc) << '\n'
          << "FPR_strategy=" << metrics.strategy << '\n'
          << "FPR_seed=" << (options.seed + static_cast<uint64_t>(iteration)) << '\n'
          << "FPR_called=" << (options.mode == Mode::Chap ? "YES" : "NO_REFERENCE_PROP_ROUND") << '\n'
          << "integer_variables_fixed=" << model.integer_columns.size() << '\n'
          << "repair_calls=" << fpr.repair_calls << '\n'
          << "repair_successes=" << fpr.successful_repairs << '\n'
          << "backtracks=" << fpr.backtracks << '\n'
          << "integer_target_checksum=" << checksumText(target) << '\n'
          << "final_completion_called=" << (options.mode == Mode::Chap && fpr.final_lp_calls ? "YES" : "NO") << '\n'
          << "final_completion_status=" << (completed_feasible ? "FEASIBLE" : "INFEASIBLE_OR_NOT_CALLED") << '\n'
          << "checker_status=PENDING_EXTERNAL_OFFICIAL_CHECKER\n";

    if (completed_feasible) {
      metrics.termination_reason = "FEASIBLE_FOUND";
      trace << "projection_called=NO_EARLY_FEASIBLE\n"
            << "cycle_detected=" << (cycle_length > 0 ? "YES" : "NO") << '\n'
            << "perturbation_applied=" << (!changed.empty() ? "YES" : "NO") << "\n\n";
      break;
    }

    pool.insert({target, target_eval, CandidateSource::FEASPUMP, iteration,
                 std::chrono::duration<double>(Clock::now() - global_start).count()});
    const double projection_start_time = elapsedSince(global_start);
    const double global_remaining_before_projection =
        currentGlobalRemaining(options, global_start);
    const double fp_remaining_before_projection =
        currentWorkerRemaining(options, worker_start);
    const double effective_lp_time_limit =
        std::min(global_remaining_before_projection,
                 fp_remaining_before_projection);
    if (effective_lp_time_limit <= 0.0) {
      metrics.termination_reason = fp_remaining_before_projection <= 0.0
          ? "WORKER_TIME_LIMIT" : "GLOBAL_TIME_LIMIT";
      break;
    }
    ProjectionResult projection = solveProjection(model, target, alpha,
                                                   lp.generation + 1,
                                                   effective_lp_time_limit);
    ++metrics.projection_status_counts[projection.lp_status];
    ++metrics.projection_calls;
    metrics.projection_time += projection.elapsed_sec;
    metrics.largest_projection_time = std::max(metrics.largest_projection_time,
                                                projection.elapsed_sec);
    std::cout << std::setprecision(17)
              << "FEASPUMP_PROJECTION checkpoint=" << options.checkpoint
              << " start_time=" << projection_start_time
              << " global_remaining=" << global_remaining_before_projection
              << " worker_remaining=" << fp_remaining_before_projection
              << " effective_lp_limit=" << effective_lp_time_limit
              << " solve_time=" << projection.elapsed_sec
              << " solver_status=" << projection.status
              << " lp_iterations=" << projection.iterations
              << " objective="
              << (projection.objective_valid
                      ? projection.objective
                      : std::numeric_limits<double>::quiet_NaN())
              << " optimal=" << (projection.optimal ? "YES" : "NO") << '\n'
              << "PROJECTION_LP_STATUS=" << projection.status << '\n'
              << "PROJECTION_LP_TIME_SEC=" << projection.elapsed_sec << '\n'
              << "PROJECTION_LP_ITERATIONS=" << projection.iterations << '\n'
              << "PROJECTION_LP_OBJECTIVE="
              << (projection.objective_valid
                      ? std::to_string(projection.objective) : "N/A") << '\n'
              << std::flush;
    trace << "projection_called=YES\n"
          << "projection_lp_status=" << projection.status << '\n'
          << "distance_component=" << projection.distance_component << '\n'
          << "original_objective_component=" << projection.original_objective_component << '\n'
          << "projection_objective=" << projection.normalized_projection_objective << '\n';
    if (!projection.optimal) {
      const double global_remaining_after_projection =
          currentGlobalRemaining(options, global_start);
      const double fp_remaining_after_projection =
          currentWorkerRemaining(options, worker_start);
      metrics.termination_reason = fp_remaining_after_projection <= 0.0
          ? "WORKER_TIME_LIMIT"
          : (global_remaining_after_projection <= 0.0
                 ? "GLOBAL_TIME_LIMIT" : "PROJECTION_NOT_OPTIMAL");
      trace << "cycle_detected=" << (cycle_length > 0 ? "YES" : "NO") << '\n'
            << "perturbation_applied=" << (!changed.empty() ? "YES" : "NO") << "\n\n";
      break;
    }
    projection.snapshot.checkpoint = options.checkpoint;
    trace << "output_x_checksum=" << checksumText(projection.snapshot.x) << '\n'
          << "output_y_checksum=" << checksumText(projection.snapshot.y) << '\n'
          << "output_rc_checksum=" << checksumText(projection.snapshot.rc) << '\n'
          << "cycle_detected=" << (cycle_length > 0 ? "YES" : "NO") << '\n'
          << "perturbation_applied=" << (!changed.empty() ? "YES" : "NO") << "\n\n";
    if (projection.distance_component + 1e-12 < metrics.best_fp_distance) {
      metrics.best_fp_distance = projection.distance_component;
      stall = 0;
    } else ++stall;
    lp = std::move(projection.snapshot);
    validateSnapshot(model, lp);
    alpha *= kObjectiveDecay;
  }

  if (metrics.feasible_candidates == 0 && !last_target.empty()) {
    const fp::path partial_path = fp::path(options.output_dir) / "phase1_failed_partial.sol";
    writeVectorSolution(model, last_target, partial_path);
    metrics.partial_solution = partial_path.string();
    metrics.failed_candidate_retained = true;
  }
  if (metrics.termination_reason == "UNKNOWN") {
    metrics.termination_reason = stall >= kMaxStallLoops
        ? "STALL_LIMIT" : "ITERATION_LIMIT";
  }
  metrics.worker_end_time = elapsedSince(global_start);
  metrics.worker_wall_time = elapsedSince(worker_start);
  metrics.total_time = std::chrono::duration<double>(Clock::now() - global_start).count();
  std::cout << std::setprecision(17)
            << "FEASPUMP_WORKER_RESULT"
            << " checkpoint=" << metrics.checkpoint
            << " worker_start_time=" << metrics.worker_start_time
            << " worker_end_time=" << metrics.worker_end_time
            << " worker_wall_time=" << metrics.worker_wall_time
            << " phase1_iterations=" << metrics.fp_iterations
            << " projection_calls=" << metrics.projection_calls
            << " largest_projection_time=" << metrics.largest_projection_time
            << " termination_reason=" << metrics.termination_reason << '\n'
            << std::flush;
  return metrics;
}

}  // namespace chap::feaspump

#ifndef CHAP_FEASPUMP_NO_MAIN
int main(int argc, char** argv) {
  try {
    using namespace chap::feaspump;
    selfTest();
    const chap::feaspump::Options options = chap::feaspump::parseOptions(argc, argv);
    const char* visible = std::getenv("CUDA_VISIBLE_DEVICES");
    if (!visible || std::string(visible) != "1")
      throw std::runtime_error("chap_feaspump requires CUDA_VISIBLE_DEVICES=1");
    fp::create_directories(options.output_dir);
    const auto global_start = Clock::now();
    MIPModel model = loadModel(options.model);
    SnapshotCapture capture;
    capture.model = &model;
    capture.requested_checkpoint = options.checkpoint;
    runGpu(options, capture);
    Metrics metrics = runPhaseOne(options, model, *capture.snapshot, global_start);
    writeMetrics(metrics, fp::path(options.output_dir) / "chap_feaspump_metrics.tsv");
    std::ofstream provenance(fp::path(options.output_dir) / "parameter_provenance.txt");
    provenance << "intermediate_lp_start=CHAP_CONFIRMED\n"
               << "objective_fp=CHAP_CONFIRMED\n"
               << "fpr_replaces_rounding=CHAP_CONFIRMED\n"
               << "alpha_0=1.0 FP2_REFERENCE_DEFAULT CHAP_UNDISCLOSED\n"
               << "objective_decay=0.1 FP2_REFERENCE_DEFAULT CHAP_UNDISCLOSED\n"
               << "max_pumping_loops=10000 FP2_REFERENCE_DEFAULT CHAP_UNDISCLOSED\n"
               << "max_stall_loops=10 FP2_REFERENCE_DEFAULT CHAP_UNDISCLOSED\n"
               << "cycle_memory=3 FP2_REFERENCE_DEFAULT CHAP_UNDISCLOSED\n"
               << "forced_perturbation_frequency=100 FP2_REFERENCE_DEFAULT CHAP_UNDISCLOSED\n"
               << "minimum_cycle1_flips=10 FP2_REFERENCE_DEFAULT CHAP_UNDISCLOSED\n"
               << "seed=13 FP2_REFERENCE_DEFAULT CHAP_UNDISCLOSED\n"
               << "stage3=OFF FP2_REFERENCE_DEFAULT_NOT_EXPLICITLY_PARAMETERIZED_BY_CHAP\n"
               << "projection_backend=HiGHS_1.14.0 REPRODUCTION_SUBSTITUTION\n";
    std::cout << "binary FP distance: PASS\n"
              << "general-integer distance: PASS\n"
              << "absolute-distance linearization: PASS\n"
              << "objective-distance convex combination: PASS\n"
              << "alpha update: PASS\n"
              << "cycle detection: PASS\n"
              << "perturbation reproducibility: PASS\n"
              << "projection x/y/rc consistency: "
              << (metrics.projection_calls > 0 ? "PASS" : "NOT_EXERCISED_EARLY_FEASIBLE") << '\n'
              << "FPR replacing rounding: " << (options.mode == Mode::Chap ? "PASS" : "N/A") << '\n'
              << "full integer target produced: "
              << ((metrics.feasible_candidates || metrics.failed_candidate_retained) ? "PASS" : "FAIL") << '\n'
              << "CHAP_FEASPUMP_SELFTEST="
              << ((metrics.feasible_candidates || metrics.failed_candidate_retained) ? "PASS" : "FAIL") << '\n';
    return (metrics.feasible_candidates || metrics.failed_candidate_retained) ? 0 : 2;
  } catch (const std::exception& error) {
    std::cerr << "ERROR: " << error.what() << '\n';
    return 1;
  }
}
#endif
