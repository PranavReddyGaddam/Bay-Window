import { useEffect, useRef, useState } from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"

import { getBuildings, type BuildingDot, type HealthBucket } from "@/lib/api"
import { AddressSearch } from "@/components/AddressSearch"

// Full-bleed SF map, modeled on NYCStoops' /map view. Zoomed out: a
// neighborhood choropleth (housing density). Zoomed in (>= BUILDING_ZOOM):
// individual building dots colored by health, with a building count + a
// "building health" legend. Clicking a neighborhood smoothly flies in.

const NEIGHBORHOODS_GEOJSON =
  "https://data.sfgov.org/resource/j2bu-swwd.geojson?$limit=200"

const BUILDING_ZOOM = 15 // at/above this, show individual buildings

// CARTO basemaps — swapped to match light/dark mode.
const CARTO_LIGHT =
  "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
const CARTO_DARK =
  "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"

// Density choropleth ramp — Golden State Warriors blue → gold (SF identity).
// Low density = light Warriors blue, climbing to gold at very high.
const DENSITY_COLORS_LIGHT = ["#c7d4ec", "#7d9bd1", "#3a63ad", "#1d428a"]
const DENSITY_COLORS_DARK = ["#1d428a", "#3f6cc4", "#caa53a", "#ffc72c"]

const HEALTH_COLORS: Record<HealthBucket, string> = {
  excellent: "#2e7d32",
  decent: "#5b6470", // mid slate — legible on both light and dark tiles
  mixed: "#f5b301",
  poor: "#d32f2f",
  unknown: "#bdbdbd",
}

function isDarkMode(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  )
}

function densityColor(level: number, dark: boolean): string {
  const ramp = dark ? DENSITY_COLORS_DARK : DENSITY_COLORS_LIGHT
  return ramp[Math.max(0, Math.min(3, level))]
}

function densityFor(name: string): number {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % 4
}

interface Props {
  onPick: (address: string) => void
  onOpenBuilding: (address: string) => void
  selectedAddress: string | null
  selectedLatLon: [number, number] | null
}

export function MapView({
  onPick,
  onOpenBuilding,
  selectedAddress,
  selectedLatLon,
}: Props) {
  const mapEl = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const hoodLayerRef = useRef<L.GeoJSON | null>(null)
  const dotLayerRef = useRef<L.LayerGroup | null>(null)
  const selectedMarkerRef = useRef<L.CircleMarker | null>(null)
  const tileRef = useRef<L.TileLayer | null>(null)
  const fetchSeq = useRef(0)

  const [zoomed, setZoomed] = useState(false)
  const [dark, setDark] = useState(isDarkMode())
  const [hoodCount, setHoodCount] = useState<number | null>(null)
  const [buildingCount, setBuildingCount] = useState<number | null>(null)
  const [loadingDots, setLoadingDots] = useState(false)
  const [filters, setFilters] = useState({ rent: false, violations: false })
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  // keep the last-fetched dots so we can re-filter without re-fetching
  const dotsData = useRef<BuildingDot[]>([])

  const SF_CENTER: [number, number] = [37.7649, -122.4394]

  useEffect(() => {
    if (!mapEl.current || mapRef.current) return
    const map = L.map(mapEl.current, {
      center: SF_CENTER,
      zoom: 12,
      zoomControl: false,
      zoomAnimation: true,
      zoomSnap: 0.25, // finer steps -> smoother fly
      wheelPxPerZoomLevel: 120,
    })
    mapRef.current = map

    const isDark = document.documentElement.classList.contains("dark")
    tileRef.current = L.tileLayer(
      isDark ? CARTO_DARK : CARTO_LIGHT,
      {
        attribution:
          '<a href="https://leafletjs.com">Leaflet</a> | &copy; <a href="https://carto.com/attributions">CARTO</a> · Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      },
    ).addTo(map)

    L.control.zoom({ position: "topleft" }).addTo(map)

    const dots = L.layerGroup().addTo(map)
    dotLayerRef.current = dots

    fetch(NEIGHBORHOODS_GEOJSON)
      .then((r) => r.json())
      .then((geo: GeoJSON.FeatureCollection) => {
        setHoodCount(geo.features.length)
        const layer = L.geoJSON(geo, {
          style: (f) => ({
            fillColor: densityColor(
              densityFor((f?.properties as { nhood?: string })?.nhood ?? ""),
              isDarkMode(),
            ),
            fillOpacity: isDarkMode() ? 0.6 : 0.75,
            color: isDarkMode() ? "#0b1f47" : "#ffffff",
            weight: 1,
          }),
          onEachFeature: (f, lyr) => {
            const name = (f.properties as { nhood?: string }).nhood ?? ""
            lyr.bindTooltip(name, { sticky: true, direction: "top" })
            lyr.on({
              mouseover: (e) =>
                (e.target as L.Path).setStyle({ fillOpacity: 1, weight: 2 }),
              mouseout: (e) =>
                (e.target as L.Path).setStyle({ fillOpacity: 0.85, weight: 1 }),
              // smooth fly into the clicked neighborhood, zooming close
              // enough to show individual buildings
              click: () => {
                const b = (lyr as L.GeoJSON).getBounds()
                // zoom in close to street/building level (clamped to max zoom)
                const targetZoom = Math.min(
                  map.getMaxZoom(),
                  Math.max(BUILDING_ZOOM + 3, map.getBoundsZoom(b)),
                )
                map.flyTo(b.getCenter(), targetZoom, {
                  duration: 1.2,
                  easeLinearity: 0.15,
                })
              },
            })
          },
        }).addTo(map)
        hoodLayerRef.current = layer
        map.fitBounds(layer.getBounds(), { padding: [20, 20] })
      })
      .catch(() => setHoodCount(0))

    const onZoomEnd = () => syncLayers(map)
    const onMoveEnd = () => {
      if (map.getZoom() >= BUILDING_ZOOM) loadBuildings(map)
    }
    map.on("zoomend", onZoomEnd)
    map.on("moveend", onMoveEnd)
    syncLayers(map)

    return () => {
      map.off("zoomend", onZoomEnd)
      map.off("moveend", onMoveEnd)
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When filters change in the zoomed-in view, re-filter the dots in place.
  useEffect(() => {
    if (zoomed) renderDots()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, zoomed])

  // Swap the basemap tiles to match light/dark mode. The toggle flips the
  // `dark` class on <html>, so we observe that and switch the tile URL.
  useEffect(() => {
    const apply = () => {
      const isDark = document.documentElement.classList.contains("dark")
      setDark(isDark)
      tileRef.current?.setUrl(isDark ? CARTO_DARK : CARTO_LIGHT)
      // recolor the neighborhood choropleth for the new theme
      hoodLayerRef.current?.resetStyle()
    }
    const observer = new MutationObserver(apply)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => observer.disconnect()
  }, [])

  // When a building is selected (via search or dot click), fly to it and draw
  // an enlarged highlighted marker so the selection is unmistakable.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    // remove any previous selection marker
    if (selectedMarkerRef.current) {
      selectedMarkerRef.current.remove()
      selectedMarkerRef.current = null
    }
    if (!selectedAddress || !selectedLatLon) return
    const [lat, lon] = selectedLatLon
    map.flyTo([lat, lon], Math.max(map.getZoom(), 17), { duration: 1.0 })
    const marker = L.circleMarker([lat, lon], {
      radius: 11,
      color: "#fff",
      weight: 3,
      fillColor: "#FF4200", // brand orange, like Stoop's selected pin
      fillOpacity: 1,
    })
    marker.bindTooltip(selectedAddress, { direction: "top", offset: [0, -8] })
    marker.addTo(map)
    selectedMarkerRef.current = marker
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAddress, selectedLatLon])

  // The map-tint overlay color for the zoomed-out (expanded) view:
  // violations -> light red, rent -> light blue, both -> light purple.
  const tint =
    !zoomed && filters.rent && filters.violations
      ? "rgba(168, 85, 247, 0.16)" // purple
      : !zoomed && filters.violations
        ? "rgba(239, 68, 68, 0.16)" // red
        : !zoomed && filters.rent
          ? "rgba(59, 130, 246, 0.16)" // blue
          : "transparent"

  // Toggle layers by zoom: zoomed in shows the plain basemap + building dots
  // (choropleth fully removed); zoomed out shows the neighborhood choropleth.
  function syncLayers(map: L.Map) {
    const isBuildings = map.getZoom() >= BUILDING_ZOOM
    setZoomed(isBuildings)
    const hood = hoodLayerRef.current
    if (hood) {
      if (isBuildings && map.hasLayer(hood)) map.removeLayer(hood)
      if (!isBuildings && !map.hasLayer(hood)) hood.addTo(map)
    }
    if (isBuildings) loadBuildings(map)
    else {
      dotLayerRef.current?.clearLayers()
      setBuildingCount(null)
    }
  }

  async function loadBuildings(map: L.Map) {
    const seq = ++fetchSeq.current
    setLoadingDots(true)
    const b = map.getBounds()
    try {
      const { buildings, count } = await getBuildings({
        south: b.getSouth(),
        west: b.getWest(),
        north: b.getNorth(),
        east: b.getEast(),
      })
      if (seq !== fetchSeq.current) return // stale
      dotsData.current = buildings
      renderDots()
      setBuildingCount(count)
    } catch {
      /* ignore transient bbox errors */
    } finally {
      if (seq === fetchSeq.current) setLoadingDots(false)
    }
  }

  // Render the stored dots, applying the active filters (zoomed-in behavior:
  // only show buildings matching the selected filter).
  function renderDots() {
    const group = dotLayerRef.current
    if (!group) return
    group.clearLayers()
    const { rent, violations } = filtersRef.current
    let shown = 0
    for (const d of dotsData.current) {
      if (rent && !d.rentStabilized) continue
      if (violations && !d.highViolations) continue
      const marker = L.circleMarker([d.lat, d.lon], {
        radius: 4,
        color: "#fff",
        weight: 0.5,
        fillColor: HEALTH_COLORS[d.health],
        fillOpacity: 0.95,
        // show a pointer cursor over a building dot
        className: "building-dot",
      })
      if (d.address) {
        marker.bindTooltip(d.address, { direction: "top", offset: [0, -4] })
      }
      marker.on({
        mouseover: (e) => (e.target as L.CircleMarker).setRadius(7),
        mouseout: (e) => (e.target as L.CircleMarker).setRadius(4),
        click: () => d.address && onOpenBuilding(d.address),
      })
      marker.addTo(group)
      shown++
    }
    setBuildingCount(shown)
  }

  function resetView() {
    mapRef.current?.flyTo(SF_CENTER, 12, { duration: 1.0 })
  }

  return (
    <div className="relative h-full w-full">
      <div ref={mapEl} className="absolute inset-0" />

      {/* filter tint overlay (expanded view only) */}
      <div
        className="pointer-events-none absolute inset-0 z-[800] transition-colors duration-300"
        style={{ backgroundColor: tint }}
      />

      {/* top-left: search + reset */}
      <div className="absolute top-4 left-16 z-[1000] w-80 max-w-[70vw]">
        <div className="bg-background rounded-lg shadow-md">
          <AddressSearch onSelect={onPick} />
        </div>
        <button
          onClick={resetView}
          className="bg-background mt-2 rounded-md border px-3 py-1.5 text-xs shadow-sm hover:bg-muted"
        >
          Reset view
        </button>
      </div>

      {/* top-right: filter pills + count */}
      <div className="absolute top-4 right-4 z-[1000] flex flex-col items-end gap-2">
        <div className="flex gap-2">
          <button
            onClick={() => setFilters((f) => ({ ...f, rent: !f.rent }))}
            className={`rounded-md border px-3 py-1.5 text-xs shadow-sm transition-colors ${
              filters.rent
                ? "border-blue-500 bg-blue-500 text-white"
                : "bg-background border-blue-500 text-blue-600 hover:bg-blue-50"
            }`}
          >
            has rent stabilized unit(s)
          </button>
          <button
            onClick={() =>
              setFilters((f) => ({ ...f, violations: !f.violations }))
            }
            className={`rounded-md border px-3 py-1.5 text-xs shadow-sm transition-colors ${
              filters.violations
                ? "border-red-500 bg-red-500 text-white"
                : "bg-background border-red-500 text-red-600 hover:bg-red-50"
            }`}
          >
            high violations
          </button>
        </div>
        <span className="bg-background rounded-md border px-3 py-1 text-xs shadow-sm">
          {loadingDots
            ? "loading…"
            : zoomed && buildingCount != null
              ? `${buildingCount.toLocaleString()} buildings`
              : hoodCount != null
                ? `${hoodCount} neighborhoods`
                : "…"}
        </span>
      </div>

      {/* bottom-right: legend (swaps with zoom) */}
      <div className="bg-background absolute right-4 bottom-8 z-[1000] w-56 rounded-lg border p-4 shadow-md">
        {zoomed ? (
          <>
            <p className="text-sm font-medium">building health</p>
            <ul className="mt-2 space-y-1.5">
              {(
                [
                  ["excellent", "excellent"],
                  ["decent", "decent"],
                  ["mixed", "mixed"],
                  ["poor", "poor"],
                  ["unknown", "not enough data"],
                ] as [HealthBucket, string][]
              ).map(([key, label]) => (
                <li key={key} className="flex items-center gap-2 text-sm">
                  <span
                    className="inline-block h-3.5 w-3.5 rounded-full"
                    style={{ backgroundColor: HEALTH_COLORS[key] }}
                  />
                  {label}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">housing density</p>
            <ul className="mt-2 space-y-1.5">
              {["low", "med", "high", "very high"].map((label, i) => (
                <li key={label} className="flex items-center gap-2 text-sm">
                  <span
                    className="inline-block h-4 w-4 rounded-sm border"
                    style={{ backgroundColor: densityColor(i, dark) }}
                  />
                  {label}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-3 text-xs">
              zoom in for individual buildings
            </p>
          </>
        )}
      </div>
    </div>
  )
}
