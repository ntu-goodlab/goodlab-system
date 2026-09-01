import test from 'node:test';
import assert from 'node:assert/strict';
import {
    formatDutyHistoryRange,
    formatDutyHistorySubmittedAt,
    getDutyHistoryStatus,
    getOrderedDutySupplyNames,
    getVisibleDutyHistoryRecords,
    hasLegacyDutySupplyData
} from '../src/duty-history.js';

test('值日紀錄只顯示已提交或已過期週次，並由新到舊排列', () => {
    const records = [
        { _id: '2026-08-17', submitted: true },
        { _id: '2026-08-31', submitted: true },
        { _id: '2026-09-07', submitted: false },
        { _id: '2026-08-24', submitted: false, status: 'carried_over' }
    ];
    assert.deepEqual(
        getVisibleDutyHistoryRecords(records, '2026-08-31').map(record => record._id),
        ['2026-08-31', '2026-08-24', '2026-08-17']
    );
});

test('已完成與未完成順延使用不同文字與圖示狀態', () => {
    assert.equal(getDutyHistoryStatus({ submitted: true }, '2026-08-31').label, '已完成');
    assert.equal(getDutyHistoryStatus({ status: 'carried_over' }, '2026-08-31').label, '未完成・已順延');
    assert.equal(getDutyHistoryStatus({ _id: '2026-08-17' }, '2026-08-31').label, '未完成');
});

test('紀錄日期與台北提交時間使用精簡格式', () => {
    assert.equal(formatDutyHistoryRange('2026-08-31'), '2026/8/31–9/6');
    assert.equal(formatDutyHistorySubmittedAt('2026-08-31T10:33:26.415Z'), '2026/8/31（一） 18:33');
});

test('紀錄只列出已叫貨項目，舊版布林資料另外標記', () => {
    const items = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
    const supplies = { a: 'ordered', b: 'sufficient', c: true };
    assert.deepEqual(getOrderedDutySupplyNames(supplies, items), ['A']);
    assert.equal(hasLegacyDutySupplyData(supplies, items), true);
});
