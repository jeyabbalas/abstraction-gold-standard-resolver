/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Relative base: the built app works from any sub-path (GitHub Pages project
// sites live under /<repo>/) and from a local `vite preview`.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
