import { getDutyWeekId } from './duty-schedule.js';
export const stampMillis = value => value?.toMillis?.() ?? (typeof value === 'string' ? Date.parse(value) : NaN);
export const sameStamp = (a, b) => Number.isFinite(stampMillis(a)) && stampMillis(a) === stampMillis(b);
export function assistanceWindow(week) {
    const start = Date.parse(`${week}T00:00:00+08:00`);
    if (!Number.isFinite(start) || getDutyWeekId(start) !== week) throw new Error('值日週次不正確。');
    return { start, end: start + 7 * 86400000 };
}
export function assistanceState(invite, record, people = [], now = Date.now()) {
    if (invite.status !== 'pending') return invite.status;
    if (now >= stampMillis(invite.expires_at)) return 'expired';
    if (!record || record.submitted || record.status !== 'pending'
        || record.assist_request !== invite._id || (record.assignment_revision || 0) !== invite.revision
        || record.assigned_to !== invite.from_student) return 'invalidated';
    const source = people.find(p => p.Student_ID === invite.from_student);
    const target = people.find(p => p.Student_ID === invite.to_student);
    if (!source || !target || source.Status !== 'Active' || target.Status !== 'Active'
        || !sameStamp(source.duty_access_at, invite.from_access_at)
        || !sameStamp(target.duty_access_at, invite.to_access_at)) return 'invalidated';
    return 'pending';
}
