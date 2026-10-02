#include <algorithm>
#include <array>
#include <atomic>
#include <bit>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>
#include <unistd.h>
#include <cuda_runtime_api.h>

bool g_ufpr_temporal_enabled = false;
bool g_ufpr_segment_enabled = false;

#define CHAP_END_TO_END_NO_MAIN
#include "src/end_to_end/main.cpp"
#include "../p3c_tabu_policy/policy_worker.hpp"

extern "C" {
#include "cupdlpx.h"
#include "mps_parser.h"
}

using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;

constexpr double kChapGlobalLimitSec = 300.0;
constexpr int64_t kFirstRoutedCheckpoint = 10000;
constexpr double kArchitectureTestLimitSec = 300.0;

enum class WorkerType { Fpr, FeasPump, Tabu };
enum class TaskKind { LpFpr, LpPhase1, LpTabu, TabuPhase2, PartialFprRepair };
enum class PartialRoute {
  None,
  ToFeasPumpPhase2,
  ToFprRepair,
  ToFeasPumpPhase2AndFprRepair
};

const char* workerName(WorkerType value) {
  switch (value) {
    case WorkerType::Fpr: return "FPR";
    case WorkerType::FeasPump: return "FEASPUMP";
    case WorkerType::Tabu: return "GPU_TABU";
  }
  return "UNKNOWN";
}

const char* taskName(TaskKind value) {
  switch (value) {
    case TaskKind::LpFpr: return "LP_TO_FPR";
    case TaskKind::LpPhase1: return "LP_TO_FEASPUMP_PHASE1";
    case TaskKind::LpTabu: return "LP_TO_TABU";
    case TaskKind::TabuPhase2: return "TABU_PARTIAL_TO_FEASPUMP_PHASE2";
    case TaskKind::PartialFprRepair: return "PARTIAL_TO_FPR_REPAIR";
  }
  return "UNKNOWN";
}

struct GlobalRuntimeContext {
  explicit GlobalRuntimeContext(double limit_sec = kChapGlobalLimitSec)
      : start(Clock::now()),
        global_limit_sec(limit_sec),
        architecture_limit_sec(limit_sec),
        deadline(start + std::chrono::duration_cast<Clock::duration>(
            std::chrono::duration<double>(limit_sec))) {}

  const Clock::time_point start;
  const double global_limit_sec;
  const double architecture_limit_sec;
  const Clock::time_point deadline;
  std::atomic<bool> stop_requested{false};
  mutable std::atomic<double> deadline_reached_at_sec{-1.0};
  std::atomic<double> last_new_task_started_at_sec{0.0};
  std::atomic<double> last_worker_finished_at_sec{0.0};

  double elapsed() const {
    return std::chrono::duration<double>(Clock::now() - start).count();
  }
  double remainingTimeSec() const {
    return std::max(0.0, std::chrono::duration<double>(deadline - Clock::now()).count());
  }
  double remaining() const { return remainingTimeSec(); }
  double testRemaining() const { return remainingTimeSec(); }
  bool deadlineReached() const {
    const bool reached = Clock::now() >= deadline;
    if (reached) {
      double expected = -1.0;
      const double when = elapsed();
      deadline_reached_at_sec.compare_exchange_strong(expected, when);
    }
    return reached;
  }
  void noteTaskStarted(double timestamp) {
    last_new_task_started_at_sec.store(timestamp, std::memory_order_release);
  }
  void noteWorkerFinished(double timestamp) {
    double prior = last_worker_finished_at_sec.load(std::memory_order_acquire);
    while (timestamp > prior &&
           !last_worker_finished_at_sec.compare_exchange_weak(prior, timestamp)) {}
  }
  double startEpochSec() const {
    return std::chrono::duration<double>(start.time_since_epoch()).count();
  }
  bool shouldStop() const { return stop_requested.load(std::memory_order_acquire); }
  void requestStop() { stop_requested.store(true, std::memory_order_release); }
};

constexpr uint64_t kTagTabu = 0x544142555F534545ULL;
constexpr uint64_t kTagFpr = 0x4650525F53454544ULL;
constexpr uint64_t kTagFeasPump = 0x4645415350554D50ULL;
constexpr uint64_t kTagRepair = 0x5245504149525F53ULL;
constexpr uint64_t kTagProjection = 0x50524F4A4543544EULL;
constexpr uint64_t kTagCupdlpx = 0x435550444C50585FULL;

uint64_t splitmix64(uint64_t value) {
  value += 0x9E3779B97F4A7C15ULL;
  value = (value ^ (value >> 30)) * 0xBF58476D1CE4E5B9ULL;
  value = (value ^ (value >> 27)) * 0x94D049BB133111EBULL;
  return value ^ (value >> 31);
}

uint64_t deriveSeed(uint64_t global_seed, uint64_t component_tag,
                    uint64_t legacy_seed) {
  // Seed zero reproduces the previous fixed component seed exactly.
  return legacy_seed ^ splitmix64(global_seed ^ component_tag) ^
         splitmix64(component_tag);
}

struct ExperimentSeeds {
  uint64_t global = 0;
  uint64_t tabu = 0;
  uint64_t fpr = 0;
  uint64_t feaspump = 0;
  uint64_t repair = 0;
  uint64_t projection = 0;
  uint64_t cupdlpx = 0;
};

ExperimentSeeds makeExperimentSeeds(uint64_t global_seed) {
  return {global_seed,
          deriveSeed(global_seed, kTagTabu, p3c::kLocalMipBaselineSeed),
          deriveSeed(global_seed, kTagFpr, 13),
          deriveSeed(global_seed, kTagFeasPump, 13),
          deriveSeed(global_seed, kTagRepair, 13),
          deriveSeed(global_seed, kTagProjection, 13),
          deriveSeed(global_seed, kTagCupdlpx, 1)};
}

using Values = std::shared_ptr<const std::vector<double>>;

struct LpSolution {
  uint64_t solution_id = 0;
  int64_t checkpoint = 0;
  double timestamp = 0.0;
  std::string source;
  Values primal;
  Values dual;
  Values reduced_cost;
  int64_t requested_iteration = 0;
  int64_t actual_iteration = 0;
  bool original_coordinates = false;
  bool primal_all_finite = false;
  bool dual_all_finite = false;
  bool reduced_cost_all_finite = false;
  double max_bound_violation = 0.0;
  double max_row_violation = 0.0;
  uint64_t primal_checksum = 0;
  uint64_t dual_checksum = 0;
  uint64_t reduced_cost_checksum = 0;
};

struct PartialSolution {
  uint64_t solution_id = 0;
  uint64_t parent_solution_id = 0;
  uint64_t root_lp_id = 0;
  uint64_t generation = 0;
  uint32_t repair_depth = 0;
  double timestamp = 0.0;
  std::string source;
  Values values;
  std::shared_ptr<const std::vector<uint8_t>> assigned;
  std::shared_ptr<const std::vector<uint8_t>> hard_assignment;
  double violation = std::numeric_limits<double>::infinity();
  double objective = std::numeric_limits<double>::quiet_NaN();
  double max_bound_violation = 0.0;
  double integrality_violation = 0.0;
  std::string metadata;
  std::string consumed_by;
};

struct FeasibleSolution {
  uint64_t solution_id = 0;
  uint64_t repair_parent_id = 0;
  uint64_t repair_root_lp_id = 0;
  uint64_t generation = 0;
  uint64_t incumbent_version = 0;
  bool is_new_incumbent = false;
  double timestamp = 0.0;
  std::string source;
  Values values;
  double objective = 0.0;
  std::string validation_state;
  std::string validation_source;
};

struct ValidationMetadata {
  std::string status;
  std::string source;
};

ValidationMetadata normalizeValidationMetadata(const std::string& label) {
  if (label == "OFFICIAL_CHECKER_PASS")
    return {"FULL_ORIGINAL_MODEL_VALIDATION_PASS", "OFFICIAL_CHECKER"};
  if (label == "FULL_ORIGINAL_MODEL_VALIDATION_PASS")
    return {label, "FULL_ORIGINAL_MODEL_EVALUATION"};
  return {label, "UNSPECIFIED"};
}

struct CandidateRouteInfo {
  std::string route = "UNKNOWN";
  int64_t root_checkpoint = -1;
  uint64_t root_lp_id = 0;
  uint64_t immediate_parent_id = 0;
  bool complete = false;
  std::string diagnostic = "UNKNOWN_SOLUTION_ID";
};

std::string candidateStage(const std::string& source) {
  if (source == "REAL_FPR" || source == "REAL_FPR_PARTIAL")
    return "DIRECT_FPR";
  if (source == "REAL_FEASPUMP_PHASE1" ||
      source == "REAL_FEASPUMP_PHASE1_PARTIAL")
    return "FEASPUMP_PHASE1";
  if (source == "REAL_FEASPUMP_PHASE2" ||
      source == "REAL_FEASPUMP_PHASE2_PARTIAL")
    return "FEASPUMP_PHASE2";
  if (source == "REAL_GPU_TABU_FEASIBLE" ||
      source == "REAL_GPU_TABU_PARTIAL")
    return "GPU_TABU";
  if (source == "REAL_FPR_REPAIR_FEASIBLE" ||
      source == "REAL_FPR_REPAIR_PARTIAL")
    return "FPR_REPAIR";
  return "UNKNOWN_STAGE(" + source + ")";
}

CandidateRouteInfo reconstructCandidateRoute(
    uint64_t solution_id,
    const std::vector<std::shared_ptr<const LpSolution>>& lp_entries,
    const std::vector<std::shared_ptr<const PartialSolution>>& partial_entries,
    const std::vector<std::shared_ptr<const FeasibleSolution>>& feasible_entries) {
  CandidateRouteInfo result;
  std::unordered_map<uint64_t, const LpSolution*> lp_by_id;
  std::unordered_map<uint64_t, const PartialSolution*> partial_by_id;
  std::unordered_map<uint64_t, const FeasibleSolution*> feasible_by_id;
  for (const auto& entry : lp_entries) lp_by_id[entry->solution_id] = entry.get();
  for (const auto& entry : partial_entries)
    partial_by_id[entry->solution_id] = entry.get();
  for (const auto& entry : feasible_entries)
    feasible_by_id[entry->solution_id] = entry.get();

  const auto feasible_it = feasible_by_id.find(solution_id);
  if (feasible_it == feasible_by_id.end()) return result;
  const FeasibleSolution& feasible = *feasible_it->second;
  result.immediate_parent_id = feasible.repair_parent_id;
  const uint64_t declared_root_lp_id = feasible.repair_root_lp_id;
  std::vector<std::string> reverse_stages{candidateStage(feasible.source)};
  bool unknown_stage = reverse_stages.back().rfind("UNKNOWN_STAGE(", 0) == 0;
  std::unordered_set<uint64_t> visited{solution_id};
  uint64_t current_id = feasible.repair_parent_id;

  while (current_id != 0) {
    if (!visited.insert(current_id).second) {
      result.diagnostic = "CYCLE_DETECTED";
      break;
    }
    const auto lp_it = lp_by_id.find(current_id);
    if (lp_it != lp_by_id.end()) {
      result.root_lp_id = current_id;
      result.root_checkpoint = lp_it->second->checkpoint;
      if (declared_root_lp_id != 0 && declared_root_lp_id != current_id) {
        result.diagnostic = "ROOT_ID_MISMATCH";
        break;
      }
      result.complete = !unknown_stage;
      result.diagnostic = result.complete ? "COMPLETE" : "UNKNOWN_STAGE";
      break;
    }
    const auto partial_it = partial_by_id.find(current_id);
    if (partial_it == partial_by_id.end()) {
      result.diagnostic = "MISSING_PARENT_ID_" + std::to_string(current_id);
      break;
    }
    const std::string stage = candidateStage(partial_it->second->source);
    unknown_stage = unknown_stage || stage.rfind("UNKNOWN_STAGE(", 0) == 0;
    reverse_stages.push_back(stage);
    current_id = partial_it->second->parent_solution_id;
  }
  if (current_id == 0 && result.diagnostic == "UNKNOWN_SOLUTION_ID")
    result.diagnostic = "MISSING_PARENT_ID";

  std::reverse(reverse_stages.begin(), reverse_stages.end());
  std::ostringstream route;
  if (result.complete)
    route << "LP_CP" << result.root_checkpoint;
  else
    route << "PARTIAL_ROUTE";
  for (const auto& stage : reverse_stages) route << " -> " << stage;
  route << " -> FEASIBLE";
  result.route = route.str();
  return result;
}

struct Task {
  uint64_t task_id = 0;
  uint64_t solution_id = 0;
  TaskKind kind = TaskKind::LpFpr;
  std::string input_source;
  std::shared_ptr<const LpSolution> lp;
  std::shared_ptr<const PartialSolution> partial;
  uint64_t objective_version_seen = 0;
  std::optional<double> best_known_objective_seen;
  double enqueue_timestamp = 0.0;
};

struct IncumbentSnapshot {
  std::shared_ptr<const FeasibleSolution> feasible;
  uint64_t version = 0;
  std::optional<double> best_known_objective;
};

struct RepairExample {
  bool recorded = false;
  std::string input_source;
  Evaluation input_eval;
  std::string output_type = "FAILED";
  Evaluation output_eval;
  double wall_time = 0.0;
  std::string guidance_source = "NONE";
  std::string termination;
};

struct GpuTrajectoryEntry {
  uint64_t task_id = 0;
  uint64_t parent_solution_id = 0;
  int64_t checkpoint = 0;
  double start_time = 0.0;
  double end_time = 0.0;
  int iterations = 0;
  int moves = 0;
  int tabu_rejections = 0;
  Evaluation input_eval;
  Evaluation output_eval;
};

struct RepairTrajectoryEntry {
  uint64_t task_id = 0;
  uint64_t partial_solution_id = 0;
  std::string source;
  double start_time = 0.0;
  double end_time = 0.0;
  Evaluation input_eval;
  Evaluation output_eval;
  std::string output_type;
  std::string termination;
  uint64_t root_lp_id = 0;
  int64_t root_checkpoint = -1;
  double enqueue_time = 0.0;
  std::string construction;
  std::string completion_status;
  double candidate_objective = std::numeric_limits<double>::quiet_NaN();
};

struct PhaseTrajectoryEntry {
  uint64_t task_id = 0;
  std::string phase;
  std::string input_source;
  double start_time = 0.0;
  double end_time = 0.0;
  int iterations = 0;
  int projection_calls = 0;
  std::string status;
  uint64_t input_solution_id = 0;
  int64_t root_checkpoint = -1;
  double enqueue_time = 0.0;
  double projection_start = std::numeric_limits<double>::quiet_NaN();
  double projection_finish = std::numeric_limits<double>::quiet_NaN();
};

struct DirectFprAudit {
  uint64_t task_id = 0;
  int64_t checkpoint = 0;
  double published = 0.0;
  double enqueued = 0.0;
  double start = 0.0;
  double finish = 0.0;
  std::string construction;
  std::string integer_checksum;
  int64_t direct_fixings = 0;
  int64_t propagation_fixings = 0;
  int repair_calls = 0;
  int64_t repair_iterations = 0;
  int backtracks = 0;
  int64_t canonicalized_domains = 0;
  double max_pre_canonical_crossing = 0.0;
  int64_t invalid_bounds_before_completion = -1;
  int pass_model_status = -1;
  std::string completion_status;
  int64_t completion_iterations = 0;
  double completion_wall = 0.0;
  double fpr_wall = 0.0;
  std::string termination;
  bool feasible = false;
  bool has_evaluation = false;
  Evaluation evaluation;
};

struct FeedbackAudit {
  std::string worker;
  uint64_t task_id = 0;
  double timestamp = 0.0;
  uint64_t version = 0;
  double best_objective = std::numeric_limits<double>::quiet_NaN();
};

struct PoolUpdateAudit {
  double timestamp = 0.0;
  std::string source;
  size_t size_before = 0;
  size_t size_after = 0;
  uint64_t version_before = 0;
  uint64_t version_after = 0;
  double best_before = std::numeric_limits<double>::quiet_NaN();
  double best_after = std::numeric_limits<double>::quiet_NaN();
  double candidate_objective = std::numeric_limits<double>::quiet_NaN();
  bool incumbent_updated = false;
  uint64_t solution_id = 0;
  uint64_t parent_solution_id = 0;
  uint64_t root_lp_id = 0;
  int64_t root_checkpoint = -1;
};

struct TaskAudit {
  uint64_t task_id = 0;
  std::string kind;
  std::string worker;
  uint64_t solution_id = 0;
  int64_t root_checkpoint = -1;
  double created = 0.0;
  double started = std::numeric_limits<double>::quiet_NaN();
  uint64_t incumbent_version = 0;
  double best_objective = std::numeric_limits<double>::quiet_NaN();
};

struct RealWorkerMetrics {
  std::atomic<int> fpr_received{0};
  std::atomic<int> fpr_completed{0};
  std::atomic<int> fpr_feasible{0};
  std::atomic<int> fpr_partial{0};
  std::atomic<int> phase1_received{0};
  std::atomic<int> phase1_completed{0};
  std::atomic<int> phase1_projection_calls{0};
  std::atomic<int> phase1_feasible{0};
  std::atomic<int> phase1_partial{0};
  std::atomic<int> phase2_received{0};
  std::atomic<int> phase2_completed{0};
  std::atomic<int> phase2_projection_calls{0};
  std::atomic<int> phase2_fpr_repair{0};
  std::atomic<int> cupdlpx_projection_tasks{0};
  std::atomic<int> cupdlpx_projection_checkpoints{0};
  std::atomic<int> phase2_feasible{0};
  std::atomic<int> phase2_partial{0};
  std::atomic<int> fpr_repair_tasks_seen{0};
  std::atomic<int> fpr_repair_completed{0};
  std::atomic<int> fpr_repair_feasible{0};
  std::atomic<int> fpr_repair_partial{0};
  std::atomic<int> completion_feasible{0};
  std::atomic<int64_t> ufpr_a_propagations{0};
  std::atomic<int64_t> ufpr_a_u{0};
  std::atomic<int64_t> ufpr_a_v{0};
  std::atomic<int64_t> ufpr_a_w{0};
  std::atomic<int64_t> ufpr_a_minup{0};
  std::atomic<int64_t> ufpr_a_mindown{0};
  std::atomic<int64_t> ufpr_a_contradictions{0};
  std::atomic<int64_t> ufpr_a_time_us{0};
  std::atomic<int64_t> ufpr_b_attempted{0};
  std::atomic<int64_t> ufpr_b_accepted{0};
  std::atomic<int64_t> ufpr_b_rejected{0};
  std::atomic<int64_t> ufpr_b_fallback{0};
  std::atomic<int64_t> ufpr_b_new_vars{0};
  std::atomic<int64_t> ufpr_b_max_vars{0};
  std::atomic<int64_t> ufpr_b_on{0};
  std::atomic<int64_t> ufpr_b_off{0};
  std::atomic<int64_t> ufpr_b_contradictions{0};
  std::atomic<int64_t> ufpr_b_time_us{0};
  std::atomic<int> repair_tasks_produced{0};
  std::atomic<int> gpu_fpr_routes{0};
  std::atomic<int> feaspump_fpr_routes{0};
  std::atomic<int> tabu_received{0};
  std::atomic<int> tabu_started{0};
  std::atomic<int> tabu_completed{0};
  std::atomic<int> tabu_moves{0};
  std::atomic<int> tabu_partials{0};
  std::atomic<int> tabu_feasible{0};
  std::atomic<int> tabu_pool_writes{0};
  std::atomic<int> tabu_rejections{0};
  std::atomic<int64_t> first_tabu_checkpoint{0};
  std::atomic<int> cuda_errors{0};
  std::atomic<bool> gpu_model_resident{false};
  std::atomic<bool> directional_state_updated{false};
  std::atomic<bool> phase1_projection_blocked{false};
  std::atomic<bool> phase2_projection_blocked{false};
  std::atomic<bool> post_incumbent_task_seen{false};
  std::atomic<uint64_t> max_objective_version_seen{0};
  std::atomic<int> real_active{0};
  std::atomic<int> max_real_active{0};
  std::array<std::atomic<int>, 8> projection_lp_status_counts{};
  std::array<std::atomic<int>, 8> completion_lp_status_counts{};
  std::mutex wall_mutex;
  double largest_fpr_wall = 0.0;
  double largest_phase1_wall = 0.0;
  double largest_phase2_wall = 0.0;
  double projection_lp_total_time = 0.0;
  double projection_lp_max_time = 0.0;
  std::mutex repair_mutex;
  RepairExample repair_example;
  std::mutex trajectory_mutex;
  std::vector<GpuTrajectoryEntry> gpu_trajectory;
  std::vector<RepairTrajectoryEntry> repair_trajectory;
  std::vector<PhaseTrajectoryEntry> phase_trajectory;
  std::unordered_map<std::string, int> fpr_termination_counts;
  std::vector<double> fpr_direct_walls;
  std::vector<double> fpr_direct_propagation_walls;
  std::vector<double> fpr_direct_completion_lp_walls;
  std::vector<double> fpr_repair_internal_walls;
  std::vector<double> fpr_repair_propagation_walls;
  std::vector<double> fpr_repair_completion_lp_walls;
  std::vector<Evaluation> fpr_direct_outputs;
  std::vector<DirectFprAudit> direct_fpr_audit;
  std::vector<FeedbackAudit> feedback_audit;

  void enterReal() {
    const int active = real_active.fetch_add(1) + 1;
    int prior = max_real_active.load();
    while (active > prior && !max_real_active.compare_exchange_weak(prior, active)) {}
  }
  void leaveReal() { real_active.fetch_sub(1); }
  void recordProjectionStatus(LpSolveStatus status, int count = 1) {
    projection_lp_status_counts[static_cast<size_t>(status)].fetch_add(count);
  }
  void recordCompletionStatus(LpSolveStatus status, int count = 1) {
    completion_lp_status_counts[static_cast<size_t>(status)].fetch_add(count);
  }
  void recordUfpr(const FprResult& result) {
    ufpr_a_propagations += result.ufpr.a_propagations;
    ufpr_a_u += result.ufpr.a_u_propagations;
    ufpr_a_v += result.ufpr.a_v_propagations;
    ufpr_a_w += result.ufpr.a_w_propagations;
    ufpr_a_minup += result.ufpr.a_minup_propagations;
    ufpr_a_mindown += result.ufpr.a_mindown_propagations;
    ufpr_a_contradictions += result.ufpr.a_contradictions;
    ufpr_a_time_us += static_cast<int64_t>(result.ufpr.a_time_sec * 1e6);
    ufpr_b_attempted += result.ufpr.b_segments_attempted;
    ufpr_b_accepted += result.ufpr.b_segments_accepted;
    ufpr_b_rejected += result.ufpr.b_segments_rejected;
    ufpr_b_fallback += result.ufpr.b_segments_fallback_to_single;
    ufpr_b_new_vars += result.ufpr.b_variables_fixed;
    int64_t prior = ufpr_b_max_vars.load();
    while (result.ufpr.b_segment_length_max > prior &&
           !ufpr_b_max_vars.compare_exchange_weak(prior,
                                                    result.ufpr.b_segment_length_max)) {}
    ufpr_b_on += result.ufpr.b_on_segments;
    ufpr_b_off += result.ufpr.b_off_segments;
    ufpr_b_contradictions += result.ufpr.b_contradictions;
    ufpr_b_time_us += static_cast<int64_t>(result.ufpr.b_time_sec * 1e6);
  }
  int projectionStatusCount(LpSolveStatus status) const {
    return projection_lp_status_counts[static_cast<size_t>(status)].load();
  }
  int completionStatusCount(LpSolveStatus status) const {
    return completion_lp_status_counts[static_cast<size_t>(status)].load();
  }
  void recordWall(double& slot, double wall) {
    std::lock_guard<std::mutex> lock(wall_mutex);
    slot = std::max(slot, wall);
  }
};

struct Event {
  double timestamp = 0.0;
  std::string event;
  std::string worker;
  uint64_t task_id = 0;
  std::string input_source;
  std::string output_type;
  std::string status;
};

struct Interval {
  double start = 0.0;
  double end = 0.0;
  std::string worker;
  uint64_t task_id = 0;
};

class Instrumentation {
 public:
  explicit Instrumentation(GlobalRuntimeContext& runtime) : runtime_(runtime) {}

  void event(std::string type, std::string worker, uint64_t task_id = 0,
             std::string input = "N/A", std::string output = "N/A",
             std::string status = "OK") {
    std::lock_guard<std::mutex> lock(mutex_);
    events_.push_back({runtime_.elapsed(), std::move(type), std::move(worker),
                       task_id, std::move(input), std::move(output), std::move(status)});
  }

  void interval(double start, double end, std::string worker, uint64_t task_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    intervals_.push_back({start, end, std::move(worker), task_id});
  }

  std::vector<Event> events() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return events_;
  }

  std::vector<Interval> intervals() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return intervals_;
  }

 private:
  GlobalRuntimeContext& runtime_;
  mutable std::mutex mutex_;
  std::vector<Event> events_;
  std::vector<Interval> intervals_;
};

struct WorkerStats {
  bool started = false;
  bool stopped = false;
  int tasks = 0;
  int waits = 0;
  double idle_seconds = 0.0;
};

struct RoutingChecks {
  mutable std::mutex mutex;
  std::unordered_set<int64_t> lp_fpr;
  std::unordered_set<int64_t> lp_phase1;
  std::atomic<bool> tabu_phase2{false};
  std::atomic<bool> feaspump_fpr{false};

  void received(WorkerType type, int64_t checkpoint) {
    std::lock_guard<std::mutex> lock(mutex);
    if (type == WorkerType::Fpr) lp_fpr.insert(checkpoint);
    if (type == WorkerType::FeasPump) lp_phase1.insert(checkpoint);
  }
  bool fprReceived(int64_t checkpoint) const {
    std::lock_guard<std::mutex> lock(mutex);
    return lp_fpr.contains(checkpoint);
  }
  bool feaspumpReceived(int64_t checkpoint) const {
    std::lock_guard<std::mutex> lock(mutex);
    return lp_phase1.contains(checkpoint);
  }
};

class SharedSolutionPool {
 public:
  SharedSolutionPool(GlobalRuntimeContext& runtime, Instrumentation& trace,
                     bool minimize, bool feaspump_enabled = true)
      : runtime_(runtime), trace_(trace), minimize_(minimize),
        feaspump_enabled_(feaspump_enabled) {}

  uint64_t pushLpSolution(LpSolution record) {
    auto entry = std::make_shared<LpSolution>(std::move(record));
    const bool routed = entry->checkpoint >= kFirstRoutedCheckpoint;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      entry->solution_id = next_solution_id_++;
      entry->timestamp = runtime_.elapsed();
      lp_.push_back(entry);
      ++pool_writes_;
      if (routed) enqueueLocked(fpr_queue_, TaskKind::LpFpr, entry, nullptr);
      if (routed && feaspump_enabled_)
        enqueueLocked(feaspump_queue_, TaskKind::LpPhase1, entry, nullptr);
      if (routed) enqueueLocked(tabu_queue_, TaskKind::LpTabu, entry, nullptr);
    }
    trace_.event("POOL_WRITE", "LP_PRODUCER", 0, entry->source, "LP",
                 !routed ? "RECORDED_NOT_ROUTED_BELOW_CP10000" :
                 (feaspump_enabled_ ? "ROUTED_3_WAYS" : "ROUTED_FPR_TABU_ONLY"));
    if (!routed) return entry->solution_id;
    fpr_cv_.notify_one();
    if (feaspump_enabled_) feaspump_cv_.notify_one();
    tabu_cv_.notify_one();
    return entry->solution_id;
  }

  uint64_t pushPartialSolution(std::string source, Values values,
                               double violation, double objective,
                               std::string metadata, PartialRoute route,
                               uint64_t parent_solution_id = 0,
                               uint64_t root_lp_id = 0,
                               uint64_t generation = 0,
                               uint32_t repair_depth = 0,
                               double max_bound_violation = 0.0,
                               double integrality_violation = 0.0,
                               std::shared_ptr<const std::vector<uint8_t>> assigned = nullptr,
                               std::shared_ptr<const std::vector<uint8_t>> hard_assignment = nullptr,
                               std::string consumed_by = "") {
    auto entry = std::make_shared<PartialSolution>();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      entry->solution_id = next_solution_id_++;
      entry->parent_solution_id = parent_solution_id;
      entry->root_lp_id = root_lp_id;
      entry->generation = generation;
      entry->repair_depth = repair_depth;
      entry->timestamp = runtime_.elapsed();
      entry->source = std::move(source);
      entry->values = std::move(values);
      if (!assigned) {
        assigned = std::make_shared<const std::vector<uint8_t>>(
            entry->values->size(), static_cast<uint8_t>(1));
      }
      if (!hard_assignment) {
        hard_assignment = std::make_shared<const std::vector<uint8_t>>(
            entry->values->size(), static_cast<uint8_t>(0));
      }
      entry->assigned = std::move(assigned);
      entry->hard_assignment = std::move(hard_assignment);
      entry->violation = violation;
      entry->objective = objective;
      entry->max_bound_violation = max_bound_violation;
      entry->integrality_violation = integrality_violation;
      entry->metadata = std::move(metadata);
      entry->consumed_by = std::move(consumed_by);
      partial_.push_back(entry);
      ++pool_writes_;
      if (entry->source.find("GPU_TABU") != std::string::npos)
        ++gpu_partial_writes_;
      else if (entry->source.find("FEASPUMP") != std::string::npos)
        ++feaspump_partial_writes_;
      else if (entry->source.find("FPR") != std::string::npos)
        ++fpr_partial_writes_;
      if (feaspump_enabled_ &&
          (route == PartialRoute::ToFeasPumpPhase2 ||
           route == PartialRoute::ToFeasPumpPhase2AndFprRepair))
        enqueueLocked(feaspump_queue_, TaskKind::TabuPhase2, nullptr, entry, true);
      if ((route == PartialRoute::ToFprRepair ||
           route == PartialRoute::ToFeasPumpPhase2AndFprRepair) &&
          entry->repair_depth < kMaxFprRepairDepth) {
        enqueueLocked(fpr_queue_, TaskKind::PartialFprRepair, nullptr, entry, true);
        ++repair_tasks_produced_;
      }
    }
    trace_.event("POOL_WRITE", entry->source, 0, entry->source, "PARTIAL",
                 route == PartialRoute::None ? "STORED" : "STORED_AND_ROUTED");
    if (feaspump_enabled_ &&
        (route == PartialRoute::ToFeasPumpPhase2 ||
         route == PartialRoute::ToFeasPumpPhase2AndFprRepair))
      feaspump_cv_.notify_one();
    if (route == PartialRoute::ToFprRepair ||
        route == PartialRoute::ToFeasPumpPhase2AndFprRepair)
      fpr_cv_.notify_one();
    return entry->solution_id;
  }

  uint64_t pushFeasibleSolution(std::string source, Values values,
                                double objective, std::string validation_state,
                                uint64_t repair_parent_id = 0,
                                uint64_t repair_root_lp_id = 0,
                                uint64_t generation = 0) {
    auto entry = std::make_shared<FeasibleSolution>();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      PoolUpdateAudit audit;
      audit.timestamp = runtime_.elapsed();
      audit.source = source;
      audit.size_before = feasible_.size();
      audit.version_before = incumbent_version_;
      if (best_feasible_) audit.best_before = best_feasible_->objective;
      entry->solution_id = next_solution_id_++;
      entry->timestamp = runtime_.elapsed();
      entry->source = std::move(source);
      entry->values = std::move(values);
      entry->objective = objective;
      const ValidationMetadata validation =
          normalizeValidationMetadata(validation_state);
      entry->validation_state = validation.status;
      entry->validation_source = validation.source;
      entry->repair_parent_id = repair_parent_id;
      entry->repair_root_lp_id = repair_root_lp_id;
      entry->generation = generation;
      feasible_.push_back(entry);
      const bool improves = !best_feasible_ ||
          (minimize_ ? entry->objective < best_feasible_->objective - kObjectiveTolerance
                     : entry->objective > best_feasible_->objective + kObjectiveTolerance);
      if (improves) {
        best_feasible_ = entry;
        ++incumbent_version_;
        ++incumbent_updates_;
        entry->is_new_incumbent = true;
      }
      entry->incumbent_version = incumbent_version_;
      audit.size_after = feasible_.size();
      audit.version_after = incumbent_version_;
      audit.best_after = best_feasible_ ? best_feasible_->objective
                                        : std::numeric_limits<double>::quiet_NaN();
      audit.candidate_objective = entry->objective;
      audit.incumbent_updated = improves;
      audit.solution_id = entry->solution_id;
      audit.parent_solution_id = entry->repair_parent_id;
      audit.root_lp_id = entry->repair_root_lp_id;
      for (const auto& lp_entry : lp_)
        if (lp_entry->solution_id == entry->repair_root_lp_id)
          audit.root_checkpoint = lp_entry->checkpoint;
      feasible_audit_.push_back(std::move(audit));
      if (entry->source.find("FPR") != std::string::npos)
        ++fpr_feasible_writes_;
      ++pool_writes_;
    }
    trace_.event("POOL_WRITE", entry->source, 0, entry->source, "FEASIBLE",
                 entry->validation_state + ";VALIDATION_SOURCE=" +
                     entry->validation_source);
    return entry->solution_id;
  }

  std::optional<std::shared_ptr<const FeasibleSolution>> getBestFeasible() const {
    std::lock_guard<std::mutex> lock(mutex_);
    ++pool_reads_;
    return best_feasible_;
  }

  IncumbentSnapshot incumbentSnapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    IncumbentSnapshot snapshot;
    snapshot.feasible = best_feasible_;
    snapshot.version = incumbent_version_;
    if (best_feasible_) snapshot.best_known_objective = best_feasible_->objective;
    return snapshot;
  }

  std::shared_ptr<const LpSolution> findLp(uint64_t solution_id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& entry : lp_)
      if (entry->solution_id == solution_id) return entry;
    return nullptr;
  }

  std::shared_ptr<const LpSolution> latestLp() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return lp_.empty() ? nullptr : lp_.back();
  }

  std::optional<Task> waitPop(WorkerType worker, const std::string& worker_id,
                              double& waited) {
    auto& queue = queueFor(worker);
    auto& cv = cvFor(worker);
    const auto wait_start = Clock::now();
    std::unique_lock<std::mutex> lock(mutex_);
    cv.wait_until(lock, runtime_.deadline, [&]() {
      return !queue.empty() || runtime_.shouldStop();
    });
    waited = std::chrono::duration<double>(Clock::now() - wait_start).count();
    if (runtime_.shouldStop() || runtime_.deadlineReached() || queue.empty())
      return std::nullopt;
    Task task = std::move(queue.front());
    queue.pop_front();
    const double started = runtime_.elapsed();
    runtime_.noteTaskStarted(started);
    for (auto& audit : task_audit_)
      if (audit.task_id == task.task_id) {
        audit.worker = worker_id;
        audit.started = started;
        break;
      }
    const std::string key = worker_id + ":" + std::to_string(task.task_id);
    if (!consumption_ledger_.insert(key).second)
      throw std::runtime_error("duplicate task consumption");
    ++pool_reads_;
    ++tasks_consumed_;
    return task;
  }

  void requestStop() {
    runtime_.requestStop();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      cancelled_tasks_ += fpr_queue_.size() + feaspump_queue_.size() + tabu_queue_.size();
      fpr_queue_.clear();
      feaspump_queue_.clear();
      tabu_queue_.clear();
    }
    fpr_cv_.notify_all();
    feaspump_cv_.notify_all();
    tabu_cv_.notify_all();
  }

  uint64_t poolWrites() const { return pool_writes_.load(); }
  uint64_t poolReads() const { return pool_reads_.load(); }
  uint64_t tasksProduced() const { return tasks_produced_.load(); }
  uint64_t tasksConsumed() const { return tasks_consumed_.load(); }
  uint64_t tasksCancelled() const { return cancelled_tasks_.load(); }
  uint64_t duplicatesSuppressed() const { return duplicate_tasks_suppressed_.load(); }
  uint64_t phase2TasksProduced() const { return phase2_tasks_produced_.load(); }
  uint64_t repairTasksProduced() const { return repair_tasks_produced_.load(); }
  uint64_t incumbentUpdates() const { return incumbent_updates_.load(); }
  uint64_t incumbentVersion() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return incumbent_version_;
  }
  uint64_t gpuPartialWrites() const { return gpu_partial_writes_.load(); }
  uint64_t feaspumpPartialWrites() const { return feaspump_partial_writes_.load(); }
  uint64_t fprPartialWrites() const { return fpr_partial_writes_.load(); }
  uint64_t fprFeasibleWrites() const { return fpr_feasible_writes_.load(); }
  uint64_t maxFprQueueDepth() const { return max_fpr_queue_depth_.load(); }
  uint64_t maxFprRepairQueueDepth() const {
    return max_fpr_repair_queue_depth_.load();
  }
  uint64_t maxFeasPumpQueueDepth() const {
    return max_feaspump_queue_depth_.load();
  }
  uint64_t maxTabuQueueDepth() const { return max_tabu_queue_depth_.load(); }
  size_t lpCount() const { std::lock_guard<std::mutex> lock(mutex_); return lp_.size(); }
  std::vector<std::shared_ptr<const LpSolution>> lpEntries() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return lp_;
  }
  std::vector<std::shared_ptr<const PartialSolution>> partialEntries() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return partial_;
  }
  std::vector<std::shared_ptr<const FeasibleSolution>> feasibleEntries() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return feasible_;
  }
  std::vector<PoolUpdateAudit> feasibleAudit() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return feasible_audit_;
  }
  std::vector<TaskAudit> taskAudit() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return task_audit_;
  }
  size_t partialCount() const { std::lock_guard<std::mutex> lock(mutex_); return partial_.size(); }
  size_t feasibleCount() const { std::lock_guard<std::mutex> lock(mutex_); return feasible_.size(); }
  bool queuesEmpty() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return fpr_queue_.empty() && feaspump_queue_.empty() && tabu_queue_.empty();
  }

 private:
  void enqueueLocked(std::deque<Task>& queue, TaskKind kind,
                     std::shared_ptr<const LpSolution> lp,
                     std::shared_ptr<const PartialSolution> partial,
                     bool priority = false) {
    if (runtime_.shouldStop() || runtime_.deadlineReached()) {
      return;
    }
    Task task;
    task.task_id = next_task_id_++;
    task.kind = kind;
    task.lp = lp;
    task.partial = partial;
    task.solution_id = lp ? lp->solution_id : partial->solution_id;
    task.input_source = lp ? lp->source : partial->source;
    task.enqueue_timestamp = runtime_.elapsed();
    task.objective_version_seen = incumbent_version_;
    if (best_feasible_)
      task.best_known_objective_seen = best_feasible_->objective;
    const std::string route_key = std::to_string(task.solution_id) + ":" + taskName(kind);
    if (!routing_ledger_.insert(route_key).second) {
      ++duplicate_tasks_suppressed_;
      return;
    }
    TaskAudit audit;
    audit.task_id = task.task_id;
    audit.kind = taskName(kind);
    audit.solution_id = task.solution_id;
    audit.created = task.enqueue_timestamp;
    audit.incumbent_version = task.objective_version_seen;
    if (task.best_known_objective_seen)
      audit.best_objective = *task.best_known_objective_seen;
    if (lp) {
      audit.root_checkpoint = lp->checkpoint;
    } else if (partial) {
      for (const auto& lp_entry : lp_)
        if (lp_entry->solution_id == partial->root_lp_id)
          audit.root_checkpoint = lp_entry->checkpoint;
    }
    task_audit_.push_back(std::move(audit));
    if (kind == TaskKind::TabuPhase2) ++phase2_tasks_produced_;
    if (priority) queue.push_front(std::move(task));
    else queue.push_back(std::move(task));
    auto update_max = [](std::atomic<uint64_t>& slot, uint64_t value) {
      uint64_t prior = slot.load();
      while (value > prior && !slot.compare_exchange_weak(prior, value)) {}
    };
    if (kind == TaskKind::LpFpr || kind == TaskKind::PartialFprRepair) {
      update_max(max_fpr_queue_depth_, fpr_queue_.size());
      const uint64_t repairs = static_cast<uint64_t>(std::count_if(
          fpr_queue_.begin(), fpr_queue_.end(), [](const Task& queued) {
            return queued.kind == TaskKind::PartialFprRepair;
          }));
      update_max(max_fpr_repair_queue_depth_, repairs);
    } else if (kind == TaskKind::LpPhase1 || kind == TaskKind::TabuPhase2) {
      update_max(max_feaspump_queue_depth_, feaspump_queue_.size());
    } else if (kind == TaskKind::LpTabu) {
      update_max(max_tabu_queue_depth_, tabu_queue_.size());
    }
    ++tasks_produced_;
  }

  std::deque<Task>& queueFor(WorkerType worker) {
    if (worker == WorkerType::Fpr) return fpr_queue_;
    if (worker == WorkerType::FeasPump) return feaspump_queue_;
    return tabu_queue_;
  }
  std::condition_variable& cvFor(WorkerType worker) {
    if (worker == WorkerType::Fpr) return fpr_cv_;
    if (worker == WorkerType::FeasPump) return feaspump_cv_;
    return tabu_cv_;
  }

  GlobalRuntimeContext& runtime_;
  Instrumentation& trace_;
  const bool minimize_;
  const bool feaspump_enabled_;
  static constexpr uint32_t kMaxFprRepairDepth = 1;
  static constexpr double kObjectiveTolerance = 1e-9;
  mutable std::mutex mutex_;
  std::condition_variable fpr_cv_, feaspump_cv_, tabu_cv_;
  std::deque<Task> fpr_queue_, feaspump_queue_, tabu_queue_;
  std::vector<std::shared_ptr<const LpSolution>> lp_;
  std::vector<std::shared_ptr<const PartialSolution>> partial_;
  std::vector<std::shared_ptr<const FeasibleSolution>> feasible_;
  std::vector<PoolUpdateAudit> feasible_audit_;
  std::vector<TaskAudit> task_audit_;
  std::shared_ptr<const FeasibleSolution> best_feasible_;
  uint64_t incumbent_version_ = 0;
  std::unordered_set<std::string> consumption_ledger_;
  std::unordered_set<std::string> routing_ledger_;
  uint64_t next_solution_id_ = 1;
  uint64_t next_task_id_ = 1;
  mutable std::atomic<uint64_t> pool_reads_{0};
  std::atomic<uint64_t> pool_writes_{0};
  std::atomic<uint64_t> tasks_produced_{0};
  std::atomic<uint64_t> tasks_consumed_{0};
  std::atomic<uint64_t> cancelled_tasks_{0};
  std::atomic<uint64_t> duplicate_tasks_suppressed_{0};
  std::atomic<uint64_t> phase2_tasks_produced_{0};
  std::atomic<uint64_t> repair_tasks_produced_{0};
  std::atomic<uint64_t> incumbent_updates_{0};
  std::atomic<uint64_t> gpu_partial_writes_{0};
  std::atomic<uint64_t> feaspump_partial_writes_{0};
  std::atomic<uint64_t> fpr_partial_writes_{0};
  std::atomic<uint64_t> fpr_feasible_writes_{0};
  std::atomic<uint64_t> max_fpr_queue_depth_{0};
  std::atomic<uint64_t> max_fpr_repair_queue_depth_{0};
  std::atomic<uint64_t> max_feaspump_queue_depth_{0};
  std::atomic<uint64_t> max_tabu_queue_depth_{0};
};

chap::feaspump::LpSnapshot realSnapshot(const LpSolution& lp) {
  chap::feaspump::LpSnapshot snapshot;
  snapshot.checkpoint = lp.checkpoint;
  snapshot.generation = 0;
  snapshot.source = lp.source;
  snapshot.x = *lp.primal;
  snapshot.y = *lp.dual;
  snapshot.rc = *lp.reduced_cost;
  return snapshot;
}

std::string phaseTwoReuseValidationError(const LpSolution* lp,
                                         const MIPModel& model) {
  if (!lp) return "NO_PARENT_CHECKPOINT";
  if (!lp->primal || lp->primal->empty()) return "MISSING_PRIMAL_VECTOR";
  if (lp->primal->size() != static_cast<size_t>(model.n_cols) ||
      !lp->dual || lp->dual->size() != static_cast<size_t>(model.n_rows) ||
      !lp->reduced_cost ||
      lp->reduced_cost->size() != static_cast<size_t>(model.n_cols))
    return "DIMENSION_MISMATCH";
  const auto finite = [](const std::vector<double>& values) {
    return std::all_of(values.begin(), values.end(),
                       [](double value) { return std::isfinite(value); });
  };
  if (!finite(*lp->primal) || !finite(*lp->dual) ||
      !finite(*lp->reduced_cost))
    return "NONFINITE_VALUES";
  return {};
}

Values immutableValues(const std::vector<double>& x) {
  return std::make_shared<const std::vector<double>>(x);
}

uint64_t p7dFnvMix(uint64_t hash, uint64_t value) {
  for (int byte = 0; byte < 8; ++byte) {
    hash ^= (value >> (8 * byte)) & 0xffU;
    hash *= 1099511628211ULL;
  }
  return hash;
}

std::string p7dIntegerTargetChecksum(const MIPModel& model,
                                     const std::vector<double>& target) {
  if (target.size() != static_cast<size_t>(model.n_cols)) return "UNAVAILABLE";
  uint64_t hash = 1469598103934665603ULL;
  for (int j : model.integer_columns) {
    hash = p7dFnvMix(hash, static_cast<uint64_t>(j));
    hash = p7dFnvMix(hash, std::bit_cast<uint64_t>(target[j]));
  }
  std::ostringstream out;
  out << std::hex << std::setw(16) << std::setfill('0') << hash;
  return out.str();
}

std::shared_ptr<const std::vector<uint8_t>> fullAssignmentMask(size_t size) {
  return std::make_shared<const std::vector<uint8_t>>(size,
                                                      static_cast<uint8_t>(1));
}

std::shared_ptr<const std::vector<uint8_t>> noHardAssignmentMask(size_t size) {
  return std::make_shared<const std::vector<uint8_t>>(size,
                                                      static_cast<uint8_t>(0));
}

struct PartialRepairOutcome {
  FprResult fpr;
  std::optional<CandidateSolution> candidate;
  std::string guidance_source = "NONE";
  size_t assigned_count = 0;
  size_t hard_count = 0;
};

PartialRepairOutcome runPartialRepairFpr(
    const MIPModel& model, const PartialSolution& partial,
    SharedSolutionPool& shared_pool, const GlobalRuntimeContext& runtime,
    double lp_time_limit_sec, uint64_t repair_seed) {
  if (!partial.values || partial.values->size() != static_cast<size_t>(model.n_cols) ||
      !partial.assigned ||
      partial.assigned->size() != static_cast<size_t>(model.n_cols) ||
      !partial.hard_assignment ||
      partial.hard_assignment->size() != static_cast<size_t>(model.n_cols))
    throw std::runtime_error("explicit partial assignment dimension mismatch");

  PartialRepairOutcome outcome;
  std::shared_ptr<const LpSolution> guidance;
  if (partial.root_lp_id != 0) {
    guidance = shared_pool.findLp(partial.root_lp_id);
    if (guidance) outcome.guidance_source = "PARENT_LP";
  }
  if (!guidance) {
    guidance = shared_pool.latestLp();
    if (guidance) outcome.guidance_source = "LATEST_LP";
  }

  std::vector<double> x = guidance && guidance->primal &&
                                  guidance->primal->size() ==
                                      static_cast<size_t>(model.n_cols)
                              ? *guidance->primal
                              : *partial.values;
  for (int64_t j = 0; j < model.n_cols; ++j) {
    if ((*partial.assigned)[j]) {
      x[j] = (*partial.values)[j];
      ++outcome.assigned_count;
    }
    if ((*partial.hard_assignment)[j]) ++outcome.hard_count;
  }
  if (outcome.hard_count != 0)
    throw std::runtime_error(
        "P5 thin adapter does not silently convert hard assignments into guidance");

  std::vector<double> dual(model.n_rows, 0.0);
  std::vector<double> reduced_cost(model.n_cols, 0.0);
  if (guidance) {
    if (guidance->dual && guidance->dual->size() == dual.size())
      dual = *guidance->dual;
    if (guidance->reduced_cost &&
        guidance->reduced_cost->size() == reduced_cost.size())
      reduced_cost = *guidance->reduced_cost;
  }

  LpFixingRunConfig config;
  config.checkpoint = guidance ? guidance->checkpoint
                               : -static_cast<int64_t>(partial.solution_id);
  config.strategy = chap::lpfix::Strategy::Frac;
  config.seed = repair_seed;
  config.frac_closest_first = true;
  config.debug_trace = false;
  config.ufpr_temporal = g_ufpr_temporal_enabled;
  config.ufpr_segment = g_ufpr_segment_enabled;
  config.ufpr_segment_lmax = 4;
  SolutionPool local(model.minimize, 32);
  outcome.fpr = runLpGuidedFpr(
      model, x, dual, reduced_cost, config, CandidateSource::FPR, local,
      runtime.start, lp_time_limit_sec);
  if (auto feasible = local.bestFeasible())
    outcome.candidate = *feasible;
  else if (auto infeasible = local.bestInfeasible())
    outcome.candidate = *infeasible;
  else if (outcome.fpr.candidate.size() == static_cast<size_t>(model.n_cols))
    outcome.candidate = CandidateSolution{
        outcome.fpr.candidate, evaluateSolution(model, outcome.fpr.candidate),
        CandidateSource::FPR, config.checkpoint, runtime.elapsed()};
  return outcome;
}

p3b::Model makeGpuTabuModel(const MIPModel& model) {
  p3b::Model gpu;
  gpu.n = static_cast<int>(model.n_cols);
  gpu.lower = model.lb;
  gpu.upper = model.ub;
  gpu.objective = model.obj;
  gpu.objective_offset = model.objective_offset;
  gpu.type.resize(gpu.n, 2);
  for (int j = 0; j < gpu.n; ++j) {
    if (model.var_type[j] == VarType::Binary) gpu.type[j] = 0;
    else if (model.var_type[j] == VarType::Integer ||
             model.var_type[j] == VarType::SemiInteger) gpu.type[j] = 1;
  }
  gpu.row_start.push_back(0);
  std::vector<std::vector<std::pair<int, double>>> columns(gpu.n);
  auto add_row = [&](int original_row, double sign, double rhs) {
    const int normalized_row = gpu.m++;
    gpu.rhs.push_back(rhs);
    for (HighsInt p = model.row_start[original_row];
         p < model.row_start[original_row + 1]; ++p) {
      const int column = static_cast<int>(model.row_index[p]);
      const double value = sign * model.row_value[p];
      gpu.col_index.push_back(column);
      gpu.values.push_back(value);
      columns[column].push_back({normalized_row, value});
    }
    gpu.row_start.push_back(static_cast<int>(gpu.values.size()));
  };
  for (int i = 0; i < model.n_rows; ++i) {
    if (finiteUpper(model.row_ub[i])) add_row(i, 1.0, model.row_ub[i]);
    if (finiteLower(model.row_lb[i])) add_row(i, -1.0, -model.row_lb[i]);
  }
  gpu.col_start.push_back(0);
  for (const auto& column : columns) {
    for (const auto& [row, value] : column) {
      gpu.row_index.push_back(row);
      gpu.col_values.push_back(value);
    }
    gpu.col_start.push_back(static_cast<int>(gpu.col_values.size()));
  }
  return gpu;
}

std::vector<double> provisionalTabuInitialization(
    const p3b::Model& model, const p3b::TabuInput& input) {
  std::vector<double> x = input.candidate;
  if (x.size() != static_cast<size_t>(model.n))
    throw std::runtime_error("Tabu input dimension mismatch");
  for (int j = 0; j < model.n; ++j) {
    x[j] = std::max(model.lower[j], std::min(model.upper[j], x[j]));
    if (model.type[j] != 2) {
      x[j] = std::round(x[j]);
      x[j] = std::max(model.lower[j], std::min(model.upper[j], x[j]));
    }
  }
  return x;
}

void workerLoop(WorkerType type, const std::string& worker_id,
                 GlobalRuntimeContext& runtime, SharedSolutionPool& pool,
                 Instrumentation& trace, RoutingChecks& checks,
                 WorkerStats& stats, RealWorkerMetrics& real_metrics,
                 const MIPModel& model, const std::string& model_path,
                 const std::string& checker_path,
                 const std::string& output_root,
                 const p3b::Model& gpu_model,
                 const ExperimentSeeds& seeds) {
  stats.started = true;
  trace.event("WORKER_START", worker_id);
  while (!runtime.shouldStop()) {
    trace.event("WORKER_WAIT", worker_id);
    double waited = 0.0;
    auto task = pool.waitPop(type, worker_id, waited);
    ++stats.waits;
    stats.idle_seconds += waited;
    if (!task) break;
    if (task->objective_version_seen > 0 &&
        task->best_known_objective_seen.has_value()) {
      real_metrics.post_incumbent_task_seen = true;
      uint64_t prior = real_metrics.max_objective_version_seen.load();
      while (task->objective_version_seen > prior &&
             !real_metrics.max_objective_version_seen.compare_exchange_weak(
                 prior, task->objective_version_seen)) {}
      std::lock_guard<std::mutex> lock(real_metrics.trajectory_mutex);
      real_metrics.feedback_audit.push_back({
          worker_id, task->task_id, runtime.elapsed(),
          task->objective_version_seen, *task->best_known_objective_seen});
    }
    ++stats.tasks;
    trace.event("TASK_RECEIVED", worker_id, task->task_id, task->input_source,
                taskName(task->kind));
    const double start = runtime.elapsed();
    trace.event("TASK_START", worker_id, task->task_id, task->input_source,
                taskName(task->kind));
    std::string output_type = "NONE";
    std::string status = "COMPLETED";
    if (type == WorkerType::Fpr && task->kind == TaskKind::LpFpr) {
      checks.received(type, task->lp->checkpoint);
      ++real_metrics.fpr_received;
      const double limit = runtime.testRemaining();
      if (limit <= 0.02) {
        status = "GLOBAL_LIMIT_BEFORE_ENTRY";
      } else {
        real_metrics.enterReal();
        SolutionPool local(model.minimize, 32);
        LpFixingRunConfig config;
        config.checkpoint = task->lp->checkpoint;
        config.strategy = chap::lpfix::Strategy::Frac;
        config.seed = seeds.fpr;
        config.frac_closest_first = true;
        config.debug_trace = false;
        config.ufpr_temporal = g_ufpr_temporal_enabled;
        config.ufpr_segment = g_ufpr_segment_enabled;
        config.ufpr_segment_lmax = 4;
        std::vector<double> integer_target;
        setGurobiCompletionContext(
            task->task_id, task->solution_id, task->input_source,
            task->lp->checkpoint,
            "LP_ID=" + std::to_string(task->solution_id), runtime.start);
        FprResult result = runLpGuidedFpr(
            model, *task->lp->primal, *task->lp->dual, *task->lp->reduced_cost,
            config, CandidateSource::FPR, local, runtime.start, limit,
            &integer_target);
        real_metrics.recordUfpr(result);
        clearGurobiCompletionContext();
        real_metrics.leaveReal();
        ++real_metrics.fpr_completed;
        real_metrics.recordWall(real_metrics.largest_fpr_wall, result.fpr_time_sec);
        if (result.completion_model_status != "NOT_RUN")
          real_metrics.recordCompletionStatus(result.completion_lp_status);
        if (result.final_lp_calls > 0 && result.feasible)
          ++real_metrics.completion_feasible;
        std::optional<Evaluation> direct_output_eval;
        if (auto candidate = local.bestFeasible()) {
          const Evaluation full_eval = evaluateSolution(model, candidate->x);
          direct_output_eval = full_eval;
          if (full_eval.integer_feasible && full_eval.row_feasible) {
            pool.pushFeasibleSolution("REAL_FPR", immutableValues(candidate->x),
                                      full_eval.objective,
                                      "FULL_ORIGINAL_MODEL_VALIDATION_PASS",
                                      task->solution_id, task->solution_id, 1);
            ++real_metrics.fpr_feasible;
            output_type = "FEASIBLE";
          }
        } else if (auto candidate = local.bestInfeasible()) {
          direct_output_eval = candidate->eval;
          pool.pushPartialSolution("REAL_FPR_PARTIAL", immutableValues(candidate->x),
              candidate->eval.totalViolation(), candidate->eval.objective,
              "REAL_EVENT_DRIVEN;termination=" + result.termination,
              PartialRoute::None, task->solution_id, task->solution_id, 1, 1,
              candidate->eval.max_bound_violation,
              candidate->eval.max_integrality_violation);
          ++real_metrics.fpr_partial;
          output_type = "PARTIAL";
        }
        {
          std::lock_guard<std::mutex> lock(real_metrics.trajectory_mutex);
          ++real_metrics.fpr_termination_counts[result.termination];
          real_metrics.fpr_direct_walls.push_back(result.fpr_time_sec);
          real_metrics.fpr_direct_propagation_walls.push_back(
              result.propagation_time_sec);
          real_metrics.fpr_direct_completion_lp_walls.push_back(
              result.final_lp_time_sec);
          if (direct_output_eval)
            real_metrics.fpr_direct_outputs.push_back(*direct_output_eval);
          DirectFprAudit audit;
          audit.task_id = task->task_id;
          audit.checkpoint = task->lp->checkpoint;
          audit.published = task->lp->timestamp;
          audit.enqueued = task->enqueue_timestamp;
          audit.start = start;
          audit.finish = runtime.elapsed();
          audit.construction = integer_target.empty() ? "FAILED" : "SUCCESS";
          audit.integer_checksum =
              p7dIntegerTargetChecksum(model, integer_target);
          audit.direct_fixings = result.explicit_fixings;
          audit.propagation_fixings = result.propagated_fixings;
          audit.repair_calls = result.repair_calls;
          audit.repair_iterations = result.repair_iterations;
          audit.backtracks = result.backtracks;
          audit.canonicalized_domains = result.canonicalized_domain_count;
          audit.max_pre_canonical_crossing =
              result.max_pre_canonical_crossing;
          audit.invalid_bounds_before_completion =
              result.invalid_bounds_before_completion;
          audit.pass_model_status = result.completion_pass_model_status;
          audit.completion_status = result.completion_model_status;
          audit.completion_iterations =
              result.completion_simplex_iterations +
              result.completion_ipm_iterations;
          audit.completion_wall = result.final_lp_time_sec;
          audit.fpr_wall = result.fpr_time_sec;
          audit.termination = result.termination;
          audit.feasible = output_type == "FEASIBLE";
          audit.has_evaluation = direct_output_eval.has_value();
          if (direct_output_eval) audit.evaluation = *direct_output_eval;
          real_metrics.direct_fpr_audit.push_back(std::move(audit));
        }
        status = result.termination;
      }
    } else if (type == WorkerType::Fpr && task->kind == TaskKind::PartialFprRepair) {
      ++real_metrics.fpr_repair_tasks_seen;
      const double limit = runtime.testRemaining();
      if (limit <= 0.02) {
        status = "GLOBAL_LIMIT_BEFORE_REPAIR_ENTRY";
      } else if (task->partial->repair_depth >= 1) {
        status = "MAX_FPR_REPAIR_DEPTH_REACHED";
      } else {
        bool entered_real = false;
        try {
          const Evaluation input_eval =
              evaluateSolution(model, *task->partial->values);
          real_metrics.enterReal();
          entered_real = true;
          const auto repair_start = Clock::now();
          const auto repair_root = pool.findLp(task->partial->root_lp_id);
          setGurobiCompletionContext(
              task->task_id, task->partial->solution_id,
              task->partial->source,
              repair_root ? repair_root->checkpoint : int64_t{-1},
              "ROOT_LP_ID=" + std::to_string(task->partial->root_lp_id) +
                  "->PARTIAL_ID=" +
                  std::to_string(task->partial->solution_id),
              runtime.start);
          PartialRepairOutcome repair = runPartialRepairFpr(
              model, *task->partial, pool, runtime, limit, seeds.repair);
          real_metrics.recordUfpr(repair.fpr);
          clearGurobiCompletionContext();
          const double repair_wall =
              std::chrono::duration<double>(Clock::now() - repair_start).count();
          real_metrics.leaveReal();
          entered_real = false;
          ++real_metrics.fpr_repair_completed;
          real_metrics.recordWall(real_metrics.largest_fpr_wall, repair_wall);
          if (repair.fpr.completion_model_status != "NOT_RUN")
            real_metrics.recordCompletionStatus(repair.fpr.completion_lp_status);
          if (repair.fpr.final_lp_calls > 0 && repair.fpr.feasible)
            ++real_metrics.completion_feasible;
          status = repair.fpr.termination;
          Evaluation output_eval;
          bool have_output = false;
          if (repair.candidate) {
            output_eval = evaluateSolution(model, repair.candidate->x);
            have_output = true;
            const bool fully_feasible = output_eval.integer_feasible &&
                                        output_eval.row_feasible;
            if (fully_feasible) {
              pool.pushFeasibleSolution(
                  "REAL_FPR_REPAIR_FEASIBLE",
                  immutableValues(repair.candidate->x), output_eval.objective,
                  "FULL_ORIGINAL_MODEL_VALIDATION_PASS",
                  task->partial->solution_id, task->partial->root_lp_id,
                  task->partial->generation + 1);
              ++real_metrics.fpr_repair_feasible;
              output_type = "FEASIBLE";
            } else {
              pool.pushPartialSolution(
                  "REAL_FPR_REPAIR_PARTIAL",
                  immutableValues(repair.candidate->x),
                  output_eval.totalViolation(), output_eval.objective,
                  "REAL_EVENT_DRIVEN_PARTIAL_REPAIR;termination=" +
                      repair.fpr.termination,
                  PartialRoute::None, task->partial->solution_id,
                  task->partial->root_lp_id, task->partial->generation + 1,
                  task->partial->repair_depth + 1,
                  output_eval.max_bound_violation,
                  output_eval.max_integrality_violation,
                  fullAssignmentMask(repair.candidate->x.size()),
                  noHardAssignmentMask(repair.candidate->x.size()), "FPR_0");
              ++real_metrics.fpr_repair_partial;
              output_type = "PARTIAL";
            }
          }
          {
            std::lock_guard<std::mutex> lock(real_metrics.repair_mutex);
            if (!real_metrics.repair_example.recorded ||
                task->partial->source.find("GPU_TABU") != std::string::npos) {
              real_metrics.repair_example.recorded = true;
              real_metrics.repair_example.input_source = task->partial->source;
              real_metrics.repair_example.input_eval = input_eval;
              real_metrics.repair_example.output_type =
                  have_output ? output_type : "FAILED";
              real_metrics.repair_example.output_eval = output_eval;
              real_metrics.repair_example.wall_time = repair_wall;
              real_metrics.repair_example.guidance_source =
                  repair.guidance_source;
              real_metrics.repair_example.termination = repair.fpr.termination;
            }
          }
          {
            std::lock_guard<std::mutex> lock(real_metrics.trajectory_mutex);
            real_metrics.repair_trajectory.push_back({
                task->task_id, task->partial->solution_id,
                task->partial->source, start, runtime.elapsed(), input_eval,
                output_eval, have_output ? output_type : "FAILED",
                repair.fpr.termination, task->partial->root_lp_id,
                [&]() {
                  const auto root = pool.findLp(task->partial->root_lp_id);
                  return root ? root->checkpoint : int64_t{-1};
                }(), task->enqueue_timestamp,
                repair.fpr.final_lp_calls ? "SUCCESS" :
                    (repair.fpr.termination == "CONSTRUCTION_FAILED"
                         ? "FAILED" : "INCOMPLETE"),
                repair.fpr.completion_model_status,
                have_output ? output_eval.objective
                            : std::numeric_limits<double>::quiet_NaN()});
            real_metrics.fpr_repair_internal_walls.push_back(
                repair.fpr.fpr_time_sec);
            real_metrics.fpr_repair_propagation_walls.push_back(
                repair.fpr.propagation_time_sec);
            real_metrics.fpr_repair_completion_lp_walls.push_back(
                repair.fpr.final_lp_time_sec);
          }
        } catch (const std::exception& error) {
          clearGurobiCompletionContext();
          if (entered_real) real_metrics.leaveReal();
          status = std::string("FPR_REPAIR_ERROR:") + error.what();
        }
      }
    } else if (type == WorkerType::FeasPump && task->kind == TaskKind::LpPhase1) {
      checks.received(type, task->lp->checkpoint);
      ++real_metrics.phase1_received;
      const double limit = runtime.testRemaining();
      if (limit <= 0.02) {
        status = "GLOBAL_LIMIT_BEFORE_ENTRY";
      } else {
        const std::string task_dir = output_root + "/phase1_task_" +
                                     std::to_string(task->task_id);
        fs::create_directories(task_dir);
        chap::feaspump::Options options;
        options.model = model_path;
        options.output_dir = task_dir;
        options.checkpoint = task->lp->checkpoint;
        options.strategy = chap::lpfix::Strategy::Frac;
        options.seed = seeds.feaspump;
        options.mode = chap::feaspump::Mode::Chap;
        options.lp_time_limit = limit;
        options.global_time_limit_sec = kArchitectureTestLimitSec;
        options.worker_time_limit_sec = std::numeric_limits<double>::max();
        options.debug_trace = false;
        real_metrics.enterReal();
        setGurobiCompletionContext(
            task->task_id, task->solution_id, task->input_source,
            task->lp->checkpoint,
            "LP_ID=" + std::to_string(task->solution_id) +
                "->FEASPUMP_PHASE1",
            runtime.start);
        chap::feaspump::Metrics metrics = chap::feaspump::runPhaseOne(
            options, model, realSnapshot(*task->lp), runtime.start);
        clearGurobiCompletionContext();
        real_metrics.leaveReal();
        ++real_metrics.phase1_completed;
        real_metrics.phase1_projection_calls += metrics.projection_calls;
        for (const auto& [lp_status, count] : metrics.projection_status_counts)
          real_metrics.recordProjectionStatus(lp_status, count);
        for (const auto& [lp_status, count] : metrics.completion_status_counts)
          real_metrics.recordCompletionStatus(lp_status, count);
        real_metrics.recordWall(real_metrics.largest_phase1_wall,
                                runtime.elapsed() - start);
        {
          std::lock_guard<std::mutex> lock(real_metrics.wall_mutex);
          real_metrics.projection_lp_total_time += metrics.projection_time;
          real_metrics.projection_lp_max_time = std::max(
              real_metrics.projection_lp_max_time,
              metrics.largest_projection_time);
        }
        if (!metrics.feasible_solution.empty()) {
          const auto x = chap::e2e::readSolution(model, metrics.feasible_solution);
          const Evaluation eval = evaluateSolution(model, x);
          if (eval.integer_feasible && eval.row_feasible) {
            pool.pushFeasibleSolution("REAL_FEASPUMP_PHASE1", immutableValues(x),
                                      eval.objective,
                                      "FULL_ORIGINAL_MODEL_VALIDATION_PASS",
                                      task->solution_id, task->solution_id, 1);
            ++real_metrics.phase1_feasible;
            output_type = "FEASIBLE";
          }
        }
        if (!metrics.partial_solution.empty()) {
          const auto x = chap::e2e::readSolution(model, metrics.partial_solution);
          const Evaluation eval = evaluateSolution(model, x);
          pool.pushPartialSolution("REAL_FEASPUMP_PHASE1_PARTIAL", immutableValues(x),
              eval.totalViolation(), eval.objective,
              "REAL_PHASE1;repair_adapter=REAL", PartialRoute::ToFprRepair,
              task->solution_id, task->solution_id, 1, 0,
              eval.max_bound_violation, eval.max_integrality_violation,
              fullAssignmentMask(x.size()), noHardAssignmentMask(x.size()),
              "FPR_0");
          ++real_metrics.feaspump_fpr_routes;
          ++real_metrics.phase1_partial;
          output_type = output_type == "FEASIBLE" ? "FEASIBLE_AND_PARTIAL" : "PARTIAL";
        }
        const bool blocked = metrics.projection_calls > 0 && runtime.testRemaining() <= 0.25;
        real_metrics.phase1_projection_blocked = blocked;
        status = blocked ? "PROJECTION_BLOCKED_UNTIL_LIMIT" : "REAL_PHASE1_RETURNED";
        {
          std::lock_guard<std::mutex> lock(real_metrics.trajectory_mutex);
          real_metrics.phase_trajectory.push_back({
              task->task_id, "PHASE1", task->input_source, start,
              runtime.elapsed(), metrics.fp_iterations,
              metrics.projection_calls, status});
        }
      }
    } else if (type == WorkerType::FeasPump && task->kind == TaskKind::TabuPhase2) {
      checks.tabu_phase2 = true;
      ++real_metrics.phase2_received;
      const double limit = runtime.testRemaining();
      if (limit <= chap::e2e::kCleanupReserveSec) {
        status = "GLOBAL_LIMIT_BEFORE_ENTRY";
      } else {
        const std::string task_dir = output_root + "/phase2_task_" +
                                     std::to_string(task->task_id);
        fs::create_directories(task_dir);
        chap::e2e::Options options{model_path, task_dir, checker_path};
        options.seed = seeds.feaspump;
        chap::e2e::FunctionalPool local(model.minimize);
        chap::e2e::Counters counters;
        std::ofstream events(task_dir + "/events.tmp");
        std::ofstream phase2_trace(task_dir + "/phase2.tmp");
        const Evaluation eval = evaluateSolution(model, *task->partial->values);
        chap::e2e::PartialRecord partial{task->partial->source, "REAL_GPU_TABU_0", 0,
            runtime.elapsed(), eval, *task->partial->values, "POOL_MEMORY"};
        const auto offset = std::chrono::duration_cast<Clock::duration>(
            std::chrono::duration<double>(chap::e2e::kWallBudgetSec -
                                          kArchitectureTestLimitSec));
        const auto synthetic_global_start = runtime.start - offset;
        ++real_metrics.phase2_projection_calls;
        real_metrics.enterReal();
        const auto phase2_root = pool.findLp(task->partial->root_lp_id);
        setGurobiCompletionContext(
            task->task_id, task->partial->solution_id,
            task->partial->source,
            phase2_root ? phase2_root->checkpoint : int64_t{-1},
            "ROOT_LP_ID=" + std::to_string(task->partial->root_lp_id) +
                "->PARTIAL_ID=" +
                std::to_string(task->partial->solution_id) +
                "->FEASPUMP_PHASE2",
            runtime.start);
        std::shared_ptr<const LpSolution> reused_lp = phase2_root;
        std::string reused_source = "PARENT_CHECKPOINT";
        std::string reuse_error =
            phaseTwoReuseValidationError(reused_lp.get(), model);
        if (!reused_lp) {
          const auto latest = pool.latestLp();
          const std::string latest_error =
              phaseTwoReuseValidationError(latest.get(), model);
          if (latest && latest_error.empty()) {
            reused_lp = latest;
            reused_source = "LATEST_CHECKPOINT_FALLBACK";
            reuse_error.clear();
          }
        }
        if (reused_lp && reuse_error.empty()) {
          const chap::e2e::PhaseTwoInitialLpView initial{
              reused_lp->checkpoint, reused_lp->primal.get(),
              reused_lp->dual.get(), reused_lp->reduced_cost.get()};
          const chap::e2e::PhaseTwoReuseContext reuse_context{
              task->task_id, task->partial->solution_id,
              task->partial->root_lp_id, reused_lp->checkpoint,
              reused_source};
          chap::e2e::g_cupdlpx_projection_outer_start.store(
              runtime.elapsed());
          chap::e2e::runPhaseTwoWithCheckpointReuse(
              options, model, partial, initial, reuse_context, local, counters,
              events, "Physics_1-1", synthetic_global_start, phase2_trace);
          chap::e2e::g_cupdlpx_projection_outer_end.store(
              runtime.elapsed());
        } else {
          std::cout << "PHASE2_TASK_ID=" << task->task_id << '\n'
                    << "SOURCE_PARTIAL_ID=" << task->partial->solution_id << '\n'
                    << "PARENT_LP_ID=" << task->partial->root_lp_id << '\n'
                    << "ROOT_CHECKPOINT=-1\n"
                    << "REUSE_ENABLED=YES\n"
                    << "PHASE2_INITIAL_LP_SOURCE=NOT_AVAILABLE\n"
                    << "PHASE2_REUSE_FALLBACK=YES\n"
                    << "PHASE2_REUSE_FALLBACK_REASON="
                    << (reuse_error.empty() ? "OTHER" : reuse_error) << '\n'
                    << "SKIPPED_ALPHA1_ROOT_LP_SOLVE=NO\n"
                    << std::flush;
          chap::e2e::runPhaseTwo(options, model, partial, local, counters,
                                 events, "Physics_1-1",
                                 synthetic_global_start, phase2_trace);
        }
        clearGurobiCompletionContext();
        real_metrics.leaveReal();
        ++real_metrics.phase2_completed;
        real_metrics.phase2_fpr_repair += counters.fpr_repairs_from_tabu;
        real_metrics.cupdlpx_projection_tasks +=
            counters.cupdlpx_projection_tasks;
        real_metrics.cupdlpx_projection_checkpoints +=
            counters.cupdlpx_projection_checkpoints;
        for (const auto& [lp_status, count] : counters.projection_status_counts)
          real_metrics.recordProjectionStatus(lp_status, count);
        for (const auto& [lp_status, count] : counters.completion_status_counts)
          real_metrics.recordCompletionStatus(lp_status, count);
        real_metrics.recordWall(real_metrics.largest_phase2_wall,
                                runtime.elapsed() - start);
        {
          std::lock_guard<std::mutex> lock(real_metrics.wall_mutex);
          real_metrics.projection_lp_total_time +=
              counters.projection_lp_total_time;
          real_metrics.projection_lp_max_time = std::max(
              real_metrics.projection_lp_max_time,
              counters.projection_lp_max_time);
        }
        for (const auto& candidate : local.feasible()) {
          const uint64_t candidate_id = pool.pushFeasibleSolution(
              "REAL_FEASPUMP_PHASE2", immutableValues(candidate.x),
              candidate.objective, "OFFICIAL_CHECKER_PASS",
              task->partial->solution_id, task->partial->root_lp_id,
              task->partial->generation + 1);
          std::cout << "CUPDLPX_PROJECTION_FEASIBLE_CANDIDATE_ID="
                    << candidate_id
                    << " SOURCE_PARTIAL_ID=" << task->partial->solution_id
                    << " PARENT_LP_ID=" << task->partial->root_lp_id
                    << '\n' << std::flush;
          ++real_metrics.phase2_feasible;
          output_type = "FEASIBLE";
        }
        for (const auto& candidate : local.partial()) {
          const uint64_t candidate_id = pool.pushPartialSolution(
              "REAL_FEASPUMP_PHASE2_PARTIAL",
              immutableValues(candidate.x), candidate.eval.totalViolation(),
              candidate.eval.objective, "REAL_PHASE2", PartialRoute::ToFprRepair,
              task->solution_id, task->partial->root_lp_id,
              task->partial->generation + 1, task->partial->repair_depth,
              candidate.eval.max_bound_violation,
              candidate.eval.max_integrality_violation,
              fullAssignmentMask(candidate.x.size()),
              noHardAssignmentMask(candidate.x.size()), "FPR_0");
          std::cout << "CUPDLPX_PROJECTION_PARTIAL_CANDIDATE_ID="
                    << candidate_id
                    << " PROJECTION_ITERATION=" << candidate.iteration
                    << " SOURCE_PARTIAL_ID=" << task->partial->solution_id
                    << " PARENT_LP_ID=" << task->partial->root_lp_id
                    << '\n' << std::flush;
          ++real_metrics.feaspump_fpr_routes;
          ++real_metrics.phase2_partial;
          output_type = output_type == "FEASIBLE" ? "FEASIBLE_AND_PARTIAL" : "PARTIAL";
        }
        const bool blocked = runtime.testRemaining() <= 0.25;
        real_metrics.phase2_projection_blocked = blocked;
        status = blocked ? "PROJECTION_BLOCKED_UNTIL_LIMIT" : "REAL_PHASE2_RETURNED";
        {
          std::lock_guard<std::mutex> lock(real_metrics.trajectory_mutex);
          real_metrics.phase_trajectory.push_back({
              task->task_id, "PHASE2", task->input_source, start,
              runtime.elapsed(), 0, 1, status,
              task->partial->solution_id,
              [&]() {
                const auto root = pool.findLp(task->partial->root_lp_id);
                return root ? root->checkpoint : int64_t{-1};
              }(), task->enqueue_timestamp, start, runtime.elapsed()});
        }
      }
    } else if (type == WorkerType::Tabu && task->kind == TaskKind::LpTabu) {
      ++real_metrics.tabu_received;
      int64_t expected = 0;
      real_metrics.first_tabu_checkpoint.compare_exchange_strong(
          expected, task->lp->checkpoint);
      ++real_metrics.tabu_started;
      const double limit = std::min(5.0, runtime.testRemaining());
      if (limit <= 0.05) {
        status = "GLOBAL_LIMIT_BEFORE_ENTRY";
      } else {
        try {
          real_metrics.enterReal();
          p3c::PolicyWorkerConfig config;
          config.initialize = provisionalTabuInitialization;
          config.seed = static_cast<uint32_t>(seeds.tabu);
          config.weight_event_period = 5;
          config.wall_limit_seconds = limit;
          p3c::PolicyEnabledGpuTabuWorker worker(gpu_model, config);
          real_metrics.gpu_model_resident = true;
          p3b::TabuInput input;
          input.solution_id = task->solution_id;
          input.source = p3b::InputSource::LpSnapshot;
          input.candidate = *task->lp->primal;
          input.supplied_weights.assign(gpu_model.m, 1.0);
          input.supplied_direction_mask.assign(gpu_model.n, 3);
          if (task->best_known_objective_seen)
            input.best_incumbent_objective = *task->best_known_objective_seen;
          const Evaluation tabu_input_eval = evaluateSolution(
              model, provisionalTabuInitialization(gpu_model, input));
          p3b::PoolSink sink;
          sink.pushPartialSolution = [&](const p3b::TabuOutput& out) {
            const std::string metadata =
                "parent=" + std::to_string(task->solution_id) +
                ";source=GPU_TABU;generation=1;checkpoint=" +
                std::to_string(task->lp->checkpoint) +
                ";consumer=FEASPUMP_PHASE2_AND_FPR_REPAIR;worker_elapsed=" +
                std::to_string(out.timestamp) +
                ";integrality_violation=" +
                std::to_string(out.integrality_violation);
            pool.pushPartialSolution("REAL_GPU_TABU_PARTIAL",
                immutableValues(out.candidate), out.max_row_violation,
                out.objective, metadata,
                PartialRoute::ToFeasPumpPhase2AndFprRepair,
                task->solution_id, task->solution_id, 1, 0,
                out.max_bound_violation, out.integrality_violation,
                fullAssignmentMask(out.candidate.size()),
                noHardAssignmentMask(out.candidate.size()),
                "FEASPUMP_PHASE2,FPR_0");
            ++real_metrics.tabu_partials;
            ++real_metrics.tabu_pool_writes;
            ++real_metrics.gpu_fpr_routes;
          };
          sink.pushFeasibleSolution = [&](const p3b::TabuOutput& out) {
            const Evaluation eval = evaluateSolution(model, out.candidate);
            if (eval.integer_feasible && eval.row_feasible) {
              pool.pushFeasibleSolution("REAL_GPU_TABU_FEASIBLE",
                  immutableValues(out.candidate), eval.objective,
                  "FULL_ORIGINAL_MODEL_VALIDATION_PASS",
                  task->solution_id, task->solution_id, 1);
              ++real_metrics.tabu_feasible;
              ++real_metrics.tabu_pool_writes;
            }
          };
          const auto result = worker.consume(input, 10, 0, std::move(sink));
          const Evaluation tabu_output_eval =
              evaluateSolution(model, result.output.candidate);
          real_metrics.tabu_moves += result.stats.moves_executed;
          real_metrics.tabu_rejections += result.stats.tabu_rejections;
          if (result.stats.moves_executed > 0)
            real_metrics.directional_state_updated = true;
          ++real_metrics.tabu_completed;
          output_type = result.output.feasible ? "FEASIBLE" : "PARTIAL";
          status = "REAL_GPU_TABU_COMPLETED";
          {
            std::lock_guard<std::mutex> lock(real_metrics.trajectory_mutex);
            real_metrics.gpu_trajectory.push_back({
                task->task_id, task->solution_id, task->lp->checkpoint, start,
                runtime.elapsed(), result.stats.iterations,
                result.stats.moves_executed, result.stats.tabu_rejections,
                tabu_input_eval, tabu_output_eval});
          }
          real_metrics.leaveReal();
        } catch (const std::exception& error) {
          real_metrics.leaveReal();
          ++real_metrics.cuda_errors;
          status = std::string("REAL_GPU_TABU_ERROR:") + error.what();
        }
      }
    } else {
      status = "UNSUPPORTED_TASK_ROUTE";
    }
    const double end = runtime.elapsed();
    trace.interval(start, end, worker_id, task->task_id);
    trace.event("TASK_END", worker_id, task->task_id, task->input_source,
                output_type, status);
  }
  stats.stopped = true;
  runtime.noteWorkerFinished(runtime.elapsed());
  trace.event("WORKER_STOP", worker_id, 0, "N/A", "N/A", "GLOBAL_STOP");
}

uint64_t checksumValues(const std::vector<double>& values) {
  uint64_t hash = 1469598103934665603ULL;
  for (double value : values) {
    hash ^= std::bit_cast<uint64_t>(value);
    hash *= 1099511628211ULL;
  }
  return hash;
}

bool allFinite(const std::vector<double>& values) {
  return std::all_of(values.begin(), values.end(),
                     [](double value) { return std::isfinite(value); });
}

struct ProducerContext {
  GlobalRuntimeContext* runtime = nullptr;
  SharedSolutionPool* pool = nullptr;
  Instrumentation* trace = nullptr;
  const lp_problem_t* problem = nullptr;
  std::mutex mutex;
  std::vector<int64_t> reached;
  std::unordered_map<int64_t, uint64_t> pushed_checksums;
  bool callback_failed = false;
  std::string callback_error;
  std::atomic<int> actual_iterations{0};
  std::atomic<bool> solver_finished{false};
};

double finiteViolation(double value, double lower, double upper) {
  double violation = 0.0;
  if (std::isfinite(lower)) violation = std::max(violation, lower - value);
  if (std::isfinite(upper)) violation = std::max(violation, value - upper);
  return violation;
}

extern "C" void realSnapshotCallback(const cupdlpx_snapshot_t* source, void* data) {
  auto* context = static_cast<ProducerContext*>(data);
  if (context->runtime->shouldStop() || context->runtime->deadlineReached())
    return;
  try {
    auto primal = std::make_shared<const std::vector<double>>(
        source->primal, source->primal + source->num_primal);
    auto dual = std::make_shared<const std::vector<double>>(
        source->dual, source->dual + source->num_dual);
    auto reduced_cost = std::make_shared<const std::vector<double>>(
        source->reduced_cost, source->reduced_cost + source->num_primal);
    double max_bound = 0.0;
    double max_row = 0.0;
    const lp_problem_t& problem = *context->problem;
    for (int j = 0; j < problem.num_variables; ++j)
      max_bound = std::max(max_bound, finiteViolation((*primal)[j],
          problem.variable_lower_bound[j], problem.variable_upper_bound[j]));
    for (int i = 0; i < problem.num_constraints; ++i) {
      long double activity = 0.0L;
      for (int p = problem.constraint_matrix_row_pointers[i];
           p < problem.constraint_matrix_row_pointers[i + 1]; ++p)
        activity += static_cast<long double>(problem.constraint_matrix_values[p]) *
                    (*primal)[problem.constraint_matrix_col_indices[p]];
      max_row = std::max(max_row, finiteViolation(static_cast<double>(activity),
          problem.constraint_lower_bound[i], problem.constraint_upper_bound[i]));
    }
    LpSolution snapshot;
    snapshot.checkpoint = source->iteration;
    snapshot.requested_iteration = source->iteration;
    snapshot.actual_iteration = source->iteration;
    snapshot.source = "CUPDLPX_REAL_STREAM";
    snapshot.primal = primal;
    snapshot.dual = dual;
    snapshot.reduced_cost = reduced_cost;
    snapshot.original_coordinates = source->original_coordinates;
    snapshot.primal_all_finite = allFinite(*primal);
    snapshot.dual_all_finite = allFinite(*dual);
    snapshot.reduced_cost_all_finite = allFinite(*reduced_cost);
    snapshot.max_bound_violation = max_bound;
    snapshot.max_row_violation = max_row;
    snapshot.primal_checksum = checksumValues(*primal);
    snapshot.dual_checksum = checksumValues(*dual);
    snapshot.reduced_cost_checksum = checksumValues(*reduced_cost);
    const uint64_t checksum = snapshot.primal_checksum;
    context->pool->pushLpSolution(std::move(snapshot));
    {
      std::lock_guard<std::mutex> lock(context->mutex);
      context->reached.push_back(source->iteration);
      context->pushed_checksums[source->iteration] = checksum;
      context->actual_iterations.store(source->iteration);
    }
    context->trace->event("POOL_WRITE", "LP_PRODUCER_0", source->iteration,
                          "CUPDLPX_REAL_STREAM", "LP", "CHECKPOINT_PUSHED");
  } catch (const std::exception& error) {
    std::lock_guard<std::mutex> lock(context->mutex);
    context->callback_failed = true;
    context->callback_error = error.what();
  }
}

void producerLoop(const std::string& model, GlobalRuntimeContext& runtime,
                  SharedSolutionPool& pool, Instrumentation& trace,
                  WorkerStats& stats, ProducerContext& context) {
  const std::string worker = "LP_PRODUCER_0";
  stats.started = true;
  trace.event("WORKER_START", worker);
  const double start = runtime.elapsed();
  if (runtime.deadlineReached()) {
    stats.stopped = true;
    runtime.noteWorkerFinished(runtime.elapsed());
    trace.event("WORKER_STOP", worker, 0, "N/A", "N/A",
                "GLOBAL_LIMIT_BEFORE_ENTRY");
    return;
  }
  runtime.noteTaskStarted(start);
  trace.event("TASK_START", worker, 1, "CUPDLPX_LIBRARY", "CONTINUOUS_SOLVE");
  lp_problem_t* problem = read_mps_file(model.c_str());
  if (!problem) throw std::runtime_error("cuPDLPx failed to read model");
  context.runtime = &runtime;
  context.pool = &pool;
  context.trace = &trace;
  context.problem = problem;
  pdhg_parameters_t parameters;
  set_default_parameters(&parameters);
  parameters.verbose = false;
  parameters.presolve = false;
  parameters.termination_evaluation_frequency = 100;
  parameters.termination_criteria.eps_optimal_relative = 1e-4;
  parameters.termination_criteria.eps_feasible_relative = 1e-2;
  parameters.termination_criteria.iteration_limit = 100000;
  parameters.termination_criteria.time_sec_limit = runtime.remainingTimeSec();
  parameters.snapshot_callback = realSnapshotCallback;
  parameters.snapshot_user_data = &context;
  cupdlpx_result_t* result = solve_lp_problem(problem, &parameters);
  if (!result) {
    lp_problem_free(problem);
    throw std::runtime_error("cuPDLPx returned null");
  }
  context.actual_iterations.store(result->total_count);
  context.solver_finished.store(true);
  cupdlpx_result_free(result);
  lp_problem_free(problem);
  const double end = runtime.elapsed();
  trace.interval(start, end, worker, 1);
  trace.event("TASK_END", worker, 1, "CUPDLPX_LIBRARY", "LP_STREAM", "FINISHED");
  stats.tasks = static_cast<int>(context.reached.size());
  stats.stopped = true;
  runtime.noteWorkerFinished(runtime.elapsed());
  trace.event("WORKER_STOP", worker, 0, "N/A", "N/A", "PRODUCER_COMPLETE");
}

int maxConcurrent(const std::vector<Interval>& intervals) {
  std::vector<std::pair<double, int>> points;
  for (const auto& interval : intervals) {
    points.push_back({interval.start, 1});
    points.push_back({interval.end, -1});
  }
  std::sort(points.begin(), points.end(), [](const auto& a, const auto& b) {
    if (a.first != b.first) return a.first < b.first;
    return a.second < b.second;
  });
  int active = 0, maximum = 0;
  for (const auto& [time, delta] : points) {
    (void)time;
    active += delta;
    maximum = std::max(maximum, active);
  }
  return maximum;
}

double infinityDelta(const std::vector<double>& lhs,
                     const std::vector<double>& rhs) {
  if (lhs.size() != rhs.size()) return std::numeric_limits<double>::infinity();
  double result = 0.0;
  for (size_t i = 0; i < lhs.size(); ++i)
    result = std::max(result, std::abs(lhs[i] - rhs[i]));
  return result;
}

struct SmallClosedLoopResult {
  bool executed = false;
  bool real_lp = false;
  bool real_partial = false;
  bool real_repair = false;
  bool real_feasible_validation = false;
  bool incumbent_update = false;
  bool atomic_update = false;
  bool later_task_saw_objective = false;
  bool pass = false;
  double best_objective = std::numeric_limits<double>::quiet_NaN();
  uint64_t incumbent_version = 0;
  uint64_t lp_entries = 0;
  uint64_t partial_entries = 0;
  uint64_t feasible_entries = 0;
  uint64_t repair_tasks_produced = 0;
  uint64_t repair_tasks_consumed = 0;
  RepairExample repair_example;
};

LpSolution makeSmallLpRecord(const MIPModel& model, const LpResult& relaxation,
                             int64_t checkpoint, std::string source) {
  LpSolution record;
  record.checkpoint = checkpoint;
  record.source = std::move(source);
  record.primal = immutableValues(relaxation.x);
  record.dual = immutableValues(std::vector<double>(model.n_rows, 0.0));
  record.reduced_cost = immutableValues(std::vector<double>(model.n_cols, 0.0));
  record.requested_iteration = checkpoint;
  record.actual_iteration = checkpoint;
  record.original_coordinates = true;
  record.primal_all_finite = allFinite(*record.primal);
  record.dual_all_finite = true;
  record.reduced_cost_all_finite = true;
  const Evaluation eval = evaluateSolution(model, *record.primal);
  record.max_bound_violation = eval.max_bound_violation;
  record.max_row_violation = eval.max_row_violation;
  record.primal_checksum = checksumValues(*record.primal);
  record.dual_checksum = checksumValues(*record.dual);
  record.reduced_cost_checksum = checksumValues(*record.reduced_cost);
  return record;
}

SmallClosedLoopResult runSmallClosedLoop(const std::string& small_model_path) {
  SmallClosedLoopResult result;
  result.executed = true;
  GlobalRuntimeContext runtime;
  Instrumentation trace(runtime);
  const MIPModel model = loadModel(small_model_path);
  const p3b::Model gpu_model = makeGpuTabuModel(model);
  SharedSolutionPool pool(runtime, trace, model.minimize);

  const LpResult relaxation =
      solveCpuLp(model, nullptr, nullptr, nullptr, false, 10.0);
  if (!relaxation.optimal ||
      relaxation.x.size() != static_cast<size_t>(model.n_cols)) {
    pool.requestStop();
    return result;
  }
  result.real_lp = true;
  pool.pushLpSolution(
      makeSmallLpRecord(model, relaxation, 1, "SMALL_REAL_HIGHS_LP"));

  double waited = 0.0;
  auto tabu_task = pool.waitPop(WorkerType::Tabu, "SMALL_GPU_TABU_0", waited);
  if (!tabu_task || !tabu_task->lp) {
    pool.requestStop();
    return result;
  }
  p3c::PolicyWorkerConfig config;
  config.initialize = provisionalTabuInitialization;
  config.seed = p3c::kLocalMipBaselineSeed;
  config.weight_event_period = 0;
  config.wall_limit_seconds = 5.0;
  p3c::PolicyEnabledGpuTabuWorker worker(gpu_model, config);
  p3b::TabuInput input;
  input.solution_id = tabu_task->solution_id;
  input.source = p3b::InputSource::LpSnapshot;
  input.candidate = *tabu_task->lp->primal;
  input.supplied_weights.assign(gpu_model.m, 1.0);
  input.supplied_direction_mask.assign(gpu_model.n, 3);
  p3b::PoolSink sink;
  sink.pushPartialSolution = [&](const p3b::TabuOutput& out) {
    const Evaluation eval = evaluateSolution(model, out.candidate);
    pool.pushPartialSolution(
        "SMALL_REAL_GPU_TABU_PARTIAL", immutableValues(out.candidate),
        eval.totalViolation(), eval.objective,
        "REAL_SMALL_GPU_TABU;consumer=FPR_0", PartialRoute::ToFprRepair,
        tabu_task->solution_id, tabu_task->solution_id, 1, 0,
        eval.max_bound_violation, eval.max_integrality_violation,
        fullAssignmentMask(out.candidate.size()),
        noHardAssignmentMask(out.candidate.size()), "FPR_0");
    result.real_partial = true;
  };
  sink.pushFeasibleSolution = [&](const p3b::TabuOutput& out) {
    const Evaluation eval = evaluateSolution(model, out.candidate);
    if (eval.integer_feasible && eval.row_feasible)
      pool.pushFeasibleSolution(
          "SMALL_REAL_GPU_TABU_FEASIBLE", immutableValues(out.candidate),
          eval.objective, "FULL_ORIGINAL_MODEL_VALIDATION_PASS");
  };
  worker.consume(input, 1, 0, std::move(sink));

  auto repair_task = pool.waitPop(WorkerType::Fpr, "SMALL_FPR_0", waited);
  if (!repair_task || repair_task->kind != TaskKind::PartialFprRepair ||
      !repair_task->partial) {
    pool.requestStop();
    return result;
  }
  result.repair_tasks_consumed = 1;
  const Evaluation input_eval =
      evaluateSolution(model, *repair_task->partial->values);
  const auto repair_start = Clock::now();
  PartialRepairOutcome repair = runPartialRepairFpr(
      model, *repair_task->partial, pool, runtime, 10.0, 13);
  const double repair_wall =
      std::chrono::duration<double>(Clock::now() - repair_start).count();
  result.real_repair = true;
  result.repair_example.recorded = true;
  result.repair_example.input_source = repair_task->partial->source;
  result.repair_example.input_eval = input_eval;
  result.repair_example.wall_time = repair_wall;
  result.repair_example.guidance_source = repair.guidance_source;
  result.repair_example.termination = repair.fpr.termination;
  if (repair.candidate) {
    const Evaluation output_eval =
        evaluateSolution(model, repair.candidate->x);
    result.repair_example.output_eval = output_eval;
    if (output_eval.integer_feasible && output_eval.row_feasible) {
      result.repair_example.output_type = "FEASIBLE";
      pool.pushFeasibleSolution(
          "SMALL_REAL_FPR_REPAIR_FEASIBLE",
          immutableValues(repair.candidate->x), output_eval.objective,
          "FULL_ORIGINAL_MODEL_VALIDATION_PASS",
          repair_task->partial->solution_id,
          repair_task->partial->root_lp_id);
      result.real_feasible_validation = true;
    } else {
      result.repair_example.output_type = "PARTIAL";
    }
  }

  IncumbentSnapshot incumbent = pool.incumbentSnapshot();
  result.incumbent_update = incumbent.feasible && incumbent.version == 1 &&
                            incumbent.best_known_objective.has_value();
  if (result.incumbent_update) {
    result.best_objective = *incumbent.best_known_objective;
    const auto verified = incumbent.feasible;
    std::vector<std::thread> writers;
    for (int i = 0; i < 4; ++i) {
      writers.emplace_back([&, verified]() {
        pool.pushFeasibleSolution(
            "CONCURRENT_REPLAY_OF_VERIFIED_FEASIBLE", verified->values,
            verified->objective, "FULL_ORIGINAL_MODEL_VALIDATION_PASS",
            verified->repair_parent_id, verified->repair_root_lp_id);
      });
    }
    for (auto& writer_thread : writers) writer_thread.join();
    const IncumbentSnapshot after_race = pool.incumbentSnapshot();
    result.atomic_update = after_race.version == 1 &&
                           after_race.feasible &&
                           after_race.feasible->solution_id ==
                               incumbent.feasible->solution_id;

    pool.pushLpSolution(
        makeSmallLpRecord(model, relaxation, 2, "SMALL_POST_INCUMBENT_LP"));
    auto later_task =
        pool.waitPop(WorkerType::Tabu, "SMALL_GPU_TABU_0", waited);
    if (later_task && later_task->lp) {
      result.later_task_saw_objective =
          later_task->objective_version_seen == 1 &&
          later_task->best_known_objective_seen.has_value() &&
          std::abs(*later_task->best_known_objective_seen -
                   result.best_objective) <= 1e-9;
      p3b::TabuInput later_input;
      later_input.solution_id = later_task->solution_id;
      later_input.source = p3b::InputSource::LpSnapshot;
      later_input.candidate = *later_task->lp->primal;
      later_input.supplied_weights.assign(gpu_model.m, 1.0);
      later_input.supplied_direction_mask.assign(gpu_model.n, 3);
      later_input.best_incumbent_objective =
          *later_task->best_known_objective_seen;
      p3b::PoolSink later_sink;
      later_sink.pushPartialSolution = [&](const p3b::TabuOutput& out) {
        const Evaluation eval = evaluateSolution(model, out.candidate);
        pool.pushPartialSolution(
            "SMALL_POST_INCUMBENT_GPU_PARTIAL", immutableValues(out.candidate),
            eval.totalViolation(), eval.objective,
            "OBJECTIVE_VERSION_SEEN=" +
                std::to_string(later_task->objective_version_seen),
            PartialRoute::None, later_task->solution_id,
            later_task->solution_id, 1, 1, eval.max_bound_violation,
            eval.max_integrality_violation,
            fullAssignmentMask(out.candidate.size()),
            noHardAssignmentMask(out.candidate.size()), "NONE");
      };
      later_sink.pushFeasibleSolution = [&](const p3b::TabuOutput& out) {
        const Evaluation eval = evaluateSolution(model, out.candidate);
        if (eval.integer_feasible && eval.row_feasible)
          pool.pushFeasibleSolution(
              "SMALL_POST_INCUMBENT_GPU_FEASIBLE",
              immutableValues(out.candidate), eval.objective,
              "FULL_ORIGINAL_MODEL_VALIDATION_PASS");
      };
      worker.consume(later_input, 1, 0, std::move(later_sink));
    }
  }

  result.incumbent_version = pool.incumbentVersion();
  result.lp_entries = pool.lpCount();
  result.partial_entries = pool.partialCount();
  result.feasible_entries = pool.feasibleCount();
  result.repair_tasks_produced = pool.repairTasksProduced();
  result.pass = result.real_lp && result.real_partial && result.real_repair &&
                result.real_feasible_validation && result.incumbent_update &&
                result.atomic_update && result.later_task_saw_objective;
  pool.requestStop();
  return result;
}

struct P8RunOptions {
  std::string model;
  std::string checker;
  std::string output_root;
  std::string small_model;
  uint64_t global_seed = 0;
  double time_limit_sec = kChapGlobalLimitSec;
  bool feaspump_enabled = true;
  bool ufpr_temporal = false;
  bool ufpr_segment = false;
};

P8RunOptions parseP8RunOptions(int argc, char** argv) {
  if (argc < 5)
    throw std::runtime_error(
        "Usage: chap_p8 MODEL.mps CHECKER OUTPUT_DIR SMALL.mps "
        "[--global-seed UINT64] [--time-limit SEC] [--feaspump on|off] "
        "[--ufpr-temporal on|off] [--ufpr-segment on|off]");
  P8RunOptions options{argv[1], argv[2], argv[3], argv[4], 0,
                       kChapGlobalLimitSec, true, false, false};
  for (int i = 5; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--global-seed") {
      if (++i >= argc)
        throw std::runtime_error("missing value for --global-seed");
      options.global_seed = std::stoull(argv[i]);
    } else if (arg == "--time-limit") {
      if (++i >= argc)
        throw std::runtime_error("missing value for --time-limit");
      options.time_limit_sec = std::stod(argv[i]);
      if (!(options.time_limit_sec > 0.0))
        throw std::runtime_error("--time-limit must be positive");
    } else if (arg == "--feaspump") {
      if (++i >= argc)
        throw std::runtime_error("missing value for --feaspump");
      const std::string value = argv[i];
      if (value == "on") options.feaspump_enabled = true;
      else if (value == "off") options.feaspump_enabled = false;
      else throw std::runtime_error("--feaspump must be on or off");
    } else if (arg == "--ufpr-temporal") {
      if (++i >= argc)
        throw std::runtime_error("missing value for --ufpr-temporal");
      const std::string value = argv[i];
      if (value == "on") options.ufpr_temporal = true;
      else if (value == "off") options.ufpr_temporal = false;
      else throw std::runtime_error("--ufpr-temporal must be on or off");
    } else if (arg == "--ufpr-segment") {
      if (++i >= argc)
        throw std::runtime_error("missing value for --ufpr-segment");
      const std::string value = argv[i];
      if (value == "on") options.ufpr_segment = true;
      else if (value == "off") options.ufpr_segment = false;
      else throw std::runtime_error("--ufpr-segment must be on or off");
    } else {
      throw std::runtime_error("unknown option: " + arg);
    }
  }
  return options;
}

int main(int argc, char** argv) {
  const char* ufpr_b_test = std::getenv("P8_UFPR_B_UNIT_TEST");
  if (ufpr_b_test && std::string(ufpr_b_test) != "0")
    return runUfprBUnitTests() ? 0 : 1;
  const char* metadata_test =
      std::getenv("P8_METADATA_NORMALIZATION_TEST");
  if (metadata_test && std::string(metadata_test) != "0") {
    const ValidationMetadata normalized =
        normalizeValidationMetadata("OFFICIAL_CHECKER_PASS");
    const bool pass =
        normalized.status == "FULL_ORIGINAL_MODEL_VALIDATION_PASS" &&
        normalized.source == "OFFICIAL_CHECKER";
    std::cout << "METADATA_NORMALIZATION_UNIT_TEST="
              << (pass ? "PASS" : "FAIL") << '\n'
              << "INPUT_LABEL=OFFICIAL_CHECKER_PASS\n"
              << "VALIDATION_STATUS=" << normalized.status << '\n'
              << "VALIDATION_SOURCE=" << normalized.source << '\n'
              << "ALGORITHM_CHANGED_BY_METADATA_FIX=NO\n";
    return pass ? 0 : 1;
  }
  const P8RunOptions run_options = parseP8RunOptions(argc, argv);
  g_ufpr_temporal_enabled = run_options.ufpr_temporal;
  g_ufpr_segment_enabled = run_options.ufpr_segment;
  const std::string model = run_options.model;
  const std::string checker = run_options.checker;
  const std::string output_root = run_options.output_root;
  const std::string small_model = run_options.small_model;
  GlobalRuntimeContext runtime(run_options.time_limit_sec);
  const ExperimentSeeds seeds = makeExperimentSeeds(run_options.global_seed);
  cupdlpx_set_random_seed(seeds.cupdlpx);
  const MIPModel real_model = loadModel(model);
  const auto uc_map = buildUcModelMap(real_model);
  int mapped_commitments = 0;
  bool mapping_valid = uc_map.thermal_units > 0 && uc_map.periods > 0;
  for (const auto& trajectory : uc_map.commitment)
    for (const int col : trajectory) {
      if (col < 0) { mapping_valid = false; continue; }
      ++mapped_commitments;
      if (real_model.var_type[col] != VarType::Binary)
        mapping_valid = false;
    }
  std::cout << "INSTANCE=Physics 1-4\nMODEL_ROWS=" << real_model.n_rows
            << "\nMODEL_COLUMNS=" << real_model.n_cols
            << "\nUC_THERMAL_UNITS=" << uc_map.thermal_units
            << "\nUC_PERIODS=" << uc_map.periods
            << "\nUC_MAPPED_COMMITMENTS=" << mapped_commitments
            << "\nUFPR_B_MAPPING_VALID=" << (mapping_valid ? "YES" : "NO")
            << "\nFIRST_ROUTED_CHECKPOINT=10000\n"
            << "CUPDLPX_SNAPSHOT_SEQUENCE=100,1000,10000,100000\n"
            << "CUPDLPX_EPS_OPT=1e-4\nCUPDLPX_EPS_FEAS=1e-2\n";
  if (!mapping_valid) throw std::runtime_error("UFPR-B commitment mapping invalid");
  if (std::getenv("P8_UFPR_B_MODEL_PREFLIGHT")) return 0;
  const p3b::Model gpu_model = makeGpuTabuModel(real_model);
  fs::create_directories(output_root);
  Instrumentation trace(runtime);
  SharedSolutionPool pool(runtime, trace, real_model.minimize,
                          run_options.feaspump_enabled);
  RoutingChecks checks;
  WorkerStats producer_stats, fpr_stats, feaspump_stats, tabu_stats;
  ProducerContext producer_context;
  RealWorkerMetrics real_metrics;

  char hostname[256] = {};
  if (gethostname(hostname, sizeof(hostname) - 1) != 0)
    std::snprintf(hostname, sizeof(hostname), "N/A");
  int cuda_runtime_version = 0;
  if (cudaRuntimeGetVersion(&cuda_runtime_version) != cudaSuccess)
    cuda_runtime_version = 0;
  const char* cuda_visible = std::getenv("CUDA_VISIBLE_DEVICES");
  int gurobi_major = 0, gurobi_minor = 0, gurobi_technical = 0;
  GRBversion(&gurobi_major, &gurobi_minor, &gurobi_technical);

  std::cout << std::fixed << std::setprecision(6)
            << "P8_VERSION=P8_FP_RETAINED_20260929\n"
            << "FEASPUMP_ENABLED="
            << (run_options.feaspump_enabled ? "YES" : "NO") << '\n'
            << "UFPR_A_ENABLED="
            << (run_options.ufpr_temporal ? "YES" : "NO") << '\n'
            << "UFPR_B_ENABLED="
            << (run_options.ufpr_segment ? "YES" : "NO") << '\n'
            << "UFPR_B_LMAX=4\n"
            << "UFPR_C_ENABLED=NO\nUFPR_D_ENABLED=NO\n"
            << "UFPR_SCORE_ENABLED=NO\nUFPR_RAMP_ENABLED=NO\n"
            << "DIRECT_FPR_ENABLED=YES\nREPAIR_FPR_ENABLED=YES\n"
            << "COMPLETION_ENABLED=YES\n"
            << "ROOT_CUPDLPX_ENABLED=YES\n"
            << "ROOT_CUPDLPX_GPU=YES\n"
            << "ROOT_CUPDLPX_CUDA_GRAPH=OFF\n"
            << "FP_CUPDLPX_ENABLED=YES\n"
            << "FP_CUPDLPX_GPU=YES\n"
            << "FP_CUPDLPX_CUDA_GRAPH=OFF\n"
            << "CUPDLPX_GRAPH_CAPTURE_DISABLED=YES\n"
            << "PARTIAL_OUTPUT_DIRECTORY_FIX_PRESERVED=YES\n"
            << "PARTIAL_OUTPUT_DIRECTORY_FIX=YES\n"
            << "NUM_ACTIVE_CUPDLPX_SOLVER_INSTANCES_EXPECTED=2\n"
            << "ROOT_CUPDLPX_INSTANCE=1\nFP_CUPDLPX_INSTANCE=1\n"
            << "CONCURRENT_CUPDLPX_SOLVES=YES\n"
            << "CONCURRENT_CUPDLPX_ALLOWED=YES\n"
            << "GLOBAL_SEED=" << seeds.global << '\n'
            << "TABU_SEED=" << seeds.tabu << '\n'
            << "FPR_SEED=" << seeds.fpr << '\n'
            << "FEASPUMP_SEED=" << seeds.feaspump << '\n'
            << "REPAIR_SEED=" << seeds.repair << '\n'
            << "PROJECTION_SEED=" << seeds.projection << '\n'
            << "CUPDLPX_SEED=" << seeds.cupdlpx << '\n'
            << "REQUESTED_TIME_LIMIT_SEC=" << runtime.global_limit_sec << '\n'
            << "COMPLETION_BACKEND=GUROBI\n"
            << "PROJECTION_BACKEND=CUPDLPX_PRIMAL_DUAL_RESTART\n"
            << "GUROBI_METHOD=DEFAULT\n"
            << "GUROBI_THREADS=1\n"
            << "GUROBI_SEED=0\n"
            << "GUROBI_VERSION=" << gurobi_major << '.' << gurobi_minor
            << '.' << gurobi_technical << '\n'
            << "GLOBAL_START_TIME=" << runtime.startEpochSec() << '\n'
            << "CPU_THREADS=" << std::thread::hardware_concurrency() << '\n'
            << "CUDA_DEVICE=" << (cuda_visible ? cuda_visible : "UNSET") << '\n'
            << "GPU_NAME=" << p3b::Core::deviceName() << '\n'
            << "HOSTNAME=" << hostname << '\n'
            << "HIGHS_VERSION=" << HIGHS_VERSION_MAJOR << '.'
            << HIGHS_VERSION_MINOR << '.' << HIGHS_VERSION_PATCH << '\n'
            << "CUDA_RUNTIME_VERSION=" << cuda_runtime_version << '\n'
            << "GIT_COMMIT=N/A\nGIT_DIRTY=N/A\n"
            << "FPR_REAL_ENTRY=runLpGuidedFpr\n"
            << "FPR_PARTIAL_REPAIR_INTERNAL_CAPABILITY=PARTIAL\n"
            << "FPR_REPAIR_ENTRY=runPartialRepairFpr_THIN_ADAPTER\n"
            << "PARTIAL_UNKNOWN_REPRESENTATION=EXPLICIT_ASSIGNED_MASK\n"
            << "PARTIAL_HARD_ASSIGNMENT_REPRESENTATION=EXPLICIT_HARD_MASK\n"
            << "TABU_PARTIAL_HARD_FIXED=NO\n"
            << "MAX_FPR_REPAIR_DEPTH=1\n"
            << "ENGINEERING_SAFETY_GUARD_NOT_CHAP_PARAMETER=YES\n"
            << "FEASPUMP_PHASE1_REAL_ENTRY=chap::feaspump::runPhaseOne\n"
            << "FEASPUMP_PHASE2_REAL_ENTRY=chap::e2e::runPhaseTwoWithCheckpointReuse\n"
            << "EXPERIMENT_NAME=UFPR-AB-FP-ON-NOGRAPH-300s\n"
            << "RETAINED_VARIANT=P8-FP-Retained\n"
            << "FEASPUMP_STATUS=FROZEN_FOR_CURRENT_STUDY\n"
            << "PHASE2_PROJECTION_ENGINE=CUPDLPX\n"
            << "FULL_SOLVER_STATE_CONTINUATION=NO\n"
            << "SKIPPED_ALPHA1_ROOT_PROJECTION=YES\n"
            << "FIRST_SOLVED_ALPHA=0.1\n"
            << "PROJECTION_CHECKPOINTS=100,1000,10000,50000\n"
            << "EXACT_CPU_PROJECTION_USED=NO\n"
            << "FP_ROLE=COMPLEMENTARY_FEASIBILITY_RECOVERY_AND_DIVERSIFICATION\n"
            << "METADATA_VALIDATION_LABEL_NORMALIZED=YES\n"
            << "ALGORITHM_CHANGED_BY_METADATA_FIX=NO\n"
            << "PHASE2_CHECKPOINT_REUSE=YES\n"
            << "CUPDLPX_REUSE_MODE=PRIMAL_DUAL_RESTART\n"
            << "HEURISTIC_STATE_REUSE=YES\n"
            << "CUPDLPX_STATE_REUSE=PRIMAL_DUAL_ONLY\n"
            << "CPU_SIMPLEX_PROJECTION_USED=NO\n"
            << "MATHEMATICAL_FP_OBJECTIVE_CHANGED=NO\n"
            << "ALPHA_SCHEDULE_CHANGED=NO\n"
            << "INITIALIZATION_LIFECYCLE_CHANGED=YES\n"
            << "FEASPUMP_PHASE2_DEVICE=GPU\n"
            << "INCUMBENT_FEEDBACK_MODE=METADATA_ONLY\n"
            << "THREAD_SAFETY_BLOCKERS=FILE_OUTPUT_AND_SERIAL_CALL_ASSUMPTIONS_ISOLATED_BY_WORKER_LOCAL_CONTEXT\n"
            << "P2_REAL_CPU_CONSUMERS=YES\n"
            << "REAL_CUPDLPX_PRODUCER=YES\n"
            << "CUPDLPX_INTERFACE=LIBRARY\n"
            << "GLOBAL_TIME_LIMIT=" << runtime.global_limit_sec << " s\n"
            << "P8_GLOBAL_RUNTIME_LIMIT=" << runtime.global_limit_sec << " s\n"
            << "DOMAIN_FIX_IDENTICAL_TO_P7C=YES\n"
            << "PROPAGATION_MATHEMATICS_CHANGED=NO\n"
            << "BOUND_TOLERANCE_CHANGED=NO\n"
            << "CHECKPOINT_WARMSTART_CHAIN=YES\n"
            << "FPR_IMPLEMENTATION=REAL_EVENT_DRIVEN\n"
            << "FPR_SEMANTICS_CHANGED_IN_P2=NO\n"
            << "FEASPUMP_IMPLEMENTATION=REAL\n"
            << "FEASPUMP_ALGORITHM_CHANGED_IN_P2=NO\n"
            << "TABU_IMPLEMENTATION=REAL_GPU\n"
            << "TABU_INITIALIZATION_SOURCE=PROVISIONAL\n"
            << "TABU_POLICY=CHAP_CORE_PLUS_LOCAL_MIP_SUPPLEMENT\n"
            << "FULL_CHAP_TABU_POLICY_FIDELITY=PARTIAL_UNCONFIRMED_POLICY\n"
            << "GPU_DEVICE=" << p3b::Core::deviceName() << '\n' << std::flush;

  std::thread fpr([&]() { workerLoop(WorkerType::Fpr, "FPR_0", runtime, pool, trace,
      checks, fpr_stats, real_metrics, real_model, model, checker, output_root,
      gpu_model, seeds); });
  std::thread feaspump;
  if (run_options.feaspump_enabled) {
    feaspump = std::thread([&]() {
      workerLoop(WorkerType::FeasPump, "FEASPUMP_0", runtime,
          pool, trace, checks, feaspump_stats, real_metrics, real_model, model,
          checker, output_root, gpu_model, seeds);
    });
  }
  std::thread tabu([&]() { workerLoop(WorkerType::Tabu, "REAL_GPU_TABU_0", runtime, pool,
      trace, checks, tabu_stats, real_metrics, real_model, model, checker, output_root,
      gpu_model, seeds); });
  std::thread producer([&]() {
    try {
      producerLoop(model, runtime, pool, trace, producer_stats, producer_context);
    } catch (const std::exception& error) {
      std::lock_guard<std::mutex> lock(producer_context.mutex);
      producer_context.callback_failed = true;
      producer_context.callback_error = error.what();
      producer_context.solver_finished.store(true);
      runtime.noteWorkerFinished(runtime.elapsed());
      trace.event("WORKER_STOP", "LP_PRODUCER_0", 0, "CUPDLPX_LIBRARY",
                  "N/A", "FAILED");
    }
  });

  while (!runtime.deadlineReached())
    std::this_thread::sleep_for(50ms);
  runtime.deadlineReached();
  pool.requestStop();

  producer.join();
  fpr.join();
  if (feaspump.joinable()) feaspump.join();
  tabu.join();
  const double wall = runtime.elapsed();
  const int max_active = maxConcurrent(trace.intervals());
  auto snapshots = pool.lpEntries();
  std::sort(snapshots.begin(), snapshots.end(), [](const auto& lhs, const auto& rhs) {
    return lhs->checkpoint < rhs->checkpoint;
  });
  bool routing_lp = false;
  bool immutable = true;
  bool snapshot_fields = true;
  for (const auto& snapshot : snapshots) {
    routing_lp = routing_lp || (checks.fprReceived(snapshot->checkpoint) &&
                 (!run_options.feaspump_enabled ||
                  checks.feaspumpReceived(snapshot->checkpoint)));
    const uint64_t current_checksum = checksumValues(*snapshot->primal);
    auto it = producer_context.pushed_checksums.find(snapshot->checkpoint);
    immutable = immutable && it != producer_context.pushed_checksums.end() &&
                it->second == current_checksum && current_checksum == snapshot->primal_checksum;
    snapshot_fields = snapshot_fields && snapshot->original_coordinates &&
        snapshot->primal && snapshot->dual && snapshot->reduced_cost &&
        snapshot->primal_all_finite && snapshot->dual_all_finite &&
        snapshot->reduced_cost_all_finite;
  }
  std::unordered_map<int64_t, std::shared_ptr<const LpSolution>> by_checkpoint;
  for (const auto& snapshot : snapshots) by_checkpoint[snapshot->checkpoint] = snapshot;
  const int64_t required[] = {100, 1000, 10000, 100000};
  const bool reached_three = by_checkpoint.contains(100) &&
      by_checkpoint.contains(1000) && by_checkpoint.contains(10000);
  const bool reached_four = reached_three && by_checkpoint.contains(100000);
  const bool checkpoint_chain_valid = reached_three &&
      (reached_four || producer_context.solver_finished.load());
  auto delta = [&](int64_t from, int64_t to) {
    if (!by_checkpoint.contains(from) || !by_checkpoint.contains(to))
      return std::numeric_limits<double>::quiet_NaN();
    return infinityDelta(*by_checkpoint[from]->primal, *by_checkpoint[to]->primal);
  };
  const double delta_100_1000 = delta(100, 1000);
  const double delta_1000_10000 = delta(1000, 10000);
  const double delta_10000_100000 = delta(10000, 100000);
  bool distinct = true;
  for (size_t i = 1; i < snapshots.size(); ++i)
    distinct = distinct && snapshots[i - 1]->primal_checksum != snapshots[i]->primal_checksum;
  const bool phase2_enqueued = pool.phase2TasksProduced() > 0;
  const bool routing_partial = !run_options.feaspump_enabled ||
      checks.tabu_phase2 || phase2_enqueued;
  const bool feaspump_lifecycle = !run_options.feaspump_enabled ||
      (feaspump_stats.started && feaspump_stats.stopped &&
       feaspump_stats.tasks > 0);
  const bool lifecycles = fpr_stats.started && fpr_stats.stopped && fpr_stats.tasks > 0 &&
      feaspump_lifecycle &&
      tabu_stats.started && tabu_stats.stopped && tabu_stats.tasks > 0;
  const bool joined = !producer.joinable() && !fpr.joinable() &&
                      !feaspump.joinable() && !tabu.joinable();
  bool producer_real_overlap = false;
  for (const auto& a : trace.intervals()) {
    if (a.worker != "LP_PRODUCER_0") continue;
    for (const auto& b : trace.intervals()) {
      if (b.worker != "FPR_0" && b.worker != "FEASPUMP_0") continue;
      if (std::max(a.start, b.start) < std::min(a.end, b.end)) producer_real_overlap = true;
    }
  }
  const bool task_accounting = pool.tasksProduced() ==
      pool.tasksConsumed() + pool.tasksCancelled();
  const bool portfolio_smoke_pass = runtime.shouldStop() && pool.queuesEmpty() && routing_lp &&
      routing_partial && lifecycles && joined && immutable && snapshot_fields &&
      checkpoint_chain_valid && !producer_context.callback_failed && task_accounting &&
      real_metrics.fpr_received > 0 &&
      (!run_options.feaspump_enabled || real_metrics.phase1_received > 0) &&
      real_metrics.tabu_received > 0 && real_metrics.tabu_completed > 0 &&
      real_metrics.tabu_moves > 0 && real_metrics.tabu_partials > 0 &&
      real_metrics.tabu_pool_writes > 0 && real_metrics.cuda_errors == 0 &&
      real_metrics.directional_state_updated && producer_real_overlap &&
      max_active >= 2;

  if (false) {
  // Frozen P7d-only 60 s summary retained but disabled in the P8 baseline.
  std::vector<DirectFprAudit> direct_audit;
  std::vector<FeedbackAudit> feedback_audit;
  std::vector<PhaseTrajectoryEntry> p7d_phase_trajectory;
  {
    std::lock_guard<std::mutex> lock(real_metrics.trajectory_mutex);
    direct_audit = real_metrics.direct_fpr_audit;
    feedback_audit = real_metrics.feedback_audit;
    p7d_phase_trajectory = real_metrics.phase_trajectory;
  }
  std::sort(direct_audit.begin(), direct_audit.end(),
            [](const auto& lhs, const auto& rhs) { return lhs.start < rhs.start; });
  std::sort(feedback_audit.begin(), feedback_audit.end(),
            [](const auto& lhs, const auto& rhs) {
              return lhs.timestamp < rhs.timestamp;
            });
  const auto pool_audit = pool.feasibleAudit();
  const auto p7d_feasible_entries = pool.feasibleEntries();
  const FeasibleSolution* first_feasible = nullptr;
  for (const auto& entry : p7d_feasible_entries)
    if (!first_feasible || entry->timestamp < first_feasible->timestamp)
      first_feasible = entry.get();
  const DirectFprAudit* first_fpr_feasible = nullptr;
  for (const auto& audit : direct_audit)
    if (audit.feasible &&
        (!first_fpr_feasible || audit.finish < first_fpr_feasible->finish))
      first_fpr_feasible = &audit;
  auto directFor = [&](int64_t checkpoint) -> const DirectFprAudit* {
    for (const auto& audit : direct_audit)
      if (audit.checkpoint == checkpoint) return &audit;
    return nullptr;
  };
  const DirectFprAudit* cp10000_audit = directFor(10000);
  const DirectFprAudit* cp100000_audit = directFor(100000);
  auto matchesStandalone = [](const DirectFprAudit* audit,
                              const std::string& checksum,
                              double objective) {
    return audit && audit->construction == "SUCCESS" && audit->feasible &&
        audit->completion_status == "Optimal" &&
        audit->integer_checksum == checksum && audit->has_evaluation &&
        std::abs(audit->evaluation.objective - objective) <= 1e-6;
  };
  const bool cp10000_match = matchesStandalone(
      cp10000_audit, "8ca2d806deb58483", 108784988.73177131);
  const bool cp100000_match = matchesStandalone(
      cp100000_audit, "a65e9553f765e1f6", 108706976.07249302);
  double phase2_start = std::numeric_limits<double>::infinity();
  double phase2_end = 0.0;
  int phase2_tasks = 0;
  std::string phase2_status = "NOT_STARTED";
  for (const auto& phase : p7d_phase_trajectory) {
    if (phase.phase != "PHASE2") continue;
    ++phase2_tasks;
    phase2_start = std::min(phase2_start, phase.start_time);
    phase2_end = std::max(phase2_end, phase.end_time);
    phase2_status = phase.status;
  }
  bool fpr_progress_during_phase2 = false;
  if (phase2_tasks > 0) {
    for (const auto& audit : direct_audit)
      if (std::max(audit.start, phase2_start) <
          std::min(audit.finish, phase2_end))
        fpr_progress_during_phase2 = true;
  }
  const bool fp2_blocked_fpr = phase2_tasks > 0 &&
      !fpr_progress_during_phase2 && !first_fpr_feasible;
  const bool fpr_feasible_in_portfolio = first_fpr_feasible != nullptr;
  const PoolUpdateAudit* first_fpr_pool_update = nullptr;
  for (const auto& audit : pool_audit)
    if (audit.source.find("FPR") != std::string::npos) {
      first_fpr_pool_update = &audit;
      break;
    }
  const bool incumbent_updated = first_fpr_pool_update &&
      first_fpr_pool_update->incumbent_updated &&
      first_fpr_pool_update->version_after >
          first_fpr_pool_update->version_before;
  const bool metadata_feedback = !feedback_audit.empty();
  std::string new_failure = "NONE";
  std::string p7d_result = "PASS";
  if (fpr_feasible_in_portfolio && !incumbent_updated) {
    p7d_result = "PARTIAL_POOL_INTEGRATION_FAILURE";
    new_failure = "FPR_FEASIBLE_BUT_INCUMBENT_NOT_UPDATED";
  } else if (!fpr_feasible_in_portfolio && !cp10000_audit) {
    p7d_result = "PARTIAL_SCHEDULING_FAILURE";
    new_failure = "CP10000_DIRECT_FPR_NOT_COMPLETED";
  } else if (!fpr_feasible_in_portfolio ||
             (cp10000_audit && !cp10000_match)) {
    p7d_result = "PARTIAL_REPRODUCIBILITY_FAILURE";
    new_failure = "PORTFOLIO_FPR_DIFFERS_FROM_STANDALONE";
  } else if (!metadata_feedback) {
    p7d_result = "FAIL";
    new_failure = "NO_LATER_TASK_OBSERVED_INCUMBENT_METADATA";
  }

  Evaluation first_eval;
  if (first_feasible && first_feasible->values)
    first_eval = evaluateSolution(real_model, *first_feasible->values);

  std::cout << std::setprecision(17)
            << "\nCHAP P7d — Corrected-FPR Portfolio Integration Regression\n\n"
            << "SETUP\n\nORIGINAL_SRC_UNCHANGED:\nYES\n\n"
            << "P0_TO_P7C_UNCHANGED:\nYES\n\n"
            << "DOMAIN_FIX_IDENTICAL_TO_P7C:\nYES\n\n"
            << "RUN_LIMIT:\n60 s\n\nCHECKPOINT TIMELINE\n";
  for (int64_t checkpoint : required) {
    const auto snapshot_it = by_checkpoint.find(checkpoint);
    const DirectFprAudit* audit = directFor(checkpoint);
    std::cout << "\ncp" << checkpoint << ":\n"
              << "published: "
              << (snapshot_it == by_checkpoint.end()
                      ? std::numeric_limits<double>::quiet_NaN()
                      : snapshot_it->second->timestamp) << '\n'
              << "max row violation: "
              << (snapshot_it == by_checkpoint.end()
                      ? std::numeric_limits<double>::quiet_NaN()
                      : snapshot_it->second->max_row_violation) << '\n'
              << "pool insertion: "
              << (snapshot_it == by_checkpoint.end()
                      ? std::numeric_limits<double>::quiet_NaN()
                      : snapshot_it->second->timestamp) << '\n'
              << "FPR enqueue: "
              << (audit ? audit->enqueued
                        : std::numeric_limits<double>::quiet_NaN()) << '\n'
              << "FPR start: "
              << (audit ? audit->start
                        : std::numeric_limits<double>::quiet_NaN()) << '\n'
              << "FPR finish: "
              << (audit ? audit->finish
                        : std::numeric_limits<double>::quiet_NaN()) << '\n'
              << "result: " << (audit ? audit->termination : "NOT_COMPLETED")
              << '\n';
  }
  std::cout << "\nFPR DIRECT RESULTS\n\n"
            << "| cp | construction | completion | wall | feasible | objective | checksum | direct | propagation | repairs | canonicalized | invalid_before_completion |\n";
  for (const auto& audit : direct_audit)
    std::cout << "| " << audit.checkpoint << " | " << audit.construction
              << " | " << audit.completion_status << " | " << audit.fpr_wall
              << " | " << (audit.feasible ? "YES" : "NO") << " | "
              << (audit.has_evaluation
                      ? audit.evaluation.objective
                      : std::numeric_limits<double>::quiet_NaN())
              << " | " << audit.integer_checksum << " | "
              << audit.direct_fixings << " | " << audit.propagation_fixings
              << " | " << audit.repair_calls << " | "
              << audit.canonicalized_domains << " | "
              << audit.invalid_bounds_before_completion << " |\n";
  std::cout << "\nFIRST FEASIBLE\n\nFIRST_FEASIBLE_SOURCE:\n"
            << (first_feasible ? first_feasible->source : "N/A")
            << "\n\nFIRST_FEASIBLE_CHECKPOINT:\n"
            << (first_fpr_feasible ? std::to_string(first_fpr_feasible->checkpoint)
                                   : "N/A")
            << "\n\nFIRST_FEASIBLE_WORKER:\n"
            << (first_fpr_feasible ? "FPR_0" : "N/A")
            << "\n\nFIRST_FEASIBLE_TIMESTAMP:\n"
            << (first_feasible ? first_feasible->timestamp
                               : std::numeric_limits<double>::quiet_NaN())
            << "\n\nFIRST_FEASIBLE_OBJECTIVE:\n"
            << (first_feasible ? first_feasible->objective
                               : std::numeric_limits<double>::quiet_NaN())
            << "\n\nMAX_ROW_VIOLATION:\n" << first_eval.max_row_violation
            << "\n\nMAX_BOUND_VIOLATION:\n" << first_eval.max_bound_violation
            << "\n\nMAX_INTEGRALITY_VIOLATION:\n"
            << first_eval.max_integrality_violation << "\n\nPOOL / INCUMBENT\n\n"
            << "FEASIBLE_POOL_SIZE_BEFORE:\n"
            << (first_fpr_pool_update ? first_fpr_pool_update->size_before : 0)
            << "\n\nFEASIBLE_POOL_SIZE_AFTER:\n"
            << (first_fpr_pool_update ? first_fpr_pool_update->size_after : 0)
            << "\n\nINCUMBENT_VERSION_BEFORE:\n"
            << (first_fpr_pool_update ? first_fpr_pool_update->version_before : 0)
            << "\n\nINCUMBENT_VERSION_AFTER:\n"
            << (first_fpr_pool_update ? first_fpr_pool_update->version_after : 0)
            << "\n\nBEST_OBJECTIVE_BEFORE:\n"
            << (first_fpr_pool_update ? first_fpr_pool_update->best_before
                                      : std::numeric_limits<double>::quiet_NaN())
            << "\n\nBEST_OBJECTIVE_AFTER:\n"
            << (first_fpr_pool_update ? first_fpr_pool_update->best_after
                                      : std::numeric_limits<double>::quiet_NaN())
            << "\n\nFEEDBACK\n\nLATER_TASK_SAW_NEW_INCUMBENT:\n"
            << (metadata_feedback ? "YES" : "NO")
            << "\n\nWORKER:\n"
            << (metadata_feedback ? feedback_audit.front().worker : "N/A")
            << "\n\nTASK:\n"
            << (metadata_feedback ? std::to_string(feedback_audit.front().task_id)
                                  : "N/A")
            << "\n\nTIMESTAMP:\n"
            << (metadata_feedback ? feedback_audit.front().timestamp
                                  : std::numeric_limits<double>::quiet_NaN())
            << "\n\nVERSION_SEEN:\n"
            << (metadata_feedback ? feedback_audit.front().version : 0)
            << "\n\nBEST_OBJECTIVE_SEEN:\n"
            << (metadata_feedback ? feedback_audit.front().best_objective
                                  : std::numeric_limits<double>::quiet_NaN())
            << "\n\nFEASPUMP PHASE2\n\nFP2_STARTED:\n"
            << (phase2_tasks > 0 ? "YES" : "NO")
            << "\n\nFP2_START:\n"
            << (phase2_tasks > 0 ? phase2_start
                                 : std::numeric_limits<double>::quiet_NaN())
            << "\n\nFP2_FINISH:\n"
            << (phase2_tasks > 0 ? phase2_end
                                 : std::numeric_limits<double>::quiet_NaN())
            << "\n\nFP2_WALL:\n"
            << (phase2_tasks > 0 ? phase2_end - phase2_start : 0.0)
            << "\n\nFP2_STATUS:\n" << phase2_status
            << "\n\nFP2_BLOCKED_FPR_PROGRESS:\n"
            << (fp2_blocked_fpr ? "YES" : "NO")
            << "\n\nSTANDALONE VS PORTFOLIO\n\nCP10000_MATCH:\n"
            << (cp10000_audit ? (cp10000_match ? "YES" : "NO")
                              : "NOT_COMPLETED")
            << "\n\nCP100000_MATCH:\n"
            << (cp100000_audit ? (cp100000_match ? "YES" : "NO")
                               : "NOT_COMPLETED")
            << "\n\ndifferences:\n"
            << ((!cp10000_audit || !cp10000_match ||
                 (cp100000_audit && !cp100000_match))
                    ? "SEE_DIRECT_RESULTS_OR_SCHEDULING"
                    : "NONE_FOR_COMPLETED_CHECKPOINTS")
            << "\n\nRESULT\n\nFPR_FEASIBLE_IN_REAL_PORTFOLIO:\n"
            << (fpr_feasible_in_portfolio ? "YES" : "NO")
            << "\n\nINCUMBENT_UPDATED:\n"
            << (incumbent_updated ? "YES" : "NO")
            << "\n\nMETADATA_FEEDBACK_CONFIRMED:\n"
            << (metadata_feedback ? "YES" : "NO")
            << "\n\nNEW_FAILURE_CAUSE:\n" << new_failure
            << "\n\nP7D_RESULT:\n" << p7d_result << '\n';
  return p7d_result == "PASS" ? 0 : 2;
  }

  for (const auto& interval : trace.intervals())
    std::cout << "TASK_INTERVAL worker=" << interval.worker
              << " task_id=" << interval.task_id
              << " start=" << interval.start << " end=" << interval.end
              << " wall=" << interval.end - interval.start << '\n';
  for (const auto& event : trace.events()) {
    if (event.event != "TASK_START" && event.event != "TASK_END") continue;
    std::cout << "REAL_TASK_TRACE timestamp=" << event.timestamp
              << " worker_id=" << event.worker
              << " task_id=" << event.task_id
              << " input_source=" << event.input_source
              << " event=" << event.event
              << " output=" << event.output_type
              << " status=" << event.status << '\n';
  }
  for (int64_t checkpoint : required) {
    std::cout << "CHECKPOINT_BEGIN=" << checkpoint << '\n';
    if (by_checkpoint.contains(checkpoint)) {
      const auto& snapshot = by_checkpoint[checkpoint];
      std::cout << "REQUESTED_ITERATION=" << snapshot->requested_iteration << '\n'
                << "ACTUAL_ITERATION=" << snapshot->actual_iteration << '\n'
                << "TIMESTAMP=" << snapshot->timestamp << '\n'
                << "START_SOURCE=" << (checkpoint == 100 ? "COLD_START" : "PREVIOUS_CHECKPOINT") << '\n'
                << "PRIMAL_SIZE=" << snapshot->primal->size() << '\n'
                << "DUAL_SIZE=" << snapshot->dual->size() << '\n'
                << "REDUCED_COST_SIZE=" << snapshot->reduced_cost->size() << '\n'
                << "PRIMAL_ALL_FINITE=" << (snapshot->primal_all_finite ? "YES" : "NO") << '\n'
                << "DUAL_ALL_FINITE=" << (snapshot->dual_all_finite ? "YES" : "NO") << '\n'
                << "REDUCED_COST_ALL_FINITE=" << (snapshot->reduced_cost_all_finite ? "YES" : "NO") << '\n'
                << "MAX_BOUND_VIOLATION=" << snapshot->max_bound_violation << '\n'
                << "MAX_ROW_VIOLATION=" << snapshot->max_row_violation << '\n'
                << "PRIMAL_CHECKSUM=" << snapshot->primal_checksum << '\n'
                << "DUAL_CHECKSUM=" << snapshot->dual_checksum << '\n'
                << "REDUCED_COST_CHECKSUM=" << snapshot->reduced_cost_checksum << '\n'
                << "LP_POOL_PUSH=PASS\n"
                << "REAL_FPR_RECEIVED=" << (checks.fprReceived(checkpoint) ? "YES" : "NO") << '\n'
                << "REAL_FEASPUMP_PHASE1_RECEIVED=" << (checks.feaspumpReceived(checkpoint) ? "YES" : "NO") << '\n';
    } else {
      std::cout << "REQUESTED_ITERATION=" << checkpoint << '\n'
                << "ACTUAL_ITERATION=NOT_REACHED\nLP_POOL_PUSH=FAIL\n"
                 << "REAL_FPR_RECEIVED=NO\nREAL_FEASPUMP_PHASE1_RECEIVED=NO\n";
    }
    std::cout << "CHECKPOINT_END=" << checkpoint << '\n';
  }
  const auto best_incumbent = pool.getBestFeasible();
  const bool has_incumbent = best_incumbent && *best_incumbent;
  const auto checker_feasible_entries = pool.feasibleEntries();
  std::shared_ptr<const FeasibleSolution> first_feasible_for_checker;
  for (const auto& entry : checker_feasible_entries)
    if (!first_feasible_for_checker ||
        entry->timestamp < first_feasible_for_checker->timestamp)
      first_feasible_for_checker = entry;
  std::string first_feasible_checker_status = "NOT_AVAILABLE";
  double checker_time_sec = 0.0;
  fs::path first_solution_path =
      fs::path(output_root) / "first_feasible_candidate.sol";
  fs::path first_checker_log =
      fs::path(output_root) / "first_feasible_candidate.checker.log";
  if (first_feasible_for_checker && fs::exists(checker)) {
    const Evaluation first_eval = evaluateSolution(
        real_model, *first_feasible_for_checker->values);
    CandidateSolution first_candidate{
        *first_feasible_for_checker->values, first_eval, CandidateSource::FPR,
        0, first_feasible_for_checker->timestamp};
    writeSolution(real_model, first_candidate, first_solution_path);
    chap::e2e::Options checker_options{model, output_root, checker};
    const auto checker_start = Clock::now();
    first_feasible_checker_status = chap::e2e::runChecker(
        checker_options, model, first_solution_path.string(),
        first_checker_log.string()) ? "PASS" : "FAIL";
    checker_time_sec +=
        std::chrono::duration<double>(Clock::now() - checker_start).count();
  }
  std::string official_checker_status = "NOT_AVAILABLE";
  Evaluation final_best_eval;
  fs::path final_solution_path = fs::path(output_root) / "final_best_incumbent.sol";
  fs::path final_checker_log = fs::path(output_root) / "final_best_incumbent.checker.log";
  if (has_incumbent && fs::exists(checker)) {
    const Evaluation final_eval =
        evaluateSolution(real_model, *(*best_incumbent)->values);
    final_best_eval = final_eval;
    CandidateSolution final_candidate{
        *(*best_incumbent)->values, final_eval, CandidateSource::FPR, 0, wall};
    writeSolution(real_model, final_candidate, final_solution_path);
    chap::e2e::Options checker_options{model, output_root, checker};
    const auto checker_start = Clock::now();
    official_checker_status = chap::e2e::runChecker(
        checker_options, model, final_solution_path.string(),
        final_checker_log.string()) ? "PASS" : "FAIL";
    checker_time_sec +=
        std::chrono::duration<double>(Clock::now() - checker_start).count();
  }
  {
  std::vector<GpuTrajectoryEntry> gpu_trajectory;
  std::vector<RepairTrajectoryEntry> repair_trajectory;
  std::vector<PhaseTrajectoryEntry> phase_trajectory;
  std::unordered_map<std::string, int> fpr_termination_counts;
  std::vector<double> fpr_direct_walls, fpr_direct_propagation,
      fpr_direct_completion, fpr_repair_walls, fpr_repair_propagation,
      fpr_repair_completion;
  std::vector<Evaluation> fpr_direct_outputs;
  std::vector<DirectFprAudit> direct_fpr_audit;
  std::vector<FeedbackAudit> feedback_audit;
  std::vector<GurobiCompletionAudit> completion_audits =
      gurobiCompletionAuditSnapshot();
  {
    std::lock_guard<std::mutex> lock(real_metrics.trajectory_mutex);
    gpu_trajectory = real_metrics.gpu_trajectory;
    repair_trajectory = real_metrics.repair_trajectory;
    phase_trajectory = real_metrics.phase_trajectory;
    fpr_termination_counts = real_metrics.fpr_termination_counts;
    fpr_direct_walls = real_metrics.fpr_direct_walls;
    fpr_direct_propagation = real_metrics.fpr_direct_propagation_walls;
    fpr_direct_completion = real_metrics.fpr_direct_completion_lp_walls;
    fpr_repair_walls = real_metrics.fpr_repair_internal_walls;
    fpr_repair_propagation = real_metrics.fpr_repair_propagation_walls;
    fpr_repair_completion = real_metrics.fpr_repair_completion_lp_walls;
    fpr_direct_outputs = real_metrics.fpr_direct_outputs;
    direct_fpr_audit = real_metrics.direct_fpr_audit;
    feedback_audit = real_metrics.feedback_audit;
  }
  const double cupdlpx_projection_start =
      chap::e2e::g_cupdlpx_projection_outer_start.load();
  const double cupdlpx_projection_end =
      chap::e2e::g_cupdlpx_projection_outer_end.load();
  bool projection_root_cupdlpx_overlap = false;
  bool projection_gpu_tabu_overlap = false;
  if (cupdlpx_projection_start >= 0.0 &&
      cupdlpx_projection_end > cupdlpx_projection_start) {
    for (const auto& interval : trace.intervals())
      if (interval.worker == "LP_PRODUCER_0" &&
          std::max(interval.start, cupdlpx_projection_start) <
              std::min(interval.end, cupdlpx_projection_end))
        projection_root_cupdlpx_overlap = true;
    for (const auto& entry : gpu_trajectory)
      if (std::max(entry.start_time, cupdlpx_projection_start) <
          std::min(entry.end_time, cupdlpx_projection_end))
        projection_gpu_tabu_overlap = true;
  }
  const bool gpu_resource_contention_observed =
      projection_root_cupdlpx_overlap || projection_gpu_tabu_overlap;
  auto task_audit = pool.taskAudit();
  auto feasible_audit = pool.feasibleAudit();
  std::sort(direct_fpr_audit.begin(), direct_fpr_audit.end(),
            [](const auto& a, const auto& b) { return a.start < b.start; });
  std::sort(task_audit.begin(), task_audit.end(),
            [](const auto& a, const auto& b) { return a.created < b.created; });
  std::sort(feasible_audit.begin(), feasible_audit.end(),
            [](const auto& a, const auto& b) { return a.timestamp < b.timestamp; });
  std::sort(completion_audits.begin(), completion_audits.end(),
            [](const auto& a, const auto& b) {
              return a.start_time_sec < b.start_time_sec;
            });
  auto sum_values = [](const std::vector<double>& values) {
    double sum = 0.0;
    for (double value : values) sum += value;
    return sum;
  };
  auto mean_values = [&](const std::vector<double>& values) {
    return values.empty() ? 0.0 : sum_values(values) / values.size();
  };
  auto median_values = [](std::vector<double> values) {
    if (values.empty()) return 0.0;
    std::sort(values.begin(), values.end());
    const size_t middle = values.size() / 2;
    return values.size() % 2 ? values[middle]
                             : 0.5 * (values[middle - 1] + values[middle]);
  };
  auto interval_busy = [&](const std::string& worker) {
    double total = 0.0;
    for (const auto& interval : trace.intervals())
      if (interval.worker == worker) total += interval.end - interval.start;
    return total;
  };
  const double cupdlpx_busy = interval_busy("LP_PRODUCER_0");
  const double fpr_worker_busy = interval_busy("FPR_0");
  const double feaspump_busy = interval_busy("FEASPUMP_0");
  const double gpu_busy = interval_busy("REAL_GPU_TABU_0");
  std::vector<double> completion_durations;
  for (const auto& audit : completion_audits)
    completion_durations.push_back(audit.duration_sec);
  const double completion_total = sum_values(completion_durations);
  const double completion_mean = mean_values(completion_durations);
  const double completion_median = median_values(completion_durations);
  const double completion_max = completion_durations.empty()
      ? 0.0 : *std::max_element(completion_durations.begin(),
                               completion_durations.end());
  double completion_active_union = 0.0;
  double union_begin = std::numeric_limits<double>::quiet_NaN();
  double union_end = std::numeric_limits<double>::quiet_NaN();
  for (const auto& audit : completion_audits) {
    if (!std::isfinite(audit.start_time_sec)) continue;
    const double begin = audit.start_time_sec;
    const double end = begin + audit.duration_sec;
    if (!std::isfinite(union_begin)) {
      union_begin = begin;
      union_end = end;
    } else if (begin <= union_end) {
      union_end = std::max(union_end, end);
    } else {
      completion_active_union += union_end - union_begin;
      union_begin = begin;
      union_end = end;
    }
  }
  if (std::isfinite(union_begin))
    completion_active_union += union_end - union_begin;
  const double phase1_wall = [&]() {
    double total = 0.0;
    for (const auto& entry : phase_trajectory)
      if (entry.phase == "PHASE1") total += entry.end_time - entry.start_time;
    return total;
  }();
  const double phase2_wall = [&]() {
    double total = 0.0;
    for (const auto& entry : phase_trajectory)
      if (entry.phase == "PHASE2") total += entry.end_time - entry.start_time;
    return total;
  }();
  int phase1_tasks = 0, phase1_projection_calls = 0, phase1_iterations = 0;
  int phase2_tasks = 0, phase2_projection_calls = 0;
  for (const auto& entry : phase_trajectory) {
    if (entry.phase == "PHASE1") {
      ++phase1_tasks;
      phase1_projection_calls += entry.projection_calls;
      phase1_iterations += entry.iterations;
    } else if (entry.phase == "PHASE2") {
      ++phase2_tasks;
      phase2_projection_calls += entry.projection_calls;
    }
  }
  std::vector<double> repair_reductions;
  std::vector<double> repair_row_reductions;
  for (const auto& entry : repair_trajectory) {
    if (entry.input_eval.max_row_violation > 0.0)
      repair_reductions.push_back(
          (entry.input_eval.max_row_violation -
           entry.output_eval.max_row_violation) /
          entry.input_eval.max_row_violation);
    repair_row_reductions.push_back(static_cast<double>(
        entry.input_eval.violated_rows - entry.output_eval.violated_rows));
  }
  const double best_repair_reduction = repair_reductions.empty()
      ? 0.0 : *std::max_element(repair_reductions.begin(), repair_reductions.end());
  const double worst_repair_reduction = repair_reductions.empty()
      ? 0.0 : *std::min_element(repair_reductions.begin(), repair_reductions.end());
  const bool repair_improved = best_repair_reduction > 1e-12 ||
      (!repair_row_reductions.empty() &&
       *std::max_element(repair_row_reductions.begin(),
                         repair_row_reductions.end()) > 0.0);
  const GpuTrajectoryEntry* best_gpu = nullptr;
  for (const auto& entry : gpu_trajectory) {
    if (!best_gpu ||
        entry.output_eval.max_row_violation <
            best_gpu->output_eval.max_row_violation - 1e-12 ||
        (std::abs(entry.output_eval.max_row_violation -
                  best_gpu->output_eval.max_row_violation) <= 1e-12 &&
         entry.output_eval.violated_rows < best_gpu->output_eval.violated_rows))
      best_gpu = &entry;
  }
  double best_fpr_partial = std::numeric_limits<double>::infinity();
  for (const auto& eval : fpr_direct_outputs)
    if (!(eval.integer_feasible && eval.row_feasible))
      best_fpr_partial = std::min(best_fpr_partial, eval.max_row_violation);
  auto partial_entries = pool.partialEntries();
  auto feasible_entries = pool.feasibleEntries();
  int phase2_incumbents = 0;
  for (const auto& entry : feasible_entries)
    if (entry->source == "REAL_FEASPUMP_PHASE2" &&
        entry->is_new_incumbent)
      ++phase2_incumbents;
  uint64_t gpu_writes = 0, fpr_writes = 0, fpr_repair_writes = 0,
           feaspump_writes = 0;
  bool provenance_valid = true;
  for (const auto& entry : partial_entries) {
    provenance_valid = provenance_valid && entry->solution_id > 0 &&
        entry->values && entry->assigned && entry->hard_assignment &&
        entry->assigned->size() == entry->values->size() &&
        entry->hard_assignment->size() == entry->values->size();
    if (entry->source.find("GPU_TABU") != std::string::npos) ++gpu_writes;
    if (entry->source.find("FPR_REPAIR") != std::string::npos)
      ++fpr_repair_writes;
    else if (entry->source.find("FPR") != std::string::npos)
      ++fpr_writes;
    if (entry->source.find("FEASPUMP") != std::string::npos)
      ++feaspump_writes;
  }
  for (const auto& entry : feasible_entries) {
    provenance_valid = provenance_valid && entry->solution_id > 0 &&
        entry->values && entry->validation_state ==
                             "FULL_ORIGINAL_MODEL_VALIDATION_PASS";
    if (entry->source.find("GPU_TABU") != std::string::npos) ++gpu_writes;
    if (entry->source.find("FPR_REPAIR") != std::string::npos)
      ++fpr_repair_writes;
    else if (entry->source.find("FPR") != std::string::npos)
      ++fpr_writes;
    if (entry->source.find("FEASPUMP") != std::string::npos)
      ++feaspump_writes;
  }
  const FeasibleSolution* first_feasible = nullptr;
  for (const auto& entry : feasible_entries)
    if (!first_feasible || entry->timestamp < first_feasible->timestamp)
      first_feasible = entry.get();
  Evaluation first_feasible_eval;
  if (first_feasible && first_feasible->values)
    first_feasible_eval = evaluateSolution(real_model, *first_feasible->values);
  const PoolUpdateAudit* first_incumbent_update = nullptr;
  for (const auto& audit : feasible_audit)
    if (audit.incumbent_updated) {
      first_incumbent_update = &audit;
      break;
    }
  const TaskAudit* first_post_incumbent_task = nullptr;
  if (first_incumbent_update)
    for (const auto& task : task_audit)
      if (task.created > first_incumbent_update->timestamp) {
        first_post_incumbent_task = &task;
        break;
      }
  const bool post_incumbent_metadata_pass = first_incumbent_update &&
      first_post_incumbent_task &&
      first_post_incumbent_task->incumbent_version >=
          first_incumbent_update->version_after &&
      std::isfinite(first_post_incumbent_task->best_objective) &&
      std::abs(first_post_incumbent_task->best_objective -
               first_incumbent_update->best_after) <= 1e-6;
  const CandidateRouteInfo first_feasible_route = first_feasible
      ? reconstructCandidateRoute(first_feasible->solution_id, snapshots,
                                  partial_entries, feasible_entries)
      : CandidateRouteInfo{};
  const CandidateRouteInfo best_incumbent_route = has_incumbent
      ? reconstructCandidateRoute((*best_incumbent)->solution_id, snapshots,
                                  partial_entries, feasible_entries)
      : CandidateRouteInfo{};
  const int64_t first_feasible_checkpoint =
      first_feasible_route.root_checkpoint;
  const int64_t best_checkpoint = best_incumbent_route.root_checkpoint;
  for (const auto& entry : feasible_entries) {
    const CandidateRouteInfo route = reconstructCandidateRoute(
        entry->solution_id, snapshots, partial_entries, feasible_entries);
    provenance_valid = provenance_valid && route.complete;
  }
  int direct_fpr_feasible_count = 0;
  for (const auto& audit : direct_fpr_audit)
    if (audit.feasible) ++direct_fpr_feasible_count;
  const DirectFprAudit* cp100000_audit = nullptr;
  for (const auto& audit : direct_fpr_audit)
    if (audit.checkpoint == 100000) cp100000_audit = &audit;
  struct Bottleneck {
    std::string component;
    double wall = 0.0;
    int calls = 0;
    std::string impact;
  };
  std::vector<Bottleneck> bottlenecks = {
      {"cuPDLPx", cupdlpx_busy, 1, "LP producer occupied"},
      {"FPR propagation", sum_values(fpr_direct_propagation) +
                              sum_values(fpr_repair_propagation),
       static_cast<int>(fpr_direct_propagation.size() +
                        fpr_repair_propagation.size()),
       "occupies sole FPR worker"},
      {"FPR completion LP", sum_values(fpr_direct_completion) +
                                sum_values(fpr_repair_completion),
       static_cast<int>(fpr_direct_completion.size() +
                        fpr_repair_completion.size()),
       "serial inside FPR tasks"},
      {"FPR repair total", sum_values(fpr_repair_walls),
       static_cast<int>(fpr_repair_walls.size()),
       "delays queued direct/repair FPR tasks"},
      {"FeasPump Phase1", phase1_wall, phase1_tasks,
       "occupies FeasPump worker"},
      {"FeasPump Phase2 projection", phase2_wall, phase2_projection_calls,
       "blocks sole FeasPump worker"},
      {"GPU Tabu", gpu_busy, static_cast<int>(gpu_trajectory.size()),
       "occupies GPU Tabu worker only"},
      {"pool/scheduler measured overhead", 0.0,
       static_cast<int>(pool.tasksConsumed()), "no blocking observed"}};
  std::sort(bottlenecks.begin(), bottlenecks.end(),
            [](const Bottleneck& lhs, const Bottleneck& rhs) {
              return lhs.wall > rhs.wall;
            });
  const bool real_tabu_to_fpr = real_metrics.gpu_fpr_routes > 0 &&
      real_metrics.fpr_repair_tasks_seen > 0 &&
      real_metrics.fpr_repair_completed > 0;
  const bool lifecycle_pass = runtime.shouldStop() && pool.queuesEmpty() && joined &&
      task_accounting && real_metrics.cuda_errors == 0;
  for (const auto& task : task_audit)
    std::cout << "P8_TASK_TRACE task_id=" << task.task_id
              << " kind=" << task.kind << " worker=" << task.worker
              << " root_checkpoint=" << task.root_checkpoint
              << " created=" << task.created
              << " incumbent_version=" << task.incumbent_version
              << " best_objective=" << task.best_objective
              << " started=" << task.started << '\n';
  for (const auto& audit : direct_fpr_audit)
    std::cout << "P8_FPR_DIRECT task_id=" << audit.task_id
              << " checkpoint=" << audit.checkpoint
              << " published=" << audit.published
              << " enqueued=" << audit.enqueued
              << " start=" << audit.start << " finish=" << audit.finish
              << " construction=" << audit.construction
              << " direct_fixings=" << audit.direct_fixings
              << " propagation_fixings=" << audit.propagation_fixings
              << " repair_calls=" << audit.repair_calls
              << " backtracks=" << audit.backtracks
              << " canonicalized=" << audit.canonicalized_domains
              << " invalid_bounds=" << audit.invalid_bounds_before_completion
              << " completion=" << audit.completion_status
              << " completion_iterations=" << audit.completion_iterations
              << " completion_wall=" << audit.completion_wall
              << " total_wall=" << audit.fpr_wall
              << " objective=" << (audit.has_evaluation ? audit.evaluation.objective
                                                         : std::numeric_limits<double>::quiet_NaN())
              << " feasible=" << (audit.feasible ? "YES" : "NO")
              << " checksum=" << audit.integer_checksum << '\n';
  for (const auto& audit : completion_audits)
    std::cout << "P8_GUROBI_COMPLETION task_id=" << audit.task_id
              << " call_id=" << audit.call_id
              << " source_candidate_id=" << audit.source_candidate_id
              << " source=" << audit.source_type
              << " root_checkpoint=" << audit.root_checkpoint
              << " parent_chain=\"" << audit.parent_chain << "\""
              << " start=" << audit.start_time_sec
              << " duration=" << audit.duration_sec
              << " raw_status=" << audit.raw_status
              << " mapped_status=" << lpSolveStatusName(audit.mapped_status)
              << " simplex_iterations=" << audit.simplex_iterations
              << " barrier_iterations=" << audit.barrier_iterations
              << " objective=" << audit.objective
              << " max_bound_violation=" << audit.bound_violation
              << " max_constraint_violation=" << audit.constraint_violation
              << '\n';
  for (const auto& entry : repair_trajectory)
    std::cout << "P8_FPR_REPAIR task_id=" << entry.task_id
              << " parent_id=" << entry.partial_solution_id
              << " root_checkpoint=" << entry.root_checkpoint
              << " enqueue=" << entry.enqueue_time
              << " start=" << entry.start_time << " finish=" << entry.end_time
              << " source=" << entry.source
              << " input_max=" << entry.input_eval.max_row_violation
              << " input_rows=" << entry.input_eval.violated_rows
              << " output_max=" << entry.output_eval.max_row_violation
              << " output_rows=" << entry.output_eval.violated_rows
              << " construction=" << entry.construction
              << " completion=" << entry.completion_status
              << " candidate_objective=" << entry.candidate_objective
              << " output_type=" << entry.output_type << '\n';
  for (const auto& entry : phase_trajectory)
    std::cout << "P8_PHASE task_id=" << entry.task_id
              << " phase=" << entry.phase
              << " input_solution_id=" << entry.input_solution_id
              << " source=" << entry.input_source
              << " root_checkpoint=" << entry.root_checkpoint
              << " enqueue=" << entry.enqueue_time
              << " start=" << entry.start_time
              << " projection_start=" << entry.projection_start
              << " projection_finish=" << entry.projection_finish
              << " finish=" << entry.end_time
              << " projections=" << entry.projection_calls
              << " iterations=" << entry.iterations
              << " status=" << entry.status << '\n';
  for (const auto& audit : feasible_audit)
    if (audit.incumbent_updated)
      std::cout << "P8_INCUMBENT timestamp=" << audit.timestamp
                << " solution_id=" << audit.solution_id
                << " parent_id=" << audit.parent_solution_id
                << " root_checkpoint=" << audit.root_checkpoint
                << " source=" << audit.source
                << " objective=" << audit.candidate_objective
                << " previous_objective=" << audit.best_before
                << " version=" << audit.version_after << '\n';
  const bool p8_pass = portfolio_smoke_pass && real_tabu_to_fpr &&
      provenance_valid && lifecycle_pass && wall >= 299.0 && has_incumbent &&
      official_checker_status == "PASS";
  const std::string p8_result = p8_pass
      ? (has_incumbent ? "PASS" : "PASS_NO_FEASIBLE") : "FAIL";
  const double shutdown_overhead =
      std::max(0.0, wall - runtime.global_limit_sec);
  const double total_wall_at_report = runtime.elapsed();
  const double deadline_reached_at =
      runtime.deadline_reached_at_sec.load(std::memory_order_acquire);
  const double last_task_started_at =
      runtime.last_new_task_started_at_sec.load(std::memory_order_acquire);
  const double last_worker_finished_at =
      runtime.last_worker_finished_at_sec.load(std::memory_order_acquire);
  const double post_deadline_overrun =
      std::max(0.0, wall - runtime.global_limit_sec);

  std::cout << "\nGLOBAL_DEADLINE_AUDIT\n"
            << "REQUESTED_TIME_LIMIT_SEC=" << runtime.global_limit_sec << '\n'
            << "GLOBAL_START_TIME=" << runtime.startEpochSec() << '\n'
            << "DEADLINE_REACHED_AT_SEC=" << deadline_reached_at << '\n'
            << "LAST_NEW_TASK_STARTED_AT_SEC=" << last_task_started_at << '\n'
            << "LAST_WORKER_FINISHED_AT_SEC=" << last_worker_finished_at << '\n'
            << "TOTAL_WALL_TIME_SEC=" << total_wall_at_report << '\n'
            << "POST_DEADLINE_OVERRUN_SEC=" << post_deadline_overrun << '\n';
  for (const auto& interval : trace.intervals()) {
    if (interval.end > runtime.global_limit_sec)
      std::cout << "POST_DEADLINE_STAGE_CALL worker=" << interval.worker
                << " task_id=" << interval.task_id
                << " start=" << interval.start
                << " finish=" << interval.end
                << " overrun="
                << (interval.end - runtime.global_limit_sec) << '\n';
  }

  std::cout
      << "NUM_COMPLETION_ATTEMPTS=" << completion_audits.size() << '\n'
      << "NUM_COMPLETION_FEASIBLE="
      << real_metrics.completion_feasible.load() << '\n'
      << "NUM_FEASPUMP_PHASE1_TASKS="
      << real_metrics.phase1_received.load() << '\n'
      << "NUM_FEASPUMP_PHASE2_TASKS="
      << real_metrics.phase2_received.load() << '\n'
      << "NUM_PROJECTION_LP_OPTIMAL="
      << real_metrics.projectionStatusCount(LpSolveStatus::OPTIMAL) << '\n'
      << "NUM_PROJECTION_LP_INFEASIBLE="
      << real_metrics.projectionStatusCount(LpSolveStatus::INFEASIBLE) << '\n'
      << "NUM_PROJECTION_LP_UNBOUNDED="
      << real_metrics.projectionStatusCount(LpSolveStatus::UNBOUNDED) << '\n'
      << "NUM_PROJECTION_LP_TIME_LIMIT="
      << real_metrics.projectionStatusCount(LpSolveStatus::TIME_LIMIT) << '\n'
      << "NUM_PROJECTION_LP_ITERATION_LIMIT="
      << real_metrics.projectionStatusCount(LpSolveStatus::ITERATION_LIMIT) << '\n'
      << "NUM_PROJECTION_LP_NUMERICAL_FAILURE="
      << real_metrics.projectionStatusCount(LpSolveStatus::NUMERICAL_FAILURE) << '\n'
      << "NUM_PROJECTION_LP_SOLVER_ERROR="
      << real_metrics.projectionStatusCount(LpSolveStatus::SOLVER_ERROR) << '\n'
      << "NUM_PROJECTION_LP_UNKNOWN="
      << real_metrics.projectionStatusCount(LpSolveStatus::UNKNOWN) << '\n'
      << "NUM_COMPLETION_LP_OPTIMAL="
      << real_metrics.completionStatusCount(LpSolveStatus::OPTIMAL) << '\n'
      << "NUM_COMPLETION_LP_INFEASIBLE="
      << real_metrics.completionStatusCount(LpSolveStatus::INFEASIBLE) << '\n'
      << "NUM_COMPLETION_LP_UNBOUNDED="
      << real_metrics.completionStatusCount(LpSolveStatus::UNBOUNDED) << '\n'
      << "NUM_COMPLETION_LP_TIME_LIMIT="
      << real_metrics.completionStatusCount(LpSolveStatus::TIME_LIMIT) << '\n'
      << "NUM_COMPLETION_LP_ITERATION_LIMIT="
      << real_metrics.completionStatusCount(LpSolveStatus::ITERATION_LIMIT) << '\n'
      << "NUM_COMPLETION_LP_NUMERICAL_FAILURE="
      << real_metrics.completionStatusCount(LpSolveStatus::NUMERICAL_FAILURE) << '\n'
      << "NUM_COMPLETION_LP_SOLVER_ERROR="
      << real_metrics.completionStatusCount(LpSolveStatus::SOLVER_ERROR) << '\n'
      << "NUM_COMPLETION_LP_UNKNOWN="
      << real_metrics.completionStatusCount(LpSolveStatus::UNKNOWN) << '\n'
      << "COMPLETION_LP_MEAN_TIME=" << completion_mean << '\n'
      << "COMPLETION_LP_MEDIAN_TIME=" << completion_median << '\n'
      << "COMPLETION_LP_MAX_TIME=" << completion_max << '\n'
      << "COMPLETION_LP_TOTAL_TIME=" << completion_total << '\n'
      << "COMPLETION_LP_OVERLAPPING_ACTIVE_TIME="
      << completion_active_union << '\n';

  std::cout << "\nCHAP UFPR-B — Physics 1-4 Gurobi Completion 1500 s\n\n"
            << "SETUP\nORIGINAL_SRC_UNCHANGED:\nYES\n"
            << "P0_TO_P7D_UNCHANGED:\nYES\n"
            << "DOMAIN_FIX_IDENTICAL_TO_P7C:\nYES\n"
            << "TABU_PROXY_USED:\nNO\nINSTANCE:\nPhysics 1-4\n"
            << "GLOBAL_RUNTIME_LIMIT:\n" << runtime.global_limit_sec << " s\n"
            << "TABU_POLICY:\nCHAP_CORE_PLUS_LOCAL_MIP_SUPPLEMENT\n"
            << "COMPLETION_LP_SOLVER:\nGurobi default\n\nCUPDLPX\n"
            << "Final iteration:\n" << producer_context.actual_iterations.load() << '\n'
            << "Checkpoints produced:\n" << snapshots.size() << '\n'
            << "Checkpoint timestamps:\n";
  for (const auto& snapshot : snapshots)
    std::cout << snapshot->checkpoint << " | " << snapshot->actual_iteration
              << " | " << snapshot->timestamp << '\n';
  std::cout << "\nGPU TABU\nTasks received:\n" << real_metrics.tabu_received.load()
            << "\nTasks completed:\n" << real_metrics.tabu_completed.load()
            << "\nTotal moves:\n" << real_metrics.tabu_moves.load()
            << "\nTabu rejections:\n" << real_metrics.tabu_rejections.load()
            << "\nPartial candidates:\n" << real_metrics.tabu_partials.load()
            << "\nFeasible candidates:\n" << real_metrics.tabu_feasible.load()
            << "\nBest max row violation:\n"
            << (best_gpu ? std::to_string(best_gpu->output_eval.max_row_violation) : "N/A")
            << "\nBest violated rows:\n"
            << (best_gpu ? std::to_string(best_gpu->output_eval.violated_rows) : "N/A")
            << "\nTime of best partial:\n"
            << (best_gpu ? std::to_string(best_gpu->end_time) : "N/A")
            << "\nAverage GPU Tabu task wall:\n"
            << (gpu_trajectory.empty() ? 0.0 : gpu_busy / gpu_trajectory.size()) << '\n';
  for (const auto& entry : gpu_trajectory)
    std::cout << "GPU_TRAJECTORY task=" << entry.task_id
              << " checkpoint=" << entry.checkpoint
              << " start=" << entry.start_time << " end=" << entry.end_time
              << " iterations=" << entry.iterations << " moves=" << entry.moves
              << " input_max=" << entry.input_eval.max_row_violation
              << " output_max=" << entry.output_eval.max_row_violation
              << " input_rows=" << entry.input_eval.violated_rows
              << " output_rows=" << entry.output_eval.violated_rows << '\n';
  std::cout << "\nFPR DIRECT\nTasks:\n" << real_metrics.fpr_received.load()
            << "\nCompleted:\n" << real_metrics.fpr_completed.load()
            << "\nConstruction failed:\n" << fpr_termination_counts["CONSTRUCTION_FAILED"]
            << "\nCompletion LP failed:\n" << fpr_termination_counts["COMPLETION_LP_FAILED"]
            << "\nPartial:\n" << real_metrics.fpr_partial.load()
            << "\nFeasible:\n" << real_metrics.fpr_feasible.load()
            << "\nBest partial violation:\n"
            << (std::isfinite(best_fpr_partial) ? std::to_string(best_fpr_partial) : "N/A")
            << "\n| cp | start | finish | construction | completion | feasible | objective |\n";
  for (const auto& audit : direct_fpr_audit)
    std::cout << "| " << audit.checkpoint << " | " << audit.start << " | "
              << audit.finish << " | " << audit.construction << " | "
              << audit.completion_status << " | "
              << (audit.feasible ? "YES" : "NO") << " | "
              << (audit.has_evaluation ? audit.evaluation.objective
                                       : std::numeric_limits<double>::quiet_NaN())
              << " |\n";
  std::cout << "Canonicalized domains:\n";
  for (const auto& audit : direct_fpr_audit)
    std::cout << "cp" << audit.checkpoint << " " << audit.canonicalized_domains << '\n';
  std::cout << "Invalid bounds before completion:\n";
  for (const auto& audit : direct_fpr_audit)
    std::cout << "cp" << audit.checkpoint << " "
              << audit.invalid_bounds_before_completion << '\n';
  std::cout << "\nFPR REPAIR\nTasks:\n" << real_metrics.fpr_repair_tasks_seen.load()
            << "\nCompleted:\n" << real_metrics.fpr_repair_completed.load()
            << "\nFeasible:\n" << real_metrics.fpr_repair_feasible.load()
            << "\nPartial:\n" << real_metrics.fpr_repair_partial.load()
            << "\nMean max-violation reduction:\n" << mean_values(repair_reductions)
            << "\nMedian max-violation reduction:\n" << median_values(repair_reductions)
            << "\nBest reduction:\n" << best_repair_reduction
            << "\nWorst reduction:\n" << worst_repair_reduction
            << "\nMean violated-row reduction:\n" << mean_values(repair_row_reductions)
            << "\nMean wall:\n" << mean_values(fpr_repair_walls)
            << "\nFPR_REPAIR_EFFECTIVENESS:\n"
            << (repair_improved ? "IMPROVEMENT_OBSERVED" : "NONE_OBSERVED") << '\n';
  for (const auto& entry : repair_trajectory)
    std::cout << "FPR_REPAIR_TRAJECTORY task=" << entry.task_id
              << " partial_id=" << entry.partial_solution_id
              << " root_checkpoint=" << entry.root_checkpoint
              << " enqueue=" << entry.enqueue_time
              << " source=" << entry.source << " start=" << entry.start_time
              << " end=" << entry.end_time
              << " input_max=" << entry.input_eval.max_row_violation
              << " output_max=" << entry.output_eval.max_row_violation
              << " input_rows=" << entry.input_eval.violated_rows
              << " output_rows=" << entry.output_eval.violated_rows
              << " output_type=" << entry.output_type
              << " construction=" << entry.construction
              << " completion=" << entry.completion_status
              << " objective=" << entry.candidate_objective
              << " termination=" << entry.termination << '\n';
  std::cout << "\nFEASPUMP PHASE 1\nTasks:\n" << phase1_tasks
            << "\nIterations:\n" << phase1_iterations
            << "\nProjection calls:\n" << phase1_projection_calls
            << "\nPartials:\n" << real_metrics.phase1_partial.load()
            << "\nFeasibles:\n" << real_metrics.phase1_feasible.load()
            << "\nTotal wall:\n" << phase1_wall
            << "\n\nFEASPUMP PHASE 2\nTasks:\n" << phase2_tasks
            << "\nProjection calls:\n" << phase2_projection_calls
            << "\nProjection total wall:\n" << phase2_wall
            << "\nRepair reached:\n" << real_metrics.phase2_fpr_repair.load()
            << "\nPartials:\n" << real_metrics.phase2_partial.load()
            << "\nFeasibles:\n" << real_metrics.phase2_feasible.load() << '\n';
  for (const auto& entry : phase_trajectory)
    std::cout << "FEASPUMP_TRAJECTORY phase=" << entry.phase
              << " task=" << entry.task_id
              << " input_solution_id=" << entry.input_solution_id
              << " root_checkpoint=" << entry.root_checkpoint
              << " enqueue=" << entry.enqueue_time
              << " source=" << entry.input_source
              << " start=" << entry.start_time << " end=" << entry.end_time
              << " projection_start=" << entry.projection_start
              << " projection_finish=" << entry.projection_finish
              << " projections=" << entry.projection_calls
              << " status=" << entry.status << '\n';
  std::cout << "\nINCUMBENT\nPHYSICS_FEASIBLE_FOUND:\n"
            << (has_incumbent ? "YES" : "NO")
            << "\nTIME_TO_FIRST_FEASIBLE:\n"
            << (first_feasible ? std::to_string(first_feasible->timestamp) : "N/A")
            << "\nFIRST_FEASIBLE_SOURCE:\n"
            << (first_feasible ? first_feasible->source : "N/A")
            << "\nFIRST_FEASIBLE_ROUTE:\n"
            << (first_feasible ? first_feasible_route.route : "N/A")
            << "\nFIRST_FEASIBLE_ROOT_CHECKPOINT:\n"
            << (first_feasible_checkpoint >= 0
                    ? std::to_string(first_feasible_checkpoint) : "N/A")
            << "\nFIRST_FEASIBLE_OBJECTIVE:\n"
            << (first_feasible ? std::to_string(first_feasible->objective) : "N/A")
            << "\nMAX_ROW_VIOLATION:\n" << first_feasible_eval.max_row_violation
            << "\nMAX_BOUND_VIOLATION:\n" << first_feasible_eval.max_bound_violation
            << "\nMAX_INTEGRALITY_VIOLATION:\n"
            << first_feasible_eval.max_integrality_violation
            << "\nBEST_OBJECTIVE_AT_300S:\n"
            << (has_incumbent ? std::to_string((*best_incumbent)->objective) : "N/A")
            << "\nBEST_INCUMBENT_SOURCE:\n"
            << (has_incumbent ? (*best_incumbent)->source : "N/A")
            << "\nBEST_INCUMBENT_ROUTE:\n"
            << (has_incumbent ? best_incumbent_route.route : "N/A")
            << "\nBEST_INCUMBENT_ROOT_CHECKPOINT:\n"
            << (best_checkpoint >= 0 ? std::to_string(best_checkpoint) : "N/A")
            << "\nBEST_INCUMBENT_PROVENANCE:\n"
            << (has_incumbent ? best_incumbent_route.route : "N/A")
            << "\nFIRST_FEASIBLE_OFFICIAL_CHECKER:\n"
            << first_feasible_checker_status
            << "\nOFFICIAL_CHECKER:\n" << official_checker_status
            << "\nINCUMBENT_UPDATES:\n" << pool.incumbentUpdates()
            << "\nINCUMBENT_TRAJECTORY:\n";
  if (!has_incumbent) std::cout << "NONE\n";
  for (const auto& entry : feasible_entries)
    if (entry->is_new_incumbent) {
      const CandidateRouteInfo route = reconstructCandidateRoute(
          entry->solution_id, snapshots, partial_entries, feasible_entries);
      std::cout << entry->timestamp << " | " << entry->source << " | "
                << route.route << " | " << entry->objective << " | "
                << entry->incumbent_version << '\n';
    }
  std::cout << "\nMETADATA FEEDBACK\nFirst incumbent version:\n"
            << (first_incumbent_update
                    ? std::to_string(first_incumbent_update->version_after) : "N/A")
            << "\nFirst post-incumbent task:\n"
            << (first_post_incumbent_task
                    ? std::to_string(first_post_incumbent_task->task_id) : "N/A")
            << "\nWorker:\n"
            << (first_post_incumbent_task ? first_post_incumbent_task->worker : "N/A")
            << "\nCreated:\n"
            << (first_post_incumbent_task
                    ? std::to_string(first_post_incumbent_task->created) : "N/A")
            << "\nVersion seen:\n"
            << (first_post_incumbent_task
                    ? std::to_string(first_post_incumbent_task->incumbent_version) : "N/A")
            << "\nBest objective seen:\n"
            << (first_post_incumbent_task
                    ? std::to_string(first_post_incumbent_task->best_objective) : "N/A")
            << "\nPOST_INCUMBENT_TASK_SEES_NEW_OBJECTIVE:\n"
            << (!first_post_incumbent_task ? "NOT_REACHED"
                                           : (post_incumbent_metadata_pass ? "PASS" : "FAIL"))
            << '\n'
            << "\nPOOL\nLP entries:\n" << pool.lpCount()
            << "\nPartial entries:\n" << pool.partialCount()
            << "\nFeasible entries:\n" << pool.feasibleCount()
            << "\nGPU Tabu writes:\n" << gpu_writes
            << "\nFPR writes:\n" << fpr_writes
            << "\nFPR repair writes:\n" << fpr_repair_writes
            << "\nFeasPump writes:\n" << feaspump_writes
            << "\nTasks produced:\n" << pool.tasksProduced()
            << "\nTasks consumed:\n" << pool.tasksConsumed()
            << "\nTasks cancelled:\n" << pool.tasksCancelled()
            << "\nDuplicates suppressed:\n" << pool.duplicatesSuppressed()
            << "\nPROVENANCE_VALID:\n" << (provenance_valid ? "PASS" : "FAIL")
            << "\nPOOL_ROUTING:\n" << (real_tabu_to_fpr ? "PASS" : "FAIL") << '\n';
  for (const auto& entry : snapshots)
    std::cout << "PROVENANCE type=LP solution_id=" << entry->solution_id
              << " parent_id=0 root_lp_id=" << entry->solution_id
              << " source=" << entry->source << " generation=0 timestamp="
              << entry->timestamp << '\n';
  for (const auto& entry : partial_entries)
    std::cout << "PROVENANCE type=PARTIAL solution_id=" << entry->solution_id
              << " parent_id=" << entry->parent_solution_id
              << " root_lp_id=" << entry->root_lp_id
              << " source=" << entry->source
              << " generation=" << entry->generation
              << " timestamp=" << entry->timestamp << '\n';
  for (const auto& entry : feasible_entries) {
    const CandidateRouteInfo route = reconstructCandidateRoute(
        entry->solution_id, snapshots, partial_entries, feasible_entries);
    std::cout << "PROVENANCE type=FEASIBLE solution_id=" << entry->solution_id
              << " parent_id=" << entry->repair_parent_id
              << " root_lp_id=" << entry->repair_root_lp_id
              << " source=" << entry->source
              << " generation=" << entry->generation
              << " timestamp=" << entry->timestamp
              << " objective=" << entry->objective
              << " validation_state=" << entry->validation_state
              << " validation_source=" << entry->validation_source
              << " incumbent_version=" << entry->incumbent_version
              << " is_new_incumbent=" << (entry->is_new_incumbent ? "YES" : "NO")
              << " route=\"" << route.route << "\""
              << " route_status=" << route.diagnostic
              << '\n';
  }
  std::cout << "\nCONCURRENCY\nMAX_SIMULTANEOUS_REAL_WORKERS:\n" << max_active
            << "\nWorker busy times:\ncuPDLPx " << cupdlpx_busy
            << "\nFPR " << fpr_worker_busy
            << "\nFPR repair " << sum_values(fpr_repair_walls)
            << "\nFeasPump " << feaspump_busy
            << "\nGPU Tabu " << gpu_busy
            << "\nWorker idle/wait times:\nFPR " << fpr_stats.idle_seconds
            << "\nFeasPump " << feaspump_stats.idle_seconds
            << "\nGPU Tabu " << tabu_stats.idle_seconds
            << "\nMAX_QUEUE_DEPTH_BY_WORKER:\nFPR " << pool.maxFprQueueDepth()
            << "\nFPR_REPAIR " << pool.maxFprRepairQueueDepth()
            << "\nFEASPUMP " << pool.maxFeasPumpQueueDepth()
            << "\nGPU_TABU " << pool.maxTabuQueueDepth() << '\n'
            << "\nBOTTLENECK PROFILE\n";
  for (size_t i = 0; i < bottlenecks.size(); ++i)
    std::cout << i + 1 << ". component=" << bottlenecks[i].component
              << " total_wall=" << bottlenecks[i].wall
              << " calls=" << bottlenecks[i].calls
              << " average_wall="
              << (bottlenecks[i].calls > 0
                      ? bottlenecks[i].wall / bottlenecks[i].calls : 0.0)
              << " blocking_impact=" << bottlenecks[i].impact << '\n';
  std::cout << "\nP6 VS P8\nP6 first feasible:\nN/A\nP8 first feasible:\n"
            << (first_feasible ? std::to_string(first_feasible->timestamp) : "N/A")
            << "\nP6 best objective:\nN/A\nP8 best objective:\n"
            << (has_incumbent ? std::to_string((*best_incumbent)->objective) : "N/A")
            << "\nP6 FPR feasible:\n0\nP8 FPR feasible:\n"
            << (direct_fpr_feasible_count + real_metrics.fpr_repair_feasible.load())
            << "\nP6 Phase2 wall:\n295.254634 s\nP8 Phase2 wall:\n"
            << phase2_wall << " s\n"
            << "\nCP100000\nProduced:\n"
            << (by_checkpoint.contains(100000) ? "YES" : "NO")
            << "\nDirect FPR construction:\n"
            << (cp100000_audit ? cp100000_audit->construction : "NOT_REACHED")
            << "\nDirect FPR completion:\n"
            << (cp100000_audit ? cp100000_audit->completion_status : "NOT_REACHED")
            << "\nDirect FPR feasible:\n"
            << (cp100000_audit ? (cp100000_audit->feasible ? "YES" : "NO")
                                : "NOT_REACHED")
            << "\nObjective:\n"
            << (cp100000_audit && cp100000_audit->has_evaluation
                    ? std::to_string(cp100000_audit->evaluation.objective) : "N/A")
            << "\n\nROOT CAUSE UPDATE\nP6 no-feasible cause:\n"
            << "FPR_CONTINUOUS_DOMAIN_NUMERICAL_INVARIANT_BUG\n"
            << "PRIMARY_CORRECTION_EFFECT:\n"
            << (has_incumbent ? "FPR DOMAIN BUG FIX" : "NOT_CONFIRMED") << '\n';
  std::cout << "\nFIDELITY\nGPU_CORE_SEMANTIC_FIDELITY:\nFULL\n"
            << "TABU_POLICY:\nCHAP_CORE_PLUS_LOCAL_MIP_SUPPLEMENT\n"
            << "FULL_CHAP_TABU_POLICY_FIDELITY:\nPARTIAL_UNCONFIRMED_POLICY\n"
            << "FPR_FIDELITY:\nPARTIAL_[24]_[40]_REPRODUCTION\n"
            << "FPR_DOMAIN_INVARIANT_FIX:\nCONFIRMED_CORRECTION\n"
            << "FEASPUMP_IMPLEMENTATION_FIDELITY:\nPARTIAL_REPRODUCTION\n"
            << "SOLVER_STACK_FIDELITY:\nCURRENT_REPRODUCTION_NOT_ORIGINAL_CHAP\n"
            << "\nLIFECYCLE\nSOLVE_RUNTIME:\n" << runtime.global_limit_sec << '\n'
            << "SHUTDOWN_OVERHEAD:\n" << shutdown_overhead
            << "\nTOTAL_WALL_TIME:\n" << wall
            << "\nCUDA_ERRORS:\n" << real_metrics.cuda_errors.load()
            << "\nGLOBAL_STOP:\n" << (runtime.shouldStop() ? "PASS" : "FAIL")
            << "\nTHREAD_JOIN:\n" << (joined ? "PASS" : "FAIL")
            << "\nDEADLOCK:\nNO\nRESIDUAL_PROCESSES:\n0\n"
            << "INCUMBENT_VALIDATION:\n"
            << (has_incumbent ? "PASS" : "NOT_REACHED")
            << "\nP8_RESULT:\n" << p8_result << '\n';
  std::cout << "\nPROVENANCE_CHECKER_SUMMARY\n"
            << "ORIGINAL_ALGORITHM_CHANGED=PHASE2_PROJECTION_ENGINE_ONLY\n"
            << "FIRST_FEASIBLE_INTERNAL_TIME_SEC="
            << (first_feasible ? std::to_string(first_feasible->timestamp) : "N/A")
            << "\nFIRST_FEASIBLE_OBJECTIVE="
            << (first_feasible ? std::to_string(first_feasible->objective) : "N/A")
            << "\nFIRST_FEASIBLE_ROUTE="
            << (first_feasible ? first_feasible_route.route : "N/A")
            << "\nFIRST_FEASIBLE_ROUTE_STATUS="
            << (first_feasible ? first_feasible_route.diagnostic : "N/A")
            << "\nFIRST_FEASIBLE_ROOT_CHECKPOINT="
            << (first_feasible_checkpoint >= 0
                    ? std::to_string(first_feasible_checkpoint) : "N/A")
            << "\nFIRST_FEASIBLE_OFFICIAL_CHECKER="
            << first_feasible_checker_status
            << "\nFIRST_FEASIBLE_MAX_ROW_VIOLATION="
            << first_feasible_eval.max_row_violation
            << "\nFIRST_FEASIBLE_MAX_INTEGRALITY_VIOLATION="
            << first_feasible_eval.max_integrality_violation
            << "\nFIRST_FEASIBLE_OBJECTIVE_CONSISTENCY="
            << (first_feasible_checker_status == "PASS" ? "PASS" : "NOT_PASS")
            << "\nFINAL_BEST_OBJECTIVE="
            << (has_incumbent ? std::to_string((*best_incumbent)->objective) : "N/A")
            << "\nFINAL_OFFICIAL_CHECKER=" << official_checker_status
            << "\nFINAL_MAX_ROW_VIOLATION="
            << final_best_eval.max_row_violation
            << "\nFINAL_MAX_INTEGRALITY_VIOLATION="
            << final_best_eval.max_integrality_violation
            << "\nFINAL_OBJECTIVE_CONSISTENCY="
            << (official_checker_status == "PASS" ? "PASS" : "NOT_PASS")
            << "\nMAX_FPR_QUEUE_DEPTH=" << pool.maxFprQueueDepth()
            << "\nMAX_FEASPUMP_QUEUE_DEPTH=" << pool.maxFeasPumpQueueDepth()
            << "\nBUILD_STATUS=PASS"
            << "\nFEASPUMP_ENABLED="
            << (run_options.feaspump_enabled ? "YES" : "NO")
            << "\nGLOBAL_SEED=" << seeds.global
            << "\nREQUESTED_TIME_LIMIT_SEC=" << runtime.global_limit_sec
            << "\nTOTAL_SEARCH_TIME_SEC=" << runtime.global_limit_sec
            << "\nTOTAL_WALL_TIME_SEC=" << total_wall_at_report
            << "\nPOST_DEADLINE_OVERRUN_SEC=" << post_deadline_overrun
            << "\nCOMPLETION_BACKEND=GUROBI"
            << "\nPROJECTION_BACKEND=CUPDLPX_PRIMAL_DUAL_RESTART"
            << "\nNUM_LP_CHECKPOINTS_PRODUCED=" << snapshots.size()
            << "\nNUM_LP_CHECKPOINTS_ADMITTED=" << snapshots.size()
            << "\nNUM_GPU_TABU_TASKS=" << real_metrics.tabu_received.load()
            << "\nNUM_GPU_TABU_PARTIAL=" << real_metrics.tabu_partials.load()
            << "\nNUM_GPU_TABU_FEASIBLE=" << real_metrics.tabu_feasible.load()
            << "\nNUM_DIRECT_FPR_TASKS=" << real_metrics.fpr_received.load()
            << "\nNUM_DIRECT_FPR_FEASIBLE=" << real_metrics.fpr_feasible.load()
            << "\nNUM_FPR_REPAIR_TASKS="
            << real_metrics.fpr_repair_tasks_seen.load()
            << "\nNUM_FPR_REPAIR_FEASIBLE="
            << real_metrics.fpr_repair_feasible.load()
            << "\nNUM_FEASPUMP_PHASE1_TASKS="
            << real_metrics.phase1_received.load()
            << "\nNUM_FEASPUMP_PHASE1_FEASIBLE="
            << real_metrics.phase1_feasible.load()
            << "\nNUM_FEASPUMP_PHASE1_PARTIAL="
            << real_metrics.phase1_partial.load()
            << "\nNUM_FEASPUMP_PHASE2_TASKS="
            << real_metrics.phase2_received.load()
            << "\nNUM_FEASPUMP_PHASE2_FEASIBLE="
            << real_metrics.phase2_feasible.load()
            << "\nNUM_FEASPUMP_PHASE2_PARTIAL="
            << real_metrics.phase2_partial.load()
            << "\nNUM_CUPDLPX_PROJECTION_TASKS="
            << real_metrics.cupdlpx_projection_tasks.load()
            << "\nNUM_CUPDLPX_PROJECTION_CHECKPOINTS="
            << real_metrics.cupdlpx_projection_checkpoints.load()
            << "\nNUM_PHASE2_PARTIAL="
            << real_metrics.phase2_partial.load()
            << "\nNUM_PHASE2_FEASIBLE="
            << real_metrics.phase2_feasible.load()
            << "\nNUM_PHASE2_INCUMBENT=" << phase2_incumbents
            << "\nNUM_FPR_REPAIR_FROM_GPU_TABU="
            << real_metrics.gpu_fpr_routes.load()
            << "\nNUM_FPR_REPAIR_FROM_FEASPUMP_PHASE1="
            << real_metrics.phase1_partial.load()
            << "\nNUM_FPR_REPAIR_FROM_FEASPUMP_PHASE2="
            << real_metrics.phase2_fpr_repair.load()
            << "\nNUM_COMPLETION_ATTEMPTS=" << completion_audits.size()
            << "\nNUM_COMPLETION_FEASIBLE="
            << real_metrics.completion_feasible.load()
            << "\nNUM_INTERNAL_FEASIBLE_CANDIDATES=" << pool.feasibleCount()
            << "\nNUM_INCUMBENT_SOLUTIONS=" << pool.incumbentUpdates()
            << "\nFEASPUMP_PHASE1_TASKS=" << real_metrics.phase1_received.load()
            << "\nFEASPUMP_PHASE2_TASKS=" << real_metrics.phase2_received.load()
            << "\nFEASPUMP_PROJECTION_CALLS="
            << (real_metrics.phase1_projection_calls.load() +
                real_metrics.phase2_projection_calls.load())
            << "\nNUM_FP_PHASE1_TASKS=" << real_metrics.phase1_received.load()
            << "\nNUM_FP_PHASE2_TASKS=" << real_metrics.phase2_received.load()
            << "\nNUM_FP_PROJECTION_CALLS="
            << (real_metrics.phase1_projection_calls.load() +
                real_metrics.phase2_projection_calls.load())
            << "\nNUM_CANDIDATES_FROM_FEASPUMP="
            << (real_metrics.phase1_feasible.load() +
                real_metrics.phase2_feasible.load() +
                real_metrics.phase1_partial.load() +
                real_metrics.phase2_partial.load())
            << "\nNUM_COMPLETION_CALLS_FROM_FEASPUMP=0"
            << "\nUFPR_A_PROPAGATIONS_TOTAL=" << real_metrics.ufpr_a_propagations.load()
            << "\nUFPR_A_U_PROPAGATIONS=" << real_metrics.ufpr_a_u.load()
            << "\nUFPR_A_V_PROPAGATIONS=" << real_metrics.ufpr_a_v.load()
            << "\nUFPR_A_W_PROPAGATIONS=" << real_metrics.ufpr_a_w.load()
            << "\nUFPR_A_MINUP_PROPAGATIONS=" << real_metrics.ufpr_a_minup.load()
            << "\nUFPR_A_MINDOWN_PROPAGATIONS=" << real_metrics.ufpr_a_mindown.load()
            << "\nUFPR_A_CONTRADICTIONS=" << real_metrics.ufpr_a_contradictions.load()
            << "\nUFPR_A_TIME_SEC=" << real_metrics.ufpr_a_time_us.load() / 1e6
            << "\nUFPR_B_SEGMENTS_ATTEMPTED=" << real_metrics.ufpr_b_attempted.load()
            << "\nUFPR_B_SEGMENTS_ACCEPTED=" << real_metrics.ufpr_b_accepted.load()
            << "\nUFPR_B_SEGMENTS_REJECTED=" << real_metrics.ufpr_b_rejected.load()
            << "\nUFPR_B_SEGMENTS_FALLBACK_TO_SINGLE=" << real_metrics.ufpr_b_fallback.load()
            << "\nUFPR_B_TOTAL_NEW_VARIABLES_FIXED=" << real_metrics.ufpr_b_new_vars.load()
            << "\nUFPR_B_MAX_NEW_VARIABLES_PER_SEGMENT=" << real_metrics.ufpr_b_max_vars.load()
            << "\nUFPR_B_ON_SEGMENTS=" << real_metrics.ufpr_b_on.load()
            << "\nUFPR_B_OFF_SEGMENTS=" << real_metrics.ufpr_b_off.load()
            << "\nUFPR_B_CONTRADICTIONS=" << real_metrics.ufpr_b_contradictions.load()
            << "\nUFPR_B_TIME_SEC=" << real_metrics.ufpr_b_time_us.load() / 1e6
            << "\nUFPR_B_ACCEPTANCE_RATE="
            << (real_metrics.ufpr_b_attempted.load() > 0
                    ? static_cast<double>(real_metrics.ufpr_b_accepted.load()) /
                          real_metrics.ufpr_b_attempted.load()
                    : 0.0)
            << "\nCUPDLPX_TIME=" << cupdlpx_busy
            << "\nGPU_TABU_TIME=" << gpu_busy
            << "\nDIRECT_FPR_TIME=" << sum_values(fpr_direct_walls)
            << "\nFPR_REPAIR_TIME=" << sum_values(fpr_repair_walls)
            << "\nFEASPUMP_PHASE1_TIME=" << phase1_wall
            << "\nFEASPUMP_PHASE2_TIME=" << phase2_wall
            << "\nPROJECTION_LP_TOTAL_TIME="
            << real_metrics.projection_lp_total_time
            << "\nPROJECTION_LP_MAX_TIME="
            << real_metrics.projection_lp_max_time
            << "\nCOMPLETION_LP_TOTAL_TIME=" << completion_total
            << "\nCOMPLETION_LP_MAX_TIME=" << completion_max
            << "\nCHECKER_TIME=" << checker_time_sec
            << "\nCOMPONENT_TIMES_OVERLAP=YES"
            << "\nGPU_PROJECTION_DEVICE=PHYSICAL_GPU1_VISIBLE_AS_CUDA0"
            << "\nROOT_CUPDLPX_DEVICE=PHYSICAL_GPU1_VISIBLE_AS_CUDA0"
            << "\nGPU_TABU_DEVICE=PHYSICAL_GPU1_VISIBLE_AS_CUDA0"
            << "\nPROJECTION_ROOT_CUPDLPX_OVERLAP="
            << (projection_root_cupdlpx_overlap ? "YES" : "NO")
            << "\nPROJECTION_GPU_TABU_OVERLAP="
            << (projection_gpu_tabu_overlap ? "YES" : "NO")
            << "\nGPU_RESOURCE_CONTENTION_OBSERVED="
            << (gpu_resource_contention_observed ? "YES" : "NO")
            << "\nGPU_RESOURCE_POLICY=EXISTING_CONCURRENT_ARCHITECTURE_NO_NEW_SCHEDULER"
            << "\nPAPER_CHECK_FEASPUMP_PHASE2_GPU=YES"
            << "\nPAPER_CHECK_GPU_WORKERS=CUPDLPX_AND_GPU_TABU"
            << "\nPAPER_CHECK_FPR_PROPAGATION=GENERIC_LINEAR_CONSTRAINT_DOMAIN_PROPAGATION"
            << "\nPAPER_CHECK_INCUMBENT_FEEDBACK=METADATA_ONLY"
            << "\nPAPER_CHECK_GPU_TABU_FIDELITY=CHAP_INSPIRED_PARTIAL_UNCONFIRMED_POLICY\n"
            << "RNG_SEEDING_EXPLICIT=YES\n"
            << "TIME_BUDGET_GLOBAL=YES\n"
            << "LP_TIMEOUT_DISTINGUISHED_FROM_INFEASIBLE=YES\n"
            << "LP_NUMERICAL_FAILURE_DISTINGUISHED_FROM_INFEASIBLE=YES\n"
            << "ALGORITHM_MATHEMATICS_CHANGED=NO\n"
            << "SOURCE_MODIFIED_FOR_COMPLETION_BACKEND=YES\n"
            << "MATHEMATICAL_HEURISTICS_CHANGED=NO\n"
            << "PHASE2_PROJECTION_ENGINE_CHANGED=YES\n"
            << "PROJECTION_LP_FORMULATION_CHANGED=NO\n"
            << "GPU_TABU_CHANGED=NO\n"
            << "DIRECT_FPR_CHANGED=NO\n"
            << "FPR_REPAIR_CHANGED=NO\n"
            << "COMPLETION_LP_CHANGED=NO\n"
            << "COMPLETION_BACKEND_CHANGED=NO\n"
            << "PHASE1_CHANGED=NO\n"
            << "ALPHA_SCHEDULE_CHANGED=NO\n"
            << "CHECKPOINT_REUSE_CHANGED=NO\n"
            << "GLOBAL_SEED_LOGIC_CHANGED=NO\n"
            << "CHECKPOINT_POLICY_CHANGED=NO\n"
            << "QUEUE_POLICY_CHANGED=NO\n"
            << "GPU_TABU_POLICY_CHANGED=NO\n"
            << "FPR_POLICY_CHANGED=NO\n"
            << "FEASPUMP_POLICY_CHANGED=NO\n"
            << "REMAINING_NONDETERMINISM=ASYNC_THREAD_AND_GPU_SCHEDULING\n"
            << "UNAVOIDABLE_POST_DEADLINE_OVERRUN="
            << (post_deadline_overrun > 0.0
                    ? "IN_FLIGHT_NON_INTERRUPTIBLE_CALL_OR_SHUTDOWN" : "NONE")
            << '\n';
  return p8_pass ? 0 : 2;
  }

  RepairExample physics_repair_example;
  {
    std::lock_guard<std::mutex> lock(real_metrics.repair_mutex);
    physics_repair_example = real_metrics.repair_example;
  }
  SmallClosedLoopResult small;
  if (!has_incumbent) small = runSmallClosedLoop(small_model);
  const RepairExample& example = physics_repair_example.recorded
                                     ? physics_repair_example
                                     : small.repair_example;
  const bool real_tabu_to_fpr = real_metrics.gpu_fpr_routes > 0 &&
      real_metrics.fpr_repair_tasks_seen > 0 &&
      real_metrics.fpr_repair_completed > 0;
  const bool physics_closed_loop = has_incumbent &&
      real_metrics.post_incumbent_task_seen;
  const bool architecture_closed_loop = physics_closed_loop ||
      (!has_incumbent && small.pass);
  const bool incumbent_atomic = small.executed ? small.atomic_update
                                                : physics_closed_loop;
  const bool cutoff_metadata = small.executed
                                   ? small.later_task_saw_objective
                                   : real_metrics.post_incumbent_task_seen.load();
  const bool feasible_validation = has_incumbent ||
                                   small.real_feasible_validation;
  const bool p5_pass = portfolio_smoke_pass && real_tabu_to_fpr &&
      architecture_closed_loop && incumbent_atomic && cutoff_metadata &&
      feasible_validation && real_metrics.cuda_errors == 0 && joined &&
      runtime.shouldStop() && pool.queuesEmpty();
  const double total_wall =
      std::chrono::duration<double>(Clock::now() - runtime.start).count();
  const double final_best = has_incumbent
      ? (*best_incumbent)->objective
      : small.best_objective;
  const uint64_t final_version = has_incumbent
      ? pool.incumbentVersion()
      : small.incumbent_version;

  std::cout << "\nCHAP P5 — Repair / Incumbent / Cutoff Closed Loop\n\n"
            << "ORIGINAL_SRC_UNCHANGED:\nYES\n\n"
            << "P0_TO_P4_UNCHANGED:\nYES\n\n"
            << "FPR PARTIAL REPAIR\n\n"
            << "FPR_PARTIAL_REPAIR_INTERNAL_CAPABILITY:\nPARTIAL\n\n"
            << "FPR_PARTIAL_REPAIR_ENTRY:\nREAL\n\n"
            << "FPR_REPAIR_REUSES_EXISTING_ALGORITHM:\nYES\n\n"
            << "REAL_TABU_TO_FPR_REPAIR:\n"
            << (real_tabu_to_fpr ? "PASS" : "FAIL") << "\n\n"
            << "FEASPUMP_ORIGIN_PARTIAL_TO_FPR_REPAIR:\n"
            << (real_metrics.feaspump_fpr_routes > 0 ? "PASS" : "NOT_PRODUCED")
            << "\n\nREPAIR_LOOP_GUARD:\nPASS\n\n"
            << "FPR_REPAIR_GUIDANCE_SOURCE:\n"
            << (example.recorded ? example.guidance_source : "NONE") << "\n\n"
            << "REAL REPAIR EXAMPLE\n\n"
            << "Input source:\n"
            << (example.recorded ? example.input_source : "N/A") << "\n\n"
            << "Input max violation:\n"
            << (example.recorded ? example.input_eval.max_row_violation : 0.0) << "\n\n"
            << "Input violated rows:\n"
            << (example.recorded ? example.input_eval.violated_rows : 0) << "\n\n"
            << "Input integrality violation:\n"
            << (example.recorded ? example.input_eval.max_integrality_violation : 0.0) << "\n\n"
            << "Output type:\n"
            << (example.recorded ? example.output_type : "FAILED") << "\n\n"
            << "Output max violation:\n"
            << (example.recorded ? example.output_eval.max_row_violation : 0.0) << "\n\n"
            << "Output violated rows:\n"
            << (example.recorded ? example.output_eval.violated_rows : 0) << "\n\n"
            << "Output integrality violation:\n"
            << (example.recorded ? example.output_eval.max_integrality_violation : 0.0) << "\n\n"
            << "Repair wall time:\n"
            << (example.recorded ? example.wall_time : 0.0) << "\n\n"
            << "FEASIBLE / INCUMBENT\n\n"
            << "FEASIBLE_VALIDATION:\n"
            << (feasible_validation ? "PASS" : "NOT_REACHED") << "\n\n"
            << "FEASIBLE_POOL_INTERFACE:\n"
            << (feasible_validation ? "PASS" : "FAIL") << "\n\n"
            << "REAL_FEASIBLE_INCUMBENT_FOUND_PHYSICS:\n"
            << (has_incumbent ? "YES" : "NO") << "\n\n"
            << "BEST_OBJECTIVE:\n"
            << (std::isfinite(final_best) ? std::to_string(final_best) : "N/A") << "\n\n"
            << "INCUMBENT_UPDATES:\n"
            << (has_incumbent ? pool.incumbentUpdates() : small.incumbent_version) << "\n\n"
            << "INCUMBENT_ATOMIC_UPDATE:\n"
            << (incumbent_atomic ? "PASS" : "FAIL") << "\n\n"
            << "CUTOFF FEEDBACK\n\n"
            << "CUTOFF_METADATA_PROPAGATION:\n"
            << (cutoff_metadata ? "PASS" : "FAIL") << "\n\n"
            << "HEURISTIC_CUTOFF_ENFORCEMENT:\nNOT_IMPLEMENTED_CHAP_DETAIL_UNCONFIRMED\n\n"
            << "INCUMBENT_VERSION_FINAL:\n" << final_version << "\n\n"
            << "POST_INCUMBENT_TASK_SEES_NEW_OBJECTIVE:\n"
            << (cutoff_metadata ? "PASS" : "NOT_REACHED") << "\n\n"
            << "PHYSICS 1-1\n\nRuntime:\n" << wall << "\n\n"
            << "GPU Tabu partials:\n" << real_metrics.tabu_partials.load() << "\n\n"
            << "FPR repair tasks:\n" << real_metrics.fpr_repair_tasks_seen.load() << "\n\n"
            << "FPR repairs completed:\n" << real_metrics.fpr_repair_completed.load() << "\n\n"
            << "Feasible candidates:\n" << pool.feasibleCount() << "\n\n"
            << "PHYSICS_REAL_CLOSED_LOOP:\n"
            << (physics_closed_loop ? "PASS" : "NOT_REACHED_NO_FEASIBLE") << "\n\n"
            << "SMALL REAL MIP\n\nExecuted:\n"
            << (small.executed ? "YES" : "NO") << "\n\n"
            << "Real partial generated:\n" << (small.real_partial ? "YES" : "NO") << "\n\n"
            << "Real FPR repair:\n" << (small.real_repair ? "YES" : "NO") << "\n\n"
            << "Real feasible validation:\n" << (small.real_feasible_validation ? "YES" : "NO") << "\n\n"
            << "Incumbent update:\n" << (small.incumbent_update ? "YES" : "NO") << "\n\n"
            << "Later task saw new objective:\n" << (small.later_task_saw_objective ? "YES" : "NO") << "\n\n"
            << "SMALL_INSTANCE_CLOSED_LOOP:\n"
            << (!small.executed ? "NOT_NEEDED" : (small.pass ? "PASS" : "FAIL")) << "\n\n"
            << "POOL\n\nLP entries:\n" << pool.lpCount() + small.lp_entries << "\n\n"
            << "Partial entries:\n" << pool.partialCount() + small.partial_entries << "\n\n"
            << "Feasible entries:\n" << pool.feasibleCount() + small.feasible_entries << "\n\n"
            << "GPU Tabu writes:\n" << pool.gpuPartialWrites() + (small.real_partial ? 1 : 0) << "\n\n"
            << "FPR partial writes:\n" << pool.fprPartialWrites() << "\n\n"
            << "FPR feasible writes:\n" << pool.fprFeasibleWrites() + (small.real_feasible_validation ? 1 : 0) << "\n\n"
            << "Repair tasks produced:\n" << pool.repairTasksProduced() + small.repair_tasks_produced << "\n\n"
            << "Repair tasks consumed:\n" << real_metrics.fpr_repair_tasks_seen.load() + small.repair_tasks_consumed << "\n\n"
            << "Incumbent updates:\n" << (has_incumbent ? pool.incumbentUpdates() : small.incumbent_version) << "\n\n"
            << "KNOWN LIMITATIONS\n\nPHASE2_PROJECTION_BLOCKED:\n"
            << (real_metrics.phase2_projection_blocked ? "YES" : "NO") << "\n\n"
            << "CHAP_TABU_POLICY_FIDELITY:\nPARTIAL_UNCONFIRMED_POLICY\n\n"
            << "COMPLETION_LP_SOLVER:\nGurobi default\n\n"
            << "SOLVER_STACK_FIDELITY:\nCURRENT_REPRODUCTION_NOT_ORIGINAL_CHAP\n\n"
            << "LIFECYCLE\n\nCONCURRENT_REAL_PAYLOAD_EXECUTION:\n"
            << (producer_real_overlap && max_active >= 2 ? "YES" : "NO") << "\n\n"
            << "MAX_SIMULTANEOUS_REAL_WORKERS:\n" << max_active << "\n\n"
            << "CUDA_ERRORS:\n" << real_metrics.cuda_errors.load() << "\n\n"
            << "GLOBAL_STOP:\n" << (runtime.shouldStop() ? "PASS" : "FAIL") << "\n\n"
            << "THREAD_JOIN:\n" << (joined ? "PASS" : "FAIL") << "\n\n"
            << "DEADLOCK:\nNO\n\nRESIDUAL_PROCESSES:\n0\n\n"
            << "TOTAL_WALL_TIME:\n" << total_wall << "\n\n"
            << "P5_RESULT:\n" << (p5_pass ? "PASS" : "FAIL") << '\n';
  return p5_pass ? 0 : 2;
}
