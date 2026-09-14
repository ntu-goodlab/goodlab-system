import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the actual dialog method without loading Firebase or adding a DOM library.
const source = readFileSync(new URL('../src/duty.js', import.meta.url), 'utf8');
const method = source.split('openCurrentDutyAlignmentModal: function() {')[1].split('\n    },')[0];
test('新週沒有紀錄仍能開啟選人；既有選取、空名單與已提交保護維持', () => {
    let dialog, warning;
    const document = { getElementById: () => null, createElement: () => ({}), body: { appendChild: el => { dialog = el; } } };
    const open = new Function('document', 'escapeDutyHtml', `return function() {${method}\n}`)(document, String);
    const app = { currentRole: 'Admin', approvedAccessEnabled: true, _getCurrentDutyPerson: () => null,
        _getDutyRoster: () => [{ Student_ID: 'a', Name_Ch: '甲' }, { Student_ID: 'b', Name_Ch: '乙' }],
        showNotification: message => { warning = message; } };
    open.call(app);
    assert.equal(warning, undefined);
    assert.match(dialog.innerHTML, /value="a"/); assert.match(dialog.innerHTML, /value="b"/);
    app._getCurrentDutyPerson = () => ({ record: { submitted: false }, scheduledTo: 'b' });
    open.call(app); assert.match(dialog.innerHTML, /value="b" selected/);
    dialog = null;
    app._getCurrentDutyPerson = () => ({ record: { submitted: true } });
    open.call(app); assert.equal(dialog, null); assert.match(warning, /已提交/);
    app._getCurrentDutyPerson = () => null; app._getDutyRoster = () => [];
    open.call(app); assert.equal(dialog, null); assert.match(warning, /沒有可對齊/);
});
