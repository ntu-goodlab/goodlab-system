import { doc, getDocFromServer, runTransaction, Timestamp } from 'firebase/firestore';
import { assistanceWindow } from './duty-assistance-state.js';
import { nextDutyAssignment, sameDutyRoster } from './duty-rotation.js';

// Only administrators maintain roster order; ordinary members may advance the
// cursor only to this Taipei week and exactly as validated by Firestore Rules.
export async function syncDutyRotationRoster(db, roster, anchorWeek) {
    return runTransaction(db, async tx => {
        const ref = doc(db, 'duty_rotation/current'), snapshot = await tx.get(ref);
        if (!snapshot.exists()) {
            tx.set(ref, { ...roster, week: anchorWeek || null,
                week_start_at: anchorWeek ? Timestamp.fromMillis(assistanceWindow(anchorWeek).start) : null });
        } else if (!sameDutyRoster(snapshot.data(), roster)) {
            tx.update(ref, roster);
        }
    });
}

export async function advanceDutyRotation(db, week, buildRecord) {
    const start = assistanceWindow(week).start;
    try { return await runTransaction(db, async tx => {
        const stateRef = doc(db, 'duty_rotation/current'), stateSnap = await tx.get(stateRef);
        if (!stateSnap.exists()) throw new Error('自動輪值名單尚未初始化，請聯絡管理員。');
        const state = stateSnap.data(), ref = doc(db, 'duty_records', week), current = await tx.get(ref);
        if (state.week === week && current.exists()) return current.data();
        if (state.week && state.week >= week) throw new Error('輪值週次已變更，請重新整理。');
        const assignment = await tx.get(doc(db, 'duty_assignments', week));
        const previousRef = state.week ? doc(db, 'duty_records', state.week) : null;
        const previous = previousRef ? (await tx.get(previousRef)).data() : null;
        if (previousRef && !previous) throw new Error('上一週輪值紀錄缺漏，請聯絡管理員。');
        let result = current.data();
        if (!current.exists()) {
            const plan = assignment.exists() ? assignment.data() : nextDutyAssignment(state, previous);
            result = buildRecord(week, plan.scheduled_to, plan.assignment_source, { ...plan, cleaning: {}, supplies: {} });
            tx.set(ref, result);
            if (!assignment.exists()) tx.set(doc(db, 'duty_assignments', week), {
                assigned_to: plan.assigned_to, scheduled_to: plan.scheduled_to,
                assignment_source: plan.assignment_source, carried_from: plan.carried_from || null });
            if (!assignment.exists() && plan.carried_from) tx.update(previousRef, {
                status: 'carried_over', carried_over_to: week, updated_at: new Date().toISOString() });
        }
        tx.update(stateRef, { week, week_start_at: Timestamp.fromMillis(start) });
        return result;
    }); } catch (error) {
        // A concurrent create can fail rule evaluation before the transaction
        // retries. Only accept a server-confirmed winner; never relax writes.
        if (error.code !== 'permission-denied') throw error;
        const [state, current] = await Promise.all([
            getDocFromServer(doc(db, 'duty_rotation/current')), getDocFromServer(doc(db, 'duty_records', week))]);
        if (state.exists() && state.data().week === week && current.exists()) return current.data();
        throw error;
    }
}
