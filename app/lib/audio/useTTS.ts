'use client';
import { useCallback, useRef, useState } from 'react';

/**
 * TTS hook with:
 * - enable(): must be called by a tap (unlocks audio on iOS/Chrome)
 * - speak(text): rate-limited; resets queue to avoid stuck audio
 * - test(text): quick sanity check after enabling
 */
export function useTTS(minGapMs = 1200) {
  const lastSpoke = useRef(0);
  const [enabled, setEnabled] = useState(false);

  const speak = useCallback((text: string) => {
    if (!enabled) return;
    const synth = (typeof window !== 'undefined') ? window.speechSynthesis : undefined;
    if (!synth) return;
    const now = performance.now();
    if (now - lastSpoke.current < minGapMs) return;

    // Some browsers get "stuck"; cancel clears the queue before speaking.
    try { synth.cancel(); } catch {}
    const u = new SpeechSynthesisUtterance(text);
    synth.speak(u);
    lastSpoke.current = now;
  }, [enabled, minGapMs]);

  const enable = useCallback(() => {
    setEnabled(true);
    // Warm-up: cancel any stale queue once the user taps.
    try { window.speechSynthesis?.cancel(); } catch {}
  }, []);

  const test = useCallback((text = 'Voice check') => {
    // Only works after enable() has been tapped
    const synth = (typeof window !== 'undefined') ? window.speechSynthesis : undefined;
    if (!synth) return false;
    try {
      synth.cancel();
      synth.speak(new SpeechSynthesisUtterance(text));
      lastSpoke.current = performance.now();
      return true;
    } catch {
      return false;
    }
  }, []);

  return { enabled, enable, speak, test };
}
