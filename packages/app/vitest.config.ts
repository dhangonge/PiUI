import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { bundledLanguagesInfo } from 'shiki/langs'

const shikiSupportedLangs = bundledLanguagesInfo.flatMap(info => [info.id, ...(info.aliases ?? [])])

export default defineConfig({
  define: {
    __SHIKI_SUPPORTED_LANGS__: JSON.stringify(shikiSupportedLangs),
  },
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    coverage: {
      // 默认只统计「被测试加载过的文件」，没被任何测试引到的文件会整体逃过统计。
      // 显式 include src 下的源码，让分母固定在真实代码规模上。
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts', 'src/test/**'],
      reporter: ['text', 'html'],
      // 门槛是「不倒退」的地板，不是目标值。当前实测
      // (statements 44.6 / branches 37.3 / functions 41.7 / lines 46.7)
      // 留 1~2 个点余量；涨了就往上调，掉下来说明新代码没带测试。
      thresholds: {
        statements: 43,
        branches: 35,
        functions: 40,
        lines: 45,
      },
    },
  },
})
