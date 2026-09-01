import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DUTY_SUPPLY_STATUS_OPTIONS,
    isDutySupplyReadyForSubmit,
    isDutySupplyStatusSelected,
    normalizeDutySupplyStatus,
    summarizeDutySupplies
} from '../src/duty-supplies.js';

test('耗材狀態依實際處理流程排列', () => {
    assert.deepEqual(
        DUTY_SUPPLY_STATUS_OPTIONS.map(option => option.value),
        ['sufficient', 'needs_order', 'ordered']
    );
});

test('待叫貨可暫存但不可提交，舊版 true 保持相容且不猜測叫貨狀態', () => {
    assert.equal(normalizeDutySupplyStatus(true), 'legacy_checked');
    assert.equal(isDutySupplyStatusSelected('needs_order'), true);
    assert.equal(isDutySupplyReadyForSubmit('sufficient'), true);
    assert.equal(isDutySupplyReadyForSubmit('ordered'), true);
    assert.equal(isDutySupplyReadyForSubmit(true), true);
    assert.equal(isDutySupplyReadyForSubmit('needs_order'), false);
    assert.equal(isDutySupplyReadyForSubmit(false), false);
    assert.equal(isDutySupplyReadyForSubmit(null), false);
});

test('耗材摘要可區分已叫貨、待叫貨與未確認', () => {
    const items = [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
        { id: 'c', name: 'C' },
        { id: 'd', name: 'D' }
    ];
    const summary = summarizeDutySupplies({ a: true, b: 'ordered', c: 'needs_order', d: false }, items);
    assert.deepEqual(summary.legacy_checked.map(item => item.id), ['a']);
    assert.deepEqual(summary.ordered.map(item => item.id), ['b']);
    assert.deepEqual(summary.needs_order.map(item => item.id), ['c']);
    assert.deepEqual(summary.unconfirmed.map(item => item.id), ['d']);
});
