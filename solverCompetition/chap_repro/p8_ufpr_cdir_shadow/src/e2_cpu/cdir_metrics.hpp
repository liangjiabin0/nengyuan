#pragma once

enum class CdirZone { Low, Mid, Normal, Zero, Outside };
struct CdirEvent {
  uint64_t fingerprint = 0;
  int column = -1, unit = -1, period = -1;
  int generic_direction = -1, direction = -1;
  CdirZone zone = CdirZone::Outside;
  double alpha_ref = 0.0, p_ref = 0.0, xi = 0.0, psi = 0.0;
  int up_donors = 0, down_donors = 0;
  bool propagation_ok = false, contradiction = false;
  bool opposite_tried = false, backtracked = false, repairwalk = false;
  double repairwalk_time = 0.0;
};
struct CdirMetrics {
  int64_t generic_decisions = 0, alpha_decisions = 0;
  int64_t fractional_references = 0, integral_references = 0;
  int64_t missing_references = 0;
  bool model_validated = false, reference_available = false;
  double total_time = 0.0, xi_time = 0.0, psi_time = 0.0;
  double classification_time = 0.0, max_time = 0.0;
  uint64_t decision_hash = 1469598103934665603ULL;
  std::vector<CdirEvent> events;
};
