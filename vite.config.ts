import { defineConfig } from 'vite'

export default defineConfig({
  base: './', // works from a GitHub Pages subpath and inside the .ehpk
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
})
