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
 * Rep counting OK but cues quiet? This version:
 * - Uses separate thresholds for REP vs COACHING depth (coach stricter).
 * - Adds a second temporal gate for coaching-depth.
 * - Lowers trunk threshold for more sensitivity.
 * - Shows a visual banner when a cue fires (even if audio blocked).
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

  // Camera controls
  const [useFront, setUseFront] = useState(true)
  const mirror = useFront

  // Coaching sensitivity (tweak live)
  const [coachDepth, setCoachDepth] = useState(0.38)     // stricter than rep depth
  const [trunkThreshDeg, setTrunkThreshDeg] = useState(30) // more sensitive trunk

  // TTS
  const { enabled, enable, speak, test } = useTTS(1200)

  // Track current stream and loop state
  const currentStream = useRef<MediaStream | null>(null)
  const lastHipYRef = useRef<number | null>(null)
  const depthPrevRef = useRef<number | null>(null)
  const lastTransitionAtRef = useRef<number>(0)

  useEffect(() => {
    let raf = 0
    let last = performance.now()

    // ----------- Smoothing -----------
    const smoother = new PoseSmoother(1.2, 0.007, 1.0, 0.08, 0.15)
    let kneeSmoothed: number | null = null
    let trunkSmoothed: number | null = null

    // ----------- FSM & Gates -----------
    let fsm = createFSM()

    // Gate for REP depth (easier)
    const repDepthGate = new TemporalGate(6, 4)
    // Gate for COACHING depth (stricter)
    const coachDepthGate = new TemporalGate(6, 4)

    let spokeCueTypeThisRep: null | 'depth' | 'trunk' | 'knee' = null

    // ----------- Calibration -----------
    const CALIB_FRAMES = 30
    const topYBuf: number[] = []
    const scaleBuf: number[] = []
    let haveTop = false
    let topY: number | null = null
    let scale: number | null = null

    // Transition hysteresis
    const MIN_TRANSITION_MS = 120
    lastTransitionAtRef.current = performance.now()

    function median(arr: number[]) {
      const a = [...arr].sort((x, y) => x - y)
      const n = a.length
      if (!n) return 0
      const mid = Math.floor(n / 2)
      return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
    }

    async function start() {
      await initPose()

      // Stop any previous stream if switching cameras
      if (currentStream.current) {
        currentStream.current.getTracks().forEach(t => t.stop())
        currentStream.current = null
      }

      // Guard for HTTPS / permissions
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
      ) {
        setCamError('Camera not available. Use localhost on desktop or HTTPS (Vercel/ngrok) on mobile.')
        return
      }

      // Prefer 1280x720 for better joint confidence; fall back gracefully
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
          // --- Smooth keypoints (time in seconds) ---
          const timeSec = now / 1000
          const kps = smoother.apply(res.keypoints, timeSec)

          const VIS = 0.2 // visibility threshold for drawing

          // --- Side-profile guard: one side must be clearly visible ---
          const leftSideOK =
            (kps[KP.LEFT_HIP].visibility ?? 0) > 0.6 &&
            (kps[KP.LEFT_KNEE].visibility ?? 0) > 0.6 &&
            (kps[KP.LEFT_ANKLE].visibility ?? 0) > 0.6
          const rightSideOK =
            (kps[KP.RIGHT_HIP].visibility ?? 0) > 0.6 &&
            (kps[KP.RIGHT_KNEE].visibility ?? 0) > 0.6 &&
            (kps[KP.RIGHT_ANKLE].visibility ?? 0) > 0.6
          const profileOK = leftSideOK || rightSideOK

          // --- Draw bones & joints ---
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

          // --- Centers & angles ---
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

          const trunk = trunkAngle(hipC, shC)
          trunkSmoothed = ema(trunkSmoothed, trunk)
          setTrunkDeg(Math.round(trunkSmoothed!))

          // --- Calibration (stand tall to capture topY + scale) ---
          const nowHipY = hipC.y
          const prevHipY = lastHipYRef.current ?? nowHipY
          const vy = nowHipY - prevHipY
          lastHipYRef.current = nowHipY

          const uprightKnees = (kneeSmoothed ?? knee) >= 165
          const uprightTrunk = (trunkSmoothed ?? trunk) <= 15
          const still = Math.abs(vy) < 0.002

          if (!haveTop && uprightKnees && uprightTrunk && still && profileOK) {
            topYBuf.push(nowHipY)
            scaleBuf.push(Math.max(0.05, shC.y - anC.y)) // shoulder->ankle span
            if (topYBuf.length >= CALIB_FRAMES) {
              topY = median(topYBuf)
              scale = median(scaleBuf)
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

          // --- Normalized depth ---
          const depth = Math.max(0, Math.min(1, (nowHipY - topY) / (scale || 1e-3)))
          const prevDepth = depthPrevRef.current ?? depth
          depthPrevRef.current = depth

          // REP thresholds (easier): controls counting
          const REP_TARGET_DEPTH = 0.33
          const DEPTH_MARGIN = 0.03
          const atRepDepthNow = depth > (REP_TARGET_DEPTH + DEPTH_MARGIN)
          const repDepthOK = repDepthGate.push(atRepDepthNow)

          // COACH thresholds (stricter): controls "Go deeper"
          const atCoachDepthNow = depth > (coachDepth + DEPTH_MARGIN)
          const coachDepthOK = coachDepthGate.push(atCoachDepthNow)

          // --- FSM (drive with repDepthOK so we don't make counting too strict) ---
          const prevState: State = fsm.state
          const nowMs = performance.now()
          const canTransition = (nowMs - lastTransitionAtRef.current) > MIN_TRANSITION_MS
          if (canTransition) {
            const next = stepFSM(fsm, depth, repDepthOK)
            if (next.state !== fsm.state) lastTransitionAtRef.current = nowMs
            fsm = next
            setReps(fsm.reps)
          }

          if (prevState === 'lockout' && fsm.state === 'descent') {
            repDepthGate.reset()
            coachDepthGate.reset()
            spokeCueTypeThisRep = null
          }

          // --- Speak/Show ONLY when we just entered 'bottom' ---
          const justHitBottom = prevState !== 'bottom' && fsm.state === 'bottom'
          if (profileOK && justHitBottom) {
            // Use coaching gate for depth cue, and trunk threshold for posture cue.
            const cues = checkRulesAtBottom({
              depthOK: coachDepthOK,
              trunkDeg: trunkSmoothed ?? trunk,
              trunkThreshold: trunkThreshDeg,
            })

            // If nothing fired but you want feedback, you can uncomment:
            // if (!cues.length) cues.push({ type: 'depth', message: 'Good rep' })

            const first = cues.find(c => c.type !== spokeCueTypeThisRep)
            if (first) {
              // Visual banner (always)
              setBanner(first.message)
              setTimeout(() => setBanner(null), 900)

              // Audio (if enabled)
              if (enabled) speak(first.message)

              setLastCue(first.message)
              spokeCueTypeThisRep = first.type
            }
          }

          // --- HUD ---
          g.fillStyle = profileOK ? '#ffffff' : '#ff7070'
          g.font = '16px system-ui'
          g.fillText(`FPS ${Math.round(fpsNow)}`, 10, 20)
          g.fillText(`Knee ${Math.round(kneeSmoothed || knee)}°`, 10, 40)
          g.fillText(`Trunk ${Math.round(trunkSmoothed || trunk)}°`, 10, 60)
          g.fillText(`Reps ${fsm.reps} | State ${fsm.state}`, 10, 80)
          g.fillText(`Depth ${(depth * 100).toFixed(0)}%`, 10, 100)
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
    <div style={{ maxWidth: 520, marginInline: 'auto' }}>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <button
          onClick={() => setUseFront(v => !v)}
          style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}
        >
          {useFront ? 'Switch to Rear Camera' : 'Switch to Front Camera'}
        </button>

        {/* Sensitivity tweaks */}
        <button
          onClick={() => setCoachDepth(d => Math.min(0.5, d + 0.02))}
          style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}
          title="Require deeper squats before saying 'good'"
        >
          Coach stricter
        </button>
        <button
          onClick={() => setCoachDepth(d => Math.max(0.30, d - 0.02))}
          style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}
          title="Easier depth requirement"
        >
          Coach easier
        </button>
        <button
          onClick={() => setTrunkThreshDeg(t => Math.max(20, t - 2))}
          style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}
          title="More sensitive to lean"
        >
          Trunk more sensitive
        </button>
        <button
          onClick={() => setTrunkThreshDeg(t => Math.min(45, t + 2))}
          style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}
          title="Less sensitive to lean"
        >
          Trunk less sensitive
        </button>

        {!enabled ? (
          <button
            onClick={() => { enable(); test('Coaching enabled') }}
            style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}
          >
            Enable Coaching Audio
          </button>
        ) : (
          <button
            onClick={() => test('Voice check')}
            style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}
          >
            Test Voice
          </button>
        )}
      </div>

      {camError && (
        <div style={{ color: '#f33', marginBottom: 12, fontSize: 14 }}>{camError}</div>
      )}

      {/* Visual coaching banner */}
      {banner && (
        <div style={{
          position: 'fixed',
          left: 0, right: 0, top: 12,
          display: 'flex', justifyContent: 'center', zIndex: 50
        }}>
          <div style={{
            background: 'rgba(0,0,0,0.75)',
            color: 'white',
            padding: '8px 14px',
            borderRadius: 12,
            border: '1px solid #444',
            fontWeight: 600
          }}>
            {banner}
          </div>
        </div>
      )}

      {/* Mirror both video and canvas together when using front camera */}
      <div style={{ position: 'relative', transform: mirror ? 'scaleX(-1)' as const : 'none' }}>
        <video ref={videoRef} className="w-full rounded-2xl" playsInline muted />
        <canvas ref={canvasRef} className="w-full h-full absolute inset-0 pointer-events-none" />
      </div>

      {/* Label under the canvas */}
      <div className="text-xs opacity-70 mt-2">
        {calibrated ? 'Calibrated' : 'Stand tall to calibrate…'} | FPS: {fps.toFixed(1)} | Reps: {reps} | Knee: {kneeDeg ?? '-'}° | Trunk: {trunkDeg ?? '-'}°
        {lastCue ? <> | Last cue: <strong>{lastCue}</strong></> : null}
      </div>
    </div>
  )
}
