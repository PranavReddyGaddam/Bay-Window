import { useEffect, useRef } from "react"
import * as maplibregl from "maplibre-gl"
import { Map as MLMap } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"

interface Props {
  lat: number
  lon: number
  label?: string
}

// Small MapLibre map showing just the searched building.
export function MiniMap({ lat, lon, label }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const markerRef = useRef<maplibregl.Marker | null>(null)

  useEffect(() => {
    if (!ref.current) return
    if (!mapRef.current) {
      mapRef.current = new MLMap({
        container: ref.current,
        center: [lon, lat],
        zoom: 15,
        scrollZoom: false,
        attributionControl: { compact: true },
        style: {
          version: 8,
          sources: {
            basemap: {
              type: "raster",
              tiles: [
                "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
              ],
              tileSize: 256,
              attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
            },
          },
          layers: [{ id: "basemap", type: "raster", source: "basemap" }],
        },
      })
    } else {
      mapRef.current.setCenter([lon, lat])
    }

    const el = document.createElement("div")
    el.style.cssText =
      "width:18px;height:18px;border-radius:9999px;background:oklch(0.49 0.16 250);opacity:0.85;border:2px solid oklch(0.49 0.16 250);"
    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([lon, lat])
      .addTo(mapRef.current)
    if (label) {
      marker.setPopup(new maplibregl.Popup({ offset: 12 }).setText(label))
    }
    markerRef.current = marker

    return () => {
      marker.remove()
      markerRef.current = null
    }
  }, [lat, lon, label])

  // tear the map down on unmount
  useEffect(
    () => () => {
      mapRef.current?.remove()
      mapRef.current = null
    },
    [],
  )

  return <div ref={ref} className="h-64 w-full rounded-xl border" />
}
