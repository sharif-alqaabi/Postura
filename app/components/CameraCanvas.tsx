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
 * Camera + overlay + calibrated normalized depth + turnaround coaching.
 * Key fixes:
 *  - Longer calibration with stillness check; fallback scale if ankles occluded.
 *  - Rep depth gate (for counting) vs Coaching depth gate (stricter) + turnaround detector.
 *  - Trunk delta vs upright baseline (compensates phone tilt).
 *  - One-Euro smoothing + despike; stricter side-profile but with ankle fallback.
 *  - Visual banner + debug line so you see WHY cues fired or not.
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
  const [dbg, setDbg] = useState<{ repOK:boolean; coachOK:boolean; trunkDelta:number; coachDepth:number; vel:number; bottomTurn:boolean }>({repOK:false, coachOK:false, trunkDelta:0, coachDepth:0.38, vel:0, bottomTurn:false})

  // Camera controls
  const [useFront, setUseFront] = useState(true)
  const mirror = useFront

  // Coaching knobs (tweak live if needed)
  const [coachDepth, setCoachDepth] = useState(0.38)       // stricter than rep depth
  const [trunkThreshDeg, setTrunkThreshDeg] = useState(14) // 12–18° typical

  const { enabled, enable, speak, test } = useTTS(1200)

  // Stream + loop state
  const currentStream = useRef<MediaStream | null>(null)
  const lastHipYRef = useRef<number | null>(null)
  const depthPrevRef = useRef<number | null>(null)
  const velPrevRef = useRef<number | null>(null)
  const lastTransitionAtRef = useRef<number>(0)

  // Adaptive coaching depth (learned from your good bottoms)
  const learnedCoachDepthRef = useRef<number | null>(null)
  const goodBottomsRef = useRef<number[]>([])

  // Upright trunk baseline (deg) learned during calibration
  const trunkBaselineRef = useRef<number | null>(null)

  useEffect(() => {
    let raf = 0
    let last = performance.now()

    // -------- Smoothing --------
    const smoother = new PoseSmoother(1.4, 0.006, 1.0, 0.07, 0.15) // slightly stronger smoothing
    let kneeSmoothed: number | null = null
    let trunkSmoothed: number | null = null

    // -------- FSM & Gates --------
    let fsm = createFSM()

    // Gates: a bit stricter at ~60 FPS (8/6 ≈ ~130 ms)
    const repDepthGate = new TemporalGate(8, 6)   // counting
    const coachDepthGate = new TemporalGate(8, 6) // coaching
    let coachConsec = 0

    let spokeCueTypeThisRep: null | 'depth' | 'trunk' | 'knee' = null

    // -------- Calibration (top, scale, trunk baseline) --------
    const CALIB_FRAMES = 90 // ~1.5s at 60 FPS
    const topYBuf: number[] = []
    const scaleBuf: number[] = []
    const trunkBaseBuf: number[] = []
    const hipYWindow: number[] = [] // for stillness std-dev
    let haveTop = false
    let topY: number | null = null
    let scale: number | null = null

    // Transition hysteresis
    const MIN_TRANSITION_MS = 130
    lastTransitionAtRef.current = performance.now()

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

          // Side-profile guard (ankles sometimes hidden near walls → allow hip+knee only)
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
          const anC = {
            x: (kps[KP.LEFT_ANKLE].x + kps[KP.RIGHT_ANKLE].x) / 2,
            y: (kps[KP.LEFT_ANKLE].y + kps[KP.RIGHT_ANKLE].y) / 2,
          }
          const kneeC = {
            y: (kps[KP.LEFT_KNEE].y + kps[KP.RIGHT_KNEE].y) / 2,
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
          setKneeDeg(Math.round(kneeSmoothed!))

          const trunk = trunkAngle(hipC, shC) // angle to vertical
          trunkSmoothed = ema(trunkSmoothed, trunk)
          setTrunkDeg(Math.round(trunkSmoothed!))

          // ---- Calibration (top, scale, trunk baseline) ----
          const nowHipY = hipC.y
          const prevHipY = lastHipYRef.current ?? nowHipY
          lastHipYRef.current = nowHipY

          // Build stillness window (hipY std-dev)
          hipYWindow.push(nowHipY)
          if (hipYWindow.length > 20) hipYWindow.shift()
          const still = stddev(hipYWindow) < 0.0009 // fairly still

          const anklesVisible =
            (kps[KP.LEFT_ANKLE].visibility ?? 0) > 0.45 &&
            (kps[KP.RIGHT_ANKLE].visibility ?? 0) > 0.45
          const scaleCandidate = anklesVisible
            ? Math.max(0.05, shC.y - anC.y)                   // shoulder->ankle span
            : Math.max(0.05, hipC.y - kneeC.y) * 1.8          // fallback when ankles hidden

          const uprightKnees = (kneeSmoothed ?? knee) >= 165
          const uprightTrunk = (trunkSmoothed ?? trunk) <= 15

          if (!haveTop && uprightKnees && uprightTrunk && still && profileOK) {
            topYBuf.push(nowHipY)
            scaleBuf.push(scaleCandidate)
            trunkBaseBuf.push(trunkSmoothed ?? trunk)
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

          // ---- Normalized depth, velocity & gates ----
          const depth = Math.max(0, Math.min(1, (nowHipY - topY) / (scale || 1e-3)))
          const prevDepth = depthPrevRef.current ?? depth
          depthPrevRef.current = depth
          const vel = depth - prevDepth
          const prevVel = velPrevRef.current ?? vel
          velPrevRef.current = vel

          // REP thresholds (easier) — counting
          const REP_TARGET_DEPTH = 0.33
          const DEPTH_MARGIN = 0.03
          const atRepDepthNow = depth > (REP_TARGET_DEPTH + DEPTH_MARGIN)
          const repOK = repDepthGate.push(atRepDepthNow)

          // COACH thresholds (stricter) — guidance
          const coachTarget = (learnedCoachDepthRef.current ?? coachDepth)
          const atCoachDepthNow = depth > (coachTarget + DEPTH_MARGIN)
          const coachOK = coachDepthGate.push(atCoachDepthNow)
          coachConsec = atCoachDepthNow ? (coachConsec + 1) : 0

          // FSM driven by repOK (don’t over tighten counting)
          const prevState: State = fsm.state
          const nowMs = performance.now()
          const canTransition = (nowMs - lastTransitionAtRef.current) > MIN_TRANSITION_MS
          if (canTransition) {
            const next = stepFSM(fsm, depth, repOK)
            if (next.state !== fsm.state) lastTransitionAtRef.current = nowMs
            fsm = next
            setReps(fsm.reps)
          }

          // Learn coaching depth from your first good bottoms
          const justHitBottom = prevState !== 'bottom' && fsm.state === 'bottom'
          if (justHitBottom && repOK) {
            goodBottomsRef.current.push(depth)
            if (goodBottomsRef.current.length >= 2 && learnedCoachDepthRef.current == null) {
              const m = median(goodBottomsRef.current)
              // keep coaching target reasonably demanding
              learnedCoachDepthRef.current = Math.max(0.36, Math.min(0.50, m - 0.01))
            }
          }

          if (prevState === 'lockout' && fsm.state === 'descent') {
            repDepthGate.reset()
            coachDepthGate.reset()
            coachConsec = 0
            spokeCueTypeThisRep = null
          }

          // Turnaround detector (so shallow reps still get coached)
          const bottomTurnaround = (prevVel > 0.002) && (vel <= 0.0005)

          // Trunk delta vs upright baseline
          const trunkBase = trunkBaselineRef.current ?? 0
          const trunkDelta = Math.max(0, (trunkSmoothed ?? trunk) - trunkBase)

          // Speak/Show at bottom entry (counted) OR at shallow turnaround (uncounted)
          const shouldEvaluate = (profileOK && (justHitBottom || bottomTurnaround))
          if (shouldEvaluate) {
            const depthAchieved = coachOK && (coachConsec >= 5) // ~80–100ms dwell at 60 FPS
            const cues = checkRulesAtBottom({
              depthAchieved,
              trunkDeltaDeg: trunkDelta,
              trunkDeltaThreshold: trunkThreshDeg,
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

          // HUD & Debug
          g.fillStyle = profileOK ? '#ffffff' : '#ff7070'
          g.font = '16px system-ui'
          g.fillText(`FPS ${Math.round(fpsNow)}`, 10, 20)
          g.fillText(`Knee ${Math.round(kneeSmoothed || knee)}°`, 10, 40)
          g.fillText(`Trunk ${Math.round(trunkSmoothed || trunk)}°`, 10, 60)
          g.fillText(`Reps ${fsm.reps} | State ${fsm.state}`, 10, 80)
          g.fillText(`Depth ${(depth * 100).toFixed(0)}%`, 10, 100)

          setDbg({
            repOK,
            coachOK,
            trunkDelta: Math.round(trunkDelta),
            coachDepth: Math.round((learnedCoachDepthRef.current ?? coachDepth) * 100) / 100,
            vel: Math.round(vel*1000)/1000,
            bottomTurn: bottomTurnaround
          })

          if (!profileOK) g.fillText('Tip: side-on; show hips-knees-ankles', 10, 120)
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
  }, [enabled, speak, useFront, coachDepth, trunkThreshDeg])

  return (
    <div style={{ maxWidth: 560, marginInline: 'auto' }}>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <button onClick={() => setUseFront(v => !v)} style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}>
          {useFront ? 'Switch to Rear Camera' : 'Switch to Front Camera'}
        </button>

        <button onClick={() => setCoachDepth(d => Math.min(0.5, d + 0.02))}
                style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}
                title="Require deeper squats before 'good'">
          Coach stricter
        </button>
        <button onClick={() => setCoachDepth(d => Math.max(0.30, d - 0.02))}
                style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}
                title="Easier depth requirement">
          Coach easier
        </button>
        <button onClick={() => setTrunkThreshDeg(t => Math.max(10, t - 2))}
                style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}
                title="More sensitive to forward lean">
          Trunk more sensitive
        </button>
        <button onClick={() => setTrunkThreshDeg(t => Math.min(30, t + 2))}
                style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}
                title="Less sensitive to forward lean">
          Trunk less sensitive
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
          Debug → repOK: {dbg.repOK ? '✓' : '✗'} | coachOK: {dbg.coachOK ? '✓' : '✗'} | trunkΔ: {dbg.trunkDelta}° | coachDepth: {dbg.coachDepth} | vel: {dbg.vel} | turn: {dbg.bottomTurn ? '✓' : '✗'}
        </div>
      </div>
    </div>
  )
}
