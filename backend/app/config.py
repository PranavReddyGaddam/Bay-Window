"""Configuration and dataset constants for the Bay Window backend."""
import os
from dotenv import load_dotenv

load_dotenv()

# Socrata app token. Optional but recommended: raises rate limits.
# Free to obtain at https://data.sfgov.org/profile/edit/developer_settings
SOCRATA_APP_TOKEN = os.getenv("SOCRATA_APP_TOKEN", "").strip()

SOCRATA_DOMAIN = "https://data.sfgov.org"

# Dataset IDs (validated against live schema during recon, 2026-06).
# NOTE: the originally-suggested av5k-qvh8 was an empty stub (6 columns, no
# type/status/date) and was dropped in favor of the two richer DBI datasets.
DATASETS = {
    "complaints": "gm2e-bten",   # DBI Complaints: complaint_description, status, dates, exact address
    "violations": "nbtm-fbw5",   # DBI Notices of Violation: nov_category_description, item, status, coords
    "311": "vw6y-z8j6",          # 311 cases: address, service_name/subtype, coords
    "rent": "gdc7-dmcn",         # Rent Board Housing Inventory: BLOCK-level (block_address), coords
    "evictions": "5cei-gny5",    # Eviction Notices: BLOCK-level (address), coords
    "assessor": "wv5m-vpq2",     # Assessor Secured Property Roll: building characteristics by block/lot (NO owner name in SF)
    "crime": "wg3w-h783",        # SFPD Incident Reports: incident_category, datetime, coords
    "permits": "i98e-djp9",      # Building Permits: type, description, status, cost, block/lot
    "softstory": "beah-shgi",    # Mandatory Soft-Story Program: seismic retrofit status by block/lot
    "transit": "i28k-bkz6",      # Muni Stops: stopname, coords
    "fire": "wr8u-xric",         # Fire Incidents: incident_date, coords
}

# 311 is dominated by street-cleaning/graffiti/parking noise. For a *building
# health* profile we only count habitability-relevant service categories.
HOUSING_311_SERVICE_NAMES = [
    "Residential Building Request",
    "Residential Building",
    "General Request - BUILDING INSPECTION",
    "Sewer Issues",
    "Sewer",
    "Water Quality",
    "Waste of Water",
    "Noise Report",
    "Noise",
]

CACHE_TTL_SECONDS = int(os.getenv("CACHE_TTL_SECONDS", "3600"))

# Permissive default for local dev; tighten for production deploy.
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:3000").split(",")
