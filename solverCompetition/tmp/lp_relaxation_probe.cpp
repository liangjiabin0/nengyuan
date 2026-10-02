#include "cupdlpx.h"
#include "mps_parser.h"
#include <chrono>
#include <climits>
#include <iomanip>
#include <iostream>

int main(int argc, char** argv) {
  if (argc != 2) return 2;
  using Clock = std::chrono::steady_clock;
  const auto start = Clock::now();
  auto* problem = read_mps_file(argv[1]);
  if (!problem) return 3;
  const auto loaded = Clock::now();
  pdhg_parameters_t parameters;
  set_default_parameters(&parameters);
  parameters.presolve = false;
  parameters.verbose = true;
  parameters.termination_evaluation_frequency = 100;
  parameters.termination_criteria.iteration_limit = INT_MAX;
  parameters.termination_criteria.time_sec_limit = 3600.0;
  cupdlpx_set_random_seed(0);
  std::cout << std::setprecision(12)
            << "LP_ONLY=YES\nINTEGER_RESTRICTIONS_ENFORCED=NO\nPRESOLVE=OFF\n"
            << "SEED=0\nITERATION_LIMIT=" << INT_MAX
            << "\nTIME_LIMIT_SEC=3600\nEPS_OPT="
            << parameters.termination_criteria.eps_optimal_relative
            << "\nEPS_FEAS=" << parameters.termination_criteria.eps_feasible_relative
            << "\nMODEL_READ_TIME_SEC="
            << std::chrono::duration<double>(loaded-start).count() << std::endl;
  const auto solve_start = Clock::now();
  auto* result = solve_lp_problem(problem, &parameters);
  const auto solved = Clock::now();
  if (!result) { lp_problem_free(problem); return 4; }
  const char* names[] = {"UNSPECIFIED", "OPTIMAL", "PRIMAL_INFEASIBLE",
      "DUAL_INFEASIBLE", "INFEASIBLE_OR_UNBOUNDED", "TIME_LIMIT",
      "ITERATION_LIMIT", "FEAS_POLISH_SUCCESS"};
  const auto reason = static_cast<unsigned>(result->termination_reason);
  std::cout << "LP_RESULT_BEGIN\nSTATUS=" << (reason < 8 ? names[reason] : "UNKNOWN")
            << "\nITERATIONS=" << result->total_count
            << "\nSOLVER_REPORTED_TIME_SEC=" << result->cumulative_time_sec
            << "\nSOLVE_CALL_WALL_SEC=" << std::chrono::duration<double>(solved-solve_start).count()
            << "\nTOTAL_WALL_SEC=" << std::chrono::duration<double>(solved-start).count()
            << "\nRESCALING_TIME_SEC=" << result->rescaling_time_sec
            << "\nPRIMAL_OBJECTIVE=" << result->primal_objective_value
            << "\nDUAL_OBJECTIVE=" << result->dual_objective_value
            << "\nRELATIVE_PRIMAL_RESIDUAL=" << result->relative_primal_residual
            << "\nRELATIVE_DUAL_RESIDUAL=" << result->relative_dual_residual
            << "\nRELATIVE_OBJECTIVE_GAP=" << result->relative_objective_gap
            << "\nLP_RESULT_END" << std::endl;
  cupdlpx_result_free(result);
  lp_problem_free(problem);
  return 0;
}
