// No Firebase imports: this preview cannot contact Auth or Firestore.
import { getDutyWeekId } from '../src/duty-schedule.js';
import { DUTY_CLEANING_TASKS, DUTY_SUPPLY_ITEMS } from '../src/constants.js';
const isAdmin = new URLSearchParams(location.search).get('role') === 'admin';
const isUnbound = new URLSearchParams(location.search).get('role') === 'guest';
const legacyAdmin = new URLSearchParams(location.search).get('legacyAdmin') === '1';
const uid = isUnbound ? 'preview-unbound' : isAdmin ? 'preview-admin' : 'preview-user';
const user = { uid, displayName: '預覽成員', email: `${uid}@example.test` };
const members = [
    { Student_ID: 'preview-a', Name_Ch: '林同學', Role: 'User', Status: 'Active', Degree: 'Master',
        Enrollment_Date: '2025-09-01', Department: '電機工程學系', Email: 'student@example.test',
        Google_UID: 'preview-user', Google_Email: 'preview-user@example.test', Google_Display_Name: '預覽成員' },
    { Student_ID: 'preview-b', Name_Ch: '陳同學', Role: 'User', Status: 'Active', Degree: 'Master', Enrollment_Date: '2025-09-01', Google_UID: 'preview-second', Email: 'second@example.test' },
    { Student_ID: 'preview-admin-a', Name_Ch: '管理員', Role: 'Admin', Status: 'Active', Degree: 'PhD',
        Google_UID: 'preview-admin', Google_Email: 'preview-admin@example.test', Google_Display_Name: '預覽成員' }
];
const week = getDutyWeekId();
const fixtures = {
    members,
    admins: isAdmin ? [legacyAdmin ? { _id: uid } : { _id: uid, student_id: 'preview-admin-a' }] : [],
    inventory: [{ Property_ID: '_SETTINGS_', IsOpen: false },
        { Property_ID: 'P001-A01-00', Name: '薄膜厚度量測儀', Location: '量測區', Personal_Remark: '靠窗第二張桌子', Status: 'Pending', Brand: 'Demo', Model: 'T-100' },
        { Property_ID: 'P002-A01-00', Name: '真空幫浦', Location: '機房', Status: 'Checked', Checked_By: 'preview-user', Checked_By_Student_ID: 'preview-a' }],
    instruments: [{ Instrument_ID: 'I001', Name: '薄膜厚度量測儀', Location: '量測區', Is_Active: true,
        Manager_ID: 'preview-a', Vendor_Info: '示範廠商，請聯絡設備負責人', Manual_Link: 'http://127.0.0.1:8091/scripts/preview-manual.html', Linked_Property_IDs: ['P001-A01-00'] }],
    duty_records: [{ _id: week, week_start: week, scheduled_to: 'preview-a', assigned_to: 'preview-a',
        assignment_source: 'auto', status: 'pending', submitted: false, note: '',
        cleaning: Object.fromEntries(DUTY_CLEANING_TASKS.map((item, index) => [item.id, index < 3])),
        supplies: Object.fromEntries(DUTY_SUPPLY_ITEMS.map((item, index) => [item.id, index < 10 ? 'sufficient' : null])) }],
    bulletins: [{ _id: 'meeting', kind: 'meeting', title: '本學期 Meeting', schedule: '每週三 14:00–16:00', location: '討論室', published: true },
        { _id: 'notice-1', kind: 'announcement', title: '共用設備使用提醒', content: '使用完畢請清潔桌面，若設備異常請聯絡負責人。', published: true, priority: 'normal' }],
    routines: [{ _id: 'routine-1', name: '確認下週 Meeting 資料', next_due: '2026-09-10', category: '例行工作', interval_value: 1, interval_unit: 'month', visible_to_users: true }],
    accounting: [{ Txn_ID: 'A001', Type: 'Income', Amount: 12000, Payer: 'Fund', Fund_Source: 'Bank', Date: '2026-09-01', Description: '期初餘額' }],
    logs: [
        { Log_ID: 'L001', Instrument_ID: 'I001', Problem_Desc: '示範：量測讀值不穩定，已暫停使用', Solution: '等待廠商檢查訊號線', Owner_ID: 'preview-a', Status: 'Open', Urgency: 3, Date_Reported: '2026-09-03' },
        { Log_ID: 'L002', Instrument_ID: '區域環境', Problem_Desc: '示範：需請廠商確認量測區新增獨立電路的配置，預計安裝在純水設備旁。施工前請先與設備負責人確認動線及停機時間。', Solution: '', Owner_ID: 'preview-admin-a', Status: 'Open', Urgency: 2, Date_Reported: '2026-09-02' },
        { Log_ID: 'L003', Instrument_ID: 'I001', Problem_Desc: '示範：開機後出現異常聲響，請暫停使用並張貼告示。', Solution: '已聯絡廠商，等待安排到場檢查。\n檢修期間請使用其他設備。', Owner_ID: 'preview-b', Status: 'Open', Urgency: 5, Date_Reported: '2026-09-01' },
        { Log_ID: 'L004', Instrument_ID: '區域環境', Problem_Desc: '示範：回收區照明故障', Solution: '已更換燈管並確認照明正常。', Owner_ID: 'preview-a', Status: 'Closed', Urgency: 1, Date_Reported: '2026-08-28', Date_Resolved: '2026-08-29' }
    ],
    projects: [
        { _id: 'project-a', name: '薄膜材料研究（示範）', project_number: 'DEMO-01', project_code: 'A01', start_month: '2026-08', end_month: '2027-07', status: 'active', color_key: 'blue', semester_budgets: { '115-1': { available: 90000 } } },
        { _id: 'project-b', name: '設備維護計畫（示範）', project_number: 'DEMO-02', project_code: 'B02', start_month: '2026-08', end_month: '2027-01', status: 'active', color_key: 'teal', semester_budgets: { '115-1': { available: 10000 } } },
        { _id: 'project-c', name: '產學合作研究（示範）', project_number: 'DEMO-03', project_code: 'C03', start_month: '2026-08', end_month: '2027-07', status: 'active', color_key: 'amber' },
        { _id: 'project-d', name: '跨領域材料分析（示範）', project_number: 'DEMO-04', project_code: 'D04', start_month: '2026-08', end_month: '2027-07', status: 'active', color_key: 'violet' }
    ],
    employments: [
        { _id: 'employment-a', student_id: 'preview-a', project_id: 'project-a', declared_start_month: '2026-08', declared_end_month: '2027-01', average_start_month: '2026-08', average_end_month: '2027-01', base_monthly_amount: 8000, month_overrides: { '2026-09': { amount: 0, reason: '示範停聘一個月' } }, schema_version: 2 },
        { _id: 'employment-b', student_id: 'preview-b', project_id: 'project-a', declared_start_month: '2026-08', declared_end_month: '2027-01', average_start_month: '2026-08', average_end_month: '2027-01', base_monthly_amount: 10000, month_overrides: {}, schema_version: 2 },
        { _id: 'employment-c', student_id: 'preview-a', project_id: 'project-b', declared_start_month: '2026-10', declared_end_month: '2027-01', average_start_month: '2026-08', average_end_month: '2027-01', base_monthly_amount: 4000, month_overrides: {}, schema_version: 2 },
        { _id: 'employment-d', student_id: 'preview-a', project_id: 'project-c', declared_start_month: '2026-09', declared_end_month: '2027-01', average_start_month: '2026-09', average_end_month: '2027-01', base_monthly_amount: 6000, month_overrides: {}, schema_version: 2, remark: '示範：期末確認續聘' },
        { _id: 'employment-e', student_id: 'preview-a', project_id: 'project-d', declared_start_month: '2026-11', declared_end_month: '2027-01', average_start_month: '2026-11', average_end_month: '2027-01', base_monthly_amount: 7000, month_overrides: {}, schema_version: 2 }
    ]
};
if (new URLSearchParams(location.search).get('empty') === '1') { fixtures.projects = []; fixtures.employments = []; }
export const db = {}, auth = {}, provider = {};
export const collection = (_db, path) => ({ path });
export const doc = (_db, ...parts) => ({ path: parts.join('/'), isDoc: true });
export const where = (field, op, value) => ({ field, op, value });
export const query = (source, ...filters) => ({ ...source, filters });
const refreshers = new Set();
document.addEventListener('click', event => {
    if (event.target.id === 'preview-inventory-toggle') {
        fixtures.inventory[0].IsOpen = !fixtures.inventory[0].IsOpen;
        event.target.textContent = fixtures.inventory[0].IsOpen ? '關閉盤點（預覽）' : '開啟盤點（預覽）';
        [...refreshers].forEach(refresh => refresh());
    }
    if (event.target.id === 'preview-refresh') [...refreshers].forEach(refresh => refresh());
});
export function onSnapshot(source, optionsOrNext, maybeNext) {
    const next = typeof optionsOrNext === 'function' ? optionsOrNext : maybeNext;
    let live = true;
    const refresh = () => {
        if (!live) return;
        const [name, id] = source.path.split('/');
        let rows = fixtures[name] || [];
        if (source.filters) rows = rows.filter(row => source.filters.every(filter => row[filter.field] === filter.value));
        const snapshots = rows.map(row => ({ id: row._id || row.Student_ID || row.Property_ID || row.Instrument_ID || row.Txn_ID,
            data: () => ({ ...row }), exists: () => true, metadata: { fromCache: false } }));
        next(source.isDoc ? snapshots.find(item => item.id === id) || { exists: () => false, data: () => undefined, metadata: { fromCache: false } } : { docs: snapshots });
    };
    refreshers.add(refresh);
    queueMicrotask(refresh);
    return () => { live = false; refreshers.delete(refresh); };
}
export const onAuthStateChanged = (_auth, next) => { queueMicrotask(() => next(user)); return () => {}; };
const denyWrite = async () => { throw new Error('這是本地假資料預覽，儲存功能停用。'); };
export const getDoc = denyWrite, setDoc = denyWrite, updateDoc = denyWrite, deleteDoc = denyWrite;
export const runTransaction = denyWrite, signInWithPopup = denyWrite, signOut = denyWrite;
export const writeBatch = () => ({ set() {}, update() {}, delete() {}, commit: denyWrite });
export const arrayUnion = (...items) => items;
export const deleteField = () => 'preview-delete-field';
