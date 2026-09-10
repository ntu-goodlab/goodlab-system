import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistanceWindow, assistanceState } from '../src/duty-assistance-state.js';

test('代做週期以台北週一零時起，下一週零時立即失效', () => {
    const { start, end } = assistanceWindow('2026-09-07');
    assert.equal(new Date(start).toISOString(), '2026-09-06T16:00:00.000Z');
    assert.equal(new Date(end).toISOString(), '2026-09-13T16:00:00.000Z');
    for (const bad of ['2026-09-08', 'bad', '2026-02-30']) assert.throws(() => assistanceWindow(bad));
    const invite = { _id: 'x', status: 'pending', from_student: 'a', to_student: 'b', from_access_at: '2026-01-01', to_access_at: '2026-01-01', revision: 0, expires_at: new Date(end).toISOString() };
    const record = { status: 'pending', submitted: false, assist_request: 'x', assigned_to: 'a' };
    const people = ['a', 'b'].map(Student_ID => ({ Student_ID, Status: 'Active', duty_access_at: '2026-01-01' }));
    assert.equal(assistanceState(invite, record, people, end - 1), 'pending');
    assert.equal(assistanceState(invite, record, people, end), 'expired');
    assert.equal(assistanceState(invite, { ...record, assignment_revision: 1 }, people, start), 'invalidated');
    assert.equal(assistanceState(invite, record, [people[0]], start), 'invalidated');
});
