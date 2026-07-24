import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildInstrumentSelectItems,
    buildMemberSelectItems,
    buildPayerSelectItems
} from '../src/select-options.js';

const members = [
    { Student_ID: 'active01', Name_Ch: '在學同學', Status: 'Active' },
    { Student_ID: 'alumni01', Name_Ch: '畢業同學', Status: 'Graduated' },
    { Student_ID: 'alumni02', Name_Ch: '另一位畢業同學', Status: 'Graduated' }
];

test('新增資料只列出目前在學成員', () => {
    assert.deepEqual(
        buildMemberSelectItems(members).map(item => item.value),
        ['active01']
    );
});

test('編輯舊資料時保留原本的畢業成員，但不帶入其他畢業成員', () => {
    const items = buildMemberSelectItems(members, 'alumni01');

    assert.deepEqual(items.map(item => item.value), ['active01', 'alumni01']);
    assert.match(items.at(-1).label, /畢業同學.*已離校/);
});

test('成員主檔已刪除時仍保留舊識別碼', () => {
    assert.deepEqual(
        buildMemberSelectItems(members, 'deleted01').at(-1),
        { value: 'deleted01', label: 'deleted01（舊資料）' }
    );
});

test('帳務付款人保留畢業成員，且公積金選項不重複', () => {
    const fundItems = buildPayerSelectItems(members, 'Fund');
    const alumniItems = buildPayerSelectItems(members, 'alumni01');

    assert.equal(fundItems.filter(item => item.value === 'Fund').length, 1);
    assert.deepEqual(
        alumniItems.map(item => item.value),
        ['Fund', 'active01', 'alumni01']
    );
    assert.match(alumniItems.at(-1).label, /畢業同學.*已離校/);
});

test('編輯維修紀錄時保留已停用儀器', () => {
    const instruments = [
        { Instrument_ID: 'INST_ACTIVE', Name: '使用中儀器', Location: '機房', Is_Active: true },
        { Instrument_ID: 'INST_OLD', Name: '已停用儀器', Location: '機房', Is_Active: false }
    ];
    const items = buildInstrumentSelectItems(instruments, '機房', 'INST_OLD');

    assert.deepEqual(items.map(item => item.value), ['INST_ACTIVE', 'INST_OLD']);
    assert.match(items.at(-1).label, /已停用儀器.*已停用/);
});

test('儀器主檔已刪除時仍保留維修紀錄原識別碼', () => {
    const items = buildInstrumentSelectItems([], '', 'INST_DELETED');

    assert.deepEqual(items, [
        { value: 'INST_DELETED', label: 'INST_DELETED（舊資料）' }
    ]);
});
