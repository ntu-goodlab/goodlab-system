import { doc, runTransaction, serverTimestamp } from 'firebase/firestore';

export const dutyAssignmentFrom = record => ({ assigned_to: record.assigned_to,
    scheduled_to: record.scheduled_to, assignment_source: record.assignment_source,
    carried_from: record.carried_from || null });

// Existing records are never silently overwritten by initialization.
export async function initializeApprovedDuty(db, weekId, buildRecord) {
    return runTransaction(db, async tx => {
        const ref = doc(db, 'duty_records', weekId);
        const current = await tx.get(ref);
        const assignment = await tx.get(doc(db, 'duty_assignments', weekId));
        if (current.exists()) return current.data();
        if (!assignment.exists()) throw new Error('本週尚未由管理員確認排班。');
        const payload = buildRecord(assignment.data());
        tx.set(ref, payload); return payload;
    });
}

// Rules independently require a currently approved administrator for the assignment.
export async function saveApprovedDutyAssignment(db, weekId, payload, { carryFrom = null, replace = false,
    reason = '管理員確認排班', fromName = '', toName = '', eventId = crypto.randomUUID() } = {}) {
    return runTransaction(db, async tx => {
        const ref = doc(db, 'duty_records', weekId);
        const current = await tx.get(ref);
        const oldRef = carryFrom ? doc(db, 'duty_records', carryFrom) : null;
        const old = oldRef ? await tx.get(oldRef) : null;
        if (current.exists() && current.data().submitted) throw new Error('本週已提交，不能重新排班。');
        if (current.exists() && !replace) throw new Error('本週已有紀錄，請重新核對排班。');
        if (oldRef && (!old.exists() || old.data().submitted || old.data().status === 'carried_over'
            || (old.data().scheduled_to || old.data().assigned_to) !== payload.assigned_to || carryFrom >= weekId)) {
            throw new Error('原週狀態已變更，請重新核對順延。');
        }
        const before = current.exists() ? current.data() : null;
        // Preserve current work and immutable assistance history when reassigning.
        const after = before ? { ...before, scheduled_to: payload.scheduled_to,
            assigned_to: payload.assigned_to, assignment_source: payload.assignment_source,
            substitute_from: null, updated_at: payload.updated_at } : payload;
        after.assignment_revision = (before?.assignment_revision || 0) + 1;
        after.admin_event = eventId;
        tx.set(doc(db, 'duty_assignments', weekId), dutyAssignmentFrom(after));
        tx.set(ref, after);
        tx.set(doc(db, 'duty_events', eventId), { week: weekId, kind: 'admin_assignment',
            from_student: before?.assigned_to || '', to_student: after.assigned_to,
            from_name: fromName, to_name: toName, reason,
            actor_student: payload.created_by_student_id, at: serverTimestamp() });
        if (oldRef) tx.update(oldRef, { status: 'carried_over', carried_over_to: weekId, updated_at: new Date().toISOString() });
        return after;
    });
}
