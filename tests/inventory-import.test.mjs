import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInventoryRows } from '../src/inventory-import.js';
const row = { '財物編號': 'P01', '校號': 'A01', '財物名稱': '<b>Equipment</b>', '單價': '1,000' };
test('學校匯入不產生可覆蓋既有位置、備註、盤點狀態的欄位', () => {
    const [payload] = parseInventoryRows([row], [{ Property_ID: 'P01-A01-00', Location: '機房' }]);
    assert.equal(payload._isNew, false);
    assert.equal(payload.Price, 1000);
    assert.equal(Object.hasOwn(payload, 'Location'), false);
    assert.equal(Object.hasOwn(payload, 'Status'), false);
    assert.equal(payload.Name, '<b>Equipment</b>');
});
test('重複編號、不完整編號、無效金額在預覽前拒絕', () => {
    assert.throws(() => parseInventoryRows([row, row]), /重複/);
    assert.throws(() => parseInventoryRows([{ ...row, 校號: '' }]), /缺少/);
    assert.throws(() => parseInventoryRows([{ ...row, 單價: 'abc' }]), /單價/);
});
