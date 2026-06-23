import { useEffect, useRef, useState } from "react"

import { searchAddresses, type Suggestion } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

interface Props {
  onSelect: (address: string) => void
  defaultValue?: string
  autoFocus?: boolean
  className?: string
}

export function AddressSearch({
  onSelect,
  defaultValue = "",
  autoFocus,
  className,
}: Props) {
  const [q, setQ] = useState(defaultValue)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [loading, setLoading] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (q.trim().length < 2) {
      setSuggestions([])
      return
    }
    let cancelled = false
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const res = await searchAddresses(q)
        if (!cancelled) {
          setSuggestions(res)
          setOpen(true)
          setActive(-1)
        }
      } catch {
        if (!cancelled) setSuggestions([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [q])

  useEffect(() => {
    function onClickAway(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onClickAway)
    return () => document.removeEventListener("mousedown", onClickAway)
  }, [])

  function choose(s: Suggestion) {
    setQ(s.address)
    setOpen(false)
    onSelect(s.address)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, suggestions.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (active >= 0 && suggestions[active]) choose(suggestions[active])
      else if (q.trim().length >= 3) {
        setOpen(false)
        onSelect(q.trim())
      }
    } else if (e.key === "Escape") {
      setOpen(false)
    }
  }

  return (
    <div ref={boxRef} className={cn("relative w-full", className)}>
      <Input
        value={q}
        autoFocus={autoFocus}
        placeholder="search any San Francisco address"
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => suggestions.length && setOpen(true)}
        onKeyDown={onKeyDown}
        className="h-12 text-base"
      />
      {loading && (
        <span className="text-muted-foreground absolute top-1/2 right-3 -translate-y-1/2 text-xs">
          …
        </span>
      )}
      {open && suggestions.length > 0 && (
        <ul className="bg-popover absolute z-20 mt-1 w-full overflow-hidden rounded-lg border shadow-lg">
          {suggestions.map((s, i) => (
            <li key={`${s.address}-${i}`}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(s)}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left",
                  i === active ? "bg-accent" : "hover:bg-accent/60",
                )}
              >
                <span className="text-sm font-medium">{s.address}</span>
                {s.block && s.lot && (
                  <span className="text-muted-foreground font-mono text-xs">
                    block {s.block} · lot {s.lot}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
