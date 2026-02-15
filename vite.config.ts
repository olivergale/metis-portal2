import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        workspace: resolve(__dirname, 'workspace-new.html'),
        workspaceOld: resolve(__dirname, 'workspace.html'),
        health: resolve(__dirname, 'health.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
        manifold: resolve(__dirname, 'manifold.html'),
        regression: resolve(__dirname, 'regression.html'),
      },
    },
  },
})
