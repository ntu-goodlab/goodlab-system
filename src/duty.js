/**
 * GOODLAB — 值日生模組 (Phase 5)
 * 
 * 動態輪值（碩班非Admin）、代班雙向確認、清潔+耗材 checklist。
 * 資料模型：
 *   duty_records/{weekId}: { week_start, scheduled_to, assigned_to, assignment_source,
 *                            carried_from, carryover_count, status, substitute_pending, substitute_from,
 *                            cleaning: {sweep: false, ...}, supplies: {acetone: false, ...},
 *                            submitted: false, submitted_at: null }
 */
import { db, doc, setDoc, updateDoc, writeBatch } from './firebase.js';
import { DUTY_CLEANING_TASKS, DUTY_SUPPLY_ITEMS, SUPPLY_VENDORS, DUTY_NOTES } from './constants.js';

const DUTY_NOTE_MAX_LENGTH = 1000;
const escapeDutyHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
})[character]);

export const dutyModule = {

    _dutyCarryoverSyncWeek: null,

    // === 取得當週 ID (ISO Week 的週一日期字串，e.g. "2026-06-09") ===
    _getDutyWeekId: function(date) {
        const d = new Date(date || Date.now());
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
        const monday = new Date(d.setDate(diff));
        return monday.toISOString().split('T')[0];
    },

    // === 取得值日生候選名單 (碩班、非Admin、在學中) ===
    _getDutyRoster: function() {
        return this.data.members
            .filter(m => m.Degree === 'Master' && m.Role !== 'Admin' && m.Status === 'Active')
            .sort((a, b) => a.Student_ID.localeCompare(b.Student_ID));
    },

    // scheduled_to 決定後續輪值；assigned_to 是本週實際執行者（可能為代班者）。
    _getScheduledDutyId: function(record) {
        return record?.scheduled_to || record?.assigned_to || '';
    },

    _getNextDutyMember: function(roster, scheduledTo) {
        if (!roster.length) return null;
        const currentIndex = roster.findIndex(member => member.Student_ID === scheduledTo);
        return roster[(currentIndex >= 0 ? currentIndex + 1 : 0) % roster.length];
    },

    _getLatestPreviousDutyRecord: function(weekId) {
        return [...this.data.duty_records]
            .filter(record => record._id < weekId)
            .sort((a, b) => b._id.localeCompare(a._id))[0] || null;
    },

    _hasDutyProgress: function(record) {
        if (!record) return false;
        return Boolean(
            String(record.note || '').trim()
            || record.substitute_pending
            || record.assignment_source === 'substitute'
            || Object.values(record.cleaning || {}).some(Boolean)
            || Object.values(record.supplies || {}).some(Boolean)
        );
    },

    _canAutoCarryOver: function(currentRecord) {
        if (!currentRecord) return true;
        return !currentRecord.submitted
            && (currentRecord.assignment_source || 'auto') === 'auto'
            && !this._hasDutyProgress(currentRecord);
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
            updated_at: new Date().toISOString()
        }, overrides);
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
            const scheduledTo = this._getScheduledDutyId(previousRecord);
            const assignedTo = previousRecord.assigned_to || scheduledTo;
            return {
                record,
                scheduledTo,
                assignedTo,
                scheduledMember: this.data.members.find(member => member.Student_ID === scheduledTo),
                member: this.data.members.find(member => member.Student_ID === assignedTo),
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
            return {
                record,
                scheduledTo,
                assignedTo,
                scheduledMember: this.data.members.find(m => m.Student_ID === scheduledTo),
                member: this.data.members.find(m => m.Student_ID === assignedTo),
                roster,
                carryoverFrom: record.carried_from
                    ? this.data.duty_records.find(item => item._id === record.carried_from) || null
                    : null,
                carryoverCount: Number(record.carryover_count || 0),
                needsCarryoverSync: false
            };
        }

        let nextIndex = 0;
        if (previousRecord) {
            const lastPerson = this._getScheduledDutyId(previousRecord);
            const lastIdx = roster.findIndex(m => m.Student_ID === lastPerson);
            if (lastIdx >= 0) {
                nextIndex = (lastIdx + 1) % roster.length;
            }
        }

        const assignedTo = roster[nextIndex].Student_ID;
        return {
            record: null,
            scheduledTo: assignedTo,
            assignedTo,
            scheduledMember: roster[nextIndex],
            member: roster[nextIndex],
            roster,
            carryoverFrom: null,
            carryoverCount: 0,
            needsCarryoverSync: false
        };
    },

    // === 確保本週紀錄存在於 Firebase ===
    _ensureWeekRecord: async function(assignedTo) {
        const weekId = this._getDutyWeekId();
        const existing = this.data.duty_records.find(r => r._id === weekId);
        if (existing) return existing;

        const newRecord = this._buildDutyRecordPayload(weekId, assignedTo, 'auto');

        await setDoc(doc(db, 'duty_records', weekId), newRecord);
        return newRecord;
    },

    _ensureCarryoverWeek: async function(previousRecord) {
        const weekId = this._getDutyWeekId();
        if (!previousRecord || this._dutyCarryoverSyncWeek === weekId) return;

        this._dutyCarryoverSyncWeek = weekId;
        const scheduledTo = this._getScheduledDutyId(previousRecord);
        const assignedTo = previousRecord.assigned_to || scheduledTo;
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
            const batch = writeBatch(db);
            // 不 merge，確保順延週使用全新的 checklist 與備註。
            batch.set(doc(db, 'duty_records', weekId), payload);
            batch.update(doc(db, 'duty_records', previousRecord._id), {
                status: 'carried_over',
                carried_over_to: weekId,
                updated_at: new Date().toISOString()
            });
            await batch.commit();
        } finally {
            if (this._dutyCarryoverSyncWeek === weekId) this._dutyCarryoverSyncWeek = null;
        }
    },

    _ensureNextWeekRecord: async function(scheduledTo) {
        const roster = this._getDutyRoster();
        const nextPerson = this._getNextDutyMember(roster, scheduledTo);
        if (!nextPerson) return null;

        const nextWeekDate = new Date();
        nextWeekDate.setDate(nextWeekDate.getDate() + 7);
        const nextWeekId = this._getDutyWeekId(nextWeekDate);
        const existing = this.data.duty_records.find(record => record._id === nextWeekId);
        if (existing) return existing;

        const payload = this._buildDutyRecordPayload(nextWeekId, nextPerson.Student_ID, 'auto');
        await setDoc(doc(db, 'duty_records', nextWeekId), payload);
        return payload;
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

        const result = this._getCurrentDutyPerson();
        if (result?.needsCarryoverSync && result.carryoverFrom) {
            const previousName = this.getMemberName(result.assignedTo);
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
            ? this.data.members.find(m => m.Student_ID === nextAssignedTo) || calculatedNextPerson
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

        // 代班 Banner
        let substituteBanner = '';
        if (record && record.substitute_pending && this.currentMember) {
            if (this.currentMember.Student_ID === record.substitute_pending) {
                // 我是被邀請代班的人
                const fromName = this.getMemberName(record.substitute_from || record.assigned_to);
                substituteBanner = `
                <div class="duty-substitute-banner">
                    <i class="ph ph-swap"></i>
                    <div style="flex:1;">
                        <strong>${fromName}</strong> 邀請你代班本週值日生工作
                    </div>
                    <button class="btn btn-primary btn-sm" onclick="app.acceptSubstitute()">接受</button>
                    <button class="btn btn-secondary btn-sm" onclick="app.rejectSubstitute()">拒絕</button>
                </div>`;
            } else if (isCurrentDuty || (record.substitute_from && this.currentMember.Student_ID === record.substitute_from)) {
                // 我發起了代班請求
                const pendingName = this.getMemberName(record.substitute_pending);
                substituteBanner = `
                <div class="duty-substitute-banner">
                    <i class="ph ph-clock"></i>
                    <div style="flex:1;">已邀請 <strong>${pendingName}</strong> 代班，等待對方確認中...</div>
                </div>`;
            }
        }

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
            return `<li>
                <input type="checkbox" ${checked} ${disabled}
                    onchange="app.toggleDutyItem('cleaning', '${task.id}', this.checked)">
                <div>
                    <div class="duty-item-name">${task.name}</div>
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

            return `<li>
                <input type="checkbox" ${checked} ${disabled}
                    onchange="app.toggleDutyItem('supplies', '${item.id}', this.checked)">
                <div style="flex:1;">
                    <div class="duty-item-name">
                        ${item.name} ${tooltipHtml}
                    </div>
                    <div class="duty-item-meta">
                        <span>⚠️ ${item.threshold} ${item.unit}</span>
                        <span>📍 ${item.location}</span>
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

        // 代班按鈕（只有當週值日生且未提交時可用）
        let subBtnHtml = '';
        if (isCurrentDuty && !submitted && !(record && record.substitute_pending)) {
            subBtnHtml = `<button class="btn btn-secondary btn-sm" onclick="app.openSubstituteModal()">
                <i class="ph ph-swap"></i> 找代班
            </button>`;
        }

        const adminDutyButtonsHtml = isAdmin
            ? `${record && !submitted ? `<button class="btn btn-secondary btn-sm" onclick="app.openCurrentDutyAlignmentModal()"><i class="ph ph-crosshair" aria-hidden="true"></i> 對齊本週輪值</button>` : ''}
               <button class="btn btn-secondary btn-sm" onclick="app.openNextDutyModal()"><i class="ph ph-calendar-plus" aria-hidden="true"></i> 設定下週值日生</button>`
            : '';

        container.innerHTML = `
            ${substituteBanner}
            
            <div class="duty-card">
                <div class="duty-card-header">
                    <h3><i class="ph ph-calendar-check" style="color:var(--primary);"></i> 本週值日生：${escapeDutyHtml(member.Name_Ch)}</h3>
                    <div class="toolbar-actions">${subBtnHtml}${adminDutyButtonsHtml}</div>
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
                    <div style="margin-bottom:12px; padding:10px 14px; background:white; border-radius:8px; border-left:3px solid var(--primary);">
                        <div style="font-weight:600; margin-bottom:4px;">${note.title}</div>
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
        if (!record && assignedTo) {
            this._ensureWeekRecord(assignedTo);
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
        try {
            await updateDoc(doc(db, 'duty_records', weekId), {
                [`${category}.${itemId}`]: checked,
                updated_at: new Date().toISOString()
            });
        } catch (e) {
            this.showNotification('❌ 更新失敗: ' + e.message, 'error');
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

        // 檢查是否全部勾選
        const allCleaning = DUTY_CLEANING_TASKS.every(t => record.cleaning && record.cleaning[t.id]);
        const allSupplies = DUTY_SUPPLY_ITEMS.every(t => record.supplies && record.supplies[t.id]);

        if (!allCleaning || !allSupplies) {
            this.showNotification('⚠️ 請先完成所有清潔與耗材清點項目', 'warning');
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
            this.showNotification('✅ 本週值日生工作已提交！', 'success');

            try {
                await this._ensureNextWeekRecord(scheduledTo);
            } catch (nextWeekError) {
                this.showNotification('本週已提交，但下週輪值建立失敗；請由 Admin 檢查：' + nextWeekError.message, 'warning');
            }
        } catch (e) {
            this.showNotification('❌ 提交失敗: ' + e.message, 'error');
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
            `<option value="${member.Student_ID}" ${member.Student_ID === result.scheduledTo ? 'selected' : ''}>${escapeDutyHtml(member.Name_Ch)}</option>`
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
                    <p class="modal-intro">請選擇舊系統本週真正輪到的人。儲存後會將此人設為新的輪值起點，並清除本週尚未提交的勾選、備註與代班狀態。完成提交後才會安排下一位；若未完成，則由同一人順延。</p>
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
            const batch = writeBatch(db);
            batch.set(
                doc(db, 'duty_records', weekId),
                this._buildDutyRecordPayload(weekId, selectedId, 'admin'),
                { merge: true }
            );
            if (currentRecord?.carried_from) {
                batch.update(doc(db, 'duty_records', currentRecord.carried_from), {
                    status: 'missed_admin_override',
                    carried_over_to: null,
                    carryover_overridden_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                });
            }
            await batch.commit();
            this.closeModal('current-duty-alignment-modal');
            this.showNotification(`輪值已對齊：本週 ${selectedMember.Name_Ch}${nextMember ? `；完成後下一位為 ${nextMember.Name_Ch}` : ''}`, 'success');
        } catch (error) {
            if (errorElement) errorElement.textContent = '對齊失敗：' + error.message;
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
            `<option value="${member.Student_ID}" ${member.Student_ID === suggestedId ? 'selected' : ''}>${member.Name_Ch}</option>`
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

    // === 代班流程 ===
    openSubstituteModal: function() {
        const roster = this._getDutyRoster();
        const currentId = this.currentMember ? this.currentMember.Student_ID : '';
        
        const options = roster
            .filter(m => m.Student_ID !== currentId)
            .map(m => `<option value="${m.Student_ID}">${m.Name_Ch}</option>`)
            .join('');

        // 使用 showNotification 搭配 confirm 的簡單方式
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'substitute-modal';
        modal.innerHTML = `
        <div class="modal-content" style="max-width:400px;">
            <div class="modal-header">
                <h3><i class="ph ph-swap"></i> 尋找代班人</h3>
                <span class="close" onclick="app.closeModal('substitute-modal')">&times;</span>
            </div>
            <div class="modal-body">
                <p style="margin-bottom:12px; color:var(--text-muted);">選擇你要邀請的代班同學。對方確認後，工作進度會自動轉移。</p>
                <div class="form-group">
                    <label>代班人選</label>
                    <select id="substitute-target">${options}</select>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="app.closeModal('substitute-modal')">取消</button>
                <button class="btn btn-primary" onclick="app.requestSubstitute()">送出邀請</button>
            </div>
        </div>`;
        document.body.appendChild(modal);
    },

    requestSubstitute: async function() {
        const target = document.getElementById('substitute-target').value;
        if (!target) return;
        const weekId = this._getDutyWeekId();
        
        try {
            await updateDoc(doc(db, 'duty_records', weekId), {
                substitute_pending: target,
                substitute_from: this.currentMember.Student_ID,
                updated_at: new Date().toISOString()
            });
            this.closeModal('substitute-modal');
            document.getElementById('substitute-modal')?.remove();
            this.showNotification('📨 代班邀請已送出！', 'success');
        } catch (e) {
            this.showNotification('❌ 送出失敗: ' + e.message, 'error');
        }
    },

    acceptSubstitute: async function() {
        const weekId = this._getDutyWeekId();
        const record = this.data.duty_records.find(item => item._id === weekId);
        if (!record) return;
        const originalAssignee = record.substitute_from || record.assigned_to || this._getScheduledDutyId(record);
        try {
            await updateDoc(doc(db, 'duty_records', weekId), {
                scheduled_to: this._getScheduledDutyId(record),
                assigned_to: this.currentMember.Student_ID,
                assignment_source: 'substitute',
                substitute_pending: null,
                substitute_from: originalAssignee,
                updated_at: new Date().toISOString()
            });
            this.showNotification('✅ 已接受代班；本週工作已轉移，後續輪值順序不變。', 'success');
        } catch (e) {
            this.showNotification('❌ 操作失敗: ' + e.message, 'error');
        }
    },

    rejectSubstitute: async function() {
        const weekId = this._getDutyWeekId();
        try {
            await updateDoc(doc(db, 'duty_records', weekId), {
                substitute_pending: null,
                substitute_from: null,
                updated_at: new Date().toISOString()
            });
            this.showNotification('已拒絕代班請求', 'info');
        } catch (e) {
            this.showNotification('❌ 操作失敗: ' + e.message, 'error');
        }
    }
};
