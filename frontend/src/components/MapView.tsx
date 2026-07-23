import { useEffect, useRef, useState } from "react"
import * as maplibregl from "maplibre-gl"
import {
  Map as MLMap,
  type MapGeoJSONFeature,
  type LngLatBoundsLike,
} from "maplibre-gl"
import type {
  Feature,
  FeatureCollection,
  Polygon,
  MultiPolygon,
} from "geojson"
import { Protocol } from "pmtiles"
import "maplibre-gl/dist/maplibre-gl.css"

import { getBuildings, type BuildingDot, type HealthBucket } from "@/lib/api"
import { AddressSearch } from "@/components/AddressSearch"

// Keep the shared worker pool alive across map remove/create cycles —
// React StrictMode mounts, unmounts, and remounts the map in one tick, and
// without prewarm the torn-down pool leaves GeoJSON sources stuck loading.
maplibregl.prewarm()

// Full-bleed SF map on MapLibre GL. Zoomed out: a neighborhood choropleth
// (housing density). Zoomed in (>= BUILDING_ZOOM): individual building dots
// colored by health, with a building count + a "building health" legend.
// A "3D buildings" toggle pitches the same camera and fades in fill-extrusion
// footprints (GlobalBuildingAtlas heights, served from a local PMTiles
// archive) — one continuous map, no second renderer.

const NEIGHBORHOODS_GEOJSON =
  "https://data.sfgov.org/resource/j2bu-swwd.geojson?$limit=200"

const PMTILES_PATH = "/sf-buildings.pmtiles"

// Leaflet zoom N ≈ MapLibre zoom N-1 (256px vs 512px tiles). The old Leaflet
// threshold was 15, so buildings appear at MapLibre zoom 14.
const BUILDING_ZOOM = 14

const CARTO_LIGHT = "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png"
const CARTO_DARK = "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png"

// Density choropleth ramp — Golden State Warriors blue → gold (SF identity).
const DENSITY_COLORS_LIGHT = ["#c7d4ec", "#7d9bd1", "#3a63ad", "#1d428a"]
const DENSITY_COLORS_DARK = ["#1d428a", "#3f6cc4", "#caa53a", "#ffc72c"]

const HEALTH_COLORS: Record<HealthBucket, string> = {
  excellent: "#2e7d32",
  decent: "#5b6470", // mid slate — legible on both light and dark tiles
  mixed: "#f5b301",
  poor: "#d32f2f",
  unknown: "#bdbdbd",
}

// Neutral extrusion tone for footprints with no health match.
const EXTRUDE_NEUTRAL_LIGHT = "#9ca3af"
const EXTRUDE_NEUTRAL_DARK = "#4b5563"

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

// Precompute a density level per feature so the choropleth can be driven by a
// data expression instead of per-feature styles.
function withDensity(geo: FeatureCollection): FeatureCollection {
  for (const f of geo.features) {
    const props = (f.properties ?? {}) as Record<string, unknown>
    props.density = densityFor((props.nhood as string) ?? "")
    f.properties = props
  }
  return geo
}

function densityRampExpression(dark: boolean): maplibregl.ExpressionSpecification {
  const ramp = dark ? DENSITY_COLORS_DARK : DENSITY_COLORS_LIGHT
  return [
    "match",
    ["get", "density"],
    0, ramp[0],
    1, ramp[1],
    2, ramp[2],
    ramp[3],
  ]
}

function healthMatchExpression(): maplibregl.ExpressionSpecification {
  return [
    "match",
    ["get", "health"],
    "excellent", HEALTH_COLORS.excellent,
    "decent", HEALTH_COLORS.decent,
    "mixed", HEALTH_COLORS.mixed,
    "poor", HEALTH_COLORS.poor,
    HEALTH_COLORS.unknown,
  ]
}

// Extrusion color: feature-state `health` (set after dot→footprint matching)
// wins; otherwise the neutral tone for the current theme.
function extrusionColorExpression(dark: boolean): maplibregl.ExpressionSpecification {
  const neutral = dark ? EXTRUDE_NEUTRAL_DARK : EXTRUDE_NEUTRAL_LIGHT
  return [
    "match",
    ["coalesce", ["feature-state", "health"], "none"],
    "excellent", HEALTH_COLORS.excellent,
    "decent", HEALTH_COLORS.decent,
    "mixed", HEALTH_COLORS.mixed,
    "poor", HEALTH_COLORS.poor,
    "unknown", HEALTH_COLORS.unknown,
    neutral,
  ]
}

const EMPTY_FC: FeatureCollection = {
  type: "FeatureCollection",
  features: [],
}

interface Props {
  onPick: (address: string) => void
  onOpenBuilding: (address: string, coords?: [number, number]) => void
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
  const mapRef = useRef<MLMap | null>(null)
  const fetchSeq = useRef(0)

  const [mapReady, setMapReady] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const [dark, setDark] = useState(isDarkMode())
  const [hoodCount, setHoodCount] = useState<number | null>(null)
  const [buildingCount, setBuildingCount] = useState<number | null>(null)
  const [loadingDots, setLoadingDots] = useState(false)
  const [filters, setFilters] = useState({ rent: false, violations: false })
  const [is3D, setIs3D] = useState(false)
  const [legendOpen, setLegendOpen] = useState(false)
  const is3DRef = useRef(is3D)
  is3DRef.current = is3D
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  // keep the last-fetched dots so we can re-filter without re-fetching
  const dotsData = useRef<BuildingDot[]>([])
  // footprint feature-ids currently carrying a health feature-state, so we can
  // clear them before re-matching (avoids stale colors as the view moves)
  const paintedIds = useRef<Set<string | number>>(new Set())
  const paintedHealth = useRef<Map<string | number, HealthBucket>>(new Map())
  // footprint feature-id → dot address, for 3D building clicks
  const footprintAddress = useRef<
    Map<string | number, { address: string; lat: number; lon: number }>
  >(new Map())
  const paintPending = useRef(false)
  const hoveredDotId = useRef<number | null>(null)
  const hoodHoverId = useRef<number | null>(null)
  const popupRef = useRef<maplibregl.Popup | null>(null)
  const selectedMarkerRef = useRef<maplibregl.Marker | null>(null)

  const SF_CENTER: [number, number] = [-122.4394, 37.7649] // [lon, lat]

  useEffect(() => {
    if (!mapEl.current || mapRef.current) return

    const protocol = new Protocol()
    maplibregl.addProtocol("pmtiles", protocol.tile)
    const archiveUrl = `${window.location.origin}${PMTILES_PATH}`

    const darkNow = isDarkMode()
    const map = new MLMap({
      container: mapEl.current,
      center: SF_CENTER,
      zoom: 11,
      minZoom: 10,
      maxZoom: 18,
      maxPitch: 70,
      attributionControl: { compact: true },
      style: {
        version: 8,
        // glyphs are needed for any symbol layers; harmless otherwise
        glyphs:
          "https://basemaps.arcgis.com/arcgis/rest/services/OpenStreetMap_v2/VectorTileServer/resources/fonts/{fontstack}/{range}.pbf",
        sources: {
          basemap: {
            type: "raster",
            tiles: [darkNow ? CARTO_DARK : CARTO_LIGHT],
            tileSize: 256,
            attribution:
              '&copy; <a href="https://carto.com/attributions">CARTO</a> · <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Heights: <a href="https://github.com/zhu-xlab/GlobalBuildingAtlas">GlobalBuildingAtlas</a> (CC BY-NC 4.0)',
          },
          neighborhoods: { type: "geojson", data: EMPTY_FC, generateId: true },
          dots: { type: "geojson", data: EMPTY_FC, generateId: true },
          footprints: {
            type: "vector",
            url: `pmtiles://${archiveUrl}`,
            // use the OSM/GBA id property as the feature id so
            // setFeatureState can target individual buildings
            promoteId: "id",
          },
        },
        layers: [
          { id: "basemap", type: "raster", source: "basemap" },
          {
            id: "hoods-fill",
            type: "fill",
            source: "neighborhoods",
            maxzoom: BUILDING_ZOOM,
            paint: {
              "fill-color": densityRampExpression(darkNow),
              "fill-opacity": [
                "case",
                ["boolean", ["feature-state", "hover"], false],
                1,
                darkNow ? 0.6 : 0.75,
              ],
            },
          },
          {
            id: "hoods-line",
            type: "line",
            source: "neighborhoods",
            maxzoom: BUILDING_ZOOM,
            paint: {
              "line-color": darkNow ? "#0b1f47" : "#ffffff",
              "line-width": [
                "case",
                ["boolean", ["feature-state", "hover"], false],
                2,
                1,
              ],
            },
          },
          {
            id: "buildings-3d",
            type: "fill-extrusion",
            source: "footprints",
            "source-layer": "buildings",
            paint: {
              "fill-extrusion-color": extrusionColorExpression(darkNow),
              "fill-extrusion-height": ["coalesce", ["get", "height"], 3],
              // hidden until 3D mode; fading opacity gives a soft transition
              "fill-extrusion-opacity": 0,
              "fill-extrusion-opacity-transition": { duration: 500 },
            },
          },
          {
            id: "dots",
            type: "circle",
            source: "dots",
            minzoom: BUILDING_ZOOM,
            paint: {
              "circle-radius": [
                "case",
                ["boolean", ["feature-state", "hover"], false],
                7,
                4,
              ],
              "circle-color": healthMatchExpression(),
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 0.5,
              "circle-opacity": 0.95,
            },
          },
        ],
      },
    })
    mapRef.current = map
    if (import.meta.env.DEV) {
      // dev-only handle for debugging/e2e; stripped from production builds
      ;(window as unknown as { __map?: MLMap }).__map = map
    }

    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      "top-left",
    )

    // --- neighborhoods choropleth ---
    fetch(NEIGHBORHOODS_GEOJSON)
      .then((r) => r.json())
      .then((geo: FeatureCollection) => {
        setHoodCount(geo.features.length)
        const data = withDensity(geo)
        // the source object may not exist until the style finishes loading;
        // retry until it does (covers both before- and after-`load` arrival)
        const applyData = () => {
          const src = map.getSource("neighborhoods") as
            | maplibregl.GeoJSONSource
            | undefined
          if (src) src.setData(data)
          else setTimeout(applyData, 100)
        }
        applyData()
        // fit SF bounds
        const bounds = new maplibregl.LngLatBounds()
        for (const f of data.features) {
          const walk = (coords: unknown): void => {
            if (
              Array.isArray(coords) &&
              typeof coords[0] === "number" &&
              typeof coords[1] === "number"
            ) {
              bounds.extend(coords as [number, number])
            } else if (Array.isArray(coords)) {
              coords.forEach(walk)
            }
          }
          walk((f.geometry as Polygon | MultiPolygon).coordinates)
        }
        if (!bounds.isEmpty()) {
          map.fitBounds(bounds as LngLatBoundsLike, { padding: 20 })
        }
      })
      .catch(() => setHoodCount(0))

    // hover highlight + name tooltip on neighborhoods
    const hoodTooltip = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      className: "map-tooltip",
      offset: 8,
    })
    map.on("mousemove", "hoods-fill", (e) => {
      const f = e.features?.[0] as MapGeoJSONFeature | undefined
      if (!f) return
      map.getCanvas().style.cursor = "pointer"
      if (hoodHoverId.current !== null && hoodHoverId.current !== f.id) {
        map.setFeatureState(
          { source: "neighborhoods", id: hoodHoverId.current },
          { hover: false },
        )
      }
      hoodHoverId.current = f.id as number
      map.setFeatureState({ source: "neighborhoods", id: f.id }, { hover: true })
      const name = (f.properties as { nhood?: string }).nhood ?? ""
      hoodTooltip.setLngLat(e.lngLat).setText(name).addTo(map)
    })
    map.on("mouseleave", "hoods-fill", () => {
      map.getCanvas().style.cursor = ""
      if (hoodHoverId.current !== null) {
        map.setFeatureState(
          { source: "neighborhoods", id: hoodHoverId.current },
          { hover: false },
        )
        hoodHoverId.current = null
      }
      hoodTooltip.remove()
    })
    // click a neighborhood: fly in past the building threshold
    map.on("click", "hoods-fill", (e) => {
      map.flyTo({
        center: e.lngLat,
        zoom: BUILDING_ZOOM + 2.5,
        duration: 1600,
      })
    })

    // --- building dots ---
    map.on("mousemove", "dots", (e) => {
      const f = e.features?.[0] as MapGeoJSONFeature | undefined
      if (!f) return
      map.getCanvas().style.cursor = "pointer"
      if (hoveredDotId.current !== null && hoveredDotId.current !== f.id) {
        map.setFeatureState(
          { source: "dots", id: hoveredDotId.current },
          { hover: false },
        )
      }
      hoveredDotId.current = f.id as number
      map.setFeatureState({ source: "dots", id: f.id }, { hover: true })
      const addr = (f.properties as { address?: string }).address
      if (addr) {
        if (!popupRef.current) {
          popupRef.current = new maplibregl.Popup({
            closeButton: false,
            closeOnClick: false,
            className: "map-tooltip",
            offset: 10,
          })
        }
        popupRef.current.setLngLat(e.lngLat).setText(addr).addTo(map)
      }
    })
    map.on("mouseleave", "dots", () => {
      map.getCanvas().style.cursor = ""
      if (hoveredDotId.current !== null) {
        map.setFeatureState(
          { source: "dots", id: hoveredDotId.current },
          { hover: false },
        )
        hoveredDotId.current = null
      }
      popupRef.current?.remove()
    })
    map.on("click", "dots", (e) => {
      const f = e.features?.[0]
      const addr = (f?.properties as { address?: string })?.address
      if (!addr) return
      // pass the dot's own coords so the camera flies immediately rather than
      // waiting for the profile fetch to geocode the address
      const coords =
        f?.geometry.type === "Point"
          ? ([f.geometry.coordinates[1], f.geometry.coordinates[0]] as [
              number,
              number,
            ])
          : undefined
      onOpenBuilding(addr, coords)
    })

    // --- 3D building clicks: same profile sidebar as the 2D dots. The
    // footprint→address mapping is built during paintFootprints, so only
    // buildings with a matched (health-colored) dot are clickable. ---
    map.on("click", "buildings-3d", (e) => {
      if (!is3DRef.current) return
      const f = e.features?.[0]
      if (f?.id === undefined) return
      const hit = footprintAddress.current.get(f.id)
      if (hit) onOpenBuilding(hit.address, [hit.lat, hit.lon])
    })
    map.on("mousemove", "buildings-3d", (e) => {
      if (!is3DRef.current) return
      const f = e.features?.[0]
      const clickable =
        f?.id !== undefined && footprintAddress.current.has(f.id)
      map.getCanvas().style.cursor = clickable ? "pointer" : ""
    })
    map.on("mouseleave", "buildings-3d", () => {
      if (is3DRef.current) map.getCanvas().style.cursor = ""
    })

    const onZoomEnd = () => syncLayers(map)
    const onMoveEnd = () => {
      if (map.getZoom() >= BUILDING_ZOOM) loadBuildings(map)
      // new footprint tiles may have arrived for the new view
      if (is3DRef.current) schedulePaint(map)
    }
    map.on("zoomend", onZoomEnd)
    map.on("moveend", onMoveEnd)
    map.on("load", () => {
      setMapReady(true)
      syncLayers(map)
    })

    return () => {
      map.remove()
      mapRef.current = null
      maplibregl.removeProtocol("pmtiles")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When filters change in the zoomed-in view, re-filter the dots in place.
  useEffect(() => {
    if (zoomed) renderDots()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, zoomed])

  // Swap basemap + theme-dependent paint when light/dark mode flips.
  useEffect(() => {
    const apply = () => {
      const isDark = document.documentElement.classList.contains("dark")
      setDark(isDark)
      const map = mapRef.current
      if (!map || !map.getLayer("basemap")) return
      const src = map.getSource("basemap") as maplibregl.RasterTileSource
      src?.setTiles([isDark ? CARTO_DARK : CARTO_LIGHT])
      map.setPaintProperty("hoods-fill", "fill-color", densityRampExpression(isDark))
      map.setPaintProperty("hoods-fill", "fill-opacity", [
        "case",
        ["boolean", ["feature-state", "hover"], false],
        1,
        isDark ? 0.6 : 0.75,
      ])
      map.setPaintProperty("hoods-line", "line-color", isDark ? "#0b1f47" : "#ffffff")
      map.setPaintProperty(
        "buildings-3d",
        "fill-extrusion-color",
        extrusionColorExpression(isDark),
      )
    }
    const observer = new MutationObserver(apply)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => observer.disconnect()
  }, [])

  // Selected building: fly to it and drop a highlighted marker.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    selectedMarkerRef.current?.remove()
    selectedMarkerRef.current = null
    if (!selectedAddress || !selectedLatLon) {
      // panel closed — stop reserving space for it
      map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 })
      return
    }
    const [lat, lon] = selectedLatLon
    // The building panel overlays the right side (max-w-[640px]); pad the
    // camera so the selected building centers in the *uncovered* map area.
    // on narrow screens the panel covers everything — no useful area to
    // center in, so don't pad (cap at 70% of the container)
    const panelWidth = Math.min(640, map.getContainer().clientWidth * 0.7)
    map.flyTo({
      center: [lon, lat],
      zoom: Math.max(map.getZoom(), 16),
      padding: { top: 0, bottom: 0, left: 0, right: panelWidth },
      duration: 1000,
    })
    const el = document.createElement("div")
    el.className = "selected-marker"
    el.title = selectedAddress
    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([lon, lat])
      .addTo(map)
    selectedMarkerRef.current = marker
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAddress, selectedLatLon, mapReady])

  // Zoomed-out tint overlay for the filter pills.
  const tint =
    !zoomed && filters.rent && filters.violations
      ? "rgba(168, 85, 247, 0.16)" // purple
      : !zoomed && filters.violations
        ? "rgba(239, 68, 68, 0.16)" // red
        : !zoomed && filters.rent
          ? "rgba(59, 130, 246, 0.16)" // blue
          : "transparent"

  function syncLayers(map: MLMap) {
    const isBuildings = map.getZoom() >= BUILDING_ZOOM
    setZoomed(isBuildings)
    if (isBuildings) loadBuildings(map)
    else {
      const src = map.getSource("dots") as maplibregl.GeoJSONSource | undefined
      src?.setData(EMPTY_FC)
      dotsData.current = []
      setBuildingCount(null)
      clearFootprintPaint(map)
    }
  }

  async function loadBuildings(map: MLMap) {
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

  // Push the stored dots (minus filtered-out ones) into the GeoJSON source.
  function renderDots() {
    const map = mapRef.current
    if (!map) return
    const src = map.getSource("dots") as maplibregl.GeoJSONSource | undefined
    if (!src) return
    const { rent, violations } = filtersRef.current
    const features: Feature[] = []
    for (const d of dotsData.current) {
      if (rent && !d.rentStabilized) continue
      if (violations && !d.highViolations) continue
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [d.lon, d.lat] },
        properties: {
          address: d.address ?? "",
          health: d.health,
        },
      })
    }
    src.setData({ type: "FeatureCollection", features })
    setBuildingCount(features.length)
    if (is3DRef.current) schedulePaint(map)
  }

  function clearFootprintPaint(map: MLMap) {
    for (const id of paintedIds.current) {
      map.setFeatureState(
        { source: "footprints", sourceLayer: "buildings", id },
        { health: null },
      )
    }
    paintedIds.current.clear()
    paintedHealth.current.clear()
    footprintAddress.current.clear()
  }

  // Schedule one footprint re-paint after the map next settles. `setFeatureState`
  // itself dirties the map and produces another `idle`, so a naive on-idle
  // painter loops forever, repainting (and re-hit-testing ~1000 dots) on every
  // frame — that was the 3D-mode lag. This waits for idle exactly once per
  // trigger (data load, camera move, filter change) and ignores the idle that
  // its own painting causes.
  function schedulePaint(map: MLMap) {
    if (paintPending.current) return
    paintPending.current = true
    map.once("idle", () => {
      paintPending.current = false
      paintFootprints(map)
    })
  }

  // point-in-polygon (ray casting) against a vector-tile polygon's rings
  function pointInRings(
    lon: number,
    lat: number,
    rings: GeoJSON.Position[][],
  ): boolean {
    let inside = false
    // ring 0 is the outer boundary; holes (rings 1+) toggle back out
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        if (
          yi > lat !== yj > lat &&
          lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
        ) {
          inside = !inside
        }
      }
    }
    return inside
  }

  // Match each dot to the footprint containing it and tint that extrusion by
  // health bucket. Geometry-based (querySourceFeatures once + point-in-polygon)
  // rather than per-dot queryRenderedFeatures screen hit-tests, which were both
  // slow (~1000 GPU hit-tests) and wrong under pitch (a tall building in front
  // could occlude the true match).
  function paintFootprints(map: MLMap) {
    if (!map.getLayer("buildings-3d")) return
    const { rent, violations } = filtersRef.current
    const dots = dotsData.current.filter(
      (d) => !(rent && !d.rentStabilized) && !(violations && !d.highViolations),
    )

    // one source query for all loaded footprint tiles in view
    const feats = dots.length
      ? map.querySourceFeatures("footprints", { sourceLayer: "buildings" })
      : []

    // coarse spatial grid over footprint bboxes so each dot only tests a
    // handful of candidate polygons instead of all of them
    const CELL = 0.002 // ~200m in lon/lat at SF latitudes
    const grid = new Map<string, { id: string | number; rings: GeoJSON.Position[][] }[]>()
    const seen = new Set<string | number>()
    for (const f of feats) {
      if (f.id === undefined || seen.has(f.id)) continue
      seen.add(f.id)
      const geom = f.geometry
      const polys: GeoJSON.Position[][][] =
        geom.type === "Polygon"
          ? [geom.coordinates]
          : geom.type === "MultiPolygon"
            ? geom.coordinates
            : []
      for (const rings of polys) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const [x, y] of rings[0]) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
        const entry = { id: f.id, rings }
        for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
          for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
            const key = `${cx}:${cy}`
            const bucket = grid.get(key)
            if (bucket) bucket.push(entry)
            else grid.set(key, [entry])
          }
        }
      }
    }

    // compute the new paint set, then diff against what's already painted so
    // an unchanged view costs zero setFeatureState calls (and zero repaints)
    const next = new Map<string | number, HealthBucket>()
    footprintAddress.current.clear()
    for (const d of dots) {
      const bucket = grid.get(
        `${Math.floor(d.lon / CELL)}:${Math.floor(d.lat / CELL)}`,
      )
      if (!bucket) continue
      for (const c of bucket) {
        if (pointInRings(d.lon, d.lat, c.rings)) {
          next.set(c.id, d.health)
          if (d.address) {
            footprintAddress.current.set(c.id, {
              address: d.address,
              lat: d.lat,
              lon: d.lon,
            })
          }
          break
        }
      }
    }

    for (const id of paintedIds.current) {
      if (!next.has(id)) {
        map.setFeatureState(
          { source: "footprints", sourceLayer: "buildings", id },
          { health: null },
        )
        paintedIds.current.delete(id)
        paintedHealth.current.delete(id)
      }
    }
    for (const [id, health] of next) {
      if (paintedHealth.current.get(id) !== health) {
        map.setFeatureState(
          { source: "footprints", sourceLayer: "buildings", id },
          { health },
        )
      }
      paintedIds.current.add(id)
      paintedHealth.current.set(id, health)
    }
  }

  function resetView() {
    setIs3D(false)
    apply3D(false)
    mapRef.current?.flyTo({
      center: SF_CENTER,
      zoom: 11,
      pitch: 0,
      bearing: 0,
      duration: 1000,
    })
  }

  function apply3D(on: boolean) {
    const map = mapRef.current
    if (!map) return
    is3DRef.current = on
    map.setPaintProperty("buildings-3d", "fill-extrusion-opacity", on ? 0.92 : 0)
    // in 3D the extrusions carry the health colors; the flat dots would just
    // float on the ground plane, so hide them
    map.setLayoutProperty("dots", "visibility", on ? "none" : "visible")
    if (on) {
      map.easeTo({
        pitch: 60,
        bearing: -15,
        // if still fully zoomed out, come in far enough to read buildings
        zoom: Math.max(map.getZoom(), 13),
        duration: 900,
      })
      schedulePaint(map)
    } else {
      map.easeTo({ pitch: 0, bearing: 0, duration: 700 })
      clearFootprintPaint(map)
    }
  }

  function toggle3D() {
    const next = !is3D
    setIs3D(next)
    apply3D(next)
  }

  return (
    <div className="relative h-full w-full">
      {/* explicit h/w: MapLibre's stylesheet forces .maplibregl-map to
          position:relative, which defeats an absolute-inset sizing approach */}
      <div ref={mapEl} className="h-full w-full" />

      {/* filter tint overlay (expanded view only) */}
      <div
        className="pointer-events-none absolute inset-0 z-[800] transition-colors duration-300"
        style={{ backgroundColor: tint }}
      />

      {/* top-left: search + reset + 3D toggle */}
      <div className="absolute top-4 left-16 z-[1000] w-80 max-w-[70vw]">
        <div className="bg-background rounded-lg shadow-md">
          <AddressSearch onSelect={onPick} />
        </div>
        <div className="mt-2 flex gap-2">
          <button
            onClick={resetView}
            className="bg-background rounded-md border px-3 py-1.5 text-xs shadow-sm hover:bg-muted"
          >
            Reset view
          </button>
          <button
            onClick={toggle3D}
            className={`rounded-md border px-3 py-1.5 text-xs shadow-sm transition-colors ${
              is3D
                ? "border-foreground bg-foreground text-background"
                : "bg-background hover:bg-muted"
            }`}
          >
            {is3D ? "Back to 2D" : "3D buildings"}
          </button>
        </div>
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

      {/* bottom-right: legend (swaps with zoom; collapsed to a pill until clicked) */}
      {!legendOpen ? (
        <button
          onClick={() => setLegendOpen(true)}
          className="bg-background absolute right-4 bottom-8 z-[1000] flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-md hover:bg-muted"
        >
          {/* mini color strip so the pill hints at what's inside */}
          <span className="flex items-center gap-0.5">
            {(zoomed
              ? (["excellent", "decent", "mixed", "poor"] as HealthBucket[]).map(
                  (k) => HEALTH_COLORS[k],
                )
              : [0, 1, 2, 3].map((i) => densityColor(i, dark))
            ).map((c, i) => (
              <span
                key={i}
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: c }}
              />
            ))}
          </span>
          {zoomed ? "building health" : "housing density"}
        </button>
      ) : (
      <div className="bg-background absolute right-4 bottom-8 z-[1000] w-56 rounded-lg border p-4 shadow-md">
        <button
          onClick={() => setLegendOpen(false)}
          aria-label="Collapse legend"
          className="text-muted-foreground absolute top-2 right-2 rounded px-1.5 text-sm leading-none hover:bg-muted"
        >
          ×
        </button>
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
            {is3D && (
              <p className="text-muted-foreground mt-3 text-xs">
                3D heights: GlobalBuildingAtlas · colored where health data
                exists
              </p>
            )}
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
              {is3D ? " · 3D heights shown" : ""}
            </p>
          </>
        )}
      </div>
      )}
    </div>
  )
}
