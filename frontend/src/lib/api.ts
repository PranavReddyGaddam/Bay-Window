// API client + types for the Bay Window backend (proxied via Vite at /api).

export interface Suggestion {
  address: string
  block: string | null
  lot: string | null
}

export interface ScoreBreakdownItem {
  open?: number
  total: number
  penalty: number
}
export interface Score {
  value: number
  grade: string
  breakdown: {
    violations: ScoreBreakdownItem
    complaints: ScoreBreakdownItem
    complaints_311: ScoreBreakdownItem
  }
  method: string
}

export interface Details {
  use?: string
  property_class?: string
  year_built?: string
  units?: number
  stories?: number
  bedrooms?: number
  bathrooms?: number
  lot_area_sqft?: number
  property_area_sqft?: number
  zoning?: string
  assessed_value?: number
  roll_year?: string
  source?: string
}

export interface ViolationItem {
  complaint_number: string
  category: string | null
  item: string | null
  status: string | null
  date_filed: string | null
  division: string | null
}
export interface Violations {
  count: number
  open: number
  by_category: Record<string, number>
  items: ViolationItem[]
}

export interface ComplaintItem {
  complaint_number: string
  description: string | null
  status: string | null
  date_filed: string | null
  closed_date: string | null
  division: string | null
}
export interface Complaints {
  count: number
  open: number
  items: ComplaintItem[]
}

export interface ThreeOneOneItem {
  id: string
  service_name: string | null
  subtype: string | null
  details: string | null
  status: string | null
  opened: string | null
  closed: string | null
}
export interface Complaints311 {
  count: number
  by_category: Record<string, number>
  items: ThreeOneOneItem[]
}

export interface EvictionItem {
  eviction_id: string
  address: string
  file_date: string | null
  neighborhood: string | null
  reasons: string[]
}
export interface Evictions {
  count: number
  by_reason: Record<string, number>
  items: EvictionItem[]
  granularity: string
}

export interface RentInventory {
  units_reported: number
  rent_ranges: Record<string, number>
  year_built: string | null
  likely_rent_controlled: boolean | null
  granularity: string
}

export interface Crime {
  count: number
  radius_m: number
  since?: string
  by_category: Record<string, number>
  recent: {
    category: string | null
    description: string | null
    datetime: string | null
    resolution: string | null
  }[]
}

export interface PermitItem {
  permit_number: string
  type: string | null
  description: string | null
  status: string | null
  filed_date: string | null
  estimated_cost: number | null
}
export interface Permits {
  count: number
  items: PermitItem[]
}

export interface Seismic {
  in_program: boolean
  status?: string
  tier?: string | null
  retrofitted?: boolean
  non_compliant?: boolean
}

export interface Transit {
  count: number
  nearest: { name: string | null; meters: number }[]
}

export interface Fire {
  count: number
  recent: { date: string | null; address: string | null }[]
}

export interface BuildingProfile {
  address: string | null
  block: string | null
  lot: string | null
  location: { lat: number | null; lon: number | null }
  geocode_source: string | null
  score: Score
  details: Details
  violations: Violations
  complaints: Complaints
  complaints_311: Complaints311
  crime: Crime
  permits: Permits
  seismic: Seismic
  transit: Transit
  fire: Fire
  block_context: {
    evictions: Evictions
    rent_inventory: RentInventory
  }
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    let detail = res.statusText
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  return res.json()
}

export function searchAddresses(q: string) {
  return getJSON<{ suggestions: Suggestion[] }>(
    `/api/search?q=${encodeURIComponent(q)}`,
  ).then((d) => d.suggestions)
}

export function getBuilding(address: string) {
  return getJSON<BuildingProfile>(
    `/api/building?address=${encodeURIComponent(address)}`,
  )
}

export type HealthBucket = "excellent" | "decent" | "mixed" | "poor" | "unknown"

export interface BuildingDot {
  address: string
  lat: number
  lon: number
  health: HealthBucket
  highViolations: boolean
  rentStabilized: boolean
}

export function getBuildings(bbox: {
  south: number
  west: number
  north: number
  east: number
}) {
  const { south, west, north, east } = bbox
  return getJSON<{ buildings: BuildingDot[]; count: number }>(
    `/api/buildings?south=${south}&west=${west}&north=${north}&east=${east}`,
  )
}
