import { defineConfig } from 'vite';
import legacy from './preview.config.mjs';
export default defineConfig({ ...legacy,
    define: { 'import.meta.env.VITE_ACCESS_MODEL': JSON.stringify('approved') },
    server: { ...legacy.server, port: 8092 },
    plugins: [...legacy.plugins, { name: 'approved-preview-label', transformIndexHtml(html) {
        return html.replace('本地假資料預覽 · 儲存功能停用', '新版授權整合預覽 · 僅操作本機假資料')
            .replace('一般成員</a>', '一般成員</a>　<a href="/?role=guest">未開通帳號</a>');
    } }]
});
