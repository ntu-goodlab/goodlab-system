import test from 'node:test';
import assert from 'node:assert/strict';
import { planApprovedMigration } from '../src/approved-migration-plan.js';
const member = { Student_ID: 'student', Google_UID: 'uid', Google_Email: 'u@example.test', Role: 'Admin', Status: 'Active' };
const account = { uid: 'uid', email: 'u@example.test', emailVerified: true, disabled: false, providerData: [{ providerId: 'google.com' }] };
test('既有正確綁定列為可直接遷移候選，管理員確認後不需要成員重新申請', () => {
    const input = { members: [member], authUsers: [account] };
    const audit = planApprovedMigration(input);
    assert.equal(audit.rows[0].decision, 'awaiting-confirmation'); assert.equal(audit.readyForMigration, false);
    const confirmed = planApprovedMigration({ ...input, approvedUids: ['uid'] });
    assert.equal(confirmed.rows[0].decision, 'confirmed'); assert.equal(confirmed.readyForMigration, true);
});
test('重複 UID、信箱不符、停用、未驗證與離校帳號必須個別處理，即使列入已確認', () => {
    const duplicate = planApprovedMigration({ members: [member, { ...member, Student_ID: 'second' }], authUsers: [account], approvedUids: ['uid'] });
    assert.equal(duplicate.confirmed.length, 0);
    for (const [m, a] of [[{ ...member, Google_Email: 'wrong' }, account], [member, { ...account, disabled: true }],
        [member, { ...account, emailVerified: false }], [{ ...member, Status: 'Alumni' }, account]]) {
        assert.equal(planApprovedMigration({ members: [m], authUsers: [a], approvedUids: ['uid'] }).confirmed.length, 0);
    }
});
test('缺少歷史 Google 信箱可由 Auth 權威資料補齊，但仍需確認；缺少 Auth 帳號不可遷移', () => {
    const report = planApprovedMigration({ members: [{ ...member, Google_Email: '' }], authUsers: [account] });
    assert.equal(report.rows[0].fillMissingGoogleEmail, account.email);
    assert.equal(report.rows[0].decision, 'awaiting-confirmation');
    assert.equal(planApprovedMigration({ members: [member], approvedUids: ['uid'] }).rows[0].eligible, false);
});
