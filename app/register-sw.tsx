'use client';
import { useEffect } from 'react';

/**
 * Registers our service worker once on the client.
 * Why: required for installable PWA.
 */
export default function RegisterSW() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(console.error);
    }
  }, []);
  return null;
}
