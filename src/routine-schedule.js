/**
 * 實驗室行事的純日期計算。
 * 獨立於 Firebase，讓週期錨定規則可以直接測試。
 */

export const ROUTINE_UNIT_LABELS = { day: '天', month: '月', year: '年' };

export function toLocalDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function parseLocalDate(value) {
    if (!value) return null;
    const date = new Date(`${value}T12:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
}

export function getRoutineScheduleType(routine = {}) {
    return routine.schedule_type === 'one_time' ? 'one_time' : 'recurring';
}

export function getRoutineInterval(routine = {}) {
    const explicitValue = parseInt(routine.interval_value, 10);
    const explicitUnit = routine.interval_unit;
    if (explicitValue > 0 && ROUTINE_UNIT_LABELS[explicitUnit]) {
        return { value: explicitValue, unit: explicitUnit };
    }

    const legacyDays = Math.max(1, parseInt(routine.interval_days, 10) || 30);
    if (legacyDays % 365 === 0) return { value: legacyDays / 365, unit: 'year' };
    if (legacyDays % 30 === 0) return { value: legacyDays / 30, unit: 'month' };
    return { value: legacyDays, unit: 'day' };
}

export function routineIntervalToDays(value, unit) {
    if (unit === 'year') return value * 365;
    if (unit === 'month') return value * 30;
    return value;
}

/**
 * 從同一個排程錨點直接加上 N 個週期。
 * 例如 1/31 每月一次，第二個週期仍會得到 3/31，而不是從 2/28 漂移到 3/28。
 */
export function addRoutineInterval(dateValue, routine, multiplier = 1) {
    const date = dateValue instanceof Date ? new Date(dateValue) : parseLocalDate(dateValue);
    if (!date) return '';

    const { value, unit } = getRoutineInterval(routine);
    const step = Math.max(1, parseInt(multiplier, 10) || 1) * value;

    if (unit === 'day') {
        date.setDate(date.getDate() + step);
    } else if (unit === 'month') {
        const originalDay = date.getDate();
        date.setDate(1);
        date.setMonth(date.getMonth() + step);
        const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
        date.setDate(Math.min(originalDay, lastDay));
    } else {
        const originalMonth = date.getMonth();
        const originalDay = date.getDate();
        date.setDate(1);
        date.setFullYear(date.getFullYear() + step);
        date.setMonth(originalMonth);
        const lastDay = new Date(date.getFullYear(), originalMonth + 1, 0).getDate();
        date.setDate(Math.min(originalDay, lastDay));
    }

    return toLocalDateString(date);
}

/**
 * 完成週期性項目後，優先維持 schedule_anchor 作為固定排程錨點。
 * 舊資料尚未有 schedule_anchor 時，才沿用 next_due。
 * 若已落後多期，持續推進到第一個晚於實際完成日的日期，但不改變原本日／月節奏。
 */
export function calculateNextScheduledDue(routine, completedOn) {
    if (getRoutineScheduleType(routine) === 'one_time') return null;

    const completedDate = parseLocalDate(completedOn);
    if (!completedDate) return '';

    const anchor = routine.schedule_anchor || routine.next_due || routine.last_done || completedOn;
    let multiplier = 1;
    let candidate = addRoutineInterval(anchor, routine, multiplier);

    while (candidate && parseLocalDate(candidate) <= completedDate && multiplier < 10000) {
        multiplier += 1;
        candidate = addRoutineInterval(anchor, routine, multiplier);
    }

    return candidate;
}
