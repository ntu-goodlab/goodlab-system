/**
 * GOODLAB — 全站共用常數
 * Phase 5：完整值日生資料（含真實廠商電話 + 補充說明）。
 */

// 實驗室標準區域清單（不含「其他」）
export const LOCATIONS = [
    "多腔體區",
    "機房",
    "製程區",
    "黃光室",
    "量測區",
    "辦公區",
    "頂樓"
];

// 含「其他」的完整清單
export const LOCATIONS_WITH_OTHER = [...LOCATIONS, "其他"];

// Routine 任務分類
export const ROUTINE_CATEGORIES = [
    "機台維護",
    "行政",
    "實驗室環境",
    "license購買"
];

// === 值日生 ===

// 固定清潔任務清單
export const DUTY_CLEANING_TASKS = [
    { id: 'sweep', name: '掃地', detail: '實驗區及辦公區' },
    { id: 'trash', name: '倒垃圾', detail: '實驗室垃圾桶×5、辦公室垃圾桶×1、資源回收' },
    { id: 'supply_check', name: '清點耗材', detail: '清點耗材數量並詳實登記在小白板上，如有缺少需叫貨' },
    { id: 'water', name: '冰水槽水位', detail: '確認機房冰水儲存槽水位，不夠拿機房乾淨空桶裝水' },
    { id: 'fingerprint', name: '門禁指紋機', detail: '實驗區及辦公區，只能拿清水擦拭' }
];

// 耗材清點清單 — 完整 12 項
export const DUTY_SUPPLY_ITEMS = [
    { id: 'acetone',      name: 'Acetone',      threshold: '<4',  unit: '瓶', location: '機房',         vendorGroup: 'youhe' },
    { id: 'methanol',     name: 'Methanol',     threshold: '<4',  unit: '瓶', location: '機房',         vendorGroup: 'youhe' },
    { id: 'detergent',    name: 'Detergent',    threshold: '<2',  unit: '瓶', location: '機房',         vendorGroup: 'youhe' },
    { id: 'n2_tank',      name: '氮氣鋼瓶',     threshold: '<2',  unit: '瓶 (空瓶不算)', location: '機房', vendorGroup: 'qingfeng' },
    { id: 'wiper',        name: '無塵紙',       threshold: '<10', unit: '盒 (一次叫10盒)', location: '黃光室、多腔體區', vendorGroup: 'xinan' },
    { id: 'glass_slide',  name: '載玻片',       threshold: '<10', unit: '盒 (一次叫10盒)', location: '黃光室', vendorGroup: 'xinan' },
    { id: 'gloves_s',     name: '乳膠手套 S',   threshold: '<10', unit: '盒 (一次叫10盒)', location: '黃光室', vendorGroup: 'xinan' },
    { id: 'gloves_m',     name: '乳膠手套 M',   threshold: '<10', unit: '盒 (一次叫10盒)', location: '黃光室', vendorGroup: 'xinan' },
    { id: 'gloves_l',     name: '乳膠手套 L',   threshold: '<10', unit: '盒 (一次叫10盒)', location: '黃光室', vendorGroup: 'xinan' },
    { id: 'cotton_swab',  name: '棉花棒',       threshold: '<20', unit: '盒 (一次叫20盒)', location: '黃光室', vendorGroup: 'xinan' },
    { id: 'aluminum_foil',name: '鋁箔',         threshold: '<20', unit: '條 (一箱20條)', location: '黃光室', vendorGroup: 'xinan' },
    { id: 'pe_gloves',    name: 'PE手套',       threshold: '<20', unit: '盒 (一次叫20盒)', location: '黃光室', vendorGroup: 'xinan' }
];

// 耗材廠商聯絡資訊（依 vendorGroup 分組）
export const SUPPLY_VENDORS = {
    'youhe':     { vendor: '友和', phone: '(02) 2600-0611', note: 'Acetone / Methanol / Detergent' },
    'qingfeng':  { vendor: '清豐行', phone: '(02) 2541-1497', note: '司機電話：0932-148-096' },
    'xinan':     { vendor: '信安儀器', phone: '(02) 2365-4317', note: '無塵紙、載玻片、乳膠手套、棉花棒、鋁箔、PE手套' }
};

// 值日生補充說明（顯示在頁面底部）
export const DUTY_NOTES = [
    {
        title: '⚠️ 氮氣鋼瓶叫貨注意',
        content: '機房內掛牌子的空瓶才算，幾瓶空瓶就叫幾瓶。記得跟廠商確認更換日期及時間，若無法配合廠商時間請提前一晚將空瓶搬到走廊。'
    },
    {
        title: '💨 RTA 特殊氣體',
        content: 'RTA 的橋藝氣體 (0.1% H₂、純 N₂) 使用者用完自己叫，不屬於值日生工作。'
    },
    {
        title: '🗑️ 資源回收車時間 & 地點',
        content: '週一至週五<br>10:20 ~ 10:30　椰林小道 生化所與新生大樓之間<br>15:05 ~ 15:15　椰林小道 電一對面'
    },
    {
        title: '💡 日光燈、化學藥劑、膠帶等',
        content: '使用者自行叫貨，不屬於值日生工作。'
    }
];

// ==========================================
// GAS (Google Apps Script) Webhook 設定
// ==========================================
// 請在完成 GAS_SETUP_GUIDE.md 的部署後，將得到的網址填入這裡
export const GAS_WEBHOOK_URL = ""; 

