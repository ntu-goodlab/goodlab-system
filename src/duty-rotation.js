import { getDutyRoster } from './duty-schedule.js';

export function dutyRotationRoster(members) {
    const ids = getDutyRoster(members).map(m => m.Student_ID);
    return { first: ids[0] || '', successors: Object.fromEntries(ids.map((id, i) => [id, ids[(i + 1) % ids.length]])) };
}

export const sameDutyRoster = (a, b) => a?.first === b.first
    && Object.keys(a.successors || {}).length === Object.keys(b.successors).length
    && Object.entries(b.successors).every(([id, next]) => a.successors[id] === next);

export function nextDutyAssignment(rotation, previous) {
    const original = previous?.scheduled_to || previous?.assigned_to || '';
    const carry = previous && !previous.submitted && previous.status !== 'carried_over'
        && Object.hasOwn(rotation.successors, original);
    const assigned = carry ? original : rotation.successors[original] || rotation.first;
    if (!assigned) throw new Error('目前沒有在學碩班值日成員。');
    return { assigned_to: assigned, scheduled_to: assigned, assignment_source: carry ? 'carryover' : 'auto',
        carried_from: carry ? rotation.week : null, carryover_count: carry ? Number(previous.carryover_count || 0) + 1 : 0 };
}
