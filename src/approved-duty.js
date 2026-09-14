import { db } from './firebase.js';
import { dutyModule } from './duty.js';
import { saveApprovedDutyAssignment } from './approved-duty-access.js';
import { escapeHtml } from './utils.js';
import { dutyRotationRoster, sameDutyRoster } from './duty-rotation.js';
import { advanceDutyRotation, syncDutyRotationRoster } from './duty-rotation-access.js';

export const approvedDutyModule = {
    syncAutomaticDuty() {
        if (!this.currentMember || this.currentRole === 'Guest' || this._autoDutyPending || !this.membersLoaded
            || !['duty_records', 'duty_assignments', 'duty_rotation'].every(k => this.realtimeLoadState[k] === 'loaded')) return;
        const week = this._getDutyWeekId(), state = this.data.duty_rotation.find(s => s._id === 'current');
        const current = this.data.duty_records.find(r => r._id === week);
        const roster = this.currentRole === 'Admin' ? dutyRotationRoster(this.data.members) : null;
        const refreshRoster = roster && !sameDutyRoster(state, roster);
        if (current && state?.week === week && !refreshRoster) return;
        const key = JSON.stringify([this.currentUser.uid, week, state?.week, !!current, roster]);
        if (this._autoDutyAttempt === key) return;
        this._autoDutyAttempt = key; this._autoDutyPending = true; this._autoDutyError = '';
        const uid = this.currentUser.uid, studentId = this.currentMember.Student_ID;
        const anchor = this.data.duty_records.filter(r => r._id <= week).sort((a, b) => b._id.localeCompare(a._id))[0]?._id;
        (async () => {
            if (refreshRoster) await syncDutyRotationRoster(db, roster, anchor);
            if (this.currentUser?.uid !== uid) return;
            await advanceDutyRotation(db, week, (w, id, source, extra) => this._buildDutyRecordPayload(w, id, source,
                { ...extra, created_by_uid: uid, created_by_student_id: studentId }));
        })().catch(error => { if (this.currentUser?.uid !== uid) return;
            this._autoDutyError = error.code === 'permission-denied'
            ? '排班或成員狀態已變更，請重新整理；若仍失敗請聯絡管理員。' : error.message;
        }).finally(() => { this._autoDutyPending = false; this.renderDuty(); this.renderOverview(); });
    },
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
            carryoverFrom: this.data.duty_records.find(r => r._id === record.carried_from) || null,
            carryoverCount: record.carryover_count || 0, needsCarryoverSync: false };
    },
    renderDuty() {
        this.syncAutomaticDuty();
        const host = document.getElementById('duty-content');
        if (!host) return;
        if (this.currentRole === 'Guest' || !this._dutyRecordsAreLoaded()) return dutyModule.renderDuty.call(this);
        if (!this.membersLoaded || this.realtimeLoadState.duty_assignments !== 'loaded') {
            host.innerHTML = '<div class="duty-card" role="status">正在載入輪值名單…</div>'; return;
        }
        const weekId = this._getDutyWeekId();
        const result = this._getCurrentDutyPerson();
        const note = host.querySelector('#duty-note');
        if (note && note.value !== note.defaultValue && this.currentRole !== 'Admin'
            && result?.assignedTo !== this.currentMember?.Student_ID) {
            this._dutyHandoverDraft = { week: weekId, uid: this.currentUser.uid, text: note.value };
        }
        if (result?.member) { dutyModule.renderDuty.call(this); this.renderDutyAssistance?.(); return; }
        host.innerHTML = `<div class="duty-card" role="status"><h3>${result ? '本週指派需要核對' : '正在接續本週輪值'}</h3>
            <p>${escapeHtml(this._autoDutyError || '系統會依原輪值順序自動建立清單，不需要每週核准。')}</p>
            ${this._autoDutyError ? '<button class="btn btn-secondary" onclick="app._autoDutyAttempt=null;app.renderDuty()">重試自動排班</button>' : ''}
            ${this.currentRole === 'Admin' && (result || this._autoDutyError) ? '<button class="btn btn-secondary" onclick="app.openCurrentDutyAlignmentModal()">調整本週排班</button>' : ''}</div>`;
    },
    async saveCurrentDutyAlignment() {
        if (this.currentRole !== 'Admin') return;
        const id = document.getElementById('current-duty-assignee')?.value;
        if (!this._getDutyRoster().some(m => m.Student_ID === id)) return;
        const button = document.getElementById('btn-align-current-duty'); if (button) button.disabled = true;
        try {
            const week = this._getDutyWeekId();
            await saveApprovedDutyAssignment(db, week, this._buildDutyRecordPayload(week, id, 'manual'), {
                replace: true, reason: document.getElementById('duty-reassign-reason')?.value.trim() || '管理員調整本週排班',
                fromName: this.getMemberName(this._getCurrentDutyPerson()?.assignedTo), toName: this.getMemberName(id) });
            this.closeModal('current-duty-alignment-modal'); this.showNotification('已更新本週排班。', 'success');
        } catch (error) { this.showNotification(error.message, 'error'); }
        finally { if (button) button.disabled = false; }
    },
    async saveNextDutyAssignment(week) {
        if (this.currentRole !== 'Admin') return;
        const id = document.getElementById('next-duty-assignee')?.value;
        if (!this._getDutyRoster().some(m => m.Student_ID === id)) return;
        const button = document.getElementById('btn-save-next-duty'); if (button) button.disabled = true;
        try {
            await saveApprovedDutyAssignment(db, week, this._buildDutyRecordPayload(week, id, 'manual'), {
                replace: true, toName: this.getMemberName(id), reason: '管理員設定下週排班' });
            this.closeModal('next-duty-modal'); this.showNotification('已設定下週排班。', 'success');
        } catch (error) { this.showNotification(error.message, 'error'); }
        finally { if (button) button.disabled = false; }
    }
};
