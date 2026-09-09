import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovedSession, resolveApprovedIdentity } from '../src/approved-session.js';
const user = { uid: 'u', email: 'u@example.test', emailVerified: true, signInProvider: 'google.com' };
const entry = { student_id: 'student', email: user.email, role: 'User' };
const member = { Student_ID: 'student', Google_UID: 'u', Google_Email: user.email, Role: 'User', Status: 'Active' };
const snap = (data, fromCache = false) => ({ exists: () => Boolean(data), data: () => data, metadata: { fromCache } });
function harness() {
    const watchers = [], states = [];
    const session = createApprovedSession({ watch(path, next, error) {
        const watcher = { path, next, error, stopped: false }; watchers.push(watcher);
        return () => { watcher.stopped = true; };
    }, onState: state => states.push(state) });
    return { session, watchers, states, state: () => states.at(-1) };
}
test('新版登入只先監聽自己的 UID 對應，取得伺服器確認後才訂閱自己的成員文件', () => {
    const h = harness(); h.session.start(user);
    assert.deepEqual(h.watchers.map(w => w.path), ['member_access/u']);
    h.watchers[0].next(snap(entry, true));
    assert.equal(h.watchers.length, 1); assert.equal(h.state().role, 'Guest');
    h.watchers[0].next(snap(entry));
    assert.equal(h.watchers[1].path, 'members/student');
    h.watchers[1].next(snap(member, true)); assert.equal(h.state().role, 'Guest');
    h.watchers[1].next(snap(member)); assert.equal(h.state().role, 'User');
});
test('撤權後舊成員回呼不能恢复權限，切換帳號後旧 UID 回呼無效', () => {
    const h = harness(); h.session.start(user);
    h.watchers[0].next(snap(entry)); h.watchers[1].next(snap(member));
    h.watchers[0].next(snap(null)); assert.equal(h.state().role, 'Guest');
    h.watchers[1].next(snap(member)); assert.equal(h.state().role, 'Guest');
    h.session.start({ ...user, uid: 'v', email: 'v@example.test' });
    h.watchers[0].next(snap(entry)); h.watchers[1].next(snap(member));
    assert.equal(h.state().uid, 'v'); assert.equal(h.state().role, 'Guest');
    h.session.stop(); h.watchers.at(-1).next(snap(entry)); assert.equal(h.state().uid, null);
});
test('升降權需 UID 對應與成員角色一致，離校與錯誤時拒絕', () => {
    const h = harness(); h.session.start(user);
    h.watchers[0].next(snap(entry)); h.watchers[1].next(snap(member));
    h.watchers[0].next(snap({ ...entry, role: 'Admin' })); assert.equal(h.state().role, 'Guest');
    h.watchers[1].next(snap({ ...member, Role: 'Admin' })); assert.equal(h.state().role, 'Admin');
    h.watchers[1].next(snap({ ...member, Role: 'Admin', Status: 'Alumni' })); assert.equal(h.state().role, 'Guest');
    h.watchers[1].error({ code: 'permission-denied' }); assert.equal(h.state().status, 'error');
});
test('未驗證帳號與 token 信箱不符不能靠舊角色或綁定解鎖', () => {
    assert.equal(resolveApprovedIdentity({ ...user, emailVerified: false }, entry, member), 'Guest');
    assert.equal(resolveApprovedIdentity(user, { ...entry, email: 'other' }, member), 'Guest');
    assert.equal(resolveApprovedIdentity(user, null, { ...member, Role: 'Admin' }), 'Guest');
    const h = harness(); h.session.start({ ...user, signInProvider: 'password' });
    assert.equal(h.watchers.length, 0); assert.equal(h.state().role, 'Guest');
});
