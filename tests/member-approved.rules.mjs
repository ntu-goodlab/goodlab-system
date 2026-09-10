import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where,
    serverTimestamp, Timestamp, writeBatch, runTransaction } from 'firebase/firestore';
import { requestApprovedMembership, approveMembershipRequest, saveApprovedMember,
    revokeApprovedMembership, memberDirectoryEntry, syncApprovedMemberTransfer } from '../src/approved-member-access.js';
import { initializeApprovedDuty, saveApprovedDutyAssignment } from '../src/approved-duty-access.js';
import { planApprovedMigration } from '../src/approved-migration-plan.js';
import { inviteDutyAssistance, respondDutyAssistance } from '../src/duty-assistance-access.js';
import { getDutyWeekId } from '../src/duty-schedule.js';

const projectId = 'demo-goodlab-security';
if (process.env.GOODLAB_RULES_TEST !== 'local-only'
    || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8085'
    || process.env.GCLOUD_PROJECT !== projectId) throw new Error('Use the isolated local rules runner only');
let env;
const claims = uid => ({ email: `${uid}@example.test`, email_verified: true,
    name: uid, firebase: { sign_in_provider: 'google.com' } });
const dbFor = (uid, overrides = {}) => env.authenticatedContext(uid, { ...claims(uid), ...overrides }).firestore();
const publicDb = () => env.unauthenticatedContext().firestore();
const member = (uid, role = 'User', extra = {}) => ({ Student_ID: `${uid}-student`,
    Google_UID: uid, Google_Email: `${uid}@example.test`, Google_Display_Name: uid,
    Name_Ch: uid, Name_En: '', Degree: 'Master', Status: 'Active', Role: role,
    Phone: 'private-phone', Previous_Google_UIDs: ['private-history'], ...extra });
const access = (uid, role = 'User', extra = {}) => ({ student_id: `${uid}-student`,
    email: `${uid}@example.test`, role, approved_by: 'bootstrap', approved_at: Timestamp.fromMillis(1), ...extra });
const week = '2026-09-07';
const duty = (id = week, assigned = 'user-student', extra = {}) => ({ week_start: id,
    assigned_to: assigned, scheduled_to: assigned, assignment_source: 'auto',
    status: 'pending', submitted: false, cleaning: {}, supplies: {}, note: '',
    created_by_uid: 'admin', created_by_student_id: 'admin-student', ...extra });
const fullCleaning = Object.fromEntries(['sweep', 'trash', 'supply_check', 'water', 'fingerprint'].map(k => [k, true]));
const fullSupplies = Object.fromEntries(['acetone', 'methanol', 'detergent', 'n2_tank', 'wiper',
    'glass_slide', 'gloves_s', 'gloves_m', 'gloves_l', 'cotton_swab', 'aluminum_foil', 'pe_gloves'].map(k => [k, 'sufficient']));
async function assistanceFixture() {
    const current = getDutyWeekId();
    await seed({ 'members/helper-student': member('helper'), 'member_access/helper': access('helper'),
        'member_directory/helper-student': memberDirectoryEntry(member('helper'), access('helper')),
        [`duty_records/${current}`]: duty(current, 'user-student', { cleaning: { sweep: true }, note: 'preserve progress' }),
        [`duty_assignments/${current}`]: { assigned_to: 'user-student', scheduled_to: 'user-student', assignment_source: 'auto' } });
    return current;
}
async function inviteFixture(requestId = 'invitation') {
    const week = await assistanceFixture();
    await inviteDutyAssistance(dbFor('user'), { requestId, week, fromStudent: 'user-student', toStudent: 'helper-student', note: 'private handover' });
    return week;
}
async function seed(values) {
    await env.withSecurityRulesDisabled(async context => {
        await Promise.all(Object.entries(values).map(([path, data]) => setDoc(doc(context.firestore(), path), data)));
    });
}
before(async () => {
    env = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port: 8085,
        rules: await readFile(new URL('../rules/member-approved.firestore.rules', import.meta.url), 'utf8') } });
});
after(async () => env?.cleanup());
beforeEach(async () => {
    await env.clearFirestore();
    const fixtures = {
        'members/unbound': member('', 'User', { Student_ID: 'unbound', Google_UID: null, Google_Email: null }),
        'admins/legacy': {}, 'admins/admin': {},
        'logs/test': { Status: 'Open' }, 'instruments/test': { Name: 'Instrument' },
        'inventory/test': { Status: 'Pending', Checked_By: null, Checked_By_Student_ID: null },
        'inventory/_SETTINGS_': { IsOpen: true },
        [`duty_records/${week}`]: duty(),
        [`duty_assignments/${week}`]: { assigned_to: 'user-student', scheduled_to: 'user-student', assignment_source: 'auto' },
        'bulletins/public': { published: true }, 'bulletins/private': { published: false },
        'routines/public': { visible_to_users: true }, 'routines/private': { visible_to_users: false },
        'accounting/test': { Amount: 100 }, 'projects/test': {}, 'employments/test': {},
        'inventory_archive/year/items/test': { Name: 'Archived' }
    };
    for (const [uid, role] of [['admin', 'Admin'], ['second', 'Admin'], ['user', 'User']]) {
        const profile = member(uid, role);
        fixtures[`members/${uid}-student`] = profile;
        fixtures[`member_access/${uid}`] = access(uid, role);
        fixtures[`member_directory/${uid}-student`] = memberDirectoryEntry(profile, access(uid, role));
    }
    await seed(fixtures);
});

const labPaths = ['members/user-student', 'member_directory/user-student', 'logs/test', 'instruments/test',
    'inventory/test', `duty_records/${week}`, `duty_assignments/${week}`, 'bulletins/public',
    'routines/public', 'accounting/test', 'projects/test', 'employments/test', 'inventory_archive/year/items/test'];
test('未登入與已驗證但未核准 Guest 都不能讀取任何實驗室集合，含列表查詢', async () => {
    for (const db of [publicDb(), dbFor('guest')]) {
        for (const path of labPaths) await assertFails(getDoc(doc(db, path)));
        for (const name of ['members', 'member_directory', 'member_access', 'access_requests', 'admins',
            'logs', 'instruments', 'inventory', 'duty_records', 'duty_assignments', 'bulletins', 'routines',
            'accounting', 'projects', 'employments', 'duty_requests', 'duty_events']) await assertFails(getDocs(collection(db, name)));
    }
});
test('未驗證信箱、非 Google 登入及信箱不符，即使 UID 有授權也拒絕', async () => {
    for (const overrides of [{ email_verified: false }, { email: 'different@example.test' },
        { firebase: { sign_in_provider: 'anonymous' } }, { firebase: { sign_in_provider: 'password' } }]) {
        const db = dbFor('user', overrides);
        await assertFails(getDocs(collection(db, 'logs')));
        await assertFails(getDoc(doc(db, 'members/user-student')));
    }
});
test('核准成員可讀共同資料與自己的私有資料，不能列出私有名單或看他人完整資料', async () => {
    const db = dbFor('user');
    for (const name of ['member_directory', 'logs', 'instruments', 'inventory', 'duty_records', 'duty_assignments']) {
        await assertSucceeds(getDocs(collection(db, name)));
    }
    await assertSucceeds(getDoc(doc(db, 'members/user-student')));
    await assertFails(getDoc(doc(db, 'members/admin-student')));
    await assertFails(getDocs(collection(db, 'members')));
    const directory = (await getDocs(collection(db, 'member_directory'))).docs[0].data();
    assert.equal('Google_UID' in directory, false);
    assert.equal('Phone' in directory, false);
});
test('本人可查核自己的 UID 授權狀態；Guest 不可取得他人的 UID 登錄', async () => {
    assert.equal((await assertSucceeds(getDoc(doc(dbFor('guest'), 'member_access/guest')))).exists(), false);
    await assertFails(getDoc(doc(dbFor('guest'), 'member_access/user')));
    await assertFails(getDocs(collection(dbFor('user'), 'member_access')));
});
test('維修紀錄：核准成員可 get/list，只有管理員能 create/update/delete', async () => {
    const user = dbFor('user'); const admin = dbFor('admin');
    await assertSucceeds(getDoc(doc(user, 'logs/test')));
    await assertSucceeds(getDocs(collection(user, 'logs')));
    for (const db of [publicDb(), dbFor('guest'), user]) {
        await assertFails(setDoc(doc(db, 'logs/new'), { Status: 'Open' }));
        await assertFails(updateDoc(doc(db, 'logs/test'), { Status: 'Closed' }));
        await assertFails(deleteDoc(doc(db, 'logs/test')));
    }
    await assertSucceeds(setDoc(doc(admin, 'logs/new'), { Status: 'Open' }));
    await assertSucceeds(updateDoc(doc(admin, 'logs/new'), { Status: 'Closed' }));
    await assertSucceeds(deleteDoc(doc(admin, 'logs/new')));
});
test('行政資料與盤點備份只有核准管理員可讀寫，舊 admins 白名單不授權', async () => {
    for (const db of [dbFor('user'), dbFor('guest'), dbFor('legacy')]) {
        for (const name of ['accounting', 'projects', 'employments']) {
            await assertFails(getDocs(collection(db, name)));
            await assertFails(setDoc(doc(db, name, 'new'), {}));
            await assertFails(updateDoc(doc(db, name, 'test'), { x: 1 }));
            await assertFails(deleteDoc(doc(db, name, 'test')));
        }
        await assertFails(getDoc(doc(db, 'inventory_archive/year/items/test')));
    }
    for (const path of ['accounting/new', 'projects/new', 'employments/new', 'inventory_archive/year/items/new']) {
        const ref = doc(dbFor('admin'), path);
        await assertSucceeds(setDoc(ref, { n: 1 }));
        await assertSucceeds(getDoc(ref));
        await assertSucceeds(updateDoc(ref, { n: 2 }));
        await assertSucceeds(deleteDoc(ref));
    }
});
test('公告與行事必須使用可見性查詢，成員不能整批讀出未公開資料', async () => {
    for (const [name, flag] of [['bulletins', 'published'], ['routines', 'visible_to_users']]) {
        const user = dbFor('user');
        await assertFails(getDocs(collection(user, name)));
        assert.equal((await assertSucceeds(getDocs(query(collection(user, name), where(flag, '==', true))))).size, 1);
        await assertFails(getDoc(doc(user, name, 'private')));
        await assertFails(getDocs(query(collection(dbFor('guest'), name), where(flag, '==', true))));
        assert.equal((await assertSucceeds(getDocs(collection(dbFor('admin'), name)))).size, 2);
    }
});
test('名冊角色或 UID 單獨存在、錯配、离校及殘留授權都不授權', async () => {
    for (const profile of [member('ghost', 'User', { Google_UID: 'different' }),
        member('ghost', 'Admin'), member('ghost', 'User', { Status: 'Alumni' }),
        member('ghost', 'User', { Google_Email: 'other@example.test' })]) {
        await seed({ 'members/ghost-student': profile, 'member_access/ghost': access('ghost') });
        await assertFails(getDocs(collection(dbFor('ghost'), 'logs')));
    }
    await seed({ 'member_access/missing': access('missing'), 'members/legacy-student': member('legacy', 'Admin') });
    await assertFails(getDocs(collection(dbFor('missing'), 'logs')));
    await assertFails(getDocs(collection(dbFor('legacy'), 'accounting')));
});
test('Guest 申請只寫自己的 token 信箱，不因填入他人學號或 Admin 字樣取得權限', async () => {
    const db = dbFor('guest');
    await assertSucceeds(requestApprovedMembership(db, { uid: 'guest', email: 'guest@example.test',
        emailVerified: true, displayName: 'guest' }, 'admin-student'));
    await assertFails(getDocs(collection(db, 'logs')));
    await assertFails(updateDoc(doc(db, 'access_requests/guest'), { role: 'Admin' }));
    await assertFails(updateDoc(doc(db, 'access_requests/guest'), { email: 'admin@example.test' }));
    await assertFails(setDoc(doc(db, 'access_requests/other'), { student_id: 'unbound',
        email: 'guest@example.test', display_name: 'guest', requested_at: serverTimestamp() }));
    await assertFails(setDoc(doc(db, 'member_access/guest'), access('guest', 'Admin')));
    await assertFails(updateDoc(doc(db, 'members/unbound'), { Google_UID: 'guest', Role: 'Admin' }));
    await assertFails(setDoc(doc(db, 'admins/guest'), {}));
});
test('核准 helper 原子建立唯一 UID、成員及公開名錄，首次核准固定為 User', async () => {
    const guest = dbFor('guest');
    await requestApprovedMembership(guest, { uid: 'guest', email: 'guest@example.test', emailVerified: true, displayName: 'guest' }, 'unbound');
    await assertSucceeds(approveMembershipRequest(dbFor('admin'), {
        uid: 'guest', studentId: 'unbound', expectedEmail: 'guest@example.test', actorUid: 'admin' }));
    await assertSucceeds(getDocs(collection(guest, 'logs')));
    await assertFails(getDocs(collection(guest, 'accounting')));
    assert.equal((await getDoc(doc(guest, 'member_access/guest'))).data().role, 'User');
    assert.equal((await getDoc(doc(guest, 'access_requests/guest'))).exists(), false);
});
test('一般成員無法核准別人的申請；核對信箱或學號改變時核准 helper 拒絕', async () => {
    await requestApprovedMembership(dbFor('guest'), { uid: 'guest', email: 'guest@example.test', emailVerified: true, displayName: 'guest' }, 'unbound');
    const params = { uid: 'guest', studentId: 'unbound', expectedEmail: 'guest@example.test', actorUid: 'user' };
    await assertFails(approveMembershipRequest(dbFor('user'), params));
    await assert.rejects(approveMembershipRequest(dbFor('admin'), { ...params, actorUid: 'admin', expectedEmail: 'changed@example.test' }), /重新核對/);
    assert.equal((await getDoc(doc(dbFor('guest'), 'member_access/guest'))).exists(), false);
});
test('管理員也不能建立雙重 UID 綁定、單邊授權或不一致的角色', async () => {
    const admin = dbFor('admin');
    await assertFails(updateDoc(doc(admin, 'members/unbound'), { Google_UID: 'user', Google_Email: 'user@example.test' }));
    await assertFails(setDoc(doc(admin, 'member_access/stranger'), { ...access('stranger'), approved_by: 'admin', approved_at: serverTimestamp() }));
    await assertFails(updateDoc(doc(admin, 'members/user-student'), { Role: 'Admin' }));
    const batch = writeBatch(admin);
    batch.update(doc(admin, 'members/unbound'), { Google_UID: 'user', Google_Email: 'user@example.test' });
    batch.set(doc(admin, 'member_access/user'), { ...access('user'), student_id: 'unbound', approved_by: 'admin', approved_at: serverTimestamp() });
    await assertFails(batch.commit());
    assert.equal((await getDoc(doc(admin, 'member_access/user'))).data().student_id, 'user-student');
});
test('核准紀錄不可偽造核准人、時間或多餘欄位', async () => {
    for (const patch of [{ approved_by: 'user' }, { approved_at: Timestamp.fromMillis(1) }, { superuser: true }]) {
        await assertFails(setDoc(doc(dbFor('admin'), 'member_access/user'), {
            ...access('user'), approved_by: 'admin', approved_at: serverTimestamp(), ...patch }));
    }
});
test('升降權 helper 與成員角色原子同步；降權後同一登入狀態立即失去行政讀取', async () => {
    const admin = dbFor('admin'); const user = dbFor('user');
    await assertSucceeds(saveApprovedMember(admin, 'user-student', { Role: 'Admin' }, 'admin'));
    await assertSucceeds(getDocs(collection(user, 'accounting')));
    await assertSucceeds(saveApprovedMember(admin, 'user-student', { Role: 'User' }, 'admin'));
    await assertFails(getDocs(collection(user, 'accounting')));
    await assertSucceeds(getDocs(collection(user, 'logs')));
});

test('舊綁定已離校者不能直接升權；明確恢復核准後可升降權並保留登入讀取', async () => {
    const admin = dbFor('admin'), legacy = dbFor('legacy');
    await seed({ 'members/legacy-student': member('legacy', 'User', { Status: 'Alumni', Leave_Date: '2025-06-30' }) });
    await assert.rejects(saveApprovedMember(admin, 'legacy-student', { Role: 'Admin', Status: 'Active' }, 'admin'), /尚未核准/);
    assert.equal((await getDoc(doc(admin, 'members/legacy-student'))).data().Status, 'Alumni');
    await requestApprovedMembership(legacy, { uid: 'legacy', email: 'legacy@example.test', emailVerified: true, displayName: 'legacy' }, 'legacy-student');
    const params = { uid: 'legacy', studentId: 'legacy-student', expectedEmail: 'legacy@example.test', actorUid: 'admin' };
    await assert.rejects(approveMembershipRequest(admin, params), /明確確認/);
    await assertFails(getDocs(collection(legacy, 'logs')));
    await assertSucceeds(approveMembershipRequest(admin, { ...params, expectedMemberStatus: 'Alumni', reactivateInactive: true }));
    const profile = (await getDoc(doc(admin, 'members/legacy-student'))).data();
    assert.equal(profile.Status, 'Active'); assert.equal(profile.Role, 'User'); assert.equal(profile.Leave_Date, '');
    assert.deepEqual(profile.Previous_Leave_Dates, ['2025-06-30']);
    await assertSucceeds(getDocs(collection(legacy, 'logs')));
    await assertFails(getDocs(collection(legacy, 'accounting')));
    await assertSucceeds(saveApprovedMember(admin, 'legacy-student', { Role: 'Admin', Status: 'Active', Name_Ch: 'Updated' }, 'admin'));
    await assertSucceeds(getDocs(collection(legacy, 'accounting')));
    await assertSucceeds(saveApprovedMember(admin, 'legacy-student', { Role: 'User', Status: 'Active' }, 'admin'));
    await assertFails(getDocs(collection(legacy, 'accounting')));
    await assertSucceeds(getDocs(collection(legacy, 'logs')));
});

test('管理員可修正未核准舊成員狀態；一般儲存不能授權或更换身分', async () => {
    const admin = dbFor('admin');
    await seed({ 'members/legacy-student': member('legacy', 'User', { Status: 'Alumni' }) });
    await assertSucceeds(saveApprovedMember(admin, 'legacy-student', { Role: 'User', Status: 'Active', Phone: 'corrected' }, 'admin'));
    await assertFails(getDocs(collection(dbFor('legacy'), 'logs')));
    assert.equal((await getDoc(doc(admin, 'member_access/legacy'))).exists(), false);
    for (const patch of [{ Role: 'Admin' }, { Google_UID: 'other' }, { Google_Email: 'other@example.test' }]) {
        await assertFails(updateDoc(doc(admin, 'members/legacy-student'), patch));
    }
    await assertFails(updateDoc(doc(dbFor('user'), 'members/legacy-student'), { Status: 'Alumni' }));
    await assertFails(updateDoc(doc(dbFor('legacy'), 'members/legacy-student'), { Status: 'Alumni' }));
});

test('舊綁定沒有授權文件時也可解除或刪除，不刪除別人的 UID 授權', async () => {
    const admin = dbFor('admin');
    await seed({ 'members/legacy-student': member('legacy'), 'members/legacy2-student': member('legacy2'),
        'members/conflicting-student': member('user', 'User', { Student_ID: 'conflicting-student' }) });
    await assertSucceeds(revokeApprovedMembership(admin, 'legacy-student', 'admin'));
    assert.equal((await getDoc(doc(admin, 'members/legacy-student'))).data().Google_UID, null);
    await assertSucceeds(revokeApprovedMembership(admin, 'legacy2-student', 'admin', { deleteMember: true }));
    await assert.rejects(revokeApprovedMembership(admin, 'conflicting-student', 'admin'), /其他成員/);
    await assertSucceeds(getDocs(collection(dbFor('user'), 'logs')));
});

test('核准舊綁定時拒絕 UID／信箱衝突及確認後變更的成員狀態', async () => {
    const admin = dbFor('admin');
    await seed({ 'members/legacy-student': member('legacy', 'User', { Status: 'Alumni' }) });
    await requestApprovedMembership(dbFor('legacy'), { uid: 'legacy', email: 'legacy@example.test', emailVerified: true, displayName: 'legacy' }, 'legacy-student');
    const params = { uid: 'legacy', studentId: 'legacy-student', expectedEmail: 'legacy@example.test', actorUid: 'admin', expectedMemberStatus: 'Alumni', reactivateInactive: true };
    await seed({ 'members/legacy-student': member('other', 'User', { Student_ID: 'legacy-student', Status: 'Alumni' }) });
    await assert.rejects(approveMembershipRequest(admin, params), /其他 Google/);
    await seed({ 'members/legacy-student': member('legacy', 'User', { Status: 'Alumni', Google_Email: 'other@example.test' }) });
    await assert.rejects(approveMembershipRequest(admin, params), /信箱不一致/);
    await seed({ 'members/legacy-student': member('legacy') });
    await assert.rejects(approveMembershipRequest(admin, params), /狀態已變更/);
    await assertSucceeds(approveMembershipRequest(admin, { ...params, expectedMemberStatus: 'Active', reactivateInactive: false }));
    await assertSucceeds(getDocs(collection(dbFor('legacy'), 'logs')));
});
test('撤銷與刪除 helper 清除 UID 授權，舊登入狀態失效，其他成員不受影響', async () => {
    const admin = dbFor('admin'); const user = dbFor('user');
    await assertSucceeds(revokeApprovedMembership(admin, 'user-student', 'admin'));
    await assertFails(getDocs(collection(user, 'logs')));
    assert.equal((await getDoc(doc(user, 'member_access/user'))).exists(), false);
    const profile = (await getDoc(doc(admin, 'members/user-student'))).data();
    assert.equal(profile.Google_UID, null);
    assert.ok(profile.Previous_Google_UIDs.includes('user'));
    await assertSucceeds(revokeApprovedMembership(admin, 'second-student', 'admin', { deleteMember: true }));
    await assertFails(getDocs(collection(dbFor('second'), 'accounting')));
    assert.equal((await getDoc(doc(admin, 'member_directory/second-student'))).exists(), false);
    await assertSucceeds(getDocs(collection(admin, 'accounting')));
});
test('成員離校立即失去權限，即使 UID 授權尚未清除', async () => {
    await assertSucceeds(saveApprovedMember(dbFor('admin'), 'user-student', { Status: 'Alumni' }, 'admin'));
    await assertFails(getDocs(collection(dbFor('user'), 'logs')));
});
test('管理員不能自行修改授權欄位或刪除自己的存取權；其他管理員可撤銷', async () => {
    const admin = dbFor('admin');
    await assertFails(deleteDoc(doc(admin, 'member_access/admin')));
    await assertFails(updateDoc(doc(admin, 'members/admin-student'), { Status: 'Alumni' }));
    await assertFails(deleteDoc(doc(admin, 'members/admin-student')));
    await assertSucceeds(revokeApprovedMembership(dbFor('second'), 'admin-student', 'second'));
    await assertFails(getDocs(collection(admin, 'logs')));
});
test('成員只能同步 token 中的顯示名稱，不能改 UID、角色、信箱、狀態或私有欄位', async () => {
    const ref = doc(dbFor('user'), 'members/user-student');
    await assertSucceeds(updateDoc(ref, { Google_Display_Name: 'user' }));
    for (const patch of [{ Google_Display_Name: 'impersonated' }, { Role: 'Admin' }, { Google_UID: 'other' },
        { Google_Email: 'other@example.test' }, { Status: 'Alumni' }, { Phone: 'forged' }]) {
        await assertFails(updateDoc(ref, patch));
    }
});
test('公開名錄拒絕額外隱私欄位及冒名內容，即使寫入者是管理員', async () => {
    const ref = doc(dbFor('admin'), 'member_directory/user-student');
    await assertFails(updateDoc(ref, { Google_Email: 'secret@example.test' }));
    await assertFails(updateDoc(ref, { Phone: 'secret' }));
    await assertFails(updateDoc(ref, { Name_Ch: 'different person' }));
    await assertSucceeds(saveApprovedMember(dbFor('admin'), 'user-student', { Name_Ch: 'Updated' }, 'admin'));
    assert.equal((await getDoc(doc(dbFor('user'), 'member_directory/user-student'))).data().Name_Ch, 'Updated');
});
test('盤點僅開放時可更新白名單欄位，操作者必須是核准成員本人', async () => {
    const db = dbFor('user'); const ref = doc(db, 'inventory/test');
    const valid = { Status: 'Checked', Checked_By: 'user', Checked_By_Student_ID: 'user-student',
        Updated_By_UID: 'user', Updated_By_Student_ID: 'user-student', Updated_At: new Date().toISOString() };
    await assertSucceeds(updateDoc(ref, valid));
    for (const patch of [{ Updated_By_UID: 'admin' }, { Updated_By_Student_ID: 'admin-student' },
        { Purchase_Price: 0 }, { Personal_Remark: 'x'.repeat(501) }, { Location: 100 }]) {
        await assertFails(updateDoc(ref, { ...valid, ...patch }));
    }
    await assertFails(updateDoc(doc(db, 'inventory/_SETTINGS_'), { IsOpen: false }));
    await updateDoc(doc(dbFor('admin'), 'inventory/_SETTINGS_'), { IsOpen: false });
    await assertFails(updateDoc(ref, { ...valid, Location: 'other' }));
});
test('沒有管理員排班時不能自行建立值日紀錄；有效排班者才可建立', async () => {
    const next = '2026-09-14'; const db = dbFor('user');
    const record = duty(next, 'user-student', { created_by_uid: 'user', created_by_student_id: 'user-student' });
    await assertFails(setDoc(doc(db, 'duty_records', next), record));
    await assertFails(setDoc(doc(db, 'duty_assignments', next), { assigned_to: 'user-student', scheduled_to: 'user-student', assignment_source: 'auto' }));
    await setDoc(doc(dbFor('admin'), 'duty_assignments', next), {
        assigned_to: 'user-student', scheduled_to: 'user-student', assignment_source: 'auto' });
    await assertSucceeds(setDoc(doc(db, 'duty_records', next), record));
});
test('值日只允許指派者改草稿，不能改指派對象、刪除紀錄或新增任意欄位', async () => {
    const user = dbFor('user'); const ref = doc(user, 'duty_records', week);
    await assertSucceeds(updateDoc(ref, { cleaning: { sweep: true }, note: 'draft', updated_at: new Date().toISOString() }));
    for (const patch of [{ assigned_to: 'admin-student' }, { cleaning: { sweep: 'yes' } },
        { supplies: { unknown: true } }, { note: 'x'.repeat(1001) }, { random: true }]) {
        await assertFails(updateDoc(ref, patch));
    }
    await assertFails(deleteDoc(ref));
    await seed({ 'member_access/other': access('other'), 'members/other-student': member('other') });
    await assertFails(updateDoc(doc(dbFor('other'), 'duty_records', week), { note: 'not my duty' }));
});
test('未完成的值日不能提交；完整提交後不得由成員再次修改', async () => {
    const ref = doc(dbFor('user'), 'duty_records', week);
    const submit = { status: 'submitted', submitted: true, submitted_at: new Date().toISOString() };
    await assertFails(updateDoc(ref, submit));
    await updateDoc(ref, { cleaning: fullCleaning, supplies: { ...fullSupplies, acetone: 'needs_order' } });
    await assertFails(updateDoc(ref, submit));
    await updateDoc(ref, { supplies: fullSupplies });
    await assertSucceeds(updateDoc(ref, submit));
    await assertFails(updateDoc(ref, { note: 'after submission' }));
});
test('順延必須有匹配且已排班的新週，原子建立新週與鎖定舊週', async () => {
    const next = '2026-09-14'; const db = dbFor('user');
    const carried = duty(next, 'user-student', { created_by_uid: 'user', created_by_student_id: 'user-student',
        assignment_source: 'carryover', carried_from: week });
    await assertFails(updateDoc(doc(db, 'duty_records', week), { status: 'carried_over', carried_over_to: next }));
    await setDoc(doc(dbFor('admin'), 'duty_assignments', next), { assigned_to: 'user-student',
        scheduled_to: 'user-student', assignment_source: 'carryover', carried_from: week });
    const batch = writeBatch(db);
    batch.set(doc(db, 'duty_records', next), carried);
    batch.update(doc(db, 'duty_records', week), { status: 'carried_over', carried_over_to: next });
    await assertSucceeds(batch.commit());
    await assertFails(updateDoc(doc(db, 'duty_records', week), { note: 'locked' }));
});
test('未知集合及已知集合中的未宣告子集合預設拒絕，包括管理員', async () => {
    for (const db of [publicDb(), dbFor('guest'), dbFor('user'), dbFor('admin')]) {
        for (const path of ['unknown/test', 'logs/test/private/test', 'members/user-student/secrets/test']) {
            await assertFails(getDoc(doc(db, path)));
            await assertFails(setDoc(doc(db, path), {}));
        }
    }
});

test('既有已確認 Google 帳號遷移後直接登入，不需再次申請', async () => {
    const profile = member('existing');
    const plan = planApprovedMigration({ members: [profile], authUsers: [{ uid: 'existing',
        email: 'existing@example.test', emailVerified: true, disabled: false,
        providerData: [{ providerId: 'google.com' }] }], approvedUids: ['existing'] });
    assert.equal(plan.confirmed.length, 1);
    // Simulate the separately authorized trusted migration using ONLY fake data.
    const row = plan.confirmed[0];
    await seed({ [`members/${row.studentId}`]: profile,
        [`member_access/${row.uid}`]: access('existing'),
        [`member_directory/${row.studentId}`]: memberDirectoryEntry(profile) });
    const db = dbFor('existing');
    await assertSucceeds(getDocs(collection(db, 'logs')));
    assert.equal((await getDoc(doc(db, 'access_requests/existing'))).exists(), false);
});

test('新版學號移轉 helper 原子更新 UID、私有成員與共用名錄，舊 member 文件刪除', async () => {
    const admin = dbFor('admin');
    await assertSucceeds(runTransaction(admin, async tx => {
        const oldRef = doc(admin, 'members/user-student');
        const snapshot = await tx.get(oldRef);
        const before = snapshot.data();
        const after = { ...before, Student_ID: 'new-student' };
        await syncApprovedMemberTransfer(tx, admin, before, after, 'admin');
        tx.set(doc(admin, 'members/new-student'), after); tx.delete(oldRef);
    }));
    const user = dbFor('user');
    await assertSucceeds(getDoc(doc(user, 'members/new-student')));
    await assertFails(getDoc(doc(user, 'members/user-student')));
    assert.equal((await getDoc(doc(user, 'member_access/user'))).data().student_id, 'new-student');
    assert.equal((await getDoc(doc(admin, 'member_directory/user-student'))).exists(), false);
});

test('原有未核准綁定不能藉學號轉移取得授權', async () => {
    await seed({ 'members/legacy-student': member('legacy') });
    const admin = dbFor('admin');
    await assert.rejects(runTransaction(admin, async tx => {
        const snapshot = await tx.get(doc(admin, 'members/legacy-student'));
        await syncApprovedMemberTransfer(tx, admin, snapshot.data(), { ...snapshot.data(), Student_ID: 'new-student' }, 'admin');
    }), /尚未完成授權核對/);
});

test('核准排班 helper 只有 Admin 可呼叫成功，初始建立不覆寫既有清單', async () => {
    const next = '2026-09-14';
    await assertFails(saveApprovedDutyAssignment(dbFor('user'), next, duty(next, 'user-student', { created_by_uid: 'user' })));
    await assertSucceeds(saveApprovedDutyAssignment(dbFor('admin'), next, duty(next)));
    await updateDoc(doc(dbFor('user'), 'duty_records', next), { note: 'keep draft' });
    await assertSucceeds(initializeApprovedDuty(dbFor('user'), next, () => { throw new Error('must not rebuild'); }));
    assert.equal((await getDoc(doc(dbFor('user'), 'duty_records', next))).data().note, 'keep draft');
});

test('核准順延 helper 一次建立指派及新週、鎖定舊週；已提交週不可覆蓋', async () => {
    const admin = dbFor('admin'); const next = '2026-09-14';
    await assertSucceeds(saveApprovedDutyAssignment(admin, next, duty(next, 'user-student', {
        assignment_source: 'carryover', carried_from: week }), { carryFrom: week }));
    assert.equal((await getDoc(doc(admin, 'duty_records', week))).data().status, 'carried_over');
    await assertFails(updateDoc(doc(dbFor('user'), 'duty_records', week), { note: 'locked' }));
    await seed({ [`duty_records/${next}`]: duty(next, 'user-student', { status: 'submitted', submitted: true }) });
    await assert.rejects(saveApprovedDutyAssignment(admin, next, duty(next), { replace: true }), /已提交/);
});

test('歷史值日格式可由 Admin 只移轉學號引用，不能讓一般成員藉此改指派或繞過提交檢查', async () => {
    const path = 'duty_records/2025-09-01';
    await seed({ [path]: { assigned_to: 'user-student', submitted: true, status: 'submitted', legacy_field: 'keep' } });
    await assertFails(updateDoc(doc(dbFor('user'), path), { assigned_to: 'other' }));
    await assertSucceeds(updateDoc(doc(dbFor('admin'), path), { assigned_to: 'new-student' }));
    assert.equal((await getDoc(doc(dbFor('admin'), path))).data().legacy_field, 'keep');
    await assertFails(updateDoc(doc(dbFor('admin'), path), { assigned_to: 'user-student', note: 'unrelated edit' }));
});


test('代做由受邀一般成員接受才交接，保留進度與原排定，提交後舊本人不可寫', async () => {
    const week = await inviteFixture();
    const user = dbFor('user'), helper = dbFor('helper');
    await assertFails(updateDoc(doc(helper, 'duty_records', week), { note: 'before acceptance' }));
    await assertSucceeds(respondDutyAssistance(helper, { requestId: 'invitation', action: 'accepted', studentId: 'helper-student' }));
    const r = (await getDoc(doc(helper, 'duty_records', week))).data();
    assert.equal(r.assigned_to, 'helper-student'); assert.equal(r.scheduled_to, 'user-student');
    assert.deepEqual(r.cleaning, { sweep: true }); assert.equal(r.note, 'preserve progress');
    assert.equal((await getDoc(doc(helper, 'duty_assignments', week))).data().assigned_to, 'helper-student');
    assert.equal((await getDoc(doc(helper, 'duty_events/invitation'))).data().from_student, 'user-student');
    await assertFails(updateDoc(doc(user, 'duty_records', week), { note: 'stale write' }));
    await assertSucceeds(updateDoc(doc(helper, 'duty_records', week), { cleaning: fullCleaning, supplies: fullSupplies }));
    await assertSucceeds(updateDoc(doc(helper, 'duty_records', week), { submitted: true, status: 'submitted', submitted_at: new Date().toISOString(), submitted_by: 'helper-student' }));
    await assertSucceeds(respondDutyAssistance(helper, { requestId: 'invitation', action: 'accepted', studentId: 'helper-student' }));
    await assertFails(updateDoc(doc(helper, 'duty_events/invitation'), { from_student: 'helper-student' }));
});

test('取消／婉拒不交接，重新邀請不能接受舊 ID；每週只有一個有效邀請', async () => {
    const week = await inviteFixture();
    await assertFails(inviteDutyAssistance(dbFor('user'), { requestId: 'duplicate', week, fromStudent: 'user-student', toStudent: 'helper-student' }));
    await respondDutyAssistance(dbFor('user'), { requestId: 'invitation', action: 'cancelled', studentId: 'user-student' });
    await assert.rejects(respondDutyAssistance(dbFor('helper'), { requestId: 'invitation', action: 'accepted', studentId: 'helper-student' }), /已處理/);
    await inviteDutyAssistance(dbFor('user'), { requestId: 'new-invitation', week, fromStudent: 'user-student', toStudent: 'helper-student' });
    await respondDutyAssistance(dbFor('helper'), { requestId: 'new-invitation', action: 'declined', studentId: 'helper-student' });
    assert.equal((await getDoc(doc(dbFor('user'), 'duty_records', week))).data().assigned_to, 'user-student');
});

test('不接受代做時不能直接改指派、偽造接受歷史，Admin 也不能替受邀者接受', async () => {
    const week = await inviteFixture();
    for (const db of [dbFor('user'), dbFor('second'), dbFor('admin')]) {
        await assertFails(updateDoc(doc(db, 'duty_requests/invitation'), { status: 'accepted', responded_at: serverTimestamp() }));
    }
    await assertFails(updateDoc(doc(dbFor('helper'), 'duty_records', week), { assigned_to: 'helper-student' }));
    await assertFails(setDoc(doc(dbFor('helper'), 'duty_events/fake'), { week, kind: 'accepted' }));
    await assertFails(getDoc(doc(dbFor('stranger'), 'duty_requests/invitation')));
    await assertSucceeds(getDoc(doc(dbFor('second'), 'duty_requests/invitation')));
});

test('私人邀請只能由當事人及管理員讀取，名錄資格不能偽造', async () => {
    await inviteFixture();
    await seed({ 'members/observer-student': member('observer'), 'member_access/observer': access('observer') });
    await assertFails(getDoc(doc(dbFor('observer'), 'duty_requests/invitation')));
    await assertSucceeds(getDocs(query(collection(dbFor('helper'), 'duty_requests'), where('to_student', '==', 'helper-student'), where('to_access_at', '==', Timestamp.fromMillis(1)))));
    await assertFails(getDocs(collection(dbFor('helper'), 'duty_requests')));
    await assertFails(updateDoc(doc(dbFor('admin'), 'member_directory/helper-student'), { duty_access_at: Timestamp.fromMillis(2) }));
});

test('邀請後撤權、提交或更換排班不能接受；過去週不能邀請', async () => {
    const week = await inviteFixture();
    await saveApprovedMember(dbFor('admin'), 'user-student', { Status: 'Alumni' }, 'admin');
    await assert.rejects(respondDutyAssistance(dbFor('helper'), { requestId: 'invitation', action: 'accepted', studentId: 'helper-student' }), /過期或人員/);
    await assistanceFixture();
    await assert.rejects(inviteDutyAssistance(dbFor('user'), { requestId: 'old', week: '2000-01-03', fromStudent: 'user-student', toStudent: 'helper-student' }));
});

// Use raw batches to test the server independently of client validation.
async function rawAcceptance(db, requestId = 'invitation') {
    const d = (await getDoc(doc(db, 'duty_requests', requestId))).data();
    const r = (await getDoc(doc(db, 'duty_records', d.week))).data();
    const batch = writeBatch(db);
    batch.update(doc(db, 'duty_requests', requestId), { status: 'accepted', responded_at: serverTimestamp() });
    batch.update(doc(db, 'duty_records', d.week), { assigned_to: d.to_student, assignment_source: 'substitute',
        substitute_from: d.from_student, assist_request: null, assignment_revision: (r.assignment_revision || 0) + 1, assist_event: requestId });
    batch.set(doc(db, 'duty_assignments', d.week), { assigned_to: d.to_student, scheduled_to: r.scheduled_to,
        assignment_source: 'substitute', carried_from: r.carried_from || null });
    batch.set(doc(db, 'duty_events', requestId), { week: d.week, kind: 'accepted', from_student: d.from_student,
        to_student: d.to_student, from_name: d.from_name, to_name: d.to_name, at: serverTimestamp() });
    return batch;
}

test('接受交易不能夾帶修改其他週的指派或紀錄', async () => {
    await inviteFixture(); const db = dbFor('helper');
    const other = '2030-01-07';
    await seed({ [`duty_records/${other}`]: duty(other), [`duty_assignments/${other}`]: { assigned_to: 'user-student', scheduled_to: 'user-student', assignment_source: 'auto' } });
    const batch = await rawAcceptance(db);
    batch.update(doc(db, 'duty_records', other), { assist_event: 'invitation', assigned_to: 'helper-student' });
    await assertFails(batch.commit());
    const second = await rawAcceptance(db);
    second.update(doc(db, 'duty_assignments', other), { assigned_to: 'helper-student' });
    await assertFails(second.commit());
    assert.equal((await getDoc(doc(db, 'duty_requests/invitation'))).data().status, 'pending');
});

test('伺服器拒絕過期邀請、過期後改時間與撤權但名錄尚未更新的帳號', async () => {
    const week = await inviteFixture(); const db = dbFor('helper');
    const request = (await getDoc(doc(db, 'duty_requests/invitation'))).data();
    await seed({ 'duty_requests/invitation': { ...request, expires_at: Timestamp.fromMillis(Date.now() - 1) } });
    await assertFails((await rawAcceptance(db)).commit());
    const forged = await rawAcceptance(db);
    forged.update(doc(db, 'duty_requests/invitation'), { expires_at: request.expires_at });
    await assertFails(forged.commit());
    await seed({ 'duty_requests/invitation': request, 'members/user-student': member('user', 'User', { Status: 'Alumni' }) });
    await assertFails((await rawAcceptance(db)).commit());
    assert.equal((await getDoc(doc(db, 'duty_records', week))).data().assigned_to, 'user-student');
});

test('管理員改派保留進度並使邀請失效；已提交清單不能再接受', async () => {
    const week = await inviteFixture(); const helper = dbFor('helper');
    await saveApprovedDutyAssignment(dbFor('admin'), week, duty(week, 'user-student', { updated_at: new Date().toISOString() }), { replace: true });
    await assertFails((await rawAcceptance(helper)).commit());
    const r = (await getDoc(doc(helper, 'duty_records', week))).data();
    assert.equal(r.note, 'preserve progress'); assert.deepEqual(r.cleaning, { sweep: true });
    await inviteDutyAssistance(dbFor('user'), { requestId: 'second-invite', week, fromStudent: 'user-student', toStudent: 'helper-student' });
    await updateDoc(doc(dbFor('user'), 'duty_records', week), { cleaning: fullCleaning, supplies: fullSupplies });
    await updateDoc(doc(dbFor('user'), 'duty_records', week), { submitted: true, status: 'submitted', submitted_at: new Date().toISOString(), submitted_by: 'user-student' });
    await assertFails((await rawAcceptance(helper, 'second-invite')).commit());
});

test('接受與取消同時操作只有一個結果，重複接受不會重複交接', async () => {
    const week = await inviteFixture();
    const results = await Promise.allSettled([
        respondDutyAssistance(dbFor('user'), { requestId: 'invitation', action: 'cancelled', studentId: 'user-student' }),
        respondDutyAssistance(dbFor('helper'), { requestId: 'invitation', action: 'accepted', studentId: 'helper-student' })
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const admin = dbFor('admin'), invite = (await getDoc(doc(admin, 'duty_requests/invitation'))).data();
    const r = (await getDoc(doc(admin, 'duty_records', week))).data();
    assert.equal(r.assigned_to, invite.status === 'accepted' ? 'helper-student' : 'user-student');
    assert.equal((await getDoc(doc(admin, 'duty_events/invitation'))).exists(), invite.status === 'accepted');
});

test('A→B→Admin 的接受鏈保留原輪值 A，順延仍由 A 承接', async () => {
    const week = await inviteFixture();
    await respondDutyAssistance(dbFor('helper'), { requestId: 'invitation', action: 'accepted', studentId: 'helper-student' });
    await inviteDutyAssistance(dbFor('helper'), { requestId: 'chain', week, fromStudent: 'helper-student', toStudent: 'admin-student' });
    await respondDutyAssistance(dbFor('admin'), { requestId: 'chain', action: 'accepted', studentId: 'admin-student' });
    const r = (await getDoc(doc(dbFor('admin'), 'duty_records', week))).data();
    assert.equal(r.assigned_to, 'admin-student'); assert.equal(r.scheduled_to, 'user-student');
    assert.equal(r.assignment_revision, 2);
    const next = getDutyWeekId(Date.parse(`${week}T00:00:00+08:00`) + 7 * 86400000);
    await saveApprovedDutyAssignment(dbFor('admin'), next, duty(next, 'user-student', { assignment_source: 'carryover', carried_from: week }), { carryFrom: week });
    assert.equal((await getDoc(doc(dbFor('admin'), 'duty_records', next))).data().assigned_to, 'user-student');
});

test('刪除受邀成員後能另邀有效成員；不能邀自己或未核准者', async () => {
    const week = await inviteFixture();
    await revokeApprovedMembership(dbFor('admin'), 'helper-student', 'admin', { deleteMember: true });
    await assertSucceeds(inviteDutyAssistance(dbFor('user'), { requestId: 'replacement', week, fromStudent: 'user-student', toStudent: 'admin-student' }));
    await assert.rejects(inviteDutyAssistance(dbFor('user'), { requestId: 'self', week, fromStudent: 'user-student', toStudent: 'user-student' }), /自己/);
    await assert.rejects(inviteDutyAssistance(dbFor('user'), { requestId: 'unapproved', week, fromStudent: 'user-student', toStudent: 'unbound' }));
});

test('邀請不能夾帶另一週的指標，也不能把舊週偽裝成目前週', async () => {
    const week = await inviteFixture(); const user = dbFor('user');
    const original = (await getDoc(doc(user, 'duty_requests/invitation'))).data();
    await respondDutyAssistance(user, { requestId: 'invitation', action: 'cancelled', studentId: 'user-student' });
    const other = '2000-01-03'; await seed({ [`duty_records/${other}`]: duty(other) });
    const create = (id, payload) => {
        const b = writeBatch(user); b.set(doc(user, 'duty_requests', id), { ...payload, created_at: serverTimestamp() });
        b.update(doc(user, 'duty_records', payload.week), { assist_request: id }); return b;
    };
    const batch = create('cross', original);
    batch.update(doc(user, 'duty_records', other), { assist_request: 'cross' });
    await assertFails(batch.commit());
    await assertFails(create('spoof', { ...original, week: other }).commit());
    const start = Date.parse(`${other}T00:00:00+08:00`);
    await assertFails(create('expired', { ...original, week: other, week_start_at: Timestamp.fromMillis(start), expires_at: Timestamp.fromMillis(start + 7 * 86400000) }).commit());
});

test('兩筆同時邀請只能成立一筆；接受與提交不會同時生效', async () => {
    const week = await assistanceFixture(), user = dbFor('user'), helper = dbFor('helper');
    const requests = await Promise.allSettled(['first','second'].map(requestId => inviteDutyAssistance(user, { requestId, week, fromStudent:'user-student', toStudent:'helper-student' })));
    assert.equal(requests.filter(r => r.status === 'fulfilled').length, 1);
    const requestId = requests.find(r => r.status === 'fulfilled').value;
    await updateDoc(doc(user, 'duty_records', week), { cleaning:fullCleaning, supplies:fullSupplies });
    const results = await Promise.allSettled([
        respondDutyAssistance(helper,{requestId,action:'accepted',studentId:'helper-student'}),
        updateDoc(doc(user,'duty_records',week),{status:'submitted',submitted:true,submitted_at:new Date().toISOString(),submitted_by:'user-student'})
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const record = (await getDoc(doc(helper,'duty_records',week))).data();
    assert.equal(record.assigned_to, record.submitted ? 'user-student' : 'helper-student');
});

test('受邀者改為 Admin 後舊核准身分邀請失效，重邀才可接受', async () => {
    const week = await inviteFixture();
    await saveApprovedMember(dbFor('admin'),'helper-student',{Role:'Admin'},'admin');
    await assertFails((await rawAcceptance(dbFor('helper'))).commit());
    await inviteDutyAssistance(dbFor('user'),{requestId:'new-role',week,fromStudent:'user-student',toStudent:'helper-student'});
    await assertSucceeds(respondDutyAssistance(dbFor('helper'),{requestId:'new-role',action:'accepted',studentId:'helper-student'}));
});
