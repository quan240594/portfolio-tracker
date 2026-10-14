import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** "portfolio-tracker" / "/portfolio-tracker" / "/portfolio-tracker/" → "/portfolio-tracker/"; empty → "/". */
function normalizeBase(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}

/**
 * Static-hosting helpers (harmless elsewhere): GitHub Pages serves 404.html for unknown paths, so a copy of
 * index.html makes deep links like /portfolio-tracker/holdings boot the SPA; .nojekyll disables Jekyll processing.
 */
function staticHostingFallback(): Plugin {
  let outDir = '';
  return {
    name: 'static-hosting-fallback',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    writeBundle() {
      const index = resolve(outDir, 'index.html');
      if (!existsSync(index)) return;
      copyFileSync(index, resolve(outDir, '404.html'));
      writeFileSync(resolve(outDir, '.nojekyll'), '');
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: normalizeBase(loadEnv(mode, process.cwd(), '').VITE_BASE_PATH),
  plugins: [react(), tailwindcss(), staticHostingFallback()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
          charts: ['recharts'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/mocks/**', 'src/test/**', 'src/main.tsx', 'src/vite-env.d.ts'],
      reporter: ['lcov', 'text-summary', 'text'],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
}));
