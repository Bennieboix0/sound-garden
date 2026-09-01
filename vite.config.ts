import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Vercel's Supabase integration injects NEXT_PUBLIC_* names whatever the
  // framework, so expose that prefix too. Secrets from the same integration
  // (service role key, database password) carry neither prefix and stay out.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['seed/*.pdf', 'seed/index.json', 'icons/*.png'],
      manifest: {
        name: 'Sound Garden',
        short_name: 'Sound Garden',
        description: 'Sheet music reader for working musicians.',
        theme_color: '#0b0d0c',
        background_color: '#0b0d0c',
        display: 'fullscreen',
        orientation: 'any',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
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
