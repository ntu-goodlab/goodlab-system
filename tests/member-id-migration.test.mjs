import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildMigratedMember,
    createMemberIdMigrationPlan,
    validateMemberIdMigration
} from '../src/member-id-migration.js';

const members = [
    {
        Student_ID: 'r10943138',
        Name_Ch: '測試同學',
        Email: 'r10943138@ntu.edu.tw',
        Degree: 'Master',
        Status: 'Active',
        Google_UID: 'google-uid'
    },
    {
        Student_ID: 'f10800001',
        Name_Ch: '另一位同學',
        Status: 'Active',
        Previous_Student_IDs: ['r10800001']
    }
];

test('拒絕目前學號或他人曾用學號重複', () => {
    assert.equal(
        validateMemberIdMigration(members, 'r10943138', 'f10800001').valid,
        false
    );
    assert.equal(
        validateMemberIdMigration(members, 'r10943138', 'r10800001').valid,
        false
    );
});

test('精確產生各集合的學號轉移操作', () => {
    const plan = createMemberIdMigrationPlan({
        instruments: [{ Instrument_ID: 'INST_1', Manager_ID: 'R10943138' }],
        logs: [
            { Log_ID: 'LOG_1', Owner_ID: 'r10943138', Reporter_UID: 'r10943138' },
            { Log_ID: 'LOG_2', Owner_ID: 'someone_else' }
        ],
        accounting: [{ Txn_ID: 'ACC_1', Payer: 'r10943138' }],
        inventory: [{ Property_ID: 'P_1', Checked_By: 'google-uid' }],
        duty_records: [{ _id: '2026-07-20', scheduled_to: 'r10943138', assigned_to: 'r10943138' }],
        employments: [{ _id: 'EMP_1', student_id: 'r10943138' }],
        bulletins: [{ _id: 'meeting', updated_by: 'r10943138' }]
    }, 'r10943138', 'f10943138');

    assert.equal(plan.affectedDocuments, 6);
    assert.deepEqual(plan.operations.find(item => item.documentId === 'LOG_1').changes, {
        Owner_ID: 'f10943138'
    });
    assert.deepEqual(plan.operations.find(item => item.documentId === 'EMP_1').changes, {
        student_id: 'f10943138',
        original_student_id: 'r10943138'
    });
    assert.equal(plan.operations.some(item => item.collection === 'inventory'), false);
});

test('聘僱再次轉移時不覆蓋最初申報學號', () => {
    const plan = createMemberIdMigrationPlan({
        employments: [{
            _id: 'EMP_1',
            student_id: 'f10943138',
            original_student_id: 'r10943138'
        }]
    }, 'f10943138', 'd10943138');

    assert.deepEqual(plan.operations[0].changes, {
        student_id: 'd10943138'
    });
});

test('新成員保留曾用學號、異動歷史與 Google 綁定', () => {
    const migrated = buildMigratedMember(members[0], {
        newId: 'f10943138',
        newEmail: 'f10943138@ntu.edu.tw',
        newDegree: 'PhD',
        newEnrollmentDate: '2026-08-01',
        preserveGoogleBinding: true,
        changedAt: '2026-07-24T00:00:00.000Z',
        changedBy: 'admin'
    });

    assert.equal(migrated.Student_ID, 'f10943138');
    assert.equal(migrated.Google_UID, 'google-uid');
    assert.equal(migrated.Degree, 'PhD');
    assert.deepEqual(migrated.Previous_Student_IDs, ['r10943138']);
    assert.deepEqual(migrated.Student_ID_History[0], {
        from: 'r10943138',
        to: 'f10943138',
        changed_at: '2026-07-24T00:00:00.000Z',
        changed_by: 'admin'
    });
});

test('改用新 Google 帳號時保留舊 UID 供歷史紀錄辨識', () => {
    const migrated = buildMigratedMember(members[0], {
        newId: 'f10943138',
        preserveGoogleBinding: false,
        changedAt: '2026-07-24T00:00:00.000Z',
        changedBy: 'admin'
    });

    assert.equal(migrated.Google_UID, null);
    assert.deepEqual(migrated.Previous_Google_UIDs, ['google-uid']);
});
