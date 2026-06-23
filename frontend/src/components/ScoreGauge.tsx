import type { Score } from "@/lib/api"

// Color the score on a health scale (green -> red), echoing NYCStoops'
// excellent/decent/mixed/poor legend.
function scoreColor(value: number): string {
  if (value >= 90) return "oklch(0.65 0.17 145)" // green
  if (value >= 80) return "oklch(0.72 0.15 130)"
  if (value >= 70) return "oklch(0.80 0.15 95)" // amber
  if (value >= 60) return "oklch(0.72 0.17 55)" // orange
  return "oklch(0.62 0.22 27)" // red
}

function scoreLabel(value: number): string {
  if (value >= 90) return "excellent"
  if (value >= 80) return "decent"
  if (value >= 70) return "mixed"
  if (value >= 60) return "needs work"
  return "poor"
}

// Compact horizontal score for the pinned panel header.
export function ScoreGaugeCompact({ score }: { score: Score }) {
  const { value, grade } = score
  const color = scoreColor(value)
  const r = 26
  const circ = 2 * Math.PI * r
  const dash = (value / 100) * circ
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-16 w-16 shrink-0">
        <svg viewBox="0 0 64 64" className="h-full w-full -rotate-90">
          <circle cx="32" cy="32" r={r} fill="none" stroke="var(--muted)" strokeWidth="6" />
          <circle
            cx="32"
            cy="32"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circ}`}
            style={{ transition: "stroke-dasharray 0.8s ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-lg font-bold tabular-nums" style={{ color }}>
            {value}
          </span>
        </div>
      </div>
      <div className="leading-tight">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xl font-bold" style={{ color }}>
            {grade}
          </span>
          <span className="text-muted-foreground text-sm lowercase">
            {scoreLabel(value)}
          </span>
        </div>
        <span className="text-muted-foreground text-xs">
          building health · out of 100
        </span>
      </div>
    </div>
  )
}

export function ScoreGauge({ score }: { score: Score }) {
  const { value, grade } = score
  const color = scoreColor(value)
  const r = 52
  const circ = 2 * Math.PI * r
  const dash = (value / 100) * circ

  return (
    <div className="flex items-center gap-5">
      <div className="relative h-32 w-32 shrink-0">
        <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
          <circle
            cx="60"
            cy="60"
            r={r}
            fill="none"
            stroke="var(--muted)"
            strokeWidth="10"
          />
          <circle
            cx="60"
            cy="60"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circ}`}
            style={{ transition: "stroke-dasharray 0.8s ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-bold tabular-nums" style={{ color }}>
            {value}
          </span>
          <span className="text-muted-foreground text-xs">/ 100</span>
        </div>
      </div>
      <div>
        <div className="flex items-center gap-2">
          <span
            className="text-2xl font-bold"
            style={{ color }}
          >
            {grade}
          </span>
          <span className="text-muted-foreground text-sm lowercase">
            {scoreLabel(value)}
          </span>
        </div>
        <p className="text-muted-foreground mt-1 max-w-xs text-xs leading-relaxed">
          {score.method}
        </p>
      </div>
    </div>
  )
}
