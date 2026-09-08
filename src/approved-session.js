export function resolveApprovedIdentity(user, entry, member) {
    if (!user?.uid || !user.emailVerified || user.signInProvider !== 'google.com') return 'Guest';
    if (!entry || !member || !['User', 'Admin'].includes(entry.role)) return 'Guest';
    return entry.email === user.email && member.Google_Email === entry.email
        && member.Student_ID === entry.student_id && member.Google_UID === user.uid
        && member.Role === entry.role && member.Status === 'Active' ? entry.role : 'Guest';
}

// All callbacks are generation guarded. Old account/old document callbacks cannot
// repopulate data after logout, revocation, or a UID-to-member mapping change.
export function createApprovedSession({ watch, onState }) {
    let epoch = 0, memberEpoch = 0, stopAccess, stopMember;
    let identity, entry, profile, memberId;
    function emit(status, error = null) {
        const role = status === 'ready' ? resolveApprovedIdentity(identity, entry, profile) : 'Guest';
        onState({ status, error, role, uid: identity?.uid || null,
            entry: entry || null, member: role === 'Guest' ? null : profile });
    }
    function clearMember() {
        memberEpoch++; stopMember?.(); stopMember = null; profile = null; memberId = null;
    }
    return {
        start(user) {
            const current = ++epoch;
            stopAccess?.(); stopAccess = null; clearMember();
            identity = user; entry = null;
            if (!user) { emit('signed-out'); return; }
            emit('checking');
            if (!user.emailVerified || user.signInProvider !== 'google.com') { emit('unverified'); return; }
            stopAccess = watch(`member_access/${user.uid}`, snapshot => {
                if (current !== epoch) return;
                if (snapshot.metadata?.fromCache) { clearMember(); emit('checking'); return; }
                entry = snapshot.exists() ? snapshot.data() : null;
                if (!entry || typeof entry.student_id !== 'string' || !entry.student_id
                    || entry.student_id.includes('/') || entry.email !== user.email) {
                    clearMember(); emit('unapproved'); return;
                }
                if (memberId === entry.student_id) { emit('ready'); return; }
                clearMember(); memberId = entry.student_id;
                const ownEpoch = memberEpoch;
                emit('checking');
                stopMember = watch(`members/${memberId}`, memberSnapshot => {
                    if (current !== epoch || ownEpoch !== memberEpoch) return;
                    if (memberSnapshot.metadata?.fromCache) { profile = null; emit('checking'); return; }
                    profile = memberSnapshot.exists() ? memberSnapshot.data() : null;
                    emit('ready');
                }, error => {
                    if (current !== epoch || ownEpoch !== memberEpoch) return;
                    profile = null; emit('error', error.code || 'unknown');
                });
            }, error => {
                if (current !== epoch) return;
                entry = null; clearMember(); emit('error', error.code || 'unknown');
            });
        },
        stop() { this.start(null); }
    };
}
