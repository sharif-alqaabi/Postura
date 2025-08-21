/**
 * Angle math for HUD + simple smoothing.
 * All points use normalized video/canvas coordinates (0..1).
 */
export type Pt = { x: number; y: number }

/** Angle at B (A–B–C) in degrees. */
export function angleABC(a: Pt, b: Pt, c: Pt): number {
  const ab = { x: a.x - b.x, y: a.y - b.y }
  const cb = { x: c.x - b.x, y: c.y - b.y }
  const dot = ab.x * cb.x + ab.y * cb.y
  const mag1 = Math.hypot(ab.x, ab.y)
  const mag2 = Math.hypot(cb.x, cb.y)
  const cos = Math.min(1, Math.max(-1, dot / (mag1 * mag2 || 1e-6)))
  return (Math.acos(cos) * 180) / Math.PI
}

/** Torso lean vs vertical (0° = upright). */
export function trunkAngle(hip: Pt, shoulder: Pt): number {
  // Canvas y grows downward; “vertical” is a 90° line.
  const dy = hip.y - shoulder.y
  const dx = hip.x - shoulder.x
  const degFromHorizontal = (Math.atan2(dy, dx) * 180) / Math.PI
  const degFromVertical = Math.abs(90 - Math.abs(degFromHorizontal))
  return degFromVertical
}

/** Exponential moving average for jitter reduction. */
export function ema(prev: number | null, curr: number, alpha = 0.35) {
  return prev == null ? curr : prev * (1 - alpha) + curr * alpha
}
