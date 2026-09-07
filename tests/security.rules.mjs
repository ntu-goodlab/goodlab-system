import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, setDoc, updateDoc, getDoc, getDocs, getDocFromServer, deleteDoc, runTransaction, writeBatch } from 'firebase/firestore';
import { saveMemberAccess, unbindMemberAccess, deleteMemberAccess, syncMemberAdminRegistry } from '../src/member-access.js';
import { writeInventoryImportChunk } from '../src/inventory-import-access.js';
import { parseInventoryRows } from '../src/inventory-import.js';
import { saveEmploymentMonthAdjustment, saveProjectDetails, employmentOverrideUpdates } from '../src/employment-access.js';
import { DUTY_CLEANING_TASKS, DUTY_SUPPLY_ITEMS } from '../src/constants.js';

const projectId = 'demo-goodlab-security';
if (process.env.GOODLAB_RULES_TEST !== 'local-only'
    || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8085'
    || process.env.GCLOUD_PROJECT !== projectId) throw new Error('只允許 npm run test:rules 的本地模擬器，拒絕其他環境。');
let env;
const authDb = (uid, verified = true) => env.authenticatedContext(uid, {
    email: `${uid}@example.test`, email_verified: verified
}).firestore();
before(async () => {
    env = await initializeTestEnvironment({ projectId,
        firestore: { host: '127.0.0.1', port: 8085, rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8') }
    });
});
after(async () => env?.cleanup());
beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async context => {
        const db = context.firestore();
        const fixtures = {
            'members/admin-student': { Student_ID: 'admin-student', Role: 'Admin', Google_UID: 'admin', Status: 'Active' },
            'admins/admin': { student_id: 'admin-student', registered_at: '2026-09-01' },
            'members/user-student': { Student_ID: 'user-student', Role: 'User', Google_UID: 'user', Status: 'Active' },
            'members/new-student': { Student_ID: 'new-student', Role: 'User', Google_UID: '' },
            'members/unbound-admin': { Student_ID: 'unbound-admin', Role: 'Admin', Google_UID: '' },
            'admins/stale': { student_id: 'missing', registered_at: '2026-09-01' },
            'accounting/test': { Amount: 100 }, 'logs/test': { Status: 'Open' },
            'projects/test': { name: 'Test' }, 'employments/test': { student_id: 'user-student' }
        };
        await Promise.all(Object.entries(fixtures).map(([path, data]) => setDoc(doc(db, path), data)));
    });
});
test('未登入、普通成員、殘留白名單都無法存取行政集合', async () => {
    for (const db of [env.unauthenticatedContext().firestore(), authDb('user'), authDb('stale')]) {
        for (const collection of ['accounting', 'projects', 'employments']) {
            await assertFails(getDoc(doc(db, collection, 'test')));
            await assertFails(setDoc(doc(db, collection, 'new'), { value: 1 }));
            await assertFails(deleteDoc(doc(db, collection, 'test')));
        }
    }
});

test('舊 UID 白名單可透過伺服器唯讀查核；無登錄者拒絕，新規則也不因舊格式而放行', async () => {
    const candidateRules = await readFile(new URL('../firestore.rules', import.meta.url), 'utf8');
    const config = { projectId, firestore: { host: '127.0.0.1', port: 8085 } };
    const legacyRules = `rules_version = '2';
        service cloud.firestore { match /databases/{database}/documents {
            function isAdmin() { return request.auth != null
                && exists(/databases/$(database)/documents/admins/$(request.auth.uid)); }
            match /admins/{uid} { allow read: if request.auth != null; allow write: if false; }
            match /accounting/{id} { allow read: if isAdmin(); allow write: if false; }
        } }`;
    await env.withSecurityRulesDisabled(async ctx => setDoc(doc(ctx.firestore(), 'admins/admin'), {}));
    let legacy;
    try {
        legacy = await initializeTestEnvironment({ ...config, firestore: { ...config.firestore, rules: legacyRules } });
        const admin = legacy.authenticatedContext('admin').firestore();
        const probe = doc(admin, 'accounting/goodlab-admin-permission-check');
        const snapshot = await assertSucceeds(getDocFromServer(probe));
        assert.equal(snapshot.exists(), false);
        assert.equal(snapshot.metadata.fromCache, false);
        await assertFails(getDocFromServer(doc(legacy.authenticatedContext('user').firestore(), probe.path)));
        await assertFails(setDoc(probe, { value: 'must not write' }));
        await assertFails(setDoc(doc(legacy.authenticatedContext('user').firestore(), 'admins/user'), {}));
    } finally {
        await legacy?.cleanup();
        const restored = await initializeTestEnvironment({ ...config, firestore: { ...config.firestore, rules: candidateRules } });
        await restored.cleanup();
    }
    await assertFails(getDocFromServer(doc(authDb('admin'), 'accounting/goodlab-admin-permission-check')));
});

test('維修紀錄登入後唯讀：普通成員可查看但不可新增、修改或刪除', async () => {
    const user = authDb('user');
    await assertSucceeds(getDoc(doc(user, 'logs/test')));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'logs/test')));
    await assertFails(setDoc(doc(user, 'logs/new'), { Status: 'Open' }));
    await assertFails(updateDoc(doc(user, 'logs/test'), { Status: 'Closed' }));
    await assertFails(deleteDoc(doc(user, 'logs/test')));
    await assertSucceeds(updateDoc(doc(authDb('admin'), 'logs/test'), { Status: 'Closed' }));
});

test('一般成員可查詢完整維修與值日紀錄列表，未登入者不可讀取，也不開放修改他人的值日', async () => {
    // The page subscribes to a collection: a single-document get alone does not
    // establish that the production listener's list query is authorized.
    const week = '2026-08-31';
    await env.withSecurityRulesDisabled(async ctx => setDoc(doc(ctx.firestore(), 'duty_records', week), {
        week_start: week, assigned_to: 'admin-student', status: 'pending',
        submitted: false, cleaning: {}, supplies: {}, note: ''
    }));
    const user = authDb('user');
    for (const name of ['logs', 'duty_records']) {
        const result = await assertSucceeds(getDocs(collection(user, name)));
        assert.equal(result.size, 1);
        await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), name)));
    }
    const otherDuty = doc(user, 'duty_records', week);
    await assertFails(updateDoc(otherDuty, { note: '不可修改他人紀錄' }));
    await assertFails(deleteDoc(otherDuty));
});

test('正式規則修補：維修列表開放登入者唯讀，保留舊管理員與值日授權', async () => {
    const productionRules = await readFile(new URL('../rules/production.firestore.rules', import.meta.url), 'utf8');
    const candidateRules = await readFile(new URL('../firestore.rules', import.meta.url), 'utf8');
    const config = { projectId, firestore: { host: '127.0.0.1', port: 8085 } };
    let production;
    try {
        production = await initializeTestEnvironment({ ...config, firestore: { ...config.firestore, rules: productionRules } });
        await production.withSecurityRulesDisabled(async ctx => {
            await setDoc(doc(ctx.firestore(), 'admins/admin'), {});
            await setDoc(doc(ctx.firestore(), 'duty_records/2026-08-31'), {
                week_start: '2026-08-31', assigned_to: 'admin-student', submitted: false,
                status: 'pending', cleaning: {}, supplies: {}, note: ''
            });
        });
        const user = production.authenticatedContext('user').firestore();
        const admin = production.authenticatedContext('admin').firestore();
        const anonymous = production.unauthenticatedContext().firestore();
        for (const name of ['logs', 'duty_records']) {
            assert.equal((await assertSucceeds(getDocs(collection(user, name)))).size, 1);
            await assertFails(getDocs(collection(anonymous, name)));
            await assertSucceeds(getDocs(collection(admin, name)));
        }
        await assertFails(setDoc(doc(user, 'logs/new'), { Status: 'Open' }));
        await assertFails(updateDoc(doc(user, 'logs/test'), { Status: 'Closed' }));
        await assertFails(deleteDoc(doc(user, 'logs/test')));
        await assertFails(updateDoc(doc(user, 'duty_records/2026-08-31'), { note: 'denied' }));
        await assertFails(deleteDoc(doc(user, 'duty_records/2026-08-31')));
        await assertFails(getDocs(collection(user, 'accounting')));
        await assertSucceeds(getDoc(doc(admin, 'accounting/test')));
        await assertSucceeds(setDoc(doc(admin, 'logs/new'), { Status: 'Open' }));
        await assertSucceeds(updateDoc(doc(admin, 'logs/new'), { Status: 'Closed' }));
        await assertSucceeds(deleteDoc(doc(admin, 'logs/new')));
    } finally {
        await production?.cleanup();
        const restored = await initializeTestEnvironment({ ...config, firestore: { ...config.firestore, rules: candidateRules } });
        await restored.cleanup();
    }
});

test('聘僱月額恢復基本值會刪除單月調整，保留其他月份', async () => {
    const db = authDb('admin');
    const record = { _id: 'adjust-test', declared_start_month: '2026-08', declared_end_month: '2027-01',
        average_start_month: '2026-08', average_end_month: '2027-01', base_monthly_amount: 6000,
        month_overrides: { '2026-09': { amount: 0, reason: '暫停' }, '2026-10': { amount: 8000, reason: '增加' } } };
    await setDoc(doc(db, 'employments/adjust-test'), record);
    await saveEmploymentMonthAdjustment(db, record, '2026-09', 6000, '');
    const saved = (await getDoc(doc(db, 'employments/adjust-test'))).data();
    assert.equal(Object.hasOwn(saved.month_overrides, '2026-09'), false);
    assert.equal(saved.month_overrides['2026-10'].amount, 8000);
});

test('清空本學期計畫預算真正移除欄位，保留其他學期與建立時間', async () => {
    const db = authDb('admin');
    await setDoc(doc(db, 'projects/budget-test'), { name: '示範', created_at: 'original',
        semester_budgets: { '115-1': { available: 10000 }, '115-2': { available: 20000 } } });
    await saveProjectDetails(db, 'budget-test', { name: '更名', created_at: 'wrong', updated_at: 'now', semester_budgets: {} }, true, '115-1', null);
    const saved = (await getDoc(doc(db, 'projects/budget-test'))).data();
    assert.equal(Object.hasOwn(saved.semester_budgets, '115-1'), false);
    assert.equal(saved.semester_budgets['115-2'].available, 20000);
    assert.equal(saved.created_at, 'original');
});
test('學號不是身分證明：已驗證、未驗證及預設 Admin 的自行認領全部拒絕', async () => {
    await assertFails(updateDoc(doc(authDb('unverified', false), 'members/new-student'), { Google_UID: 'unverified' }));
    await assertFails(updateDoc(doc(authDb('outsider'), 'members/unbound-admin'), { Google_UID: 'outsider' }));
    await assertFails(updateDoc(doc(authDb('new-user'), 'members/new-student'), { Google_UID: 'new-user' }));
    await assertFails(updateDoc(doc(authDb('outsider'), 'members/new-student'), { Google_UID: 'outsider' }));
});

test('既有綁定只允許同步本人已驗證 Google 身分，不得偽造信箱或修改綁定', async () => {
    const ref = doc(authDb('user'), 'members/user-student');
    await assertSucceeds(updateDoc(ref, { Google_Email: 'user@example.test' }));
    await assertFails(updateDoc(ref, { Google_Email: 'someone-else@example.test' }));
    await assertFails(updateDoc(ref, { Google_UID: 'someone-else' }));
    await assertFails(updateDoc(doc(authDb('user', false), 'members/user-student'), { Google_Email: 'user@example.test' }));
    await assertFails(updateDoc(doc(authDb('outsider'), 'members/user-student'), { Google_Email: 'outsider@example.test' }));
});
test('一般成員不可自行升權、建立白名單或偽造 UID', async () => {
    const db = authDb('user');
    await assertFails(updateDoc(doc(db, 'members/user-student'), { Role: 'Admin' }));
    await assertFails(setDoc(doc(db, 'admins/user'), { student_id: 'user-student', registered_at: 'now' }));
    await assertFails(updateDoc(doc(db, 'members/new-student'), { Google_UID: 'someone-else' }));
});
test('實際授權 helper 原子升權，撤權立刻失效', async () => {
    const db = authDb('admin');
    await assertSucceeds(saveMemberAccess(db, 'user-student', { Role: 'Admin' }, 'admin'));
    const user = authDb('user');
    await assertSucceeds(getDoc(doc(user, 'accounting/test')));
    await assertSucceeds(saveMemberAccess(db, 'user-student', { Role: 'User' }, 'admin'));
    await assertFails(getDoc(doc(user, 'accounting/test')));
    assert.equal((await getDoc(doc(db, 'admins/user'))).exists(), false);
});
test('角色或 UID 不符時拒絕白名單，交易失敗不留部分寫入', async () => {
    const db = authDb('admin');
    await assertFails(runTransaction(db, async tx => {
        tx.update(doc(db, 'members/user-student'), { Role: 'Admin' });
        tx.set(doc(db, 'admins/wrong-uid'), { student_id: 'user-student', registered_at: 'now' });
    }));
    assert.equal((await getDoc(doc(db, 'members/user-student'))).data().Role, 'User');
    assert.equal((await getDoc(doc(db, 'admins/wrong-uid'))).exists(), false);
});
test('解除綁定與刪除都清理白名單，保留解除前身分歷史', async () => {
    const db = authDb('admin');
    await saveMemberAccess(db, 'user-student', { Role: 'Admin' }, 'admin');
    await unbindMemberAccess(db, 'user-student', 'admin');
    const member = (await getDoc(doc(db, 'members/user-student'))).data();
    assert.equal(member.Google_UID, null);
    assert.deepEqual(member.Previous_Google_UIDs, ['user']);
    await assertFails(getDoc(doc(authDb('user'), 'accounting/test')));
    await saveMemberAccess(db, 'user-student', { Google_UID: 'user', Role: 'Admin' }, 'admin');
    await deleteMemberAccess(db, 'user-student', 'admin');
    assert.equal((await getDoc(doc(db, 'admins/user'))).exists(), false);
    await assertFails(getDoc(doc(authDb('user'), 'accounting/test')));
});
test('學號轉移在同一交易更新有效白名單', async () => {
    const db = authDb('admin');
    await saveMemberAccess(db, 'user-student', { Role: 'Admin' }, 'admin');
    await runTransaction(db, async tx => {
        const before = (await tx.get(doc(db, 'members/user-student'))).data();
        const after = { ...before, Student_ID: 'migrated-student' };
        syncMemberAdminRegistry(tx, db, before, after, 'now');
        tx.set(doc(db, 'members/migrated-student'), after);
        tx.delete(doc(db, 'members/user-student'));
    });
    assert.equal((await getDoc(doc(db, 'admins/user'))).data().student_id, 'migrated-student');
    await assertSucceeds(getDoc(doc(authDb('user'), 'accounting/test')));
});
test('缺操作者、自行撤權、未綁定 Admin 在 helper 直接拒絕', async () => {
    const db = authDb('admin');
    await assert.rejects(saveMemberAccess(db, 'new-student', { Role: 'User' }, undefined), /操作者/);
    await assert.rejects(saveMemberAccess(db, 'admin-student', { Role: 'User' }, 'admin'), /自己的管理權限/);
    await assert.rejects(saveMemberAccess(db, 'unbound-admin', { Role: 'Admin' }, 'admin'), /完成 Google 綁定/);
});

test('值日清單未完成或仍待叫貨不得提交，全部完成才可提交', async () => {
    const db = authDb('user');
    const path = 'duty_records/2026-09-07';
    await env.withSecurityRulesDisabled(async ctx => setDoc(doc(ctx.firestore(), path), {
        assigned_to: 'user-student', submitted: false, cleaning: {}, supplies: {}, status: 'pending'
    }));
    const submission = { submitted: true, status: 'submitted', submitted_at: 'now' };
    await assertFails(updateDoc(doc(db, path), submission));
    const cleaning = Object.fromEntries(DUTY_CLEANING_TASKS.map(item => [item.id, true]));
    const supplies = Object.fromEntries(DUTY_SUPPLY_ITEMS.map(item => [item.id, 'sufficient']));
    await assertSucceeds(updateDoc(doc(db, path), { cleaning, supplies: { ...supplies, acetone: 'needs_order' } }));
    await assertFails(updateDoc(doc(db, path), submission));
    await assertSucceeds(updateDoc(doc(db, path), { supplies }));
    await assertSucceeds(updateDoc(doc(db, path), submission));
    await assertFails(updateDoc(doc(db, path), { note: 'changed after submission' }));
});

test('值日草稿拒絕錯誤型別、任意欄位、超長備註及非指派者', async () => {
    const path = 'duty_records/2026-09-07';
    await env.withSecurityRulesDisabled(async ctx => setDoc(doc(ctx.firestore(), path), {
        week_start: '2026-09-07', assigned_to: 'user-student', submitted: false,
        cleaning: {}, supplies: {}, status: 'pending'
    }));
    const ref = doc(authDb('user'), path);
    for (const patch of [
        { cleaning: 'completed' }, { cleaning: { sweep: 'true' } },
        { cleaning: { extra: true } }, { supplies: { acetone: 'anything' } },
        { supplies: { extra: 'ordered' } }, { supplies: [] },
        { note: 'x'.repeat(1001) }, { assigned_to: 'new-student' }
    ]) await assertFails(updateDoc(ref, patch));
    await assertFails(updateDoc(doc(authDb('outsider'), path), { cleaning: { sweep: true } }));
    await assertSucceeds(updateDoc(ref, { cleaning: { sweep: true }, supplies: { acetone: false } }));
    await assertSucceeds(updateDoc(ref, { supplies: { acetone: 'needs_order' }, note: '暫存' }));
});

test('值日順延必須有相符的新週，已順延的舊清單不能再編輯或提交', async () => {
    const week = '2026-09-07';
    const nextWeek = '2026-09-14';
    const user = authDb('user');
    const ref = doc(user, 'duty_records', week);
    await env.withSecurityRulesDisabled(async ctx => setDoc(doc(ctx.firestore(), 'duty_records', week), {
        week_start: week, assigned_to: 'user-student', submitted: false,
        cleaning: {}, supplies: {}, status: 'pending'
    }));
    const carry = { status: 'carried_over', carried_over_to: nextWeek };
    await assertFails(updateDoc(ref, carry));
    const successor = {
        week_start: nextWeek, assigned_to: 'user-student', scheduled_to: 'user-student',
        assignment_source: 'carryover', carried_from: week, status: 'pending', submitted: false,
        cleaning: {}, supplies: {}, note: '', created_by_uid: 'user', created_by_student_id: 'user-student'
    };
    const wrong = writeBatch(user);
    wrong.set(doc(user, 'duty_records', nextWeek), { ...successor, carried_from: '2026-08-31' });
    wrong.update(ref, carry);
    await assertFails(wrong.commit());
    const batch = writeBatch(user);
    batch.set(doc(user, 'duty_records', nextWeek), successor);
    batch.update(ref, carry);
    await assertSucceeds(batch.commit());
    await assertFails(updateDoc(ref, { cleaning: { sweep: true } }));
    await assertFails(updateDoc(ref, { submitted: true, status: 'submitted', submitted_at: 'now' }));
    await assertSucceeds(updateDoc(doc(user, 'duty_records', nextWeek), { cleaning: { sweep: true } }));
});

test('實際匯入保留自訂位置、原子備份，重試不覆寫原始備份', async () => {
    const db = authDb('admin');
    const original = { Property_ID: 'P-A-00', Name: 'old', Location: '機房', Personal_Remark: '櫃子第二層', Status: 'Checked' };
    await setDoc(doc(db, 'inventory/P-A-00'), original);
    const payloads = parseInventoryRows([{ 財物編號: 'P', 校號: 'A', 財物名稱: 'new' }], [original]);
    await writeInventoryImportChunk(db, payloads, 'test-job');
    await writeInventoryImportChunk(db, payloads, 'test-job');
    const actual = (await getDoc(doc(db, 'inventory/P-A-00'))).data();
    assert.equal(actual.Name, 'new');
    assert.equal(actual.Location, '機房');
    assert.equal(actual.Personal_Remark, '櫃子第二層');
    assert.equal(actual.Status, 'Checked');
    assert.deepEqual((await getDoc(doc(db, 'inventory_archive/test-job_P-A-00'))).data().before, original);
    await assertFails(writeInventoryImportChunk(authDb('user'), payloads, 'denied-job'));
    assert.equal((await getDoc(doc(db, 'inventory_archive/denied-job_P-A-00'))).exists(), false);
});

test('表格批次恢復月額真正刪除欄位，保留其他管理員更新的月份', async () => {
    const db = authDb('admin');
    const ref = doc(db, 'employments/inline-months');
    const original = { '2026-09': { amount: 0, reason: '暫停' }, '2026-10': { amount: 7000, reason: '既有調整' } };
    await setDoc(ref, { created_at: 'original', month_overrides: original });
    await updateDoc(ref, { 'month_overrides.2026-10': { amount: 9000, reason: '另一人稍後更新' } });
    const next = { '2026-10': original['2026-10'], '2026-11': { amount: 0, reason: '新停聘' } };
    const batch = writeBatch(db);
    batch.update(ref, { remark: '表格修改', ...employmentOverrideUpdates(original, next) });
    await batch.commit();
    const saved = (await getDoc(ref)).data();
    assert.equal(Object.hasOwn(saved.month_overrides, '2026-09'), false);
    assert.equal(saved.month_overrides['2026-10'].amount, 9000);
    assert.equal(saved.month_overrides['2026-11'].amount, 0);
    assert.equal(saved.created_at, 'original');
});
