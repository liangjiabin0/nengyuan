#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>

namespace chap::lpfix {

enum class Strategy { Frac, RedCost, Dual, Type };
enum class IntegerKind { Binary, General };
enum class BranchKind { Fix, LowerRange, UpperRange };

struct SnapshotView {
  int64_t checkpoint = 0;
  const std::vector<double>* primal = nullptr;
  const std::vector<double>* dual = nullptr;
  const std::vector<double>* reduced_cost = nullptr;
};

struct SparseRowsView {
  int64_t num_rows = 0;
  int64_t num_cols = 0;
  const std::vector<int>* row_start = nullptr;
  const std::vector<int>* row_index = nullptr;
};

struct OrderEntry {
  int column = -1;
  int selected_row = -1;
};

struct ValueChoice {
  double x_lp = 0.0;
  double low = 0.0;
  double high = 0.0;
  double fractional_part = 0.0;
  double random_draw = std::numeric_limits<double>::quiet_NaN();
  double preferred = 0.0;
};

struct Branch {
  double lower = 0.0;
  double upper = 0.0;
  BranchKind kind = BranchKind::Fix;
};

inline const char* strategyName(Strategy strategy) {
  switch (strategy) {
    case Strategy::Frac: return "FRAC";
    case Strategy::RedCost: return "REDCOST";
    case Strategy::Dual: return "DUAL";
    case Strategy::Type: return "TYPE";
  }
  return "UNKNOWN";
}

inline const char* branchName(BranchKind kind) {
  switch (kind) {
    case BranchKind::Fix: return "FIX";
    case BranchKind::LowerRange: return "LOWER_RANGE";
    case BranchKind::UpperRange: return "UPPER_RANGE";
  }
  return "UNKNOWN";
}

inline double fractionality(double value) {
  const double floor_value = std::floor(value);
  const double ceil_value = std::ceil(value);
  return std::min(value - floor_value, ceil_value - value);
}

inline void validateSnapshot(const SnapshotView& snapshot, int64_t num_rows,
                             int64_t num_cols) {
  if (!snapshot.primal || !snapshot.dual || !snapshot.reduced_cost)
    throw std::runtime_error("LP fixing snapshot is missing x/y/rc");
  if (snapshot.primal->size() != static_cast<size_t>(num_cols) ||
      snapshot.reduced_cost->size() != static_cast<size_t>(num_cols) ||
      snapshot.dual->size() != static_cast<size_t>(num_rows))
    throw std::runtime_error("LP fixing snapshot dimension mismatch");
}

inline std::vector<OrderEntry> buildOrder(
    Strategy strategy, const SnapshotView& snapshot,
    const SparseRowsView& rows, const std::vector<int>& integer_columns,
    const std::vector<IntegerKind>& integer_kind, bool frac_closest_first = true) {
  validateSnapshot(snapshot, rows.num_rows, rows.num_cols);
  if (integer_kind.size() != static_cast<size_t>(rows.num_cols))
    throw std::runtime_error("integer kind dimension mismatch");

  std::vector<OrderEntry> order;
  order.reserve(integer_columns.size());
  if (strategy == Strategy::Type) {
    for (int j : integer_columns)
      if (integer_kind[j] == IntegerKind::Binary) order.push_back({j, -1});
    for (int j : integer_columns)
      if (integer_kind[j] == IntegerKind::General) order.push_back({j, -1});
    return order;
  }

  if (strategy == Strategy::Dual) {
    if (!rows.row_start || !rows.row_index)
      throw std::runtime_error("Dual strategy requires sparse row access");
    std::vector<int> row_order(rows.num_rows);
    for (int64_t i = 0; i < rows.num_rows; ++i) row_order[i] = static_cast<int>(i);
    std::stable_sort(row_order.begin(), row_order.end(), [&](int a, int b) {
      const double lhs = std::abs((*snapshot.dual)[a]);
      const double rhs = std::abs((*snapshot.dual)[b]);
      if (std::abs(lhs - rhs) > 1e-15) return lhs > rhs;
      return a < b;
    });
    std::vector<char> is_integer(rows.num_cols, 0);
    std::vector<char> inserted(rows.num_cols, 0);
    for (int j : integer_columns) is_integer[j] = 1;
    for (int row : row_order) {
      std::vector<int> row_columns;
      for (int p = (*rows.row_start)[row]; p < (*rows.row_start)[row + 1]; ++p) {
        const int j = (*rows.row_index)[p];
        if (is_integer[j] && !inserted[j]) row_columns.push_back(j);
      }
      std::sort(row_columns.begin(), row_columns.end());
      row_columns.erase(std::unique(row_columns.begin(), row_columns.end()),
                        row_columns.end());
      std::stable_sort(row_columns.begin(), row_columns.end(), [&](int a, int b) {
        const double lhs = std::abs((*snapshot.reduced_cost)[a]);
        const double rhs = std::abs((*snapshot.reduced_cost)[b]);
        if (std::abs(lhs - rhs) > 1e-15) return lhs > rhs;
        return a < b;
      });
      for (int j : row_columns) {
        if (inserted[j]) continue;
        inserted[j] = 1;
        order.push_back({j, row});
      }
    }
    std::vector<int> remaining;
    for (int j : integer_columns)
      if (!inserted[j]) remaining.push_back(j);
    std::stable_sort(remaining.begin(), remaining.end(), [&](int a, int b) {
      const double lhs = std::abs((*snapshot.reduced_cost)[a]);
      const double rhs = std::abs((*snapshot.reduced_cost)[b]);
      if (std::abs(lhs - rhs) > 1e-15) return lhs > rhs;
      return a < b;
    });
    for (int j : remaining) order.push_back({j, -1});
    return order;
  }

  std::vector<int> columns = integer_columns;
  std::stable_sort(columns.begin(), columns.end(), [&](int a, int b) {
    double lhs = 0.0;
    double rhs = 0.0;
    if (strategy == Strategy::Frac) {
      lhs = fractionality((*snapshot.primal)[a]);
      rhs = fractionality((*snapshot.primal)[b]);
      if (std::abs(lhs - rhs) > 1e-15)
        return frac_closest_first ? lhs < rhs : lhs > rhs;
    } else {
      lhs = std::abs((*snapshot.reduced_cost)[a]);
      rhs = std::abs((*snapshot.reduced_cost)[b]);
      if (std::abs(lhs - rhs) > 1e-15) return lhs > rhs;
    }
    return a < b;
  });
  for (int j : columns) order.push_back({j, -1});
  return order;
}

inline ValueChoice chooseValue(double x_lp, double current_lower,
                               double current_upper, double integer_tolerance,
                               std::mt19937_64& rng) {
  const double domain_lower = std::ceil(current_lower - 1e-12);
  const double domain_upper = std::floor(current_upper + 1e-12);
  if (domain_lower > domain_upper)
    throw std::runtime_error("empty integer domain in LP value selection");

  ValueChoice choice;
  choice.x_lp = x_lp;
  const double raw_low = std::floor(x_lp);
  const double raw_high = std::ceil(x_lp);
  choice.low = std::max(domain_lower, std::min(domain_upper, raw_low));
  choice.high = std::max(domain_lower, std::min(domain_upper, raw_high));
  choice.fractional_part = x_lp - raw_low;

  if (std::abs(x_lp - std::round(x_lp)) <= integer_tolerance ||
      std::abs(choice.low - choice.high) <= integer_tolerance) {
    choice.preferred = std::max(
        domain_lower, std::min(domain_upper, std::round(x_lp)));
    choice.low = choice.high = choice.preferred;
    return choice;
  }

  std::uniform_real_distribution<double> draw(0.0, 1.0);
  choice.random_draw = draw(rng);
  choice.preferred =
      choice.random_draw > choice.fractional_part ? choice.low : choice.high;
  return choice;
}

inline std::vector<Branch> buildBranches(double current_lower,
                                         double current_upper,
                                         double preferred,
                                         double objective_coefficient,
                                         bool minimize) {
  const double lower = std::ceil(current_lower - 1e-12);
  const double upper = std::floor(current_upper + 1e-12);
  const double value = std::max(lower, std::min(upper, std::round(preferred)));
  std::vector<Branch> branches;
  branches.push_back({value, value, BranchKind::Fix});
  if (lower >= upper) return branches;

  if (value <= lower) {
    if (std::isfinite(upper))
      branches.push_back({upper, upper, BranchKind::Fix});
    else
      branches.push_back({value + 1.0, current_upper, BranchKind::UpperRange});
    return branches;
  }
  if (value >= upper) {
    if (std::isfinite(lower))
      branches.push_back({lower, lower, BranchKind::Fix});
    else
      branches.push_back({current_lower, value - 1.0, BranchKind::LowerRange});
    return branches;
  }

  const Branch lower_branch{current_lower, value - 1.0,
                            BranchKind::LowerRange};
  const Branch upper_branch{value + 1.0, current_upper,
                            BranchKind::UpperRange};
  const double effective_cost = minimize ? objective_coefficient
                                         : -objective_coefficient;
  if (effective_cost > 0.0) {
    branches.push_back(lower_branch);
    branches.push_back(upper_branch);
  } else {
    branches.push_back(upper_branch);
    branches.push_back(lower_branch);
  }
  return branches;
}

}  // namespace chap::lpfix
