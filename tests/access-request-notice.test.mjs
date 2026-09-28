import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('申請提醒同步數量，清空／撤權／登出／載入失敗時移除，按鈕連到申請區', () => {
    const source = readFileSync(new URL('../src/approved-auth.js', import.meta.url), 'utf8');
    const method = source.split('renderAccessRequestNotice() {')[1].split('\n    },')[0];
    let notice, opened = 0;
    const badges = new Set();
    const entries = Array.from({length:4}, () => ({append: badge => badges.add(badge)}));
    const document = {
        getElementById: () => notice,
        querySelectorAll: selector => selector === '.access-request-count' ? [...badges] : entries,
        querySelector: () => ({prepend: element => { notice = element; }}),
        createElement: () => {
            const title = {}, button = {addEventListener: (_, fn) => { button.click = fn; }};
            const element = {setAttribute() {}, querySelector: name => name === 'button' ? button : title,
                remove: () => { badges.delete(element); if (notice === element) notice = undefined; }};
            return element;
        }
    };
    const render = new Function('document', `return function() {${method}\n}`)(document);
    const app = {currentUser:{uid:'admin'},currentRole:'Admin',_approvedState:{status:'ready'},
        realtimeLoadState:{access_requests:'loaded'},data:{access_requests:[{},{}]},openAccessRequests:()=>{opened++;}};
    render.call(app);
    assert.equal(notice.querySelector('strong').textContent, '2 筆帳號開通申請待核准');
    assert.equal(badges.size,4);
    notice.querySelector('button').click(); assert.equal(opened,1);
    const previous = notice; render.call(app); assert.equal(notice,previous); assert.equal(badges.size,4);
    for (const hide of [() => {app.data.access_requests=[];}, () => {app.currentRole='User';},
        () => {app.currentUser=null;}, () => {app.realtimeLoadState.access_requests='error';},
        () => {app._approvedState.status='checking';}]) {
        Object.assign(app,{currentUser:{uid:'admin'},currentRole:'Admin',_approvedState:{status:'ready'},
            realtimeLoadState:{access_requests:'loaded'},data:{access_requests:[{}]}});
        render.call(app); hide(); render.call(app);
        assert.equal(notice,undefined); assert.equal(badges.size,0);
    }
});
