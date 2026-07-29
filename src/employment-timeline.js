export const PROJECT_COLOR_OPTIONS = [
    { key: 'amber', label: '橘色' },
    { key: 'blue', label: '藍色' },
    { key: 'violet', label: '紫色' },
    { key: 'teal', label: '青綠色' },
    { key: 'rose', label: '玫紅色' },
    { key: 'sky', label: '天藍色' },
    { key: 'lime', label: '草綠色' },
    { key: 'slate', label: '灰藍色' }
];

const PROJECT_COLOR_KEYS = new Set(PROJECT_COLOR_OPTIONS.map(option => option.key));

function stableHash(value) {
    let hash = 0;
    for (const character of String(value || '')) {
        hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
    }
    return Math.abs(hash);
}

export function resolveProjectColorKey(project = {}) {
    if (PROJECT_COLOR_KEYS.has(project.color_key)) return project.color_key;
    const seed = project._id || project.project_code || project.project_number || project.name || 'project';
    return PROJECT_COLOR_OPTIONS[stableHash(seed) % PROJECT_COLOR_OPTIONS.length].key;
}

export function buildScheduleSegments(schedule = {}, visibleMonths = []) {
    const segments = [];
    let current = null;

    visibleMonths.forEach((month, index) => {
        const amount = schedule[month];
        const active = amount !== undefined && Number(amount) > 0;

        if (!active) {
            if (current) {
                segments.push(current);
                current = null;
            }
            return;
        }

        if (!current) {
            current = {
                startIndex: index,
                endIndex: index,
                months: []
            };
        }
        current.endIndex = index;
        current.months.push({ month, amount: Number(amount) || 0 });
    });

    if (current) segments.push(current);
    return segments;
}

function semesterMonths(academicYear, term) {
    const startYear = term === 1 ? academicYear + 1911 : academicYear + 1912;
    const startMonth = term === 1 ? 8 : 2;
    const startIndex = startYear * 12 + startMonth - 1;
    return Array.from({ length: 6 }, (_, offset) => {
        const index = startIndex + offset;
        const year = Math.floor(index / 12);
        const month = index % 12 + 1;
        return `${year}-${String(month).padStart(2, '0')}`;
    });
}

export function buildEmploymentExportWindow(academicYear, term) {
    const first = term === 2
        ? { academicYear, term: 2 }
        : { academicYear: academicYear - 1, term: 2 };
    const second = { academicYear: first.academicYear + 1, term: 1 };
    const semesters = [first, second].map(semester => ({
        ...semester,
        months: semesterMonths(semester.academicYear, semester.term)
    }));

    return {
        semesters,
        months: semesters.flatMap(semester => semester.months)
    };
}
