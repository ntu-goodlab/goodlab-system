// UI authorization must agree with the deployed rules. Legacy UID-only registry
// entries need a successful server permission check, never a role-only fallback.
export function resolveAdminAccess(member, uid, registry, legacyAccess = 'idle') {
    if (!uid || member?.Google_UID !== uid || member?.Role !== 'Admin') return 'user';
    if (!registry.loaded) return 'checking';
    if (registry.error) return 'lookup-error';
    if (!registry.entry) return 'missing';
    if (Object.hasOwn(registry.entry, 'student_id')) {
        return registry.entry.student_id === member.Student_ID ? 'authorized' : 'mismatch';
    }
    if (legacyAccess === 'allowed') return 'authorized';
    if (legacyAccess === 'denied') return 'legacy-denied';
    if (legacyAccess === 'error') return 'lookup-error';
    return 'legacy-check';
}
