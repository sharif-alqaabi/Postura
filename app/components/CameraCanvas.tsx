'use client'
import { useEffect, useRef, useState } from 'react'
import { initPose, detectPose, isReady } from '@/app/lib/pose/loader'
import { EDGES, KP } from '@/app/lib/pose/topology'
import { angleABC, trunkAngle, ema } from '@/app/lib/math/angles'
import { createFSM, stepFSM, type State } from '@/app/lib/logic/fsm'
import { useTTS } from '@/app/lib/audio/useTTS'
import { TemporalGate } from '@/app/lib/logic/temporal'
import { checkRulesAtBottom } from '@/app/lib/logic/rules'
import { PoseSmoother } from '@/app/lib/pose/smoothing'

/**
 * EXACT RULES:
 * - Rep counts only when KNEE ≤ 65° (with temporal gating & hysteresis).
 * - Until KNEE ≤ 60°, the coach says "Go deeper".
 * - We drive the FSM with a monotonic knee-depth metric for stability.
 * - Turnaround detector + dwell to prevent random rep bumps.
 * - "Chest up" still uses trunk delta vs upright baseline (tilt-safe).
 */
export default function CameraCanvas() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // HUD
  const [fps, setFps] = useState(0)
  const [kneeDeg, setKneeDeg] = useState<number | null>(null)
  const [trunkDeg, setTrunkDeg] = useState<number | null>(null)
  const [reps, setReps] = useState(0)
  const [camError, setCamError] = useState<string | null>(null)
  const [calibrated, setCalibrated] = useState(false)
  const [lastCue, setLastCue] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)

  // Debug line so you can see why it did/didn't count/speak
  const [dbg, setDbg] = useState<{
    knee: number; kneeDepth: number; depthFSM: number;
    repOK: boolean; coachOK: boolean; vel: number; turn: boolean
  }>({ knee: 999, kneeDepth: 0, depthFSM: 0, repOK: false, coachOK: false, vel: 0, turn: false })

  // Camera controls
  const [useFront, setUseFront] = useState(true)
  const mirror = useFront

  // === Your exact thresholds ===
  const REP_KNEE_DEG = 65    // count a rep when knee ≤ 65°
  const COACH_KNEE_DEG = 60  // say "Go deeper" until knee ≤ 60°

  // Temporal gates / hysteresis
  const GATE_WINDOW = 10, GATE_NEED = 7   // slightly stricter to remove bounce
  const MIN_TRANSITION_MS = 160           // hysteresis between FSM transitions
  const COACH_DWELL_FRAMES = 5            // coachOK must persist this long

  // TTS
  const { enabled, enable, speak, test } = useTTS(1200)

  // Loop state (no 'any')
  const currentStream = useRef<MediaStream | null>(null)
  const lastTransitionAtRef = useRef<number>(0)
  const prevDepthFSMRef = useRef<number | null>(null)
  const prevVelRef = useRef<number | null>(null)

  // Calibration for trunk baseline (tilt-safe chest cue)
  const trunkBaselineRef = useRef<number | null>(null)

  useEffect(() => {
    let raf = 0
    let last = performance.now()

    // --- Smoothing ---
    const smoother = new PoseSmoother(1.4, 0.006, 1.0, 0.07, 0.15)
    let kneeSmoothed: number | null = null
    let trunkSmoothed: number | null = null

    // --- FSM & Gates ---
    let fsm = createFSM()
    const repGate = new TemporalGate(GATE_WINDOW, GATE_NEED)
    const coachGate = new TemporalGate(GATE_WINDOW, GATE_NEED)
    let coachConsec = 0
    let spokeCueTypeThisRep: null | 'depth' | 'trunk' | 'knee' = null

    // --- Calibration (upright trunk baseline only) ---
    const CALIB_FRAMES = 60 // ~1s @60fps
    const trunkBaseBuf: number[] = []
    let calibDone = false

    function clamp01(x: number) { return Math.max(0, Math.min(1, x)) }

    async function start() {
      await initPose()
      if (currentStream.current) {
        currentStream.current.getTracks().forEach(t => t.stop())
        currentStream.current = null
      }
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
      ) {
        setCamError('Camera not available. Use localhost on desktop or HTTPS (Vercel/ngrok) on mobile.')
        return
      }

      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: useFront ? 'user' : { exact: 'environment' as const },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      }

      let stream: MediaStream
      try { stream = await navigator.mediaDevices.getUserMedia(constraints) }
      catch { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }) }
      currentStream.current = stream

      const v = videoRef.current!
      const c = canvasRef.current!
      const g = c.getContext('2d')!
      v.srcObject = stream
      await v.play()

      lastTransitionAtRef.current = performance.now()

      const loop = () => {
        const now = performance.now()
        const dt = now - last
        const fpsNow = dt > 0 ? 1000 / dt : 0
        setFps(fpsNow)
        last = now

        if (!isReady()) { raf = requestAnimationFrame(loop); return }
        const res = detectPose(v, now)

        c.width = v.videoWidth
        c.height = v.videoHeight
        g.clearRect(0, 0, c.width, c.height)

        if (res && res.keypoints.length) {
          const timeSec = now / 1000
          const kps = smoother.apply(res.keypoints, timeSec)
          const VIS = 0.2

          // Require hips+knees on at least one side (ankles can be occluded)
          const leftSideOK =
            (kps[KP.LEFT_HIP].visibility ?? 0) > 0.55 &&
            (kps[KP.LEFT_KNEE].visibility ?? 0) > 0.55
          const rightSideOK =
            (kps[KP.RIGHT_HIP].visibility ?? 0) > 0.55 &&
            (kps[KP.RIGHT_KNEE].visibility ?? 0) > 0.55
          const profileOK = leftSideOK || rightSideOK

          // Draw skeleton
          g.lineWidth = 3
          g.globalAlpha = 0.95
          g.strokeStyle = '#ffffff'
          EDGES.forEach(([a, b]) => {
            const p = kps[a]; const q = kps[b]
            if ((p?.visibility ?? 0) > VIS && (q?.visibility ?? 0) > VIS) {
              g.beginPath()
              g.moveTo(p.x * c.width, p.y * c.height)
              g.lineTo(q.x * c.width, q.y * c.height)
              g.stroke()
            }
          })
          g.fillStyle = '#ffffff'
          kps.forEach((pt) => {
            if ((pt.visibility ?? 0) > VIS) {
              g.beginPath()
              g.arc(pt.x * c.width, pt.y * c.height, 4, 0, Math.PI * 2)
              g.fill()
            }
          })

          // Centers & angles
          const hipC = {
            x: (kps[KP.LEFT_HIP].x + kps[KP.RIGHT_HIP].x) / 2,
            y: (kps[KP.LEFT_HIP].y + kps[KP.RIGHT_HIP].y) / 2,
          }
          const shC = {
            x: (kps[KP.LEFT_SHOULDER].x + kps[KP.RIGHT_SHOULDER].x) / 2,
            y: (kps[KP.LEFT_SHOULDER].y + kps[KP.RIGHT_SHOULDER].y) / 2,
          }

          const lKnee = angleABC(
            { x: kps[KP.LEFT_HIP].x, y: kps[KP.LEFT_HIP].y },
            { x: kps[KP.LEFT_KNEE].x, y: kps[KP.LEFT_KNEE].y },
            { x: kps[KP.LEFT_ANKLE].x, y: kps[KP.LEFT_ANKLE].y },
          )
          const rKnee = angleABC(
            { x: kps[KP.RIGHT_HIP].x, y: kps[KP.RIGHT_HIP].y },
            { x: kps[KP.RIGHT_KNEE].x, y: kps[KP.RIGHT_KNEE].y },
            { x: kps[KP.RIGHT_ANKLE].x, y: kps[KP.RIGHT_ANKLE].y },
          )
          const knee = (lKnee + rKnee) / 2
          kneeSmoothed = ema(kneeSmoothed, knee)
          const kneeNow = kneeSmoothed ?? knee
          setKneeDeg(Math.round(kneeNow))

          const trunk = trunkAngle(hipC, shC) // angle vs vertical
          trunkSmoothed = ema(trunkSmoothed, trunk)
          const trunkNow = trunkSmoothed ?? trunk
          setTrunkDeg(Math.round(trunkNow))

          // --- Upright trunk baseline calibration (simple & robust) ---
          if (!calibDone && kneeNow >= 170 && trunkNow <= 12 && profileOK) {
            trunkBaseBuf.push(trunkNow)
            if (trunkBaseBuf.length >= CALIB_FRAMES) {
              // median
              const sorted = [...trunkBaseBuf].sort((a, b) => a - b)
              const mid = Math.floor(sorted.length / 2)
              trunkBaselineRef.current = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
              calibDone = true
              setCalibrated(true)
            }
          }

          if (!calibDone) {
            g.fillStyle = '#ffdb6e'
            g.font = '16px system-ui'
            g.fillText('Stand tall to calibrate…', 10, 24)
            g.fillText('Tips: side-on, good light', 10, 44)
            raf = requestAnimationFrame(loop); return
          }

          // --- Knee-only depth metric ---
          // Map knee 180° (top) -> 0, 60° (coach OK) -> 1
          const kneeDepth = clamp01((180 - kneeNow) / (180 - COACH_KNEE_DEG))
          // Use kneeDepth as the monotonic FSM driver
          const depthFSM = kneeDepth

          // Velocity / turnaround (down → up)
          const prevDepthFSM = prevDepthFSMRef.current ?? depthFSM
          prevDepthFSMRef.current = depthFSM
          const vel = depthFSM - prevDepthFSM
          const prevVel = prevVelRef.current ?? vel
          prevVelRef.current = vel
          const bottomTurn = (prevVel > 0.003) && (vel <= 0.0008)

          // Gates: EXACT RULES
          const repOK = repGate.push(kneeNow <= REP_KNEE_DEG)
          const coachOKNow = (kneeNow <= COACH_KNEE_DEG)
          const coachOK = coachGate.push(coachOKNow)
          coachConsec = coachOKNow ? (coachConsec + 1) : 0

          // FSM driven by knee-depth + rep gate (prevents random rep counts)
          const prevState: State = fsm.state
          const nowMs = performance.now()
          const canTransition = (nowMs - lastTransitionAtRef.current) > MIN_TRANSITION_MS
          if (canTransition) {
            const next = stepFSM(fsm, depthFSM, repOK)
            if (next.state !== fsm.state) lastTransitionAtRef.current = nowMs
            fsm = next
            setReps(fsm.reps)
          }

          // Reset gates & cue limiter on new rep
          if (prevState === 'lockout' && fsm.state === 'descent') {
            repGate.reset()
            coachGate.reset()
            coachConsec = 0
            spokeCueTypeThisRep = null
          }

          // Trunk delta vs upright baseline (tilt-safe)
          const trunkBase = trunkBaselineRef.current ?? 0
          const trunkDelta = Math.max(0, trunkNow - trunkBase)

          // Evaluate cues either when we *enter bottom* or when we *turn around shallow*
          const justHitBottom = prevState !== 'bottom' && fsm.state === 'bottom'
          const shouldEval = profileOK && (justHitBottom || bottomTurn)

          if (shouldEval) {
            // Depth achieved only if KNEE ≤ 60° with dwell
            const depthAchieved = coachOK && (coachConsec >= COACH_DWELL_FRAMES)
            const cues = checkRulesAtBottom({
              depthAchieved,                    // false → "Go deeper"
              trunkDeltaDeg: trunkDelta,        // "Chest up" if big lean
              trunkDeltaThreshold: 16
            })
            const first = cues.find(c => c.type !== spokeCueTypeThisRep)
            if (first) {
              setBanner(first.message)
              setTimeout(() => setBanner(null), 900)
              if (enabled) speak(first.message)
              setLastCue(first.message)
              spokeCueTypeThisRep = first.type
            }
          }

          // HUD
          g.fillStyle = profileOK ? '#ffffff' : '#ff7070'
          g.font = '16px system-ui'
          g.fillText(`FPS ${Math.round(fpsNow)}`, 10, 20)
          g.fillText(`Knee ${Math.round(kneeNow)}°`, 10, 40)
          g.fillText(`Trunk ${Math.round(trunkNow)}°`, 10, 60)
          g.fillText(`Reps ${fsm.reps} | State ${fsm.state}`, 10, 80)
          g.fillText(`KneeDepth ${(kneeDepth*100).toFixed(0)}%`, 10, 100)

          setDbg({
            knee: Math.round(kneeNow),
            kneeDepth: Math.round(kneeDepth*100)/100,
            depthFSM: Math.round(depthFSM*100)/100,
            repOK,
            coachOK,
            vel: Math.round((depthFSM - (prevDepthFSMRef.current ?? depthFSM))*1000)/1000,
            turn: bottomTurn
          })
        }

        raf = requestAnimationFrame(loop)
      }

      raf = requestAnimationFrame(loop)
    }

    start().catch(console.error)
    return () => {
      cancelAnimationFrame(raf)
      if (currentStream.current) currentStream.current.getTracks().forEach(t => t.stop())
    }
  }, [enabled, speak, useFront])

  return (
    <div style={{ maxWidth: 560, marginInline: 'auto' }}>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <button onClick={() => setUseFront(v => !v)} style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}>
          {useFront ? 'Switch to Rear Camera' : 'Switch to Front Camera'}
        </button>

        {!enabled ? (
          <button onClick={() => { enable(); test('Coaching enabled') }}
                  style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}>
            Enable Coaching Audio
          </button>
        ) : (
          <button onClick={() => test('Voice check')}
                  style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}>
            Test Voice
          </button>
        )}
      </div>

      {camError && <div style={{ color: '#f33', marginBottom: 12, fontSize: 14 }}>{camError}</div>}

      {/* Coaching banner */}
      {banner && (
        <div style={{ position: 'fixed', left: 0, right: 0, top: 12, display: 'flex', justifyContent: 'center', zIndex: 50 }}>
          <div style={{ background: 'rgba(0,0,0,0.75)', color: 'white', padding: '8px 14px', borderRadius: 12, border: '1px solid #444', fontWeight: 600 }}>
            {banner}
          </div>
        </div>
      )}

      {/* Mirror both video and canvas together when using front camera */}
      <div style={{ position: 'relative', transform: mirror ? 'scaleX(-1)' as const : 'none' }}>
        <video ref={videoRef} className="w-full rounded-2xl" playsInline muted />
        <canvas ref={canvasRef} className="w-full h-full absolute inset-0 pointer-events-none" />
      </div>

      {/* Label + debug under the canvas */}
      <div className="text-xs opacity-70 mt-2">
        {calibrated ? 'Calibrated' : 'Stand tall to calibrate…'} | FPS: {fps.toFixed(1)} | Reps: {reps} | Knee: {kneeDeg ?? '-'}° | Trunk: {trunkDeg ?? '-'}°
        {lastCue ? <> | Last cue: <strong>{lastCue}</strong></> : null}
        <div className="mt-1">
          Debug → knee: {dbg.knee}° | repOK: {dbg.repOK ? '✓' : '✗'} | coachOK(≤60°): {dbg.coachOK ? '✓' : '✗'} | depthFSM: {dbg.depthFSM} | turn: {dbg.turn ? '✓' : '✗'}
        </div>
      </div>
    </div>
  )
}
