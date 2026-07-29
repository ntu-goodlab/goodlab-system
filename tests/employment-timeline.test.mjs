import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildEmploymentExportWindow,
    buildScheduleSegments,
    resolveProjectColorKey
} from '../src/employment-timeline.js';

const months = ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01'];

test('連續聘僱月份合併成同一個時間區段', () => {
    const segments = buildScheduleSegments({
        '2026-08': 6000,
        '2026-09': 6000,
        '2026-10': 6000
    }, months);

    assert.deepEqual(segments, [{
        startIndex: 0,
        endIndex: 2,
        months: [
            { month: '2026-08', amount: 6000 },
            { month: '2026-09', amount: 6000 },
            { month: '2026-10', amount: 6000 }
        ]
    }]);
});

test('零元或未聘僱月份會切斷時間區段', () => {
    const segments = buildScheduleSegments({
        '2026-08': 6000,
        '2026-09': 0,
        '2026-10': 6000,
        '2026-11': 6000
    }, months);

    assert.deepEqual(segments.map(segment => [segment.startIndex, segment.endIndex]), [
        [0, 0],
        [2, 3]
    ]);
});

test('未設定色票的既有計畫會取得穩定顏色', () => {
    const project = { _id: 'PRJ_123', name: '工研院計畫' };
    assert.equal(resolveProjectColorKey(project), resolveProjectColorKey(project));
    assert.equal(resolveProjectColorKey({ ...project, color_key: 'violet' }), 'violet');
});

test('第二學期匯出會接續下一學年第一學期共十二個月', () => {
    const window = buildEmploymentExportWindow(114, 2);
    assert.deepEqual(window.semesters.map(({ academicYear, term }) => [academicYear, term]), [
        [114, 2],
        [115, 1]
    ]);
    assert.deepEqual(window.months, [
        '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07',
        '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01'
    ]);
});

test('第一學期匯出仍與前一個第二學期組成同一聘僱年度', () => {
    const window = buildEmploymentExportWindow(115, 1);
    assert.deepEqual(window.semesters.map(({ academicYear, term }) => [academicYear, term]), [
        [114, 2],
        [115, 1]
    ]);
    assert.equal(window.months[0], '2026-02');
    assert.equal(window.months.at(-1), '2027-01');
});
