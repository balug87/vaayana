import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Only the Pages workflow sets this; ordinary npm start keeps the stable local root.
const base = process.env.VAAYANA_BASE_PATH || '/';
export default defineConfig({
  base,
  plugins: [
    react(),
    {
      name: 'vaayana-security-policy',
      apply: 'build',
      transformIndexHtml: () => [{
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://openlibrary.org https://covers.openlibrary.org https://huggingface.co https://*.huggingface.co https://*.hf.co; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
        },
        injectTo: 'head',
      }],
    },
    VitePWA({
      base,
      scope: base,
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}', 'import-formats/*.json'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        globIgnores: ['**/*onnx*', '**/*transformers*', '**/*semantic.worker*', '**/*.wasm', '**/*.mjs'],
      },
      manifest: {
        name: 'Vaayana · A life in books',
        short_name: 'Vaayana',
        description: 'Your personal library and reading life, on your device.',
        theme_color: '#f5f1e8',
        background_color: '#f5f1e8',
        display: 'standalone',
        id: base,
        start_url: base,
        scope: base,
        icons: [
          { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: `${base}icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
  build: {
    sourcemap: true,
    rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom'], database: ['dexie', 'dexie-react-hooks'], animation: ['motion/react'] } } },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'tests/**/*.test.ts'], exclude: ['tests/e2e/**'] },
} as Parameters<typeof defineConfig>[0]);
