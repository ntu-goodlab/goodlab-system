import { compareMembersForDirectory } from './member-directory.js';

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 取得台北時間所屬週的星期一，避免午夜到早上八點被 UTC 算到前一天。 */
export function getDutyWeekId(date = Date.now()) {
    const instant = new Date(date);
    const taipei = new Date(instant.getTime() + TAIPEI_OFFSET_MS);
    const day = taipei.getUTCDay();
    const daysFromMonday = day === 0 ? 6 : day - 1;
    taipei.setUTCDate(taipei.getUTCDate() - daysFromMonday);

    const year = taipei.getUTCFullYear();
    const month = String(taipei.getUTCMonth() + 1).padStart(2, '0');
    const dayOfMonth = String(taipei.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${dayOfMonth}`;
}

/** 值日順序與成員頁一致：在學、非 Admin 碩士生，依入學日期由早到晚。 */
export function getDutyRoster(members = []) {
    return members
        .filter(member => member.Degree === 'Master' && member.Role !== 'Admin' && member.Status === 'Active')
        .sort(compareMembersForDirectory);
}

export function hasDutyProgress(record) {
    if (!record) return false;
    return Boolean(
        String(record.note || '').trim()
        || record.substitute_pending
        || record.assignment_source === 'substitute'
        || Object.values(record.cleaning || {}).some(Boolean)
        || Object.values(record.supplies || {}).some(Boolean)
    );
}

export function canAutoCarryOver(record) {
    if (!record) return true;
    return !record.submitted
        && (record.assignment_source || 'auto') === 'auto'
        && !hasDutyProgress(record);
}

/** 只有首次快照已完成且 Firestore 確認文件不存在時，才能建立空白週清單。 */
export function canInitializeDutyWeek(loadState, recordExists) {
    return loadState === 'loaded' && !recordExists;
}
