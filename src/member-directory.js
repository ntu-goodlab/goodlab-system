export const MEMBER_GROUPS = [
    { key: 'phd', label: '博士班', className: 'is-phd' },
    { key: 'master', label: '碩士班', className: 'is-master' },
    { key: 'other', label: '其他在學成員', className: 'is-other' },
    { key: 'alumni', label: '已畢業／離校', className: 'is-alumni' }
];

export function memberGroupKey(member) {
    if (member.Status === 'Alumni') return 'alumni';
    if (member.Degree === 'PhD') return 'phd';
    if (member.Degree === 'Master') return 'master';
    return 'other';
}

function enrollmentTimestamp(value) {
    if (!value) return Number.POSITIVE_INFINITY;

    if (typeof value?.toDate === 'function') {
        const timestamp = value.toDate().getTime();
        return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
    }

    const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

export function compareMembersForDirectory(a, b) {
    const groupRank = Object.fromEntries(MEMBER_GROUPS.map((group, index) => [group.key, index]));
    const leftGroup = memberGroupKey(a);
    const rightGroup = memberGroupKey(b);
    const groupDifference = groupRank[leftGroup] - groupRank[rightGroup];
    if (groupDifference) return groupDifference;

    if (leftGroup === 'alumni') {
        const alumniDegreeRank = { PhD: 0, Master: 1, Bachelor: 2 };
        const degreeDifference = (alumniDegreeRank[a.Degree] ?? 3) - (alumniDegreeRank[b.Degree] ?? 3);
        if (degreeDifference) return degreeDifference;
    }

    const leftEnrollment = enrollmentTimestamp(a.Enrollment_Date);
    const rightEnrollment = enrollmentTimestamp(b.Enrollment_Date);
    if (leftEnrollment !== rightEnrollment) return leftEnrollment < rightEnrollment ? -1 : 1;

    return String(a.Student_ID || '').localeCompare(String(b.Student_ID || ''), 'en', {
        numeric: true,
        sensitivity: 'base'
    });
}
