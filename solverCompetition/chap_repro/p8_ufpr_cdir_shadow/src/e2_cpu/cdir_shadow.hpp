#pragma once

constexpr double kCdirRho = 0.5;
constexpr double kCdirTransferEps = 1e-6;

CdirZone cdirZone(double p, double pmin, double pmax) {
  if (!std::isfinite(p) || p < -kCdirTransferEps ||
      p > pmax + kCdirTransferEps) return CdirZone::Outside;
  if (std::abs(p) <= kCdirTransferEps) return CdirZone::Zero;
  if (p < kCdirRho * pmin) return CdirZone::Low;
  if (p < pmin) return CdirZone::Mid;
  return CdirZone::Normal;
}

int cdirDirection(CdirZone zone, double xi, double psi) {
  if (zone == CdirZone::Low) {
    if (xi > kCdirTransferEps) return 0;
    if (xi < -kCdirTransferEps && psi > kCdirTransferEps) return 1;
  } else if (zone == CdirZone::Mid) {
    if (psi > kCdirTransferEps) return 1;
    if (psi < -kCdirTransferEps && xi > kCdirTransferEps) return 0;
  }
  return -1;
}

struct CdirRowTerm { int column; double coefficient; };
struct CdirLocalRow {
  double lower, upper;
  std::vector<CdirRowTerm> terms;
  int original_row = -1;
};
struct CdirRampRow {
  double target_coefficient = 0.0;
  double continuous_reference = 0.0;
  double lower = -1e30, upper = 1e30;
  std::vector<CdirRowTerm> binaries;
};
struct CdirCell {
  int alpha = -1, startup = -1, shutdown = -1, dispatch = -1;
  int previous_alpha = -1;
  double p = 0.0, alpha_ref = 0.0, pmin = 0.0, pmax = 0.0;
  std::vector<CdirRampRow> ramps;
  std::vector<CdirLocalRow> logic;
};

// Read-only task-local cache. Reference values are the ORIGINAL LP primal;
// they are never clamped to subsequent FPR domains or replaced by partials.
struct CdirContext {
  int units = 0, periods = 0;
  bool validated = false, reference_available = false;
  std::vector<CdirCell> cells;
  std::vector<std::vector<int>> dependent_cells;
  mutable std::vector<char> dirty;
  mutable std::vector<std::pair<double,double>> capability_cache;
  mutable size_t observed_trail = 0;
  mutable int64_t observed_backtracks = -1;
  CdirContext(const MIPModel& model, const UcModelMap& map,
              const std::vector<double>* reference) {
    units = map.thermal_units; periods = map.periods;
    validated = map.power_transfer_mapping_validated;
    reference_available = reference &&
        reference->size() == static_cast<size_t>(model.n_cols);
    if (!validated || !reference_available) return;
    cells.resize(units * periods);
    dependent_cells.resize(model.n_cols);
    dirty.assign(cells.size(),1);capability_cache.resize(cells.size());
    std::vector<std::vector<int>> logic_by_column(model.n_cols);
    for (int r = 0; r < model.n_rows; ++r) {
      const auto& name = model.row_names[r];
      if (name.rfind("thermal_state[", 0) != 0 &&
          name.rfind("thermal_initial_state[", 0) != 0 &&
          name.rfind("thermal_initial_freeze[", 0) != 0 &&
          name.rfind("thermal_minimum_up[", 0) != 0 &&
          name.rfind("thermal_minimum_down[", 0) != 0) continue;
      for (HighsInt k = model.row_start[r]; k < model.row_start[r+1]; ++k)
        logic_by_column[model.row_index[k]].push_back(r);
    }
    for (int i = 0; i < units; ++i) for (int t = 0; t < periods; ++t) {
      auto& cell = cells[i*periods+t];
      cell.alpha = map.commitment[i][t];
      cell.startup = map.startup[i][t]; cell.shutdown = map.shutdown[i][t];
      cell.dispatch = map.dispatch[i][t];
      cell.previous_alpha = t ? map.commitment[i][t-1] : -1;
      cell.p = (*reference)[cell.dispatch];
      cell.alpha_ref = (*reference)[cell.alpha];
      cell.pmin = map.pmin[i][t]; cell.pmax = map.pmax[i][t];
      reference_available = reference_available && std::isfinite(cell.p) &&
          std::isfinite(cell.alpha_ref);
      std::vector<int> rows;
      for (int c : {cell.alpha, cell.startup, cell.shutdown})
        rows.insert(rows.end(), logic_by_column[c].begin(), logic_by_column[c].end());
      std::sort(rows.begin(), rows.end());
      rows.erase(std::unique(rows.begin(), rows.end()), rows.end());
      std::vector<int> dependencies{cell.alpha,cell.startup,cell.shutdown,cell.dispatch};
      if(cell.previous_alpha>=0)dependencies.push_back(cell.previous_alpha);
      for (int r : rows) {
        CdirLocalRow row{model.row_lb[r], model.row_ub[r], {}, r};
        for (HighsInt k = model.row_start[r]; k < model.row_start[r+1]; ++k) {
          const int c = model.row_index[k];
          dependencies.push_back(c);
          if(c==cell.alpha || c==cell.startup || c==cell.shutdown || c==cell.previous_alpha)
            row.terms.push_back({c,model.row_value[k]});
        }
        cell.logic.push_back(std::move(row));
      }
      std::vector<int> ramp_rows{map.ramp_up_row[i][t], map.ramp_down_row[i][t]};
      if (t+1 < periods) {
        ramp_rows.push_back(map.ramp_up_row[i][t+1]);
        ramp_rows.push_back(map.ramp_down_row[i][t+1]);
      }
      for (int r : ramp_rows) {
        CdirRampRow row;
        row.lower = model.row_lb[r]; row.upper = model.row_ub[r];
        for (HighsInt k = model.row_start[r]; k < model.row_start[r+1]; ++k) {
          const int c = model.row_index[k]; const double a = model.row_value[k];
          if (c == cell.dispatch) row.target_coefficient += a;
          else if (map.col_kind[c]) row.binaries.push_back({c, a});
          else row.continuous_reference += a * (*reference)[c];
        }
        if (std::abs(row.target_coefficient) > 1e-15)
          cell.ramps.push_back(std::move(row));
      }
      for(const auto& row:cell.ramps)for(const auto& term:row.binaries)dependencies.push_back(term.column);
      std::sort(dependencies.begin(),dependencies.end());
      dependencies.erase(std::unique(dependencies.begin(),dependencies.end()),dependencies.end());
      for(int c:dependencies)dependent_cells[c].push_back(i*periods+t);
    }
  }
  void sync(const ReversibleDomains& domains,int64_t backtracks) const {
    const auto& trail=domains.trailEntries();
    if(observed_backtracks!=backtracks || trail.size()<observed_trail) {
      std::fill(dirty.begin(),dirty.end(),1);
      observed_trail=trail.size();observed_backtracks=backtracks;return;
    }
    for(size_t p=observed_trail;p<trail.size();++p)
      for(int cell:dependent_cells[trail[p].column])dirty[cell]=1;
    observed_trail=trail.size();
  }
};

bool cdirAllows(const ReversibleDomains& domains, int c, int value) {
  return c >= 0 && domains.lower(c) <= value + kBoundTolerance &&
         domains.upper(c) >= value - kBoundTolerance;
}

// Enumerate only (alpha_t,u_t,d_t); all other binary terms use their current
// interval. Reject locally impossible transitions/min-up/down/freeze states.
// This is an optimistic local bound, NOT a full UC feasibility proof.
std::pair<double,double> cdirOutputInterval(
    const CdirCell& cell, const ReversibleDomains& domains,
    int alpha, int startup, int shutdown) {
  if (!cdirAllows(domains, cell.alpha, alpha) ||
      !cdirAllows(domains, cell.startup, startup) ||
      !cdirAllows(domains, cell.shutdown, shutdown) || startup+shutdown > 1)
    return {1.0, 0.0};
  auto interval = [&](int c) -> std::pair<double,double> {
    if (c == cell.alpha) return {double(alpha),double(alpha)};
    if (c == cell.startup) return {double(startup),double(startup)};
    if (c == cell.shutdown) return {double(shutdown),double(shutdown)};
    if (c == cell.previous_alpha) {
      const int previous = alpha-startup+shutdown;
      if (!cdirAllows(domains,c,previous)) return {1.0,0.0};
      return {double(previous),double(previous)};
    }
    return {domains.lower(c),domains.upper(c)};
  };
  for (const auto& row : cell.logic) {
    // Existing incremental row activities are read only. Apply hypothetical
    // local binary substitutions to scalar copies, never to FPR state.
    double lo = row.original_row>=0 ? domains.rowMin(row.original_row) : 0.0;
    double hi = row.original_row>=0 ? domains.rowMax(row.original_row) : 0.0;
    for (const auto& term : row.terms) {
      auto [l,u] = interval(term.column);
      if (l > u) return {1.0,0.0};
      lo += term.coefficient*(term.coefficient < 0 ? u : l);
      hi += term.coefficient*(term.coefficient < 0 ? l : u);
      if(row.original_row>=0) {
        lo -= term.coefficient*(term.coefficient<0 ? domains.upper(term.column):domains.lower(term.column));
        hi -= term.coefficient*(term.coefficient<0 ? domains.lower(term.column):domains.upper(term.column));
      }
    }
    if (lo > row.upper+kConstraintTolerance || hi < row.lower-kConstraintTolerance)
      return {1.0,0.0};
  }
  double lo = std::max(domains.lower(cell.dispatch),cell.pmin*alpha);
  double hi = std::min(domains.upper(cell.dispatch),cell.pmax*alpha);
  for (const auto& row : cell.ramps) {
    double minimum_other = row.continuous_reference;
    double maximum_other = row.continuous_reference;
    for (const auto& term : row.binaries) {
      auto [l,u] = interval(term.column);
      if (l > u) return {1.0,0.0};
      minimum_other += term.coefficient*(term.coefficient < 0 ? u : l);
      maximum_other += term.coefficient*(term.coefficient < 0 ? l : u);
    }
    const double a = row.target_coefficient;
    if (finiteUpper(row.upper)) {
      const double bound = (row.upper-minimum_other)/a;
      if (a > 0) hi = std::min(hi,bound); else lo = std::max(lo,bound);
    }
    if (finiteLower(row.lower)) {
      const double bound = (row.lower-maximum_other)/a;
      if (a > 0) lo = std::max(lo,bound); else hi = std::min(hi,bound);
    }
  }
  return {lo,hi};
}

std::pair<double,double> cdirDonorCapabilities(
    const CdirCell& cell, const ReversibleDomains& domains) {
  double minimum = std::numeric_limits<double>::infinity();
  double maximum = -std::numeric_limits<double>::infinity();
  for (int alpha = 0; alpha <= 1; ++alpha)
    for (int u = 0; u <= 1; ++u) for (int d = 0; d <= 1; ++d) {
      auto [lo,hi] = cdirOutputInterval(cell,domains,alpha,u,d);
      if (lo <= hi + kConstraintTolerance) {
        minimum = std::min(minimum,lo); maximum = std::max(maximum,hi);
      }
    }
  const double up = std::isfinite(maximum) ? std::max(0.0,maximum-cell.p) : 0.0;
  const double down = std::isfinite(minimum) ? std::max(0.0,cell.p-minimum) : 0.0;
  return {up,down};
}

int cdirObserve(const CdirContext& context, const UcModelMap& map,
                const ReversibleDomains& domains, int column,
                int generic_direction, int64_t backtrack_generation,
                CdirMetrics& metrics) {
  const auto start = Clock::now();
  ++metrics.generic_decisions;
  metrics.decision_hash ^= uint64_t(column)*3+uint64_t(generic_direction+1);
  metrics.decision_hash *= 1099511628211ULL;
  if (column < 0 || column >= static_cast<int>(map.col_kind.size()) ||
      map.col_kind[column] != 'c') return -1;
  ++metrics.alpha_decisions;
  if (!context.validated || !context.reference_available) {
    ++metrics.missing_references; return -1;
  }
  const int unit = map.col_unit[column], period = map.col_time[column];
  const auto& selected = context.cells[unit*context.periods+period];
  if (!(selected.alpha_ref > kIntegerTolerance &&
        selected.alpha_ref < 1.0-kIntegerTolerance)) {
    ++metrics.integral_references; return -1;
  }
  ++metrics.fractional_references;
  CdirEvent event;
  event.column = column; event.unit = unit; event.period = period;
  event.alpha_ref = selected.alpha_ref; event.p_ref = selected.p;
  event.generic_direction = generic_direction;
  event.zone = cdirZone(selected.p,selected.pmin,selected.pmax);
  event.fingerprint = (uint64_t(column)+1)*1099511628211ULL;
  for (uint64_t value : {uint64_t(domains.trailPointer()),
       uint64_t(backtrack_generation), uint64_t(std::llround(domains.lower(column))),
       uint64_t(std::llround(domains.upper(column)))}) {
    event.fingerprint ^= value; event.fingerprint *= 1099511628211ULL;
  }
  double total_up = 0.0, total_down = 0.0;
  const auto transfer_start = Clock::now();
  const bool cached=context.dirty.size()==context.cells.size();
  if(cached)context.sync(domains,backtrack_generation);
  for (int i = 0; i < context.units; ++i) {
    if (i == unit) continue;
    const int cell=i*context.periods+period;
    std::pair<double,double> capability;
    if(cached) {
      if(context.dirty[cell]) {
        context.capability_cache[cell]=cdirDonorCapabilities(context.cells[cell],domains);
        context.dirty[cell]=0;
      }
      capability=context.capability_cache[cell];
    } else capability=cdirDonorCapabilities(context.cells[cell],domains);
    auto [up,down]=capability;
    total_up += up; total_down += down;
    if (up > kCdirTransferEps) ++event.up_donors;
    if (down > kCdirTransferEps) ++event.down_donors;
  }
  // Shared donor envelope calculation is timed once; do not double count.
  const double transfer_time = std::chrono::duration<double>(
      Clock::now()-transfer_start).count();
  metrics.xi_time += transfer_time;
  const auto psi_start = Clock::now();
  event.xi = total_up-selected.p;
  event.psi = total_down+selected.p-selected.pmin;
  metrics.psi_time += std::chrono::duration<double>(Clock::now()-psi_start).count();
  const auto classification_start = Clock::now();
  event.direction = cdirDirection(event.zone,event.xi,event.psi);
  metrics.events.push_back(event);
  metrics.classification_time += std::chrono::duration<double>(
      Clock::now()-classification_start).count();
  const double elapsed = std::chrono::duration<double>(Clock::now()-start).count();
  metrics.total_time += elapsed; metrics.max_time = std::max(metrics.max_time,elapsed);
  return static_cast<int>(metrics.events.size()-1);
}
