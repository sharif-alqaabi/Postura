// Spoken cues produced at the *bottom* of the rep.
export interface Cue {
    type: 'depth' | 'trunk' | 'knee'
    message: string
  }
  
  export function checkRulesAtBottom(opts: {
    depthOK: boolean
    trunkDeg: number | null
    trunkThreshold?: number
  }): Cue[] {
    const { depthOK, trunkDeg, trunkThreshold = 35 } = opts
    const cues: Cue[] = []
  
    // Only say "Go deeper" if depth was NOT achieved for this rep.
    if (!depthOK) cues.push({ type: 'depth', message: 'Go deeper' })
    if (trunkDeg != null && trunkDeg > trunkThreshold) {
      cues.push({ type: 'trunk', message: 'Chest up' })
    }
    // (Knees-in will come later when we compute knee/ankle spread)
    return cues
  }
  