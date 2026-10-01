import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 见 ARCHITECTURE.md 第 8 节：
// 开发期由 Vite proxy 把 /api 转发到后端，避开跨域问题。
//
// 默认目标 http://localhost:3001（后端默认端口，保持与 server 一致）。
// 允许用 HOME_CHEF_API_TARGET 覆盖，仅用于自动化测试隔离，
// 不改变开发时的默认行为。
const apiTarget = process.env.HOME_CHEF_API_TARGET ?? 'http://localhost:3001'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
})
