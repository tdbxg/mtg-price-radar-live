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


class SustainedWatchlistTests(unittest.TestCase):
    def setUp(self):
        self.run_at = datetime(2026, 9, 2, 4, tzinfo=timezone.utc)
        self.current = {"sku": {"price": 14.0, "qty": 3, "name": "Rising Card"}}
        self.card_index = {"sku": {"name": "Rising Card", "scryfallSet": "sld", "collectorNumber": "123"}}

    def test_two_consecutive_rises_are_automatically_watched(self):
        changes = {
            "sku": [
                [MOVERS.iso(self.run_at - timedelta(hours=24)), 10.0],
                [MOVERS.iso(self.run_at - timedelta(hours=12)), 12.0],
                [MOVERS.iso(self.run_at - timedelta(hours=1)), 14.0],
            ]
        }

        rows = MOVERS.build_sustained_watchlist(self.current, changes, self.card_index, self.run_at)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["streakCount"], 2)
        self.assertEqual(rows[0]["streakStartUsd"], 10.0)
        self.assertEqual(rows[0]["currentUsd"], 14.0)

    def test_one_rise_is_not_enough(self):
        changes = {"sku": [[MOVERS.iso(self.run_at - timedelta(hours=2)), 12.0], [MOVERS.iso(self.run_at - timedelta(hours=1)), 14.0]]}

        self.assertEqual(MOVERS.build_sustained_watchlist(self.current, changes, self.card_index, self.run_at), [])

    def test_latest_drop_breaks_the_rising_streak(self):
        current = {"sku": {"price": 13.0, "qty": 3, "name": "Rising Card"}}
        changes = {
            "sku": [
                [MOVERS.iso(self.run_at - timedelta(hours=4)), 10.0],
                [MOVERS.iso(self.run_at - timedelta(hours=3)), 12.0],
                [MOVERS.iso(self.run_at - timedelta(hours=2)), 14.0],
                [MOVERS.iso(self.run_at - timedelta(hours=1)), 13.0],
            ]
        }

        self.assertEqual(MOVERS.build_sustained_watchlist(current, changes, self.card_index, self.run_at), [])

    def test_stale_rises_are_not_automatically_watched(self):
        changes = {
            "sku": [
                [MOVERS.iso(self.run_at - timedelta(hours=80)), 10.0],
                [MOVERS.iso(self.run_at - timedelta(hours=76)), 12.0],
                [MOVERS.iso(self.run_at - timedelta(hours=73)), 14.0],
            ]
        }

        self.assertEqual(MOVERS.build_sustained_watchlist(self.current, changes, self.card_index, self.run_at), [])


if __name__ == "__main__":
    unittest.main()
