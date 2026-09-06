export function applyEmploymentMonthDrafts(original, fields, activeMonths, baseAmount) {
    const overrides = { ...original };
    const errors = [];
    for (const month of activeMonths) {
        const field = fields[month];
        if (!field) continue;
        const text = String(field.amount).trim();
        const amount = Number(text);
        if (text === '' || amount === baseAmount) {
            delete overrides[month];
            continue;
        }
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(amount)) {
            errors.push({ month, message: '金額須為 0 以上的整數' });
            continue;
        }
        const reason = String(field.reason || '').trim();
        const previous = original[month];
        const previousAmount = typeof previous === 'object' ? previous?.amount : previous;
        const previousReason = typeof previous === 'object' ? previous?.reason || '' : '';
        if (!reason && (previousAmount !== amount || previousReason !== reason)) {
            errors.push({ month, message: '請填寫調整原因' });
        }
        overrides[month] = previousAmount === amount && previousReason === reason
            ? previous : { amount, reason, updated_at: new Date().toISOString() };
    }
    return { overrides, errors };
}
