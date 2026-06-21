import { defineConfig } from 'vite';

export default defineConfig({
  base: '/goodlab-system/',
  // 開發伺服器設定
  server: {
    port: 8080,
    open: true,  // 啟動時自動開瀏覽器
    headers: {
      // 解決 Firebase Google 登入的 COOP 問題
      'Cross-Origin-Opener-Policy': 'unsafe-none',
      'Cross-Origin-Embedder-Policy': 'unsafe-none'
    }
  },
  // 建置設定
  build: {
    outDir: 'dist',
    sourcemap: true
  }
});
