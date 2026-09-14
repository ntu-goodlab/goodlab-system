import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dutyRotationRoster, nextDutyAssignment, sameDutyRoster } from '../src/duty-rotation.js';
import { escapeHtml } from '../src/utils.js';

test('輪值沿原排班循環；代做完成不跳過 helper 的輪值，未完成回到原輪值者', () => {
    const members = ['a', 'b'].map(Student_ID => ({ Student_ID, Role:'User', Status:'Active', Degree:'Master' }));
    const roster = dutyRotationRoster([...members, { Student_ID:'admin', Role:'Admin', Status:'Active', Degree:'Master' }]);
    const state = { ...roster, week:'2026-09-07' };
    assert.equal(nextDutyAssignment(state, {scheduled_to:'a',assigned_to:'b',submitted:true}).assigned_to, 'b');
    assert.equal(nextDutyAssignment(state, {scheduled_to:'a',assigned_to:'b',submitted:false}).assigned_to, 'a');
    assert.equal(nextDutyAssignment(state, {scheduled_to:'b',submitted:true}).assigned_to, 'a');
    assert.equal(nextDutyAssignment(state, {scheduled_to:'retired',submitted:false}).assigned_to, 'a');
    assert.equal(sameDutyRoster(state, {first:'a',successors:{b:'a',a:'b'}}), true);
    assert.throws(() => nextDutyAssignment(dutyRotationRoster([]), null), /沒有/);
});

test('管理紀錄只有 Admin 可見、預設收合，使用段落避免外凸列表圓點', () => {
    const source = readFileSync(new URL('../src/duty-assistance.js', import.meta.url), 'utf8');
    const method = source.split('renderDutyEventHistory(week) {')[1].split('\n    },')[0];
    const render = new Function('escapeHtml','when','stampMillis', `return function(week) {${method}\n}`)(escapeHtml,String,Number);
    const app = {currentRole:'User',data:{duty_events:[{week:'week',kind:'admin',at:1,to_name:'<script>',reason:'test'}]}};
    assert.equal(render.call(app,'week'), '');
    app.currentRole = 'Admin'; const html = render.call(app,'week');
    assert.match(html, /<details class="duty-audit">/); assert.match(html, /管理紀錄（1）/);
    assert.doesNotMatch(html, /<li|<ul|<script>|\bopen\b/); assert.match(html, /&lt;script&gt;/);
});
