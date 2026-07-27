/**
 * GOODLAB — 學生聘僱模組
 *
 * v2 資料模型（舊欄位仍可讀取）：
 * projects/{id}: {
 *   name, project_number, project_code, start_month, end_month, status,
 *   semester_budgets: { "115-1": { available, updated_at } }
 * }
 * employments/{id}: {
 *   student_id, project_id,
 *   declared_start_month, declared_end_month, base_monthly_amount,
 *   month_overrides: { "2026-11": { amount, reason, updated_at } },
 *   average_start_month, average_end_month, remark, schema_version
 * }
 */
import { db, doc, setDoc, writeBatch } from './firebase.js';
import { generateId } from './utils.js';

const ROC_OFFSET = 1911;
const EMPLOYMENT_VIEWS = ['people', 'projects'];
const EMPLOYMENT_PEOPLE_VIEWS = ['list', 'timeline'];
const MIN_PROJECT_MONTHLY_AMOUNT = 6000;

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
}

function toInteger(value, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function formatMoney(value) {
    return `$${Math.round(Number(value) || 0).toLocaleString('zh-TW')}`;
}

function scrollToEditor(id, block = 'start') {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block
    }));
}

function monthKeyToIndex(key) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) return null;
    return year * 12 + month - 1;
}

function indexToMonthKey(index) {
    const year = Math.floor(index / 12);
    const month = index % 12 + 1;
    return `${year}-${String(month).padStart(2, '0')}`;
}

function rocMonthToKey(rocYear, month) {
    const year = toInteger(rocYear);
    const monthNumber = toInteger(month);
    if (year < 1 || monthNumber < 1 || monthNumber > 12) return '';
    return `${year + ROC_OFFSET}-${String(monthNumber).padStart(2, '0')}`;
}

function monthKeyToRocParts(key) {
    const index = monthKeyToIndex(key);
    if (index === null) return null;
    const year = Math.floor(index / 12);
    return { year: year - ROC_OFFSET, month: index % 12 + 1 };
}

function formatRocMonth(key) {
    const parts = monthKeyToRocParts(key);
    return parts ? `${parts.year}.${parts.month}` : '-';
}

function normalizeMonthKey(value) {
    if (!value) return '';
    const text = String(value).trim();
    const gregorian = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(text);
    if (gregorian) return `${gregorian[1]}-${String(Number(gregorian[2])).padStart(2, '0')}`;
    const roc = /^(\d{2,3})[./](\d{1,2})$/.exec(text);
    if (roc) return rocMonthToKey(Number(roc[1]), Number(roc[2]));
    return '';
}

function parseStudentIdForSort(value) {
    const normalized = String(value || '').trim().toUpperCase();
    const match = /^([A-Z]+)(\d{2,3})/.exec(normalized);
    const prefix = match?.[1] || '';
    const rawYear = match?.[2] || '';
    const parsedYear = Number(rawYear);
    const admissionYear = Number.isFinite(parsedYear)
        ? (rawYear.length === 2 ? parsedYear + 100 : parsedYear)
        : Number.POSITIVE_INFINITY;

    return {
        normalized,
        prefix,
        admissionYear,
        group: prefix === 'F' ? 0 : 1
    };
}

function compareStudentIds(a, b) {
    const left = parseStudentIdForSort(a);
    const right = parseStudentIdForSort(b);

    return left.group - right.group
        || left.prefix.localeCompare(right.prefix, 'en', { sensitivity: 'base' })
        || left.admissionYear - right.admissionYear
        || left.normalized.localeCompare(right.normalized, 'en', { numeric: true, sensitivity: 'base' });
}

function parseLegacyPeriod(period) {
    if (!period) return null;
    const parts = String(period).trim().split(/\s*(?:-|–|—|~|～|至)\s*/);
    if (parts.length !== 2) return null;
    const start = normalizeMonthKey(parts[0]);
    const end = normalizeMonthKey(parts[1]);
    return start && end ? { start, end } : null;
}

function monthRange(startKey, endKey) {
    const start = monthKeyToIndex(startKey);
    const end = monthKeyToIndex(endKey);
    if (start === null || end === null || end < start) return [];
    return Array.from({ length: end - start + 1 }, (_, offset) => indexToMonthKey(start + offset));
}

function rangesOverlap(startKey, endKey, months) {
    const range = new Set(monthRange(startKey, endKey));
    return months.some(month => range.has(month));
}

function currentSemester() {
    const now = new Date();
    const rocYear = now.getFullYear() - ROC_OFFSET;
    const month = now.getMonth() + 1;
    if (month >= 8) return { academicYear: rocYear, term: 1 };
    if (month === 1) return { academicYear: rocYear - 1, term: 1 };
    return { academicYear: rocYear - 1, term: 2 };
}

function semesterKey(academicYear, term) {
    return `${academicYear}-${term}`;
}

function semesterLabel(academicYear, term) {
    return `${academicYear} 學年度第${term === 1 ? '一' : '二'}學期`;
}

function getSemesterMonths(academicYear, term) {
    const startYear = term === 1 ? academicYear + ROC_OFFSET : academicYear + ROC_OFFSET + 1;
    const startMonth = term === 1 ? 8 : 2;
    const startIndex = startYear * 12 + startMonth - 1;
    return Array.from({ length: 6 }, (_, offset) => indexToMonthKey(startIndex + offset));
}

function shiftSemester(academicYear, term, direction) {
    if (direction > 0) return term === 1
        ? { academicYear, term: 2 }
        : { academicYear: academicYear + 1, term: 1 };
    return term === 2
        ? { academicYear, term: 1 }
        : { academicYear: academicYear - 1, term: 2 };
}

function normalizeEmployment(raw) {
    const legacy = parseLegacyPeriod(raw.period);
    const declaredStart = normalizeMonthKey(raw.declared_start_month) || legacy?.start || '';
    const declaredEnd = normalizeMonthKey(raw.declared_end_month) || legacy?.end || declaredStart;
    const averageStart = normalizeMonthKey(raw.average_start_month) || declaredStart;
    const averageEnd = normalizeMonthKey(raw.average_end_month) || declaredEnd;
    const baseAmount = Math.max(0, toInteger(raw.base_monthly_amount ?? raw.hire_salary ?? raw.actual_monthly));
    const overrides = raw.month_overrides && typeof raw.month_overrides === 'object' ? raw.month_overrides : {};

    return {
        ...raw,
        declared_start_month: declaredStart,
        declared_end_month: declaredEnd,
        average_start_month: averageStart,
        average_end_month: averageEnd,
        base_monthly_amount: baseAmount,
        month_overrides: overrides
    };
}

function normalizeProject(raw) {
    const legacyEnd = normalizeMonthKey(raw.end_date);
    return {
        ...raw,
        project_number: raw.project_number || '',
        project_code: raw.project_code || '',
        start_month: normalizeMonthKey(raw.start_month),
        end_month: normalizeMonthKey(raw.end_month) || legacyEnd,
        status: raw.status || 'active',
        semester_budgets: raw.semester_budgets && typeof raw.semester_budgets === 'object' ? raw.semester_budgets : {}
    };
}

function projectCurrentState(raw, referenceDate = new Date()) {
    const project = normalizeProject(raw);
    const referenceMonth = `${referenceDate.getFullYear()}-${String(referenceDate.getMonth() + 1).padStart(2, '0')}`;
    const currentIndex = monthKeyToIndex(referenceMonth);
    const startIndex = monthKeyToIndex(project.start_month);
    const endIndex = monthKeyToIndex(project.end_month);

    if (project.status === 'archived') {
        return { key: 'ended', label: '已封存', icon: 'ph-archive', rank: 2 };
    }
    if (startIndex === null || endIndex === null) {
        return { key: 'undated', label: '未設定期限', icon: 'ph-minus-circle', rank: 1 };
    }
    if (currentIndex < startIndex) {
        return { key: 'upcoming', label: '尚未開始', icon: 'ph-calendar-dots', rank: 0 };
    }
    if (currentIndex > endIndex) {
        return { key: 'ended', label: '已結束', icon: 'ph-check-circle', rank: 2 };
    }
    return { key: 'active', label: '進行中', icon: 'ph-play-circle', rank: 0 };
}

function formatProjectPeriod(project) {
    if (project.start_month && project.end_month) {
        return `${formatRocMonth(project.start_month)}～${formatRocMonth(project.end_month)}`;
    }
    if (project.start_month) return `${formatRocMonth(project.start_month)} 起`;
    if (project.end_month) return `至 ${formatRocMonth(project.end_month)}`;
    return '未設定';
}

function declaredSchedule(employment) {
    const normalized = normalizeEmployment(employment);
    const schedule = {};
    monthRange(normalized.declared_start_month, normalized.declared_end_month).forEach(month => {
        const override = normalized.month_overrides[month];
        const overrideAmount = typeof override === 'object' ? override.amount : override;
        schedule[month] = Number.isFinite(Number(overrideAmount))
            ? Math.max(0, toInteger(overrideAmount))
            : normalized.base_monthly_amount;
    });
    return schedule;
}

function declaredTotal(employment) {
    return Object.values(declaredSchedule(employment)).reduce((sum, amount) => sum + amount, 0);
}

function averageSchedule(employment) {
    const normalized = normalizeEmployment(employment);
    const months = monthRange(normalized.average_start_month, normalized.average_end_month);
    if (!months.length) return {};
    const total = declaredTotal(normalized);
    const base = Math.floor(total / months.length);
    const remainder = total - base * months.length;
    return Object.fromEntries(months.map((month, index) => [
        month,
        base + (index === months.length - 1 ? remainder : 0)
    ]));
}

function getSemesterBudget(project, key) {
    const entry = normalizeProject(project).semester_budgets[key];
    const value = typeof entry === 'object' ? entry?.available : entry;
    return value === '' || value === null || value === undefined ? null : Number(value);
}

function formatAverageSummary(employment) {
    const values = Object.values(averageSchedule(employment));
    if (!values.length) return '-';
    const first = values[0];
    const last = values[values.length - 1];
    return first === last
        ? `${formatMoney(first)} × ${values.length} 個月`
        : `${formatMoney(first)} × ${values.length - 1}，尾月 ${formatMoney(last)}`;
}

function formatMonthlyRange(values) {
    const amounts = values.map(value => Math.max(0, toInteger(value)));
    if (!amounts.length) return '-';
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    return min === max ? `${formatMoney(min)}／月` : `${formatMoney(min)}～${formatMoney(max)}／月`;
}

function formatSemesterAverageSummary(values) {
    const paid = values.filter(value => Number(value) > 0);
    if (!paid.length) return '$0／月';
    const range = formatMonthlyRange(paid);
    return paid.length === values.length ? range : `${range}（${paid.length}/${values.length} 個月）`;
}

function scheduleValuesInMonths(schedule, months, includeMissing = false) {
    return months
        .filter(month => includeMissing || schedule[month] !== undefined)
        .map(month => schedule[month] ?? 0);
}

function lowDeclaredMonths(employment, months) {
    const schedule = declaredSchedule(employment);
    return months.filter(month => schedule[month] > 0 && schedule[month] < MIN_PROJECT_MONTHLY_AMOUNT);
}

function monthOptions(selectedMonth) {
    return Array.from({ length: 12 }, (_, index) => {
        const month = index + 1;
        return `<option value="${month}" ${month === selectedMonth ? 'selected' : ''}>${month} 月</option>`;
    }).join('');
}

function renderRocMonthField(prefix, label, value, options = {}) {
    const parts = monthKeyToRocParts(value) || { year: '', month: 1 };
    const optional = options.optional ? '（選填）' : '';
    const previewHandler = options.previewHandler ? `oninput="${options.previewHandler}"` : '';
    return `<fieldset class="form-group roc-month-field">
        <legend>${escapeHtml(label)}${optional}</legend>
        <div class="roc-month-controls">
            <label class="sr-only" for="${prefix}-year">${escapeHtml(label)}民國年</label>
            <div class="input-with-suffix"><input type="number" id="${prefix}-year" min="1" max="999" value="${parts.year}" ${options.required ? 'required' : ''} ${previewHandler}><span>年</span></div>
            <label class="sr-only" for="${prefix}-month">${escapeHtml(label)}月份</label>
            <select id="${prefix}-month" ${previewHandler}>${monthOptions(parts.month)}</select>
        </div>
    </fieldset>`;
}

export const employmentUtils = {
    averageSchedule,
    compareStudentIds,
    currentSemester,
    declaredSchedule,
    declaredTotal,
    formatAverageSummary,
    formatRocMonth,
    getSemesterMonths,
    monthRange,
    normalizeEmployment,
    normalizeProject,
    projectCurrentState,
    parseStudentIdForSort,
    semesterKey,
    semesterLabel,
    shiftSemester
};

export const employmentModule = {
    empView: 'people',
    empPeopleView: 'list',
    empAmountMode: 'average',
    empAcademicYear: null,
    empTerm: null,
    employmentPersonEditorOpen: false,
    employmentPersonId: '',
    employmentPersonDrafts: [],
    expandedEmploymentPeople: [],
    projectEditorOpen: false,
    projectEditId: null,
    empMonthEditor: null,

    _ensureEmploymentState: function() {
        if (!EMPLOYMENT_VIEWS.includes(this.empView)) this.empView = 'people';
        if (!EMPLOYMENT_PEOPLE_VIEWS.includes(this.empPeopleView)) this.empPeopleView = 'list';
        if (this.empAcademicYear === null || this.empTerm === null) {
            const semester = currentSemester();
            this.empAcademicYear = semester.academicYear;
            this.empTerm = semester.term;
        }
    },

    _employmentData: function() {
        return (this.data.employments || []).map(normalizeEmployment);
    },

    _projectData: function() {
        return (this.data.projects || []).map(normalizeProject);
    },

    _semesterMonths: function() {
        return getSemesterMonths(this.empAcademicYear, this.empTerm);
    },

    _semesterKey: function() {
        return semesterKey(this.empAcademicYear, this.empTerm);
    },

    renderEmployment: function() {
        const container = document.getElementById('employment-content');
        if (!container) return;

        if (this.currentRole !== 'Admin') {
            container.innerHTML = '<div class="empty-state"><i class="ph-fill ph-lock-key" aria-hidden="true"></i>此頁面僅限 Admin 檢視</div>';
            return;
        }

        this._ensureEmploymentState();
        const tabs = [
            ['people', 'ph-users-three', '人員聘僱'],
            ['projects', 'ph-folder-simple', '計畫']
        ].map(([view, icon, label]) => `<button type="button" class="employment-tab ${this.empView === view ? 'active' : ''}" onclick="app.setEmploymentView('${view}')" ${this.empView === view ? 'aria-current="page"' : ''}>
            <i class="ph ${icon}" aria-hidden="true"></i>${label}
        </button>`).join('');

        let content = '';
        if (this.empView === 'projects') content = this._renderProjectsView();
        else content = this._renderPeopleView();

        container.innerHTML = `
            <div class="employment-header">
                <div><h2>學生聘僱</h2><p>依學期查看人員平均月薪、各計畫聘僱金額與業務費。</p></div>
                <button type="button" class="btn btn-secondary btn-sm" onclick="app.exportEmploymentExcel()"><i class="ph ph-download-simple" aria-hidden="true"></i> 匯出</button>
            </div>
            <nav class="employment-tabs" aria-label="學生聘僱子頁面">${tabs}</nav>
            ${this._renderSemesterNavigator()}
            <div class="employment-view">${content}</div>`;

        if (this.employmentPersonEditorOpen) this.updateEmploymentPersonPreviews();
    },

    _renderSemesterNavigator: function() {
        const months = this._semesterMonths();
        return `<div class="semester-navigator" aria-label="學期切換">
            <button type="button" class="btn btn-secondary btn-sm" onclick="app.changeEmploymentSemester(-1)" aria-label="上一學期"><i class="ph ph-caret-left" aria-hidden="true"></i></button>
            <div class="semester-label"><strong>${semesterLabel(this.empAcademicYear, this.empTerm)}</strong><span>${formatRocMonth(months[0])}～${formatRocMonth(months[months.length - 1])}</span></div>
            <button type="button" class="btn btn-secondary btn-sm" onclick="app.changeEmploymentSemester(1)" aria-label="下一學期"><i class="ph ph-caret-right" aria-hidden="true"></i></button>
        </div>`;
    },

    setEmploymentView: function(view) {
        if (!EMPLOYMENT_VIEWS.includes(view)) return;
        if (this.employmentPersonEditorOpen && view !== 'people' && !confirm('離開人員聘僱會放棄尚未儲存的修改，確定要繼續嗎？')) return;
        if (view !== 'people') {
            this.employmentPersonEditorOpen = false;
            this.employmentPersonId = '';
            this.employmentPersonDrafts = [];
        }
        this.empView = view;
        this.empMonthEditor = null;
        this.renderEmployment();
    },

    setEmploymentPeopleView: function(view) {
        if (!EMPLOYMENT_PEOPLE_VIEWS.includes(view)) return;
        this.empPeopleView = view;
        this.empMonthEditor = null;
        this.renderEmployment();
    },

    changeEmploymentSemester: function(direction) {
        if (this.employmentPersonEditorOpen && !confirm('切換學期會放棄尚未儲存的聘僱修改，確定要繼續嗎？')) return;
        const next = shiftSemester(this.empAcademicYear, this.empTerm, direction);
        this.empAcademicYear = next.academicYear;
        this.empTerm = next.term;
        this.empMonthEditor = null;
        this.employmentPersonEditorOpen = false;
        this.employmentPersonId = '';
        this.employmentPersonDrafts = [];
        this.renderEmployment();
    },

    setEmploymentAmountMode: function(mode) {
        if (!['declared', 'average'].includes(mode)) return;
        this.empAmountMode = mode;
        this.empMonthEditor = null;
        this.renderEmployment();
    },

    _semesterEmployments: function() {
        const months = this._semesterMonths();
        return this._employmentData().filter(employment =>
            rangesOverlap(employment.declared_start_month, employment.declared_end_month, months)
            || rangesOverlap(employment.average_start_month, employment.average_end_month, months)
        );
    },

    _renderPeopleView: function() {
        const listActive = this.empPeopleView === 'list';
        const viewToggle = `<div class="employment-view-toggle" role="group" aria-label="人員聘僱檢視方式">
            <button type="button" class="btn-filter ${listActive ? 'active' : ''}" onclick="app.setEmploymentPeopleView('list')" aria-pressed="${listActive}"><i class="ph ph-list-dashes" aria-hidden="true"></i> 人員列表</button>
            <button type="button" class="btn-filter ${listActive ? '' : 'active'}" onclick="app.setEmploymentPeopleView('timeline')" aria-pressed="${!listActive}"><i class="ph ph-chart-bar-horizontal" aria-hidden="true"></i> 甘特圖</button>
        </div>`;

        const editor = this._renderEmploymentPersonEditor();
        const content = this.employmentPersonEditorOpen ? '' : (listActive ? this._renderPeopleListView() : this._renderTimelineView());
        const toolbarActions = this.employmentPersonEditorOpen ? '' : `<div class="employment-toolbar-actions">${viewToggle}<button type="button" class="btn btn-primary" onclick="app.openEmploymentPersonEditor()"><i class="ph ph-user-plus" aria-hidden="true"></i> 新增／編輯人員</button></div>`;
        return `<div class="employment-toolbar employment-people-toolbar">
                <div><h3>本學期聘僱人員</h3></div>
                ${toolbarActions}
            </div>
            ${editor}
            ${content}`;
    },

    _renderPeopleListView: function() {
        const months = this._semesterMonths();
        const projects = this._projectData();
        const grouped = new Map();
        this._semesterEmployments().forEach(employment => {
            if (!grouped.has(employment.student_id)) grouped.set(employment.student_id, []);
            grouped.get(employment.student_id).push(employment);
        });

        if (!grouped.size) {
            return '<div class="empty-state"><i class="ph ph-users" aria-hidden="true"></i>這個學期尚無聘僱人員</div>';
        }

        const membersById = new Map((this.data.members || []).map(member => [member.Student_ID, member]));
        const cards = [...grouped.entries()]
            .sort(([a], [b]) => compareStudentIds(a, b))
            .map(([studentId, records]) => {
                const member = membersById.get(studentId);
                const name = member?.Name_Ch || studentId;
                const monthlyTotals = Object.fromEntries(months.map(month => [month, 0]));
                records.forEach(employment => {
                    const schedule = averageSchedule(employment);
                    months.forEach(month => { monthlyTotals[month] += schedule[month] || 0; });
                });
                const projectCount = new Set(records.map(item => item.project_id)).size;
                const lowMonths = records.flatMap(record => lowDeclaredMonths(record, months));
                const warningCount = lowMonths.length;
                const expanded = this.expandedEmploymentPeople.includes(studentId);
                const detailsId = `employment-person-details-${escapeHtml(studentId)}`;

                const monthSummary = months.map(month => `<div><span>${formatRocMonth(month)}</span><strong>${formatMoney(monthlyTotals[month])}</strong></div>`).join('');
                const recordRows = records
                    .sort((a, b) => (projects.find(item => item._id === a.project_id)?.name || '').localeCompare(projects.find(item => item._id === b.project_id)?.name || '', 'zh-Hant'))
                    .map(employment => {
                        const project = projects.find(item => item._id === employment.project_id);
                        const projectName = project?.name || '未指定計畫';
                        const averageValues = scheduleValuesInMonths(averageSchedule(employment), months);
                        const warnings = lowDeclaredMonths(employment, months);
                        return `<div class="employment-person-record">
                            <div class="employment-person-record-title"><strong>${escapeHtml(projectName)}</strong>${employment.schema_version === 2 ? '' : '<span class="legacy-badge">舊格式</span>'}</div>
                            ${employment.original_student_id ? `<p class="employment-record-original-id">原始申報學號：${escapeHtml(employment.original_student_id)}</p>` : ''}
                            <dl>
                                <div><dt>申報聘僱期間</dt><dd>${formatRocMonth(employment.declared_start_month)}～${formatRocMonth(employment.declared_end_month)}</dd></div>
                                <div><dt>基本月額</dt><dd>${formatMoney(employment.base_monthly_amount)}</dd></div>
                                <div><dt>申報總額</dt><dd>${formatMoney(declaredTotal(employment))}</dd></div>
                                <div><dt>平均月薪對應期間</dt><dd>${formatRocMonth(employment.average_start_month)}～${formatRocMonth(employment.average_end_month)}</dd></div>
                                <div><dt>本學期平均月薪貢獻</dt><dd>${averageValues.length ? formatMonthlyRange(averageValues) : '本學期無平均月薪'}</dd></div>
                            </dl>
                            ${warnings.length ? `<p class="employment-min-warning"><i class="ph ph-warning" aria-hidden="true"></i>${warnings.map(formatRocMonth).join('、')} 低於每計畫每月 ${formatMoney(MIN_PROJECT_MONTHLY_AMOUNT)}</p>` : ''}
                            ${employment.remark ? `<p class="employment-record-remark">${escapeHtml(employment.remark)}</p>` : ''}
                        </div>`;
                    }).join('');

                return `<article class="employment-person-card ${warningCount ? 'has-warning' : ''}">
                    <button type="button" class="employment-person-summary" onclick="app.toggleEmploymentPerson('${escapeHtml(studentId)}')" aria-expanded="${expanded}" aria-controls="${detailsId}">
                        <span class="employment-person-identity"><i class="ph ph-user-circle" aria-hidden="true"></i><span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(studentId)}</small></span></span>
                        <span><small>本學期平均月薪</small><strong>${formatSemesterAverageSummary(Object.values(monthlyTotals))}</strong></span>
                        <span><small>聘僱計畫</small><strong>${projectCount} 個</strong></span>
                        <span class="employment-person-check ${warningCount ? 'warning' : 'ok'}"><small>最低金額檢查</small><strong>${warningCount ? `${warningCount} 個計畫月份需確認` : '正常'}</strong></span>
                        <i class="ph ph-caret-down employment-person-caret" aria-hidden="true"></i>
                    </button>
                    ${expanded ? `<div class="employment-person-details" id="${detailsId}">
                        <div class="employment-person-months" aria-label="${escapeHtml(name)}本學期各月平均月薪">${monthSummary}</div>
                        <div class="employment-person-records">${recordRows}</div>
                        <div class="employment-person-actions"><button type="button" class="btn btn-primary" onclick="app.openEmploymentPersonEditor('${escapeHtml(studentId)}')"><i class="ph ph-pencil-simple" aria-hidden="true"></i> 編輯此人聘僱</button></div>
                    </div>` : ''}
                </article>`;
            }).join('');

        return `<div class="employment-people-list">${cards}</div>`;
    },

    toggleEmploymentPerson: function(studentId) {
        this.expandedEmploymentPeople = this.expandedEmploymentPeople.includes(studentId)
            ? this.expandedEmploymentPeople.filter(id => id !== studentId)
            : [...this.expandedEmploymentPeople, studentId];
        this.renderEmployment();
    },

    _renderTimelineView: function() {
        const employments = this._employmentData();
        const projects = this._projectData();
        const visibleMonths = this._semesterMonths();
        const mode = this.empAmountMode;
        const grouped = new Map();

        employments.forEach(employment => {
            const overlaps = mode === 'declared'
                ? rangesOverlap(employment.declared_start_month, employment.declared_end_month, visibleMonths)
                : rangesOverlap(employment.average_start_month, employment.average_end_month, visibleMonths);
            if (!overlaps) return;
            if (!grouped.has(employment.student_id)) grouped.set(employment.student_id, []);
            grouped.get(employment.student_id).push(employment);
        });

        const modeToggle = `<div class="employment-mode-toggle" role="group" aria-label="時程金額模式">
            <button type="button" class="btn-filter ${mode === 'average' ? 'active' : ''}" onclick="app.setEmploymentAmountMode('average')">平均月薪</button>
            <button type="button" class="btn-filter ${mode === 'declared' ? 'active' : ''}" onclick="app.setEmploymentAmountMode('declared')">聘僱金額</button>
        </div>`;

        if (!grouped.size) {
            return `<div class="employment-timeline-controls">${modeToggle}</div>
                <div class="empty-state"><i class="ph ph-calendar-blank" aria-hidden="true"></i>這個學期沒有聘僱資料</div>`;
        }

        const headers = visibleMonths.map(month => `<th scope="col">${formatRocMonth(month)}</th>`).join('');
        let rows = '';

        [...grouped.entries()].sort(([a], [b]) => compareStudentIds(a, b)).forEach(([studentId, records]) => {
            const member = this.data.members.find(item => item.Student_ID === studentId);
            const name = member?.Name_Ch || studentId;
            const totals = Object.fromEntries(visibleMonths.map(month => [month, 0]));
            rows += `<tr class="employment-person-row"><th colspan="${visibleMonths.length + 1}" scope="rowgroup"><span><i class="ph ph-user" aria-hidden="true"></i>${escapeHtml(name)}</span><small>${escapeHtml(studentId)}</small></th></tr>`;

            records.sort((a, b) => a.project_id.localeCompare(b.project_id)).forEach(employment => {
                const project = projects.find(item => item._id === employment.project_id);
                const schedule = mode === 'declared' ? declaredSchedule(employment) : averageSchedule(employment);
                const projectName = project?.name || '未指定計畫';
                const cells = visibleMonths.map(month => {
                    if (schedule[month] === undefined) return '<td class="employment-month-empty">—</td>';
                    const amount = schedule[month];
                    totals[month] += amount;
                    if (mode === 'average') return `<td><span class="employment-month-value readonly" aria-label="${formatRocMonth(month)}平均月薪 ${amount} 元">${amount.toLocaleString('zh-TW')}</span></td>`;

                    const override = employment.month_overrides[month];
                    const adjusted = override !== undefined;
                    const belowMinimum = amount > 0 && amount < MIN_PROJECT_MONTHLY_AMOUNT;
                    const reason = typeof override === 'object' ? override.reason : '';
                    const stateLabel = [adjusted ? '已調整' : '', belowMinimum ? `低於 ${MIN_PROJECT_MONTHLY_AMOUNT.toLocaleString('zh-TW')}` : ''].filter(Boolean).join('／');
                    return `<td><button type="button" class="employment-month-value ${adjusted ? 'adjusted' : ''} ${belowMinimum ? 'below-minimum' : ''}" onclick="app.editEmploymentMonth('${employment._id}','${month}')" aria-label="編輯 ${escapeHtml(name)} ${escapeHtml(projectName)} ${formatRocMonth(month)}，目前 ${amount} 元${adjusted ? '，有單月調整' : ''}${belowMinimum ? `，低於最低聘僱金額 ${MIN_PROJECT_MONTHLY_AMOUNT} 元` : ''}" title="${belowMinimum ? `低於每計畫每月最低聘僱金額 ${formatMoney(MIN_PROJECT_MONTHLY_AMOUNT)}` : (adjusted ? `單月調整：${escapeHtml(reason || '未填原因')}` : '點擊編輯最終總額')}">${amount.toLocaleString('zh-TW')}${stateLabel ? `<span>${stateLabel}</span>` : ''}</button></td>`;
                }).join('');

                rows += `<tr><th scope="row" class="employment-project-cell"><span>${escapeHtml(projectName)}</span><small>${escapeHtml(employment.remark || '')}</small></th>${cells}</tr>`;
            });

            rows += `<tr class="employment-total-row"><th scope="row">${mode === 'declared' ? '本月聘僱合計' : '本月平均月薪'}</th>${visibleMonths.map(month => `<td>${totals[month] ? totals[month].toLocaleString('zh-TW') : '—'}</td>`).join('')}</tr>`;
        });

        return `<div class="employment-timeline-controls">${modeToggle}</div>
            <div class="employment-timeline-wrap" tabindex="0" role="region" aria-label="聘僱時程表，可左右及上下捲動"><table class="employment-timeline-table">
                <thead><tr><th scope="col">人員／計畫</th>${headers}</tr></thead>
                <tbody>${rows}</tbody>
            </table></div>
            ${this._renderMonthEditor()}`;
    },

    editEmploymentMonth: function(employmentId, month) {
        this.empAmountMode = 'declared';
        this.empMonthEditor = { employmentId, month };
        this.renderEmployment();
        scrollToEditor('employment-month-editor', 'nearest');
    },

    cancelEmploymentMonthEdit: function() {
        this.empMonthEditor = null;
        this.renderEmployment();
    },

    _renderMonthEditor: function() {
        if (!this.empMonthEditor) return '';
        const employment = this._employmentData().find(item => item._id === this.empMonthEditor.employmentId);
        if (!employment) return '';
        const project = this._projectData().find(item => item._id === employment.project_id);
        const member = this.data.members.find(item => item.Student_ID === employment.student_id);
        const override = employment.month_overrides[this.empMonthEditor.month];
        const amount = declaredSchedule(employment)[this.empMonthEditor.month] ?? employment.base_monthly_amount;
        const reason = typeof override === 'object' ? override.reason || '' : '';

        return `<section id="employment-month-editor" class="inline-editor" aria-labelledby="employment-month-editor-title">
            <div class="inline-editor-heading"><div><h3 id="employment-month-editor-title">編輯單月聘僱金額</h3><p>${escapeHtml(member?.Name_Ch || employment.student_id)}／${escapeHtml(project?.name || '未指定計畫')}／${formatRocMonth(this.empMonthEditor.month)}</p></div><button type="button" class="btn btn-secondary btn-sm" onclick="app.cancelEmploymentMonthEdit()">取消</button></div>
            <div class="inline-editor-grid compact">
                <div class="readonly-field"><span>基本月額</span><strong>${formatMoney(employment.base_monthly_amount)}</strong></div>
                <div class="form-group"><label for="employment-month-amount">該月最終總額</label><input type="number" id="employment-month-amount" min="0" step="1" value="${amount}" oninput="app.validateEmploymentMonthEdit()"></div>
                <div class="form-group wide"><label for="employment-month-reason">調整原因</label><input type="text" id="employment-month-reason" value="${escapeHtml(reason)}" placeholder="金額不同於基本月額時必填" oninput="app.validateEmploymentMonthEdit()"><div id="employment-month-error" class="form-error" role="alert"></div></div>
            </div>
            <div class="inline-editor-actions"><button type="button" class="btn btn-primary" id="btn-save-employment-month" onclick="app.saveEmploymentMonth()">儲存單月金額</button></div>
        </section>`;
    },

    validateEmploymentMonthEdit: function() {
        if (!this.empMonthEditor) return false;
        const employment = this._employmentData().find(item => item._id === this.empMonthEditor.employmentId);
        const amount = toInteger(document.getElementById('employment-month-amount')?.value, -1);
        const reason = document.getElementById('employment-month-reason')?.value.trim() || '';
        const error = document.getElementById('employment-month-error');
        let message = '';
        if (amount < 0) message = '金額必須是 0 以上的整數。';
        else if (employment && amount !== employment.base_monthly_amount && !reason) message = '金額不同於基本月額時，請填寫調整原因。';
        if (error) error.textContent = message;
        return !message;
    },

    saveEmploymentMonth: async function() {
        if (!this.empMonthEditor || !this.validateEmploymentMonthEdit()) return;
        const employment = this._employmentData().find(item => item._id === this.empMonthEditor.employmentId);
        if (!employment) return;
        const month = this.empMonthEditor.month;
        const amount = toInteger(document.getElementById('employment-month-amount').value);
        const reason = document.getElementById('employment-month-reason').value.trim();
        const overrides = { ...employment.month_overrides };
        if (amount === employment.base_monthly_amount) delete overrides[month];
        else overrides[month] = { amount, reason, updated_at: new Date().toISOString() };

        const button = document.getElementById('btn-save-employment-month');
        button.disabled = true;
        button.textContent = '儲存中...';
        try {
            await setDoc(doc(db, 'employments', employment._id), {
                schema_version: 2,
                declared_start_month: employment.declared_start_month,
                declared_end_month: employment.declared_end_month,
                base_monthly_amount: employment.base_monthly_amount,
                average_start_month: employment.average_start_month,
                average_end_month: employment.average_end_month,
                month_overrides: overrides,
                updated_at: new Date().toISOString()
            }, { merge: true });
            this.empMonthEditor = null;
            this.showNotification('單月金額已更新', 'success');
        } catch (error) {
            this.showNotification('儲存失敗：' + error.message, 'error');
            button.disabled = false;
            button.textContent = '儲存單月金額';
        }
    },

    _newEmploymentDraft: function(studentId = '') {
        const months = this._semesterMonths();
        return normalizeEmployment({
            student_id: studentId,
            project_id: '',
            declared_start_month: months[0],
            declared_end_month: months[months.length - 1],
            base_monthly_amount: 0,
            average_start_month: months[0],
            average_end_month: months[months.length - 1],
            month_overrides: {},
            remark: ''
        });
    },

    _draftsForPersonInSemester: function(studentId) {
        return this._semesterEmployments()
            .filter(employment => employment.student_id === studentId)
            .map(employment => ({ ...employment, month_overrides: { ...employment.month_overrides }, _delete: false }));
    },

    openEmploymentPersonEditor: function(studentId = '') {
        this.employmentPersonEditorOpen = true;
        this.employmentPersonId = studentId;
        const existing = studentId ? this._draftsForPersonInSemester(studentId) : [];
        this.employmentPersonDrafts = existing.length ? existing : [this._newEmploymentDraft(studentId)];
        this.renderEmployment();
        scrollToEditor('employment-person-editor');
    },

    changeEmploymentPersonEditorStudent: function(studentId) {
        this.employmentPersonId = studentId;
        const existing = studentId ? this._draftsForPersonInSemester(studentId) : [];
        this.employmentPersonDrafts = existing.length ? existing : [this._newEmploymentDraft(studentId)];
        this.renderEmployment();
        scrollToEditor('employment-person-editor', 'nearest');
    },

    cancelEmploymentPersonEditor: function() {
        this.employmentPersonEditorOpen = false;
        this.employmentPersonId = '';
        this.employmentPersonDrafts = [];
        this.renderEmployment();
    },

    _renderEmploymentPersonEditor: function() {
        if (!this.employmentPersonEditorOpen) return '';
        const activeMembers = (this.data.members || []).filter(member =>
            member.Status === 'Active' || member.Student_ID === this.employmentPersonId
        );
        const memberOptions = activeMembers
            .sort((a, b) => compareStudentIds(a.Student_ID, b.Student_ID))
            .map(member => `<option value="${escapeHtml(member.Student_ID)}" ${member.Student_ID === this.employmentPersonId ? 'selected' : ''}>${escapeHtml(member.Name_Ch)} (${escapeHtml(member.Student_ID)})</option>`)
            .join('');
        const projects = this._projectData();

        const cards = this.employmentPersonDrafts.map((employment, index) => {
            const project = projects.find(item => item._id === employment.project_id);
            if (employment._delete) {
                return `<div class="employment-draft-deleted">
                    <span><i class="ph ph-trash" aria-hidden="true"></i>${escapeHtml(project?.name || '未指定計畫')}將在儲存後刪除</span>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="app.toggleEmploymentDraftDelete(${index})">復原</button>
                </div>`;
            }

            const prefix = `employment-person-${index}`;
            const previewHandler = 'app.updateEmploymentPersonPreviews()';
            const projectOptions = projects
                .filter(item => item.status !== 'archived' || item._id === employment.project_id)
                .map(item => `<option value="${escapeHtml(item._id)}" ${item._id === employment.project_id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`)
                .join('');

            return `<fieldset class="employment-draft-card" data-employment-draft="${index}">
                <legend>計畫聘僱 ${index + 1}${employment.schema_version === 2 || !employment._id ? '' : '<span class="legacy-badge">舊格式</span>'}</legend>
                <div class="employment-draft-card-actions"><button type="button" class="btn btn-danger btn-sm" onclick="app.toggleEmploymentDraftDelete(${index})"><i class="ph ph-trash" aria-hidden="true"></i>${employment._id ? '標記刪除' : '移除此列'}</button></div>
                <div class="inline-editor-grid">
                    <div class="form-group wide"><label for="${prefix}-project">計畫</label><select id="${prefix}-project" onchange="app.updateEmploymentPersonPreviews()"><option value="">請選擇計畫</option>${projectOptions}</select></div>
                    ${renderRocMonthField(`${prefix}-declared-start`, '申報聘僱開始月份', employment.declared_start_month, { required: true, previewHandler })}
                    ${renderRocMonthField(`${prefix}-declared-end`, '申報聘僱結束月份', employment.declared_end_month, { required: true, previewHandler })}
                    <div class="form-group"><label for="${prefix}-base-amount">基本月額</label><input type="number" id="${prefix}-base-amount" min="1" step="1" value="${employment.base_monthly_amount || ''}" oninput="app.updateEmploymentPersonPreviews()"></div>
                    <div class="form-group"><label for="${prefix}-remark">備註（選填）</label><input type="text" id="${prefix}-remark" value="${escapeHtml(employment.remark || '')}"></div>
                    <div class="average-period-heading wide"><div><strong>平均月薪對應期間</strong><span>特殊計畫可與申報聘僱期間不同。</span></div><button type="button" class="btn btn-secondary btn-sm" onclick="app.copyEmploymentDraftPeriod(${index})">帶入申報期間</button></div>
                    ${renderRocMonthField(`${prefix}-average-start`, '對應開始月份', employment.average_start_month, { required: true, previewHandler })}
                    ${renderRocMonthField(`${prefix}-average-end`, '對應結束月份', employment.average_end_month, { required: true, previewHandler })}
                    <div id="${prefix}-preview" class="employment-draft-preview wide" aria-live="polite"></div>
                </div>
            </fieldset>`;
        }).join('');

        return `<section id="employment-person-editor" class="inline-editor employment-person-editor" aria-labelledby="employment-person-editor-title">
            <div class="inline-editor-heading"><div><h3 id="employment-person-editor-title">以人員為單位編輯聘僱</h3><p>同時比較並儲存此人在本學期相關的所有計畫聘僱。</p></div><button type="button" class="btn btn-secondary btn-sm" onclick="app.cancelEmploymentPersonEditor()">取消</button></div>
            <div class="form-group employment-person-select"><label for="employment-person-student">人員</label><select id="employment-person-student" onchange="app.changeEmploymentPersonEditorStudent(this.value)"><option value="">請選擇人員</option>${memberOptions}</select></div>
            <div id="employment-person-editor-summary" class="employment-person-editor-summary" aria-live="polite"></div>
            <div class="employment-draft-list">${cards}</div>
            <div id="employment-person-form-error" class="form-error" role="alert" tabindex="-1"></div>
            <div class="inline-editor-actions split"><button type="button" class="btn btn-secondary" onclick="app.addEmploymentPersonDraft()"><i class="ph ph-plus" aria-hidden="true"></i> 加入計畫聘僱</button><button type="button" class="btn btn-primary" id="btn-save-employment-person" onclick="app.saveEmploymentPerson()">儲存此人全部聘僱</button></div>
        </section>`;
    },

    _readRocMonth: function(prefix) {
        return rocMonthToKey(
            document.getElementById(`${prefix}-year`)?.value,
            document.getElementById(`${prefix}-month`)?.value
        );
    },

    _readEmploymentDraft: function(index, existing) {
        if (existing._delete) return existing;
        const prefix = `employment-person-${index}`;
        return normalizeEmployment({
            ...existing,
            student_id: this.employmentPersonId,
            project_id: document.getElementById(`${prefix}-project`)?.value || '',
            declared_start_month: this._readRocMonth(`${prefix}-declared-start`),
            declared_end_month: this._readRocMonth(`${prefix}-declared-end`),
            base_monthly_amount: Math.max(0, toInteger(document.getElementById(`${prefix}-base-amount`)?.value)),
            average_start_month: this._readRocMonth(`${prefix}-average-start`),
            average_end_month: this._readRocMonth(`${prefix}-average-end`),
            remark: document.getElementById(`${prefix}-remark`)?.value.trim() || ''
        });
    },

    _captureEmploymentPersonDrafts: function() {
        const personSelect = document.getElementById('employment-person-student');
        if (personSelect) this.employmentPersonId = personSelect.value;
        this.employmentPersonDrafts = this.employmentPersonDrafts.map((draft, index) => this._readEmploymentDraft(index, draft));
    },

    addEmploymentPersonDraft: function() {
        this._captureEmploymentPersonDrafts();
        this.employmentPersonDrafts.push(this._newEmploymentDraft(this.employmentPersonId));
        this.renderEmployment();
        scrollToEditor('employment-person-editor', 'nearest');
    },

    toggleEmploymentDraftDelete: function(index) {
        this._captureEmploymentPersonDrafts();
        const draft = this.employmentPersonDrafts[index];
        if (!draft) return;
        if (!draft._id) this.employmentPersonDrafts.splice(index, 1);
        else draft._delete = !draft._delete;
        if (!this.employmentPersonDrafts.length) this.employmentPersonDrafts.push(this._newEmploymentDraft(this.employmentPersonId));
        this.renderEmployment();
    },

    copyEmploymentDraftPeriod: function(index) {
        ['year', 'month'].forEach(part => {
            document.getElementById(`employment-person-${index}-average-start-${part}`).value = document.getElementById(`employment-person-${index}-declared-start-${part}`).value;
            document.getElementById(`employment-person-${index}-average-end-${part}`).value = document.getElementById(`employment-person-${index}-declared-end-${part}`).value;
        });
        this.updateEmploymentPersonPreviews();
    },

    updateEmploymentPersonPreviews: function() {
        if (!this.employmentPersonEditorOpen) return;
        const months = this._semesterMonths();
        const readableDrafts = this.employmentPersonDrafts.map((draft, index) => this._readEmploymentDraft(index, draft));
        const activeDrafts = readableDrafts.filter(draft => !draft._delete);
        const monthlyTotals = Object.fromEntries(months.map(month => [month, 0]));

        readableDrafts.forEach((draft, index) => {
            if (draft._delete) return;
            const preview = document.getElementById(`employment-person-${index}-preview`);
            const average = averageSchedule(draft);
            months.forEach(month => { monthlyTotals[month] += average[month] || 0; });
            const warnings = lowDeclaredMonths(draft, months);
            if (preview) preview.innerHTML = `<div><span>申報總額</span><strong>${formatMoney(declaredTotal(draft))}</strong></div><div><span>平均月薪</span><strong>${formatAverageSummary(draft)}</strong></div><div class="${warnings.length ? 'warning' : ''}"><span>最低金額檢查</span><strong>${warnings.length ? `${warnings.map(formatRocMonth).join('、')} 低於 ${formatMoney(MIN_PROJECT_MONTHLY_AMOUNT)}` : '正常'}</strong></div>`;
        });

        const summary = document.getElementById('employment-person-editor-summary');
        if (summary) summary.innerHTML = `<div class="employment-person-editor-summary-heading"><span>本學期合併平均月薪</span><strong>${formatMonthlyRange(Object.values(monthlyTotals))}</strong><small>${activeDrafts.length} 個計畫聘僱</small></div><div class="employment-person-months">${months.map(month => `<div><span>${formatRocMonth(month)}</span><strong>${formatMoney(monthlyTotals[month])}</strong></div>`).join('')}</div>`;
    },

    saveEmploymentPerson: async function() {
        this._captureEmploymentPersonDrafts();
        const errorRegion = document.getElementById('employment-person-form-error');
        const activeDrafts = this.employmentPersonDrafts.filter(draft => !draft._delete);
        let errorMessage = '';

        if (!this.employmentPersonId) errorMessage = '請先選擇人員。';
        else if (!activeDrafts.length) errorMessage = '至少需要保留一筆計畫聘僱。';
        else activeDrafts.some((draft, index) => {
            if (!draft.project_id) errorMessage = `第 ${index + 1} 筆尚未選擇計畫。`;
            else if (!draft.declared_start_month || !draft.declared_end_month || monthKeyToIndex(draft.declared_end_month) < monthKeyToIndex(draft.declared_start_month)) errorMessage = `第 ${index + 1} 筆申報聘僱期間不正確。`;
            else if (draft.base_monthly_amount <= 0) errorMessage = `第 ${index + 1} 筆基本月額必須大於 0。`;
            else if (!draft.average_start_month || !draft.average_end_month || monthKeyToIndex(draft.average_end_month) < monthKeyToIndex(draft.average_start_month)) errorMessage = `第 ${index + 1} 筆平均月薪對應期間不正確。`;
            return Boolean(errorMessage);
        });

        if (!errorMessage) {
            for (let i = 0; i < activeDrafts.length; i += 1) {
                for (let j = i + 1; j < activeDrafts.length; j += 1) {
                    if (activeDrafts[i].project_id !== activeDrafts[j].project_id) continue;
                    if (rangesOverlap(activeDrafts[i].declared_start_month, activeDrafts[i].declared_end_month, monthRange(activeDrafts[j].declared_start_month, activeDrafts[j].declared_end_month))) {
                        errorMessage = '同一人、同一計畫的申報聘僱月份不可重疊，請合併為一筆並使用單月調整。';
                        break;
                    }
                }
                if (errorMessage) break;
            }
        }

        if (errorMessage) {
            errorRegion.textContent = errorMessage;
            errorRegion.focus();
            return;
        }

        const button = document.getElementById('btn-save-employment-person');
        button.disabled = true;
        button.textContent = '儲存中...';
        const batch = writeBatch(db);
        const now = new Date().toISOString();

        this.employmentPersonDrafts.forEach(draft => {
            if (draft._delete) {
                if (draft._id) batch.delete(doc(db, 'employments', draft._id));
                return;
            }
            const id = draft._id || generateId('EMP');
            batch.set(doc(db, 'employments', id), {
                schema_version: 2,
                student_id: this.employmentPersonId,
                project_id: draft.project_id,
                declared_start_month: draft.declared_start_month,
                declared_end_month: draft.declared_end_month,
                base_monthly_amount: draft.base_monthly_amount,
                average_start_month: draft.average_start_month,
                average_end_month: draft.average_end_month,
                month_overrides: draft.month_overrides || {},
                remark: draft.remark || '',
                created_at: draft.created_at || now,
                updated_at: now
            }, { merge: true });
        });

        try {
            await batch.commit();
            const warningCount = activeDrafts.reduce((total, draft) => total + lowDeclaredMonths(draft, this._semesterMonths()).length, 0);
            this.employmentPersonEditorOpen = false;
            this.employmentPersonId = '';
            this.employmentPersonDrafts = [];
            this.showNotification(warningCount ? `聘僱已儲存；另有 ${warningCount} 個計畫月份低於 ${formatMoney(MIN_PROJECT_MONTHLY_AMOUNT)}，請再確認。` : '此人全部聘僱已儲存', warningCount ? 'warning' : 'success');
        } catch (error) {
            this.showNotification('儲存失敗：' + error.message, 'error');
            button.disabled = false;
            button.textContent = '儲存此人全部聘僱';
        }
    },

    _projectSpend: function(projectId, months = null) {
        const monthSet = months ? new Set(months) : null;
        return this._employmentData()
            .filter(employment => employment.project_id === projectId)
            .reduce((sum, employment) => sum + Object.entries(declaredSchedule(employment))
                .filter(([month]) => !monthSet || monthSet.has(month))
                .reduce((subtotal, [, amount]) => subtotal + amount, 0), 0);
    },

    _renderProjectsView: function() {
        const projects = this._projectData()
            .map(project => ({ ...project, _currentState: projectCurrentState(project) }))
            .sort((a, b) => {
                if (a._currentState.rank !== b._currentState.rank) return a._currentState.rank - b._currentState.rank;
                if (a._currentState.rank === 0 && a._currentState.key !== b._currentState.key) {
                    return a._currentState.key === 'active' ? -1 : 1;
                }
                if (a._currentState.rank === 2) {
                    const endDifference = (monthKeyToIndex(b.end_month) ?? -1) - (monthKeyToIndex(a.end_month) ?? -1);
                    if (endDifference) return endDifference;
                }
                return (a.name || '').localeCompare(b.name || '', 'zh-Hant');
            });
        const semester = this._semesterKey();
        const months = this._semesterMonths();
        const rows = projects.map(project => {
            const available = getSemesterBudget(project, semester);
            const semesterSpend = this._projectSpend(project._id, months);
            const totalSpend = this._projectSpend(project._id);
            const remaining = available === null ? null : available - semesterSpend;
            const state = project._currentState;
            return `<tr class="${state.rank === 2 ? 'is-ended' : ''}">
                <td><strong>${escapeHtml(project.name)}</strong></td>
                <td><span class="project-state-badge is-${state.key}"><i class="ph ${state.icon}" aria-hidden="true"></i>${state.label}</span></td>
                <td>${escapeHtml(project.project_number || '-')}</td>
                <td>${escapeHtml(project.project_code || '-')}</td>
                <td>${formatProjectPeriod(project)}</td>
                <td class="number-cell">${available === null ? '未設定' : formatMoney(available)}</td>
                <td class="number-cell">${formatMoney(semesterSpend)}</td>
                <td class="number-cell ${remaining !== null && remaining < 0 ? 'amount-neg' : ''}">${remaining === null ? '—' : formatMoney(remaining)}</td>
                <td class="number-cell">${formatMoney(totalSpend)}</td>
                <td><button type="button" class="btn btn-secondary btn-sm" onclick="app.openProjectEditor('${project._id}')"><i class="ph ph-pencil-simple" aria-hidden="true"></i> 編輯</button></td>
            </tr>`;
        }).join('');

        return `<div class="employment-toolbar"><div><h3>計畫</h3><p>業務費以目前選取學期為單位管理。</p></div><button type="button" class="btn btn-primary" onclick="app.openProjectEditor()"><i class="ph ph-plus" aria-hidden="true"></i> 新增計畫</button></div>
            ${this._renderProjectEditor()}
            <div class="table-container"><table class="project-management-table">
                <thead><tr><th>計畫</th><th>目前狀況</th><th>計畫編號</th><th>計畫代碼</th><th>計畫期間</th><th>本學期可用業務費</th><th>本學期聘僱支出</th><th>預計剩餘</th><th>累計聘僱支出</th><th>操作</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="10" class="empty">尚無計畫</td></tr>'}</tbody>
            </table></div>`;
    },

    openProjectEditor: function(id = null) {
        this.projectEditorOpen = true;
        this.projectEditId = id;
        this.renderEmployment();
        scrollToEditor('project-inline-editor');
    },

    cancelProjectEditor: function() {
        this.projectEditorOpen = false;
        this.projectEditId = null;
        this.renderEmployment();
    },

    _renderProjectEditor: function() {
        if (!this.projectEditorOpen) return '';
        const project = this.projectEditId
            ? this._projectData().find(item => item._id === this.projectEditId)
            : normalizeProject({ name: '', status: 'active', semester_budgets: {} });
        if (!project) return '';
        const budget = getSemesterBudget(project, this._semesterKey());

        return `<section id="project-inline-editor" class="inline-editor" aria-labelledby="project-editor-title">
            <div class="inline-editor-heading"><div><h3 id="project-editor-title">${this.projectEditId ? '編輯' : '新增'}計畫</h3><p>本學期業務費：${semesterLabel(this.empAcademicYear, this.empTerm)}</p></div><button type="button" class="btn btn-secondary btn-sm" onclick="app.cancelProjectEditor()">取消</button></div>
            <input type="hidden" id="project-edit-id" value="${this.projectEditId || ''}">
            <div class="inline-editor-grid">
                <div class="form-group"><label for="project-name">計畫名稱</label><input type="text" id="project-name" value="${escapeHtml(project.name || '')}" required></div>
                <div class="form-group"><label for="project-number">計畫編號</label><input type="text" id="project-number" value="${escapeHtml(project.project_number)}"></div>
                <div class="form-group"><label for="project-code">計畫代碼</label><input type="text" id="project-code" value="${escapeHtml(project.project_code)}"></div>
                <div class="form-group"><label for="project-semester-budget">本學期規劃前可用業務費（選填）</label><input type="number" id="project-semester-budget" min="0" step="1" value="${budget ?? ''}"></div>
                ${renderRocMonthField('project-start', '計畫開始月份', project.start_month, { optional: true })}
                ${renderRocMonthField('project-end', '計畫結束月份', project.end_month, { optional: true })}
                <div class="form-group"><label for="project-status">管理狀態</label><select id="project-status"><option value="active" ${project.status === 'active' ? 'selected' : ''}>使用中</option><option value="archived" ${project.status === 'archived' ? 'selected' : ''}>已封存</option></select><p class="form-help">進行中或已結束會依計畫期間自動判定。</p></div>
                <div id="project-form-error" class="form-error wide" role="alert"></div>
            </div>
            <div class="inline-editor-actions"><button type="button" class="btn btn-primary" id="btn-save-project" onclick="app.saveProject()">儲存計畫</button></div>
        </section>`;
    },

    saveProject: async function() {
        const editId = document.getElementById('project-edit-id').value;
        const id = editId || generateId('PRJ');
        const existing = editId ? this._projectData().find(item => item._id === editId) : null;
        const name = document.getElementById('project-name').value.trim();
        const start = this._readRocMonth('project-start');
        const end = this._readRocMonth('project-end');
        const budgetText = document.getElementById('project-semester-budget').value.trim();
        const errorRegion = document.getElementById('project-form-error');
        let errorMessage = '';
        if (!name) errorMessage = '請輸入計畫名稱。';
        else if (start && end && monthKeyToIndex(end) < monthKeyToIndex(start)) errorMessage = '計畫結束月份不得早於開始月份。';
        else if (budgetText && toInteger(budgetText, -1) < 0) errorMessage = '業務費不可為負數。';
        if (errorMessage) {
            errorRegion.textContent = errorMessage;
            return;
        }

        const budgets = { ...(existing?.semester_budgets || {}) };
        if (budgetText === '') delete budgets[this._semesterKey()];
        else budgets[this._semesterKey()] = { available: toInteger(budgetText), updated_at: new Date().toISOString() };
        const payload = {
            name,
            project_number: document.getElementById('project-number').value.trim(),
            project_code: document.getElementById('project-code').value.trim(),
            start_month: start || null,
            end_month: end || null,
            status: document.getElementById('project-status').value,
            semester_budgets: budgets,
            created_at: existing?.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        const button = document.getElementById('btn-save-project');
        button.disabled = true;
        button.textContent = '儲存中...';
        try {
            await setDoc(doc(db, 'projects', id), payload, { merge: true });
            this.projectEditorOpen = false;
            this.projectEditId = null;
            this.showNotification('計畫已儲存', 'success');
        } catch (error) {
            this.showNotification('儲存失敗：' + error.message, 'error');
            button.disabled = false;
            button.textContent = '儲存計畫';
        }
    },

    exportEmploymentExcel: function() {
        const employments = this._employmentData();
        const projects = this._projectData();
        if (!employments.length) {
            this.showNotification('沒有聘僱資料可匯出', 'warning');
            return;
        }

        const summaryRows = employments.map(employment => {
            const member = this.data.members.find(item => item.Student_ID === employment.student_id);
            const project = projects.find(item => item._id === employment.project_id);
            return {
                '學號': employment.original_student_id || employment.student_id,
                '姓名': member?.Name_Ch || '',
                '計畫名稱': project?.name || '',
                '計畫編號': project?.project_number || '',
                '計畫代碼': project?.project_code || '',
                '聘僱期間': `${formatRocMonth(employment.declared_start_month)}-${formatRocMonth(employment.declared_end_month)}`,
                '基本月額': employment.base_monthly_amount,
                '聘僱總額': declaredTotal(employment),
                '平均月薪對應期間': `${formatRocMonth(employment.average_start_month)}-${formatRocMonth(employment.average_end_month)}`,
                '平均月薪': formatAverageSummary(employment),
                '備註': employment.remark || ''
            };
        });

        const monthRows = [];
        employments.forEach(employment => {
            const member = this.data.members.find(item => item.Student_ID === employment.student_id);
            const project = projects.find(item => item._id === employment.project_id);
            const declared = declaredSchedule(employment);
            const average = averageSchedule(employment);
            const months = [...new Set([...Object.keys(declared), ...Object.keys(average)])].sort();
            months.forEach(month => {
                const override = employment.month_overrides[month];
                monthRows.push({
                    '學號': employment.original_student_id || employment.student_id,
                    '姓名': member?.Name_Ch || '',
                    '計畫名稱': project?.name || '',
                    '年月': formatRocMonth(month),
                    '聘僱金額': declared[month] ?? '',
                    '平均月薪': average[month] ?? '',
                    '單月調整原因': typeof override === 'object' ? override.reason || '' : ''
                });
            });
        });

        const projectRows = projects.map(project => {
            const available = getSemesterBudget(project, this._semesterKey());
            const spend = this._projectSpend(project._id, this._semesterMonths());
            return {
                '計畫名稱': project.name,
                '目前狀況': projectCurrentState(project).label,
                '計畫編號': project.project_number,
                '計畫代碼': project.project_code,
                '學期': semesterLabel(this.empAcademicYear, this.empTerm),
                '規劃前可用業務費': available ?? '',
                '本學期聘僱支出': spend,
                '預計剩餘': available === null ? '' : available - spend
            };
        });

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), '聘僱總表');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(monthRows), '月份明細');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(projectRows), '計畫業務費');
        XLSX.writeFile(workbook, `GOODLAB_聘僱_${this._semesterKey()}_${new Date().toISOString().split('T')[0]}.xlsx`);
        this.showNotification('Excel 已匯出', 'success');
    }
};
