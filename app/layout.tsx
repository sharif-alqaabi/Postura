import type { Metadata } from 'next';
import './globals.css';
import RegisterSW from './register-sw';

// Metadata controls <head> tags and PWA manifest link.
export const metadata: Metadata = {
  title: 'Postura',
  description: 'Real-time workout form coach',
  // Makes Next.js include a <link rel="manifest"> for PWA
  manifest: '/manifest.webmanifest',
  // Helps the OS color the browser UI
  themeColor: '#0B0F1A',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Registers service worker on the client */}
        <RegisterSW />
        {children}
      </body>
    </html>
  );
}
