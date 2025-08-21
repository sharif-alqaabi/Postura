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
 * Depth logic keyed to knee ≤ 50° (coaching), and knee ≤ 70° (rep counting).
 * - Monotonic depthFSM = max(hipDepth, kneeDepth) for stable FSM.
 * - Coaching + rep have separate (stricter vs easier) thresholds.
 * - Knee-depth normalization: 180° -> 0, 50° -> 1.
 * - Hip-depth equivalents tuned to match (rep≈0.45, coach≈0.52).
 * - Turnaround detector + dwell + hysteresis to avoid random counts.
 * - Trunk cue uses delta vs upright baseline for reliable “Chest up”.
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
  const [lastCue, setLastCue] = useState<string | null>(null)
  const [calibrated, setCalibrated] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [dbg, setDbg] = useState<{
    repOK: boolean; coachOK: boolean; trunkDelta: number;
    knee: number; depthHip: number; depthKnee: number; depthFSM: number;
    vel: number; turn: boolean;
  }>({repOK:false, coachOK:false, trunkDelta:0, knee:0, depthHip:0, depthKnee:0, depthFSM:0, vel:0, turn:false})

  // Camera controls
  const [useFront, setUseFront] = useState(true)
  const mirror = useFront

  // ---- Thresholds aligned to knee 50° target ----
  // Rep counting (easier)
  const REP_KNEE_DEG   = 70;   // knee ≤ 70° counts as deep enough for reps
  const REP_HIP_DEPTH  = 0.45; // equivalent hip-depth
  // Coaching (stricter)
  const COACH_KNEE_DEG = 50;   // knee ≤ 50° is the coaching "good depth"
  const COACH_HIP_DEPTH= 0.52; // equivalent hip-depth
  // Dwell & hysteresis
  const GATE_WINDOW = 8, GATE_NEED = 6; // ≈130ms @60fps
  const DWELL_FRAMES = 5;               // frames coachOK must persist
  const MIN_TRANSITION_MS = 140;

  // TTS
  const { enabled, enable, speak, test } = useTTS(1200)

  // Stream + loop state
  const currentStream = useRef<MediaStream | null>(null)
  const lastHipYRef = useRef<number | null>(null)
  const prevDepthFSMRef = useRef<number | null>(null)
  const prevVelRef = useRef<number | null>(null)
  const lastTransitionAtRef = useRef<number>(0)

  // Learned (auto-tuned) coaching targets (start near our defaults, clamp around new spec)
  const learnedCoachHipRef = useRef<number | null>(null)
  const learnedCoachKneeRef = useRef<number | null>(null)
  const goodBottomHip: number[] = []
  const goodBottomKnee: number[] = []

  // Upright trunk baseline (deg) learned during calibration
  const trunkBaselineRef = useRef<number | null>(null)

  useEffect(() => {
    let raf = 0
    let last = performance.now()

    // -------- Smoothing --------
    const smoother = new PoseSmoother(1.4, 0.006, 1.0, 0.07, 0.15)
    let kneeSmoothed: number | null = null
    let trunkSmoothed: number | null = null

    // -------- FSM & Gates --------
    let fsm = createFSM()
    const repGate = new TemporalGate(GATE_WINDOW, GATE_NEED)
    const coachGate = new TemporalGate(GATE_WINDOW, GATE_NEED)
    let coachConsec = 0
    let spokeCueTypeThisRep: null | 'depth' | 'trunk' | 'knee' = null

    // -------- Calibration (top, scale, trunk baseline) --------
    const CALIB_FRAMES = 90 // ~1.5s @60fps
    const topYBuf: number[] = []
    const scaleBuf: number[] = []
    const trunkBaseBuf: number[] = []
    const hipYWindow: number[] = []
    let haveTop = false
    let topY: number | null = null
    let scale: number | null = null

    function median(arr: number[]) {
      const a = [...arr].sort((x, y) => x - y)
      const n = a.length
      if (!n) return 0
      const mid = Math.floor(n / 2)
      return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
    }
    function stddev(arr: number[]) {
      const n = arr.length
      if (n < 2) return 0
      const m = arr.reduce((s,v)=>s+v,0)/n
      const v = arr.reduce((s,v)=>s+(v-m)*(v-m),0)/(n-1)
      return Math.sqrt(v)
    }
    function clamp01(x:number){ return Math.max(0, Math.min(1, x)) }

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
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints)
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      }
      currentStream.current = stream

      const v = videoRef.current!
      const c = canvasRef.current!
      const g = c.getContext('2d')!
      v.srcObject = stream
      await v.play()

      // Init
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
          // --- Smooth keypoints ---
          const timeSec = now / 1000
          const kps = smoother.apply(res.keypoints, timeSec)
          const VIS = 0.2

          // Side-profile guard (hip+knee visibility required; ankles may be hidden)
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
          const ankVis =
            (kps[KP.LEFT_ANKLE].visibility ?? 0) > 0.45 &&
            (kps[KP.RIGHT_ANKLE].visibility ?? 0) > 0.45
          const anC = {
            x: (kps[KP.LEFT_ANKLE].x + kps[KP.RIGHT_ANKLE].x) / 2,
            y: (kps[KP.LEFT_ANKLE].y + kps[KP.RIGHT_ANKLE].y) / 2,
          }
          const kneeC = { y: (kps[KP.LEFT_KNEE].y + kps[KP.RIGHT_KNEE].y) / 2 }

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

          const trunk = trunkAngle(hipC, shC) // absolute vs vertical
          trunkSmoothed = ema(trunkSmoothed, trunk)
          const trunkNow = trunkSmoothed ?? trunk
          setTrunkDeg(Math.round(trunkNow))

          // ---- Calibration (top, scale, trunk baseline) ----
          const nowHipY = hipC.y
          const prevHipY = lastHipYRef.current ?? nowHipY
          lastHipYRef.current = nowHipY

          hipYWindow.push(nowHipY)
          if (hipYWindow.length > 20) hipYWindow.shift()
          const still = stddev(hipYWindow) < 0.0009

          const scaleCandidate = ankVis
            ? Math.max(0.05, shC.y - anC.y)              // shoulder->ankle span
            : Math.max(0.05, hipC.y - kneeC.y) * 1.8     // fallback if ankles hidden

          const uprightKnees = kneeNow >= 170
          const uprightTrunk = trunkNow <= 12

          if (!haveTop && uprightKnees && uprightTrunk && still && profileOK) {
            topYBuf.push(nowHipY)
            scaleBuf.push(scaleCandidate)
            trunkBaseBuf.push(trunkNow)
            if (topYBuf.length >= CALIB_FRAMES) {
              topY = median(topYBuf)
              scale = median(scaleBuf)
              trunkBaselineRef.current = median(trunkBaseBuf)
              haveTop = true
              setCalibrated(true)
            }
          }

          if (!haveTop || !topY || !scale) {
            g.fillStyle = '#ffdb6e'
            g.font = '16px system-ui'
            g.fillText('Stand tall to calibrate…', 10, 24)
            g.fillText('Tips: side-on, full body, good light', 10, 44)
            raf = requestAnimationFrame(loop); return
          }

          // ---- Depth metrics ----
          // Hip-based normalized depth (0=top, 1=deep)
          const depthHip = clamp01((nowHipY - topY) / (scale || 1e-3))
          // Knee-based depth: 180° (top) -> 0, 50° (target deep) -> 1
          const depthKnee = clamp01((180 - kneeNow) / (180 - 50))
          // Monotonic driver for FSM
          const depthFSM = Math.max(depthHip, depthKnee)

          // Velocity & turnaround on FSM depth
          const prevDepthFSM = prevDepthFSMRef.current ?? depthFSM
          prevDepthFSMRef.current = depthFSM
          const vel = depthFSM - prevDepthFSM
          const prevVel = prevVelRef.current ?? vel
          prevVelRef.current = vel
          const bottomTurn = (prevVel > 0.003) && (vel <= 0.0008)

          // REP gating: knee or hip depth (easier)
          const repOKNow = (kneeNow <= REP_KNEE_DEG) || (depthHip >= REP_HIP_DEPTH)
          const repOK = repGate.push(repOKNow)

          // COACH gating: knee or hip depth (stricter)
          const coachKneeTarget = learnedCoachKneeRef.current ?? COACH_KNEE_DEG
          const coachHipTarget  = learnedCoachHipRef.current  ?? COACH_HIP_DEPTH
          const coachOKNow = (kneeNow <= coachKneeTarget) || (depthHip >= coachHipTarget)
          const coachOK = coachGate.push(coachOKNow)
          coachConsec = coachOKNow ? (coachConsec + 1) : 0

          // FSM driven by depthFSM & repOK
          const prevState: State = fsm.state
          const nowMs = performance.now()
          const canTransition = (nowMs - lastTransitionAtRef.current) > MIN_TRANSITION_MS
          if (canTransition) {
            const next = stepFSM(fsm, depthFSM, repOK)
            if (next.state !== fsm.state) lastTransitionAtRef.current = nowMs
            fsm = next
            setReps(fsm.reps)
          }

          // Learn stricter coaching targets from early good bottoms (clamped around new spec)
          const justHitBottom = prevState !== 'bottom' && fsm.state === 'bottom'
          if (justHitBottom && repOK) {
            goodBottomHip.push(depthHip)
            goodBottomKnee.push(kneeNow)
            if (goodBottomHip.length >= 2 && learnedCoachHipRef.current == null) {
              const mHip = median(goodBottomHip)
              const mKnee = median(goodBottomKnee)
              learnedCoachHipRef.current  = Math.max(0.50, Math.min(0.65, mHip  - 0.01))
              learnedCoachKneeRef.current = Math.max(50,   Math.min(75,   mKnee + 0))
            }
          }

          if (prevState === 'lockout' && fsm.state === 'descent') {
            repGate.reset()
            coachGate.reset()
            coachConsec = 0
            spokeCueTypeThisRep = null
          }

          // Trunk delta vs upright baseline (compensates for phone tilt)
          const trunkBase = trunkBaselineRef.current ?? 0
          const trunkDelta = Math.max(0, trunkNow - trunkBase)

          // Evaluate cues at counted bottom OR shallow turnaround
          const shouldEval = profileOK && (justHitBottom || bottomTurn)
          if (shouldEval) {
            const depthAchieved = coachOK && (coachConsec >= DWELL_FRAMES)
            const cues = checkRulesAtBottom({
              depthAchieved,
              trunkDeltaDeg: trunkDelta,
              trunkDeltaThreshold: 16,
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

          // --- HUD & Debug ---
          g.fillStyle = profileOK ? '#ffffff' : '#ff7070'
          g.font = '16px system-ui'
          g.fillText(`FPS ${Math.round(fpsNow)}`, 10, 20)
          g.fillText(`Knee ${Math.round(kneeNow)}°`, 10, 40)
          g.fillText(`Trunk ${Math.round(trunkNow)}°`, 10, 60)
          g.fillText(`Reps ${fsm.reps} | State ${fsm.state}`, 10, 80)
          g.fillText(`DepthHip ${(depthHip*100).toFixed(0)}%`, 10, 100)
          g.fillText(`DepthKnee ${(depthKnee*100).toFixed(0)}%`, 10, 120)

          setDbg({
            repOK, coachOK,
            trunkDelta: Math.round(trunkDelta),
            knee: Math.round(kneeNow),
            depthHip: Math.round(depthHip*100)/100,
            depthKnee: Math.round(depthKnee*100)/100,
            depthFSM: Math.round(Math.max(depthHip, depthKnee)*100)/100,
            vel: Math.round( (depthFSM - (prevDepthFSMRef.current ?? depthFSM)) * 1000 )/1000,
            turn: bottomTurn,
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
          Debug → repOK: {dbg.repOK ? '✓' : '✗'}
          {' '}| coachOK: {dbg.coachOK ? '✓' : '✗'}
          {' '}| knee: {dbg.knee}°
          {' '}| hipDepth: {dbg.depthHip}
          {' '}| kneeDepth: {dbg.depthKnee}
          {' '}| depthFSM: {dbg.depthFSM}
          {' '}| turn: {dbg.turn ? '✓' : '✗'}
        </div>
      </div>
    </div>
  )
}
