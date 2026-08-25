import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, getMemberName } from '../src/utils.js';

test('escapeHtml 會轉義可執行標記與引號', () => {
    assert.equal(
        escapeHtml(`<img src=x onerror="alert('x')"> &`),
        '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp;'
    );
});

test('getMemberName 支援現有與曾用學號', () => {
    const members = [{
        Student_ID: 'f10943138',
        Name_Ch: '測試成員',
        Previous_Student_IDs: ['r10943138']
    }];

    assert.equal(getMemberName(members, 'F10943138'), '測試成員');
    assert.equal(getMemberName(members, 'r10943138'), '測試成員');
});
