import { useCallback, useEffect, useState } from "react"

import { getBuilding, type BuildingProfile as Profile } from "@/lib/api"
import { AddressSearch } from "@/components/AddressSearch"
import { BuildingPanel } from "@/components/BuildingPanel"
import { BuildingProfile } from "@/components/BuildingProfile"
import { CustomCursor } from "@/components/CustomCursor"
import { MapView } from "@/components/MapView"
import { MiniMap } from "@/components/MiniMap"
import { PhotoCollage } from "@/components/PhotoCollage"
import { Separator } from "@/components/ui/separator"

type View =
  | { kind: "home" }
  | { kind: "map" }
  | { kind: "loading"; address: string }
  | { kind: "result"; data: Profile }
  | { kind: "error"; message: string; address: string }

export default function App() {
  const [view, setView] = useState<View>({ kind: "home" })
  // address of the building shown in the map slide-over panel (null = closed)
  const [panelAddress, setPanelAddress] = useState<string | null>(null)
  // coords of the selected building, for the map to fly to + highlight
  const [selectedLatLon, setSelectedLatLon] = useState<
    [number, number] | null
  >(null)

  // Load a building by address and reflect it in the URL (/building?address=).
  const lookup = useCallback(
    async (address: string, opts?: { push?: boolean }) => {
      setView({ kind: "loading", address })
      if (opts?.push !== false) {
        window.history.pushState(
          {},
          "",
          `/building?address=${encodeURIComponent(address)}`,
        )
      }
      try {
        const data = await getBuilding(address)
        setView({ kind: "result", data })
      } catch (e) {
        setView({
          kind: "error",
          message: e instanceof Error ? e.message : "Something went wrong.",
          address,
        })
      }
    },
    [],
  )

  // Derive the view from the current URL (so refresh + back/forward work).
  const routeFromUrl = useCallback(() => {
    const path = window.location.pathname
    const params = new URLSearchParams(window.location.search)
    const address = params.get("address")
    const building = params.get("building")
    if (path.startsWith("/map")) {
      setView({ kind: "map" })
      setPanelAddress(building) // null when absent -> panel closed
      setSelectedLatLon(null)
    } else if (path.startsWith("/building") && address) {
      lookup(address, { push: false })
    } else {
      setView({ kind: "home" })
    }
  }, [lookup])

  useEffect(() => {
    routeFromUrl()
    const onPop = () => routeFromUrl()
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [routeFromUrl])

  function navigate(path: string, v: View) {
    window.history.pushState({}, "", path)
    setView(v)
  }

  function goHome() {
    navigate("/", { kind: "home" })
  }

  function openMap() {
    navigate("/map", { kind: "map" })
  }

  // Unified: open a building in the side panel on the map (no page nav).
  // Used by both the search box and clicking a dot. Reflects the selection in
  // the URL (/map?building=…) so a refresh restores it.
  const openBuilding = useCallback((address: string) => {
    setView({ kind: "map" })
    setPanelAddress(address)
    setSelectedLatLon(null) // cleared until coords arrive from the panel fetch
    window.history.pushState(
      {},
      "",
      `/map?building=${encodeURIComponent(address)}`,
    )
  }, [])

  function closePanel() {
    setPanelAddress(null)
    setSelectedLatLon(null)
    window.history.pushState({}, "", "/map")
  }

  // Full-bleed map view (the "enter" destination, like Stoop's /map).
  if (view.kind === "map") {
    return (
      <div className="flex h-svh flex-col overflow-hidden">
        <CustomCursor />
        <Header onHome={goHome} view="map" />
        <div className="relative flex-1">
          <MapView
            onPick={openBuilding}
            onOpenBuilding={openBuilding}
            selectedAddress={panelAddress}
            selectedLatLon={selectedLatLon}
          />
          <BuildingPanel
            address={panelAddress}
            onClose={closePanel}
            onCoords={(lat, lon) => setSelectedLatLon([lat, lon])}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-svh">
      <CustomCursor />
      {view.kind !== "home" && (
        <Header onHome={goHome} view={view.kind} />
      )}

      {view.kind === "home" && (
        <Landing onHome={goHome} onEnter={openMap} />
      )}

      {view.kind !== "home" && (
        <main className="mx-auto max-w-3xl px-5 pb-24">
          <div className="py-6">
            <AddressSearch onSelect={lookup} className="max-w-xl" />
          </div>

          {view.kind === "loading" && <LoadingState address={view.address} />}

          {view.kind === "error" && (
            <div className="rounded-xl border border-dashed p-8 text-center">
              <p className="font-medium">Couldn’t load that address</p>
              <p className="text-muted-foreground mt-1 text-sm">
                {view.message}
              </p>
            </div>
          )}

          {view.kind === "result" && (
            <div className="space-y-5">
              {view.data.location.lat && view.data.location.lon && (
                <MiniMap
                  lat={view.data.location.lat}
                  lon={view.data.location.lon}
                  label={view.data.address ?? undefined}
                />
              )}
              <BuildingProfile data={view.data} />
            </div>
          )}
        </main>
      )}

      {view.kind !== "home" && <Footer />}
    </div>
  )
}

function Header({
  onHome,
  view,
}: {
  onHome: () => void
  view: View["kind"]
}) {
  const isMap = view === "map"
  return (
    <header className="relative z-[1100] flex items-center justify-between border-b bg-background px-6 py-4">
      <button
        onClick={onHome}
        className="text-2xl font-bold tracking-tight"
      >
        Bay Window<span className="text-brand">.</span>
      </button>
      <div className="flex items-center gap-6">
        {isMap ? (
          <nav className="flex items-center gap-6 text-sm">
            <span className="border-b-2 border-foreground pb-0.5 font-medium">
              map
            </span>
          </nav>
        ) : (
          <span className="text-muted-foreground font-mono text-xs">
            SF building health
          </span>
        )}
        <DarkModeToggle />
      </div>
    </header>
  )
}

function DarkModeToggle() {
  const [dark, setDark] = useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark"),
  )
  function toggle() {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle("dark", next)
  }
  return (
    <button
      onClick={toggle}
      aria-label="Toggle dark mode"
      className="text-foreground transition-opacity hover:opacity-70"
    >
      {/* half-filled circle, like NYCStoops */}
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle
          cx="11"
          cy="11"
          r="9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path d="M11 2 A9 9 0 0 1 11 20 Z" fill="currentColor" />
      </svg>
    </button>
  )
}

function Landing({
  onHome,
  onEnter,
}: {
  onHome: () => void
  onEnter: () => void
}) {
  return (
    <main className="relative min-h-svh px-8 py-7 sm:px-12 sm:py-8">
      {/* Full-bleed top bar: wordmark hard top-left, enter + toggle top-right */}
      <div className="flex items-start justify-between">
        <button
          onClick={onHome}
          className="font-display text-6xl leading-none font-bold tracking-tight sm:text-7xl lg:text-8xl"
        >
          Bay Window<span className="text-brand">.</span>
        </button>
        <div className="flex items-center gap-5 pt-3">
          <button
            onClick={onEnter}
            className="flex items-center gap-1.5 font-mono text-sm hover:opacity-70"
          >
            <span className="text-brand">●</span> enter
          </button>
          <DarkModeToggle />
        </div>
      </div>

      {/* Hero text (2 lines) on the left + collage on the right */}
      <div className="relative mt-24 grid lg:mt-32 lg:grid-cols-2">
        <div className="lg:pl-10">
          <h1 className="text-6xl font-light leading-[1.05] tracking-tight sm:text-7xl lg:text-[4.5rem]">
            what your landlord
            <br />
            won’t tell you.
          </h1>
          {/* one photo under the hero, like the reference's bottom-left photo */}
          <HeroLeftPhoto />
        </div>
        <PhotoCollage />
      </div>

      {/* Staircased blurbs */}
      <section className="relative mx-auto mt-32 grid max-w-6xl gap-y-12 sm:grid-cols-3 sm:gap-x-8">
        <Blurb title="What it does" className="sm:col-start-1 sm:row-start-1">
          Bay Window turns DBI violations, 311 complaints, evictions, and
          assessor records into a single, readable profile for every SF
          building.
        </Blurb>
        <Blurb
          title="Who it’s for"
          className="sm:col-start-2 sm:row-start-1 sm:mt-24"
        >
          Renters who want the truth before signing. Tenants checking the record
          on their own building. Reporters and organizers tracking the worst
          conditions in the city.
        </Blurb>
        <Blurb
          title="Every neighborhood"
          className="sm:col-start-3 sm:row-start-1 sm:mt-48"
        >
          Sunset duplexes, Mission flats, Tenderloin SROs, Bayview row houses,
          downtown towers. One database, one search box, no paywall.
        </Blurb>
      </section>

      {/* enter CTA */}
      <Separator className="mx-auto mt-16 max-w-6xl" />
      <section className="mx-auto flex max-w-6xl items-end justify-between gap-6 py-12">
        <button
          onClick={onEnter}
          className="font-display group flex items-center gap-3 text-6xl font-bold tracking-tight sm:text-8xl"
        >
          enter
          <span className="text-brand transition-transform group-hover:translate-x-2">
            →
          </span>
        </button>
        <div className="text-muted-foreground hidden text-right font-mono text-xs leading-relaxed sm:block">
          <p>Bay Window · built for San Francisco</p>
          <p>Data: SF DBI, Rent Board, 311, Assessor</p>
          <p>via DataSF · no paywall</p>
        </div>
      </section>
    </main>
  )
}

// The single bottom-left photo that sits beneath the hero tagline.
function HeroLeftPhoto() {
  return (
    <figure className="mt-16 hidden w-[clamp(240px,22vw,340px)] lg:block">
      <span className="text-foreground mb-3 flex items-center gap-2 font-mono text-[11px] tracking-wide">
        <span className="text-brand text-[8px]">●</span> the castro
      </span>
      <img
        src="https://images.unsplash.com/photo-1571897767174-35e817232fba?w=920&q=75&auto=format&fit=crop"
        alt="San Francisco Victorian house in the Castro"
        loading="lazy"
        className="block aspect-[3/2] w-full object-cover"
        data-cursor="grow"
      />
    </figure>
  )
}

function Blurb({
  title,
  className,
  children,
}: {
  title: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={className}>
      <h3 className="text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-[0.15em] uppercase">
        <span className="text-brand">●</span> {title}
      </h3>
      <p className="mt-4 text-xl leading-snug sm:text-2xl">{children}</p>
    </div>
  )
}

function LoadingState({ address }: { address: string }) {
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Pulling DataSF records for{" "}
        <span className="text-foreground font-medium">{address}</span>…
      </p>
      <div className="h-64 w-full animate-pulse rounded-xl bg-muted" />
      <div className="h-40 w-full animate-pulse rounded-xl bg-muted" />
      <div className="h-40 w-full animate-pulse rounded-xl bg-muted" />
    </div>
  )
}

function Footer() {
  return (
    <footer className="mx-auto max-w-3xl border-t px-5 py-8">
      <p className="text-muted-foreground font-mono text-xs leading-relaxed">
        Bay Window · built for San Francisco · Data: SF DBI, Rent Board, 311,
        Assessor, via DataSF. Not legal advice; always verify against official
        records.
      </p>
    </footer>
  )
}
