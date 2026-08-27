#!/usr/bin/env python3
"""Build the lightweight, hourly Card Kingdom buylist movement feed.

The history deliberately keeps only the current SKU price index plus points for
SKUs whose cash buy price changed.  It avoids duplicating the full CK catalog on
every run while still allowing 1-hour, 24-hour, and 7-day comparisons.
"""

from __future__ import annotations

import argparse
import gzip
import http.client
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
SINGLES_URL = "https://api.cardkingdom.com/api/v2/pricelist"
HISTORY_PATH = ROOT / "movers" / "live_history.json.gz"
LIVE_PATH = ROOT / "movers" / "live.json"
FORMAT_INDEX_PATH = ROOT / "movers" / "scryfall_format_index.json.gz"
USER_AGENT = "mtg-price-radar-live-movers/1.0"
PERIODS = {"hour": 1, "day": 24, "week": 24 * 7}
HISTORY_WINDOW = timedelta(days=8)
TOP_ROWS = 250
SET_TOP_ROWS = 80
FORMAT_TOP_ROWS = 120
FORMAT_BUCKETS = ("standard", "pioneer", "modern", "legacy", "special")
STANDARD_SETS = {"woe", "lci", "mkm", "otj", "blb", "dsk", "fdn", "dft", "tdm", "fin", "eoe", "tla"}
MODERN_ONLY_SETS = {"mh1", "mh2", "mh3", "ltr", "ltc"}
SPECIAL_EDITION_TERMS = (
    "secret lair", "commander", "masters", "masterpiece", "promo", "from the vault",
    "conspiracy", "planechase", "archenemy", "duel decks", "battlebond", "jumpstart",
    "unfinity", "unset", "mystery booster", "box topper", "special guests",
)


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def fetch_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    # CK's public feed is reachable directly. Ignore macOS/system proxy settings
    # so local VPN proxy nodes are not used for the large catalog download.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def load_snapshot_pricelist() -> dict[str, list[dict[str, Any]]]:
    """Rebuild the API-shaped rows from the freshly generated site snapshot."""
    with gzip.open(ROOT / "data.json.gz", "rt", encoding="utf-8") as handle:
        payload = json.load(handle)
    return {
        "data": [
            {
                "sku": row.get("sku"),
                "name": row.get("ckName") or row.get("name") or "",
                "price_buy": row.get("cashUsd"),
                "price_retail": row.get("retailUsd"),
                "qty_buying": row.get("qtyBuying"),
                "qty_retail": row.get("qtyRetail"),
            }
            for row in payload.get("cards", [])
            if row.get("sku")
        ]
    }


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
        "image", "ckUrl", "formatBucket", "releasedAt", "variation", "flavorName", "scryfallSetName", "scryfallId",
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


def load_format_index() -> dict[str, Any]:
    if not FORMAT_INDEX_PATH.exists():
        return {"updatedAt": "", "buckets": {}}
    with gzip.open(FORMAT_INDEX_PATH, "rt", encoding="utf-8") as handle:
        data = json.load(handle)
    data.setdefault("buckets", {})
    return data


def format_bucket(legalities: dict[str, Any]) -> str:
    if legalities.get("standard") == "legal":
        return "standard"
    if legalities.get("pioneer") == "legal":
        return "pioneer"
    if legalities.get("modern") == "legal":
        return "modern"
    if legalities.get("legacy") == "legal":
        return "legacy"
    return "special"


def fallback_format_bucket(meta: dict[str, Any]) -> str:
    """Classify by the printing's set environment when exact legality is absent."""
    code = str(meta.get("scryfallSet") or "").lower()
    edition = str(meta.get("edition") or "").lower()
    released = str(meta.get("releasedAt") or "")
    if code in STANDARD_SETS:
        return "standard"
    if code in MODERN_ONLY_SETS:
        return "modern"
    if code.startswith("p") or any(term in edition for term in SPECIAL_EDITION_TERMS):
        return "special"
    if released >= "2012-10-05":
        return "pioneer"
    if released >= "2003-07-28":
        return "modern"
    if released:
        return "legacy"
    return "special"


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


def compact_row(
    sku: str, current: dict[str, Any], old_price: float, meta: dict[str, Any], value_field: str = "price", qty_field: str = "qty"
) -> dict[str, Any]:
    price = money(current[value_field])
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
        "variation": meta.get("variation") or "",
        "flavorName": meta.get("flavorName") or "",
        "releasedAt": meta.get("releasedAt") or "",
        "previousUsd": old_price,
        "currentUsd": price,
        "deltaUsd": delta,
        "deltaPct": round(delta / old_price * 100, 2) if old_price else 0,
        "qtyBuying": quantity(current.get(qty_field)),
    }


def build_period(
    current: dict[str, dict[str, Any]], changes: dict[str, list[list[Any]]], card_index: dict[str, dict[str, Any]], target: datetime,
    value_field: str = "price", qty_field: str = "qty",
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for sku, value in current.items():
        old_price = baseline_at(changes.get(sku, []), target)
        if old_price is None or old_price <= 0 or money(value.get(value_field)) <= 0:
            continue
        row = compact_row(sku, value, old_price, card_index.get(sku, {}), value_field=value_field, qty_field=qty_field)
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

    formats: dict[str, dict[str, Any]] = {}
    for bucket in FORMAT_BUCKETS:
        group = [row for row in rows if row.get("formatBucket") == bucket]
        formats[bucket] = {"available": len(group), **rank(group, FORMAT_TOP_ROWS)}

    return {"available": len(rows), "sets": sets, "formats": formats, **rank(rows, TOP_ROWS)}


def update_price_changes(
    current: dict[str, dict[str, Any]], previous: dict[str, dict[str, Any]], changes: dict[str, list[list[Any]]],
    field: str, prior_at: str, run_at: datetime,
) -> None:
    for sku, value in current.items():
        before = previous.get(sku)
        new_price = money(value.get(field))
        if not before:
            # A returning SKU has an observation gap. Do not compare its new
            # price with a stale point from before CK stopped listing it.
            if sku in changes and new_price > 0:
                changes[sku] = [[iso(run_at), new_price]]
            continue
        old_price = money(before.get(field))
        if old_price <= 0:
            if sku in changes and new_price > 0:
                changes[sku] = [[iso(run_at), new_price]]
            continue
        if new_price <= 0:
            continue
        points = changes.setdefault(sku, [])
        # Older updater versions could leave the series ending at a stale
        # price. Anchor the last confirmed snapshot before calculating deltas.
        if points and money(points[-1][1]) != old_price and prior_at:
            points.append([prior_at, old_price])
        if old_price == new_price:
            continue
        if not points and prior_at:
            points.append([prior_at, old_price])
        if not points or points[-1][0] != iso(run_at):
            points.append([iso(run_at), new_price])


def prune_changes(changes: dict[str, list[list[Any]]], cutoff: datetime) -> None:
    for sku, points in list(changes.items()):
        kept = [point for point in points if parse_iso(point[0]) >= cutoff]
        older = [point for point in points if parse_iso(point[0]) < cutoff]
        if older:
            kept.insert(0, older[-1])
        if kept:
            changes[sku] = kept
        else:
            changes.pop(sku, None)


def build_sld_catalog(
    current: dict[str, dict[str, Any]], changes: dict[str, list[list[Any]]], card_index: dict[str, dict[str, Any]], target: datetime
) -> list[dict[str, Any]]:
    """Expose every actively bought SLD print, not only records that moved."""
    catalog: list[dict[str, Any]] = []
    for sku, value in current.items():
        meta = card_index.get(sku, {})
        if str(meta.get("scryfallSet") or "").lower() != "sld":
            continue
        old_price = baseline_at(changes.get(sku, []), target)
        row = compact_row(sku, value, old_price or money(value.get("price")), meta)
        row["hasBaseline"] = old_price is not None
        if not row["hasBaseline"]:
            row["deltaUsd"] = None
            row["deltaPct"] = None
            row["previousUsd"] = None
        catalog.append(row)
    return sorted(catalog, key=lambda row: (-float(row["currentUsd"]), row["name"], row["sku"]))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", action="store_true", help="use the latest generated data.json.gz")
    args = parser.parse_args()
    run_at = now_utc()
    source = "Latest generated Card Kingdom buylist snapshot"
    if args.snapshot:
        raw = load_snapshot_pricelist()
    else:
        source = "Card Kingdom public buylist"
        try:
            raw = fetch_json(SINGLES_URL)
        except (urllib.error.URLError, TimeoutError, http.client.HTTPException, json.JSONDecodeError) as error:
            raw = load_snapshot_pricelist()
            source = "Latest generated Card Kingdom buylist snapshot"
            print(f"Direct price feed unavailable ({type(error).__name__}); using data.json.gz", flush=True)
    current: dict[str, dict[str, Any]] = {}
    cash_active_rows = 0
    retail_active_rows = 0
    for row in raw.get("data", []):
        sku = str(row.get("sku") or "")
        cash = money(row.get("price_buy"))
        retail = money(row.get("price_retail"))
        qty_buying = quantity(row.get("qty_buying"))
        qty_retail = quantity(row.get("qty_retail"))
        cash_active = cash > 0 and qty_buying > 0
        retail_active = retail > 0 and qty_retail > 0
        if not sku or not (cash_active or retail_active):
            continue
        current[sku] = {"price": cash if cash_active else 0, "qty": qty_buying, "retail": retail if retail_active else 0, "qtyRetail": qty_retail, "name": row.get("name") or ""}
        cash_active_rows += int(cash_active)
        retail_active_rows += int(retail_active)
    history = load_history()
    prior_at = history.get("currentAt") or ""
    previous = history.get("current", {})
    changes: dict[str, list[list[Any]]] = history.get("changes", {})
    retail_changes: dict[str, list[list[Any]]] = history.setdefault("retailChanges", {})
    update_price_changes(current, previous, changes, "price", prior_at, run_at)
    update_price_changes(current, previous, retail_changes, "retail", prior_at, run_at)

    cutoff = run_at - HISTORY_WINDOW
    prune_changes(changes, cutoff)
    prune_changes(retail_changes, cutoff)

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
    # Prefer exact legalities when a cache is available. Most rows use the
    # printing's set environment so hourly updates never depend on a long API run.
    format_index = load_format_index()
    for meta in card_index.values():
        card_id = str(meta.get("scryfallId") or "")
        meta["formatBucket"] = format_index["buckets"].get(card_id) or fallback_format_bucket(meta)
    live = {
        "meta": {
            "generatedAt": iso(run_at),
            "trackedSince": history["startedAt"],
            "source": source,
            "activeRows": cash_active_rows,
            "retailActiveRows": retail_active_rows,
            "changedSkus": len(changes),
            "retailChangedSkus": len(retail_changes),
            "formatLegalitiesCached": len(format_index["buckets"]),
            "formatClassification": "exact legality cache when available; otherwise printing set environment",
            "storage": "current SKU index plus changed price points",
            "setCatalog": set_catalog,
        },
        "periods": {
            key: {
                **build_period(current, changes, card_index, run_at - timedelta(hours=hours)),
                "retail": build_period(current, retail_changes, card_index, run_at - timedelta(hours=hours), value_field="retail", qty_field="qtyRetail"),
            }
            for key, hours in PERIODS.items()
        },
        "catalogs": {
            "sld": build_sld_catalog(current, changes, card_index, run_at - timedelta(hours=1)),
        },
    }
    with open(LIVE_PATH, "w", encoding="utf-8") as handle:
        json.dump(live, handle, ensure_ascii=False, separators=(",", ":"))
    print(json.dumps({"generatedAt": live["meta"]["generatedAt"], "cashActiveRows": cash_active_rows, "retailActiveRows": retail_active_rows, "changedSkus": len(changes), "retailChangedSkus": len(retail_changes)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
