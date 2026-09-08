import { approvedAccessEnabled } from './access-mode.js';
import * as legacy from './member-access.js';
import { saveApprovedMember, revokeApprovedMembership, syncApprovedMemberTransfer } from './approved-member-access.js';
export const saveMemberAccess = (db, id, payload, actorUid) => {
    if (!approvedAccessEnabled) return legacy.saveMemberAccess(db, id, payload, actorUid);
    const { Student_ID, ...fields } = payload;
    return saveApprovedMember(db, id, fields, actorUid);
};
export const unbindMemberAccess = (db, id, actorUid) => approvedAccessEnabled
    ? revokeApprovedMembership(db, id, actorUid) : legacy.unbindMemberAccess(db, id, actorUid);
export const deleteMemberAccess = (db, id, actorUid) => approvedAccessEnabled
    ? revokeApprovedMembership(db, id, actorUid, { deleteMember: true }) : legacy.deleteMemberAccess(db, id, actorUid);
export const syncMemberAdminRegistry = (transaction, db, before, after, now, actorUid) => approvedAccessEnabled
    ? syncApprovedMemberTransfer(transaction, db, before, after, actorUid)
    : legacy.syncMemberAdminRegistry(transaction, db, before, after, now);
