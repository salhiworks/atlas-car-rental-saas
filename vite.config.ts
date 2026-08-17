/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'

import packageJson from './package.json' with { type: 'json' }

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  /*
   * The version the About panel shows, taken from package.json at build time.
   *
   * Inlined as a constant rather than imported: importing the manifest would put
   * the whole dependency list in the browser bundle to display one string, and
   * declaring the version a second time in source would let the two drift until
   * the product told somebody the wrong one.
   */
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    // Hostinger serves the built `dist/` directory as static assets.
    outDir: 'dist',
    /*
     * No source maps in the production bundle.
     *
     * Nothing consumes them: there is no error-monitoring service on this
     * deployment, so the only reader would be somebody with the site open in
     * developer tools. What they would get is the entire annotated source —
     * including the comments that explain where each authorization boundary is
     * and why. That is a reconnaissance aid, not a debugging aid, and it also
     * roughly triples what has to be uploaded.
     *
     * `vite dev` is unaffected: the dev server always serves maps, whatever
     * this says. Set it back to true (or 'hidden', which emits the files
     * without advertising them) only alongside something that actually reads
     * them.
     */
    sourcemap: false,
    target: 'es2022',
    // Routes are lazy-loaded, so the entry chunk is the unavoidable runtime:
    // React, the router, TanStack Query and the Supabase client. It sits just
    // above the 500 kB default (~147 kB gzipped); raising the threshold keeps
    // the warning meaningful instead of firing on every build.
    //
    // One chunk exceeds it on purpose: @react-pdf's renderer, at roughly 1.3 MB.
    // It is imported dynamically and only when somebody actually produces a
    // contract PDF, so nobody downloads a PDF engine to look at a list. The
    // warning is expected for that chunk and for no other.
    chunkSizeWarningLimit: 600,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'supabase/tests/**/*.test.ts'],
    // Schema tests boot a real PostgreSQL (WASM) instance and apply every migration.
    testTimeout: 30_000,
    hookTimeout: 180_000,
    restoreMocks: true,
  },
})
