"""Fetch and aggregate the building health profile for a geocoded address."""
import asyncio
from collections import Counter
from typing import Any, Optional

import httpx

from .config import DATASETS, HOUSING_311_SERVICE_NAMES
from .scoring import compute_score
from .socrata import soql, _esc


async def build_profile(client: httpx.AsyncClient, geo: dict) -> dict:
    """Given a geocode result, pull all datasets and assemble the profile."""
    number = geo.get("number")
    name = geo.get("street_name") or ""
    block = geo.get("block")
    lot = geo.get("lot")
    lat, lon = geo.get("lat"), geo.get("lon")

    (complaints, violations, threeoneone, evictions, rent, details,
     crime, permits, seismic, transit, fire) = await asyncio.gather(
        _fetch_complaints(client, block, lot, number, name),
        _fetch_violations(client, block, lot, number, name),
        _fetch_311(client, number, name),
        _fetch_evictions(client, block, lat, lon),
        _fetch_rent(client, block, lat, lon),
        _fetch_details(client, block, lot),
        _fetch_crime(client, lat, lon),
        _fetch_permits(client, block, lot),
        _fetch_seismic(client, block, lot),
        _fetch_transit(client, lat, lon),
        _fetch_fire(client, lat, lon),
    )

    score = compute_score(violations, complaints, threeoneone)

    return {
        "address": geo.get("matched_address"),
        "block": block,
        "lot": geo.get("lot"),
        "location": {"lat": lat, "lon": lon},
        "geocode_source": geo.get("source"),
        "score": score,
        "details": details,
        "violations": violations,
        "complaints": complaints,
        "complaints_311": threeoneone,
        "crime": crime,
        "permits": permits,
        "seismic": seismic,
        "transit": transit,
        "fire": fire,
        # Block-level (anonymized) context — shown separately, NOT in score.
        "block_context": {
            "evictions": evictions,
            "rent_inventory": rent,
        },
    }


# --- building-precise datasets (match on exact street number + name) --------

def _addr_where(block, lot, number, name) -> Optional[str]:
    """Build the most reliable WHERE clause available.

    Prefer block+lot (spelling-proof: SF datasets disagree on street spellings,
    e.g. BLYTHDALE vs BLYTHEDALE). Fall back to street_number + name prefix only
    when block/lot are absent (Census-geocoded addresses).
    """
    if block and lot:
        return f"block='{_esc(block)}' AND lot='{_esc(lot)}'"
    if number and name:
        first = name.split(" ")[0]
        return (f"street_number='{_esc(number)}' "
                f"AND upper(street_name) like upper('{_esc(first)}%')")
    return None


async def _fetch_complaints(client, block, lot, number, name) -> dict:
    where = _addr_where(block, lot, number, name)
    if not where:
        return {"count": 0, "open": 0, "items": []}
    rows = await soql(client, DATASETS["complaints"],
                      **{"$where": where, "$order": "date_filed DESC", "$limit": 200})
    items = [{
        "complaint_number": r.get("complaint_number"),
        "description": r.get("complaint_description"),
        "status": r.get("status"),
        "date_filed": r.get("date_filed"),
        "closed_date": r.get("closed_date"),
        "division": r.get("assigned_division"),
    } for r in rows]
    open_count = sum(1 for r in rows if (r.get("status") or "").lower().startswith("active"))
    return {"count": len(items), "open": open_count, "items": items}


async def _fetch_violations(client, block, lot, number, name) -> dict:
    where = _addr_where(block, lot, number, name)
    if not where:
        return {"count": 0, "open": 0, "by_category": {}, "items": []}
    rows = await soql(client, DATASETS["violations"],
                      **{"$where": where, "$order": "date_filed DESC", "$limit": 200})
    items = [{
        "complaint_number": r.get("complaint_number"),
        "category": r.get("nov_category_description"),
        "item": r.get("item"),
        "status": r.get("status"),
        "date_filed": r.get("date_filed"),
        "division": r.get("assigned_division"),
    } for r in rows]
    open_count = sum(1 for r in rows if "active" in (r.get("status") or "").lower()
                     and "not active" not in (r.get("status") or "").lower())
    by_category = dict(Counter(i["category"] for i in items if i["category"]))
    return {"count": len(items), "open": open_count,
            "by_category": by_category, "items": items}


async def _fetch_311(client, number, name) -> dict:
    if not number or not name:
        return {"count": 0, "by_category": {}, "items": []}
    # 311 stores a single `address` string like "208 LEXINGTON ST, SAN FRANCISCO..."
    addr_prefix = f"{number} {name}".upper()
    names = ",".join(f"'{_esc(n)}'" for n in HOUSING_311_SERVICE_NAMES)
    where = (
        f"upper(address) like upper('{_esc(addr_prefix)}%') "
        f"AND service_name in({names})"
    )
    rows = await soql(client, DATASETS["311"],
                      **{"$where": where, "$order": "requested_datetime DESC", "$limit": 200})
    items = [{
        "id": r.get("service_request_id"),
        "service_name": r.get("service_name"),
        "subtype": r.get("service_subtype"),
        "details": r.get("service_details"),
        "status": r.get("status_description"),
        "opened": r.get("requested_datetime"),
        "closed": r.get("closed_date"),
    } for r in rows]
    by_category = dict(Counter(i["service_name"] for i in items if i["service_name"]))
    return {"count": len(items), "by_category": by_category, "items": items}


# --- safety, permits, seismic, transit (new sections) -----------------------

CRIME_RADIUS_M = 200  # neighborhood-block scale around the building


async def _fetch_crime(client, lat, lon) -> dict:
    """SFPD incidents within CRIME_RADIUS_M, last ~2 years, by category."""
    if lat is None or lon is None:
        return {"count": 0, "radius_m": CRIME_RADIUS_M, "by_category": {}, "recent": []}
    where = (
        f"within_circle(point, {lat}, {lon}, {CRIME_RADIUS_M}) "
        f"AND incident_datetime > '2024-01-01T00:00:00'"
    )
    rows = await soql(client, DATASETS["crime"],
                      **{"$where": where, "$order": "incident_datetime DESC",
                         "$limit": 800})
    by_category = dict(Counter(
        r.get("incident_category") for r in rows if r.get("incident_category")
    ))
    recent = [{
        "category": r.get("incident_category"),
        "description": r.get("incident_description"),
        "datetime": r.get("incident_datetime"),
        "resolution": r.get("resolution"),
    } for r in rows[:8]]
    return {"count": len(rows), "radius_m": CRIME_RADIUS_M,
            "since": "2024", "by_category": by_category, "recent": recent}


async def _fetch_permits(client, block, lot) -> dict:
    """Building permits for this parcel — signals renovation / major work."""
    if not (block and lot):
        return {"count": 0, "items": []}
    where = f"block='{_esc(block)}' AND lot='{_esc(lot)}'"
    rows = await soql(client, DATASETS["permits"],
                      **{"$where": where, "$order": "filed_date DESC", "$limit": 50})
    items = [{
        "permit_number": r.get("permit_number"),
        "type": r.get("permit_type_definition"),
        "description": r.get("description"),
        "status": r.get("status"),
        "filed_date": r.get("filed_date"),
        "estimated_cost": _intish(r.get("estimated_cost") or r.get("revised_cost")),
    } for r in rows]
    return {"count": len(items), "items": items}


async def _fetch_seismic(client, block, lot) -> dict:
    """Mandatory Soft-Story (seismic retrofit) status for this parcel."""
    if not (block and lot):
        return {"in_program": False}
    where = f"block='{_esc(block)}' AND lot='{_esc(lot)}'"
    rows = await soql(client, DATASETS["softstory"],
                      **{"$where": where, "$limit": 1})
    if not rows:
        return {"in_program": False}
    r = rows[0]
    status = r.get("status") or ""
    retrofitted = "complete" in status.lower()
    return {
        "in_program": True,
        "status": status,
        "tier": r.get("tier"),
        "retrofitted": retrofitted,
        "non_compliant": "non-compliant" in status.lower(),
    }


async def _fetch_transit(client, lat, lon) -> dict:
    """Nearest Muni stops within 500m (walkable transit access)."""
    if lat is None or lon is None:
        return {"count": 0, "nearest": []}
    where = f"within_circle(shape, {lat}, {lon}, 500)"
    rows = await soql(client, DATASETS["transit"],
                      **{"$where": where, "$select": "stopname,latitude,longitude",
                         "$limit": 200})
    stops = []
    for r in rows:
        slat, slon = _num(r.get("latitude")), _num(r.get("longitude"))
        if slat is None or slon is None:
            continue
        stops.append({
            "name": r.get("stopname"),
            "meters": int(_haversine_m(lat, lon, slat, slon)),
        })
    stops.sort(key=lambda s: s["meters"])
    return {"count": len(stops), "nearest": stops[:5]}


async def _fetch_fire(client, lat, lon) -> dict:
    """Fire incidents within 75m of the building (recent history)."""
    if lat is None or lon is None:
        return {"count": 0, "recent": []}
    where = f"within_circle(point, {lat}, {lon}, 75)"
    rows = await soql(client, DATASETS["fire"],
                      **{"$where": where, "$order": "incident_date DESC", "$limit": 50})
    recent = [{
        "date": r.get("incident_date"),
        "address": r.get("address"),
    } for r in rows[:5]]
    return {"count": len(rows), "recent": recent}


# --- block-level (anonymized) datasets: match by block / coord proximity ----

async def _fetch_evictions(client, block, lat, lon) -> dict:
    rows: list[dict] = []
    if lat is not None and lon is not None:
        # within ~75m of the building
        where = f"within_circle(shape, {lat}, {lon}, 75)"
        rows = await soql(client, DATASETS["evictions"],
                          **{"$where": where, "$order": "file_date DESC", "$limit": 200})
    reason_fields = [
        "non_payment", "breach", "nuisance", "owner_move_in", "ellis_act_withdrawal",
        "demolition", "capital_improvement", "substantial_rehab", "condo_conversion",
        "failure_to_sign_renewal", "illegal_use", "access_denial",
    ]
    items = []
    reason_counts: Counter = Counter()
    for r in rows:
        reasons = [f.replace("_", " ").title() for f in reason_fields if r.get(f) is True]
        reason_counts.update(reasons)
        items.append({
            "eviction_id": r.get("eviction_id"),
            "address": r.get("address"),
            "file_date": r.get("file_date"),
            "neighborhood": r.get("neighborhood"),
            "reasons": reasons,
        })
    return {"count": len(items), "by_reason": dict(reason_counts),
            "items": items, "granularity": "block"}


async def _fetch_rent(client, block, lat, lon) -> dict:
    rows: list[dict] = []
    if lat is not None and lon is not None:
        where = f"within_circle(point, {lat}, {lon}, 75)"
        rows = await soql(client, DATASETS["rent"],
                          **{"$where": where, "$limit": 200})
    rent_ranges = Counter(r.get("monthly_rent") for r in rows if r.get("monthly_rent"))
    years = [r.get("year_property_built") for r in rows if r.get("year_property_built")]
    return {
        "units_reported": len(rows),
        "rent_ranges": dict(rent_ranges),
        "year_built": years[0] if years else None,
        # SF rent control generally applies to multi-unit buildings built before
        # 1979-06-13. We surface the year so the UI can flag likely coverage.
        "likely_rent_controlled": _likely_rent_controlled(years),
        "granularity": "block",
    }


async def _fetch_details(client, block, lot) -> dict:
    """Building characteristics from the Assessor roll (most recent roll year).

    SF publishes NO owner name in free data, but this gives use type, year
    built, units, stories, lot size, assessed value, and zoning.
    """
    if not (block and lot):
        return {}
    where = f"block='{_esc(block)}' AND lot='{_esc(lot)}'"
    rows = await soql(client, DATASETS["assessor"],
                      **{"$where": where, "$order": "closed_roll_year DESC", "$limit": 1})
    if not rows:
        return {}
    r = rows[0]
    land = _num(r.get("assessed_land_value"))
    impr = _num(r.get("assessed_improvement_value"))
    assessed = (land or 0) + (impr or 0) if (land or impr) else None
    return {
        "use": r.get("use_definition"),
        "property_class": r.get("property_class_code_definition"),
        "year_built": r.get("year_property_built"),
        "units": _intish(r.get("number_of_units")),
        "stories": _intish(r.get("number_of_stories")),
        "bedrooms": _intish(r.get("number_of_bedrooms")),
        "bathrooms": _intish(r.get("number_of_bathrooms")),
        "lot_area_sqft": _intish(r.get("lot_area")),
        "property_area_sqft": _intish(r.get("property_area")),
        "zoning": r.get("zoning_code"),
        "assessed_value": int(assessed) if assessed else None,
        "roll_year": r.get("closed_roll_year"),
        "source": "SF Assessor Secured Property Roll",
    }


def _num(v: Any) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _intish(v: Any) -> Optional[int]:
    n = _num(v)
    return int(n) if n is not None else None


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in meters between two lat/lon points."""
    import math
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _likely_rent_controlled(years: list[str]) -> Optional[bool]:
    valid = [int(y) for y in years if str(y).isdigit()]
    if not valid:
        return None
    return min(valid) < 1979
