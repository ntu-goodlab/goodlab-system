import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateNextScheduledDue } from '../src/routine-schedule.js';

test('週期以原排定日推進，不以實際完成日重算', () => {
    assert.equal(calculateNextScheduledDue({
        next_due: '2026-07-11',
        interval_value: 2,
        interval_unit: 'month'
    }, '2026-07-16'), '2026-09-11');
});

test('逾期多期時推進到第一個未來排定日', () => {
    assert.equal(calculateNextScheduledDue({
        next_due: '2026-03-02',
        interval_value: 1,
        interval_unit: 'month'
    }, '2026-07-16'), '2026-08-02');
});

test('每月月初項目延後完成，仍維持下個月一日', () => {
    assert.equal(calculateNextScheduledDue({
        next_due: '2026-08-01',
        interval_value: 1,
        interval_unit: 'month'
    }, '2026-08-18'), '2026-09-01');
});

test('固定排程錨點可修正舊資料曾經產生的日期漂移', () => {
    assert.equal(calculateNextScheduledDue({
        schedule_anchor: '2026-08-01',
        next_due: '2026-08-16',
        interval_value: 1,
        interval_unit: 'month'
    }, '2026-08-18'), '2026-09-01');
});

test('月底週期不因短月份而永久漂移', () => {
    assert.equal(calculateNextScheduledDue({
        next_due: '2026-01-31',
        interval_value: 1,
        interval_unit: 'month'
    }, '2026-02-28'), '2026-03-31');
});

test('一次性項目完成後不再產生下次日期', () => {
    assert.equal(calculateNextScheduledDue({
        schedule_type: 'one_time',
        next_due: '2026-07-16'
    }, '2026-07-16'), null);
});
