import { auth, db, doc, onSnapshot, onAuthStateChanged } from './firebase.js';
import { createApprovedSession } from './approved-session.js';
import { requestApprovedMembership, approveMembershipRequest } from './approved-member-access.js';
import { escapeHtml } from './utils.js';
import { approvalState } from './approval-state.js';

export const approvedAuthModule = {
    approvedAccessEnabled: true,
    setupAuthListener() {
        let identityEpoch = 0;
        this._approvedSession = createApprovedSession({
            watch: (path, next, error) => onSnapshot(doc(db, ...path.split('/')),
                { includeMetadataChanges: true }, next, error),
            onState: state => {
                const priorRole = this.currentRole;
                this._approvedState = state;
                this.currentMember = state.member;
                this.currentRole = state.role;
                if (priorRole === 'Admin' && state.role !== 'Admin' || state.role === 'Guest') {
                    this.resetEmploymentEditors();
                    this._employmentSaveToken = null;
                    document.querySelectorAll('.modal:not(#bind-modal)').forEach(modal => modal.classList.add('hidden'));
                    for (const id of ['overview-content', 'duty-content', 'employment-content', 'access-requests-panel']) {
                        const element = document.getElementById(id); if (element) element.replaceChildren();
                    }
                }
                this.syncRealtimeListeners(state.role);
                this.syncDutyAssistance?.(state);
                if (state.role === 'Guest' || priorRole === 'Admin' && state.role !== 'Admin') {
                    this.renderMembers(); this.renderLogs(); this.renderInstruments(); this.renderInventory();
                    this.renderAccounting(); this.renderEmployment({ preserveDrafts: false });
                }
                this.checkUserRole();
            }
        });
        onAuthStateChanged(auth, async user => {
            const current = ++identityEpoch;
            this.currentUser = user;
            this._approvedSession.stop();
            this.syncRealtimeListeners('Anonymous');
            this.membersLoaded = false;
            this._ownRequestStop?.(); this._ownRequestStop = null;
            this._ownAccessRequest = null;
            if (!user) return;
            try {
                const token = await user.getIdTokenResult();
                if (current !== identityEpoch) return;
                this._approvedSession.start({ uid: user.uid, email: token.claims.email,
                    emailVerified: token.claims.email_verified === true,
                    signInProvider: token.signInProvider });
                if (token.signInProvider === 'google.com' && token.claims.email_verified === true) {
                    this._ownRequestStop = onSnapshot(doc(db, 'access_requests', user.uid), snapshot => {
                        if (current !== identityEpoch) return;
                        this._ownAccessRequest = snapshot.exists() ? snapshot.data() : null;
                        this.renderJoinRequest();
                    }, () => { if (current === identityEpoch) this.renderJoinRequest(); });
                }
            } catch (error) {
                if (current !== identityEpoch) return;
                this._approvedState = { role: 'Guest', status: 'error', error: error.code };
                this.checkUserRole();
            }
        });
    },
    checkUserRole() {
        const state = this._approvedState || { status: 'checking', role: 'Guest' };
        const loggedIn = Boolean(this.currentUser);
        document.getElementById('btn-login')?.classList.toggle('hidden', loggedIn);
        document.getElementById('btn-logout')?.classList.toggle('hidden', !loggedIn);
        const info = document.getElementById('user-info');
        if (info) info.textContent = !loggedIn ? '' : state.status === 'checking' ? '正在確認使用權限…'
            : this.currentMember ? `${this.currentMember.Name_Ch} · ${this.currentRole === 'Admin' ? '管理員' : '成員'}`
            : `${this.currentUser.email || 'Google 帳號'} · ${state.status === 'error' ? '無法確認授權' : '尚未開通'}`;
        this.updateSidebarUI();
        const modal = document.getElementById('bind-modal');
        modal?.classList.toggle('hidden', !loggedIn || Boolean(this.currentMember) || state.status === 'checking');
        this.renderJoinRequest();
        if (!this.currentMember) this.switchTab('welcome', true);
        else {
            const active = document.querySelector('.page-section.active')?.id.replace('page-', '');
            if (!this.getAllowedTabs().includes(active)) this.routeFromHash();
            this.renderOverview();
        }
    },
    renderJoinRequest() {
        const host = document.querySelector('#bind-modal .modal-body');
        if (!host || !this.currentUser || this.currentRole !== 'Guest') return;
        // Preserve a typed student ID across access and request watcher updates.
        const draft = document.getElementById('join-student-id')?.value || this._ownAccessRequest?.student_id || '';
        const error = this._approvedState?.status === 'error';
        const hasEntry = Boolean(this._approvedState?.entry);
        host.innerHTML = `<p>${error ? '暫時無法確認使用權限，請重新登入後再試。' : hasEntry
            ? '帳號已有授權紀錄，但身分或在學狀態不一致，請聯絡管理員核對。'
            : '請填寫學號送出申請，由管理員核對 Google 帳號後開通。既有成員若尚未完成遷移，請先聯絡管理員。'}</p>
            <div class="bind-account"><i class="ph ph-google-logo" aria-hidden="true"></i><span><small>目前登入帳號</small><strong>${escapeHtml(this.currentUser.email || '')}</strong></span></div>
            ${!error && !hasEntry ? `<div class="form-group"><label for="join-student-id">學號</label><input id="join-student-id" maxlength="128" value="${escapeHtml(draft)}" autocomplete="off"></div>
            <p role="status">${this._ownAccessRequest ? '申請已送出，等待管理員核對。' : '送出申請不會立即取得實驗室資料權限。'}</p>
            <button class="btn btn-primary" id="join-submit" type="button" onclick="app.submitBinding()">${this._ownAccessRequest ? '更新申請' : '送出申請'}</button>` : ''}`;
    },
    async submitBinding() {
        const user = this.currentUser;
        const studentId = document.getElementById('join-student-id')?.value.trim().toLowerCase();
        const button = document.getElementById('join-submit');
        if (button) button.disabled = true;
        try {
            await requestApprovedMembership(db, user, studentId);
            if (this.currentUser?.uid === user.uid) this.showNotification('申請已送出，請等待管理員核對。', 'success');
        } catch (error) { this.showNotification(error.message, 'error'); }
        finally { if (button) button.disabled = false; }
    },
    renderAccessRequests() {
        let panel = document.getElementById('access-requests-panel');
        if (this.currentRole !== 'Admin') { panel?.remove(); return; }
        if (!panel) {
            panel = document.createElement('section'); panel.id = 'access-requests-panel';
            panel.className = 'duty-card';
            document.getElementById('page-members')?.prepend(panel);
        }
        const requests = this.data.access_requests || [];
        panel.innerHTML = '<h3>帳號開通申請</h3><p>先向本人核對學號與 Google 帳號。首次開通為一般成員；管理權限請另行設定。</p>';
        if (!requests.length) { const p = document.createElement('p'); p.textContent = '目前沒有待核准的申請。'; panel.append(p); }
        for (const request of requests) {
            const member = this.data.members.find(m => m.Student_ID === request.student_id);
            const row = document.createElement('div'); row.className = 'access-request-row';
            const text = document.createElement('p');
            text.textContent = `${member?.Name_Ch || '查無成員'} · ${request.student_id} · ${request.email}（Google 顯示名稱：${request.display_name || '未提供'}）`;
            const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-primary btn-sm';
            const state = approvalState(member, request);
            button.textContent = state.label;
            button.disabled = state.blocked;
            button.addEventListener('click', async () => {
                document.getElementById('approve-access-modal')?.remove();
                const modal = document.createElement('div'); modal.id = 'approve-access-modal'; modal.className = 'modal';
                modal.innerHTML = `<div class="modal-content"><div class="modal-header"><h3>確認開通 Google 帳號</h3></div>
                    <div class="modal-body"><p>請確認已向本人核對以下資料：</p><p><strong>${escapeHtml(member.Name_Ch)}</strong>（${escapeHtml(request.student_id)}）</p>
                    <p>${escapeHtml(request.email)}</p><p>本次會開通一般成員權限。</p>
                    ${state.reactivate ? '<p>此成員目前為已離校。恢復後會改為在學／在職，清空目前離校日期並保留原日期於歷史。</p><label><input type="checkbox" data-reactivate>我已確認要恢復這位成員的在學／在職狀態與使用權限</label>' : ''}
                    <p class="form-error" role="alert"></p></div>
                    <div class="modal-footer"><button class="btn btn-secondary" type="button" data-cancel>取消</button><button class="btn btn-primary" type="button" data-approve>已核對，開通帳號</button></div></div>`;
                modal.querySelector('[data-cancel]').addEventListener('click', () => modal.remove());
                if (state.reactivate) {
                    modal.querySelector('[data-approve]').disabled = true;
                    modal.querySelector('[data-reactivate]').addEventListener('change', event => {
                        modal.querySelector('[data-approve]').disabled = !event.target.checked;
                    });
                }
                modal.querySelector('[data-approve]').addEventListener('click', async event => {
                    event.target.disabled = true;
                    try {
                        await approveMembershipRequest(db, { uid: request._id, studentId: request.student_id,
                            expectedEmail: request.email, actorUid: this.currentUser?.uid,
                            expectedMemberStatus: member.Status,
                            reactivateInactive: modal.querySelector('[data-reactivate]')?.checked === true });
                        modal.remove(); this.showNotification('已開通一般成員權限。', 'success');
                    } catch (error) {
                        modal.querySelector('[role="alert"]').textContent = error.message;
                        event.target.disabled = false;
                    }
                });
                document.body.append(modal);
            });
            row.append(text, button); panel.append(row);
        }
    }
};
