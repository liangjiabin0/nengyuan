from __future__ import annotations

import copy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from power_dispatch_skill.backends.custom_pyomo import CustomPyomoBackend
from power_dispatch_skill.io import load_spec
from power_dispatch_skill.profiles import resolve_profile


class CustomPyomoSolverPolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec = load_spec(ROOT / "examples" / "inputs" / "case33bw_pq_24h.yaml")
        cls.frame = resolve_profile(cls.spec, cls.spec["metadata"]["source_file"])

    def solve_schedule(self, spec):
        backend = CustomPyomoBackend()
        steps, dt_h = backend._steps(spec, self.frame)
        return backend._solve_storage_schedule(spec, self.frame, steps, dt_h)

    def test_requested_highs_solves_without_fallback(self):
        schedule = self.solve_schedule(copy.deepcopy(self.spec))

        self.assertEqual(schedule["solver_name"], "highs")
        self.assertIn("optimal", schedule["termination"].lower())
        self.assertFalse(schedule["fallback_used"])
        self.assertEqual(schedule["formulation"], "QP_SOC")
        self.assertTrue(schedule["solver_attempts"][0]["acceptable"])

    def test_broken_appsi_adapter_retries_classic_highs(self):
        spec = copy.deepcopy(self.spec)
        spec["solver"]["solver_name"] = "appsi_highs"
        schedule = self.solve_schedule(spec)

        self.assertEqual(schedule["solver_attempts"][0]["solver"], "appsi_highs")
        self.assertEqual(schedule["solver_attempts"][0]["status"], "error")
        self.assertEqual(schedule["solver_name"], "highs")
        self.assertFalse(schedule["fallback_used"])

    def test_greedy_is_only_used_after_formal_attempts_fail(self):
        backend = CustomPyomoBackend()
        spec = copy.deepcopy(self.spec)
        steps, dt_h = backend._steps(spec, self.frame)

        with patch.object(backend, "_try_pyomo_solvers", return_value=None) as solve:
            schedule = backend._solve_storage_schedule(spec, self.frame, steps, dt_h)

        self.assertEqual(solve.call_count, 2)
        self.assertEqual(schedule["solver_name"], "greedy")
        self.assertTrue(schedule["fallback_used"])
        self.assertTrue(any("All configured" in item for item in schedule["warnings"]))


if __name__ == "__main__":
    unittest.main()
