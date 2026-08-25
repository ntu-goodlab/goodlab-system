import test from 'node:test';
import assert from 'node:assert/strict';
import { compareMembersForDirectory } from '../src/member-directory.js';

test('成員先依學位分組，再依完整入學日期由早到晚排列', () => {
    const members = [
        { Student_ID: 'r11400001', Degree: 'Master', Status: 'Active', Enrollment_Date: '2026-02-01' },
        { Student_ID: 'f11500001', Degree: 'PhD', Status: 'Active', Enrollment_Date: '2026-09-01' },
        { Student_ID: 'r11500001', Degree: 'Master', Status: 'Active', Enrollment_Date: '2025-09-01' },
        { Student_ID: 'r11300001', Degree: 'Master', Status: 'Active', Enrollment_Date: '2026-02-01' }
    ];

    assert.deepEqual(
        members.sort(compareMembersForDirectory).map(member => member.Student_ID),
        ['f11500001', 'r11500001', 'r11300001', 'r11400001']
    );
});

test('未填入學日期的成員排在同組已填日期者之後', () => {
    const members = [
        { Student_ID: 'r11000001', Degree: 'Master', Status: 'Active' },
        { Student_ID: 'r11500001', Degree: 'Master', Status: 'Active', Enrollment_Date: '2025-09-01' }
    ];

    assert.deepEqual(
        members.sort(compareMembersForDirectory).map(member => member.Student_ID),
        ['r11500001', 'r11000001']
    );
});

test('入學日期相同時以學號維持穩定順序', () => {
    const members = [
        { Student_ID: 'r11500002', Degree: 'Master', Status: 'Active', Enrollment_Date: '2025-09-01' },
        { Student_ID: 'r11500001', Degree: 'Master', Status: 'Active', Enrollment_Date: '2025-09-01' }
    ];

    assert.deepEqual(
        members.sort(compareMembersForDirectory).map(member => member.Student_ID),
        ['r11500001', 'r11500002']
    );
});
