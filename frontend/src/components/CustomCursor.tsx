import { useEffect, useRef, useState } from "react"

// A fixed-size round cursor that follows the mouse and inverts whatever is
// beneath it via mix-blend-mode: difference (a white dot over black reads
// white; over an image it reads as the photographic negative).
// Disabled for touch / coarse pointers.

export function CustomCursor() {
  const dotRef = useRef<HTMLDivElement>(null)
  const [enabled, setEnabled] = useState(false)
  const [hidden, setHidden] = useState(true)

  useEffect(() => {
    // Only on devices with a fine pointer (mouse/trackpad).
    if (!window.matchMedia("(pointer: fine)").matches) return
    setEnabled(true)

    const pos = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    const target = { ...pos }
    let raf = 0

    function onMove(e: MouseEvent) {
      target.x = e.clientX
      target.y = e.clientY
      // Over a map building dot, hide the custom cursor so the native pointer
      // shows (signaling the dot is clickable).
      const el = e.target as Element | null
      const overDot = !!el?.closest?.(".building-dot, [data-cursor='pointer']")
      document.documentElement.classList.toggle("native-pointer", overDot)
      setHidden(overDot)
    }
    function onLeave() {
      setHidden(true)
    }

    function tick() {
      // smooth follow (lerp)
      pos.x += (target.x - pos.x) * 0.2
      pos.y += (target.y - pos.y) * 0.2
      if (dotRef.current) {
        dotRef.current.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0) translate(-50%, -50%)`
      }
      raf = requestAnimationFrame(tick)
    }

    window.addEventListener("mousemove", onMove)
    document.addEventListener("mouseleave", onLeave)
    raf = requestAnimationFrame(tick)

    // hide the native cursor
    document.documentElement.classList.add("custom-cursor-active")

    return () => {
      window.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseleave", onLeave)
      cancelAnimationFrame(raf)
      document.documentElement.classList.remove("custom-cursor-active")
    }
  }, [])

  if (!enabled) return null

  return (
    <div
      ref={dotRef}
      aria-hidden="true"
      className="pointer-events-none fixed top-0 left-0 z-[9999] h-[18px] w-[18px] rounded-full bg-white mix-blend-difference"
      style={{
        opacity: hidden ? 0 : 1,
        transition: "opacity 0.2s ease",
        willChange: "transform",
      }}
    />
  )
}
