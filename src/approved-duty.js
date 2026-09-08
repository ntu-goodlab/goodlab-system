import { db } from './firebase.js';
import { dutyModule } from './duty.js';
import { initializeApprovedDuty, saveApprovedDutyAssignment } from './approved-duty-access.js';
import { escapeHtml } from './utils.js';

export const approvedDutyModule = {
    _buildDutyRecordPayload(weekId, scheduledTo, source = 'auto', overrides = {}) {
        return dutyModule._buildDutyRecordPayload.call(this, weekId, scheduledTo, source === 'admin' ? 'manual' : source, overrides);
    },
    _getCurrentDutyPerson() {
        const record = this.data.duty_records.find(r => r._id === this._getDutyWeekId());
        if (!record) return null;
        const roster = this._getDutyRoster();
        return { record, scheduledTo: record.scheduled_to, assignedTo: record.assigned_to,
            scheduledMember: this.data.members.find(m => m.Student_ID === record.scheduled_to),
            member: this.data.members.find(m => m.Student_ID === record.assigned_to), roster,
            carryoverFrom: null, carryoverCount: record.carryover_count || 0, needsCarryoverSync: false };
    },
    renderDuty() {
        const host = document.getElementById('duty-content');
        if (!host) return;
        if (this.currentRole === 'Guest' || !this._dutyRecordsAreLoaded()) return dutyModule.renderDuty.call(this);
        if (!this.membersLoaded || this.realtimeLoadState.duty_assignments !== 'loaded') {
            host.innerHTML = '<div class="duty-card" role="status">正在確認成員名錄與核准排班…</div>'; return;
        }
        const weekId = this._getDutyWeekId();
        const result = this._getCurrentDutyPerson();
        if (result?.member) return dutyModule.renderDuty.call(this);
        const assignment = this.data.duty_assignments.find(r => r._id === weekId);
        const canInitialize = assignment && assignment.assigned_to === this.currentMember?.Student_ID;
        const previous = this._getLatestPreviousDutyRecord(weekId);
        const canCarry = previous && !previous.submitted && previous.status !== 'carried_over';
        host.innerHTML = `<div class="duty-card"><h3>${result ? '本週指派需要核對' : '本週值日清單尚未建立'}</h3>
            <p>${assignment ? `已核准值日生：${escapeHtml(this.getMemberName(assignment.assigned_to))}` : '等待管理員確認排班。已完成的歷史紀錄仍可查看。'}</p>
            ${canInitialize && !result ? '<button class="btn btn-primary" type="button" onclick="app.initializeMyApprovedDuty()">開啟本週工作清單</button>' : ''}
            ${this.currentRole === 'Admin' ? `<button class="btn btn-primary" type="button" onclick="app.openCurrentDutyAlignmentModal()">確認本週排班</button>
                ${canCarry && !result ? '<button class="btn btn-secondary" type="button" onclick="app.approveDutyCarryover()">核對並順延上週</button>' : ''}` : ''}</div>`;
    },
    async initializeMyApprovedDuty() {
        try {
            const week = this._getDutyWeekId();
            await initializeApprovedDuty(db, week, assignment => this._buildDutyRecordPayload(week,
                assignment.scheduled_to, assignment.assignment_source, assignment));
        } catch (error) { this.showNotification(error.message, 'error'); }
    },
    async saveCurrentDutyAlignment() {
        if (this.currentRole !== 'Admin') return;
        const id = document.getElementById('current-duty-assignee')?.value;
        if (!this._getDutyRoster().some(m => m.Student_ID === id)) return;
        const button = document.getElementById('btn-align-current-duty'); if (button) button.disabled = true;
        try {
            const week = this._getDutyWeekId();
            await saveApprovedDutyAssignment(db, week, this._buildDutyRecordPayload(week, id, 'manual'), { replace: true });
            this.closeModal('current-duty-alignment-modal'); this.showNotification('已核准並建立本週排班。', 'success');
        } catch (error) { this.showNotification(error.message, 'error'); }
        finally { if (button) button.disabled = false; }
    },
    async saveNextDutyAssignment(week) {
        if (this.currentRole !== 'Admin') return;
        const id = document.getElementById('next-duty-assignee')?.value;
        if (!this._getDutyRoster().some(m => m.Student_ID === id)) return;
        const button = document.getElementById('btn-save-next-duty'); if (button) button.disabled = true;
        try {
            await saveApprovedDutyAssignment(db, week, this._buildDutyRecordPayload(week, id, 'manual'), { replace: true });
            this.closeModal('next-duty-modal'); this.showNotification('已核准並建立下週排班。', 'success');
        } catch (error) { this.showNotification(error.message, 'error'); }
        finally { if (button) button.disabled = false; }
    },
    async approveDutyCarryover() {
        if (this.currentRole !== 'Admin') return;
        const week = this._getDutyWeekId(); const previous = this._getLatestPreviousDutyRecord(week);
        if (!previous || !confirm(`確認由 ${this.getMemberName(previous.assigned_to)} 承接上週未完成的值日？`)) return;
        try {
            const payload = this._buildDutyRecordPayload(week, previous.scheduled_to || previous.assigned_to, 'carryover', {
                assigned_to: previous.assigned_to, carried_from: previous._id,
                carryover_count: Number(previous.carryover_count || 0) + 1 });
            await saveApprovedDutyAssignment(db, week, payload, { carryFrom: previous._id });
            this.showNotification('已核准順延，原週紀錄已鎖定。', 'success');
        } catch (error) { this.showNotification(error.message, 'error'); }
    }
};
