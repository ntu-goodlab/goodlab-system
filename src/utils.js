/**
 * GOODLAB — 共用工具函式
 * 從 script.js 中抽出所有模組都會用到的工具函式。
 */

// 統一 ID 生成邏輯 (YYYYMMDDHHMMSS_隨機數)
export function generateId(prefix) {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const rand = Math.floor(Math.random() * 900) + 100;
    return `${prefix}_${yyyy}${mm}${dd}${hh}${min}${ss}_${rand}`;
}

// Firestore 文字在插入 innerHTML 前一律先轉義，避免使用者輸入被當成標記執行。
export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    })[character]);
}

// 日期格式化（YYYY-MM-DD），已修正時區偏移
export function formatDateForInput(dateStr) {
    if (!dateStr || dateStr === "-") return "";
    if (typeof dateStr === 'string' && dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) return dateStr;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "";
    const localDate = new Date(d.getTime() - (d.getTimezoneOffset() * 60000));
    return localDate.toISOString().split('T')[0];
}

// 從 members 陣列中取得名字（支援 Student_ID 或 Google_UID）
export function getMemberName(members, id) {
    if (!id) return '';
    if (id === 'Fund') return '公積金';
    const normalizedId = String(id).trim().toLowerCase();
    const m = members.find(x =>
        String(x.Student_ID || '').trim().toLowerCase() === normalizedId
        || x.Google_UID === id
        || (x.Previous_Google_UIDs || []).includes(id)
        || (x.Previous_Student_IDs || []).some(previous =>
            String(previous || '').trim().toLowerCase() === normalizedId
        )
    );
    return m ? m.Name_Ch : id;
}

// 計算學年期別（例：「碩一上」「博二下」）
export function calculateGrade(enrollDateStr, degree) {
    if (!enrollDateStr || enrollDateStr === "-") return "未知";
    const start = new Date(enrollDateStr);
    const now = new Date();
    const monthDiff = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
    if (monthDiff < 0) return "新生";
    const semester = Math.floor(monthDiff / 6) + 1;
    const year = Math.ceil(semester / 2);
    const term = (semester % 2 === 1) ? "上" : "下";
    let prefix = "";
    if (degree === "PhD") prefix = "博";
    else if (degree === "Master") prefix = "碩";
    else prefix = "大";
    return `${prefix}${year}${term}`;
}
