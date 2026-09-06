import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('./preview-firebase.js', import.meta.url));
export default defineConfig({
    root: fileURLToPath(new URL('../', import.meta.url)), base: '/',
    envDir: fileURLToPath(new URL('../.local-tools/empty-env', import.meta.url)),
    server: { host: '127.0.0.1', port: 8091, strictPort: true, open: false },
    plugins: [{ name: 'local-fixture-only', enforce: 'pre',
        resolveId(source) {
            if (source === 'firebase/firestore' || source.endsWith('/firebase.js') || source === './firebase.js') return fixture;
        },
        transformIndexHtml(html) {
            return html.replace(/<script src="https:\/\/(?:cdn\.sheetjs\.com|cdn\.jsdelivr\.net)[^"]*"><\/script>/g, '')
                .replace('<body>', '<body><div class="preview-banner">本地假資料預覽 · 儲存功能停用　<a href="/?role=user#/overview">一般成員</a>　<a href="/?role=admin#/overview">管理員</a>　<button type="button" id="preview-refresh">模擬資料更新</button> <button type="button" id="preview-inventory-toggle">開啟盤點（預覽）</button></div>');
        }
    }]
});
