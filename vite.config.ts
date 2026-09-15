import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };
// A short commit is what actually identifies a build; the version alone cannot
// tell two deploys apart. Falls back cleanly outside a git checkout.
let commit = 'local';
try {
  commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
} catch {
  /* not a git checkout, e.g. a source tarball */
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(`${pkg.version}+${commit}`),
  },
  // Vercel's Supabase integration injects NEXT_PUBLIC_* names whatever the
  // framework, so expose that prefix too. Secrets from the same integration
  // (service role key, database password) carry neither prefix and stay out.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registration is done by hand in src/pwa/serviceWorker.ts so an update
      // can never reload the page out from under a musician mid-performance.
      injectRegister: null,
      includeAssets: [
        'seed/*.pdf',
        'seed/index.json',
        'favicon.svg',
        'apple-touch-icon.png',
      ],
      manifest: {
        name: 'Sound Garden',
        short_name: 'Sound Garden',
        description: 'Sheet music reader for working musicians',
        // ink-900 from tailwind.config.js, the app's dark surface.
        theme_color: '#0b0d0c',
        background_color: '#0b0d0c',
        // Not 'fullscreen': that hides the system clock and battery, which a
        // musician on stage has a real use for. Standalone still gives the
        // whole screen to the score.
        display: 'standalone',
        // Never locked. Scores are read in portrait on a stand and landscape
        // on a desk, and the app handles both.
        orientation: 'any',
        start_url: '/#/library',
        scope: '/',
        categories: ['music', 'productivity'],
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Separate artwork, inset to the middle 80%, so Android's circle or
          // squircle mask cannot crop the notehead off.
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The PDF worker and seed scores are large; raise the precache ceiling so the
        // app is genuinely usable offline after the first load.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // `mjs` matters: pdf.js ships its worker with that extension, and
        // without it in the cache nothing renders offline at all.
        globPatterns: ['**/*.{js,mjs,css,html,ico,png,svg,woff2,pdf,json,webmanifest}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
  // pdf.js ships its worker as a separate ESM chunk; pre-bundling it confuses Vite's
  // dep optimiser, so leave it to be resolved through the `?url` import in src/pdf/pdfjs.ts.
  optimizeDeps: {
    exclude: ['pdfjs-dist/build/pdf.worker.min.mjs'],
  },
  build: {
    target: 'es2022',
  },
});
