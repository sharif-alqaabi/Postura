// Spoken cues produced at the *bottom* of the rep.
//
// We use "trunk delta" (how much you leaned vs your upright baseline) so
// chest cues are correct even if the phone is slightly tilted.
export interface Cue {
    type: 'depth' | 'trunk' | 'knee'
    message: string
  }
  
  export function checkRulesAtBottom(opts: {
    depthAchieved: boolean
    trunkDeltaDeg: number | null
    trunkDeltaThreshold?: number // default ~18°
  }): Cue[] {
    const { depthAchieved, trunkDeltaDeg, trunkDeltaThreshold = 18 } = opts
    const cues: Cue[] = []
  
    if (!depthAchieved) {
      cues.push({ type: 'depth', message: 'Go deeper' })
    }
    if (trunkDeltaDeg != null && trunkDeltaDeg > trunkDeltaThreshold) {
      cues.push({ type: 'trunk', message: 'Chest up' })
    }
    // (Knees-in will be added later)
    return cues
  }
  