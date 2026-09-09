import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalState } from '../src/approval-state.js';
const request = { _id: 'legacy', email: 'legacy@example.test' };
test('same legacy binding is actionable; alumni require explicit reactivation', () => {
    const member = { Google_UID: 'legacy', Google_Email: request.email, Status: 'Alumni' };
    assert.deepEqual(approvalState(member, request), { blocked: false, reactivate: true, label: '核對並恢復使用權限' });
    assert.equal(approvalState({ ...member, Status: 'Active' }, request).reactivate, false);
    assert.equal(approvalState({ ...member, Google_Email: null }, request).blocked, false);
});
test('a conflicting Google identity or missing profile cannot be approved', () => {
    for (const member of [null, { Google_UID: 'other', Status: 'Active' },
        { Google_UID: 'legacy', Google_Email: 'different@example.test', Status: 'Active' }]) {
        assert.equal(approvalState(member, request).blocked, true);
    }
});
