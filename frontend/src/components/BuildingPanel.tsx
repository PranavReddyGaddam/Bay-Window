import { useEffect, useState } from "react"

import { getBuilding, type BuildingProfile as Profile } from "@/lib/api"
import { BuildingProfile } from "@/components/BuildingProfile"

// Right-side slide-over that shows a building's full profile while the map
// stays visible behind it (modeled on NYCStoops' "building profile" panel).
export function BuildingPanel({
  address,
  onClose,
  onCoords,
}: {
  address: string | null
  onClose: () => void
  /** called once the building's coordinates are known, so the map can fly + mark it */
  onCoords?: (lat: number, lon: number) => void
}) {
  const open = address != null
  const [data, setData] = useState<Profile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!address) return
    let cancelled = false
    setData(null)
    setError(null)
    setLoading(true)
    getBuilding(address)
      .then((d) => {
        if (cancelled) return
        setData(d)
        if (d.location?.lat != null && d.location?.lon != null) {
          onCoords?.(d.location.lat, d.location.lon)
        }
      })
      .catch((e) => !cancelled && setError(e?.message ?? "Failed to load"))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  // close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  return (
    <aside
      aria-hidden={!open}
      className={`bg-background absolute top-0 right-0 z-[1200] flex h-full w-full max-w-[640px] flex-col border-l shadow-2xl transition-transform duration-300 ease-out ${
        open ? "translate-x-0" : "pointer-events-none translate-x-full"
      }`}
    >
      {/* sticky header bar */}
      <div className="flex items-center justify-between border-b px-6 py-4">
        <span className="text-muted-foreground font-mono text-xs">
          building profile
        </span>
        <button
          onClick={onClose}
          className="text-sm font-medium hover:opacity-70"
          data-cursor="pointer"
        >
          Close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        {loading && (
          <div className="space-y-4 py-6">
            <div className="bg-muted h-10 w-3/4 animate-pulse rounded" />
            <div className="bg-muted h-40 w-full animate-pulse rounded-xl" />
            <div className="bg-muted h-40 w-full animate-pulse rounded-xl" />
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-dashed p-8 text-center">
            <p className="font-medium">Couldn’t load this building</p>
            <p className="text-muted-foreground mt-1 text-sm">{error}</p>
          </div>
        )}
        {data && <BuildingProfile data={data} />}
      </div>
    </aside>
  )
}
