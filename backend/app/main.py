"""Bay Window backend — FastAPI proxy + scoring for SF building health profiles."""
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .building import build_profile
from .config import CORS_ORIGINS, DATASETS, SOCRATA_APP_TOKEN
from .socrata import EAS_DATASET, geocode, soql, _esc


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.client = httpx.AsyncClient()
    yield
    await app.state.client.aclose()


app = FastAPI(title="Bay Window API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {"ok": True, "app_token_configured": bool(SOCRATA_APP_TOKEN)}


@app.get("/api/search")
async def search(q: str = Query(..., min_length=2)):
    """Autocomplete-style address suggestions from SF EAS address points."""
    import re
    # leading house number, then the street name remainder
    m = re.match(r"^\s*(\d+)\s+(.*)$", q)
    house_num = m.group(1) if m else None
    street = (m.group(2) if m else q).strip()
    # strip a trailing street type the user may have typed (st, ave, blvd…)
    street = re.sub(r"\b(st|street|ave|avenue|blvd|dr|drive|rd|road|"
                    r"ln|lane|ct|pl|ter|way|blvd)\.?$", "", street,
                    flags=re.IGNORECASE).strip()

    clauses = []
    if house_num:
        clauses.append(f"address_number='{_esc(house_num)}'")
    if street:
        # numeric streets are zero-padded in EAS ("06TH"), so tolerate a
        # leading zero: match "6th" against both "6TH" and "06TH".
        s = _esc(street)
        s_nozero = s.lstrip("0")
        if s_nozero and s_nozero != s and s_nozero[0].isdigit():
            clauses.append(
                f"(upper(street_name) like upper('{s}%') "
                f"OR upper(street_name) like upper('0{s_nozero}%') "
                f"OR upper(street_name) like upper('{s_nozero}%'))"
            )
        elif s and s[0].isdigit():
            clauses.append(
                f"(upper(street_name) like upper('{s}%') "
                f"OR upper(street_name) like upper('0{s}%'))"
            )
        else:
            clauses.append(f"upper(street_name) like upper('{s}%')")
    if not clauses:
        clauses.append(f"upper(address) like upper('{_esc(q)}%')")
    where = " AND ".join(clauses)
    try:
        rows = await soql(
            app.state.client, EAS_DATASET,
            **{"$where": where, "$select": "address,block,lot,longitude,latitude",
               "$group": "address,block,lot,longitude,latitude",
               "$order": "address", "$limit": 8},
        )
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Address search failed: {e}")
    return {"suggestions": [{"address": r.get("address"), "block": r.get("block"),
                             "lot": r.get("lot")} for r in rows]}


@app.get("/api/buildings")
async def buildings(
    south: float = Query(...),
    west: float = Query(...),
    north: float = Query(...),
    east: float = Query(...),
    limit: int = Query(1500, le=3000),
):
    """Individual building points within a bbox, each with a health bucket.

    Used by the zoomed-in map. Aggregates DBI violations + complaints by parcel
    in the visible box (one query each), then joins to EAS address points and
    buckets each into excellent / decent / mixed / poor / unknown.
    """
    import asyncio
    box = f"within_box(point, {north}, {west}, {south}, {east})"
    loc_box = f"within_box(location, {north}, {west}, {south}, {east})"
    geom_box = f"within_box(the_geom, {north}, {west}, {south}, {east})"
    client = app.state.client
    try:
        points, viol, assessor = await asyncio.gather(
            soql(client, EAS_DATASET,
                 **{"$where": box, "$select": "address,block,lot,latitude,longitude",
                    "$limit": limit}),
            soql(client, DATASETS["violations"],
                 **{"$where": loc_box, "$select": "block,lot,count(*)",
                    "$group": "block,lot", "$limit": 5000}),
            # Assessor parcels in the box, to flag likely rent-controlled
            # buildings: SF rent control generally covers multi-unit buildings
            # built before June 1979.
            soql(client, DATASETS["assessor"],
                 **{"$where": geom_box,
                    "$select": "block,lot,year_property_built,number_of_units",
                    "$limit": 20000}),
        )
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Upstream DataSF error: {e}")

    v_by_parcel: dict[str, int] = {}
    for r in viol:
        if r.get("block") and r.get("lot"):
            v_by_parcel[f"{r['block']}/{r['lot']}"] = int(r["count"])

    rent_parcels = _rent_controlled_parcels(assessor)

    features = []
    seen = set()
    for p in points:
        lat, lon = p.get("latitude"), p.get("longitude")
        block, lot = p.get("block"), p.get("lot")
        if not (lat and lon and block and lot):
            continue
        key = f"{block}/{lot}"
        if key in seen:
            continue  # one dot per parcel
        seen.add(key)
        v = v_by_parcel.get(key, 0)
        # strip unit suffix ("3055 PACIFIC AVE #4" -> "3055 PACIFIC AVE")
        addr = (p.get("address") or "").split(" #")[0].strip()
        features.append({
            "address": addr,
            "lat": float(lat),
            "lon": float(lon),
            "health": _health_bucket(v),
            "highViolations": v > 6,
            "rentStabilized": key in rent_parcels,
        })
    return {"buildings": features, "count": len(features)}


def _rent_controlled_parcels(assessor_rows: list[dict]) -> set[str]:
    """Parcels likely under SF rent control: multi-unit, built before 1979.

    The Assessor roll stores year/units as strings ("1906", "2.0") and has
    multiple rows per parcel across roll years; we just need membership.
    """
    out: set[str] = set()
    for r in assessor_rows:
        block, lot = r.get("block"), r.get("lot")
        if not (block and lot):
            continue
        year = _to_int(r.get("year_property_built"))
        units = _to_float(r.get("number_of_units"))
        if year and 0 < year < 1979 and units and units >= 2:
            out.add(f"{block}/{lot}")
    return out


def _to_int(v) -> int | None:
    try:
        return int(str(v).split(".")[0])
    except (TypeError, ValueError):
        return None


def _to_float(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _health_bucket(violations: int) -> str:
    # Color by DBI violation count on the parcel. Clean parcels read excellent
    # (green); severity climbs decent -> mixed -> poor, matching NYCStoops'
    # green/black/yellow/red building-health scale.
    if violations == 0:
        return "excellent"
    if violations <= 2:
        return "decent"
    if violations <= 6:
        return "mixed"
    return "poor"


@app.get("/api/building")
async def building(address: str = Query(..., min_length=3)):
    """Full building health profile for a free-text address."""
    geo = await geocode(app.state.client, address)
    if not geo:
        raise HTTPException(404, f"Could not locate '{address}' in San Francisco.")
    try:
        return await build_profile(app.state.client, geo)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Upstream DataSF error: {e}")
