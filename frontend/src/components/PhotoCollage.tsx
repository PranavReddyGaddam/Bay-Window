import { useEffect, useRef, useState } from "react"

// Scattered SF neighborhood photo collage for the landing hero, matching
// NYCStoops' hero: big, mixed-orientation, un-rounded photos spread down the
// right column, each with a small caption. Photos drift with the mouse
// (per-photo `depth`, like Stoop's data-depth parallax) and reveal on load.
// Photos are free Unsplash CDN images (no key), verified as genuine SF imagery.

interface Photo {
  id: string
  alt: string
  neighborhood: string
  top: number
  left: number
  width: number
  height: number
  /** parallax depth — higher = drifts more with the mouse (Stoop uses 0.06–0.14) */
  depth: number
  /** caption position relative to the photo */
  capTop: number
  capLeft: number
}

// 4 photos scattered on the right column, mirroring Stoop's artistic layout:
// a tall portrait top-left, a landscape top-right (offset lower), a portrait
// mid, and a landscape bottom-right. The 5th (the castro) sits under the hero.
const PHOTOS: Photo[] = [
  {
    id: "photo-1670382393811-5604f952b50b",
    alt: "Victorian row houses near Alamo Square",
    neighborhood: "the mission",
    top: 40,
    left: 30,
    width: 250,
    height: 300, // tall portrait
    depth: 0.05,
    capTop: 14,
    capLeft: 30,
  },
  {
    id: "photo-1501594907352-04cda38ebc29",
    alt: "Golden Gate Bridge at the Presidio",
    neighborhood: "the presidio",
    top: 150,
    left: 360,
    width: 300,
    height: 220, // landscape, dropped lower-right
    depth: 0.07,
    capTop: 124,
    capLeft: 360,
  },
  {
    id: "photo-1669206333066-1c858fbc7903",
    alt: "San Francisco skyline along the Embarcadero",
    neighborhood: "embarcadero",
    top: 470,
    left: 250,
    width: 290,
    height: 200, // landscape, bottom
    depth: 0.06,
    capTop: 444,
    capLeft: 250,
  },
]

function src(id: string, w: number) {
  return `https://images.unsplash.com/${id}?w=${w}&q=75&auto=format&fit=crop`
}

export function PhotoCollage() {
  const ref = useRef<HTMLDivElement>(null)
  const [revealed, setRevealed] = useState(false)
  // shared mouse offset, applied per-photo by depth
  const mouse = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const t = setTimeout(() => setRevealed(true), 80)

    let raf = 0
    const cur = { x: 0, y: 0 }
    function onMove(e: MouseEvent) {
      // offset from viewport center, in px
      mouse.current.x = e.clientX - window.innerWidth / 2
      mouse.current.y = e.clientY - window.innerHeight / 2
    }
    function tick() {
      cur.x += (mouse.current.x - cur.x) * 0.08
      cur.y += (mouse.current.y - cur.y) * 0.08
      const el = ref.current
      if (el) {
        for (const fig of Array.from(
          el.querySelectorAll<HTMLElement>("[data-depth]"),
        )) {
          const d = parseFloat(fig.dataset.depth || "0")
          fig.style.transform = `translate3d(${(-cur.x * d).toFixed(2)}px, ${(-cur.y * d).toFixed(2)}px, 0)`
        }
      }
      raf = requestAnimationFrame(tick)
    }
    window.addEventListener("mousemove", onMove)
    raf = requestAnimationFrame(tick)
    return () => {
      clearTimeout(t)
      window.removeEventListener("mousemove", onMove)
      cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <div ref={ref} className="relative hidden h-[760px] w-full lg:-mt-28 lg:block">
      {PHOTOS.map((p, i) => (
        <div key={p.id}>
          <span
            className="text-foreground absolute z-10 flex items-center gap-2 font-mono text-[11px] tracking-wide whitespace-nowrap"
            style={{
              top: p.capTop,
              left: p.capLeft,
              opacity: revealed ? 1 : 0,
              transition: `opacity 0.6s ease ${0.15 + i * 0.08}s`,
            }}
          >
            <span className="text-brand text-[8px]">●</span>
            {p.neighborhood}
          </span>
          <figure
            data-depth={p.depth}
            className="absolute m-0"
            style={{ top: p.top, left: p.left, willChange: "transform" }}
          >
            <img
              src={src(p.id, p.width * 2)}
              alt={p.alt}
              loading="lazy"
              className="block object-cover"
              style={{
                width: p.width,
                height: p.height,
                opacity: revealed ? 1 : 0,
                transform: revealed ? "translateY(0)" : "translateY(24px)",
                transition: `opacity 0.7s ease ${i * 0.1}s, transform 0.7s cubic-bezier(0.22,1,0.36,1) ${i * 0.1}s`,
              }}
            />
          </figure>
        </div>
      ))}
      {/* scattered black dot near the top, like the reference */}
      <span
        className="bg-foreground absolute block h-5 w-5 rounded-full"
        data-depth="0.025"
        style={{ top: 24, left: 290, willChange: "transform" }}
      />
    </div>
  )
}
