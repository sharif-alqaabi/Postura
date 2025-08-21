'use client';
import { useCallback, useRef, useState } from 'react';

/**
 * Very small Text-To-Speech hook with a cooldown so we don't "spam" the user.
 * - enable(): must be called via a user click (iOS audio policy)
 * - speak(text): enqueues a spoken message, rate-limited
 */
export function useTTS(minGapMs = 1200) {
  const lastSpoke = useRef(0);
  const [enabled, setEnabled] = useState(false);

  const speak = useCallback((text: string) => {
    if (!enabled) return;                       // must be enabled by user gesture
    if (!('speechSynthesis' in window)) return; // browser supports TTS
    const now = performance.now();
    if (now - lastSpoke.current < minGapMs) return; // rate limit

    const utterance = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utterance);
    lastSpoke.current = now;
  }, [enabled, minGapMs]);

  return { enabled, enable: () => setEnabled(true), speak };
}
