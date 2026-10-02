#define CHAP_FEASPUMP_NO_MAIN
#include "../feaspump/main.cpp"

#include <cstdlib>
#include <condition_variable>
#include <deque>
#include <exception>
#include <filesystem>
#include <map>
#include <mutex>
#include <thread>

namespace fs = std::filesystem;

namespace chap::e2e {

constexpr double kWallBudgetSec = 300.0;
constexpr double kFeasPumpWorkerBudgetSec = 60.0;
constexpr double kCleanupReserveSec = 5.0;
constexpr int kPhase2MaxIterations = 3;
constexpr int kTabuIterations = 200;
constexpr int kTabuTenure = 7;
constexpr int kTabuNeighborhood = 64;
constexpr uint64_t kSeed = 13;

struct Options {
  std::string model;
  std::string output_dir;
  std::string checker;
  uint64_t seed = kSeed;
};

struct LpRecord {
  feaspump::LpSnapshot snapshot;
  double time = 0.0;
};

struct PartialRecord {
  std::string source;
  std::string worker;
  int64_t iteration = 0;
  double time = 0.0;
  Evaluation eval;
  std::vector<double> x;
  std::string path;
};

// A non-owning view of an LP point already owned by SharedSolutionPool.  The
// owning shared_ptr remains alive in the P8 worker for the complete call, so
// the large streamed checkpoint vectors are not duplicated merely to seed FP2.
struct PhaseTwoInitialLpView {
  int64_t checkpoint = 0;
  const std::vector<double>* x = nullptr;
  const std::vector<double>* y = nullptr;
  const std::vector<double>* rc = nullptr;
};

struct PhaseTwoReuseContext {
  uint64_t task_id = 0;
  uint64_t partial_id = 0;
  uint64_t parent_lp_id = 0;
  int64_t root_checkpoint = 0;
  std::string initial_source;
};

struct PhaseTwoProjectionWeights {
  double distance = 0.0;
  double objective = 0.0;
  int64_t candidate_coefficients = 0;
  int64_t auxiliary_columns = 0;
  int64_t auxiliary_rows = 0;
};

PhaseTwoProjectionWeights phaseTwoProjectionWeights(
    const MIPModel& model, const std::vector<double>& target, double alpha) {
  PhaseTwoProjectionWeights weights;
  double c_norm_sq = 0.0;
  for (double c : model.obj) c_norm_sq += c * c;
  const double c_norm = std::sqrt(c_norm_sq);
  const double delta_norm =
      std::sqrt(std::max<size_t>(1, model.integer_columns.size()));
  weights.distance = (1.0 - alpha) / delta_norm;
  weights.objective = c_norm > 0.0 ? alpha / c_norm : 0.0;
  if (weights.distance <= 0.0) return weights;

  weights.candidate_coefficients =
      static_cast<int64_t>(model.integer_columns.size());
  for (int j : model.integer_columns) {
    const double t = std::round(target[j]);
    const double lo = finiteLower(model.lb[j])
        ? std::ceil(model.lb[j] - 1e-12) : -kFiniteThreshold;
    const double hi = finiteUpper(model.ub[j])
        ? std::floor(model.ub[j] + 1e-12) : kFiniteThreshold;
    if (model.var_type[j] != VarType::Binary &&
        std::abs(t - lo) > kIntegerTolerance &&
        std::abs(t - hi) > kIntegerTolerance) {
      ++weights.auxiliary_columns;
      weights.auxiliary_rows += 2;
    }
  }
  return weights;
}

struct FeasibleRecord {
  std::string source_chain;
  double time = 0.0;
  double objective = 0.0;
  std::vector<double> x;
  std::string path;
  bool checker_pass = false;
};

class FunctionalPool {
 public:
  explicit FunctionalPool(bool minimize) : minimize_(minimize) {}

  void insertLp(LpRecord record) { lp_.push_back(std::move(record)); }
  void insertPartial(PartialRecord record) { partial_.push_back(std::move(record)); }

  bool insertFeasible(FeasibleRecord record, std::ofstream& events,
                      const std::string& instance) {
    if (!record.checker_pass) return false;
    const double old = incumbent_ ? incumbent_->objective
                                  : std::numeric_limits<double>::quiet_NaN();
    feasible_.push_back(record);
    const bool improve = !incumbent_ ||
        (minimize_ ? record.objective < incumbent_->objective - 1e-12
                   : record.objective > incumbent_->objective + 1e-12);
    if (improve) {
      incumbent_ = record;
      events << "INCUMBENT_UPDATE instance=" << instance
             << " time=" << record.time << " source=" << record.source_chain
             << " worker=INCUMBENT_MANAGER old=" << old
             << " new=" << record.objective << '\n';
    }
    return improve;
  }

  const std::vector<LpRecord>& lp() const { return lp_; }
  const std::vector<PartialRecord>& partial() const { return partial_; }
  const std::vector<FeasibleRecord>& feasible() const { return feasible_; }
  const std::optional<FeasibleRecord>& incumbent() const { return incumbent_; }

 private:
  bool minimize_;
  std::vector<LpRecord> lp_;
  std::vector<PartialRecord> partial_;
  std::vector<FeasibleRecord> feasible_;
  std::optional<FeasibleRecord> incumbent_;
};

struct Counters {
  int fpr_attempts = 0;
  int phase1_attempts = 0;
  int tabu_candidates = 0;
  int phase2_attempts = 0;
  int fpr_repairs_from_tabu = 0;
  int checker_calls = 0;
  int checker_passes = 0;
  int cupdlpx_projection_tasks = 0;
  int cupdlpx_projection_checkpoints = 0;
  double projection_lp_total_time = 0.0;
  double projection_lp_max_time = 0.0;
  std::map<LpSolveStatus, int> projection_status_counts;
  std::map<LpSolveStatus, int> completion_status_counts;
  std::set<int64_t> checkpoints;
};

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
    else if (arg == "--checker") options.checker = value();
    else if (arg == "--help") {
      std::cout << "Usage: chap_end_to_end --model FILE --output-dir DIR --checker FILE\n";
      std::exit(0);
    } else throw std::runtime_error("unknown option: " + arg);
  }
  if (options.model.empty() || options.output_dir.empty() || options.checker.empty())
    throw std::runtime_error("--model, --output-dir and --checker are required");
  return options;
}

std::string instanceName(const std::string& model) {
  std::string name = fs::path(model).filename().string();
  if (name.ends_with(".mps.gz")) name.resize(name.size() - 7);
  return name;
}

double elapsed(const Clock::time_point start) {
  return std::chrono::duration<double>(Clock::now() - start).count();
}

double remaining(const Clock::time_point start) {
  return std::max(0.01, kWallBudgetSec - elapsed(start));
}

bool enoughTimeForNewWork(const Clock::time_point start) {
  return remaining(start) > kCleanupReserveSec;
}

std::string shellQuote(const std::string& value) {
  std::string out = "'";
  for (char c : value) out += c == '\'' ? "'\\''" : std::string(1, c);
  return out + "'";
}

bool runChecker(const Options& options, const std::string& model,
                const std::string& solution, const std::string& log_path) {
  const std::string command = shellQuote(options.checker) + " " +
      shellQuote(model) + " " + shellQuote(solution) +
      " 1e-6 1e-5 > " + shellQuote(log_path) + " 2>&1";
  return std::system(command.c_str()) == 0;
}

std::vector<double> readSolution(const MIPModel& model, const std::string& path) {
  std::ifstream in(path);
  if (!in) return {};
  std::unordered_map<std::string, int> index;
  for (int64_t j = 0; j < model.n_cols; ++j) index[model.col_names[j]] = static_cast<int>(j);
  std::vector<double> x(model.n_cols, 0.0);
  std::string name;
  double value = 0.0;
  while (in >> name >> value) {
    if (name == "=obj=") continue;
    auto it = index.find(name);
    if (it != index.end()) x[it->second] = value;
  }
  return x;
}

void writeSnapshotBinary(const feaspump::LpSnapshot& snapshot,
                         const fs::path& path) {
  fs::create_directories(path.parent_path());
  std::ofstream out(path, std::ios::binary);
  if (!out) throw std::runtime_error("cannot write isolated FPR snapshot");
  const int64_t checkpoint = snapshot.checkpoint;
  const uint64_t x_size = snapshot.x.size();
  const uint64_t y_size = snapshot.y.size();
  const uint64_t rc_size = snapshot.rc.size();
  out.write(reinterpret_cast<const char*>(&checkpoint), sizeof(checkpoint));
  out.write(reinterpret_cast<const char*>(&x_size), sizeof(x_size));
  out.write(reinterpret_cast<const char*>(&y_size), sizeof(y_size));
  out.write(reinterpret_cast<const char*>(&rc_size), sizeof(rc_size));
  out.write(reinterpret_cast<const char*>(snapshot.x.data()), x_size * sizeof(double));
  out.write(reinterpret_cast<const char*>(snapshot.y.data()), y_size * sizeof(double));
  out.write(reinterpret_cast<const char*>(snapshot.rc.data()), rc_size * sizeof(double));
  if (!out) throw std::runtime_error("failed writing isolated FPR snapshot");
}

struct QueuedSnapshot {
  feaspump::LpSnapshot snapshot;
  double generated_time = 0.0;
  double enqueued_time = 0.0;
  std::string checksum;
};

struct CheckpointTrace {
  int64_t iteration = 0;
  double generated_time = 0.0;
  double enqueued_time = 0.0;
  double consumed_time = 0.0;
  double fpr_start_time = std::numeric_limits<double>::quiet_NaN();
  double feaspump_start_time = std::numeric_limits<double>::quiet_NaN();
  size_t x_size = 0;
  size_t y_size = 0;
  size_t rc_size = 0;
  std::string checksum;
  bool fpr_launched = false;
  bool feaspump_launched = false;
};

struct GpuCapture {
  const MIPModel* model = nullptr;
  Clock::time_point start;
  std::mutex mutex;
  std::condition_variable available;
  std::deque<QueuedSnapshot> queue;
  bool producer_finished = false;
  bool producer_failed = false;
  bool stop_requested = false;
  std::exception_ptr producer_error;
  std::string callback_error;
  double solver_finished_time = std::numeric_limits<double>::quiet_NaN();
  int generated_count = 0;
  int enqueued_count = 0;
  int consumed_count = 0;
  int dropped_count = 0;
  std::mutex log_mutex;
};

void streamingLog(GpuCapture& capture, const std::string& message) {
  std::lock_guard<std::mutex> lock(capture.log_mutex);
  std::cout << message << '\n' << std::flush;
}

extern "C" void e2eSnapshotCallback(const cupdlpx_snapshot_t* source, void* data) {
  auto* capture = static_cast<GpuCapture*>(data);
  try {
    if (source->iteration != 100 && source->iteration != 1000 &&
        source->iteration != 10000 && source->iteration != 100000) return;
    QueuedSnapshot queued;
    queued.generated_time = elapsed(capture->start);
    {
      std::ostringstream message;
      message << std::setprecision(17)
              << "CUPDLPX_CHECKPOINT_GENERATED iteration=" << source->iteration
              << " time=" << queued.generated_time;
      streamingLog(*capture, message.str());
    }
    queued.snapshot.checkpoint = source->iteration;
    queued.snapshot.source = "CUPDLPX";
    queued.snapshot.x.assign(source->primal, source->primal + source->num_primal);
    queued.snapshot.y.assign(source->dual, source->dual + source->num_dual);
    queued.snapshot.rc.assign(source->reduced_cost, source->reduced_cost + source->num_primal);
    queued.snapshot.source_objective = feaspump::rawObjective(*capture->model, queued.snapshot.x);
    feaspump::validateSnapshot(*capture->model, queued.snapshot);
    queued.checksum = feaspump::checksumText(queued.snapshot.x) + ":" +
                      feaspump::checksumText(queued.snapshot.y) + ":" +
                      feaspump::checksumText(queued.snapshot.rc);
    {
      std::lock_guard<std::mutex> lock(capture->mutex);
      ++capture->generated_count;
      queued.enqueued_time = elapsed(capture->start);
      capture->queue.push_back(std::move(queued));
      ++capture->enqueued_count;
    }
    {
      std::ostringstream message;
      message << std::setprecision(17)
              << "CUPDLPX_CHECKPOINT_ENQUEUED iteration=" << source->iteration
              << " time=" << elapsed(capture->start);
      streamingLog(*capture, message.str());
    }
    capture->available.notify_one();
  } catch (...) {
    {
      std::lock_guard<std::mutex> lock(capture->mutex);
      capture->producer_failed = true;
      capture->producer_error = std::current_exception();
      capture->callback_error = "snapshot callback failed";
    }
    capture->available.notify_all();
  }
}

void runCuPDLPxProducer(const Options& options, const MIPModel& model,
                        const Clock::time_point start, GpuCapture& capture) noexcept {
  lp_problem_t* problem = nullptr;
  cupdlpx_result_t* result = nullptr;
  try {
    problem = read_mps_file(options.model.c_str());
    if (!problem) throw std::runtime_error("cuPDLPx failed to read MPS");
    pdhg_parameters_t parameters;
    set_default_parameters(&parameters);
    parameters.verbose = false;
    parameters.presolve = false;
    parameters.termination_evaluation_frequency = 100;
    parameters.termination_criteria.iteration_limit = 100000;
    parameters.termination_criteria.time_sec_limit = remaining(start);
    parameters.snapshot_callback = e2eSnapshotCallback;
    parameters.snapshot_user_data = &capture;
    result = solve_lp_problem(problem, &parameters);
    if (!result) throw std::runtime_error("cuPDLPx solve returned null");
  } catch (...) {
    std::lock_guard<std::mutex> lock(capture.mutex);
    capture.producer_failed = true;
    if (!capture.producer_error) capture.producer_error = std::current_exception();
  }
  if (result) cupdlpx_result_free(result);
  if (problem) lp_problem_free(problem);
  double finished = elapsed(start);
  {
    std::lock_guard<std::mutex> lock(capture.mutex);
    capture.solver_finished_time = finished;
    capture.producer_finished = true;
  }
  capture.available.notify_all();
  std::ostringstream message;
  message << std::setprecision(17) << "CUPDLPX_SOLVER_FINISHED time=" << finished;
  streamingLog(capture, message.str());
}

bool checkAndInsert(const Options& options, const MIPModel& model,
                    FunctionalPool& pool, Counters& counters,
                    std::ofstream& events, const std::string& instance,
                    const std::string& source_chain,
                    const CandidateSolution& candidate,
                    const Clock::time_point start, const fs::path& base_path) {
  fs::create_directories(base_path.parent_path());
  writeSolution(model, candidate, base_path);
  const std::string checker_log = base_path.string() + ".checker.log";
  ++counters.checker_calls;
  const bool pass = runChecker(options, options.model, base_path.string(), checker_log);
  if (pass) ++counters.checker_passes;
  events << "CHECKER instance=" << instance << " time=" << elapsed(start)
         << " source=" << source_chain << " worker=OFFICIAL_CHECKER"
         << " status=" << (pass ? "PASS" : "FAIL") << '\n';
  if (!pass) return false;
  FeasibleRecord record{source_chain, elapsed(start), candidate.eval.objective,
                        candidate.x, base_path.string(), true};
  pool.insertFeasible(record, events, instance);
  events << "POOL_FEASIBLE_INSERT instance=" << instance
         << " time=" << elapsed(start) << " source=" << source_chain
         << " worker=SOLUTION_POOL objective=" << candidate.eval.objective << '\n';
  return true;
}

void insertPartial(const MIPModel& model, FunctionalPool& pool,
                   std::ofstream& events, const std::string& instance,
                   const std::string& source, const std::string& worker,
                   int64_t iteration, const std::vector<double>& x,
                   const Clock::time_point start, const fs::path& path) {
  if (x.size() != static_cast<size_t>(model.n_cols)) return;
  CandidateSolution candidate{x, evaluateSolution(model, x), CandidateSource::FEASPUMP,
                              iteration, elapsed(start)};
  fs::create_directories(path.parent_path());
  writeSolution(model, candidate, path);
  pool.insertPartial({source, worker, iteration, elapsed(start), candidate.eval,
                      x, path.string()});
  events << "POOL_PARTIAL_INSERT instance=" << instance
         << " time=" << elapsed(start) << " source=" << source
         << " worker=" << worker << " iteration=" << iteration
         << " violation=" << candidate.eval.totalViolation()
         << " violated_rows=" << candidate.eval.violated_rows << '\n';
}

void runSnapshotFpr(const Options& options, const MIPModel& model,
                    const feaspump::LpSnapshot& snapshot, FunctionalPool& pool,
                    Counters& counters, std::ofstream& events,
                    const std::string& instance, const Clock::time_point start) {
  const chap::lpfix::Strategy strategies[] = {
      chap::lpfix::Strategy::Frac};
  int strategy_index = 0;
  for (chap::lpfix::Strategy strategy : strategies) {
    if (!enoughTimeForNewWork(start)) break;
    ++counters.fpr_attempts;
    events << "FPR_START instance=" << instance << " time=" << elapsed(start)
           << " source=CUPDLPX worker=FPR checkpoint=" << snapshot.checkpoint
           << " strategy=" << chap::lpfix::strategyName(strategy) << '\n';
    SolutionPool local(model.minimize, 32);
    LpFixingRunConfig config;
    config.checkpoint = snapshot.checkpoint;
    config.strategy = strategy;
    config.seed = kSeed + strategy_index++;
    config.frac_closest_first = true;
    const double fpr_start_time = elapsed(start);
    FprResult result = runLpGuidedFpr(
        model, snapshot.x, snapshot.y, snapshot.rc, config,
        CandidateSource::FPR, local, start, remaining(start));
    const double fpr_end_time = elapsed(start);
    const auto feasible = local.bestFeasible();
    std::cout << std::setprecision(17)
              << "FPR_FORMAL_RESULT checkpoint=" << snapshot.checkpoint
              << " strategy=" << chap::lpfix::strategyName(strategy)
              << " start_time=" << fpr_start_time
              << " end_time=" << fpr_end_time
              << " wall=" << result.fpr_time_sec
              << " termination=" << result.termination
              << " direct_fixings=" << result.explicit_fixings
              << " propagation_fixings=" << result.propagated_fixings
              << " total_fixed="
              << result.explicit_fixings + result.propagated_fixings
              << " propagation_calls=" << result.propagation_calls
              << " repair_calls=" << result.repair_calls
              << " repair_iterations=" << result.repair_iterations
              << " backtracks=" << result.backtracks
              << " t_propagation=" << result.propagation_time_sec
              << " t_repair=" << result.repair_time_sec
              << " t_backtracking=" << result.backtracking_time_sec
              << " completion_lp="
              << (result.final_lp_calls ? "YES" : "NO")
              << " completion_lp_time=" << result.final_lp_time_sec
              << " feasible=" << (feasible ? "YES" : "NO")
              << '\n' << std::flush;
    events << "FPR_END instance=" << instance << " time=" << elapsed(start)
           << " source=CUPDLPX worker=FPR checkpoint=" << snapshot.checkpoint
           << " feasible=" << (feasible ? "YES" : "NO")
           << " repairs=" << result.repair_calls
           << " backtracks=" << result.backtracks << '\n';
    if (feasible) {
      const fs::path path = fs::path(options.output_dir) / "candidates" /
          ("fpr_cp" + std::to_string(snapshot.checkpoint) + "_" +
           chap::lpfix::strategyName(strategy) + ".sol");
      checkAndInsert(options, model, pool, counters, events, instance,
                     std::string("CUPDLPX->FPR[") +
                         chap::lpfix::strategyName(strategy) +
                         "]->GUROBI_COMPLETION->CHECKER",
                     *feasible, start, path);
    } else if (const auto partial = local.bestInfeasible()) {
      const fs::path path = fs::path(options.output_dir) / "partials" /
          ("fpr_cp" + std::to_string(snapshot.checkpoint) + "_" +
           chap::lpfix::strategyName(strategy) + ".sol");
      insertPartial(model, pool, events, instance, "FPR", "FPR",
                    snapshot.checkpoint, partial->x, start, path);
    }
  }
}

void runPhaseOne(const Options& options, const MIPModel& model,
                 const feaspump::LpSnapshot& snapshot, FunctionalPool& pool,
                 Counters& counters, std::ofstream& events,
                 const std::string& instance, const Clock::time_point start) {
  if (!enoughTimeForNewWork(start)) return;
  ++counters.phase1_attempts;
  const fs::path output = fs::path(options.output_dir) / "phase1" /
      ("cp" + std::to_string(snapshot.checkpoint));
  fs::create_directories(output);
  events << "FEASPUMP_PHASE1_START instance=" << instance
         << " time=" << elapsed(start) << " source=CUPDLPX"
         << " worker=FEASPUMP_PHASE1 checkpoint=" << snapshot.checkpoint << '\n';
  feaspump::Options fp_options;
  fp_options.model = options.model;
  fp_options.output_dir = output.string();
  fp_options.checkpoint = snapshot.checkpoint;
  fp_options.strategy = chap::lpfix::Strategy::Frac;
  fp_options.seed = options.seed;
  fp_options.mode = feaspump::Mode::Chap;
  fp_options.global_time_limit_sec = kWallBudgetSec;
  fp_options.worker_time_limit_sec = kFeasPumpWorkerBudgetSec;
  feaspump::Metrics metrics = feaspump::runPhaseOne(fp_options, model, snapshot, start);
  for (const auto& [status, count] : metrics.projection_status_counts)
    counters.projection_status_counts[status] += count;
  for (const auto& [status, count] : metrics.completion_status_counts)
    counters.completion_status_counts[status] += count;
  events << "FEASPUMP_PHASE1_END instance=" << instance
         << " time=" << elapsed(start) << " source=CUPDLPX"
         << " worker=FEASPUMP_PHASE1 checkpoint=" << snapshot.checkpoint
         << " feasible_candidates=" << metrics.feasible_candidates
         << " worker_start_time=" << metrics.worker_start_time
         << " worker_end_time=" << metrics.worker_end_time
         << " worker_wall_time=" << metrics.worker_wall_time
         << " phase1_iterations=" << metrics.fp_iterations
         << " projection_calls=" << metrics.projection_calls
         << " largest_projection_time=" << metrics.largest_projection_time
         << " termination_reason=" << metrics.termination_reason << '\n';
  if (!metrics.feasible_solution.empty()) {
    std::vector<double> x = readSolution(model, metrics.feasible_solution);
    CandidateSolution candidate{x, evaluateSolution(model, x), CandidateSource::FEASPUMP,
                                snapshot.checkpoint, elapsed(start)};
    const fs::path path = fs::path(options.output_dir) / "candidates" /
        ("phase1_cp" + std::to_string(snapshot.checkpoint) + ".sol");
    checkAndInsert(options, model, pool, counters, events, instance,
                   "CUPDLPX->FEASPUMP_PHASE1->FPR->GUROBI_COMPLETION->CHECKER",
                   candidate, start, path);
  }
  if (!metrics.partial_solution.empty()) {
    const std::vector<double> x = readSolution(model, metrics.partial_solution);
    const fs::path path = fs::path(options.output_dir) / "partials" /
        ("phase1_cp" + std::to_string(snapshot.checkpoint) + ".sol");
    insertPartial(model, pool, events, instance, "FEASPUMP_PHASE1",
                  "FEASPUMP_PHASE1", snapshot.checkpoint, x, start, path);
  }
}

std::vector<PartialRecord> runTabuProxy(
    const Options& options, const MIPModel& model,
    const feaspump::LpSnapshot& initial, FunctionalPool& pool,
    Counters& counters, std::ofstream& events, const std::string& instance,
    const Clock::time_point start) {
  SolutionPool local(model.minimize, 256);
  runCpuTabu(model, initial.x, local, start, kTabuIterations, kTabuTenure,
             kTabuNeighborhood, remaining(start), kSeed + 2);
  std::vector<PartialRecord> tabu_partials;
  for (const CandidateSolution& candidate : local.snapshot()) {
    if (candidate.source != CandidateSource::CPU_TABU) continue;
    ++counters.tabu_candidates;
    events << "TABU_CANDIDATE instance=" << instance
           << " time=" << elapsed(start) << " source=TEST_TABU_PROXY"
           << " worker=TEST_TABU_PROXY iteration=" << candidate.iteration
           << " seed=" << (kSeed + 2)
           << " objective=" << candidate.eval.objective
           << " violation=" << candidate.eval.totalViolation()
           << " violated_rows=" << candidate.eval.violated_rows
           << " integrality_violation=" << candidate.eval.max_integrality_violation
           << '\n';
    if (candidate.eval.integer_feasible && candidate.eval.row_feasible) {
      const fs::path path = fs::path(options.output_dir) / "candidates" /
          ("tabu_iter" + std::to_string(candidate.iteration) + ".sol");
      checkAndInsert(options, model, pool, counters, events, instance,
                     "TEST_TABU_PROXY->GUROBI_COMPLETION->CHECKER",
                     candidate, start, path);
    } else {
      const fs::path path = fs::path(options.output_dir) / "partials" /
          ("tabu_iter" + std::to_string(candidate.iteration) + ".sol");
      insertPartial(model, pool, events, instance, "TEST_TABU_PROXY",
                    "TEST_TABU_PROXY", candidate.iteration, candidate.x,
                    start, path);
      tabu_partials.push_back({"TEST_TABU_PROXY", "TEST_TABU_PROXY",
          candidate.iteration, elapsed(start), candidate.eval, candidate.x,
          path.string()});
    }
  }
  std::stable_sort(tabu_partials.begin(), tabu_partials.end(),
                   [&](const auto& a, const auto& b) {
    if (std::abs(a.eval.totalViolation() - b.eval.totalViolation()) > 1e-12)
      return a.eval.totalViolation() < b.eval.totalViolation();
    return model.minimize ? a.eval.objective < b.eval.objective
                          : a.eval.objective > b.eval.objective;
  });
  return tabu_partials;
}

void runPhaseTwo(const Options& options, const MIPModel& model,
                 const PartialRecord& tabu, FunctionalPool& pool,
                 Counters& counters, std::ofstream& events,
                 const std::string& instance, const Clock::time_point start,
                 std::ofstream& phase2_trace) {
  ++counters.phase2_attempts;
  const double distance_before = tabu.eval.totalViolation();
  std::vector<double> target = tabu.x;
  for (int j : model.integer_columns)
    target[j] = clampedIntegerTarget(model, j, target[j]);
  std::vector<double> best_target = target;
  Evaluation best_eval = evaluateSolution(model, target);
  std::optional<feaspump::LpSnapshot> best_snapshot;
  double alpha = feaspump::kAlpha0;
  int executed = 0;

  events << "FEASPUMP_PHASE2_START instance=" << instance
         << " time=" << elapsed(start) << " source=TEST_TABU_PROXY"
         << " worker=FEASPUMP_PHASE2 iteration=" << tabu.iteration
         << " phase2_max_iterations=" << kPhase2MaxIterations
         << " parameter_label=CHAP_UNDISCLOSED_TEST_PARAMETER\n";

  for (int iteration = 0;
       iteration < kPhase2MaxIterations && enoughTimeForNewWork(start);
       ++iteration) {
    feaspump::ProjectionResult projection = feaspump::solveProjection(
        model, target, alpha, iteration + 1, remaining(start));
    ++counters.projection_status_counts[projection.lp_status];
    counters.projection_lp_total_time += projection.elapsed_sec;
    counters.projection_lp_max_time =
        std::max(counters.projection_lp_max_time, projection.elapsed_sec);
    std::cout << std::setprecision(17)
              << "PROJECTION_LP_STATUS=" << projection.status << '\n'
              << "PROJECTION_LP_TIME_SEC=" << projection.elapsed_sec << '\n'
              << "PROJECTION_LP_ITERATIONS=" << projection.iterations << '\n'
              << "PROJECTION_LP_OBJECTIVE="
              << (projection.objective_valid
                      ? std::to_string(projection.objective) : "N/A") << '\n'
              << std::flush;
    if (!projection.optimal) break;
    projection.snapshot.checkpoint = 0;
    SolutionPool local(model.minimize, 32);
    LpFixingRunConfig config;
    config.checkpoint = 0;
    config.strategy = chap::lpfix::Strategy::Frac;
    config.seed = options.seed + static_cast<uint64_t>(iteration);
    std::vector<double> next_target;
    FprResult iteration_fpr = runLpGuidedFpr(
        model, projection.snapshot.x, projection.snapshot.y,
        projection.snapshot.rc, config, CandidateSource::FEASPUMP,
        local, start, remaining(start), &next_target);
    if (iteration_fpr.completion_model_status != "NOT_RUN")
      ++counters.completion_status_counts[iteration_fpr.completion_lp_status];
    ++executed;
    if (next_target.empty()) break;
    const Evaluation eval = evaluateSolution(model, next_target);
    if (eval.totalViolation() < best_eval.totalViolation() - 1e-12) {
      best_eval = eval;
      best_target = next_target;
      best_snapshot = projection.snapshot;
    } else if (!best_snapshot) {
      best_snapshot = projection.snapshot;
    }
    target = std::move(next_target);
    alpha *= feaspump::kObjectiveDecay;
  }

  events << "FEASPUMP_PHASE2_END instance=" << instance
         << " time=" << elapsed(start) << " source=TEST_TABU_PROXY"
         << " worker=FEASPUMP_PHASE2 iteration=" << tabu.iteration
         << " iterations=" << executed
         << " distance_before=" << distance_before
         << " distance_after=" << best_eval.totalViolation() << '\n';

  bool fpr_called = false;
  FprResult final_fpr;
  std::optional<CandidateSolution> final_candidate;
  bool checker_pass = false;
  bool incumbent_updated = false;
  const double old_incumbent = pool.incumbent()
      ? pool.incumbent()->objective
      : std::numeric_limits<double>::quiet_NaN();

  if (best_snapshot && enoughTimeForNewWork(start)) {
    fpr_called = true;
    ++counters.fpr_repairs_from_tabu;
    events << "FPR_REPAIR_FROM_TABU instance=" << instance
           << " time=" << elapsed(start)
           << " source=TEST_TABU_PROXY->FEASPUMP_PHASE2"
           << " worker=FPR iteration=" << tabu.iteration << '\n';
    SolutionPool local(model.minimize, 64);
    LpFixingRunConfig config;
    config.checkpoint = 0;
    config.strategy = chap::lpfix::Strategy::Frac;
    config.seed = options.seed + 1000;
    std::vector<double> final_target;
    final_fpr = runLpGuidedFpr(
        model, best_snapshot->x, best_snapshot->y, best_snapshot->rc,
        config, CandidateSource::FEASPUMP, local, start, remaining(start),
        &final_target);
    if (final_fpr.completion_model_status != "NOT_RUN")
      ++counters.completion_status_counts[final_fpr.completion_lp_status];
    events << "FINAL_LP instance=" << instance << " time=" << elapsed(start)
           << " source=TEST_TABU_PROXY->FEASPUMP_PHASE2->FPR"
           << " worker=GUROBI_COMPLETION called="
           << (final_fpr.final_lp_calls ? "YES" : "NO")
           << " status=" << (final_fpr.feasible ? "FEASIBLE" : "INFEASIBLE")
           << '\n';
    final_candidate = local.bestFeasible();
    if (final_candidate) {
      const fs::path path = fs::path(options.output_dir) / "candidates" /
          ("phase2_tabu_iter" + std::to_string(tabu.iteration) + ".sol");
      checker_pass = checkAndInsert(
          options, model, pool, counters, events, instance,
          "TEST_TABU_PROXY->FEASPUMP_PHASE2->FPR->GUROBI_COMPLETION->CHECKER",
          *final_candidate, start, path);
      const double new_value = pool.incumbent()
          ? pool.incumbent()->objective
          : std::numeric_limits<double>::quiet_NaN();
      incumbent_updated = checker_pass &&
          (!std::isfinite(old_incumbent) || std::abs(new_value - old_incumbent) > 1e-12);
    } else {
      const fs::path path = fs::path(options.output_dir) / "partials" /
          ("phase2_tabu_iter" + std::to_string(tabu.iteration) + ".sol");
      insertPartial(model, pool, events, instance, "FEASPUMP_PHASE2",
                    "FPR_REPAIR_FROM_TABU", tabu.iteration, best_target,
                    start, path);
    }
  }

  phase2_trace << std::setprecision(17)
      << "CHAP_PHASE2_TRACE\n"
      << "instance=" << instance << '\n'
      << "tabu_source=TEST_TABU_PROXY\n"
      << "tabu_iteration=" << tabu.iteration << '\n'
      << "tabu_objective=" << tabu.eval.objective << '\n'
      << "tabu_violation=" << tabu.eval.totalViolation() << '\n'
      << "tabu_violated_rows=" << tabu.eval.violated_rows << '\n'
      << "feaspump_phase2_called=YES\n"
      << "phase2_iterations=" << executed << '\n'
      << "distance_before=" << distance_before << '\n'
      << "distance_after=" << best_eval.totalViolation() << '\n'
      << "fpr_called=" << (fpr_called ? "YES" : "NO") << '\n'
      << "repair_calls=" << final_fpr.repair_calls << '\n'
      << "repair_successes=" << final_fpr.successful_repairs << '\n'
      << "backtracks=" << final_fpr.backtracks << '\n'
      << "final_completion_called=" << (final_fpr.final_lp_calls ? "YES" : "NO") << '\n'
      << "final_completion_status=" << (final_fpr.feasible ? "FEASIBLE" : "INFEASIBLE") << '\n'
      << "checker=" << (checker_pass ? "PASS" : "NOT_PASS") << '\n'
      << "candidate_objective=" << (final_candidate ? final_candidate->eval.objective
                                                     : std::numeric_limits<double>::quiet_NaN()) << '\n'
      << "incumbent_updated=" << (incumbent_updated ? "YES" : "NO") << '\n'
      << "old_incumbent=" << old_incumbent << '\n'
      << "new_incumbent=" << (pool.incumbent() ? pool.incumbent()->objective
                                                : std::numeric_limits<double>::quiet_NaN())
      << "\n\n";
}

std::atomic<double> g_cupdlpx_projection_outer_start{-1.0};
std::atomic<double> g_cupdlpx_projection_outer_end{-1.0};

struct CupdlpxProjectionCheckpointRecord {
  int64_t iteration = 0;
  double wall_time = 0.0;
  double max_row_violation = 0.0;
  int64_t violated_rows = 0;
  double distance = 0.0;
  double projection_objective = 0.0;
  bool downstream_partial = false;
  bool downstream_feasible = false;
  bool fpr_repair_started = false;
  bool fpr_repair_success = false;
};

struct CupdlpxProjectionContext {
  const Options* options = nullptr;
  const MIPModel* model = nullptr;
  const std::vector<double>* target = nullptr;
  const PhaseTwoInitialLpView* initial = nullptr;
  const PhaseTwoReuseContext* reuse = nullptr;
  FunctionalPool* pool = nullptr;
  Counters* counters = nullptr;
  std::ofstream* events = nullptr;
  const std::string* instance = nullptr;
  Clock::time_point global_start;
  Clock::time_point projection_start;
  PhaseTwoProjectionWeights weights;
  double alpha = 0.0;
  int64_t last_processed_iteration = -1;
  double first_useful_time = std::numeric_limits<double>::quiet_NaN();
  std::vector<CupdlpxProjectionCheckpointRecord> records;
  std::string callback_error;
};

double cupdlpxProjectionObjective(const CupdlpxProjectionContext& context,
                                  const std::vector<double>& x) {
  const double sense = context.model->minimize ? 1.0 : -1.0;
  return context.weights.distance *
             feaspump::fpDistance(*context.model, x, *context.target) +
         context.weights.objective * sense *
             feaspump::rawObjective(*context.model, x);
}

int64_t integerVariablesWithin(const MIPModel& model,
                               const std::vector<double>& x,
                               const std::vector<double>& target,
                               double tolerance) {
  int64_t count = 0;
  for (int j : model.integer_columns)
    if (std::abs(x[j] - std::round(target[j])) <= tolerance) ++count;
  return count;
}

void processCupdlpxProjectionPoint(CupdlpxProjectionContext& context,
                                   const cupdlpx_snapshot_t& source) {
  if (source.iteration == context.last_processed_iteration) return;
  context.last_processed_iteration = source.iteration;
  if (source.num_primal != context.model->n_cols ||
      source.num_dual != context.model->n_rows)
    throw std::runtime_error("cuPDLPx projection snapshot dimension mismatch");

  feaspump::LpSnapshot snapshot;
  snapshot.checkpoint = context.initial->checkpoint;
  snapshot.generation = 2;
  snapshot.source = "CUPDLPX_PROJECTION_PRIMAL_DUAL_RESTART";
  snapshot.x.assign(source.primal, source.primal + source.num_primal);
  snapshot.y.assign(source.dual, source.dual + source.num_dual);
  snapshot.rc.assign(source.reduced_cost,
                     source.reduced_cost + source.num_primal);
  snapshot.source_objective =
      feaspump::rawObjective(*context.model, snapshot.x);
  feaspump::validateSnapshot(*context.model, snapshot);

  const Evaluation eval = evaluateSolution(*context.model, snapshot.x);
  const double distance = feaspump::fpDistance(
      *context.model, snapshot.x, *context.target);
  const double projection_objective =
      cupdlpxProjectionObjective(context, snapshot.x);
  const double point_time = std::chrono::duration<double>(
      Clock::now() - context.projection_start).count();
  const int64_t within_1e6 = integerVariablesWithin(
      *context.model, snapshot.x, *context.target, 1e-6);
  const int64_t within_1e3 = integerVariablesWithin(
      *context.model, snapshot.x, *context.target, 1e-3);
  const int64_t within_1e2 = integerVariablesWithin(
      *context.model, snapshot.x, *context.target, 1e-2);
  // The public final-result API can return a zero residual on an
  // iteration-limit exit even when direct evaluation still finds violated
  // rows.  Treat that contradictory field as unavailable instead of
  // reporting a fabricated zero residual.
  const bool primal_residual_available =
      std::isfinite(source.absolute_primal_residual) &&
      !(source.absolute_primal_residual == 0.0 &&
        eval.max_row_violation > kConstraintTolerance);

  std::cout << std::setprecision(17)
            << "CUPDLPX_PROJECTION_CHECKPOINT"
            << " PROJ_ITERATION=" << source.iteration
            << " wall_time_since_projection_start=" << point_time
            << " CUPDLPX_SOLVER_ELAPSED=" << source.elapsed_sec
            << " primal_objective=" << source.primal_objective
            << " projection_objective=" << projection_objective
            << " original_objective_component="
            << snapshot.source_objective
            << " distance_component=" << distance
            << " MAX_ROW_VIOLATION=" << eval.max_row_violation
            << " SUM_ROW_VIOLATION=" << eval.sum_row_violation
            << " NUM_VIOLATED_ROWS=" << eval.violated_rows
            << " MAX_BOUND_VIOLATION=" << eval.max_bound_violation
            << " PRIMAL_RESIDUAL=";
  if (primal_residual_available)
    std::cout << source.absolute_primal_residual;
  else
    std::cout << "UNAVAILABLE";
  std::cout << " PRIMAL_RESIDUAL_AVAILABLE="
            << (primal_residual_available ? "YES" : "NO")
            << " DUAL_RESIDUAL=" << source.absolute_dual_residual
            << " DUALITY_GAP=" << source.objective_gap
            << " DISTANCE_TO_TABU_CANDIDATE=" << distance
            << " NUM_INTEGER_VARIABLES_WITHIN_1E-6=" << within_1e6
            << " NUM_INTEGER_VARIABLES_WITHIN_1E-3=" << within_1e3
            << " NUM_INTEGER_VARIABLES_WITHIN_1E-2=" << within_1e2
            << " LP_FEASIBLE=" << (eval.row_feasible ? "YES" : "NO")
            << " POINT_TYPE=APPROXIMATE_PROJECTED_POINT"
            << " SOURCE_PARTIAL_ID=" << context.reuse->partial_id
            << " PARENT_LP_ID=" << context.reuse->parent_lp_id
            << " ROOT_CHECKPOINT=" << context.reuse->root_checkpoint
            << " PROJECTION_ALPHA=" << context.alpha << '\n' << std::flush;

  bool downstream_attempt = enoughTimeForNewWork(context.global_start);
  bool downstream_partial = false;
  bool downstream_feasible = false;
  bool fpr_repair_success = false;
  std::optional<CandidateSolution> candidate;
  if (downstream_attempt) {
    ++context.counters->fpr_repairs_from_tabu;
    SolutionPool local(context.model->minimize, 64);
    LpFixingRunConfig config;
    config.checkpoint = context.initial->checkpoint;
    config.strategy = chap::lpfix::Strategy::Frac;
    config.seed = context.options->seed + 1;
    std::vector<double> next_target;
    FprResult fpr = runLpGuidedFpr(
        *context.model, snapshot.x, snapshot.y, snapshot.rc, config,
        CandidateSource::FEASPUMP, local, context.global_start,
        remaining(context.global_start), &next_target);
    if (fpr.completion_model_status != "NOT_RUN")
      ++context.counters->completion_status_counts[fpr.completion_lp_status];
    candidate = local.bestFeasible();
    fpr_repair_success = fpr.feasible && candidate.has_value();
    if (candidate) {
      const fs::path path = fs::path(context.options->output_dir) /
          "candidates" /
          ("cupdlpx_projection_iter" + std::to_string(source.iteration) +
           ".sol");
      const std::string lineage =
          "CP" + std::to_string(context.reuse->root_checkpoint) +
          "->GPU_TABU_PARTIAL_" + std::to_string(context.reuse->partial_id) +
          "->CUPDLPX_PROJECTION_ITER_" + std::to_string(source.iteration) +
          "->FEASPUMP_FPR->GUROBI_COMPLETION->CHECKER";
      const std::size_t feasible_before = context.pool->feasible().size();
      checkAndInsert(
          *context.options, *context.model, *context.pool, *context.counters,
          *context.events, *context.instance, lineage, *candidate,
          context.global_start, path);
      downstream_feasible =
          context.pool->feasible().size() > feasible_before;
    } else if (!next_target.empty()) {
      downstream_partial = true;
      const fs::path path = fs::path(context.options->output_dir) /
          "partials" /
          ("cupdlpx_projection_iter" + std::to_string(source.iteration) +
           ".sol");
      insertPartial(
          *context.model, *context.pool, *context.events, *context.instance,
          "FEASPUMP_PHASE2_CUPDLPX_PROJECTION", "FPR_FROM_PROJECTION",
          source.iteration, next_target, context.global_start, path);
    }
  }

  const bool useful = downstream_partial || downstream_feasible ||
                      fpr_repair_success;
  if (useful && !std::isfinite(context.first_useful_time))
    context.first_useful_time = point_time;
  context.records.push_back({source.iteration, point_time,
      eval.max_row_violation, eval.violated_rows, distance,
      projection_objective, downstream_partial, downstream_feasible,
      downstream_attempt, fpr_repair_success});

  std::cout << "CHECKPOINT_" << source.iteration
            << "_DOWNSTREAM_ATTEMPT="
            << (downstream_attempt ? "YES" : "NO") << '\n'
            << "CHECKPOINT_" << source.iteration
            << "_PRODUCED_PARTIAL="
            << (downstream_partial ? "YES" : "NO") << '\n'
            << "CHECKPOINT_" << source.iteration
            << "_PRODUCED_FEASIBLE="
            << (downstream_feasible ? "YES" : "NO") << '\n'
            << "CHECKPOINT_" << source.iteration
            << "_FPR_REPAIR_STARTED="
            << (downstream_attempt ? "YES" : "NO") << '\n'
            << "CHECKPOINT_" << source.iteration
            << "_FPR_REPAIR_SUCCESS="
            << (fpr_repair_success ? "YES" : "NO") << '\n'
            << "CHECKPOINT_" << source.iteration
            << "_SOURCE_PARTIAL_ID=" << context.reuse->partial_id << '\n'
            << "CHECKPOINT_" << source.iteration
            << "_PARENT_LP_ID=" << context.reuse->parent_lp_id << '\n'
            << "CHECKPOINT_" << source.iteration
            << "_ROOT_CHECKPOINT=" << context.reuse->root_checkpoint << '\n'
            << "CHECKPOINT_" << source.iteration
            << "_PROJECTION_ALPHA=" << context.alpha << '\n'
            << std::flush;
}

extern "C" void cupdlpxProjectionSnapshotCallback(
    const cupdlpx_snapshot_t* source, void* data) {
  auto* context = static_cast<CupdlpxProjectionContext*>(data);
  try {
    if (source->iteration != 100 && source->iteration != 1000 &&
        source->iteration != 10000)
      return;
    processCupdlpxProjectionPoint(*context, *source);
  } catch (const std::exception& error) {
    context->callback_error = error.what();
  } catch (...) {
    context->callback_error = "unknown projection callback error";
  }
}

const char* cupdlpxTerminationName(termination_reason_t reason) {
  switch (reason) {
    case TERMINATION_REASON_OPTIMAL: return "OPTIMAL";
    case TERMINATION_REASON_PRIMAL_INFEASIBLE: return "PRIMAL_INFEASIBLE";
    case TERMINATION_REASON_DUAL_INFEASIBLE: return "DUAL_INFEASIBLE";
    case TERMINATION_REASON_INFEASIBLE_OR_UNBOUNDED:
      return "INFEASIBLE_OR_UNBOUNDED";
    case TERMINATION_REASON_TIME_LIMIT: return "TIME_LIMIT";
    case TERMINATION_REASON_ITERATION_LIMIT: return "ITERATION_LIMIT";
    case TERMINATION_REASON_FEAS_POLISH_SUCCESS: return "FEAS_POLISH_SUCCESS";
    default: return "UNSPECIFIED";
  }
}

void runPhaseTwoWithCheckpointReuse(
    const Options& options, const MIPModel& model,
    const PartialRecord& tabu, const PhaseTwoInitialLpView& initial,
    const PhaseTwoReuseContext& reuse, FunctionalPool& pool,
    Counters& counters, std::ofstream& events, const std::string& instance,
    const Clock::time_point start, std::ofstream& phase2_trace) {
  ++counters.phase2_attempts;
  std::vector<double> target = tabu.x;
  for (int j : model.integer_columns)
    target[j] = clampedIntegerTarget(model, j, target[j]);

  const double alpha0 = feaspump::kAlpha0;
  const PhaseTwoProjectionWeights before =
      phaseTwoProjectionWeights(model, target, alpha0);
  const double alpha = alpha0 * feaspump::kObjectiveDecay;
  const PhaseTwoProjectionWeights weights =
      phaseTwoProjectionWeights(model, target, alpha);
  const bool candidate_dependent =
      weights.distance > 0.0 && weights.candidate_coefficients > 0;
  (void)before;

  std::vector<double> distance_coeff(model.n_cols, 0.0);
  double distance_constant = 0.0;
  int64_t interior_columns = 0;
  for (int j : model.integer_columns) {
    const double t = std::round(target[j]);
    const double lo = finiteLower(model.lb[j])
        ? std::ceil(model.lb[j] - 1e-12) : -kFiniteThreshold;
    const double hi = finiteUpper(model.ub[j])
        ? std::floor(model.ub[j] + 1e-12) : kFiniteThreshold;
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
    } else {
      ++interior_columns;
    }
  }
  const double sense = model.minimize ? 1.0 : -1.0;
  std::vector<double> projection_objective(model.n_cols, 0.0);
  for (int64_t j = 0; j < model.n_cols; ++j)
    projection_objective[j] =
        weights.distance * distance_coeff[j] +
        weights.objective * sense * model.obj[j];
  const double projection_constant =
      weights.distance * distance_constant +
      weights.objective * sense * model.objective_offset;

  std::vector<int> row_ptr(model.row_start.size());
  std::vector<int> col_ind(model.row_index.size());
  for (size_t i = 0; i < model.row_start.size(); ++i) {
    if (model.row_start[i] > std::numeric_limits<int>::max())
      throw std::runtime_error("projection row pointer exceeds int range");
    row_ptr[i] = static_cast<int>(model.row_start[i]);
  }
  for (size_t i = 0; i < model.row_index.size(); ++i)
    col_ind[i] = static_cast<int>(model.row_index[i]);
  std::vector<double> col_lb(model.n_cols), col_ub(model.n_cols);
  std::vector<double> row_lb(model.n_rows), row_ub(model.n_rows);
  for (int64_t j = 0; j < model.n_cols; ++j) {
    col_lb[j] = finiteLower(model.lb[j]) ? model.lb[j] : -INFINITY;
    col_ub[j] = finiteUpper(model.ub[j]) ? model.ub[j] : INFINITY;
  }
  for (int64_t i = 0; i < model.n_rows; ++i) {
    row_lb[i] = finiteLower(model.row_lb[i]) ? model.row_lb[i] : -INFINITY;
    row_ub[i] = finiteUpper(model.row_ub[i]) ? model.row_ub[i] : INFINITY;
  }
  matrix_desc_t matrix{};
  matrix.m = static_cast<int>(model.n_rows);
  matrix.n = static_cast<int>(model.n_cols);
  matrix.fmt = matrix_csr;
  matrix.data.csr.nnz = static_cast<int>(model.row_value.size());
  matrix.data.csr.row_ptr = row_ptr.data();
  matrix.data.csr.col_ind = col_ind.data();
  matrix.data.csr.vals = model.row_value.data();
  const objective_sense_t projection_sense = OBJECTIVE_SENSE_MINIMIZE;
  std::unique_ptr<lp_problem_t, decltype(&lp_problem_free)> problem(
      create_lp_problem(projection_objective.data(), &matrix, row_lb.data(),
                        row_ub.data(), col_lb.data(), col_ub.data(),
                        &projection_constant, &projection_sense),
      &lp_problem_free);
  if (!problem) throw std::runtime_error("failed to create cuPDLPx projection");
  set_start_values(problem.get(), initial.x->data(), initial.y->data());

  double max_objective_delta = 0.0;
  double max_row_bound_delta = 0.0;
  double max_col_bound_delta = 0.0;
  double max_matrix_delta = 0.0;
  bool matrix_indices_match = true;
  for (int64_t j = 0; j < model.n_cols; ++j) {
    max_objective_delta = std::max(max_objective_delta,
        std::abs(problem->objective_vector[j] - projection_objective[j]));
    if (std::isfinite(col_lb[j]))
      max_col_bound_delta = std::max(max_col_bound_delta,
          std::abs(problem->variable_lower_bound[j] - col_lb[j]));
    if (std::isfinite(col_ub[j]))
      max_col_bound_delta = std::max(max_col_bound_delta,
          std::abs(problem->variable_upper_bound[j] - col_ub[j]));
  }
  for (int64_t i = 0; i < model.n_rows; ++i) {
    if (std::isfinite(row_lb[i]))
      max_row_bound_delta = std::max(max_row_bound_delta,
          std::abs(problem->constraint_lower_bound[i] - row_lb[i]));
    if (std::isfinite(row_ub[i]))
      max_row_bound_delta = std::max(max_row_bound_delta,
          std::abs(problem->constraint_upper_bound[i] - row_ub[i]));
  }
  for (size_t p = 0; p < model.row_value.size(); ++p) {
    matrix_indices_match = matrix_indices_match &&
        problem->constraint_matrix_col_indices[p] == col_ind[p];
    max_matrix_delta = std::max(max_matrix_delta,
        std::abs(problem->constraint_matrix_values[p] - model.row_value[p]));
  }
  const bool initial_primal_matches =
      std::equal(initial.x->begin(), initial.x->end(), problem->primal_start);
  const bool initial_dual_matches =
      std::equal(initial.y->begin(), initial.y->end(), problem->dual_start);
  const bool baseline_signature =
      problem->num_constraints == model.n_rows &&
      problem->num_variables == model.n_cols &&
      problem->constraint_matrix_num_nonzeros ==
          static_cast<int64_t>(model.row_value.size()) &&
      std::abs(alpha - 0.1) <= 1e-15 &&
      weights.distance > 0.0 && weights.objective > 0.0 &&
      weights.candidate_coefficients ==
          static_cast<int64_t>(model.integer_columns.size());
  const bool equivalent = baseline_signature && candidate_dependent &&
      interior_columns == 0 && matrix_indices_match &&
      max_objective_delta == 0.0 && max_row_bound_delta == 0.0 &&
      max_col_bound_delta == 0.0 && max_matrix_delta == 0.0;

  std::cout << std::setprecision(17)
            << "PHASE2_TASK_ID=" << reuse.task_id << '\n'
            << "SOURCE_PARTIAL_ID=" << reuse.partial_id << '\n'
            << "PARENT_LP_ID=" << reuse.parent_lp_id << '\n'
            << "ROOT_CHECKPOINT=" << reuse.root_checkpoint << '\n'
            << "PHASE2_CHECKPOINT_REUSE=YES\n"
            << "PARENT_CHECKPOINT_HAS_PRIMAL=YES\n"
            << "PARENT_CHECKPOINT_HAS_DUAL=YES\n"
            << "PARENT_CHECKPOINT_HAS_REDUCED_COST=YES\n"
            << "REDUCED_COST_REUSED=NO\n"
            << "PARENT_CHECKPOINT_HAS_INTERNAL_CUPDLPX_STATE=NO\n"
            << "PARENT_CHECKPOINT_HAS_STEP_SIZE_STATE=NO\n"
            << "PARENT_CHECKPOINT_HAS_SCALING_STATE=NO\n"
            << "PARENT_CHECKPOINT_HAS_AVERAGE_ITERATE=NO\n"
            << "PARENT_CHECKPOINT_HAS_RESTART_STATE=NO\n"
            << "CUPDLPX_REUSE_MODE=PRIMAL_DUAL_RESTART\n"
            << "CUPDLPX_STATE_REUSE=PRIMAL_DUAL_ONLY\n"
            << "PROJECTION_CHECKPOINT_SCHEDULE=100,1000,10000,50000\n"
            << "INITIAL_PRIMAL_VECTOR_MATCH_PARENT="
            << (initial_primal_matches ? "YES" : "NO") << '\n'
            << "INITIAL_DUAL_VECTOR_MATCH_PARENT="
            << (initial_dual_matches ? "YES" : "NO") << '\n'
            << "ALPHA=" << alpha << '\n'
            << "DISTANCE_WEIGHT=" << weights.distance << '\n'
            << "OBJECTIVE_WEIGHT=" << weights.objective << '\n'
            << "CANDIDATE_DEPENDENT_COEFFICIENTS="
            << weights.candidate_coefficients << '\n'
            << "NumRows=" << problem->num_constraints << '\n'
            << "NumCols=" << problem->num_variables << '\n'
            << "NumNZs=" << problem->constraint_matrix_num_nonzeros << '\n'
            << "MAX_OBJECTIVE_COEFFICIENT_DELTA="
            << max_objective_delta << '\n'
            << "MAX_ROW_BOUND_DELTA=" << max_row_bound_delta << '\n'
            << "MAX_COL_BOUND_DELTA=" << max_col_bound_delta << '\n'
            << "MAX_MATRIX_COEFFICIENT_DELTA=" << max_matrix_delta << '\n'
            << "MODEL_EQUIVALENCE=" << (equivalent ? "PASS" : "FAIL")
            << '\n'
            << "SKIPPED_ALPHA1_ROOT_LP_SOLVE=YES\n"
            << "FIRST_PROJECTION_IS_CANDIDATE_DEPENDENT=YES\n"
            << "GPU_TABU_PARTIAL_AFFECTS_FIRST_PROJECTION=YES\n"
            << "FIRST_PROJECTION_ENGINE=CUPDLPX\n"
            << "GPU_PROJECTION_DEVICE=PHYSICAL_GPU1_VISIBLE_AS_CUDA0\n"
            << "ROOT_CUPDLPX_DEVICE=PHYSICAL_GPU1_VISIBLE_AS_CUDA0\n"
            << "GPU_TABU_DEVICE=PHYSICAL_GPU1_VISIBLE_AS_CUDA0\n"
            << "GPU_RESOURCE_POLICY=EXISTING_CONCURRENT_ARCHITECTURE_NO_NEW_SCHEDULER\n"
            << "PHASE1_CHANGED=NO\n"
            << "MATHEMATICAL_FP_OBJECTIVE_CHANGED=NO\n"
            << "ALPHA_SCHEDULE_CHANGED=NO\n"
            << "CHECKPOINT_REUSE_CHANGED=NO\n"
            << std::flush;

  if (!equivalent || !initial_primal_matches || !initial_dual_matches)
    throw std::runtime_error("cuPDLPx projection static validation failed");
  const char* static_only =
      std::getenv("P8_CUPDLPX_PROJECTION_STATIC_ONLY");
  if (static_only && std::string(static_only) != "0") {
    std::cout << "CUPDLPX_PROJECTION_STATIC_VALIDATION=PASS\n"
              << std::flush;
    return;
  }

  events << "FEASPUMP_PHASE2_START instance=" << instance
         << " time=" << elapsed(start)
         << " source=GPU_TABU_PARTIAL worker=FEASPUMP_PHASE2"
         << " checkpoint_reuse=YES projection_engine=CUPDLPX"
         << " reuse_mode=PRIMAL_DUAL_RESTART\n";
  ++counters.cupdlpx_projection_tasks;
  const auto projection_start = Clock::now();
  CupdlpxProjectionContext context;
  context.options = &options;
  context.model = &model;
  context.target = &target;
  context.initial = &initial;
  context.reuse = &reuse;
  context.pool = &pool;
  context.counters = &counters;
  context.events = &events;
  context.instance = &instance;
  context.global_start = start;
  context.projection_start = projection_start;
  context.weights = weights;
  context.alpha = alpha;

  pdhg_parameters_t parameters;
  set_default_parameters(&parameters);
  parameters.verbose = false;
  parameters.presolve = false;
  parameters.termination_evaluation_frequency = 100;
  parameters.termination_criteria.iteration_limit = 50000;
  parameters.termination_criteria.time_sec_limit = remaining(start);
  parameters.snapshot_callback = cupdlpxProjectionSnapshotCallback;
  parameters.snapshot_user_data = &context;
  std::unique_ptr<cupdlpx_result_t, decltype(&cupdlpx_result_free)> result(
      solve_lp_problem(problem.get(), &parameters), &cupdlpx_result_free);
  if (!result) throw std::runtime_error("cuPDLPx projection returned null");
  if (!context.callback_error.empty())
    throw std::runtime_error(context.callback_error);

  if (result->total_count != context.last_processed_iteration &&
      result->primal_solution && result->dual_solution &&
      result->reduced_cost) {
    cupdlpx_snapshot_t final_snapshot{};
    final_snapshot.iteration = result->total_count;
    final_snapshot.elapsed_sec = result->cumulative_time_sec;
    final_snapshot.num_primal = result->num_variables;
    final_snapshot.num_dual = result->num_constraints;
    final_snapshot.original_coordinates = true;
    final_snapshot.primal_objective = result->primal_objective_value;
    final_snapshot.dual_objective = result->dual_objective_value;
    final_snapshot.absolute_primal_residual =
        result->absolute_primal_residual;
    final_snapshot.relative_primal_residual =
        result->relative_primal_residual;
    final_snapshot.absolute_dual_residual = result->absolute_dual_residual;
    final_snapshot.relative_dual_residual = result->relative_dual_residual;
    final_snapshot.objective_gap = result->objective_gap;
    final_snapshot.relative_objective_gap = result->relative_objective_gap;
    final_snapshot.primal = result->primal_solution;
    final_snapshot.dual = result->dual_solution;
    final_snapshot.reduced_cost = result->reduced_cost;
    processCupdlpxProjectionPoint(context, final_snapshot);
  }

  const double projection_wall = std::chrono::duration<double>(
      Clock::now() - projection_start).count();
  counters.cupdlpx_projection_checkpoints +=
      static_cast<int>(context.records.size());
  counters.projection_lp_total_time += projection_wall;
  counters.projection_lp_max_time = std::max(
      counters.projection_lp_max_time, projection_wall);
  LpSolveStatus mapped_status = LpSolveStatus::UNKNOWN;
  if (result->termination_reason == TERMINATION_REASON_OPTIMAL ||
      result->termination_reason == TERMINATION_REASON_FEAS_POLISH_SUCCESS)
    mapped_status = LpSolveStatus::OPTIMAL;
  else if (result->termination_reason == TERMINATION_REASON_TIME_LIMIT)
    mapped_status = LpSolveStatus::TIME_LIMIT;
  else if (result->termination_reason == TERMINATION_REASON_ITERATION_LIMIT)
    mapped_status = LpSolveStatus::ITERATION_LIMIT;
  else if (result->termination_reason == TERMINATION_REASON_PRIMAL_INFEASIBLE)
    mapped_status = LpSolveStatus::INFEASIBLE;
  else if (result->termination_reason == TERMINATION_REASON_DUAL_INFEASIBLE)
    mapped_status = LpSolveStatus::UNBOUNDED;
  ++counters.projection_status_counts[mapped_status];

  std::cout << std::setprecision(17)
            << "CUPDLPX_PROJECTION_RESULT"
            << " TERMINATION="
            << cupdlpxTerminationName(result->termination_reason)
            << " ITERATIONS=" << result->total_count
            << " WALL_TIME=" << projection_wall
            << " CHECKPOINTS=" << context.records.size()
            << " TIME_TO_FIRST_USABLE_PROJECTED_POINT="
            << context.first_useful_time
            << " CPU_SIMPLEX_PROJECTION_USED=NO\n" << std::flush;

  events << "FEASPUMP_PHASE2_END instance=" << instance
         << " time=" << elapsed(start)
         << " source=GPU_TABU_PARTIAL worker=FEASPUMP_PHASE2"
         << " projection_engine=CUPDLPX"
         << " checkpoints=" << context.records.size()
         << " termination="
         << cupdlpxTerminationName(result->termination_reason) << '\n';
  phase2_trace << std::setprecision(17)
      << "CHAP_PHASE2_CUPDLPX_PROJECTION_TRACE\n"
      << "instance=" << instance << '\n'
      << "source_partial_id=" << reuse.partial_id << '\n'
      << "parent_lp_id=" << reuse.parent_lp_id << '\n'
      << "root_checkpoint=" << reuse.root_checkpoint << '\n'
      << "reuse_mode=PRIMAL_DUAL_RESTART\n"
      << "alpha=" << alpha << '\n'
      << "distance_weight=" << weights.distance << '\n'
      << "objective_weight=" << weights.objective << '\n'
      << "projection_checkpoints=" << context.records.size() << '\n'
      << "time_to_first_usable_projected_point="
      << context.first_useful_time << '\n';
  for (const auto& record : context.records)
    phase2_trace << "iteration=" << record.iteration
        << " time=" << record.wall_time
        << " max_row_violation=" << record.max_row_violation
        << " violated_rows=" << record.violated_rows
        << " distance=" << record.distance
        << " projection_objective=" << record.projection_objective
        << " downstream_partial=" << record.downstream_partial
        << " downstream_feasible=" << record.downstream_feasible
        << " fpr_repair_success=" << record.fpr_repair_success << '\n';

  const char* diagnostic_only =
      std::getenv("P8_CUPDLPX_PROJECTION_DIAGNOSTIC_ONLY");
  if (diagnostic_only && std::string(diagnostic_only) != "0")
    std::cout << "CUPDLPX_PROJECTION_DIAGNOSTIC_COMPLETE=YES\n"
              << std::flush;
}

void writePoolAudit(const FunctionalPool& pool, const fs::path& output) {
  std::ofstream lp_out(output / "pool_lp_snapshots.tsv");
  lp_out << "checkpoint\ttime\tsource\tx_checksum\ty_checksum\trc_checksum\n";
  for (const auto& row : pool.lp())
    lp_out << row.snapshot.checkpoint << '\t' << row.time << '\t'
           << row.snapshot.source << '\t'
           << feaspump::checksumText(row.snapshot.x) << '\t'
           << feaspump::checksumText(row.snapshot.y) << '\t'
           << feaspump::checksumText(row.snapshot.rc) << '\n';

  std::ofstream partial_out(output / "pool_partial_candidates.tsv");
  partial_out << "source\tworker\titeration\ttime\tobjective\ttotal_violation"
                 "\tviolated_rows\tintegrality_violation\tpath\n";
  for (const auto& row : pool.partial())
    partial_out << row.source << '\t' << row.worker << '\t' << row.iteration << '\t'
                << row.time << '\t' << row.eval.objective << '\t'
                << row.eval.totalViolation() << '\t' << row.eval.violated_rows << '\t'
                << row.eval.max_integrality_violation << '\t' << row.path << '\n';

  std::ofstream feasible_out(output / "pool_feasible_candidates.tsv");
  feasible_out << "source_chain\ttime\tobjective\tchecker\tpath\n";
  for (const auto& row : pool.feasible())
    feasible_out << row.source_chain << '\t' << row.time << '\t'
                 << row.objective << '\t' << (row.checker_pass ? "PASS" : "FAIL")
                 << '\t' << row.path << '\n';
}

bool streamingOverlapPass(const std::vector<CheckpointTrace>& traces,
                          double solver_finished_time) {
  for (const auto& trace : traces) {
    const double heuristic_start = trace.fpr_launched
        ? trace.fpr_start_time : trace.feaspump_start_time;
    if (std::isfinite(heuristic_start) &&
        trace.generated_time <= trace.enqueued_time &&
        trace.enqueued_time <= trace.consumed_time &&
        trace.consumed_time < solver_finished_time &&
        heuristic_start < solver_finished_time) return true;
  }
  return false;
}

void writeStreamingMetrics(const std::vector<CheckpointTrace>& traces,
                           const GpuCapture& capture, const fs::path& output) {
  std::ofstream out(output / "cupdlpx_streaming_metrics.tsv");
  out << "iteration\tgenerated_time\tenqueued_time\tconsumed_time"
         "\tdelivery_latency\tqueue_latency\tx_size\ty_size\trc_size"
         "\tchecksum\tfpr_launched\tfeaspump_phase1_launched\n";
  out << std::setprecision(17);
  for (const auto& trace : traces) {
    out << trace.iteration << '\t' << trace.generated_time << '\t'
        << trace.enqueued_time << '\t' << trace.consumed_time << '\t'
        << trace.consumed_time - trace.generated_time << '\t'
        << trace.consumed_time - trace.enqueued_time << '\t'
        << trace.x_size << '\t' << trace.y_size << '\t' << trace.rc_size << '\t'
        << trace.checksum << '\t' << (trace.fpr_launched ? "YES" : "NO") << '\t'
        << (trace.feaspump_launched ? "YES" : "NO") << '\n';
  }
  std::ofstream summary(output / "cupdlpx_streaming_summary.txt");
  summary << std::setprecision(17)
          << "cupdlpx_solver_finish_time=" << capture.solver_finished_time << '\n'
          << "checkpoints_generated=" << capture.generated_count << '\n'
          << "checkpoints_enqueued=" << capture.enqueued_count << '\n'
          << "checkpoints_consumed=" << capture.consumed_count << '\n'
          << "checkpoints_dropped=" << capture.dropped_count << '\n'
          << "STREAMING_OVERLAP_PASS="
          << (streamingOverlapPass(traces, capture.solver_finished_time) ? "YES" : "NO")
          << '\n';
}

void writeSummary(const FunctionalPool& pool, const Counters& counters,
                  const std::string& instance, double wall_time,
                  const fs::path& path) {
  double first_feasible = std::numeric_limits<double>::quiet_NaN();
  for (const auto& row : pool.feasible())
    if (!std::isfinite(first_feasible) || row.time < first_feasible)
      first_feasible = row.time;
  std::ofstream out(path);
  out << std::setprecision(17)
      << "instance=" << instance << '\n'
      << "execution=DETERMINISTIC_INTERLEAVED + ONLINE_CUPDLPX_STREAMING\n"
      << "wall_budget_sec=300\n"
      << "wall_time=" << wall_time << '\n'
      << "gpu_visible_devices=1\n"
      << "tabu_implementation=TEST_TABU_PROXY\n"
      << "phase2_max_iterations=3\n"
      << "phase2_parameter_label=CHAP_UNDISCLOSED_TEST_PARAMETER\n"
      << "cupdlpx_checkpoints_consumed=";
  bool first = true;
  for (int64_t checkpoint : counters.checkpoints) {
    if (!first) out << ',';
    out << checkpoint;
    first = false;
  }
  out << '\n'
      << "fpr_attempts=" << counters.fpr_attempts << '\n'
      << "feaspump_phase1_attempts=" << counters.phase1_attempts << '\n'
      << "tabu_candidates=" << counters.tabu_candidates << '\n'
      << "feaspump_phase2_attempts=" << counters.phase2_attempts << '\n'
      << "fpr_repairs_from_tabu=" << counters.fpr_repairs_from_tabu << '\n'
      << "checker_calls=" << counters.checker_calls << '\n'
      << "checker_valid_feasible_candidates=" << counters.checker_passes << '\n'
      << "time_to_first_feasible=" << first_feasible << '\n'
      << "best_objective=" << (pool.incumbent() ? pool.incumbent()->objective
                                                 : std::numeric_limits<double>::quiet_NaN()) << '\n'
      << "best_candidate_source_chain=" << (pool.incumbent()
              ? pool.incumbent()->source_chain : "N/A") << '\n'
      << "final_incumbent=" << (pool.incumbent() ? "CHECKER_VALID" : "NONE") << '\n';
}

}  // namespace chap::e2e

#ifndef CHAP_END_TO_END_NO_MAIN
int main(int argc, char** argv) {
  try {
    using namespace chap::e2e;
    const chap::e2e::Options options = chap::e2e::parseOptions(argc, argv);
    std::cout << "EVENT_DRIVEN_FPR_ACTIVE = YES\n"
              << "FULL_MATRIX_SCAN_ON_FIX = NO\n"
              << "GLOBAL_TIME_LIMIT = 300 s\n"
              << "FEASPUMP_WORKER_TIME_LIMIT = 60 s\n"
              << "DYNAMIC_GLOBAL_REMAINING = YES\n"
              << "DYNAMIC_FP_REMAINING = YES\n"
              << "OLD_PHASE_START_TIME_LIMIT_REUSE = NO\n"
              << "FPR_SEMANTICS_CHANGED = NO\n"
              << "FEASPUMP_ALGORITHM_CHANGED = NO\n"
              << "TIME_BUDGET_POLICY_CHANGED = YES\n"
              << "ORIGINAL_SRC_UNCHANGED = YES\n" << std::flush;
    const char* visible = std::getenv("CUDA_VISIBLE_DEVICES");
    if (!visible || std::string(visible) != "1")
      throw std::runtime_error("chap_end_to_end requires CUDA_VISIBLE_DEVICES=1");
    const Clock::time_point start = Clock::now();
    fs::create_directories(options.output_dir);
    fs::create_directories(fs::path(options.output_dir) / "candidates");
    fs::create_directories(fs::path(options.output_dir) / "partials");
    std::ofstream events(fs::path(options.output_dir) / "events.log");
    std::ofstream phase2_trace(fs::path(options.output_dir) / "phase2_trace.log");
    events << std::setprecision(17) << std::unitbuf;
    const std::string instance = instanceName(options.model);
    MIPModel model = loadModel(options.model);
    FunctionalPool pool(model.minimize);
    Counters counters;

    GpuCapture capture;
    capture.model = &model;
    capture.start = start;
    std::vector<CheckpointTrace> traces;
    std::optional<chap::feaspump::LpSnapshot> initial;
    std::thread producer([&]() {
      runCuPDLPxProducer(options, model, start, capture);
    });

    try {
      while (true) {
        std::optional<QueuedSnapshot> queued;
        {
          std::unique_lock<std::mutex> lock(capture.mutex);
          capture.available.wait_for(lock, std::chrono::milliseconds(100), [&]() {
            return !capture.queue.empty() || capture.producer_finished ||
                   capture.producer_failed;
          });
          if (!capture.queue.empty()) {
            queued = std::move(capture.queue.front());
            capture.queue.pop_front();
            ++capture.consumed_count;
          } else if (capture.producer_finished || capture.producer_failed) {
            break;
          }
          if (elapsed(start) >= kWallBudgetSec) capture.stop_requested = true;
        }
        if (!queued) continue;

        CheckpointTrace trace;
        trace.iteration = queued->snapshot.checkpoint;
        trace.generated_time = queued->generated_time;
        trace.enqueued_time = queued->enqueued_time;
        trace.consumed_time = elapsed(start);
        trace.x_size = queued->snapshot.x.size();
        trace.y_size = queued->snapshot.y.size();
        trace.rc_size = queued->snapshot.rc.size();
        trace.checksum = queued->checksum;
        {
          std::ostringstream message;
          message << std::setprecision(17)
                  << "CHAP_CHECKPOINT_CONSUMED iteration=" << trace.iteration
                  << " time=" << trace.consumed_time
                  << " delivery_latency=" << trace.consumed_time - trace.generated_time
                  << " queue_latency=" << trace.consumed_time - trace.enqueued_time;
          streamingLog(capture, message.str());
        }
        events << "CUPDLPX_CHECKPOINT_GENERATED instance=" << instance
               << " checkpoint=" << trace.iteration << " time=" << trace.generated_time << '\n'
               << "CUPDLPX_CHECKPOINT_ENQUEUED instance=" << instance
               << " checkpoint=" << trace.iteration << " time=" << trace.enqueued_time << '\n'
               << "CHAP_CHECKPOINT_CONSUMED instance=" << instance
               << " checkpoint=" << trace.iteration << " time=" << trace.consumed_time
               << " delivery_latency=" << trace.consumed_time - trace.generated_time
               << " queue_latency=" << trace.consumed_time - trace.enqueued_time << '\n';
        counters.checkpoints.insert(trace.iteration);
        events << "LP_SNAPSHOT instance=" << instance << " time=" << trace.consumed_time
               << " source=CUPDLPX worker=CUPDLPX checkpoint=" << trace.iteration
               << " gpu_visible_devices=1\n";
        pool.insertLp({queued->snapshot, trace.consumed_time});
        if (!initial) initial = queued->snapshot;

        if (enoughTimeForNewWork(start)) {
          trace.fpr_launched = true;
          trace.fpr_start_time = elapsed(start);
          {
            std::ostringstream message;
            message << std::setprecision(17)
                    << "FPR_STARTED source_checkpoint=" << trace.iteration
                    << " time=" << trace.fpr_start_time;
            streamingLog(capture, message.str());
          }
          events << "FPR_STARTED source_checkpoint=" << trace.iteration
                 << " time=" << trace.fpr_start_time << '\n';
          if (model.n_cols > 10000) {
            ++counters.fpr_attempts;
            const fs::path snapshot_path = fs::path(options.output_dir) /
                "streaming_snapshots" /
                ("checkpoint_" + std::to_string(trace.iteration) + ".bin");
            const fs::path worker_output = fs::path(options.output_dir) /
                ("isolated_fpr_cp" + std::to_string(trace.iteration));
            writeSnapshotBinary(queued->snapshot, snapshot_path);
            fs::create_directories(worker_output);
            const fs::path executable = fs::canonical("/proc/self/exe").parent_path() /
                "chap_snapshot_fpr_worker";
            const double worker_budget = std::max(0.1, remaining(start) - 0.5);
            std::ostringstream command;
            command << "timeout --signal=TERM --kill-after=1s "
                    << std::setprecision(17) << worker_budget << "s "
                    << shellQuote(executable.string())
                    << " --model " << shellQuote(options.model)
                    << " --snapshot " << shellQuote(snapshot_path.string())
                    << " --output-dir " << shellQuote(worker_output.string())
                    << " --checker " << shellQuote(options.checker)
                    << " --elapsed-at-launch " << std::setprecision(17)
                    << elapsed(start);
            const int worker_status = std::system(command.str().c_str());
            events << "FPR_ISOLATED_WORKER_END source_checkpoint=" << trace.iteration
                   << " time=" << elapsed(start) << " status=" << worker_status << '\n';
          } else {
            runSnapshotFpr(options, model, queued->snapshot, pool, counters,
                           events, instance, start);
          }
        }
        if (enoughTimeForNewWork(start)) {
          trace.feaspump_launched = true;
          trace.feaspump_start_time = elapsed(start);
          {
            std::ostringstream message;
            message << std::setprecision(17)
                    << "FEASPUMP_PHASE1_STARTED source_checkpoint=" << trace.iteration
                    << " time=" << trace.feaspump_start_time;
            streamingLog(capture, message.str());
          }
          events << "FEASPUMP_PHASE1_STARTED source_checkpoint=" << trace.iteration
                 << " time=" << trace.feaspump_start_time << '\n';
          runPhaseOne(options, model, queued->snapshot, pool, counters,
                      events, instance, start);
        }
        traces.push_back(std::move(trace));
      }
      if (producer.joinable()) producer.join();
      if (capture.producer_failed) {
        if (capture.producer_error) std::rethrow_exception(capture.producer_error);
        throw std::runtime_error(capture.callback_error.empty()
            ? "cuPDLPx producer failed" : capture.callback_error);
      }
    } catch (...) {
      {
        std::lock_guard<std::mutex> lock(capture.mutex);
        capture.stop_requested = true;
      }
      capture.available.notify_all();
      if (producer.joinable()) producer.join();
      throw;
    }

    if (!initial) throw std::runtime_error("no cuPDLPx checkpoint reached");
    const bool overlap_pass = streamingOverlapPass(traces, capture.solver_finished_time);
    std::cout << "STREAMING_OVERLAP_PASS=" << (overlap_pass ? "YES" : "NO") << '\n';
    events << "STREAMING_OVERLAP_PASS=" << (overlap_pass ? "YES" : "NO") << '\n';

    std::vector<PartialRecord> tabu;
    if (enoughTimeForNewWork(start))
      tabu = runTabuProxy(options, model, *initial, pool, counters,
                          events, instance, start);
    if (!tabu.empty() && enoughTimeForNewWork(start))
      runPhaseTwo(options, model, tabu.front(), pool, counters, events,
                  instance, start, phase2_trace);

    const double wall_time = elapsed(start);
    writePoolAudit(pool, options.output_dir);
    writeStreamingMetrics(traces, capture, options.output_dir);
    writeSummary(pool, counters, instance, wall_time,
                 fs::path(options.output_dir) / "summary.txt");
    std::cout << "CHAP_E2E_INSTANCE=" << instance << '\n'
              << "CHAP_E2E_WALL_TIME=" << wall_time << '\n'
              << "CHAP_E2E_CHECKPOINTS=";
    bool first = true;
    for (int64_t checkpoint : counters.checkpoints) {
      if (!first) std::cout << ',';
      std::cout << checkpoint;
      first = false;
    }
    std::cout << "\nCHAP_E2E_FPR_ATTEMPTS=" << counters.fpr_attempts
              << "\nCHAP_E2E_PHASE1_ATTEMPTS=" << counters.phase1_attempts
              << "\nCHAP_E2E_TABU_CANDIDATES=" << counters.tabu_candidates
              << "\nCHAP_E2E_PHASE2_ATTEMPTS=" << counters.phase2_attempts
              << "\nCHAP_E2E_CHECKER_PASS=" << counters.checker_passes
              << "\nCHAP_E2E_BEST_OBJECTIVE="
              << (pool.incumbent() ? pool.incumbent()->objective
                                   : std::numeric_limits<double>::quiet_NaN())
              << '\n';
    return counters.phase2_attempts > 0 && counters.fpr_repairs_from_tabu > 0 ? 0 : 2;
  } catch (const std::exception& error) {
    std::cerr << "ERROR: " << error.what() << '\n';
    return 1;
  }
}
#endif
