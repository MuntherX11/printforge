import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  optimizeDeps: {
    // Both ship their own wasm loaded relative to the module — keep them
    // un-prebundled so import.meta.url resolution stays intact in dev.
    exclude: ['manifold-3d', 'harfbuzzjs'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
})
