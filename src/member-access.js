import { doc, runTransaction } from 'firebase/firestore';

// Called only inside an existing administrator's transaction. Rules remain the authority.
export function syncMemberAdminRegistry(transaction, db, before, after, now) {
    const oldUid = before?.Google_UID;
    const newUid = after?.Google_UID;
    if (after?.Role === 'Admin' && !newUid) {
        throw new Error('請先以一般成員完成 Google 綁定，核對帳號後再設為 Admin。');
    }
    if (oldUid && (oldUid !== newUid || after?.Role !== 'Admin')) {
        transaction.delete(doc(db, 'admins', oldUid));
    }
    if (after?.Role === 'Admin') {
        transaction.set(doc(db, 'admins', newUid), {
            student_id: after.Student_ID,
            registered_at: now
        });
    }
}

function preventSelfRevocation(before, after, actorUid) {
    if (!actorUid) throw new Error('無法確認操作者，請重新登入。');
    if (before?.Google_UID && before.Google_UID === actorUid
        && (after?.Google_UID !== actorUid || after?.Role !== 'Admin')) {
        throw new Error('不能在此撤銷自己的管理權限，請由另一位已授權管理員操作。');
    }
}

export async function saveMemberAccess(db, id, payload, actorUid) {
    return runTransaction(db, async transaction => {
        const ref = doc(db, 'members', id);
        const snapshot = await transaction.get(ref);
        const before = snapshot.exists() ? snapshot.data() : null;
        const after = { ...before, ...payload, Student_ID: id };
        if (!['User', 'Admin'].includes(after.Role)) throw new Error('成員角色不正確。');
        preventSelfRevocation(before, after, actorUid);
        syncMemberAdminRegistry(transaction, db, before, after, new Date().toISOString());
        transaction.set(ref, after);
    });
}

export async function unbindMemberAccess(db, id, actorUid) {
    return runTransaction(db, async transaction => {
        const ref = doc(db, 'members', id);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists()) throw new Error('成員資料已不存在。');
        const before = snapshot.data();
        const after = { ...before, Role: 'User' };
        for (const field of ['Google_UID', 'Google_Email', 'Google_Display_Name']) {
            const historyKey = `Previous_${field}s`;
            const history = Array.isArray(before[historyKey]) ? before[historyKey] : [];
            after[historyKey] = [...new Set([...history, before[field]].filter(Boolean))];
            after[field] = null;
        }
        preventSelfRevocation(before, after, actorUid);
        syncMemberAdminRegistry(transaction, db, before, after, new Date().toISOString());
        transaction.set(ref, after);
    });
}

export async function deleteMemberAccess(db, id, actorUid) {
    return runTransaction(db, async transaction => {
        const ref = doc(db, 'members', id);
        const snapshot = await transaction.get(ref);
        const before = snapshot.exists() ? snapshot.data() : null;
        preventSelfRevocation(before, null, actorUid);
        syncMemberAdminRegistry(transaction, db, before, null, new Date().toISOString());
        transaction.delete(ref);
    });
}
