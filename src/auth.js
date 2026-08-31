/**
 * GOODLAB — 認證與權限模組
 * Phase 4：處理 Google 登入/登出、學號綁定、角色檢查與側邊欄 UI 控制。
 */
import { auth, provider, db, doc, updateDoc, signInWithPopup, onAuthStateChanged, signOut } from './firebase.js';
import { showNotification, closeModal } from './ui.js';
import { escapeHtml } from './utils.js';
import { getMobileNavigationLayout } from './mobile-navigation.js';
import { normalizeStudentId } from './member-id-migration.js';

export const authModule = {

    _googleIdentitySyncUid: null,

    // === 登入 ===
    login: async function() {
        try {
            await signInWithPopup(auth, provider);
        } catch (error) {
            this.showNotification("登入失敗: " + error.message, 'error');
        }
    },

    // === 登出 ===
    logout: async function() {
        try {
            await signOut(auth);
        } catch (error) {
            this.showNotification("登出失敗", 'error');
        }
    },

    // === 監聽登入狀態 ===
    setupAuthListener: function() {
        onAuthStateChanged(auth, (user) => {
            const previousUid = this.currentUser ? this.currentUser.uid : null;
            if (!user || previousUid !== user.uid) this._googleIdentitySyncUid = null;
            this.currentUser = user;
            this.currentMember = null;
            this.currentRole = 'Guest';

            if (user) {
                if (previousUid !== user.uid) this.membersLoaded = false;
                this.syncRealtimeListeners('Guest');
            } else {
                this.membersLoaded = false;
                this.data.members = [];
                this.syncRealtimeListeners('Anonymous');
            }

            this.checkUserRole();
        });
    },

    // === 權限中控室 (解決非同步時間差) ===
    checkUserRole: function() {
        const userInfo = document.getElementById('user-info');
        const btnLogin = document.getElementById('btn-login');
        const btnLogout = document.getElementById('btn-logout');

        // 1. 完全沒登入 Google
        if (!this.currentUser) {
            this.currentRole = 'Guest';
            this.currentMember = null;
            if(userInfo) userInfo.innerText = "";
            if(btnLogin) btnLogin.classList.remove('hidden');
            if(btnLogout) btnLogout.classList.add('hidden');
            this.updateSidebarUI();
            this.switchTab('welcome');
            return;
        }

        // 2. 登入中但成員資料還沒跑完
        if (!this.membersLoaded) {
            if(userInfo) userInfo.innerText = "正在確認使用權限...";
            if(btnLogin) btnLogin.classList.add('hidden');
            if(btnLogout) btnLogout.classList.remove('hidden');
            return;
        }

        // 3. 已經登入 Google，切換按鈕
        if(btnLogin) btnLogin.classList.add('hidden');
        if(btnLogout) btnLogout.classList.remove('hidden');

        const memberData = this.data.members.find(m => m.Google_UID === this.currentUser.uid);

        if (memberData) {
            // 已綁定成功 (User / Admin)
            this.currentRole = memberData.Role || 'User';
            this.currentMember = memberData; // Phase 5: 儲存完整 member 資料
            const roleLabel = this.currentRole === 'Admin' ? '管理員' : '成員';
            if(userInfo) userInfo.innerText = `${memberData.Name_Ch} · ${roleLabel}`;
            closeModal('bind-modal');
            this.syncRealtimeListeners(this.currentRole);
            const googleEmail = String(this.currentUser.email || '').trim().toLowerCase();
            const googleDisplayName = String(this.currentUser.displayName || '').trim();
            const needsIdentitySync = googleEmail && (
                memberData.Google_Email !== googleEmail
                || (googleDisplayName && memberData.Google_Display_Name !== googleDisplayName)
            );
            if (needsIdentitySync && this._googleIdentitySyncUid !== this.currentUser.uid) {
                this._googleIdentitySyncUid = this.currentUser.uid;
                const googleIdentity = { Google_Email: googleEmail };
                if (googleDisplayName) googleIdentity.Google_Display_Name = googleDisplayName;
                updateDoc(doc(db, 'members', memberData.Student_ID), googleIdentity)
                    .catch(error => console.warn('[GOODLAB] 無法同步 Google 帳號資料：', error.code || error.message));
            }
        } else {
            // 已登入但未綁定學號 ➔ 視為 Guest
            this.currentRole = 'Guest';
            this.currentMember = null;
            if(userInfo) userInfo.innerText = `${this.currentUser.displayName || 'Google 使用者'} · 尚未綁定`;
            this.syncRealtimeListeners('Guest');
            this.switchTab('welcome');
            // 彈出強制綁定視窗
            const bindModal = document.getElementById('bind-modal');
            const bindAccountEmail = document.getElementById('bind-account-email');
            if (bindAccountEmail) bindAccountEmail.textContent = this.currentUser.email || '無法取得信箱';
            if (bindModal) bindModal.classList.remove('hidden');
        }
        this.updateSidebarUI();
        if (this.currentMember) {
            const activePage = document.querySelector('.page-section.active');
            const activeTab = activePage ? activePage.id.replace('page-', '') : '';
            if (!this.getAllowedTabs().includes(activeTab) || activeTab === 'welcome') this.routeFromHash();
            this.renderOverview();
        }
    },

    // === 自訂綁定視窗邏輯：取消綁定 ===
    cancelBinding: function() {
        // 使用者拒絕綁定，直接強制踢出系統
        signOut(auth).then(() => {
            closeModal('bind-modal');
            this.showNotification("已取消綁定，帳號已登出。", "info");
            // 登出後 Firebase 會自動觸發 onAuthStateChanged 變成 Guest 狀態
        }).catch(e => {
            this.showNotification("登出失敗: " + e.message, "error");
        });
    },

    // === 自訂綁定視窗邏輯：送出綁定 ===
    submitBinding: async function() {
        const studentId = normalizeStudentId(document.getElementById('Bind_Input_ID').value);
        if (!studentId) {
            this.showNotification("請輸入學號！", "warning");
            return;
        }

        // 從資料庫找這個學號
        const member = this.data.members.find(m => normalizeStudentId(m?.Student_ID) === studentId);

        if (!member) {
            this.showNotification("找不到此學號。請 Admin 確認成員資料內的 Student_ID 欄位與輸入學號一致，再重新整理後綁定。", "error", 8000);
            return;
        }

        // ★ 安全檢查：此學號是否已被別的 Google 帳號綁走了？
        if (member.Google_UID && member.Google_UID !== this.currentUser.uid) {
            this.showNotification("綁定失敗：此學號已被其他 Google 帳戶使用。", "error");
            return;
        }

        const loginEmail = String(this.currentUser?.email || '').trim().toLowerCase();
        const loginDisplayName = String(this.currentUser?.displayName || '').trim();
        if (!loginEmail) {
            this.showNotification("目前 Google 帳號沒有可記錄的信箱，請改用一般 Google 帳號登入。", "error");
            return;
        }

        try {
            const btn = document.getElementById('btn-submit-bind');
            btn.innerText = "綁定中...";
            btn.disabled = true;

            // 先寫入 UID 完成認領，維持與既有 Firestore Rules 相容。
            const memberRef = doc(db, "members", member.Student_ID);
            await updateDoc(memberRef, { Google_UID: this.currentUser.uid });
            try {
                const googleIdentity = { Google_Email: loginEmail };
                if (loginDisplayName) googleIdentity.Google_Display_Name = loginDisplayName;
                await updateDoc(memberRef, googleIdentity);
            } catch (identityError) {
                console.warn('[GOODLAB] 綁定已完成，但 Google 帳號資料將在新規則發布後補登：', identityError.code || identityError.message);
            }

            this.showNotification("綁定成功！權限已解鎖。", "success");
            closeModal('bind-modal');
            
            // 重新整理身分與 UI
            this.checkUserRole(); 
        } catch (e) {
            this.showNotification("寫入失敗: " + e.message, "error");
        } finally {
            document.getElementById('btn-submit-bind').disabled = false;
            document.getElementById('btn-submit-bind').innerText = "確認綁定";
        }
    },

    // === 側邊欄與手機 UI 動態控制 ===
    updateSidebarUI: function() {
        document.body.classList.toggle('guest-mode', this.currentRole === 'Guest');
        document.querySelectorAll('.admin-only').forEach(element => {
            element.style.display = this.currentRole === 'Admin' ? '' : 'none';
        });

        const navIds = ['overview', 'logs', 'routine', 'duty', 'inventory', 'accounting', 'members', 'employment', 'instruments'];
        const allowedIds = this.getAllowedTabs().filter(id => navIds.includes(id));
        const allowedSet = new Set(allowedIds);

        navIds.forEach(id => {
            const desktopButton = document.getElementById('nav-btn-' + id);
            if (desktopButton) desktopButton.style.display = allowedSet.has(id) ? 'flex' : 'none';
        });

        // 現有四個常用入口維持優先；五個以內全部直接顯示。
        const mobileLayout = getMobileNavigationLayout(allowedIds, {
            priorityIds: ['overview', 'instruments', 'duty', 'inventory']
        });
        const directSet = new Set(mobileLayout.directIds);
        const overflowSet = new Set(mobileLayout.overflowIds);

        document.querySelectorAll('.mobile-nav-item[data-nav-tab]').forEach(button => {
            button.style.display = directSet.has(button.dataset.navTab) ? 'flex' : 'none';
        });
        document.querySelectorAll('.mobile-drawer-item[data-nav-tab]').forEach(button => {
            button.style.display = overflowSet.has(button.dataset.navTab) ? 'flex' : 'none';
        });
        document.querySelectorAll('.mobile-drawer-group').forEach(group => {
            const hasVisibleItem = [...group.querySelectorAll('.mobile-drawer-item[data-nav-tab]')]
                .some(button => overflowSet.has(button.dataset.navTab));
            group.classList.toggle('hidden', !hasVisibleItem);
        });

        const moreBtn = document.getElementById('mobile-more-btn');
        if (moreBtn) {
            moreBtn.style.display = mobileLayout.showMore ? 'flex' : 'none';
            moreBtn.setAttribute('aria-expanded', 'false');
        }
        if (!mobileLayout.showMore) {
            document.getElementById('mobile-more-drawer')?.classList.add('hidden');
        }
    },

    // === 頁面說明 Modal ===
    openHelpModal: function() {
        // 抓取目前 active 的 page id，例如 'page-members' -> 'members'
        const activePage = document.querySelector('.page-section.active');
        if (!activePage) return;
        
        const tabName = activePage.id.replace('page-', '');
        const title = document.getElementById('help-modal-title');
        const body = document.getElementById('help-modal-body');
        if (!body) return;

        const loginGuide = `<section class="help-current-page">
            <h4>第一次登入與帳號綁定</h4>
            <ol><li>點右上角「Google 登入」。</li><li>選擇自己要用來登入 GOODLAB 的 Google 帳號。</li><li>輸入 Admin 已建立、且尚未被認領的學號並確認綁定。</li></ol>
            <p>Google 登入信箱與學校通知信箱是兩筆不同資料。若學號不在名單或已被綁定，請聯絡 Admin。</p>
        </section>`;
        const commonQuestions = `<section class="help-section">
            <h4>常見問題</h4>
            <ul><li><strong>看不到編輯按鈕：</strong>該功能可能僅限 Admin，或產編盤點目前未開放。</li><li><strong>值日清單不能勾：</strong>只有本週值日生及 Admin 可以修改。</li><li><strong>資料沒有更新：</strong>先重新整理；仍有問題再把頁面與錯誤訊息告訴 Admin。</li></ul>
        </section>`;

        if (this.currentRole === 'User') {
            const pageContent = this.userHelpDocs?.[tabName] || '<p>本頁目前沒有額外操作說明。</p>';
            const pageNames = { overview: '實驗室總覽', duty: '值日生工作', inventory: '產編清點', instruments: '儀器設備', members: '實驗室成員' };
            if (title) title.textContent = 'GOODLAB 使用說明';
            body.innerHTML = `<section class="help-current-page"><span class="help-eyebrow">目前頁面</span><h4>${escapeHtml(pageNames[tabName] || 'GOODLAB')}</h4>${pageContent}</section>${commonQuestions}`;
        } else if (this.currentRole === 'Admin') {
            if (title) title.textContent = 'Admin 頁面說明';
            body.innerHTML = this.helpDocs[tabName] || '<p>本頁目前沒有額外操作說明。</p>';
        } else {
            if (title) title.textContent = 'GOODLAB 登入說明';
            body.innerHTML = loginGuide;
        }
        
        // 這裡因為沒有填寫表單的需求，直接把 hidden 拿掉即可
        document.getElementById('help-modal').classList.remove('hidden');
    }
};
