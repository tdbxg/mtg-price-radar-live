#!/usr/bin/env python3
"""Build the lightweight, hourly Card Kingdom buylist movement feed.

The history deliberately keeps only the current SKU price index plus points for
SKUs whose cash buy price changed.  It avoids duplicating the full CK catalog on
every run while still allowing 1-hour, 24-hour, and 7-day comparisons.
"""

from __future__ import annotations

import gzip
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
SINGLES_URL = "https://api.cardkingdom.com/api/v2/pricelist"
HISTORY_PATH = ROOT / "movers" / "live_history.json.gz"
LIVE_PATH = ROOT / "movers" / "live.json"
USER_AGENT = "mtg-price-radar-live-movers/1.0"
PERIODS = {"hour": 1, "day": 24, "week": 24 * 7}
HISTORY_WINDOW = timedelta(days=8)
TOP_ROWS = 250
SET_TOP_ROWS = 80


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def fetch_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def money(value: Any) -> float:
    try:
        return round(float(value or 0), 2)
    except (TypeError, ValueError):
        return 0.0


def quantity(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def load_card_index() -> tuple[dict[str, dict[str, Any]], list[dict[str, str]]]:
    with gzip.open(ROOT / "data.json.gz", "rt", encoding="utf-8") as handle:
        payload = json.load(handle)
    fields = (
        "sku", "name", "cn", "edition", "scryfallSet", "collectorNumber", "foil",
        "image", "ckUrl", "formatBucket", "releasedAt",
    )
    index = {
        str(row.get("sku")): {field: row.get(field) for field in fields}
        for row in payload.get("cards", [])
        if row.get("sku")
    }
    catalog: dict[str, dict[str, str]] = {}
    for row in index.values():
        code = str(row.get("scryfallSet") or "").lower()
        if not code:
            continue
        existing = catalog.get(code, {})
        catalog[code] = {
            "code": code,
            "name": str(row.get("edition") or existing.get("name") or code),
            "releasedAt": str(row.get("releasedAt") or existing.get("releasedAt") or ""),
        }
    return index, sorted(catalog.values(), key=lambda item: (item["releasedAt"], item["name"]), reverse=True)


def load_history() -> dict[str, Any]:
    if not HISTORY_PATH.exists():
        return {"version": 1, "startedAt": "", "currentAt": "", "current": {}, "changes": {}}
    with gzip.open(HISTORY_PATH, "rt", encoding="utf-8") as handle:
        history = json.load(handle)
    history.setdefault("current", {})
    history.setdefault("changes", {})
    return history


def write_gzip_json(path: Path, payload: dict[str, Any]) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(temp, "wt", encoding="utf-8", compresslevel=9) as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    temp.replace(path)


def baseline_at(points: list[list[Any]], target: datetime) -> float | None:
    candidate: float | None = None
    for timestamp, price in points:
        if parse_iso(timestamp) <= target:
            candidate = money(price)
        else:
            break
    return candidate


def compact_row(sku: str, current: dict[str, Any], old_price: float, meta: dict[str, Any]) -> dict[str, Any]:
    price = money(current["price"])
    delta = round(price - old_price, 2)
    return {
        "sku": sku,
        "name": meta.get("name") or current.get("name") or sku,
        "cn": meta.get("cn") or "",
        "edition": meta.get("edition") or "",
        "setCode": meta.get("scryfallSet") or "",
        "collectorNumber": meta.get("collectorNumber") or "",
        "foil": bool(meta.get("foil")),
        "image": meta.get("image") or "",
        "ckUrl": meta.get("ckUrl") or "",
        "formatBucket": meta.get("formatBucket") or "special",
        "previousUsd": old_price,
        "currentUsd": price,
        "deltaUsd": delta,
        "deltaPct": round(delta / old_price * 100, 2) if old_price else 0,
        "qtyBuying": quantity(current.get("qty")),
    }


def build_period(
    current: dict[str, dict[str, Any]], changes: dict[str, list[list[Any]]], card_index: dict[str, dict[str, Any]], target: datetime
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for sku, value in current.items():
        old_price = baseline_at(changes.get(sku, []), target)
        if old_price is None or old_price <= 0 or money(value.get("price")) <= 0:
            continue
        row = compact_row(sku, value, old_price, card_index.get(sku, {}))
        if row["deltaUsd"]:
            rows.append(row)
    def rank(group: list[dict[str, Any]], limit: int) -> dict[str, list[dict[str, Any]]]:
        return {
            "winners": sorted((row for row in group if row["deltaUsd"] > 0), key=lambda row: row["deltaUsd"], reverse=True)[:limit],
            "losers": sorted((row for row in group if row["deltaUsd"] < 0), key=lambda row: row["deltaUsd"])[:limit],
        }

    sets: dict[str, dict[str, Any]] = {}
    for row in rows:
        code = str(row.get("setCode") or "").lower()
        if not code:
            continue
        group = sets.setdefault(code, {"name": row.get("edition") or code, "available": 0, "rows": []})
        group["available"] += 1
        group["rows"].append(row)
    for code, group in sets.items():
        ranked = rank(group.pop("rows"), SET_TOP_ROWS)
        group.update(ranked)

    return {"available": len(rows), "sets": sets, **rank(rows, TOP_ROWS)}


def main() -> int:
    run_at = now_utc()
    raw = fetch_json(SINGLES_URL)
    current = {
        str(row.get("sku")): {"price": money(row.get("price_buy")), "qty": quantity(row.get("qty_buying")), "name": row.get("name") or ""}
        for row in raw.get("data", [])
        if row.get("sku") and money(row.get("price_buy")) > 0 and quantity(row.get("qty_buying")) > 0
    }
    history = load_history()
    prior_at = history.get("currentAt") or ""
    previous = history.get("current", {})
    changes: dict[str, list[list[Any]]] = history.get("changes", {})
    for sku, value in current.items():
        before = previous.get(sku)
        if not before:
            continue
        old_price = money(before.get("price"))
        new_price = money(value.get("price"))
        if old_price == new_price:
            continue
        points = changes.setdefault(sku, [])
        if not points and prior_at:
            points.append([prior_at, old_price])
        if not points or points[-1][0] != iso(run_at):
            points.append([iso(run_at), new_price])

    cutoff = run_at - HISTORY_WINDOW
    for sku, points in list(changes.items()):
        kept = [point for point in points if parse_iso(point[0]) >= cutoff]
        older = [point for point in points if parse_iso(point[0]) < cutoff]
        if older:
            kept.insert(0, older[-1])
        if kept:
            changes[sku] = kept
        else:
            changes.pop(sku, None)

    history.update({
        "version": 1,
        "startedAt": history.get("startedAt") or iso(run_at),
        "currentAt": iso(run_at),
        "current": current,
        "changes": changes,
    })
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    write_gzip_json(HISTORY_PATH, history)

    card_index, set_catalog = load_card_index()
    live = {
        "meta": {
            "generatedAt": iso(run_at),
            "trackedSince": history["startedAt"],
            "source": "Card Kingdom public buylist",
            "activeRows": len(current),
            "changedSkus": len(changes),
            "storage": "current SKU index plus changed price points",
            "setCatalog": set_catalog,
        },
        "periods": {
            key: build_period(current, changes, card_index, run_at - timedelta(hours=hours))
            for key, hours in PERIODS.items()
        },
    }
    with open(LIVE_PATH, "w", encoding="utf-8") as handle:
        json.dump(live, handle, ensure_ascii=False, separators=(",", ":"))
    print(json.dumps({"generatedAt": live["meta"]["generatedAt"], "activeRows": len(current), "changedSkus": len(changes)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
