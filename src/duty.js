/**
 * GOODLAB — 值日生模組 (Phase 5)
 * 
 * 動態輪值（碩班非Admin）、清潔+耗材 checklist。
 * 資料模型：
 *   duty_records/{weekId}: { week_start, scheduled_to, assigned_to, assignment_source,
 *                            carried_from, carryover_count, status, substitute_pending, substitute_from,
 *                            cleaning: {sweep: false, ...}, supplies: {acetone: false, ...},
 *                            submitted: false, submitted_at: null }
 */
import { db, doc, setDoc, updateDoc, runTransaction } from './firebase.js';
import { DUTY_CLEANING_TASKS, DUTY_SUPPLY_ITEMS, SUPPLY_VENDORS, DUTY_NOTES } from './constants.js';
import { canAutoCarryOver, canInitializeDutyWeek, getDutyRoster, getDutyWeekId, hasDutyProgress } from './duty-schedule.js';

const DUTY_NOTE_MAX_LENGTH = 1000;
const escapeDutyHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
})[character]);

export const dutyModule = {

    _dutyCarryoverSyncWeek: null,
    _dutyRosterSyncWeek: null,

    _dutyRecordsAreLoaded: function() {
        return canInitializeDutyWeek(this.realtimeLoadState?.duty_records, false);
    },

    // === 取得當週 ID (ISO Week 的週一日期字串，e.g. "2026-06-09") ===
    _getDutyWeekId: function(date) {
        return getDutyWeekId(date || Date.now());
    },

    // === 取得值日生候選名單 (碩班、非Admin、在學中) ===
    _getDutyRoster: function() {
        return getDutyRoster(this.data.members);
    },

    // scheduled_to 決定後續輪值；assigned_to 是本週實際執行者（可能為代班者）。
    _getScheduledDutyId: function(record) {
        return record?.scheduled_to || record?.assigned_to || '';
    },

    _getNextDutyMember: function(roster, scheduledTo) {
        if (!roster.length) return null;
        const currentIndex = roster.findIndex(member => member.Student_ID === scheduledTo);
        if (currentIndex >= 0) return roster[(currentIndex + 1) % roster.length];

        // 舊紀錄可能仍指向已畢業成員；依學號順序接到下一位有效成員。
        return roster.find(member => String(member.Student_ID).localeCompare(
            String(scheduledTo || ''), 'en', { numeric: true, sensitivity: 'base' }
        ) > 0) || roster[0];
    },

    _getLatestPreviousDutyRecord: function(weekId) {
        return [...this.data.duty_records]
            .filter(record => record._id < weekId)
            .sort((a, b) => b._id.localeCompare(a._id))[0] || null;
    },

    _hasDutyProgress: function(record) {
        return hasDutyProgress(record);
    },

    _canAutoCarryOver: function(currentRecord) {
        return canAutoCarryOver(currentRecord);
    },

    _canAutoReplaceInactiveAssignment: function(record) {
        if (!record || record.submitted || this._hasDutyProgress(record)) return false;
        return ['auto', 'carryover'].includes(record.assignment_source || 'auto');
    },

    _buildDutyRecordPayload: function(weekId, scheduledTo, source = 'auto', overrides = {}) {
        const cleaning = {};
        DUTY_CLEANING_TASKS.forEach(task => { cleaning[task.id] = false; });
        const supplies = {};
        DUTY_SUPPLY_ITEMS.forEach(item => { supplies[item.id] = false; });
        return Object.assign({
            week_start: weekId,
            scheduled_to: scheduledTo,
            assigned_to: scheduledTo,
            assignment_source: source,
            status: 'pending',
            carried_from: null,
            carried_over_to: null,
            carryover_count: 0,
            substitute_pending: null,
            substitute_from: null,
            cleaning,
            supplies,
            note: '',
            submitted: false,
            submitted_at: null,
            created_by_uid: this.currentUser?.uid || null,
            created_by_student_id: this.currentMember?.Student_ID || null,
            updated_at: new Date().toISOString()
        }, overrides);
    },

    _canEditDutyRecord: function(record) {
        if (!record || record.submitted || !this.currentUser) return false;
        if (this.currentRole === 'Admin') return true;
        return Boolean(this.currentMember?.Student_ID && this.currentMember.Student_ID === record.assigned_to);
    },

    // === 計算本週值日生 ===
    _getCurrentDutyPerson: function() {
        const roster = this._getDutyRoster();
        if (roster.length === 0) return null;

        const weekId = this._getDutyWeekId();
        const record = this.data.duty_records.find(r => r._id === weekId);
        const previousRecord = this._getLatestPreviousDutyRecord(weekId);

        // 上一筆紀錄未提交時，同一位實際執行者承接新週清單；
        // 已有 Admin 指定、代班或實際進度的本週紀錄視為明確覆寫，不自動改寫。
        if (previousRecord && !previousRecord.submitted && this._canAutoCarryOver(record)) {
            const previousScheduledTo = this._getScheduledDutyId(previousRecord);
            const previousAssignedTo = previousRecord.assigned_to || previousScheduledTo;
            const scheduledMember = roster.find(member => member.Student_ID === previousScheduledTo)
                || this._getNextDutyMember(roster, previousScheduledTo);
            const assignedMember = roster.find(member => member.Student_ID === previousAssignedTo)
                || scheduledMember;
            const scheduledTo = scheduledMember.Student_ID;
            const assignedTo = assignedMember.Student_ID;
            return {
                record,
                scheduledTo,
                assignedTo,
                scheduledMember,
                member: assignedMember,
                roster,
                carryoverFrom: previousRecord,
                carryoverCount: Number(previousRecord.carryover_count || 0) + 1,
                needsCarryoverSync: true
            };
        }

        // 本週紀錄存在時，保留排定者與實際執行者兩種身分。
        if (record && (record.assigned_to || record.scheduled_to)) {
            const scheduledTo = this._getScheduledDutyId(record);
            const assignedTo = record.assigned_to || scheduledTo;
            const scheduledMember = roster.find(member => member.Student_ID === scheduledTo);
            const assignedMember = roster.find(member => member.Student_ID === assignedTo);
            if (!record.submitted && (!scheduledMember || !assignedMember)) {
                const fallbackMember = this._getNextDutyMember(roster, assignedTo || scheduledTo);
                if (fallbackMember && this._canAutoReplaceInactiveAssignment(record)) {
                    return {
                        record,
                        scheduledTo: fallbackMember.Student_ID,
                        assignedTo: fallbackMember.Student_ID,
                        scheduledMember: fallbackMember,
                        member: fallbackMember,
                        roster,
                        carryoverFrom: null,
                        carryoverCount: Number(record.carryover_count || 0),
                        needsCarryoverSync: false,
                        needsRosterSync: true,
                        inactiveAssignment: assignedTo || scheduledTo
                    };
                }
                return {
                    record,
                    scheduledTo,
                    assignedTo,
                    scheduledMember,
                    member: assignedMember,
                    roster,
                    carryoverFrom: null,
                    carryoverCount: Number(record.carryover_count || 0),
                    needsCarryoverSync: false,
                    invalidAssignment: true
                };
            }
            return {
                record,
                scheduledTo,
                assignedTo,
                scheduledMember: scheduledMember || this.data.members.find(m => m.Student_ID === scheduledTo),
                member: assignedMember || this.data.members.find(m => m.Student_ID === assignedTo),
                roster,
                carryoverFrom: record.carried_from
                    ? this.data.duty_records.find(item => item._id === record.carried_from) || null
                    : null,
                carryoverCount: Number(record.carryover_count || 0),
                needsCarryoverSync: false
            };
        }

        const nextMember = previousRecord
            ? this._getNextDutyMember(roster, this._getScheduledDutyId(previousRecord))
            : roster[0];
        const assignedTo = nextMember.Student_ID;
        return {
            record: null,
            scheduledTo: assignedTo,
            assignedTo,
            scheduledMember: nextMember,
            member: nextMember,
            roster,
            carryoverFrom: null,
            carryoverCount: 0,
            needsCarryoverSync: false
        };
    },

    // === 確保本週紀錄存在於 Firebase ===
    _ensureWeekRecord: async function(assignedTo) {
        const weekId = this._getDutyWeekId();
        if (!this._dutyRecordsAreLoaded()) {
            throw new Error('值日資料仍在載入，已停止建立空白清單');
        }
        if (this.currentRole !== 'Admin' && this.currentMember?.Student_ID !== assignedTo) {
            throw new Error('只有本週值日生或 Admin 可以建立工作清單');
        }

        const newRecord = this._buildDutyRecordPayload(weekId, assignedTo, 'auto');
        const recordRef = doc(db, 'duty_records', weekId);
        return runTransaction(db, async transaction => {
            const snapshot = await transaction.get(recordRef);
            // 初始載入與即時監聽可能交錯；既有資料永遠具有優先權，
            // 尤其不可覆蓋 Admin 對齊、已提交紀錄或已勾選的清單。
            if (!canInitializeDutyWeek(this.realtimeLoadState?.duty_records, snapshot.exists())) {
                return snapshot.exists() ? snapshot.data() : null;
            }
            transaction.set(recordRef, newRecord);
            return newRecord;
        });
    },

    _ensureCarryoverWeek: async function(previousRecord) {
        const weekId = this._getDutyWeekId();
        if (!previousRecord || this._dutyCarryoverSyncWeek === weekId) return;
        if (!this._dutyRecordsAreLoaded()) return;

        this._dutyCarryoverSyncWeek = weekId;
        const roster = this._getDutyRoster();
        const previousScheduledTo = this._getScheduledDutyId(previousRecord);
        const previousAssignedTo = previousRecord.assigned_to || previousScheduledTo;
        const scheduledMember = roster.find(member => member.Student_ID === previousScheduledTo)
            || this._getNextDutyMember(roster, previousScheduledTo);
        if (!scheduledMember) return;
        const assignedMember = roster.find(member => member.Student_ID === previousAssignedTo)
            || scheduledMember;
        const scheduledTo = scheduledMember.Student_ID;
        const assignedTo = assignedMember.Student_ID;
        if (this.currentRole !== 'Admin' && this.currentMember?.Student_ID !== assignedTo) {
            throw new Error('只有順延後的值日生或 Admin 可以建立本週清單');
        }
        const carryoverCount = Number(previousRecord.carryover_count || 0) + 1;
        const payload = this._buildDutyRecordPayload(weekId, scheduledTo, 'carryover', {
            assigned_to: assignedTo,
            carried_from: previousRecord._id,
            carryover_count: carryoverCount,
            substitute_from: assignedTo !== scheduledTo
                ? (previousRecord.substitute_from || scheduledTo)
                : null
        });

        try {
            const currentRef = doc(db, 'duty_records', weekId);
            const previousRef = doc(db, 'duty_records', previousRecord._id);
            await runTransaction(db, async transaction => {
                const currentSnapshot = await transaction.get(currentRef);
                const previousSnapshot = await transaction.get(previousRef);
                const currentData = currentSnapshot.exists() ? currentSnapshot.data() : null;
                const previousData = previousSnapshot.exists() ? previousSnapshot.data() : null;

                // Admin 對齊、代班、既有進度或已提交紀錄都具有優先權。
                // Transaction 會在同時寫入時重新執行，因此自動順延不能再蓋掉 Admin 結果。
                if (!previousData || previousData.submitted || !this._canAutoCarryOver(currentData)) return;

                transaction.set(currentRef, payload);
                transaction.update(previousRef, {
                    status: 'carried_over',
                    carried_over_to: weekId,
                    updated_at: new Date().toISOString()
                });
            });
        } finally {
            if (this._dutyCarryoverSyncWeek === weekId) this._dutyCarryoverSyncWeek = null;
        }
    },

    _syncInactiveDutyAssignment: async function(record, assignedTo, inactiveAssignment) {
        if (this.currentRole !== 'Admin') throw new Error('只有 Admin 可以重新對齊輪值名單');
        const weekId = this._getDutyWeekId();
        if (!record || this._dutyRosterSyncWeek === weekId) return;
        this._dutyRosterSyncWeek = weekId;
        try {
            await updateDoc(doc(db, 'duty_records', record._id), {
                scheduled_to: assignedTo,
                assigned_to: assignedTo,
                inactive_assignment_replaced: inactiveAssignment || null,
                updated_at: new Date().toISOString()
            });
        } finally {
            if (this._dutyRosterSyncWeek === weekId) this._dutyRosterSyncWeek = null;
        }
    },

    _ensureNextWeekRecord: async function(scheduledTo) {
        const roster = this._getDutyRoster();
        const nextPerson = this._getNextDutyMember(roster, scheduledTo);
        if (!nextPerson) return null;

        const nextWeekDate = new Date();
        nextWeekDate.setDate(nextWeekDate.getDate() + 7);
        const nextWeekId = this._getDutyWeekId(nextWeekDate);
        const payload = this._buildDutyRecordPayload(nextWeekId, nextPerson.Student_ID, 'auto');
        const recordRef = doc(db, 'duty_records', nextWeekId);
        return runTransaction(db, async transaction => {
            const snapshot = await transaction.get(recordRef);
            if (snapshot.exists()) return snapshot.data();
            transaction.set(recordRef, payload);
            return payload;
        });
    },

    // === 主渲染 ===
    renderDuty: function() {
        const container = document.getElementById('duty-content');
        if (!container) return;

        if (this.currentRole === 'Guest') {
            container.innerHTML = `<div style="text-align:center; padding:50px; color:var(--text-muted);">
                <i class="ph-fill ph-lock-key" style="font-size:3rem; margin-bottom:10px; display:block;"></i>
                請先登入並完成綁定</div>`;
            return;
        }

        // 切頁與登入後的首次 render 可能早於 Firestore 首次快照。
        // 在確認 duty_records 已載入前，禁止推算與建立任何週紀錄。
        if (!this._dutyRecordsAreLoaded()) {
            const loadFailed = this.realtimeLoadState?.duty_records === 'error';
            container.innerHTML = `<div class="duty-card ${loadFailed ? 'duty-carryover-error' : 'duty-carryover-loading'}" role="status">
                <i class="ph ${loadFailed ? 'ph-warning-circle' : 'ph-spinner ph-spin'}" aria-hidden="true"></i>
                <div><strong>${loadFailed ? '無法載入值日資料' : '正在載入值日資料'}</strong><br>
                <span>${loadFailed ? '請重新整理；若仍失敗，請聯絡 Admin。' : '載入完成後才會顯示本週清單。'}</span></div>
            </div>`;
            return;
        }

        const result = this._getCurrentDutyPerson();
        if (result?.needsRosterSync && result.record) {
            if (this.currentRole !== 'Admin') {
                container.innerHTML = `<div class="duty-card duty-carryover-error" role="status">
                    <div><strong>本週輪值需要 Admin 確認</strong><br><span>舊紀錄指向目前不在輪值名單的人員，請通知 Admin 重新對齊。</span></div>
                </div>`;
                return;
            }
            container.innerHTML = `<div class="duty-card duty-carryover-loading" role="status">
                <i class="ph ph-spinner ph-spin" aria-hidden="true"></i>
                <div><strong>正在更新輪值名單</strong><br><span>舊紀錄指向非在學成員，系統正在接到下一位有效成員。</span></div>
            </div>`;
            this._syncInactiveDutyAssignment(result.record, result.assignedTo, result.inactiveAssignment).catch(error => {
                container.innerHTML = `<div class="duty-card duty-carryover-error" role="alert">
                    <div><strong>輪值名單更新失敗</strong><br><span>${escapeDutyHtml(error.message)}</span></div>
                    <button class="btn btn-secondary" type="button" onclick="app.renderDuty()">重試</button>
                </div>`;
            });
            return;
        }
        if (result?.invalidAssignment) {
            container.innerHTML = `<div class="duty-card duty-carryover-error" role="alert">
                <div><strong>本週輪值需要重新對齊</strong><br><span>目前紀錄指向非在學成員，為避免改動已有進度，系統不會自動換人。</span></div>
                ${this.currentRole === 'Admin' ? '<button class="btn btn-primary" type="button" onclick="app.openCurrentDutyAlignmentModal()">對齊本週輪值</button>' : ''}
            </div>`;
            return;
        }
        if (result?.needsCarryoverSync && result.carryoverFrom) {
            const previousName = this.getMemberName(result.assignedTo);
            const canCreateCarryover = this.currentRole === 'Admin'
                || this.currentMember?.Student_ID === result.assignedTo;
            if (!canCreateCarryover) {
                container.innerHTML = `<div class="duty-card duty-carryover-loading" role="status">
                    <i class="ph ph-arrow-bend-down-right" aria-hidden="true"></i>
                    <div><strong>${escapeDutyHtml(previousName)} 本週繼續值日</strong><br><span>上週尚未完成；值日生開啟本頁後會建立新的工作清單。</span></div>
                </div>`;
                return;
            }
            container.innerHTML = `<div class="duty-card duty-carryover-loading" role="status">
                <i class="ph ph-spinner ph-spin" aria-hidden="true"></i>
                <div><strong>正在建立順延週清單</strong><br>
                <span>${escapeDutyHtml(previousName)} 上週尚未完成，本週將由同一人繼續。</span></div>
            </div>`;
            this._ensureCarryoverWeek(result.carryoverFrom).catch(error => {
                container.innerHTML = `<div class="duty-card duty-carryover-error" role="alert">
                    <div><strong>順延週清單建立失敗</strong><br><span>${escapeDutyHtml(error.message)}</span></div>
                    <button class="btn btn-secondary" type="button" onclick="app.renderDuty()">重試</button>
                </div>`;
            });
            return;
        }
        if (!result || !result.member) {
            container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">
                <i class="ph ph-user-circle-minus" style="font-size:2.5rem; display:block; margin-bottom:10px;"></i>
                目前無碩班同學可排值日</div>`;
            return;
        }

        const { record, scheduledTo, assignedTo, scheduledMember, member, roster, carryoverFrom, carryoverCount } = result;
        const weekId = this._getDutyWeekId();
        const isCurrentDuty = this.currentMember && this.currentMember.Student_ID === assignedTo;
        const isAdmin = this.currentRole === 'Admin';
        const canEdit = isCurrentDuty || isAdmin;
        const submitted = Boolean(record && record.submitted);

        // 計算下週值日生；若 Admin 已預先指定，優先顯示指定結果
        const nextWeekDate = new Date();
        nextWeekDate.setDate(nextWeekDate.getDate() + 7);
        const nextWeekId = this._getDutyWeekId(nextWeekDate);
        const nextWeekRecord = this.data.duty_records.find(r => r._id === nextWeekId);
        const calculatedNextPerson = this._getNextDutyMember(roster, scheduledTo);
        const nextAssignedTo = nextWeekRecord?.assigned_to || nextWeekRecord?.scheduled_to;
        const nextPerson = nextAssignedTo
            ? roster.find(m => m.Student_ID === nextAssignedTo) || calculatedNextPerson
            : calculatedNextPerson;
        const carryoverStatusHtml = carryoverFrom
            ? `<span class="status-badge status-badge-warning"><i class="ph ph-arrow-bend-down-right" aria-hidden="true"></i> 上週未完成，已順延${carryoverCount > 1 ? ` ${carryoverCount} 週` : ''}</span>`
            : '';
        const assignmentStatusHtml = assignedTo !== scheduledTo
            ? `<span class="status-badge status-badge-warning">代班：原排定 ${escapeDutyHtml(scheduledMember?.Name_Ch || scheduledTo)}</span>`
            : record?.assignment_source === 'admin'
                ? '<span class="status-badge status-badge-info">Admin 對齊</span>'
                : '<span class="status-badge">依輪值排定</span>';
        const nextAssignmentStatusHtml = nextWeekRecord
            ? nextWeekRecord.assignment_source === 'admin'
                ? '<span class="status-badge status-badge-info">Admin 指定</span>'
                : '<span class="status-badge">已建立</span>'
            : '<span class="status-badge">依輪值推算</span>';

        // 輪值順序列表
        const rosterHtml = roster.map(m => {
            let cls = 'duty-roster-item';
            if (m.Student_ID === assignedTo) cls += ' current';
            else if (nextPerson && m.Student_ID === nextPerson.Student_ID) cls += ' next';
            return `<li class="${cls}">${escapeDutyHtml(m.Name_Ch)}</li>`;
        }).join('');

        // 清潔 checklist
        const cleaningHtml = DUTY_CLEANING_TASKS.map(task => {
            const checked = record && record.cleaning && record.cleaning[task.id] ? 'checked' : '';
            const disabled = !canEdit || (record && record.submitted) ? 'disabled' : '';
            return `<li class="duty-cleaning-item">
                <input type="checkbox" ${checked} ${disabled}
                    aria-label="完成${escapeDutyHtml(task.name)}"
                    onchange="app.toggleDutyItem('cleaning', '${task.id}', this.checked)">
                <div class="duty-item-content">
                    <div class="duty-item-heading"><span class="duty-item-name">${task.name}</span></div>
                    <div class="duty-item-detail">${task.detail}</div>
                </div>
            </li>`;
        }).join('');

        // 耗材 checklist（含 vendor tooltip，依 vendorGroup 查詢）
        const suppliesHtml = DUTY_SUPPLY_ITEMS.map(item => {
            const checked = record && record.supplies && record.supplies[item.id] ? 'checked' : '';
            const disabled = !canEdit || (record && record.submitted) ? 'disabled' : '';
            const vendor = SUPPLY_VENDORS[item.vendorGroup];
            const contactsHtml = vendor?.contacts?.map(contact => `
                <div class="vendor-contact-row">
                    <a class="vendor-phone-link" href="tel:${escapeDutyHtml(contact.dial)}"
                        aria-label="撥打${escapeDutyHtml(vendor.vendor)}${escapeDutyHtml(contact.label)} ${escapeDutyHtml(contact.display)}"
                        onclick="event.stopPropagation()">
                        <i class="ph ph-phone" aria-hidden="true"></i>
                        <span><small>${escapeDutyHtml(contact.label)}</small>${escapeDutyHtml(contact.display)}</span>
                    </a>
                    <button class="vendor-copy-button" type="button"
                        data-phone="${escapeDutyHtml(contact.display)}"
                        aria-label="複製${escapeDutyHtml(vendor.vendor)}${escapeDutyHtml(contact.label)}"
                        title="複製電話"
                        onclick="app.copyVendorPhone(event, this.dataset.phone)">
                        <i class="ph ph-copy" aria-hidden="true"></i>
                    </button>
                </div>
            `).join('') || '';
            const tooltipHtml = vendor ? `
                <details class="supply-info-tooltip" name="supply-vendor">
                    <summary aria-label="查看${escapeDutyHtml(vendor.vendor)}聯絡電話" title="查看廠商電話">
                        <i class="ph ph-info" aria-hidden="true"></i>
                    </summary>
                    <div class="tooltip-content">
                        <strong>${escapeDutyHtml(vendor.vendor)}</strong>
                        ${contactsHtml}
                    </div>
                </details>` : '';

            return `<li class="duty-supply-item">
                <input type="checkbox" ${checked} ${disabled}
                    aria-label="完成${escapeDutyHtml(item.name)}清點"
                    onchange="app.toggleDutyItem('supplies', '${item.id}', this.checked)">
                <div class="duty-item-content">
                    <div class="duty-item-heading">
                        <span class="duty-item-name">${item.name}</span>${tooltipHtml}
                    </div>
                    <div class="duty-item-meta">
                        <span><i class="ph ph-package" aria-hidden="true"></i>${item.threshold} ${item.unit}</span>
                        <span><i class="ph ph-map-pin" aria-hidden="true"></i>${item.location}</span>
                    </div>
                </div>
            </li>`;
        }).join('');

        const noteValue = String(record?.note || '').slice(0, DUTY_NOTE_MAX_LENGTH);
        const noteEditorHtml = `<div class="duty-card duty-note-card">
            <div class="duty-card-header">
                <h3><i class="ph ph-note-pencil" aria-hidden="true"></i> 本週備註</h3>
            </div>
            <label class="duty-note-label" for="duty-note">補貨、叫貨、異常或交接事項（選填）</label>
            <textarea id="duty-note" maxlength="${DUTY_NOTE_MAX_LENGTH}" rows="4"
                ${submitted ? 'disabled' : ''}
                oninput="app.updateDutyNoteCount(this.value)"
                onchange="app.saveDutyNote(this.value)"
                placeholder="例如：已補充手套；IPA 已叫貨，預計下週到。">${escapeDutyHtml(noteValue)}</textarea>
            <div class="duty-note-footer">
                <span id="duty-note-status" role="status">${submitted ? '已隨本週紀錄封存' : '離開欄位時自動儲存，提交時會再確認一次'}</span>
                <span id="duty-note-count">${noteValue.length}/${DUTY_NOTE_MAX_LENGTH}</span>
            </div>
        </div>`;
        const readonlyNoteHtml = submitted && noteValue
            ? `<div class="duty-card duty-note-card">
                <div class="duty-card-header"><h3><i class="ph ph-note" aria-hidden="true"></i> 本週備註</h3></div>
                <p class="duty-note-readonly">${escapeDutyHtml(noteValue).replace(/\n/g, '<br>')}</p>
            </div>`
            : '';

        // 提交按鈕
        let submitBtnHtml = '';
        if (canEdit && !submitted) {
            submitBtnHtml = `<button class="btn btn-primary" id="btn-submit-duty" onclick="app.submitDuty()" style="width:100%; padding:14px; font-size:1.05rem; margin-top:12px;">
                <i class="ph ph-check-circle"></i> 提交本週值日生工作
            </button>`;
        } else if (submitted) {
            submitBtnHtml = `<div style="text-align:center; padding:16px; background:#ecfdf5; border-radius:10px; margin-top:12px; color:var(--success); font-weight:600;">
                <i class="ph ph-check-circle"></i> 本週值日生工作已完成提交
            </div>`;
        }

        const adminDutyButtonsHtml = isAdmin
            ? `${record && !submitted ? `<button class="btn btn-secondary btn-sm" onclick="app.openCurrentDutyAlignmentModal()"><i class="ph ph-crosshair" aria-hidden="true"></i> 對齊本週輪值</button>` : ''}
               <button class="btn btn-secondary btn-sm" onclick="app.openNextDutyModal()"><i class="ph ph-calendar-plus" aria-hidden="true"></i> 設定下週值日生</button>`
            : '';

        container.innerHTML = `
            <div class="duty-card">
                <div class="duty-card-header">
                    <h3><i class="ph ph-calendar-check" style="color:var(--primary);"></i> 本週值日生：${escapeDutyHtml(member.Name_Ch)}</h3>
                    <div class="toolbar-actions">${adminDutyButtonsHtml}</div>
                </div>
                <div style="display:flex; gap:16px; flex-wrap:wrap; align-items:center;">
                    <div><strong>週期：</strong>${weekId} 起</div>
                    ${carryoverStatusHtml}
                    ${assignmentStatusHtml}
                    <div><strong>完成後下一位：</strong>${nextPerson ? escapeDutyHtml(nextPerson.Name_Ch) : '-'}</div>
                    ${nextAssignmentStatusHtml}
                </div>
                ${!submitted && !nextWeekRecord?.assignment_source?.includes('admin') ? '<p class="duty-rotation-help">若本週仍未提交，系統會保留原輪值順序，並由本週值日生順延至下一週。</p>' : ''}
            </div>

            <div class="duty-card">
                <div class="duty-card-header"><h3><i class="ph ph-list-numbers" aria-hidden="true"></i> 輪值順序</h3></div>
                <ul class="duty-roster-list">${rosterHtml}</ul>
            </div>

            ${canEdit ? `
            <div class="duty-card">
                <div class="duty-card-header"><h3><i class="ph ph-broom" aria-hidden="true"></i> 一般清潔</h3></div>
                <ul class="duty-checklist">${cleaningHtml}</ul>
            </div>

            <div class="duty-card">
                <div class="duty-card-header"><h3><i class="ph ph-package" aria-hidden="true"></i> 耗材清點 <span style="font-size:0.8rem; color:var(--text-muted); font-weight:400;">(打勾 = 數量足夠或已叫貨)</span></h3></div>
                <ul class="duty-checklist">${suppliesHtml}</ul>
            </div>

            ${noteEditorHtml}
            ${submitBtnHtml}
            ` : `
            <div class="duty-card">
                <div style="text-align:center; padding:20px; color:var(--text-muted);">
                    <i class="ph ph-eye-closed" style="font-size:2rem; display:block; margin-bottom:8px;"></i>
                    僅當週值日生與 Admin 可以查看並編輯任務清單
                </div>
            </div>
            ${readonlyNoteHtml}
            `}

            <div class="duty-card" style="background:#f8fafc;">
                <div class="duty-card-header"><h3><i class="ph ph-info" aria-hidden="true"></i> 補充說明</h3></div>
                ${DUTY_NOTES.map(note => `
                    <div class="duty-note-item">
                        <div class="duty-note-title"><i class="ph ${escapeDutyHtml(note.icon || 'ph-info')}" aria-hidden="true"></i>${escapeDutyHtml(note.title)}</div>
                        <div style="font-size:0.9rem; color:var(--text-muted); line-height:1.6;">${note.content}</div>
                        ${note.link ? `<a class="duty-resource-link" href="${escapeDutyHtml(note.link.url)}" target="_blank" rel="noopener noreferrer">
                            <i class="ph ph-table" aria-hidden="true"></i>${escapeDutyHtml(note.link.label)}
                            <i class="ph ph-arrow-square-out" aria-hidden="true"></i>
                        </a>` : ''}
                    </div>
                `).join('')}
            </div>
        `;

        // 自動建立紀錄
        if (!record && assignedTo && (isAdmin || isCurrentDuty)) {
            this._ensureWeekRecord(assignedTo).catch(error => {
                this.showNotification('建立本週值日清單失敗：' + error.message, 'error');
            });
        }
    },

    copyVendorPhone: async function(event, phone) {
        event?.preventDefault();
        event?.stopPropagation();
        const value = String(phone || '').trim();
        if (!value) return;

        try {
            let copied = false;
            if (navigator.clipboard?.writeText) {
                try {
                    await navigator.clipboard.writeText(value);
                    copied = true;
                } catch {
                    copied = false;
                }
            }
            if (!copied) {
                const textarea = document.createElement('textarea');
                textarea.value = value;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                copied = document.execCommand('copy');
                textarea.remove();
                if (!copied) throw new Error('瀏覽器未允許複製');
            }
            this.showNotification(`已複製電話：${value}`, 'success');
        } catch (error) {
            this.showNotification(`無法自動複製，請長按電話號碼：${value}`, 'warning');
        }
    },

    // === 勾選項目 ===
    toggleDutyItem: async function(category, itemId, checked) {
        const weekId = this._getDutyWeekId();
        const record = this.data.duty_records.find(item => item._id === weekId);
        const validItem = category === 'cleaning'
            ? DUTY_CLEANING_TASKS.some(item => item.id === itemId)
            : category === 'supplies' && DUTY_SUPPLY_ITEMS.some(item => item.id === itemId);
        if (!validItem || !this._canEditDutyRecord(record)) {
            this.showNotification('你沒有權限修改這份值日清單', 'warning');
            this.renderDuty();
            return;
        }
        try {
            await updateDoc(doc(db, 'duty_records', weekId), {
                [`${category}.${itemId}`]: checked,
                updated_at: new Date().toISOString()
            });
        } catch (e) {
            this.showNotification('更新失敗：' + e.message, 'error');
        }
    },

    saveDutyNote: async function(value) {
        const weekId = this._getDutyWeekId();
        const record = this.data.duty_records.find(item => item._id === weekId);
        if (!record || record.submitted) return;

        const result = this._getCurrentDutyPerson();
        const canEdit = this.currentRole === 'Admin'
            || (result && this.currentMember?.Student_ID === result.assignedTo);
        if (!canEdit) return;

        const note = String(value || '').slice(0, DUTY_NOTE_MAX_LENGTH);
        const status = document.getElementById('duty-note-status');
        if (status) status.textContent = '儲存中…';
        try {
            await updateDoc(doc(db, 'duty_records', weekId), {
                note,
                updated_at: new Date().toISOString()
            });
            if (status) status.textContent = '已儲存';
        } catch (error) {
            if (status) status.textContent = '儲存失敗，請再試一次';
            this.showNotification('備註儲存失敗：' + error.message, 'error');
        }
    },

    updateDutyNoteCount: function(value) {
        const counter = document.getElementById('duty-note-count');
        if (counter) counter.textContent = `${String(value || '').length}/${DUTY_NOTE_MAX_LENGTH}`;
        const status = document.getElementById('duty-note-status');
        if (status) status.textContent = '尚未儲存';
    },

    // === 提交本週工作 ===
    submitDuty: async function() {
        const weekId = this._getDutyWeekId();
        const record = this.data.duty_records.find(r => r._id === weekId);
        if (!record) return;
        if (!this._canEditDutyRecord(record)) {
            this.showNotification('只有本週值日生或 Admin 可以提交', 'warning');
            return;
        }

        // 檢查是否全部勾選
        const allCleaning = DUTY_CLEANING_TASKS.every(t => record.cleaning && record.cleaning[t.id]);
        const allSupplies = DUTY_SUPPLY_ITEMS.every(t => record.supplies && record.supplies[t.id]);

        if (!allCleaning || !allSupplies) {
            this.showNotification('請先完成所有清潔與耗材清點項目', 'warning');
            return;
        }

        if (!confirm('確定提交本週值日生工作？提交後將無法修改。')) return;

        const button = document.getElementById('btn-submit-duty');
        const note = String(document.getElementById('duty-note')?.value || record.note || '')
            .trim()
            .slice(0, DUTY_NOTE_MAX_LENGTH);
        const scheduledTo = this._getScheduledDutyId(record);
        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="ph ph-spinner ph-spin" aria-hidden="true"></i> 提交中…';
        }

        try {
            await updateDoc(doc(db, 'duty_records', weekId), {
                scheduled_to: scheduledTo,
                note,
                status: 'submitted',
                submitted: true,
                submitted_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
            this.showNotification('本週值日生工作已提交', 'success');

        } catch (e) {
            this.showNotification('提交失敗：' + e.message, 'error');
            if (button) {
                button.disabled = false;
                button.innerHTML = '<i class="ph ph-check-circle" aria-hidden="true"></i> 提交本週值日生工作';
            }
        }
    },

    // === Admin 對齊本週輪值起點 ===
    openCurrentDutyAlignmentModal: function() {
        if (this.currentRole !== 'Admin') return;
        const result = this._getCurrentDutyPerson();
        const roster = this._getDutyRoster();
        if (!result || !roster.length) {
            this.showNotification('目前沒有可對齊的碩班成員', 'warning');
            return;
        }
        if (result.record?.submitted) {
            this.showNotification('本週紀錄已提交，不能再調整輪值', 'warning');
            return;
        }

        const options = roster.map(member =>
            `<option value="${escapeDutyHtml(member.Student_ID)}" ${member.Student_ID === result.scheduledTo ? 'selected' : ''}>${escapeDutyHtml(member.Name_Ch)}</option>`
        ).join('');

        document.getElementById('current-duty-alignment-modal')?.remove();
        this.modalReturnFocus?.delete('current-duty-alignment-modal');
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'current-duty-alignment-modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:520px;">
                <div class="modal-header">
                    <h3>對齊本週輪值</h3>
                    <span class="close" onclick="app.closeModal('current-duty-alignment-modal')">&times;</span>
                </div>
                <div class="modal-body">
                    <p class="modal-intro">請選擇本週真正輪到的人。儲存後會將此人設為新的輪值起點，並清除本週尚未提交的勾選與備註。完成提交後才會安排下一位；若未完成，則由同一人順延。</p>
                    <div class="form-group">
                        <label for="current-duty-assignee">本週實際輪到的人</label>
                        <select id="current-duty-assignee">${options}</select>
                        <div class="form-help">這個操作只用於切換系統或需要重新校正順序時。</div>
                    </div>
                    <div id="current-duty-alignment-error" class="form-error" role="alert"></div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="app.closeModal('current-duty-alignment-modal')">取消</button>
                    <button class="btn btn-primary" id="btn-align-current-duty" onclick="app.saveCurrentDutyAlignment()">確認對齊</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
    },

    saveCurrentDutyAlignment: async function() {
        if (this.currentRole !== 'Admin') return;
        const selectedId = document.getElementById('current-duty-assignee')?.value;
        const button = document.getElementById('btn-align-current-duty');
        const errorElement = document.getElementById('current-duty-alignment-error');
        const roster = this._getDutyRoster();
        const selectedMember = roster.find(member => member.Student_ID === selectedId);
        if (!selectedMember) {
            if (errorElement) errorElement.textContent = '請選擇有效的值日生。';
            return;
        }

        const weekId = this._getDutyWeekId();
        const currentRecord = this.data.duty_records.find(record => record._id === weekId);
        if (currentRecord?.submitted) {
            if (errorElement) errorElement.textContent = '本週紀錄已提交，不能再調整。';
            return;
        }

        const nextMember = this._getNextDutyMember(roster, selectedId);
        if (button) {
            button.disabled = true;
            button.textContent = '對齊中…';
        }
        if (errorElement) errorElement.textContent = '';

        try {
            const alignedRecord = this._buildDutyRecordPayload(weekId, selectedId, 'admin');
            // Admin 對齊是本週的最高優先權操作，必須先獨立完成。
            // 不可因清理上週紀錄失敗而連帶回滾本週指定。
            await setDoc(doc(db, 'duty_records', weekId), alignedRecord);

            if (currentRecord?.carried_from) {
                updateDoc(doc(db, 'duty_records', currentRecord.carried_from), {
                    status: 'missed_admin_override',
                    carried_over_to: null,
                    carryover_overridden_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }).catch(error => {
                    // 上週註記只是歷史整理，不影響已完成的本週強制指定。
                    console.warn('[GOODLAB] 本週已對齊，但無法補記上週覆寫狀態：', error.code || error.message);
                });
            }
            const recordIndex = this.data.duty_records.findIndex(record => record._id === weekId);
            const localRecord = { _id: weekId, ...alignedRecord };
            if (recordIndex >= 0) this.data.duty_records[recordIndex] = localRecord;
            else this.data.duty_records.push(localRecord);
            this.closeModal('current-duty-alignment-modal');
            this.renderDuty();
            this.renderOverview();
            this.showNotification(`輪值已對齊：本週 ${selectedMember.Name_Ch}${nextMember ? `；完成後下一位為 ${nextMember.Name_Ch}` : ''}`, 'success');
        } catch (error) {
            if (errorElement) errorElement.textContent = '對齊失敗：' + error.message;
            this.showNotification('本週值日生對齊失敗：' + error.message, 'error', 8000);
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = '確認對齊';
            }
        }
    },

    // === Admin 預先指定下週值日生 ===
    openNextDutyModal: function() {
        if (this.currentRole !== 'Admin') return;
        const roster = this._getDutyRoster();
        if (!roster.length) {
            this.showNotification('目前沒有可排班的碩班成員', 'warning');
            return;
        }

        const nextWeekDate = new Date();
        nextWeekDate.setDate(nextWeekDate.getDate() + 7);
        const nextWeekId = this._getDutyWeekId(nextWeekDate);
        const existing = this.data.duty_records.find(record => record._id === nextWeekId);
        const currentResult = this._getCurrentDutyPerson();
        const suggestedId = existing?.scheduled_to
            || existing?.assigned_to
            || (currentResult ? this._getNextDutyMember(roster, currentResult.scheduledTo)?.Student_ID : '')
            || roster[0].Student_ID;
        const options = roster.map(member =>
            `<option value="${escapeDutyHtml(member.Student_ID)}" ${member.Student_ID === suggestedId ? 'selected' : ''}>${escapeDutyHtml(member.Name_Ch)}</option>`
        ).join('');

        document.getElementById('next-duty-modal')?.remove();
        this.modalReturnFocus?.delete('next-duty-modal');
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'next-duty-modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:440px;">
                <div class="modal-header">
                    <h3>設定下週值日生</h3>
                    <span class="close" onclick="app.closeModal('next-duty-modal')">&times;</span>
                </div>
                <div class="modal-body">
                    <p class="modal-intro">適用週次：${nextWeekId} 起。儲存後，下週會優先使用這個指定結果；若本週屆時仍未完成，這項 Admin 指定會視為明確覆寫，不再自動順延本週值日生。</p>
                    <div class="form-group">
                        <label for="next-duty-assignee">值日生</label>
                        <select id="next-duty-assignee">${options}</select>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="app.closeModal('next-duty-modal')">取消</button>
                    <button class="btn btn-primary" id="btn-save-next-duty" onclick="app.saveNextDutyAssignment('${nextWeekId}')">儲存</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
    },

    saveNextDutyAssignment: async function(nextWeekId) {
        if (this.currentRole !== 'Admin') return;
        const assignedTo = document.getElementById('next-duty-assignee')?.value;
        if (!assignedTo) return;
        const button = document.getElementById('btn-save-next-duty');
        const payload = this._buildDutyRecordPayload(nextWeekId, assignedTo, 'admin');

        button.disabled = true;
        button.textContent = '儲存中...';
        try {
            await setDoc(doc(db, 'duty_records', nextWeekId), payload, { merge: true });
            this.closeModal('next-duty-modal');
            this.showNotification('已設定下週值日生', 'success');
        } catch (error) {
            this.showNotification('設定失敗：' + error.message, 'error');
        } finally {
            button.disabled = false;
            button.textContent = '儲存';
        }
    },

};
