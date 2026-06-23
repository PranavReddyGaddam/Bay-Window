import { useMemo, useState } from "react"

import type { ViolationItem } from "@/lib/api"

// Bar chart of violations filed per year, modeled on NYCStoops' "Violations by
// year". Bars for years that include an open/active violation are highlighted
// red (analogous to Stoop's hazardous-year bars).

function yearOf(dateStr: string | null): number | null {
  if (!dateStr) return null
  const y = new Date(dateStr).getFullYear()
  return Number.isFinite(y) ? y : null
}

function isOpen(status: string | null): boolean {
  const s = (status ?? "").toLowerCase()
  return s.includes("active") && !s.includes("not active")
}

export function ViolationsByYear({ items }: { items: ViolationItem[] }) {
  const [hover, setHover] = useState<number | null>(null)

  const { bars, max } = useMemo(() => {
    const total = new Map<number, number>()
    const open = new Map<number, number>()
    for (const v of items) {
      const y = yearOf(v.date_filed)
      if (y == null) continue
      total.set(y, (total.get(y) ?? 0) + 1)
      if (isOpen(v.status)) open.set(y, (open.get(y) ?? 0) + 1)
    }
    const present = [...total.keys()].sort((a, b) => a - b)
    if (present.length === 0) return { bars: [], max: 0 }
    // fill the full year range so gaps show as empty bars (like the reference)
    const first = present[0]
    const last = present[present.length - 1]
    const bars: { year: number; count: number; open: number }[] = []
    for (let y = first; y <= last; y++) {
      bars.push({ year: y, count: total.get(y) ?? 0, open: open.get(y) ?? 0 })
    }
    const max = bars.reduce((m, b) => Math.max(m, b.count), 0)
    return { bars, max }
  }, [items])

  if (bars.length === 0) return null

  return (
    <div>
      <p className="mb-3 text-sm font-medium">Violations by year</p>
      <div className="flex h-40 items-end gap-1.5">
        {bars.map((b) => {
          const h = max > 0 ? Math.max(b.count > 0 ? 6 : 2, (b.count / max) * 140) : 2
          const hazardous = b.open > 0
          return (
            <div
              key={b.year}
              className="flex max-w-16 flex-1 flex-col items-center gap-1"
              onMouseEnter={() => setHover(b.year)}
              onMouseLeave={() => setHover(null)}
            >
              <div className="relative w-full">
                {hover === b.year && (
                  <div className="bg-popover absolute -top-9 left-1/2 z-10 -translate-x-1/2 rounded border px-2 py-1 text-xs whitespace-nowrap shadow">
                    {b.year}: {b.count} violation{b.count === 1 ? "" : "s"}
                    {b.open > 0 ? ` (${b.open} open)` : ""}
                  </div>
                )}
                <div
                  className="w-full rounded-sm transition-colors"
                  style={{
                    height: h,
                    backgroundColor: hazardous
                      ? "var(--destructive)"
                      : "var(--muted-foreground)",
                    opacity: hover === null || hover === b.year ? 1 : 0.5,
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
      <div className="text-muted-foreground mt-1 flex justify-between text-[10px]">
        <span>{bars[0].year}</span>
        {bars.length > 1 && <span>{bars[bars.length - 1].year}</span>}
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        Red bars indicate years with open (active) violations.
      </p>
    </div>
  )
}
