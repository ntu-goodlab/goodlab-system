import { doc, runTransaction, serverTimestamp, Timestamp } from 'firebase/firestore';
import { assistanceWindow, assistanceState } from './duty-assistance-state.js';
const id = value => { if (typeof value !== 'string' || !value || value.length > 128 || value.includes('/')) throw new Error('身分或邀請格式不正確。'); return value; };

export async function inviteDutyAssistance(db, { requestId, week, fromStudent, toStudent, note = '' }) {
    [requestId, week, fromStudent, toStudent].forEach(id);
    if (fromStudent === toStudent) throw new Error('不能邀請自己代做。');
    if (note.length > 500) throw new Error('交接事項最多 500 字。');
    const window = assistanceWindow(week);
    return runTransaction(db, async tx => {
        const ref = doc(db, 'duty_records', week), req = doc(db, 'duty_requests', requestId);
        const record = await tx.get(ref);
        const source = await tx.get(doc(db, 'member_directory', fromStudent));
        const target = await tx.get(doc(db, 'member_directory', toStudent));
        // New IDs are generated once per dialog; a lost response is resolved by
        // rereading the own outgoing query, never by creating another invitation.
        const r = record.data();
        if (!r || r.status !== 'pending' || r.submitted || r.assigned_to !== fromStudent) throw new Error('本週負責人或完成狀態已變更，請重新確認。');
        if (!source.data()?.duty_access_at || !target.data()?.duty_access_at || target.data().Status !== 'Active') throw new Error('對方目前尚未具備代做資格。');
        tx.set(req, { week, from_student: fromStudent, to_student: toStudent,
            from_name: source.data().Name_Ch, to_name: target.data().Name_Ch,
            from_access_at: source.data().duty_access_at, to_access_at: target.data().duty_access_at,
            revision: r.assignment_revision || 0, status: 'pending', note,
            created_at: serverTimestamp(), week_start_at: Timestamp.fromMillis(window.start),
            expires_at: Timestamp.fromMillis(window.end) });
        tx.update(ref, { assist_request: requestId });
        return requestId;
    });
}

export async function respondDutyAssistance(db, { requestId, action, studentId, adminCancel = false }) {
    [requestId, studentId].forEach(id);
    if (!['accepted', 'declined', 'cancelled'].includes(action)) throw new Error('邀請操作不正確。');
    return runTransaction(db, async tx => {
        const req = doc(db, 'duty_requests', requestId), snapshot = await tx.get(req);
        if (!snapshot.exists()) throw new Error('邀請已不存在。');
        const invite = { ...snapshot.data(), _id: requestId };
        if (action === 'cancelled' ? studentId !== invite.from_student && !adminCancel : studentId !== invite.to_student) throw new Error('只有邀請當事人可以執行此操作。');
        if (invite.status === action) return action;
        if (invite.status !== 'pending') throw new Error('邀請已處理，請查看最新結果。');
        const ref = doc(db, 'duty_records', invite.week), record = await tx.get(ref);
        const source = await tx.get(doc(db, 'member_directory', invite.from_student));
        const target = await tx.get(doc(db, 'member_directory', invite.to_student));
        if (action === 'accepted' && assistanceState(invite, record.data(), [source.data(), target.data()].filter(Boolean)) !== 'pending') throw new Error('邀請已過期或人員／排班已變更，無法接受。');
        tx.update(req, { status: action, responded_at: serverTimestamp() });
        if (action === 'accepted') {
            const r = record.data();
            tx.update(ref, { assigned_to: invite.to_student, assignment_source: 'substitute',
                substitute_from: invite.from_student, assist_request: null,
                assignment_revision: (r.assignment_revision || 0) + 1, assist_event: requestId });
            tx.set(doc(db, 'duty_assignments', invite.week), { assigned_to: invite.to_student,
                scheduled_to: r.scheduled_to, assignment_source: 'substitute', carried_from: r.carried_from || null });
            tx.set(doc(db, 'duty_events', requestId), { week: invite.week, kind: 'accepted',
                from_student: invite.from_student, to_student: invite.to_student,
                from_name: invite.from_name, to_name: invite.to_name, at: serverTimestamp() });
        }
        return action;
    });
}
