import test from 'node:test';
import assert from 'node:assert/strict';
import { getMobileNavigationLayout } from '../src/mobile-navigation.js';

const priorityIds = ['overview', 'instruments', 'duty', 'inventory'];

test('五個可用頁面全部放在手機底部，不顯示更多', () => {
    const layout = getMobileNavigationLayout(
        ['overview', 'duty', 'inventory', 'members', 'instruments'],
        { priorityIds }
    );

    assert.deepEqual(layout.directIds, ['overview', 'instruments', 'duty', 'inventory', 'members']);
    assert.deepEqual(layout.overflowIds, []);
    assert.equal(layout.showMore, false);
});

test('超過五個頁面時顯示四個主要入口與更多', () => {
    const layout = getMobileNavigationLayout(
        ['overview', 'logs', 'routine', 'duty', 'inventory', 'accounting', 'members', 'employment', 'instruments'],
        { priorityIds }
    );

    assert.deepEqual(layout.directIds, ['overview', 'instruments', 'duty', 'inventory']);
    assert.deepEqual(layout.overflowIds, ['logs', 'routine', 'accounting', 'members', 'employment']);
    assert.equal(layout.showMore, true);
});

test('重複的頁面不會佔用兩個手機導覽位置', () => {
    const layout = getMobileNavigationLayout(
        ['overview', 'overview', 'duty'],
        { priorityIds }
    );

    assert.deepEqual(layout.directIds, ['overview', 'duty']);
    assert.equal(layout.showMore, false);
});
