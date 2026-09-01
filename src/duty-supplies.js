export const DUTY_SUPPLY_STATUS_OPTIONS = [
    { value: 'sufficient', label: '足夠', icon: 'ph-check-circle' },
    { value: 'needs_order', label: '待叫貨', icon: 'ph-warning-circle' },
    { value: 'ordered', label: '已叫貨', icon: 'ph-truck' }
];

const VALID_SUPPLY_STATUSES = new Set(DUTY_SUPPLY_STATUS_OPTIONS.map(option => option.value));

/** 舊版 true 只代表已完成清點，無法判斷當時是足夠或已叫貨。 */
export function normalizeDutySupplyStatus(value) {
    if (value === true) return 'legacy_checked';
    return VALID_SUPPLY_STATUSES.has(value) ? value : '';
}

export function isDutySupplyStatusSelected(value) {
    return Boolean(normalizeDutySupplyStatus(value));
}

/** 待叫貨只供暫存；實際叫貨並改為已叫貨後才能提交。 */
export function isDutySupplyReadyForSubmit(value) {
    return ['sufficient', 'ordered', 'legacy_checked'].includes(normalizeDutySupplyStatus(value));
}

export function summarizeDutySupplies(supplies = {}, items = []) {
    const summary = { sufficient: [], ordered: [], needs_order: [], legacy_checked: [], unconfirmed: [] };
    items.forEach(item => {
        const status = normalizeDutySupplyStatus(supplies[item.id]);
        if (status) summary[status].push(item);
        else summary.unconfirmed.push(item);
    });
    return summary;
}
