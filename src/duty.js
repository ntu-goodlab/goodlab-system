/**
 * GOODLAB — 值日生模組 (Phase 5)
 * 
 * 動態輪值（碩班非Admin）、代班雙向確認、清潔+耗材 checklist。
 * 資料模型：
 *   duty_records/{weekId}: { week_start, assigned_to, substitute_pending, substitute_from,
 *                            cleaning: {sweep: false, ...}, supplies: {acetone: false, ...},
 *                            submitted: false, submitted_at: null }
 */
import { db, doc, setDoc, updateDoc } from './firebase.js';
import { DUTY_CLEANING_TASKS, DUTY_SUPPLY_ITEMS, SUPPLY_VENDORS, DUTY_NOTES, GAS_WEBHOOK_URL } from './constants.js';

export const dutyModule = {

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

    // === 計算本週值日生 ===
    _getCurrentDutyPerson: function() {
        const roster = this._getDutyRoster();
        if (roster.length === 0) return null;

        const weekId = this._getDutyWeekId();
        const record = this.data.duty_records.find(r => r._id === weekId);

        // 如果本週紀錄已存在，直接用它的 assigned_to
        if (record && record.assigned_to) {
            return {
                record,
                assignedTo: record.assigned_to,
                member: this.data.members.find(m => m.Student_ID === record.assigned_to),
                roster
            };
        }

        // 找出上一週的紀錄（最近一筆已提交的）
        const sorted = [...this.data.duty_records]
            .filter(r => r._id < weekId)
            .sort((a, b) => b._id.localeCompare(a._id));

        let nextIndex = 0;
        if (sorted.length > 0) {
            const lastPerson = sorted[0].assigned_to;
            const lastIdx = roster.findIndex(m => m.Student_ID === lastPerson);
            if (lastIdx >= 0) {
                nextIndex = (lastIdx + 1) % roster.length;
            }
        }

        const assignedTo = roster[nextIndex].Student_ID;
        return { record: null, assignedTo, member: roster[nextIndex], roster };
    },

    // === 確保本週紀錄存在於 Firebase ===
    _ensureWeekRecord: async function(assignedTo) {
        const weekId = this._getDutyWeekId();
        const existing = this.data.duty_records.find(r => r._id === weekId);
        if (existing) return existing;

        const cleaning = {};
        DUTY_CLEANING_TASKS.forEach(t => { cleaning[t.id] = false; });
        const supplies = {};
        DUTY_SUPPLY_ITEMS.forEach(t => { supplies[t.id] = false; });

        const newRecord = {
            week_start: weekId,
            assigned_to: assignedTo,
            substitute_pending: null,
            substitute_from: null,
            cleaning,
            supplies,
            submitted: false,
            submitted_at: null
        };

        await setDoc(doc(db, 'duty_records', weekId), newRecord);
        return newRecord;
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
        if (!result || !result.member) {
            container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">
                <i class="ph ph-user-circle-minus" style="font-size:2.5rem; display:block; margin-bottom:10px;"></i>
                目前無碩班同學可排值日</div>`;
            return;
        }

        const { record, assignedTo, member, roster } = result;
        const weekId = this._getDutyWeekId();
        const isCurrentDuty = this.currentMember && this.currentMember.Student_ID === assignedTo;
        const isAdmin = this.currentRole === 'Admin';
        const canEdit = isCurrentDuty || isAdmin;

        // 計算下一位
        const currentIdx = roster.findIndex(m => m.Student_ID === assignedTo);
        const nextPerson = roster[(currentIdx + 1) % roster.length];

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
            return `<li class="${cls}">${m.Name_Ch}</li>`;
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
            const tooltipHtml = vendor ? `
                <span class="supply-info-tooltip" tabindex="0">
                    <i class="ph ph-info" style="color:var(--primary); font-size:1rem;"></i>
                    <span class="tooltip-content">
                        📞 ${vendor.vendor} ${vendor.phone}${vendor.note ? '<br>' + vendor.note : ''}
                    </span>
                </span>` : '';

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

        // 提交按鈕
        const submitted = record && record.submitted;
        let submitBtnHtml = '';
        if (canEdit && !submitted) {
            submitBtnHtml = `<button class="btn btn-primary" onclick="app.submitDuty()" style="width:100%; padding:14px; font-size:1.05rem; margin-top:12px;">
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

        container.innerHTML = `
            ${substituteBanner}
            
            <div class="duty-card">
                <div class="duty-card-header">
                    <h3><i class="ph ph-calendar-check" style="color:var(--primary);"></i> 本週值日生：${member.Name_Ch}</h3>
                    ${subBtnHtml}
                </div>
                <div style="display:flex; gap:16px; flex-wrap:wrap; align-items:center;">
                    <div><strong>週期：</strong>${weekId} 起</div>
                    <div><strong>下一位：</strong>${nextPerson ? nextPerson.Name_Ch : '-'}</div>
                </div>
            </div>

            <div class="duty-card">
                <div class="duty-card-header"><h3>📋 輪值順序</h3></div>
                <ul class="duty-roster-list">${rosterHtml}</ul>
            </div>

            ${canEdit ? `
            <div class="duty-card">
                <div class="duty-card-header"><h3>🧹 一般清潔</h3></div>
                <ul class="duty-checklist">${cleaningHtml}</ul>
            </div>

            <div class="duty-card">
                <div class="duty-card-header"><h3>📦 耗材清點 <span style="font-size:0.8rem; color:var(--text-muted); font-weight:400;">(打勾 = 數量足夠或已叫貨)</span></h3></div>
                <ul class="duty-checklist">${suppliesHtml}</ul>
            </div>

            ${submitBtnHtml}
            ` : `
            <div class="duty-card">
                <div style="text-align:center; padding:20px; color:var(--text-muted);">
                    <i class="ph ph-eye-closed" style="font-size:2rem; display:block; margin-bottom:8px;"></i>
                    僅當週值日生與 Admin 可以查看並編輯任務清單
                </div>
            </div>
            `}

            <div class="duty-card" style="background:#f8fafc;">
                <div class="duty-card-header"><h3>📝 補充說明</h3></div>
                ${DUTY_NOTES.map(note => `
                    <div style="margin-bottom:12px; padding:10px 14px; background:white; border-radius:8px; border-left:3px solid var(--primary);">
                        <div style="font-weight:600; margin-bottom:4px;">${note.title}</div>
                        <div style="font-size:0.9rem; color:var(--text-muted); line-height:1.6;">${note.content}</div>
                    </div>
                `).join('')}
            </div>
        `;

        // 自動建立紀錄
        if (!record && assignedTo) {
            this._ensureWeekRecord(assignedTo);
        }
    },

    // === 勾選項目 ===
    toggleDutyItem: async function(category, itemId, checked) {
        const weekId = this._getDutyWeekId();
        try {
            await updateDoc(doc(db, 'duty_records', weekId), {
                [`${category}.${itemId}`]: checked
            });
        } catch (e) {
            this.showNotification('❌ 更新失敗: ' + e.message, 'error');
        }
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

        try {
            await updateDoc(doc(db, 'duty_records', weekId), {
                submitted: true,
                submitted_at: new Date().toISOString()
            });
            this.showNotification('✅ 本週值日生工作已提交！', 'success');

            // --- Phase 5: 寄信給全體實驗室公告交接 ---
            if (GAS_WEBHOOK_URL) {
                const roster = this._getDutyRoster();
                const currentIdx = roster.findIndex(m => m.Student_ID === record.assigned_to);
                const nextPerson = roster[(currentIdx + 1) % roster.length];
                const personName = this.currentMember ? this.currentMember.Name_Ch : record.assigned_to;
                
                const allEmails = this.data.members
                    .filter(m => m.Status === 'Active' && m.Email)
                    .map(m => m.Email)
                    .join(',');

                const payload = {
                    to: allEmails,
                    subject: `【GOODLAB 公告】本週值日生已完成，下週為 ${nextPerson ? nextPerson.Name_Ch : '未知'}`,
                    body: `
                        <div style="font-family: sans-serif; line-height: 1.6; color: #333;">
                            <h2 style="color: #059669;">✅ 值日生交接公告</h2>
                            <p>Hi 大家：</p>
                            <p>本週值日生 <b>${personName}</b> 已完成一般清潔與耗材清點工作！</p>
                            <p>👉 <b>下週值日生輪到：${nextPerson ? nextPerson.Name_Ch : '-'}</b></p>
                            <p>請下週負責人記得登入系統確認並執行任務。</p>
                        </div>
                    `
                };

                fetch(GAS_WEBHOOK_URL, {
                    method: 'POST',
                    mode: 'no-cors',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch(e => console.error("Webhook error:", e));
            }

        } catch (e) {
            this.showNotification('❌ 提交失敗: ' + e.message, 'error');
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
                substitute_from: this.currentMember.Student_ID
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
        try {
            await updateDoc(doc(db, 'duty_records', weekId), {
                assigned_to: this.currentMember.Student_ID,
                substitute_pending: null,
                substitute_from: null
            });
            this.showNotification('✅ 已接受代班，本週工作轉移到你身上！', 'success');
        } catch (e) {
            this.showNotification('❌ 操作失敗: ' + e.message, 'error');
        }
    },

    rejectSubstitute: async function() {
        const weekId = this._getDutyWeekId();
        try {
            await updateDoc(doc(db, 'duty_records', weekId), {
                substitute_pending: null,
                substitute_from: null
            });
            this.showNotification('已拒絕代班請求', 'info');
        } catch (e) {
            this.showNotification('❌ 操作失敗: ' + e.message, 'error');
        }
    }
};
