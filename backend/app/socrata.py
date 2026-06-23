"""Socrata (DataSF) client + free address geocoding.

Geocoding is hybrid and key-free:
  1. Primary: SF's own EAS address points dataset on DataSF (ramy-di5m) — gives
     canonical street_number/street_name + block/lot + lat/long for an SF address.
  2. Fallback: US Census geocoder (geocoding.geo.census.gov) — free, no key.

Both are free. We never call a paid geocoder.
"""
import asyncio
import re
from typing import Any, Optional

import httpx

from .cache import cache
from .config import SOCRATA_APP_TOKEN, SOCRATA_DOMAIN

EAS_DATASET = "ramy-di5m"  # SF EAS active address points

_headers = {"Accept": "application/json"}
if SOCRATA_APP_TOKEN:
    _headers["X-App-Token"] = SOCRATA_APP_TOKEN


async def soql(client: httpx.AsyncClient, dataset_id: str, **params: Any) -> list[dict]:
    """Run a SoQL query against a dataset, with caching."""
    cache_key = f"{dataset_id}:{sorted(params.items())}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    url = f"{SOCRATA_DOMAIN}/resource/{dataset_id}.json"
    resp = await client.get(url, params=params, headers=_headers, timeout=30.0)
    resp.raise_for_status()
    data = resp.json()
    cache.set(cache_key, data)
    return data


# --- address normalization -------------------------------------------------

_SUFFIX_MAP = {
    "street": "st", "st": "st", "avenue": "av", "ave": "av", "av": "av",
    "boulevard": "blvd", "blvd": "blvd", "drive": "dr", "dr": "dr",
    "court": "ct", "ct": "ct", "place": "pl", "pl": "pl", "road": "rd",
    "rd": "rd", "terrace": "ter", "ter": "ter", "lane": "ln", "ln": "ln",
    "way": "way", "circle": "cir", "cir": "cir",
}


def parse_address(raw: str) -> dict:
    """Split a free-text address into number / street name / suffix."""
    s = re.sub(r",.*$", "", raw.strip())  # drop city/state/zip tail
    s = re.sub(r"\s+", " ", s)
    m = re.match(r"^(\d+)\s+(.*)$", s)
    number = m.group(1) if m else ""
    rest = (m.group(2) if m else s).strip()
    parts = rest.split(" ")
    suffix = ""
    if len(parts) > 1 and parts[-1].lower() in _SUFFIX_MAP:
        suffix = _SUFFIX_MAP[parts[-1].lower()]
        name = " ".join(parts[:-1])
    else:
        name = rest
    return {"number": number, "name": name.strip(), "suffix": suffix, "raw": raw}


async def geocode(client: httpx.AsyncClient, raw: str) -> Optional[dict]:
    """Resolve a free-text SF address to canonical fields + coords + block/lot.

    Returns dict: number, street_name, block, lot, lat, lon, matched_address.
    """
    cache_key = f"geocode:{raw.lower().strip()}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    parsed = parse_address(raw)
    result = await _geocode_eas(client, parsed)
    if not result:
        result = await _geocode_census(client, parsed)
        # SF datasets disagree on street spellings (e.g. BLYTHDALE vs
        # BLYTHEDALE), so a name match can miss. Recover the canonical
        # block/lot from EAS by coordinate proximity to the Census point.
        if result and result.get("lat") is not None and not result.get("block"):
            parcel = await _eas_by_point(client, result["lat"], result["lon"])
            if parcel:
                result["block"] = parcel.get("block")
                result["lot"] = parcel.get("lot")
                result["source"] = "census+eas"
    if result:
        cache.set(cache_key, result)
    return result


async def _eas_by_point(client: httpx.AsyncClient, lat: float, lon: float) -> Optional[dict]:
    """Find the nearest EAS parcel to a coordinate (recovers block/lot)."""
    where = f"within_circle(point, {lat}, {lon}, 30)"
    try:
        rows = await soql(client, EAS_DATASET,
                          **{"$where": where, "$select": "block,lot", "$limit": 1})
    except httpx.HTTPError:
        return None
    return rows[0] if rows else None


async def _geocode_eas(client: httpx.AsyncClient, parsed: dict) -> Optional[dict]:
    """Match against SF EAS address points (preferred: gives block/lot)."""
    if not parsed["number"] or not parsed["name"]:
        return None
    # EAS columns: address_number, street_name, block, lot, blklot, longitude, latitude, address
    where = (
        f"address_number='{parsed['number']}' "
        f"AND upper(street_name) like upper('{_esc(parsed['name'])}%')"
    )
    try:
        rows = await soql(client, EAS_DATASET, **{"$where": where, "$limit": 1})
    except httpx.HTTPError:
        return None
    if not rows:
        return None
    r = rows[0]
    lat = _flt(r.get("latitude"))
    lon = _flt(r.get("longitude"))
    if lat is None and isinstance(r.get("point"), dict):
        coords = r["point"].get("coordinates") or []
        if len(coords) == 2:
            lon, lat = coords[0], coords[1]
    return {
        "number": r.get("address_number", parsed["number"]),
        "street_name": r.get("street_name", parsed["name"]),
        "block": r.get("block") or (r.get("blklot") or "")[:4] or None,
        "lot": r.get("lot"),
        "lat": lat,
        "lon": lon,
        "matched_address": r.get("address") or _join_addr(parsed),
        "source": "eas",
    }


async def _geocode_census(client: httpx.AsyncClient, parsed: dict) -> Optional[dict]:
    """Free US Census geocoder fallback (no block/lot, but gives coords)."""
    addr = _join_addr(parsed) + ", San Francisco, CA"
    url = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
    params = {"address": addr, "benchmark": "Public_AR_Current", "format": "json"}
    try:
        resp = await client.get(url, params=params, timeout=30.0)
        resp.raise_for_status()
        matches = resp.json().get("result", {}).get("addressMatches", [])
    except (httpx.HTTPError, ValueError):
        return None
    if not matches:
        return None
    m = matches[0]
    coord = m.get("coordinates", {})
    return {
        "number": parsed["number"],
        "street_name": parsed["name"],
        "block": None,
        "lot": None,
        "lat": coord.get("y"),
        "lon": coord.get("x"),
        "matched_address": m.get("matchedAddress", addr),
        "source": "census",
    }


# --- helpers ---------------------------------------------------------------

def _esc(s: str) -> str:
    return s.replace("'", "''")


def _flt(v: Any) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _join_addr(parsed: dict) -> str:
    bits = [parsed["number"], parsed["name"], parsed["suffix"].upper()]
    return " ".join(b for b in bits if b)
