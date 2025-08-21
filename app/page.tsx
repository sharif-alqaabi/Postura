'use client';
import { useEffect } from 'react';
import CameraCanvas from './components/CameraCanvas';
import { useTTS } from './lib/audio/useTTS';

/**
 * Home page:
 * - Button to enable coaching (required for iOS audio policy)
 * - Mounts the camera/canvas component
 */
export default function Home() {
  const { enable, enabled, speak } = useTTS();

  // Give a short confirmation once TTS is enabled
  useEffect(() => {
    if (enabled) speak('Coaching enabled');
  }, [enabled, speak]);

  return (
    <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 12 }}>Postura — Squat Coach</h1>

        {/* User gesture to allow TTS (especially on iOS) */}
        {!enabled ? (
          <button
            onClick={() => enable()}
            style={{ padding: '8px 14px', borderRadius: 12, border: '1px solid #444', cursor: 'pointer' }}
          >
            Enable Coaching
          </button>
        ) : null}

        {/* Camera + overlay */}
        <div style={{ marginTop: 12 }}>
          <CameraCanvas />
        </div>
      </div>
    </main>
  );
}
