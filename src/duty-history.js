const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

function parseDateKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return { year, month, day, date };
}

export function shiftDutyDateKey(value, days) {
    const parsed = parseDateKey(value);
    if (!parsed) return String(value || '');
    parsed.date.setUTCDate(parsed.date.getUTCDate() + Number(days || 0));
    return [
        parsed.date.getUTCFullYear(),
        String(parsed.date.getUTCMonth() + 1).padStart(2, '0'),
        String(parsed.date.getUTCDate()).padStart(2, '0')
    ].join('-');
}

export function formatDutyHistoryDate(value, includeWeekday = false) {
    const parsed = parseDateKey(value);
    if (!parsed) return String(value || '日期未設定');
    const weekday = includeWeekday ? `（${WEEKDAY_LABELS[parsed.date.getUTCDay()]}）` : '';
    return `${parsed.year}/${parsed.month}/${parsed.day}${weekday}`;
}

export function formatDutyHistoryRange(weekId) {
    const start = parseDateKey(weekId);
    const endKey = shiftDutyDateKey(weekId, 6);
    const end = parseDateKey(endKey);
    if (!start || !end) return String(weekId || '日期未設定');
    const endLabel = start.year === end.year
        ? `${end.month}/${end.day}`
        : `${end.year}/${end.month}/${end.day}`;
    return `${start.year}/${start.month}/${start.day}–${endLabel}`;
}

export function formatDutyHistorySubmittedAt(value) {
    if (!value) return '未提交';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).map(part => [part.type, part.value]));
    const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
    return `${formatDutyHistoryDate(dateKey, true)} ${parts.hour}:${parts.minute}`;
}

export function getDutyHistoryStatus(record, currentWeekId) {
    if (record?.submitted || record?.status === 'submitted') {
        return { key: 'completed', label: '已完成', icon: 'ph-check-circle', className: 'completed' };
    }
    if (record?.carried_over_to || record?.status === 'carried_over') {
        return { key: 'incomplete', label: '未完成・已順延', icon: 'ph-arrow-bend-down-right', className: 'incomplete' };
    }
    if (String(record?._id || record?.week_start || '') < String(currentWeekId || '')) {
        return { key: 'incomplete', label: '未完成', icon: 'ph-warning-circle', className: 'incomplete' };
    }
    return { key: 'current', label: '進行中', icon: 'ph-clock', className: 'current' };
}

export function getVisibleDutyHistoryRecords(records = [], currentWeekId = '') {
    return records
        .filter(record => {
            const weekId = String(record?._id || record?.week_start || '');
            if (!weekId || weekId > currentWeekId) return false;
            return Boolean(record?.submitted || record?.status === 'submitted' || weekId < currentWeekId);
        })
        .sort((a, b) => String(b._id || b.week_start || '').localeCompare(String(a._id || a.week_start || '')));
}

export function getOrderedDutySupplyNames(supplies = {}, items = []) {
    return items.filter(item => supplies[item.id] === 'ordered').map(item => item.name);
}

export function hasLegacyDutySupplyData(supplies = {}, items = []) {
    return items.some(item => supplies[item.id] === true);
}
