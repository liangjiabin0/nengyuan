#pragma once

#include <array>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <map>
#include <set>

namespace chap_profile {

using ProfileClock = std::chrono::steady_clock;

enum class Phase : int { Other = 0, DirectFix = 1, Propagation = 2,
                          Repair = 3, Backtrack = 4, Initialization = 5 };

inline double secondsSince(const ProfileClock::time_point& t) {
  return std::chrono::duration<double>(ProfileClock::now() - t).count();
}

struct FixEvent {
  int64_t id = 0;
  int variable = -1;
  std::string name;
  std::string type;
  int period = -1;
  int unit = -1;
  double preferred = 0.0;
  double total_time = 0.0;
  double propagation_time = 0.0;
  int64_t propagation_calls = 0;
  int64_t bound_changes = 0;
  bool repair_triggered = false;
  double repair_time = 0.0;
  int64_t repair_iterations = 0;
  bool backtracking_triggered = false;
  double backtrack_time = 0.0;
  int64_t rows_touched = 0;
  int temporal_min = 1000000000;
  int temporal_max = -1;
  bool success = false;
  std::set<int> touched_rows;
  ProfileClock::time_point start;
  double base_prop_time = 0.0;
  int64_t base_prop_calls = 0;
  int64_t base_bound_changes = 0;
  double base_repair_time = 0.0;
  int64_t base_repair_iterations = 0;
  double base_backtrack_time = 0.0;
};

struct RepairCall {
  int64_t id = 0;
  int trigger_variable = -1;
  int violated_row = -1;
  double initial_violation = 0.0;
  double best_violation = 0.0;
  double final_violation = 0.0;
  int64_t iterations = 0;
  int64_t candidates_inspected = 0;
  int64_t selected_variables = 0;
  bool earlier_modified = false;
  bool success = false;
  double elapsed = 0.0;
  double candidate_eval_time = 0.0;
  int max_candidates = 0;
  ProfileClock::time_point start;
  bool watchdog_printed = false;
};

struct ProgressPoint {
  double time = 0.0;
  int64_t fixed = 0;
  int64_t attempts = 0;
  int64_t propagation_calls = 0;
  int64_t bound_tightenings = 0;
  int64_t repair_calls = 0;
  int64_t repair_successes = 0;
  int64_t backtracks = 0;
  double best_violation = 0.0;
};

struct CategoryCount {
  int64_t events = 0;
  int64_t bound_changes = 0;
  int64_t infeasibilities = 0;
  int64_t repair_triggers = 0;
  double time = 0.0;
};

struct FprProfile {
  const MIPModel* model = nullptr;
  std::string strategy;
  uint64_t seed = 0;
  double limit_sec = 300.0;
  ProfileClock::time_point start;
  ProfileClock::time_point next_progress;
  bool time_limit = false;
  std::string termination = "ERROR";
  Phase phase = Phase::Other;

  double t_total = 0.0;
  double t_initialization = 0.0;
  double t_ranking = 0.0;
  double t_fixing_inclusive = 0.0;
  double t_propagation = 0.0;
  double t_queue = 0.0;
  double t_repair = 0.0;
  double t_backtrack = 0.0;
  double t_branch_generation = 0.0;
  double t_singleton_scans = 0.0;
  double t_completion = 0.0;
  double t_final_evaluation = 0.0;
  double t_candidate_evaluation = 0.0;
  std::array<double, 6> t_activity{};
  std::array<double, 6> t_domain{};

  int64_t integer_total = 0;
  int64_t integer_fixed_current = 0;
  int64_t integer_fixed_max = 0;
  int64_t direct_fixings = 0;
  int64_t propagation_fixing_events = 0;
  int64_t fixing_attempts = 0;
  int64_t successful_fixings = 0;
  int64_t failed_fixings = 0;
  int64_t branch_nodes_created = 0;
  int64_t branch_nodes_processed = 0;
  int64_t propagation_calls = 0;
  int64_t propagation_rounds = 0;
  int64_t constraint_propagator_calls = 0;
  int64_t propagators_processed = 0;
  int64_t bound_tightenings = 0;
  int64_t binary_bound_tightenings = 0;
  int64_t continuous_bound_tightenings = 0;
  int64_t infeasible_constraints = 0;
  int64_t redundant_constraints = 0;
  int64_t repair_calls = 0;
  int64_t repair_iterations = 0;
  int64_t repair_successes = 0;
  int64_t repair_failures = 0;
  int64_t repair_variable_changes = 0;
  int64_t earlier_fixings_modified = 0;
  int64_t backtracks = 0;
  int64_t trail_pushes = 0;
  int64_t trail_pops = 0;
  int64_t max_trail_size = 0;
  int64_t max_search_stack_size = 0;
  int64_t activity_update_calls = 0;
  int64_t activity_updates_total = 0;
  int64_t rows_touched_total = 0;
  int64_t row_scans = 0;
  int64_t nnz_visits = 0;
  int64_t rows_enqueued = 0;
  int64_t rows_dequeued = 0;
  int64_t row_revisits = 0;
  int64_t unique_rows_touched = 0;
  int64_t max_queue_size = 0;
  long double queue_size_sum = 0.0;
  int64_t queue_size_samples = 0;
  int64_t bound_tightening_attempts = 0;
  int64_t full_scan_calls_after_initial = 0;
  int64_t singleton_scan_calls = 0;
  int64_t trail_reallocations = 0;
  int64_t repair_candidate_reallocations = 0;
  int64_t repair_temp_buffer_builds = 0;
  int64_t repeated_continuous_updates = 0;
  int64_t continuous_variables_tightened = 0;
  int64_t max_continuous_updates = 0;
  int64_t final_trail_size = 0;
  int64_t final_stack_size = 0;
  int64_t final_fixed = 0;
  int64_t final_direct = 0;
  int64_t final_propagated = 0;
  int64_t final_lp_calls = 0;
  bool final_feasible = false;
  double time_all_fixed = std::numeric_limits<double>::quiet_NaN();
  double completion_start_time = std::numeric_limits<double>::quiet_NaN();
  std::string completion_status = "NOT_CALLED";
  double completion_objective = std::numeric_limits<double>::quiet_NaN();

  double largest_propagation = 0.0;
  double best_violation = std::numeric_limits<double>::infinity();
  int active_variable = -1;
  int active_row = -1;
  int64_t active_propagation_id = 0;
  ProfileClock::time_point propagation_start;
  bool propagation_watchdog_printed = false;
  int64_t current_prop_rows = 0;
  int64_t current_prop_nnz = 0;
  int64_t current_prop_unique = 0;
  uint32_t row_seen_epoch = 0;
  std::vector<uint32_t> row_seen_stamp;
  std::vector<int64_t> rows_per_propagation;
  std::vector<int64_t> nnz_per_propagation;
  std::vector<int64_t> continuous_update_count;
  std::vector<int> column_period;
  std::vector<int> column_unit;
  std::vector<std::string> column_category;
  std::vector<std::string> row_category;
  std::map<std::string, CategoryCount> categories;
  std::vector<FixEvent> fixes;
  std::vector<RepairCall> repairs;
  std::vector<ProgressPoint> progress;

  static int lastBracketInteger(const std::string& name) {
    const size_t close = name.rfind(']');
    if (close == std::string::npos) return -1;
    size_t begin = name.rfind(',', close);
    if (begin == std::string::npos) begin = name.rfind('[', close);
    if (begin == std::string::npos || begin + 1 >= close) return -1;
    try { return std::stoi(name.substr(begin + 1, close - begin - 1)); }
    catch (...) { return -1; }
  }

  static int firstBracketInteger(const std::string& name) {
    const size_t open = name.find('[');
    if (open == std::string::npos) return -1;
    size_t end = name.find(',', open);
    if (end == std::string::npos) end = name.find(']', open);
    if (end == std::string::npos) return -1;
    try { return std::stoi(name.substr(open + 1, end - open - 1)); }
    catch (...) { return -1; }
  }

  static bool contains(const std::string& s, const std::string& p) {
    return s.find(p) != std::string::npos;
  }

  static std::string variableCategory(const std::string& name) {
    if (contains(name, "thermal_on") || contains(name, "commit") ||
        name.rfind("u[", 0) == 0 || name.rfind("alpha[", 0) == 0)
      return "THERMAL_COMMITMENT";
    if (contains(name, "startup") || contains(name, "start") ||
        name.rfind("beta[", 0) == 0) return "THERMAL_STARTUP";
    if (contains(name, "shutdown") || contains(name, "shut") ||
        name.rfind("gamma[", 0) == 0) return "THERMAL_SHUTDOWN";
    if (contains(name, "storage") && (contains(name, "mode") ||
        contains(name, "charge_status") || contains(name, "discharge_status")))
      return "STORAGE_MODE";
    return "OTHER_BINARY";
  }

  static std::string rowCategory(const std::string& name) {
    if (contains(name, "minimum_up") || contains(name, "min_up")) return "MIN_UP";
    if (contains(name, "minimum_down") || contains(name, "min_down")) return "MIN_DOWN";
    if (contains(name, "ramp")) return "RAMPING";
    if (contains(name, "balance")) return "POWER_BALANCE";
    if (contains(name, "reserve")) return "RESERVE";
    if (contains(name, "section")) return "SECTION";
    if (contains(name, "storage") && contains(name, "soc")) return "STORAGE_SOC";
    if (contains(name, "storage") && contains(name, "mode")) return "STORAGE_MODE";
    if (contains(name, "storage") && (contains(name, "power") || contains(name, "charge") || contains(name, "discharge"))) return "STORAGE_POWER";
    if (contains(name, "generation") || contains(name, "output") || contains(name, "limit")) return "GENERATION_LIMIT";
    if (contains(name, "thermal_state") || contains(name, "startup") || contains(name, "shutdown")) return "STARTUP_SHUTDOWN_LOGIC";
    return "OTHER";
  }

  void begin(const MIPModel& m, std::string strategy_value, uint64_t seed_value,
             double limit) {
    model = &m;
    strategy = std::move(strategy_value);
    seed = seed_value;
    limit_sec = limit;
    start = ProfileClock::now();
    next_progress = start + std::chrono::seconds(10);
    integer_total = static_cast<int64_t>(m.integer_columns.size());
    continuous_update_count.assign(m.n_cols, 0);
    row_seen_stamp.assign(m.n_rows, 0);
    column_period.assign(m.n_cols, -1);
    column_unit.assign(m.n_cols, -1);
    column_category.assign(m.n_cols, "OTHER_BINARY");
    row_category.assign(m.n_rows, "OTHER");
    for (int64_t j = 0; j < m.n_cols; ++j) {
      column_period[j] = lastBracketInteger(m.col_names[j]);
      column_unit[j] = firstBracketInteger(m.col_names[j]);
      column_category[j] = variableCategory(m.col_names[j]);
      if (integralType(m.var_type[j]) && std::abs(m.lb[j] - m.ub[j]) <= kBoundTolerance)
        ++integer_fixed_current;
    }
    for (int64_t i = 0; i < m.n_rows; ++i)
      if (i < static_cast<int64_t>(m.row_names.size())) row_category[i] = rowCategory(m.row_names[i]);
    integer_fixed_max = integer_fixed_current;
  }

  double elapsed() const { return secondsSince(start); }
  bool deadlineReached() {
    if (!time_limit && elapsed() >= limit_sec) time_limit = true;
    return time_limit;
  }

  void maybeProgress() {
    const auto now = ProfileClock::now();
    if (now < next_progress) return;
    ProgressPoint p{elapsed(), integer_fixed_current, fixing_attempts,
                    propagation_calls, bound_tightenings, repair_calls,
                    repair_successes, backtracks,
                    std::isfinite(best_violation) ? best_violation : -1.0};
    progress.push_back(p);
    std::cout << std::setprecision(12)
              << "FPR_PROGRESS time=" << p.time
              << " integer_fixed=" << p.fixed
              << " integer_remaining=" << (integer_total - p.fixed)
              << " fixing_attempts=" << p.attempts
              << " propagation_calls=" << p.propagation_calls
              << " bound_tightenings=" << p.bound_tightenings
              << " repair_calls=" << p.repair_calls
              << " repair_successes=" << p.repair_successes
              << " backtracks=" << p.backtracks
              << " best_violation=" << p.best_violation << '\n' << std::flush;
    while (next_progress <= now) next_progress += std::chrono::seconds(10);
  }

  void touchRow(int row) {
    ++rows_touched_total;
    if (!fixes.empty() && fixes.back().total_time == 0.0) fixes.back().touched_rows.insert(row);
  }

  void onDomainApplied(int j, double old_l, double old_u, double new_l,
                       double new_u, int64_t rows, double activity_sec) {
    const bool old_fixed = integralType(model->var_type[j]) && std::abs(old_l - old_u) <= kBoundTolerance;
    const bool new_fixed = integralType(model->var_type[j]) && std::abs(new_l - new_u) <= kBoundTolerance;
    if (!old_fixed && new_fixed) ++integer_fixed_current;
    if (old_fixed && !new_fixed) --integer_fixed_current;
    integer_fixed_max = std::max(integer_fixed_max, integer_fixed_current);
    if (integer_fixed_current == integer_total && !std::isfinite(time_all_fixed))
      time_all_fixed = elapsed();
    ++activity_update_calls;
    activity_updates_total += rows;
    t_activity[static_cast<int>(phase)] += activity_sec;
    if (!fixes.empty() && fixes.back().total_time == 0.0) {
      const int p = column_period[j];
      if (p >= 1 && p <= 96) {
        fixes.back().temporal_min = std::min(fixes.back().temporal_min, p);
        fixes.back().temporal_max = std::max(fixes.back().temporal_max, p);
      }
    }
  }

  void onTrailPush(bool reallocated, size_t size) {
    ++trail_pushes;
    if (reallocated) ++trail_reallocations;
    max_trail_size = std::max<int64_t>(max_trail_size, size);
  }

  void onDomainSet(double sec) { t_domain[static_cast<int>(phase)] += sec; }

  void onBacktrack(int64_t pops, int64_t levels, int64_t rows, double sec) {
    ++backtracks;
    trail_pops += pops;
    t_backtrack += sec;
    max_search_stack_size = std::max(max_search_stack_size, levels);
    (void)rows;
  }

  void beginPropagation(int change_step) {
    ++propagation_calls;
    active_propagation_id = propagation_calls;
    propagation_start = ProfileClock::now();
    propagation_watchdog_printed = false;
    current_prop_rows = 0;
    current_prop_nnz = 0;
    current_prop_unique = 0;
    ++row_seen_epoch;
    if (row_seen_epoch == 0) {
      std::fill(row_seen_stamp.begin(), row_seen_stamp.end(), 0);
      row_seen_epoch = 1;
    }
    (void)change_step;
  }

  void propagationHeartbeat(int row) {
    maybeProgress();
    const double event_elapsed = secondsSince(propagation_start);
    if (event_elapsed > 5.0 && !propagation_watchdog_printed) {
      std::cout << "FPR_LONG_EVENT event_type=PROPAGATION event_id="
                << active_propagation_id << " elapsed=" << event_elapsed
                << " variable=" << active_variable << " row=" << row
                << " repair_call=" << (repairs.empty() ? -1 : repairs.back().id)
                << " propagation_queue_size=0\n" << std::flush;
      propagation_watchdog_printed = true;
    }
  }

  void endPropagation(double sec) {
    t_propagation += sec;
    largest_propagation = std::max(largest_propagation, sec);
    rows_per_propagation.push_back(current_prop_rows);
    nnz_per_propagation.push_back(current_prop_nnz);
    if (active_propagation_id > 1 && current_prop_unique == model->n_rows)
      ++full_scan_calls_after_initial;
  }

  void addQueueTime(double sec) { t_queue += sec; }
  void onRowEnqueued(size_t queue_size) {
    ++rows_enqueued;
    max_queue_size = std::max<int64_t>(max_queue_size, queue_size);
    queue_size_sum += queue_size;
    ++queue_size_samples;
  }
  void onRowDequeued(int row, int64_t nnz, size_t queue_size) {
    ++rows_dequeued;
    ++current_prop_rows;
    current_prop_nnz += nnz;
    ++constraint_propagator_calls;
    ++propagators_processed;
    ++row_scans;
    nnz_visits += nnz;
    if (row_seen_stamp[row] == row_seen_epoch) {
      ++row_revisits;
    } else {
      row_seen_stamp[row] = row_seen_epoch;
      ++current_prop_unique;
      ++unique_rows_touched;
    }
    queue_size_sum += queue_size;
    ++queue_size_samples;
  }
  void onBoundTighteningAttempt() { ++bound_tightening_attempts; }

  void onPropagationRound() { ++propagation_rounds; }
  void onRowScan(int64_t nnz) {
    ++constraint_propagator_calls;
    ++propagators_processed;
    ++row_scans;
    nnz_visits += nnz;
  }
  void onRedundantRow() { ++redundant_constraints; }
  void onInfeasibleRow(int row) {
    ++infeasible_constraints;
    ++categories[row_category[row]].infeasibilities;
    active_row = row;
  }
  void onBoundTightening(int j, int row, double old_l, double old_u,
                         double new_l, double new_u) {
    int changes = 0;
    if (new_l > old_l + kBoundTolerance) ++changes;
    if (new_u < old_u - kBoundTolerance) ++changes;
    bound_tightenings += changes;
    categories[row_category[row]].bound_changes += changes;
    if (integralType(model->var_type[j])) {
      binary_bound_tightenings += changes;
      if (std::abs(old_l - old_u) > kBoundTolerance && std::abs(new_l - new_u) <= kBoundTolerance)
        ++propagation_fixing_events;
    } else {
      continuous_bound_tightenings += changes;
      if (continuous_update_count[j] == 0) ++continuous_variables_tightened;
      continuous_update_count[j] += changes;
      if (continuous_update_count[j] > changes) repeated_continuous_updates += changes;
      max_continuous_updates = std::max(max_continuous_updates, continuous_update_count[j]);
    }
    categories[row_category[row]].events++;
  }

  void beginFix(int j, double preferred, int64_t branch_count) {
    ++fixing_attempts;
    branch_nodes_created += branch_count;
    ++branch_nodes_processed;
    active_variable = j;
    FixEvent f;
    f.id = fixing_attempts;
    f.variable = j;
    f.name = model->col_names[j];
    f.type = model->var_type[j] == VarType::Binary ? "BINARY" : "INTEGER";
    f.period = column_period[j];
    f.unit = column_unit[j];
    f.preferred = preferred;
    f.start = ProfileClock::now();
    f.base_prop_time = t_propagation;
    f.base_prop_calls = propagation_calls;
    f.base_bound_changes = bound_tightenings;
    f.base_repair_time = t_repair;
    f.base_repair_iterations = repair_iterations;
    f.base_backtrack_time = t_backtrack;
    fixes.push_back(std::move(f));
  }

  void endFix(bool success) {
    if (fixes.empty()) return;
    FixEvent& f = fixes.back();
    f.total_time = secondsSince(f.start);
    f.propagation_time = t_propagation - f.base_prop_time;
    f.propagation_calls = propagation_calls - f.base_prop_calls;
    f.bound_changes = bound_tightenings - f.base_bound_changes;
    f.repair_time = t_repair - f.base_repair_time;
    f.repair_iterations = repair_iterations - f.base_repair_iterations;
    f.backtrack_time = t_backtrack - f.base_backtrack_time;
    f.repair_triggered = f.repair_time > 0.0;
    f.backtracking_triggered = f.backtrack_time > 0.0;
    f.rows_touched = static_cast<int64_t>(f.touched_rows.size());
    f.touched_rows.clear();
    f.success = success;
    if (success) ++successful_fixings; else ++failed_fixings;
    t_fixing_inclusive += f.total_time;
    if (f.total_time > 5.0)
      std::cout << "FPR_LONG_EVENT event_type=FIXING event_id=" << f.id
                << " elapsed=" << f.total_time << " variable=" << f.variable
                << " row=" << active_row << " repair_call="
                << (repairs.empty() ? -1 : repairs.back().id)
                << " propagation_queue_size=0\n" << std::flush;
    active_variable = -1;
    maybeProgress();
  }

  void beginRepair(int64_t id, int trigger, double initial) {
    ++repair_calls;
    RepairCall r;
    r.id = id;
    r.trigger_variable = trigger;
    r.initial_violation = initial;
    r.best_violation = initial;
    r.final_violation = initial;
    r.start = ProfileClock::now();
    repairs.push_back(r);
    best_violation = std::min(best_violation, initial);
  }

  void onRepairIteration(int row, int candidates, int reallocations,
                         double candidate_sec, double current_violation) {
    ++repair_iterations;
    RepairCall& r = repairs.back();
    ++r.iterations;
    r.violated_row = row;
    r.candidates_inspected += candidates;
    r.max_candidates = std::max(r.max_candidates, candidates);
    r.candidate_eval_time += candidate_sec;
    r.best_violation = std::min(r.best_violation, current_violation);
    t_candidate_evaluation += candidate_sec;
    repair_candidate_reallocations += reallocations;
    ++repair_temp_buffer_builds;
    categories[row_category[row]].repair_triggers++;
    best_violation = std::min(best_violation, current_violation);
    maybeProgress();
    const double e = secondsSince(r.start);
    if (e > 5.0 && !r.watchdog_printed) {
      std::cout << "FPR_LONG_EVENT event_type=REPAIR event_id=" << r.id
                << " elapsed=" << e << " variable=" << r.trigger_variable
                << " row=" << row << " repair_call=" << r.id
                << " propagation_queue_size=0\n" << std::flush;
      r.watchdog_printed = true;
    }
  }

  void onRepairMove(bool earlier) {
    ++repair_variable_changes;
    ++repairs.back().selected_variables;
    if (earlier) {
      ++earlier_fixings_modified;
      repairs.back().earlier_modified = true;
    }
  }

  void endRepair(bool success, double final_violation) {
    RepairCall& r = repairs.back();
    r.elapsed = secondsSince(r.start);
    r.final_violation = final_violation;
    r.success = success;
    t_repair += r.elapsed;
    if (success) ++repair_successes; else ++repair_failures;
    best_violation = std::min(best_violation, final_violation);
  }

  void finish(double total, bool feasible, int64_t fixed, int64_t direct,
              int64_t propagated, int64_t trail, int64_t stack,
              int64_t completion_calls, double completion_time) {
    t_total = total;
    final_feasible = feasible;
    final_fixed = fixed;
    final_direct = direct;
    final_propagated = propagated;
    final_trail_size = trail;
    final_stack_size = stack;
    final_lp_calls = completion_calls;
    t_completion = completion_time;
    termination = time_limit ? "TIME_LIMIT" : (feasible ? "FEASIBLE" : "INFEASIBLE");
    maybeProgress();
  }

  void writeFiles(const std::string& output_dir) const {
    namespace fs = std::filesystem;
    fs::create_directories(output_dir);
    std::ofstream s(fs::path(output_dir) / "profile_summary.tsv");
    s << std::setprecision(17);
    auto kv = [&](const std::string& k, auto v) { s << k << '\t' << v << '\n'; };
    kv("strategy", strategy); kv("seed", seed); kv("termination", termination);
    kv("t_total", t_total); kv("t_initialization", t_initialization);
    kv("t_ranking", t_ranking); kv("t_fixing_inclusive", t_fixing_inclusive);
    kv("t_propagation", t_propagation); kv("t_repair", t_repair);
    kv("t_backtrack", t_backtrack); kv("t_branch_generation", t_branch_generation);
    kv("t_singleton_scans", t_singleton_scans); kv("t_completion", t_completion);
    kv("t_final_evaluation", t_final_evaluation); kv("t_candidate_evaluation", t_candidate_evaluation);
    for (int i = 0; i < 6; ++i) { kv("t_activity_" + std::to_string(i), t_activity[i]); kv("t_domain_" + std::to_string(i), t_domain[i]); }
    kv("integer_total", integer_total); kv("integer_fixed", final_fixed);
    kv("integer_unfixed", integer_total - final_fixed); kv("direct_fixings", final_direct);
    kv("propagation_fixings", final_propagated); kv("fixing_attempts", fixing_attempts);
    kv("successful_fixings", successful_fixings); kv("failed_fixings", failed_fixings);
    kv("branch_nodes_created", branch_nodes_created); kv("branch_nodes_processed", branch_nodes_processed);
    kv("propagation_calls", propagation_calls); kv("propagation_rounds", propagation_rounds);
    kv("constraint_propagator_calls", constraint_propagator_calls); kv("bound_tightenings", bound_tightenings);
    kv("binary_bound_tightenings", binary_bound_tightenings); kv("continuous_bound_tightenings", continuous_bound_tightenings);
    kv("constraints_infeasible", infeasible_constraints); kv("constraints_redundant", redundant_constraints);
    kv("repair_calls", repair_calls); kv("repair_iterations", repair_iterations);
    kv("repair_successes", repair_successes); kv("repair_failures", repair_failures);
    kv("repair_variable_changes", repair_variable_changes); kv("earlier_fixings_modified", earlier_fixings_modified);
    kv("backtracks", backtracks); kv("trail_pushes", trail_pushes); kv("trail_pops", trail_pops);
    kv("max_trail_size", max_trail_size); kv("max_search_stack_size", max_search_stack_size);
    kv("final_trail_size", final_trail_size); kv("final_stack_size", final_stack_size);
    kv("activity_update_calls", activity_update_calls); kv("activity_updates_total", activity_updates_total);
    kv("rows_touched_total", rows_touched_total); kv("row_scans", row_scans); kv("nnz_visits", nnz_visits);
    kv("singleton_scan_calls", singleton_scan_calls); kv("trail_reallocations", trail_reallocations);
    kv("repair_candidate_reallocations", repair_candidate_reallocations); kv("repair_temp_buffer_builds", repair_temp_buffer_builds);
    kv("continuous_variables_tightened", continuous_variables_tightened); kv("repeated_continuous_updates", repeated_continuous_updates);
    kv("max_continuous_updates", max_continuous_updates); kv("largest_propagation", largest_propagation);
    kv("final_lp_calls", final_lp_calls); kv("final_feasible", final_feasible ? 1 : 0);
    kv("time_limit", time_limit ? 1 : 0);

    std::ofstream f(fs::path(output_dir) / "fix_events.tsv"); f << std::setprecision(17);
    f << "id\tvariable\tname\ttype\tperiod\tunit\tpreferred\ttotal_time\tpropagation_time\tpropagation_calls\tbound_changes\trepair_triggered\trepair_time\trepair_iterations\tbacktracking_triggered\tbacktrack_time\trows_touched\ttemporal_min\ttemporal_max\tsuccess\n";
    for (const auto& x : fixes) f << x.id << '\t' << x.variable << '\t' << x.name << '\t' << x.type << '\t' << x.period << '\t' << x.unit << '\t' << x.preferred << '\t' << x.total_time << '\t' << x.propagation_time << '\t' << x.propagation_calls << '\t' << x.bound_changes << '\t' << x.repair_triggered << '\t' << x.repair_time << '\t' << x.repair_iterations << '\t' << x.backtracking_triggered << '\t' << x.backtrack_time << '\t' << x.rows_touched << '\t' << (x.temporal_min == 1000000000 ? -1 : x.temporal_min) << '\t' << x.temporal_max << '\t' << x.success << '\n';

    std::ofstream r(fs::path(output_dir) / "repair_calls.tsv"); r << std::setprecision(17);
    r << "id\ttrigger_variable\tviolated_row\tinitial_violation\tbest_violation\tfinal_violation\titerations\tcandidates_inspected\tselected_variables\tearlier_modified\tsuccess\telapsed\tcandidate_eval_time\tmax_candidates\n";
    for (const auto& x : repairs) r << x.id << '\t' << x.trigger_variable << '\t' << x.violated_row << '\t' << x.initial_violation << '\t' << x.best_violation << '\t' << x.final_violation << '\t' << x.iterations << '\t' << x.candidates_inspected << '\t' << x.selected_variables << '\t' << x.earlier_modified << '\t' << x.success << '\t' << x.elapsed << '\t' << x.candidate_eval_time << '\t' << x.max_candidates << '\n';

    std::ofstream p(fs::path(output_dir) / "progress.tsv"); p << std::setprecision(17);
    p << "time\tfixed\tattempts\tpropagation_calls\tbound_tightenings\trepair_calls\trepair_successes\tbacktracks\tbest_violation\n";
    for (const auto& x : progress) p << x.time << '\t' << x.fixed << '\t' << x.attempts << '\t' << x.propagation_calls << '\t' << x.bound_tightenings << '\t' << x.repair_calls << '\t' << x.repair_successes << '\t' << x.backtracks << '\t' << x.best_violation << '\n';

    std::ofstream c(fs::path(output_dir) / "categories.tsv");
    c << "category\tevents\tbound_changes\tinfeasibilities\trepair_triggers\ttime\n";
    for (const auto& [name, x] : categories) c << name << '\t' << x.events << '\t' << x.bound_changes << '\t' << x.infeasibilities << '\t' << x.repair_triggers << '\t' << x.time << '\n';
  }
};

inline FprProfile* g_profile = nullptr;

struct ScopedPhase {
  Phase old;
  explicit ScopedPhase(Phase value) : old(g_profile ? g_profile->phase : Phase::Other) {
    if (g_profile) g_profile->phase = value;
  }
  ~ScopedPhase() { if (g_profile) g_profile->phase = old; }
};

}  // namespace chap_profile
