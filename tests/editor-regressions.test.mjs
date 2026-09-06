import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { captureFormDrafts, restoreFormDrafts } from '../src/form-draft.js';
import * as employmentTimeline from '../src/employment-timeline.js';
import { employmentEditFingerprint } from '../src/employment-edit-state.js';
import { applyEmploymentMonthDrafts } from '../src/employment-month-draft.js';
import { employmentOverrideUpdates } from '../src/employment-access.js';

function loadModule(file, name, context) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
        .replace(/^import\b[\s\S]*?;\s*/gm, '')
        .replace(/^export const /gm, 'var ');
    vm.runInNewContext(source, context);
    return context[name];
}

test('編輯帳務使用欄位更新，新增才寫入建立時間', async () => {
    const values = { Acc_Amount: '120', Acc_Type: 'Lab', Fund_Source: 'Bank', Payback_Method: 'Bank',
        Acc_Payer: 'Fund', Txn_ID: 'existing', Acc_Description: '耗材', Acc_Date: '2026-09-06' };
    const fields = new Map();
    const calls = [];
    const context = { Date, document: { getElementById: id => {
        if (!fields.has(id)) fields.set(id, { value: values[id] || '' });
        return fields.get(id);
    } }, db: {}, doc: (_db, collection, id) => `${collection}/${id}`,
    updateDoc: async (_ref, data) => calls.push(['update', data]),
    setDoc: async (_ref, data) => calls.push(['set', data]), closeModal() {}, showNotification() {} };
    const app = loadModule('accounting.js', 'accountingModule', context);
    app.data = { accounting: [{ Txn_ID: 'existing', Created_At: '2026-01-01' }] };
    await app.saveAccounting();
    assert.equal(calls[0][0], 'update');
    assert.equal(Object.hasOwn(calls[0][1], 'Created_At'), false);
    assert.equal(calls[0][1].Amount, -120);
    fields.get('Txn_ID').value = 'new';
    await app.saveAccounting();
    assert.equal(calls[1][0], 'set');
    assert.ok(calls[1][1].Created_At);
});

test('儀器儲存失敗後重試，仍保留全部產編關聯', async () => {
    let fail = true;
    const writes = [];
    const context = { document: { getElementById: id => ({ value: id === 'Instrument_ID' ? 'I1' : '' }), querySelectorAll: () => [] },
        db: {}, doc: () => 'instruments/I1', setDoc: async (_ref, payload) => {
            writes.push([...payload.Linked_Property_IDs]);
            if (fail) throw new Error('test interruption');
        }, alert() {} };
    const app = loadModule('instruments.js', 'instrumentsModule', context);
    Object.assign(app, { currentRole: 'Admin', currentEditingInstTags: ['P1'], tempLinkedPropId: 'P2', currentInstIsActive: true,
        closeModal() {}, showNotification() {}, renderInstruments() {}, renderInventory() {} });
    await app.saveInstrument();
    assert.deepEqual(Array.from(app.currentEditingInstTags), ['P1', 'P2']);
    fail = false;
    await app.saveInstrument();
    assert.deepEqual(writes, [['P1', 'P2'], ['P1', 'P2']]);
    assert.equal(app.currentEditingInstTags.length, 0);
});

test('重畫保留同筆表單草稿與焦點，但不污染另一筆記錄', () => {
    const field = { id: 'title', value: '未儲存文字', selectionStart: 2, selectionEnd: 4, focus() {}, setSelectionRange() {} };
    const editor = { dataset: { draftKey: 'notice-a' }, querySelectorAll: () => [field] };
    const container = { querySelectorAll: () => [editor] };
    const previousDocument = globalThis.document;
    globalThis.document = { activeElement: field };
    try {
        const drafts = captureFormDrafts(container);
        field.value = '伺服器舊值';
        restoreFormDrafts(container, drafts);
        assert.equal(field.value, '未儲存文字');
        editor.dataset.draftKey = 'notice-b';
        field.value = '另一筆';
        restoreFormDrafts(container, drafts);
        assert.equal(field.value, '另一筆');
    } finally { globalThis.document = previousDocument; }
});

test('留言儲存回應使用目前狀態欄，且不把後續編輯誤標為已儲存', async () => {
    let finish;
    let status = { textContent: '' };
    const field = { value: '第一版' };
    const context = {
        document: { getElementById: () => status, querySelector: () => field },
        DUTY_NOTE_MAX_LENGTH: 1000, db: {}, doc: () => 'duty_records/test-week',
        updateDoc: () => new Promise(resolve => { finish = resolve; })
    };
    const app = loadModule('duty.js', 'dutyModule', context);
    Object.assign(app, { data: { duty_records: [{ _id: 'test-week', submitted: false }] },
        currentRole: 'Admin', currentUser: { uid: 'test-admin' },
        _getDutyWeekId: () => 'test-week', _getCurrentDutyPerson: () => null, showNotification() {} });
    const firstSave = app.saveDutyNote(field.value);
    status = { textContent: '重畫後的狀態' };
    finish();
    await firstSave;
    assert.equal(status.textContent, '已儲存');
    const secondSave = app.saveDutyNote(field.value);
    field.value = '尚未送出的第二版';
    status.textContent = '尚未儲存';
    finish();
    await secondSave;
    assert.equal(status.textContent, '尚未儲存');
});

function employmentEditorFixture() {
    const fields = new Map();
    const values = { project: 'project-a', 'declared-start-year': '115', 'declared-start-month': '10',
        'declared-end-year': '116', 'declared-end-month': '1', 'average-start-year': '115',
        'average-start-month': '8', 'average-end-year': '116', 'average-end-month': '1',
        'base-amount': '8000', remark: '待確認' };
    for (const [key, value] of Object.entries(values)) fields.set(`employment-person-0-${key}`, { value });
    fields.set('employment-person-0-custom-average', { checked: false });
    fields.set('employment-person-student', { value: 'student-a' });
    fields.set('employment-person-form-error', { textContent: '', focus() {} });
    fields.set('btn-save-employment-person', { disabled: false });
    const writes = [];
    const context = { ...employmentTimeline, employmentEditFingerprint, applyEmploymentMonthDrafts, employmentOverrideUpdates, document: { getElementById: id => fields.get(id) }, db: {},
        confirm: () => false, generateId: () => 'generated-employment-id',
        doc: (_db, _collection, id) => id,
        writeBatch: () => ({ set: (id, data) => writes.push({ id, data }), update: (id, data) => writes.push({ id, data }), delete() {}, commit: async () => {} }) };
    const app = loadModule('employment.js', 'employmentModule', context);
    Object.assign(app, { currentRole: 'Admin', employmentPersonId: 'student-a', employmentPersonEditorOpen: true,
        empAcademicYear: 115, empTerm: 1, renderEmployment() {}, showNotification() {} });
    const draft = { _id: 'employment-a', declared_start_month: '2026-08', declared_end_month: '2027-01',
        average_start_month: '2026-08', average_end_month: '2027-01', _detailsOpen: true,
        month_overrides: { '2026-11': { amount: 0, reason: '停聘' } }, created_at: '2026-08-01' };
    app.employmentPersonDrafts = [draft];
    return { app, fields, writes, draft, context };
}

test('表格儲存：一般分攤跟隨修改後的申報日期，保留單月停聘與建立時間', async () => {
    const { app, writes } = employmentEditorFixture();
    await app.saveEmploymentPerson();
    assert.equal(writes.length, 1);
    const { data } = writes[0];
    assert.equal(data.average_start_month, '2026-10');
    assert.equal(data.declared_start_month, '2026-10');
    assert.equal(Object.hasOwn(data, 'month_overrides'), false);
    assert.equal(Object.hasOwn(data, 'month_overrides.2026-11'), false);
    assert.equal(Object.hasOwn(data, 'created_at'), false);
    assert.equal(data.remark, '待確認');
    assert.equal(Object.hasOwn(data, '_detailsOpen'), false);
    assert.equal(Object.hasOwn(data, '_customAverage'), false);
});

test('表格儲存：特殊分攤期間不受申報日期修改影響', async () => {
    const { app, fields, writes } = employmentEditorFixture();
    fields.get('employment-person-0-custom-average').checked = true;
    await app.saveEmploymentPerson();
    assert.equal(writes[0].data.declared_start_month, '2026-10');
    assert.equal(writes[0].data.average_start_month, '2026-08');
});

test('表格驗證拒絕重疊計畫，不執行批次寫入', async () => {
    const { app, fields, draft, writes } = employmentEditorFixture();
    for (const [id, field] of [...fields]) {
        if (id.startsWith('employment-person-0-')) fields.set(id.replace('-0-', '-1-'), { ...field });
    }
    app.employmentPersonDrafts.push({ ...draft, _id: 'employment-b' });
    await app.saveEmploymentPerson();
    assert.equal(writes.length, 0);
    assert.match(fields.get('employment-person-form-error').textContent, /月份不可重疊/);
});

function attachEmploymentDom(fixture) {
    const { app, fields } = fixture;
    const controls = () => [...fields].filter(([id]) => id.startsWith('employment-person-0-')).map(([id, field]) => {
        field.id = id;
        field.type = id.endsWith('custom-average') ? 'checkbox' : 'text';
        return field;
    });
    const editor = { dataset: { draftKey: 'person-student-a-115-1' }, querySelectorAll: controls };
    const container = { querySelectorAll: selector => selector === '[data-draft-key]' ? [editor] : controls() };
    fields.set('employment-content', container);
    app._employmentDraftBaseline = employmentEditFingerprint(container);
    return { editor, container };
}

test('未修改不提醒，修改再還原也不提醒；取消切換人員保留原選項和草稿', () => {
    const fixture = employmentEditorFixture();
    const { app, fields, context } = fixture;
    attachEmploymentDom(fixture);
    let prompts = 0;
    context.confirm = () => { prompts++; return false; };
    assert.equal(app.confirmEmploymentLeave(), true);
    fields.get('employment-person-0-base-amount').value = '9000';
    fields.get('employment-person-student').value = 'student-b';
    app.changeEmploymentPersonEditorStudent('student-b');
    assert.equal(prompts, 1);
    assert.equal(app.employmentPersonId, 'student-a');
    assert.equal(fields.get('employment-person-student').value, 'student-a');
    assert.equal(fields.get('employment-person-0-base-amount').value, '9000');
    fields.get('employment-person-0-base-amount').value = '8000';
    assert.equal(app.confirmEmploymentLeave(), true);
    assert.equal(prompts, 1);
});

test('取消切換學期與瀏覽器返回保持原畫面；確認離開才清除編輯器', () => {
    const fixture = employmentEditorFixture();
    const { app, fields, context } = fixture;
    attachEmploymentDom(fixture);
    fields.get('employment-person-0-remark').value = '未儲存';
    app.changeEmploymentSemester(1);
    assert.equal(app.empTerm, 1);
    assert.equal(app.employmentPersonEditorOpen, true);
    const routes = [];
    context.history = { replaceState: (_state, _title, hash) => routes.push(hash) };
    assert.equal(app.guardEmploymentNavigation('overview', true), false);
    assert.deepEqual(routes, ['#/employment']);
    context.confirm = () => true;
    assert.equal(app.guardEmploymentNavigation('overview'), true);
    assert.equal(app.employmentPersonEditorOpen, false);
    assert.equal(app._employmentDraftBaseline, null);
});

test('計畫與單月編輯的文字、核取設定、列結構都有修改保護', () => {
    const fixture = employmentEditorFixture();
    const { app, fields } = fixture;
    const { editor } = attachEmploymentDom(fixture);
    for (const key of ['project-project-a-115-1', 'month-employment-a-2026-10']) {
        editor.dataset.draftKey = key;
        app._employmentDraftBaseline = employmentEditFingerprint(fields.get('employment-content'));
        fields.get('employment-person-0-custom-average').checked = true;
        assert.equal(app.confirmEmploymentLeave(), false);
        fields.get('employment-person-0-custom-average').checked = false;
        assert.equal(app.confirmEmploymentLeave(), true);
        fields.set('employment-person-0-extra', { value: '新增欄位' });
        assert.equal(app.confirmEmploymentLeave(), false);
        fields.delete('employment-person-0-extra');
    }
});

test('儲存中鎖定控制項與切頁、拒絕重複送出，失敗後可用同一 ID 重試', async () => {
    const fixture = employmentEditorFixture();
    const { app, fields, context, writes, draft } = fixture;
    attachEmploymentDom(fixture);
    delete draft._id;
    let rejectSave;
    let commits = 0;
    context.writeBatch = () => ({ set: (id, data) => writes.push({ id, data }), delete() {}, commit: () => {
        commits++;
        return new Promise((_resolve, reject) => { rejectSave = reject; });
    } });
    const first = app.saveEmploymentPerson();
    assert.equal(fields.get('employment-person-0-base-amount').disabled, true);
    assert.equal(app.confirmEmploymentLeave(), false);
    await app.saveEmploymentPerson();
    assert.equal(commits, 1);
    rejectSave(new Error('測試斷線'));
    await first;
    assert.equal(fields.get('btn-save-employment-person').disabled, false);
    assert.equal(app._employmentSaveToken, null);
    assert.equal(app.employmentPersonEditorOpen, true);
    assert.equal(fields.get('employment-person-0-remark').value, '待確認');
    context.writeBatch = () => ({ set: (id, data) => writes.push({ id, data }), delete() {}, commit: async () => {} });
    await app.saveEmploymentPerson();
    assert.equal(writes.length, 2);
    assert.equal(writes[0].id, writes[1].id);
    assert.equal(app.employmentPersonEditorOpen, false);
});

test('建立批次失敗也解除儲存鎖；舊帳號儲存完成不清除新帳號編輯', async () => {
    const fixture = employmentEditorFixture();
    const { app, context } = fixture;
    context.writeBatch = () => { throw new Error('建立批次失敗'); };
    await app.saveEmploymentPerson();
    assert.equal(app._employmentSaveToken, null);
    let finish;
    app.currentUser = { uid: 'old' };
    const saving = app._runEmploymentSave('btn-save-employment-person', () => new Promise(resolve => { finish = resolve; }), { text: '完成' });
    app.currentUser = { uid: 'new' };
    app.resetEmploymentEditors();
    app._employmentSaveToken = null;
    app.projectEditorOpen = true;
    finish();
    await saving;
    assert.equal(app.projectEditorOpen, true);
});

test('只有未儲存或儲存中的聘僱需要重新整理提醒', () => {
    const fixture = employmentEditorFixture();
    const { app, fields } = fixture;
    attachEmploymentDom(fixture);
    let prevented = 0;
    const event = { preventDefault() { prevented++; } };
    app.protectEmploymentUnload(event);
    assert.equal(prevented, 0);
    fields.get('employment-person-0-remark').value = '未儲存';
    app.protectEmploymentUnload(event);
    assert.equal(prevented, 1);
    assert.equal(event.returnValue, '');
});

test('表格內月額與原因一起儲存，恢復預設只刪除該月調整', async () => {
    const { app, fields, writes } = employmentEditorFixture();
    fields.set('employment-person-0-2026-11-amount', { value: '' });
    fields.set('employment-person-0-2026-11-reason', { value: '' });
    fields.set('employment-person-0-2026-12-amount', { value: '0' });
    fields.set('employment-person-0-2026-12-reason', { value: '暫停一個月' });
    await app.saveEmploymentPerson();
    assert.equal(writes.length, 1);
    assert.ok(writes[0].data['month_overrides.2026-11']);
    assert.equal(writes[0].data['month_overrides.2026-12'].amount, 0);
    assert.equal(writes[0].data['month_overrides.2026-12'].reason, '暫停一個月');
    assert.equal(Object.hasOwn(writes[0].data, '_monthDrafts'), false);
});

test('表格新增月額調整缺少原因時阻止整批儲存', async () => {
    const { app, fields, writes } = employmentEditorFixture();
    fields.set('employment-person-0-2026-12-amount', { value: '0' });
    fields.set('employment-person-0-2026-12-reason', { value: '' });
    await app.saveEmploymentPerson();
    assert.equal(writes.length, 0);
    assert.match(fields.get('employment-person-form-error').textContent, /115.12.*原因/);
});

test('單月草稿保留期間外既有調整，拒絕負數或非整數', () => {
    const original = { '2026-09': { amount: 0, reason: '既有停聘' } };
    const result = applyEmploymentMonthDrafts(original, {
        '2026-09': { amount: '', reason: '' },
        '2026-10': { amount: '-2', reason: '錯誤' },
        '2026-11': { amount: '1.5', reason: '錯誤' }
    }, ['2026-10', '2026-11'], 8000);
    assert.equal(result.errors.length, 2);
    assert.equal(result.overrides['2026-09'].amount, 0);
    assert.equal(Object.hasOwn(result.overrides, '2026-10'), false);
});
