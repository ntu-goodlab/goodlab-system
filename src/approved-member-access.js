// Transaction helpers for rules/member-approved.firestore.rules.
// Used only in the explicitly enabled approved access mode. Rules enforce authorization.
import { doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { approvalState } from './approval-state.js';

function requireId(value) {
    if (typeof value !== 'string' || !value || value.length > 128 || value.includes('/')) {
        throw new Error('帳號或學號格式不正確。');
    }
    return value;
}

export function memberDirectoryEntry(member) {
    return {
        Student_ID: member.Student_ID,
        Name_Ch: member.Name_Ch || '', Name_En: member.Name_En || '',
        Degree: member.Degree || '', Status: member.Status, Role: member.Role,
        Enrollment_Date: member.Enrollment_Date || ''
    };
}

// Await before any transaction writes; legacy bindings are never implicitly approved.
export async function syncApprovedMemberTransfer(transaction, db, before, after, actorUid) {
    requireId(actorUid);
    if (before?.Google_UID === actorUid) throw new Error('請由另一位管理員變更你的學號。');
    if (before.Google_UID) {
        const existing = await transaction.get(doc(db, 'member_access', before.Google_UID));
        if (!existing.exists() || existing.data().student_id !== before.Student_ID
            || existing.data().email !== before.Google_Email || existing.data().role !== before.Role) {
            throw new Error('原帳號尚未完成授權核對，不能透過學號轉移自動開通。');
        }
    }
    if (before.Google_UID && before.Google_UID !== after.Google_UID) {
        transaction.delete(doc(db, 'member_access', before.Google_UID));
    }
    if (after.Google_UID) {
        transaction.set(doc(db, 'member_access', after.Google_UID), {
            student_id: after.Student_ID, email: after.Google_Email, role: after.Role,
            approved_by: actorUid, approved_at: serverTimestamp()
        });
    }
    transaction.delete(doc(db, 'member_directory', before.Student_ID));
    transaction.set(doc(db, 'member_directory', after.Student_ID), memberDirectoryEntry(after));
}

// requestedStudentId is only a claim for an administrator to review.
export async function requestApprovedMembership(db, user, requestedStudentId) {
    const uid = requireId(user?.uid);
    const studentId = requireId(requestedStudentId);
    if (!user.emailVerified || !user.email) throw new Error('請先使用已驗證的 Google 帳號登入。');
    return runTransaction(db, async transaction => {
        const access = await transaction.get(doc(db, 'member_access', uid));
        if (access.exists()) throw new Error('此帳號已有授權紀錄，請聯絡管理員。');
        transaction.set(doc(db, 'access_requests', uid), {
            student_id: studentId, email: user.email,
            display_name: user.displayName || '', requested_at: serverTimestamp()
        });
    });
}

// The administrator reviews the immutable Auth UID and token-verified e-mail,
// not a user-entered e-mail field. A changed request must be reviewed again.
export async function approveMembershipRequest(db, { uid, studentId, expectedEmail, actorUid,
    expectedMemberStatus, reactivateInactive = false }) {
    [uid, studentId, actorUid].forEach(requireId);
    if (uid === actorUid) throw new Error('不能自行核准自己的權限。');
    return runTransaction(db, async transaction => {
        const memberRef = doc(db, 'members', studentId);
        const accessRef = doc(db, 'member_access', uid);
        const requestRef = doc(db, 'access_requests', uid);
        const member = await transaction.get(memberRef);
        const existing = await transaction.get(accessRef);
        const request = await transaction.get(requestRef);
        if (!member.exists() || !request.exists()) throw new Error('成員或申請已不存在，請重新核對。');
        if (existing.exists()) throw new Error('帳號已有授權，請重新整理後確認成員狀態。');
        const claimed = request.data();
        if (claimed.student_id !== studentId || claimed.email !== expectedEmail) {
            throw new Error('申請內容已變更，請重新核對學號與 Google 帳號。');
        }
        const before = member.data();
        const state = approvalState(before, { ...claimed, _id: uid });
        if (state.blocked) throw new Error(state.label);
        if (expectedMemberStatus !== undefined && before.Status !== expectedMemberStatus) {
            throw new Error('成員狀態已變更，請重新核對。');
        }
        if (state.reactivate && !(reactivateInactive && expectedMemberStatus === 'Alumni')) {
            throw new Error('此成員目前已離校，請明確確認恢復在學／在職狀態後再開通。');
        }
        // First approval always creates an ordinary member. Admin promotion is separate.
        const after = { ...before, Student_ID: studentId, Role: 'User', Status: 'Active',
            Google_UID: uid, Google_Email: claimed.email, Google_Display_Name: claimed.display_name };
        if (state.reactivate) {
            after.Previous_Leave_Dates = [...new Set([...(Array.isArray(before.Previous_Leave_Dates)
                ? before.Previous_Leave_Dates : []), before.Leave_Date].filter(Boolean))];
            after.Leave_Date = '';
        }
        transaction.set(memberRef, after);
        transaction.set(accessRef, { student_id: studentId, email: claimed.email, role: 'User',
            approved_by: actorUid, approved_at: serverTimestamp() });
        transaction.set(doc(db, 'member_directory', studentId), memberDirectoryEntry(after));
        transaction.delete(requestRef);
    });
}

// Ordinary profile edits do not touch authorization. Role changes update both
// sides in one transaction. There is no implicit approval of legacy UID bindings.
export async function saveApprovedMember(db, studentId, payload, actorUid) {
    [studentId, actorUid].forEach(requireId);
    if (['Google_UID', 'Google_Email', 'Google_Display_Name', 'Student_ID'].some(key => key in payload)) {
        throw new Error('Google 綁定與學號需使用專用的核准或轉移流程。');
    }
    return runTransaction(db, async transaction => {
        const ref = doc(db, 'members', studentId);
        const existing = await transaction.get(ref);
        const before = existing.exists() ? existing.data() : {};
        const after = { ...before, ...payload, Student_ID: studentId };
        if (!['User', 'Admin'].includes(after.Role) || !['Active', 'Alumni'].includes(after.Status)) {
            throw new Error('角色或在職／在學狀態不正確。');
        }
        let entry;
        if (before.Google_UID) {
            entry = await transaction.get(doc(db, 'member_access', before.Google_UID));
            if (!entry.exists()) {
                entry = null;
                if (after.Role === 'Admin') throw new Error('此 Google 帳號尚未核准，不能直接設為管理員。請先處理「帳號開通申請」，開通一般成員後再升權。');
            } else if (entry.data().student_id !== studentId || entry.data().email !== before.Google_Email
                || entry.data().role !== before.Role) {
                throw new Error('帳號授權與成員資料不一致，請先核對並解除原綁定後重新開通。');
            }
        }
        if (before.Google_UID === actorUid && (after.Role !== before.Role || after.Status !== before.Status)) {
            throw new Error('請由另一位管理員變更你的權限或停用狀態。');
        }
        if (after.Role === 'Admin' && !before.Google_UID) throw new Error('請先核准一般成員，再授予管理權限。');
        if (entry && after.Role !== before.Role) {
            if (after.Status !== 'Active') throw new Error('請先解除離校成員的授權。');
            transaction.set(entry.ref, { ...entry.data(), role: after.Role,
                approved_by: actorUid, approved_at: serverTimestamp() });
        }
        transaction.set(ref, after);
        transaction.set(doc(db, 'member_directory', studentId), memberDirectoryEntry(after));
        return { approved: Boolean(entry) };
    });
}

export async function revokeApprovedMembership(db, studentId, actorUid, { deleteMember = false } = {}) {
    [studentId, actorUid].forEach(requireId);
    return runTransaction(db, async transaction => {
        const ref = doc(db, 'members', studentId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists()) throw new Error('成員已不存在。');
        const before = snapshot.data();
        if (before.Google_UID === actorUid) throw new Error('請由另一位管理員撤銷你的權限。');
        // An unapproved legacy binding has no access document to delete.
        const entry = before.Google_UID ? await transaction.get(doc(db, 'member_access', before.Google_UID)) : null;
        if (entry?.exists() && entry.data().student_id !== studentId) {
            throw new Error('此帳號授權對應其他成員，請先核對重複綁定。');
        }
        if (entry?.exists()) transaction.delete(entry.ref);
        if (deleteMember) {
            transaction.delete(ref);
            transaction.delete(doc(db, 'member_directory', studentId));
        } else {
            const after = { ...before, Role: 'User', Google_UID: null, Google_Email: null, Google_Display_Name: null };
            for (const field of ['Google_UID', 'Google_Email', 'Google_Display_Name']) {
                const key = `Previous_${field}s`;
                after[key] = [...new Set([...(Array.isArray(before[key]) ? before[key] : []), before[field]].filter(Boolean))];
            }
            transaction.set(ref, after);
            transaction.set(doc(db, 'member_directory', studentId), memberDirectoryEntry(after));
        }
    });
}
