import test from 'node:test';
import assert from 'node:assert/strict';

import {
    calculateAccountingSummary,
    getPaybackMethod
} from '../src/accounting-calculations.js';

test('個人代墊以現金還款時扣除現金餘額', () => {
    const summary = calculateAccountingSummary([
        { Type: 'Income', Amount: 20000, Payer: 'Fund', Fund_Source: 'Bank' },
        { Type: 'Income', Amount: 5000, Payer: 'Fund', Fund_Source: 'Cash' },
        {
            Type: 'Lab',
            Amount: -1200,
            Payer: 'f10943138',
            Payback_Date: '2026-07-27',
            Payback_Method: 'Cash'
        }
    ]);

    assert.equal(summary.bankBalance, 20000);
    assert.equal(summary.cashBalance, 3800);
    assert.equal(summary.payable, 0);
});

test('尚未還款的個人代墊不扣餘額並列入待還款', () => {
    const summary = calculateAccountingSummary([
        { Type: 'Income', Amount: 10000, Payer: 'Fund', Fund_Source: 'Bank' },
        { Type: 'Lab', Amount: -600, Payer: 'r10943138', Payback_Date: '' }
    ]);

    assert.equal(summary.bankBalance, 10000);
    assert.equal(summary.cashBalance, 0);
    assert.equal(summary.payable, 600);
});

test('舊還款紀錄沿用 Fund_Source，缺少來源則預設戶頭', () => {
    assert.equal(getPaybackMethod({ Fund_Source: 'Cash' }), 'Cash');
    assert.equal(getPaybackMethod({}), 'Bank');
});
