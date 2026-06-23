import { useEffect, useRef } from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"

interface Props {
  lat: number
  lon: number
  label?: string
}

// Small map showing just the searched building (search-first MVP; the
// full-bleed choropleth is a v2 item).
export function MiniMap({ lat, lon, label }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)

  useEffect(() => {
    if (!ref.current) return
    if (!mapRef.current) {
      mapRef.current = L.map(ref.current, {
        center: [lat, lon],
        zoom: 16,
        scrollWheelZoom: false,
      })
      L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        {
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
          maxZoom: 19,
        },
      ).addTo(mapRef.current)
    } else {
      mapRef.current.setView([lat, lon], 16)
    }

    const marker = L.circleMarker([lat, lon], {
      radius: 9,
      color: "oklch(0.49 0.16 250)",
      fillColor: "oklch(0.49 0.16 250)",
      fillOpacity: 0.6,
      weight: 2,
    }).addTo(mapRef.current)
    if (label) marker.bindPopup(label)

    return () => {
      marker.remove()
    }
  }, [lat, lon, label])

  return <div ref={ref} className="h-64 w-full rounded-xl border" />
}
