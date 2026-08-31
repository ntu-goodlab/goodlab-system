import test from 'node:test';
import assert from 'node:assert/strict';
import { getDutyRoster, getDutyWeekId } from '../src/duty-schedule.js';

test('值日順序依成員入學日期由早到晚，不依學號字串', () => {
    const members = [
        { Student_ID: 'r11300001', Name_Ch: '碩一甲', Degree: 'Master', Role: 'User', Status: 'Active', Enrollment_Date: '2026-09-01' },
        { Student_ID: 'r11500001', Name_Ch: '何品彥', Degree: 'Master', Role: 'User', Status: 'Active', Enrollment_Date: '2024-09-01' },
        { Student_ID: 'r11000001', Name_Ch: '蔡蓁羚', Degree: 'Master', Role: 'User', Status: 'Active', Enrollment_Date: '2025-02-01' },
        { Student_ID: 'r11400001', Name_Ch: '陳同學', Degree: 'Master', Role: 'User', Status: 'Active', Enrollment_Date: '2025-09-01' }
    ];

    assert.deepEqual(
        getDutyRoster(members).map(member => member.Name_Ch),
        ['何品彥', '蔡蓁羚', '陳同學', '碩一甲']
    );
});

test('值日名單排除 Admin、非碩士與離校成員', () => {
    const members = [
        { Student_ID: 'active', Degree: 'Master', Role: 'User', Status: 'Active', Enrollment_Date: '2025-09-01' },
        { Student_ID: 'admin', Degree: 'Master', Role: 'Admin', Status: 'Active', Enrollment_Date: '2024-09-01' },
        { Student_ID: 'phd', Degree: 'PhD', Role: 'User', Status: 'Active', Enrollment_Date: '2024-09-01' },
        { Student_ID: 'alumni', Degree: 'Master', Role: 'User', Status: 'Alumni', Enrollment_Date: '2023-09-01' }
    ];

    assert.deepEqual(getDutyRoster(members).map(member => member.Student_ID), ['active']);
});

test('台北時間週一凌晨仍使用當天作為週次 ID', () => {
    assert.equal(getDutyWeekId('2026-08-31T00:30:00+08:00'), '2026-08-31');
    assert.equal(getDutyWeekId('2026-09-06T23:59:59+08:00'), '2026-08-31');
    assert.equal(getDutyWeekId('2026-09-07T00:00:00+08:00'), '2026-09-07');
});
