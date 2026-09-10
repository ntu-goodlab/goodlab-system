import { db } from './firebase.js';
import { collection, doc, query, where, onSnapshot, updateDoc } from 'firebase/firestore';
import { inviteDutyAssistance, respondDutyAssistance } from './duty-assistance-access.js';
import { assistanceState, stampMillis } from './duty-assistance-state.js';
import { escapeHtml } from './utils.js';
const labels = { pending: '等待回覆', accepted: '已接受', declined: '已婉拒', cancelled: '已取消', expired: '已過期', invalidated: '已失效' };
const when = stamp => Number.isFinite(stampMillis(stamp))
    ? new Date(stampMillis(stamp)).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '同步中';
const errorMessage = error => error.code === 'permission-denied'
    ? '邀請、排班或帳號資格已變更，操作未完成。請關閉視窗後查看最新狀態。'
    : error.code === 'unavailable' ? '暫時無法連線。請待同步後查看結果，避免重複邀請。' : error.message;

export const dutyAssistanceModule = {
    syncDutyAssistance(state) {
        const enabled = state.role !== 'Guest' && state.status === 'ready' && state.member;
        const scope = enabled ? `${state.uid}:${state.role}:${stampMillis(state.entry.approved_at)}` : '';
        if (scope === this._assistScope) return;
        this._assistScope = scope;
        this._assistStops?.forEach(stop => stop());
        clearInterval(this._assistTimer);
        this._assistStops = []; this._assistRows = {}; this._assistErrors = new Set(); this._assistLoaded = new Set();
        if (!enabled || this._dutyHandoverDraft?.uid !== state.uid) this._dutyHandoverDraft = null;
        this.renderDutyAssistance();
        if (!enabled) return;
        const filters = state.role === 'Admin' ? [['all', collection(db, 'duty_requests')]]
            : ['from', 'to'].map(side => [side, query(collection(db, 'duty_requests'),
                where(`${side}_student`, '==', state.member.Student_ID), where(`${side}_access_at`, '==', state.entry.approved_at))]);
        this._assistExpected = filters.length;
        for (const [key, source] of filters) {
            this._assistStops.push(onSnapshot(source, { includeMetadataChanges: true }, snapshot => {
                if (this._assistScope !== scope) return;
                if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
                this._assistRows[key] = snapshot.docs.map(d => ({ ...d.data(), _id: d.id }));
                this._assistLoaded.add(key); this._assistErrors.delete(key); this.renderDutyAssistance();
            }, error => {
                if (this._assistScope !== scope) return;
                this._assistRows[key] = []; this._assistErrors.add(key); this.renderDutyAssistance();
            }));
        }
        this._assistTimer = setInterval(() => this.renderDutyAssistance(), 15000);
    },
    assistancePeople() { return this.currentRole === 'Admin' ? this.data.duty_people || [] : this.data.members; },
    assistanceRows() { return [...new Map(Object.values(this._assistRows || {}).flat().map(r => [r._id, r])).values()]; },
    renderDutyEventHistory(week) {
        const rows = (this.data.duty_events || []).filter(e => e.week === week).sort((a, b) => stampMillis(a.at) - stampMillis(b.at));
        if (!rows.length) return '';
        return `<section aria-label="值日交接紀錄"><h3>交接紀錄</h3><ul>${rows.map(e => `<li>${escapeHtml(when(e.at))} · ${e.kind === 'accepted'
            ? `${escapeHtml(e.from_name || e.from_student)} 邀請 ${escapeHtml(e.to_name || e.to_student)}，本人已接受代做`
            : `管理員指定 ${escapeHtml(e.to_name || e.to_student)}${e.from_student ? `（原執行：${escapeHtml(e.from_name || e.from_student)}）` : ''}：${escapeHtml(e.reason || '')}`}</li>`).join('')}</ul></section>`;
    },
    renderDutyAssistance() {
        document.getElementById('duty-assistance')?.remove();
        document.getElementById('duty-invitation-notice')?.remove();
        document.getElementById('duty-invitation-count')?.remove();
        if (!this.currentMember || this.currentRole === 'Guest') return;
        const people = this.assistancePeople(), week = this._getDutyWeekId();
        const record = this.data.duty_records.find(r => r._id === week);
        const rows = this.assistanceRows();
        const stateOf = invite => assistanceState(invite, this.data.duty_records.find(r => r._id === invite.week), people);
        const incoming = rows.filter(r => r.to_student === this.currentMember.Student_ID && stateOf(r) === 'pending');
        if (incoming.length) {
            const badge = document.createElement('span'); badge.id = 'duty-invitation-count'; badge.className = 'status-badge';
            badge.textContent = `${incoming.length} 待回覆`; document.getElementById('nav-btn-duty')?.append(badge);
        }
        if (incoming.length || this._assistErrors?.size) {
            const banner = document.createElement('div'); banner.id = 'duty-invitation-notice'; banner.className = 'duty-card'; banner.setAttribute('role', 'status');
            const p = document.createElement('p'); p.textContent = this._assistErrors.size ? '代做邀請載入失敗，請重試。' : `你有 ${incoming.length} 筆待回覆的代做邀請。`;
            const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-primary btn-sm';
            button.textContent = this._assistErrors.size ? '重新載入邀請' : '查看邀請';
            button.addEventListener('click', () => {
                if (this._assistErrors.size) { this._assistScope = null; this.syncDutyAssistance(this._approvedState); }
                else this.switchTab('duty');
            });
            banner.append(p, button); document.querySelector('.page-container')?.prepend(banner);
        }
        const host = document.getElementById('duty-content');
        if (!host || !record) return;
        const panel = document.createElement('section'); panel.id = 'duty-assistance'; panel.className = 'duty-card';
        panel.innerHTML = '<h3>本週代做與交接</h3><p>本人接受後才交接，保留清單進度；只影響本週，不交換未來輪值。</p>';
        const directoryLoaded = this.currentRole === 'Admin' ? this.realtimeLoadState.duty_directory === 'loaded' : this.membersLoaded;
        const ready = directoryLoaded && this._assistLoaded?.size === this._assistExpected && !this._assistErrors?.size;
        const addButton = (label, handler) => {
            const b = document.createElement('button'); b.className = 'btn btn-secondary btn-sm'; b.type = 'button'; b.textContent = label;
            b.addEventListener('click', handler); panel.append(b); return b;
        };
        if (!ready) { const p = document.createElement('p'); p.textContent = '正在確認代做邀請與可協助成員…'; panel.append(p); }
        else {
            const pending = rows.find(r => r._id === record.assist_request && stateOf(r) === 'pending');
            if (record.assigned_to === this.currentMember.Student_ID && record.status === 'pending' && !record.submitted && !pending) {
                addButton('請人代做', () => this.openDutyAssistanceInvite());
            }
            const visible = rows.filter(r => r.week === week).sort((a, b) => stampMillis(b.created_at) - stampMillis(a.created_at));
            for (const r of visible) {
                const status = stateOf(r), p = document.createElement('p');
                p.textContent = `${r.from_name} → ${r.to_name} · ${labels[status]}${r.note ? ` · 交接：${r.note}` : ''}`; panel.append(p);
                if (status === 'pending' && r.to_student === this.currentMember.Student_ID) {
                    addButton('接受代做', () => this.openDutyAssistanceResponse(r, 'accepted'));
                    addButton('婉拒', () => this.openDutyAssistanceResponse(r, 'declined'));
                }
                if (r.status === 'pending' && (r.from_student === this.currentMember.Student_ID || this.currentRole === 'Admin')) {
                    addButton(status === 'pending' ? '取消邀請' : '結束失效邀請', () => this.openDutyAssistanceResponse(r, 'cancelled'));
                }
            }
        }
        panel.insertAdjacentHTML('beforeend', this.renderDutyEventHistory(week));
        if (this._dutyHandoverDraft?.week === week && this._dutyHandoverDraft.uid === this.currentUser.uid) {
            const label = document.createElement('label'); label.textContent = '交接已完成，這是你尚未送出的留言草稿（不會覆蓋對方資料）';
            const draft = document.createElement('textarea'); draft.readOnly = true; draft.value = this._dutyHandoverDraft.text; label.append(draft); panel.append(label);
            addButton('複製草稿', async () => { try { await navigator.clipboard.writeText(draft.value); this.showNotification('草稿已複製。'); } catch { draft.focus(); draft.select(); this.showNotification('請手動複製已選取的草稿。'); } });
        }
        host.prepend(panel);
    },
    assistanceDialog(title, body) {
        document.getElementById('duty-assist-modal')?.remove();
        const modal = document.createElement('div'); modal.id = 'duty-assist-modal'; modal.className = 'modal';
        modal.innerHTML = `<div class="modal-content"><div class="modal-header"><h3>${escapeHtml(title)}</h3></div>
            <div class="modal-body">${body}<p role="alert" class="form-error"></p></div>
            <div class="modal-footer"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button type="button" class="btn btn-primary" data-submit>確認</button></div></div>`;
        modal.querySelector('[data-cancel]').addEventListener('click', () => this.closeModal('duty-assist-modal'));
        document.body.append(modal); return modal;
    },
    openDutyAssistanceInvite() {
        const week = this._getDutyWeekId(), student = this.currentMember.Student_ID, uid = this.currentUser.uid;
        const people = this.assistancePeople().filter(p => p.Status === 'Active' && p.duty_access_at && p.Student_ID !== student);
        const modal = this.assistanceDialog('請人代做本週值日', `<p>${escapeHtml(week)} 起這一週。對方接受前仍由你負責；接受後保留目前清單進度。</p>
            <div class="form-group"><label for="assist-search">搜尋姓名或學號</label><input id="assist-search" type="search"></div>
            <div class="form-group"><label for="assist-person">邀請對象</label><select id="assist-person"></select></div>
            <div class="form-group"><label for="assist-note">交接事項（選填，僅雙方及管理員可見）</label><textarea id="assist-note" maxlength="500" rows="3"></textarea></div>`);
        const select = modal.querySelector('#assist-person');
        const update = () => {
            const previous = select.value, needle = modal.querySelector('#assist-search').value.trim().toLowerCase();
            select.replaceChildren();
            const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '請選擇已開通的成員'; select.append(placeholder);
            people.filter(p => `${p.Name_Ch} ${p.Student_ID}`.toLowerCase().includes(needle)).forEach(p => {
                const option = document.createElement('option'); option.value = p.Student_ID; option.textContent = `${p.Name_Ch}（${p.Student_ID}）`; select.append(option);
            });
            select.value = [...select.options].some(o => o.value === previous) ? previous : '';
        };
        update(); modal.querySelector('#assist-search').addEventListener('input', update);
        const button = modal.querySelector('[data-submit]'); button.textContent = '送出邀請';
        const requestId = crypto.randomUUID();
        button.addEventListener('click', async () => {
            if (!select.value) { modal.querySelector('[role="alert"]').textContent = '請先選擇邀請對象。'; return; }
            if (this.currentUser?.uid !== uid) return;
            button.disabled = true;
            try {
                const draft = document.getElementById('duty-note');
                if (draft && !draft.disabled) await updateDoc(doc(db, 'duty_records', week), { note: draft.value.slice(0, 1000), updated_at: new Date().toISOString() });
                await inviteDutyAssistance(db, { requestId, week, fromStudent: student, toStudent: select.value, note: modal.querySelector('#assist-note').value.trim() });
                if (this.currentUser?.uid === uid) { this.closeModal('duty-assist-modal'); this.showNotification('邀請已送出，對方接受前仍由你負責。', 'success'); }
            } catch (error) { modal.querySelector('[role="alert"]').textContent = errorMessage(error); button.disabled = false; }
        });
    },
    openDutyAssistanceResponse(invite, action) {
        const uid = this.currentUser.uid, student = this.currentMember.Student_ID;
        const record = this.data.duty_records.find(r => r._id === invite.week);
        const completed = Object.values(record?.cleaning || {}).filter(v => v === true).length;
        const title = action === 'accepted' ? '確認接受代做' : action === 'declined' ? '婉拒代做邀請' : '取消這筆邀請';
        const modal = this.assistanceDialog(title, `<p>${escapeHtml(invite.from_name)} 邀請 ${escapeHtml(invite.to_name)} 協助 ${escapeHtml(invite.week)} 起這一週。</p>
            ${action === 'accepted' ? `<p>清潔已完成 ${completed} 項，現有進度與留言將保留。接受後由你負責剩餘工作及提交；不影響你的其他輪值。</p>` : '<p>本週負責人不會因此改變。</p>'}`);
        const button = modal.querySelector('[data-submit]'); button.textContent = action === 'accepted' ? '確認接受' : action === 'declined' ? '確認婉拒' : '確認取消邀請';
        button.addEventListener('click', async () => {
            if (this.currentUser?.uid !== uid) return;
            button.disabled = true;
            try {
                await respondDutyAssistance(db, { requestId: invite._id, action, studentId: student, adminCancel: this.currentRole === 'Admin' });
                if (this.currentUser?.uid === uid) { this.closeModal('duty-assist-modal'); this.showNotification(action === 'accepted' ? '已接受代做，現在可繼續本週清單。' : '邀請已處理。', 'success'); }
            } catch (error) { modal.querySelector('[role="alert"]').textContent = errorMessage(error); button.disabled = false; }
        });
    }
};
