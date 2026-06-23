import { useState } from "react"

import type { BuildingProfile as Profile, Violations } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { ScoreGauge, ScoreGaugeCompact } from "@/components/ScoreGauge"
import { ViolationsByYear } from "@/components/ViolationsByYear"

function fmtDate(s: string | null): string {
  if (!s) return "—"
  const d = new Date(s)
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

function isOpen(status: string | null): boolean {
  const s = (status ?? "").toLowerCase()
  return s.includes("active") && !s.includes("not active")
}

function Section({
  title,
  source,
  children,
}: {
  title: string
  source?: string
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
      {source && (
        <CardContent>
          <p className="text-muted-foreground border-t pt-3 text-xs">{source}</p>
        </CardContent>
      )}
    </Card>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>
}

type Tab = "overview" | "conditions" | "safety" | "area"

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "conditions", label: "Conditions" },
  { id: "safety", label: "Safety" },
  { id: "area", label: "Area" },
]

export function BuildingProfile({ data }: { data: Profile }) {
  const { details, score, violations, complaints, complaints_311, block_context } =
    data
  const rent = block_context.rent_inventory
  const evictions = block_context.evictions
  const [tab, setTab] = useState<Tab>("conditions")

  const summary = buildSummary(data)

  return (
    <div>
      {/* Pinned header: address, badges, compact score, tab bar.
          Stays visible while only the active tab's content scrolls. */}
      <div className="bg-background sticky top-0 z-10 -mx-6 border-b px-6 pt-6 pb-0">
        <h1 className="text-2xl font-bold tracking-tight">{data.address}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {rent.likely_rent_controlled && (
            <Badge variant="success">Likely rent-controlled</Badge>
          )}
          {details.year_built && (
            <Badge variant="secondary">Built {details.year_built}</Badge>
          )}
          {details.units != null && (
            <Badge variant="secondary">
              {details.units} unit{details.units === 1 ? "" : "s"}
            </Badge>
          )}
          {data.seismic.retrofitted && (
            <Badge variant="success">Retrofitted</Badge>
          )}
          {data.seismic.non_compliant && (
            <Badge variant="destructive">Not retrofitted</Badge>
          )}
        </div>

        <div className="mt-3">
          <ScoreGaugeCompact score={score} />
        </div>

        {/* tab bar */}
        <div className="mt-3 flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`border-b-2 px-3 py-2 text-sm transition-colors ${
                tab === t.id
                  ? "border-foreground font-medium"
                  : "text-muted-foreground border-transparent hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="space-y-5 pt-5">
        {/* ===== OVERVIEW ===== */}
        {tab === "overview" && (
          <>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {summary}
            </p>
            <Section title="Building Health Score">
              <ScoreGauge score={score} />
            </Section>
            <OverviewExtras data={data} />
          </>
        )}

        {/* ===== CONDITIONS ===== */}
        {tab === "conditions" && (
          <>
      {/* DBI Violations — grouped like NYCStoops: hazardous vs other, then
          open/closed counts, the individual list, and a by-year chart. */}
      <Section
        title="DBI Violations"
        source="Source: SF DBI Notices of Violation (nbtm-fbw5), live from DataSF."
      >
        {violations.count === 0 ? (
          <Empty>No DBI violations on record for this parcel.</Empty>
        ) : (
          <div className="space-y-5">
            <ViolationGroups violations={violations} />

            <Separator />

            {/* Open */}
            <div>
              <p className="text-muted-foreground text-xs tracking-wide uppercase">
                Open
              </p>
              <div className="mt-1 flex items-baseline gap-2">
                <span
                  className={`text-3xl font-bold tabular-nums ${violations.open > 0 ? "text-destructive" : ""}`}
                >
                  {violations.open}
                </span>
                <span className="text-muted-foreground text-sm">
                  open violation{violations.open === 1 ? "" : "s"}
                </span>
              </div>
            </div>

            {/* Closed (historical) */}
            <div>
              <p className="text-muted-foreground text-xs tracking-wide uppercase">
                Closed (historical)
              </p>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold tabular-nums">
                  {Math.max(violations.count - violations.open, 0)}
                </span>
                <span className="text-muted-foreground text-sm">
                  closed / resolved
                </span>
              </div>
            </div>

            {/* Individual violations */}
            <div>
              <div className="flex items-baseline justify-between">
                <p className="text-sm font-medium">Individual violations</p>
                <span className="text-muted-foreground text-xs">
                  Showing {Math.min(10, violations.items.length)} of{" "}
                  {violations.count}
                </span>
              </div>
              <ul className="mt-2 divide-y">
                {violations.items.slice(0, 10).map((v, i) => (
                  <li key={`${v.complaint_number}-${i}`} className="py-2">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-sm">{v.item ?? v.category}</span>
                      <Badge
                        variant={isOpen(v.status) ? "destructive" : "outline"}
                      >
                        {v.status ?? "—"}
                      </Badge>
                    </div>
                    <span className="text-muted-foreground text-xs">
                      {v.category} · filed {fmtDate(v.date_filed)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <Separator />
            <ViolationsByYear items={violations.items} />
          </div>
        )}
      </Section>

      {/* DBI Complaints */}
      <Section
        title="DBI Complaints"
        source="Source: SF DBI Complaints (gm2e-bten), live from DataSF."
      >
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Open" value={complaints.open} accent="destructive" />
          <Stat label="Total on record" value={complaints.count} />
        </div>
        {complaints.items.length > 0 ? (
          <ul className="divide-y">
            {complaints.items.slice(0, 10).map((c, i) => (
              <li key={`${c.complaint_number}-${i}`} className="py-2">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-sm">{c.description ?? "—"}</span>
                  <Badge variant={isOpen(c.status) ? "destructive" : "outline"}>
                    {c.status ?? "—"}
                  </Badge>
                </div>
                <span className="text-muted-foreground text-xs">
                  filed {fmtDate(c.date_filed)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No DBI complaints on record for this parcel.</Empty>
        )}
      </Section>

      {/* 311 */}
      <Section
        title="311 Housing Complaints"
        source="Source: SF 311 cases (vw6y-z8j6), filtered to housing/habitability categories."
      >
        <Stat label="Housing-related 311 cases" value={complaints_311.count} />
        {Object.keys(complaints_311.by_category).length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {Object.entries(complaints_311.by_category)
              .sort((a, b) => b[1] - a[1])
              .map(([cat, n]) => (
                <Badge key={cat} variant="secondary">
                  {cat} · {n}
                </Badge>
              ))}
          </div>
        ) : (
          <Empty>No housing-related 311 complaints on file.</Empty>
        )}
      </Section>
          </>
        )}

        {/* ===== SAFETY ===== */}
        {tab === "safety" && (
          <>
      {/* Safety: crime + fire nearby */}
      <Section
        title="Crime Nearby"
        source={`Source: SFPD Incident Reports (wg3w-h783), within ${data.crime.radius_m}m, since ${data.crime.since ?? "2024"}. Reflects the area, not this building specifically.`}
      >
        <Stat
          label={`incidents within ${data.crime.radius_m}m (since ${data.crime.since ?? "2024"})`}
          value={data.crime.count}
          accent={data.crime.count > 200 ? "destructive" : undefined}
        />
        {Object.keys(data.crime.by_category).length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {Object.entries(data.crime.by_category)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([cat, n]) => (
                <Badge key={cat} variant="secondary">
                  {cat} · {n}
                </Badge>
              ))}
          </div>
        ) : (
          <Empty>No recent incidents recorded nearby.</Empty>
        )}
      </Section>

      <Section
        title="Fire Incidents"
        source="Source: SF Fire Department incident reports (wr8u-xric), within 75m."
      >
        <Stat
          label="fire incidents nearby (recent)"
          value={data.fire.count}
          accent={data.fire.count > 0 ? "destructive" : undefined}
        />
        {data.fire.recent.length > 0 && (
          <ul className="text-muted-foreground text-xs">
            {data.fire.recent.map((f, i) => (
              <li key={i}>
                {fmtDate(f.date)} — {f.address}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Seismic / soft-story */}
      <Section
        title="Seismic Safety"
        source="Source: SF Mandatory Soft-Story Program (beah-shgi). Covers wood-frame multi-unit buildings required to retrofit."
      >
        {!data.seismic.in_program ? (
          <Empty>
            Not in the city’s mandatory soft-story retrofit program (typically
            means it isn’t a wood-frame soft-story building, or isn’t covered).
          </Empty>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {data.seismic.retrofitted && (
              <Badge variant="success">Seismically retrofitted</Badge>
            )}
            {data.seismic.non_compliant && (
              <Badge variant="destructive">Non-compliant — not retrofitted</Badge>
            )}
            <Badge variant="outline">{data.seismic.status}</Badge>
            {data.seismic.tier && (
              <Badge variant="secondary">Tier {data.seismic.tier}</Badge>
            )}
          </div>
        )}
      </Section>
          </>
        )}

        {/* ===== AREA ===== */}
        {tab === "area" && (
          <>
      {/* Transit */}
      <Section
        title="Transit Access"
        source="Source: SFMTA Muni Stops (i28k-bkz6), within 500m walking distance."
      >
        <Stat label="Muni stops within 500m" value={data.transit.count} />
        {data.transit.nearest.length > 0 && (
          <ul className="text-sm">
            {data.transit.nearest.map((s, i) => (
              <li key={i} className="flex justify-between border-b py-1.5">
                <span>{s.name}</span>
                <span className="text-muted-foreground tabular-nums">
                  {s.meters} m
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Evictions (block-level) */}
      <Section
        title="Evictions"
        source="Source: SF Rent Board eviction notices (5cei-gny5). SF anonymizes these to the block level for privacy."
      >
        <div className="flex items-center gap-2">
          <Stat label="Eviction notices nearby" value={evictions.count} />
          <Badge variant="warning">block-level</Badge>
        </div>
        {Object.keys(evictions.by_reason).length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {Object.entries(evictions.by_reason)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, n]) => (
                <Badge key={reason} variant="secondary">
                  {reason} · {n}
                </Badge>
              ))}
          </div>
        ) : (
          <Empty>No eviction notices recorded on this block.</Empty>
        )}
      </Section>

      {/* Rent status (block-level) */}
      <Section
        title="Rent Stabilization"
        source="Source: SF Rent Board Housing Inventory (gdc7-dmcn), block-level. SF rent control generally applies to multi-unit buildings built before June 1979."
      >
        <div className="flex flex-wrap items-center gap-2">
          {rent.likely_rent_controlled === true && (
            <Badge variant="success">Likely rent-controlled</Badge>
          )}
          {rent.likely_rent_controlled === false && (
            <Badge variant="outline">Likely not rent-controlled</Badge>
          )}
          {rent.likely_rent_controlled === null && (
            <Badge variant="outline">Unknown</Badge>
          )}
          <Badge variant="warning">block-level</Badge>
        </div>
        {rent.units_reported > 0 && (
          <Empty>
            {rent.units_reported} unit
            {rent.units_reported === 1 ? "" : "s"} reported in the Rent Board
            inventory near this block.
          </Empty>
        )}
      </Section>

      {/* Permits */}
      <Section
        title="Building Permits"
        source="Source: SF DBI Building Permits (i98e-djp9). Recent permits signal renovation; absence of permits for visible work can be a red flag."
      >
        <Stat label="permits on record" value={data.permits.count} />
        {data.permits.items.length > 0 ? (
          <ul className="divide-y">
            {data.permits.items.slice(0, 6).map((p, i) => (
              <li key={`${p.permit_number}-${i}`} className="py-2">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-sm">{p.description ?? p.type}</span>
                  <Badge variant="outline">{p.status ?? "—"}</Badge>
                </div>
                <span className="text-muted-foreground text-xs">
                  {p.type} · filed {fmtDate(p.filed_date)}
                  {p.estimated_cost
                    ? ` · est. $${p.estimated_cost.toLocaleString()}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No permits on record for this parcel.</Empty>
        )}
      </Section>
          </>
        )}
      </div>
    </div>
  )
}

// Building details + official records, rendered in the Overview tab.
function OverviewExtras({ data }: { data: Profile }) {
  const { details } = data
  return (
    <>
      <Section
        title="Building Details"
        source="Source: SF Assessor Secured Property Roll (wv5m-vpq2). Owner names are not published in SF's free public data."
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <Meta term="Use" value={details.use ?? "—"} />
          <Meta term="Class" value={details.property_class ?? "—"} />
          <Meta term="Year built" value={details.year_built ?? "—"} />
          <Meta term="Units" value={details.units?.toString() ?? "—"} />
          <Meta term="Stories" value={details.stories?.toString() ?? "—"} />
          <Meta term="Zoning" value={details.zoning ?? "—"} />
          <Meta
            term="Lot area"
            value={details.lot_area_sqft ? `${details.lot_area_sqft} sqft` : "—"}
          />
          <Meta
            term="Building area"
            value={
              details.property_area_sqft
                ? `${details.property_area_sqft} sqft`
                : "—"
            }
          />
          <Meta
            term="Assessed value"
            value={
              details.assessed_value
                ? `$${details.assessed_value.toLocaleString()}`
                : "—"
            }
          />
        </dl>
      </Section>

      <Section title="Official Records">
        <p className="text-muted-foreground text-sm">
          These links open official SF and third-party records. Bay Window does
          not control their content.
        </p>
        <div className="flex flex-wrap gap-2">
          <RecordLink
            href="https://dbiweb02.sfgov.org/dbipts/default.aspx?page=AddressQuery"
            label="SF DBI Lookup"
          />
          {data.block && data.lot && (
            <RecordLink
              href={`https://sfplanninggis.org/pim/?search=${data.block}${data.lot}`}
              label="Property Info Map"
            />
          )}
          <RecordLink
            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(data.address ?? "")}`}
            label="Google Maps"
          />
        </div>
      </Section>
    </>
  )
}

// SF DBI categories that tend to indicate a habitability hazard, surfaced
// separately (analogous to NYCStoops' "immediately hazardous" group).
const HAZARDOUS_CATEGORIES = [
  "sanitation",
  "plumbing",
  "electrical",
  "fire",
  "heat",
  "mechanical",
]

function isHazardous(category: string | null): boolean {
  const c = (category ?? "").toLowerCase()
  return HAZARDOUS_CATEGORIES.some((k) => c.includes(k))
}

// Two chip groups summarizing violation categories by severity, with counts.
function ViolationGroups({ violations }: { violations: Violations }) {
  const hazardous: [string, number][] = []
  const other: [string, number][] = []
  for (const [cat, n] of Object.entries(violations.by_category)) {
    ;(isHazardous(cat) ? hazardous : other).push([cat, n])
  }
  hazardous.sort((a, b) => b[1] - a[1])
  other.sort((a, b) => b[1] - a[1])

  return (
    <div className="space-y-4">
      {hazardous.length > 0 && (
        <div>
          <p className="text-muted-foreground text-xs tracking-wide uppercase">
            Potentially hazardous
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {hazardous.map(([cat, n]) => (
              <Badge key={cat} variant="destructive">
                {cat} ×{n}
              </Badge>
            ))}
          </div>
          <p className="text-muted-foreground mt-1 text-xs italic">
            Sanitation, plumbing/electrical, fire, and heat — habitability
            risks.
          </p>
        </div>
      )}
      {other.length > 0 && (
        <div>
          <p className="text-muted-foreground text-xs tracking-wide uppercase">
            Other violations
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {other.map(([cat, n]) => (
              <Badge key={cat} variant="outline">
                {cat} ×{n}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Meta({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-[0.7rem] uppercase tracking-wide">
        {term}
      </dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent?: "destructive"
}) {
  return (
    <div>
      <p
        className={cnStat(accent, value)}
      >
        {value}
      </p>
      <p className="text-muted-foreground text-xs">{label}</p>
    </div>
  )
}

function cnStat(accent: "destructive" | undefined, value: number): string {
  const base = "text-2xl font-bold tabular-nums"
  if (accent === "destructive" && value > 0) return `${base} text-destructive`
  return base
}

function RecordLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="border-input hover:bg-accent inline-flex items-center rounded-md border px-3 py-1.5 text-sm transition-colors"
    >
      {label} ↗
    </a>
  )
}

function buildSummary(d: Profile): string {
  const parts: string[] = []
  const v = d.violations.open
  const c = d.complaints.open
  if (v === 0 && c === 0 && d.violations.count === 0 && d.complaints.count === 0) {
    parts.push("This building has a clean DBI record with no violations or complaints on file.")
  } else {
    const bits: string[] = []
    if (v > 0) bits.push(`${v} open violation${v === 1 ? "" : "s"}`)
    if (c > 0) bits.push(`${c} open complaint${c === 1 ? "" : "s"}`)
    if (bits.length) parts.push(`This building has ${bits.join(" and ")} on record.`)
    else parts.push("This building has past DBI issues that are now resolved.")
  }
  if (d.block_context.evictions.count > 0) {
    parts.push(
      `${d.block_context.evictions.count} eviction notice${d.block_context.evictions.count === 1 ? "" : "s"} recorded on this block (SF anonymizes evictions to block level).`,
    )
  } else {
    parts.push("No eviction notices are recorded on this block.")
  }
  return parts.join(" ")
}
