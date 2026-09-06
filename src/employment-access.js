import { doc, updateDoc, setDoc, deleteField } from 'firebase/firestore';

export function employmentOverrideUpdates(original, next) {
    const updates = {};
    for (const month of new Set([...Object.keys(original), ...Object.keys(next)])) {
        if (JSON.stringify(original[month]) === JSON.stringify(next[month])) continue;
        updates[`month_overrides.${month}`] = Object.hasOwn(next, month) ? next[month] : deleteField();
    }
    return updates;
}

export async function saveEmploymentMonthAdjustment(db, employment, month, amount, reason) {
    // Update just this month. Returning to the base amount must remove its override.
    return updateDoc(doc(db, 'employments', employment._id), {
        schema_version: 2,
        declared_start_month: employment.declared_start_month,
        declared_end_month: employment.declared_end_month,
        base_monthly_amount: employment.base_monthly_amount,
        average_start_month: employment.average_start_month,
        average_end_month: employment.average_end_month,
        [`month_overrides.${month}`]: amount === employment.base_monthly_amount
            ? deleteField() : { amount, reason, updated_at: new Date().toISOString() },
        updated_at: new Date().toISOString()
    });
}

export async function saveProjectDetails(db, id, payload, existing, semester, budget) {
    const ref = doc(db, 'projects', id);
    if (!existing) return setDoc(ref, payload);
    const { semester_budgets, created_at, ...fields } = payload;
    return updateDoc(ref, {
        ...fields,
        [`semester_budgets.${semester}`]: budget === null
            ? deleteField() : { available: budget, updated_at: payload.updated_at }
    });
}
