// Pure offline audit. No Firebase credentials, network, or writes.
export function planApprovedMigration({ members = [], authUsers = [], approvedUids = [] }) {
    const users = new Map(authUsers.map(user => [user.uid, user]));
    const counts = new Map();
    for (const member of members) if (member.Google_UID) counts.set(member.Google_UID, (counts.get(member.Google_UID) || 0) + 1);
    const approved = new Set(approvedUids);
    const rows = members.map(member => {
        const uid = member.Google_UID;
        const user = users.get(uid);
        const issues = [];
        if (!uid) issues.push('unbound');
        if (uid && counts.get(uid) > 1) issues.push('duplicate-uid');
        if (uid && !user) issues.push('auth-account-missing');
        if (user?.disabled) issues.push('auth-account-disabled');
        if (user && (!user.emailVerified || !user.providerData?.some(p => p.providerId === 'google.com'))) issues.push('unverified-google-account');
        if (user && !user.email) issues.push('missing-auth-email');
        if (member.Google_Email && user && member.Google_Email !== user.email) issues.push('email-mismatch');
        if (member.Status !== 'Active') issues.push('inactive-member');
        if (!['User', 'Admin'].includes(member.Role)) issues.push('invalid-role');
        if (!member.Student_ID || members.filter(m => m.Student_ID === member.Student_ID).length !== 1) issues.push('duplicate-or-missing-student-id');
        const eligible = issues.length === 0;
        return { studentId: member.Student_ID, uid: uid || null, email: user?.email || member.Google_Email || null,
            role: member.Role, issues, eligible,
            decision: !eligible ? 'needs-review' : approved.has(uid) ? 'confirmed' : 'awaiting-confirmation',
            fillMissingGoogleEmail: eligible && !member.Google_Email ? user.email : null };
    });
    const confirmed = rows.filter(row => row.decision === 'confirmed');
    return { rows, confirmed, readyForMigration: confirmed.some(row => row.role === 'Admin'),
        unknownApprovedUids: approvedUids.filter(uid => !rows.some(row => row.uid === uid)),
        note: '資料一致只代表可遷移候選。需管理員確認後才產生授權；此工具不執行遷移。' };
}
