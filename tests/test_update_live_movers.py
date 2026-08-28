#!/usr/bin/env python3

import importlib.util
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "update_live_movers.py"
SPEC = importlib.util.spec_from_file_location("update_live_movers", SCRIPT)
MOVERS = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MOVERS)


class PriceHistoryTests(unittest.TestCase):
    def test_three_day_period_uses_72_hour_baseline(self):
        run_at = datetime(2026, 8, 27, 4, tzinfo=timezone.utc)
        changes = {
            "sku": [
                [MOVERS.iso(run_at - timedelta(hours=96)), 10.0],
                [MOVERS.iso(run_at - timedelta(hours=48)), 15.0],
            ]
        }

        self.assertEqual(MOVERS.PERIODS["threeDay"], 72)
        self.assertEqual(MOVERS.baseline_at(changes["sku"], run_at - timedelta(hours=72)), 10.0)

    def test_stale_tail_is_anchored_at_last_confirmed_snapshot(self):
        run_at = datetime(2026, 8, 27, 4, tzinfo=timezone.utc)
        prior_at = MOVERS.iso(run_at - timedelta(hours=3))
        changes = {"sku": [[MOVERS.iso(run_at - timedelta(days=10)), 600.0]]}
        current = {"sku": {"price": 650.0}}
        previous = {"sku": {"price": 650.0}}

        MOVERS.update_price_changes(current, previous, changes, "price", prior_at, run_at)

        self.assertEqual(changes["sku"][-1], [prior_at, 650.0])
        self.assertEqual(MOVERS.baseline_at(changes["sku"], run_at - timedelta(hours=1)), 650.0)
        self.assertEqual(MOVERS.baseline_at(changes["sku"], run_at - timedelta(hours=24)), 600.0)

    def test_returning_sku_breaks_stale_price_continuity(self):
        run_at = datetime(2026, 8, 27, 4, tzinfo=timezone.utc)
        changes = {"sku": [[MOVERS.iso(run_at - timedelta(days=2)), 20.0]]}
        current = {"sku": {"price": 35.0}}

        MOVERS.update_price_changes(current, {}, changes, "price", "", run_at)

        self.assertEqual(changes["sku"], [[MOVERS.iso(run_at), 35.0]])
        self.assertIsNone(MOVERS.baseline_at(changes["sku"], run_at - timedelta(hours=1)))

    def test_reactivated_price_field_breaks_stale_continuity(self):
        run_at = datetime(2026, 8, 27, 4, tzinfo=timezone.utc)
        changes = {"sku": [[MOVERS.iso(run_at - timedelta(days=2)), 20.0]]}
        current = {"sku": {"price": 35.0, "retail": 50.0}}
        previous = {"sku": {"price": 0.0, "retail": 50.0}}

        MOVERS.update_price_changes(current, previous, changes, "price", "", run_at)

        self.assertEqual(changes["sku"], [[MOVERS.iso(run_at), 35.0]])


if __name__ == "__main__":
    unittest.main()
