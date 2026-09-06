/**
 * GOODLAB — 認證與權限模組
 * Phase 4：處理 Google 登入/登出、學號綁定、角色檢查與側邊欄 UI 控制。
 */
import { auth, provider, db, doc, onSnapshot, updateDoc, signInWithPopup, onAuthStateChanged, signOut } from './firebase.js';
import { showNotification, closeModal } from './ui.js';
import { escapeHtml } from './utils.js';
import { getMobileNavigationLayout } from './mobile-navigation.js';
import { resolveAdminAccess } from './admin-access.js';

export const authModule = {

    _googleIdentitySyncUid: null,
    _adminRegistryUnsubscribe: null,
    _adminRegistry: null,
    _adminRegistryLoaded: false,
    _adminAccessWarning: null,
    _adminRegistryError: null,
    _legacyAdminAccess: 'idle',
    _legacyAdminProbeKey: null,
    _legacyAdminUnsubscribe: null,

    stopLegacyAdminProbe: function() {
        this._legacyAdminUnsubscribe?.();
        this._legacyAdminUnsubscribe = null;
        this._legacyAdminProbeKey = null;
        this._legacyAdminAccess = 'idle';
    },

    watchLegacyAdminPermission: function(uid, studentId) {
        const key = `${uid}:${studentId}`;
        if (this._legacyAdminProbeKey === key) return;
        this.stopLegacyAdminProbe();
        this._legacyAdminProbeKey = key;
        this._legacyAdminAccess = 'pending';
        // This reserved document need not exist. A server read is allowed only
        // when the deployed accounting rules recognize this UID as an admin.
        // No document is created and no financial data is used or displayed.
        this._legacyAdminUnsubscribe = onSnapshot(
            doc(db, 'accounting', 'goodlab-admin-permission-check'),
            { includeMetadataChanges: true },
            snapshot => {
                if (this.currentUser?.uid !== uid || this._legacyAdminProbeKey !== key) return;
                if (snapshot.metadata.fromCache) return;
                this._legacyAdminAccess = 'allowed';
                this.checkUserRole();
            },
            error => {
                if (this.currentUser?.uid !== uid || this._legacyAdminProbeKey !== key) return;
                this._legacyAdminAccess = error.code === 'permission-denied' ? 'denied' : 'error';
                this.checkUserRole();
            }
        );
    },

    // Authentication only reads authorization; it must never grant it.
    watchOwnAdminRegistry: function(uid) {
        this._adminRegistryUnsubscribe?.();
        this.stopLegacyAdminProbe();
        this._adminRegistryUnsubscribe = null;
        this._adminRegistry = null;
        this._adminRegistryLoaded = false;
        this._adminAccessWarning = null;
        this._adminRegistryError = null;
        if (!uid) return;
        this._adminRegistryUnsubscribe = onSnapshot(doc(db, 'admins', uid), snapshot => {
            if (this.currentUser?.uid !== uid) return;
            this._adminRegistry = snapshot.exists() ? snapshot.data() : null;
            this._adminRegistryLoaded = true;
            this._adminRegistryError = null;
            this.checkUserRole();
        }, error => {
            if (this.currentUser?.uid !== uid) return;
            this._adminRegistry = null;
            this._adminRegistryLoaded = true;
            this._adminRegistryError = error.code || 'unknown';
            console.warn('[GOODLAB] 無法確認管理授權：', error.code || error.message);
            this.checkUserRole();
        });
    },

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
        if (!this.confirmEmploymentLeave()) return;
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
            if (!user || previousUid !== user.uid) {
                this.resetEmploymentEditors();
                this._employmentSaveToken = null;
                this._googleIdentitySyncUid = null;
                this.syncRealtimeListeners('Anonymous');
                this.overviewEditorOpen = false;
                this.overviewMeetingEditorOpen = false;
                this.overviewNoticeEditId = null;
                this.employmentPersonEditorOpen = false;
                this.employmentPersonDrafts = [];
                this.projectEditorOpen = false;
                this.empMonthEditor = null;
                for (const id of ['bulletin-editor-modal', 'log-details-modal', 'routine-edit-modal']) {
                    document.getElementById(id)?.remove();
                }
                for (const id of ['overview-content', 'duty-content', 'employment-content']) {
                    const region = document.getElementById(id);
                    if (region) region.innerHTML = '';
                }
            }
            this.currentUser = user;
            this.currentMember = null;
            this.currentRole = 'Guest';
            if (!user || previousUid !== user.uid) this.watchOwnAdminRegistry(user?.uid);

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
    checkUserRole: async function() {
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
            const access = resolveAdminAccess(memberData, this.currentUser.uid, {
                loaded: this._adminRegistryLoaded,
                entry: this._adminRegistry,
                error: this._adminRegistryError
            }, this._legacyAdminProbeKey === `${this.currentUser.uid}:${memberData.Student_ID}` ? this._legacyAdminAccess : 'idle');
            if (access === 'legacy-check') {
                this.watchLegacyAdminPermission(this.currentUser.uid, memberData.Student_ID);
            } else if (Object.hasOwn(this._adminRegistry || {}, 'student_id') || !this._adminRegistry || memberData.Role !== 'Admin') {
                this.stopLegacyAdminProbe();
            }
            const adminAuthorized = access === 'authorized';
            this.currentRole = adminAuthorized ? 'Admin' : 'User';
            this.currentMember = memberData; // Phase 5: 儲存完整 member 資料
            const roleLabel = this.currentRole === 'Admin' ? '管理員' : '成員';
            if(userInfo) userInfo.innerText = `${memberData.Name_Ch} · ${roleLabel}`;
            closeModal('bind-modal');

            if (memberData.Role === 'Admin' && !adminAuthorized) {
                const pending = ['checking', 'legacy-check'].includes(access);
                if (userInfo) userInfo.innerText = `${memberData.Name_Ch} · ${pending ? '正在確認管理權限' : '管理權限需確認'}`;
                const warningKey = `${memberData.Student_ID}:${access}`;
                if (!pending && this._adminAccessWarning !== warningKey) {
                    this._adminAccessWarning = warningKey;
                    const messages = {
                        'lookup-error': '暫時無法向伺服器確認管理權限，請檢查連線後重新整理；這不表示你的 Admin 身分已被撤銷。',
                        missing: '成員資料是 Admin，但目前登入帳號沒有對應的管理員登錄。請專案管理者核對登入帳號與管理員登錄。',
                        mismatch: '管理員登錄的學號與目前成員資料不一致，請專案管理者核對登錄資料。',
                        'legacy-denied': '找到舊版管理員登錄，但目前資料庫規則未授予此帳號行政資料權限，請專案管理者核對登錄與線上規則。'
                    };
                    this.showNotification(messages[access] || '無法確認管理權限，請重新整理後再試。', 'warning', 10000);
                }
            } else {
                this._adminAccessWarning = null;
            }

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
            this.stopLegacyAdminProbe();
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

    // Compatibility entry point for an older open page: never attempt an unsafe UID claim.
    submitBinding: async function() {
        this.showNotification('目前暫停以學號自行開通，請聯絡管理員核對帳號。', 'info', 8000);
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
            <ol><li>點右上角「Google 登入」。</li><li>選擇自己要用來登入 GOODLAB 的 Google 帳號。</li><li>若帳號尚未開通，請將學號及目前登入的 Google 信箱提供給管理員核對。</li></ol>
            <p>Google 登入信箱與學校通知信箱是兩筆不同資料。目前暫停以學號自行綁定；既有已綁定帳號仍可正常登入。</p>
        </section>`;
        const commonQuestions = `<section class="help-section">
            <h4>常見問題</h4>
            <ul><li><strong>看不到編輯按鈕：</strong>該功能可能僅限 Admin，或產編盤點目前未開放。</li><li><strong>值日清單不能勾：</strong>只有本週值日生及 Admin 可以修改。</li><li><strong>資料沒有更新：</strong>先重新整理；仍有問題再把頁面與錯誤訊息告訴 Admin。</li></ul>
        </section>`;

        if (this.currentRole === 'User') {
            const pageContent = this.userHelpDocs?.[tabName] || '<p>本頁目前沒有額外操作說明。</p>';
            const pageNames = { overview: '實驗室總覽', duty: '值日生工作', 'duty-history': '值日生執行紀錄', inventory: '財產清冊', instruments: '儀器設備', members: '實驗室成員' };
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
