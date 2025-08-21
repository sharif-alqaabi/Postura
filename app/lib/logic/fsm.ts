/**
 * Minimal squat FSM using hip center vertical velocity + depth flag.
 * States: idle → descent → bottom → ascent → lockout
 */
export type State = 'idle' | 'descent' | 'bottom' | 'ascent' | 'lockout'

export interface RepContext {
  state: State
  reps: number
  lastHipY: number | null
  depthReached: boolean
}

export function createFSM(): RepContext {
  return { state: 'idle', reps: 0, lastHipY: null, depthReached: false }
}

/**
 * @param hipY        normalized hip-center y (0 top → 1 bottom)
 * @param depthOkay   true if hip below knee (depth) at any time in this rep
 */
export function stepFSM(ctx: RepContext, hipY: number, depthOkay: boolean): RepContext {
  const vy = ctx.lastHipY == null ? 0 : hipY - (ctx.lastHipY as number) // +down, -up
  let { state, reps, depthReached } = ctx
  depthReached = depthReached || depthOkay

  switch (state) {
    case 'idle':
      if (vy > 0.002) state = 'descent'
      break
    case 'descent':
      // Near bottom: velocity around zero; if we’ve reached depth, mark bottom.
      if (vy > -0.001 && vy < 0.001 && depthReached) state = 'bottom'
      else if (vy < -0.002) state = 'ascent' // bounced quickly
      break
    case 'bottom':
      if (vy < -0.002) state = 'ascent'
      break
    case 'ascent':
      // Back to lockout (upright): velocity ~0
      if (vy > -0.001 && vy < 0.001) {
        state = 'lockout'
        if (depthReached) reps += 1
        depthReached = false
      }
      break
    case 'lockout':
      if (vy > 0.002) state = 'descent'
      break
  }
  return { state, reps, lastHipY: hipY, depthReached }
}
