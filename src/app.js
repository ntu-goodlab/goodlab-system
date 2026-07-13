/**
 * GOODLAB — 主應用程式協調器 (Phase 5)
 * 
 * 將所有功能模組混入 (mixin) 到單一 app 物件中，
 * 維持原有的 this.xxx 呼叫慣例，同時享有模組化帶來的可維護性。
 */

// === 基礎設施 ===
import { db, collection, onSnapshot, doc, deleteDoc } from './firebase.js';
import { showNotification, closeModal, populateLocationSelects, fillMemberSelect, fillPayerSelect, copyEmail } from './ui.js';
import { generateId, formatDateForInput, getMemberName, calculateGrade } from './utils.js';
import { LOCATIONS, LOCATIONS_WITH_OTHER } from './constants.js';

// === 功能模組 ===
import { authModule } from './auth.js';
import { membersModule } from './members.js';
import { instrumentsModule } from './instruments.js';
import { logsModule } from './logs.js';
import { accountingModule } from './accounting.js';
import { inventoryModule } from './inventory.js';
import { dutyModule } from './duty.js';
import { routineModule } from './routine.js';
import { employmentModule } from './employment.js';

// === 主 App 物件 ===
const app = {
    // --- 共用狀態 ---
    data: {
        members: [], instruments: [], logs: [], accounting: [], inventory: [],
        duty_records: [], duty_state: null,
        routines: [],
        projects: [], employments: []
    },
    invSortState: { key: 'Property_ID', direction: 'asc' },
    tempLinkedPropId: null,
    currentEditingInstTags: [],
    currentInstIsActive: true,
    tempImportPayloads: [],
    sortState: { key: 'Location', direction: 'asc' },
    logSortState: { key: 'Date_Reported', direction: 'desc' },
    logFilterStatus: 'Open',
    accFilterStatus: 'All',
    invFilterStatus: 'All',
    currentUser: null,
    currentRole: 'Guest',
    currentMember: null, // Phase 5: 當前登入的 member 完整資料
    membersLoaded: false,
    realtimeUnsubscribers: new Map(),
    realtimeProfile: 'Anonymous',
    modalReturnFocus: new Map(),

    // --- 訪客遮罩 ---
    guestGuardHtml: `<tr><td colspan="10" style="text-align:center; padding: 50px 20px; background: #f8fafc;">
        <i class="ph-fill ph-lock-key" style="font-size: 3.5rem; color: #cbd5e1; margin-bottom: 15px; display: block;"></i>
        <div style="font-weight: 700; font-size: 1.2rem; color: var(--text-main);">權限不足，資料已鎖定</div>
        <div style="font-size: 0.95rem; color: var(--text-muted); margin-top: 6px;">請點擊右上角「Google 登入」並完成學號綁定，以解鎖實驗室機密資料。</div>
    </td></tr>`,

    // --- 頁面說明文案 ---
    helpDocs: {
        'members': `
            <h3 style="color: var(--primary); border-bottom: 2px solid var(--border-color); padding-bottom: 8px; margin-bottom: 12px;">人員管理與權限控制</h3>
            <p style="margin-bottom: 10px;">本模組負責管理實驗室成員資料、帳號綁定與系統操作權限。</p>
            <ul style="margin-top: 10px; padding-left: 20px; line-height: 1.6;">
                <li><strong>帳號綁定流程：</strong>新生需先由 Admin 於此處建立「學號」。新生使用 Google 帳號登入系統後，輸入該學號即可完成系統綁定。</li>
                <li><strong>資料不可變性：</strong>學號 (Student_ID) 為系統底層之唯一識別碼，建立存檔後即無法變更。</li>
                <li><strong>權限層級說明：</strong>
                    <ul>
                        <li><span style="color: var(--primary); font-weight: 600;">Admin：</span>具備全站最高權限，可進行資料增刪查改、產編匯入與公積金管理。</li>
                        <li><span style="color: var(--text-main); font-weight: 600;">User：</span>具備一般檢視權限，僅能回報維修紀錄及瀏覽公開資訊。</li>
                    </ul>
                </li>
            </ul>`,
        'instruments': `
            <h3 style="color: var(--primary); border-bottom: 2px solid var(--border-color); padding-bottom: 8px; margin-bottom: 12px;">儀器設備與資產管理</h3>
            <p style="margin-bottom: 10px;">本模組為實驗室硬體資產之核心資料庫，負責追蹤機台狀態與歷史履歷。</p>
            <ul style="margin-top: 10px; padding-left: 20px; line-height: 1.6;">
                <li><strong>跨系統關聯 (產編綁定)：</strong>編輯儀器時，右側可檢視並管理關聯之「學校財產編號」。一項儀器可包含多個產編（多對一架構）。</li>
                <li><strong>資料獨立性：</strong>解除產編綁定或刪除儀器時，產編原本的「物理位置 (實驗區域)」將被保留，不會被強制清空。</li>
                <li><strong>維修履歷整合：</strong>於列表中直接點擊任意儀器列，下方將即時展開該機台之歷史維修清單。</li>
            </ul>`,
        'logs': `
            <h3 style="color: var(--primary); border-bottom: 2px solid var(--border-color); padding-bottom: 8px; margin-bottom: 12px;">維修紀錄與除錯知識庫</h3>
            <p style="margin-bottom: 10px;">追蹤設備異常與維護進度，並作為未來交接之技術參考指南。</p>
            <ul style="margin-top: 10px; padding-left: 20px; line-height: 1.6;">
                <li><strong>報修標準作業：</strong>新增紀錄時，請先選擇「實驗區域」，系統將自動過濾出該區域之設備供您選擇。</li>
                <li><strong>狀態與緊急度：</strong>緊急度以 1 (最低) 至 5 (最高) 標示；Admin 可直接點擊列表左側之圖示，快速將案件切換為「已結案 (Closed)」。</li>
                <li><strong>知識庫建立：</strong>結案時請詳實填寫「解決方案」，以便未來發生相同異常時可快速檢索處置方式。</li>
            </ul>`,
        'accounting': `
            <h3 style="color: var(--primary); border-bottom: 2px solid var(--border-color); padding-bottom: 8px; margin-bottom: 12px;">公積金報帳系統</h3>
            <p style="margin-bottom: 10px;">監控銀行帳戶餘額、實驗室現金水位與代墊款項核銷進度。</p>
            <ul style="margin-top: 10px; padding-left: 20px; line-height: 1.6;">
                <li><strong>帳務燈號警示：</strong>
                    <ul>
                        <li><span style="color: var(--danger); font-weight: 600;">紅燈 (待還款)：</span>成員代墊款項，實驗室尚未以現金或匯款償還。</li>
                        <li><span style="color: var(--warning); font-weight: 600;">黃燈 (待回沖)：</span>已送出報帳程序，等待學校經費撥入銀行帳戶。</li>
                    </ul>
                </li>
                <li><strong>自動化防呆：</strong>輸入金額時一律填寫「正數」。系統將依據交易類型 (如：報帳、提款) 自動判斷並計算正負值。</li>
            </ul>`,
        'inventory': `
            <h3 style="color: var(--primary); border-bottom: 2px solid var(--border-color); padding-bottom: 8px; margin-bottom: 12px;">財產編號清點系統</h3>
            <p style="margin-bottom: 10px;">學校年度財產盤點與實驗室資產定位的自動化處理中心。</p>
            <ul style="margin-top: 10px; padding-left: 20px; line-height: 1.6;">
                <li><strong>匯入 Excel 規範與必要欄位：</strong>
                    <br>請直接上傳學校提供之 Excel 原檔。系統會自動略過前 6 行表頭。</li>
                <li><strong>盤點流程：</strong>Admin 開放盤點後，User 可點擊列表左側的燈號來切換「已盤/未盤」。</li>
                <li><strong>匯出功能：</strong>盤點完成後可匯出完整的 Excel 清冊。</li>
            </ul>`,
        'duty': `
            <h3 style="color: var(--primary); border-bottom: 2px solid var(--border-color); padding-bottom: 8px; margin-bottom: 12px;">值日生工作</h3>
            <p style="margin-bottom: 10px;">碩班同學每週輪流值日，負責實驗室清潔與耗材清點。</p>
            <ul style="margin-top: 10px; padding-left: 20px; line-height: 1.6;">
                <li><strong>輪值規則：</strong>依學號排序的碩班同學 (非 Admin) 自動輪值。</li>
                <li><strong>未完成順延：</strong>當週未提交時，系統會保留原輪值順序，以新週清單讓同一位值日生繼續；完成後才輪到下一位。</li>
                <li><strong>輪值對齊：</strong>切換自舊系統時，Admin 可將本週對齊到實際輪值者；Admin 手動指定下週則會優先於自動順延。</li>
                <li><strong>代班機制：</strong>當週值日生可以發出代班邀請，待對方確認後工作才會轉移；單次代班不會改變後續輪值順序。</li>
                <li><strong>耗材補貨：</strong>點擊耗材旁的 <i class="ph ph-info"></i> 可查看廠商電話；手機可直接撥號，也可複製電話。其他廠商請使用頁尾共用聯絡表。</li>
                <li><strong>完成交接：</strong>可在提交前填寫補貨、叫貨或交接備註；提交後系統會寄送完成摘要與下週值日生資訊。</li>
            </ul>`,
        'routine': `
            <h3 style="color: var(--primary); border-bottom: 2px solid var(--border-color); padding-bottom: 8px; margin-bottom: 12px;">實驗室 Routine</h3>
            <p style="margin-bottom: 10px;">管理週期性維護任務，自動追蹤下次到期日並提醒。僅 Admin 可見。</p>`,
        'employment': `
            <h3 style="color: var(--primary); border-bottom: 2px solid var(--border-color); padding-bottom: 8px; margin-bottom: 12px;">學生聘僱管理</h3>
            <p style="margin-bottom: 10px;">管理各計畫的學生聘僱紀錄，包含甘特圖與 Excel 匯出。僅 Admin 可見。</p>`
    },

    // --- 工具函式（混入到 app 上，讓各模組可以透過 this. 呼叫）---
    generateId,
    formatDateForInput,
    calculateGrade,
    showNotification,
    closeModal,
    populateLocationSelects,
    fillMemberSelect: function(selectId) {
        fillMemberSelect(selectId, this.data.members);
    },
    fillPayerSelect: function(selectId) {
        fillPayerSelect(selectId, this.data.members);
    },
    getMemberName: function(id) {
        return getMemberName(this.data.members, id);
    },
    copyEmail,

    // --- 共用刪除邏輯 ---
    deleteRecord: async function(collectionName, id, modalId) {
        if (!confirm("⚠️ 確定要永久刪除這筆資料嗎？刪除後無法復原！")) return;
        
        const btn = document.getElementById(`btn-del-${modalId.charAt(0)}`);
        if (btn) { btn.innerText = "刪除中..."; btn.disabled = true; }

        try {
            await deleteDoc(doc(db, collectionName, id));
            this.closeModal(modalId);
            this.showNotification("刪除成功", 'success');
        } catch (e) {
            this.showNotification("❌ 刪除失敗: " + e.message, 'error');
        } finally {
            if (btn) { btn.innerText = "刪除"; btn.disabled = false; }
        }
    },

    // --- 手機版「更多」選單 ---
    toggleMobileMore: function() {
        const drawer = document.getElementById('mobile-more-drawer');
        const trigger = document.getElementById('mobile-more-btn');
        if (!drawer) return;
        const willOpen = drawer.classList.contains('hidden');
        drawer.classList.toggle('hidden');
        if (trigger) trigger.setAttribute('aria-expanded', String(willOpen));
    },

    getAllowedTabs: function() {
        if (!this.currentUser) return ['welcome'];
        if (this.currentRole === 'Admin') {
            return ['overview', 'logs', 'routine', 'duty', 'inventory', 'accounting', 'members', 'employment', 'instruments'];
        }
        if (this.currentRole === 'User') {
            return ['overview', 'logs', 'duty', 'inventory', 'members', 'instruments'];
        }
        return ['welcome'];
    },

    renderOverview: function() {
        const container = document.getElementById('overview-content');
        const greeting = document.getElementById('overview-greeting');
        if (!container || !this.currentMember) return;

        const openLogs = this.data.logs.filter(item => item.Status === 'Open').length;
        const duty = typeof this._getCurrentDutyPerson === 'function' ? this._getCurrentDutyPerson() : null;
        const dutyName = duty && duty.member ? duty.member.Name_Ch : '尚未排定';
        const escapeText = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        })[character]);
        const safeDutyName = escapeText(dutyName);
        const isAdmin = this.currentRole === 'Admin';
        const accounting = isAdmin && typeof this.getAccountingSummary === 'function'
            ? this.getAccountingSummary()
            : null;
        const routines = isAdmin && typeof this.getUpcomingRoutines === 'function'
            ? this.getUpcomingRoutines(6)
            : [];
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        const routineRows = routines.map(routine => {
            let stateClass = 'routine-status-ok';
            let stateText = routine.next_due;
            if (routine.next_due < today) {
                stateClass = 'routine-status-overdue';
                stateText = `${routine.next_due} · 已逾期`;
            } else if (routine.next_due === today) {
                stateClass = 'routine-status-warn';
                stateText = `${routine.next_due} · 今天`;
            }
            return `<button type="button" class="overview-routine-row" onclick="app.switchTab('routine')">
                <span>${escapeText(routine.name)}</span>
                <span class="${stateClass}">${stateText}</span>
            </button>`;
        }).join('');

        greeting.textContent = `${this.currentMember.Name_Ch}，以下是目前資料摘要。`;
        container.innerHTML = `
            <div class="overview-kpis">
                ${isAdmin ? `<button class="overview-card overview-card-action" onclick="app.switchTab('accounting')">
                    <span class="overview-card-icon"><i class="ph ph-wallet" aria-hidden="true"></i></span>
                    <span class="overview-card-body"><span class="overview-card-label">帳務可用餘額</span><strong>$${(accounting?.totalBalance || 0).toLocaleString('zh-TW')}</strong><span>戶頭與現金合計</span></span>
                </button>` : ''}
                <button class="overview-card overview-card-action" onclick="app.switchTab('logs')">
                    <span class="overview-card-icon overview-card-icon-danger"><i class="ph ph-wrench" aria-hidden="true"></i></span>
                    <span class="overview-card-body"><span class="overview-card-label">待處理維修</span><strong>${openLogs}</strong><span>查看維修紀錄</span></span>
                </button>
                <button class="overview-card overview-card-action" onclick="app.switchTab('duty')">
                    <span class="overview-card-icon overview-card-icon-success"><i class="ph ph-broom" aria-hidden="true"></i></span>
                    <span class="overview-card-body"><span class="overview-card-label">本週值日生</span><strong class="overview-card-name">${safeDutyName}</strong><span>查看本週工作</span></span>
                </button>
            </div>
            ${isAdmin ? `<section class="overview-panel" aria-labelledby="overview-routine-heading">
                <div class="overview-panel-header">
                    <div><h3 id="overview-routine-heading">近期 Routine</h3><p>依下次更新日期排序</p></div>
                    <button class="btn btn-secondary btn-sm" onclick="app.switchTab('routine')">查看全部</button>
                </div>
                <div class="overview-routine-list">${routineRows || '<div class="empty">尚無設定下次更新日期的 Routine</div>'}</div>
            </section>` : ''}`;
    },

    // --- 頁面切換 ---
    switchTab: function(tabId, fromRoute = false) {
        if (!this.getAllowedTabs().includes(tabId)) return;

        document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
        const targetPage = document.getElementById('page-' + tabId);
        if (targetPage) targetPage.classList.add('active');

        // 桌面版側邊欄 highlight
        document.querySelectorAll('.nav-item').forEach(btn => {
            const isMatch = btn.getAttribute('onclick') && btn.getAttribute('onclick').includes("'" + tabId + "'");
            btn.classList.toggle('active', isMatch);
            if (isMatch) btn.setAttribute('aria-current', 'page');
            else btn.removeAttribute('aria-current');
        });

        // 手機版底部欄 highlight
        document.querySelectorAll('.mobile-nav-item').forEach(btn => {
            if (btn.id === 'mobile-more-btn') return; // 「更多」按鈕不參與 highlight
            const isMatch = btn.getAttribute('onclick') && btn.getAttribute('onclick').includes("'" + tabId + "'");
            btn.classList.toggle('active', isMatch);
        });

        const titleMap = {
            'welcome': '歡迎',
            'overview': '實驗室總覽',
            'members': '人員管理',
            'instruments': '儀器設備',
            'logs': '維修紀錄',
            'accounting': '公積金報帳',
            'inventory': '產編清點',
            'duty': '值日生工作',
            'routine': '實驗室 Routine',
            'employment': '學生聘僱'
        };
        const titleEl = document.getElementById('current-page-title');
        if (titleEl) titleEl.innerText = titleMap[tabId] || '實驗室管理';

        // 切頁時觸發對應渲染
        const renderMap = {
            'overview': () => this.renderOverview(),
            'inventory': () => this.renderInventory(),
            'instruments': () => this.renderInstruments(),
            'logs': () => this.renderLogs(),
            'accounting': () => this.renderAccounting(),
            'members': () => this.renderMembers(),
            'duty': () => this.renderDuty(),
            'routine': () => this.renderRoutine(),
            'employment': () => this.renderEmployment()
        };
        if (renderMap[tabId]) renderMap[tabId]();

        if (!fromRoute && window.location.hash !== `#/${tabId}`) {
            history.pushState({ tabId }, '', `#/${tabId}`);
        }

        const main = document.getElementById('main-content');
        if (main) main.focus({ preventScroll: true });
    },

    routeFromHash: function() {
        const requested = window.location.hash.replace(/^#\/?/, '') || (this.currentUser ? 'overview' : 'welcome');
        const fallback = this.currentUser ? 'overview' : 'welcome';
        const target = this.getAllowedTabs().includes(requested) ? requested : fallback;
        this.switchTab(target, target === requested);
    },

    // --- Firebase 即時連線 ---
    getRealtimeConfig: function() {
        return {
            members: { dataKey: 'members', withId: false, onData: () => { this.membersLoaded = true; this.renderMembers(); this.checkUserRole(); } },
            instruments: { dataKey: 'instruments', withId: false, onData: () => { this.renderInstruments(); this.renderOverview(); } },
            logs: { dataKey: 'logs', withId: false, onData: () => { this.renderLogs(); this.renderOverview(); } },
            inventory: { dataKey: 'inventory', withId: false, onData: () => { this.renderInventory(); this.renderOverview(); } },
            duty_records: { dataKey: 'duty_records', withId: true, onData: () => { this.renderDuty(); this.renderOverview(); } },
            accounting: { dataKey: 'accounting', withId: false, onData: () => { this.renderAccounting(); this.calcDashboard(); this.renderOverview(); } },
            routines: { dataKey: 'routines', withId: true, onData: () => { this.renderRoutine(); this.renderOverview(); } },
            projects: { dataKey: 'projects', withId: true, onData: () => this.renderEmployment() },
            employments: { dataKey: 'employments', withId: true, onData: () => this.renderEmployment() }
        };
    },

    syncRealtimeListeners: function(profile) {
        const allowedByProfile = {
            Anonymous: [],
            Guest: ['members'],
            User: ['members', 'instruments', 'logs', 'inventory', 'duty_records'],
            Admin: ['members', 'instruments', 'logs', 'inventory', 'duty_records', 'accounting', 'routines', 'projects', 'employments']
        };
        const allowed = new Set(allowedByProfile[profile] || []);
        const config = this.getRealtimeConfig();

        for (const [name, unsubscribe] of this.realtimeUnsubscribers.entries()) {
            if (!allowed.has(name)) {
                unsubscribe();
                this.realtimeUnsubscribers.delete(name);
                this.data[config[name].dataKey] = [];
            }
        }

        allowed.forEach(name => {
            if (this.realtimeUnsubscribers.has(name)) return;
            const item = config[name];
            const unsubscribe = onSnapshot(collection(db, name), snapshot => {
                this.data[item.dataKey] = snapshot.docs.map(document => item.withId ? ({ _id: document.id, ...document.data() }) : document.data());
                item.onData();
            }, error => {
                this.data[item.dataKey] = [];
                if (name === 'members') this.membersLoaded = true;
                console.warn(`[GOODLAB] ${name} listener unavailable: ${error.code || error.message}`);
                if (this.currentUser) this.showNotification(`無法載入${name}資料，請重新整理或聯絡管理員。`, 'error');
                item.onData();
            });
            this.realtimeUnsubscribers.set(name, unsubscribe);
        });

        this.realtimeProfile = profile;
    },

    setupRealtimeListeners: function() {
        this.syncRealtimeListeners(this.currentUser ? 'Guest' : 'Anonymous');
    },

    // --- Modal 事件 ---
    setupModalEvents: function() {
        const prepareModal = modal => {
            if (!modal || modal.dataset.a11yReady === 'true') return;
            modal.dataset.a11yReady = 'true';
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');

            const heading = modal.querySelector('.modal-header h3');
            if (heading) {
                if (!heading.id) heading.id = `${modal.id}-title`;
                modal.setAttribute('aria-labelledby', heading.id);
            }

            modal.querySelectorAll('.close').forEach(close => {
                close.setAttribute('role', 'button');
                close.setAttribute('tabindex', '0');
                close.setAttribute('aria-label', '關閉對話框');
                close.addEventListener('keydown', event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        close.click();
                    }
                });
            });

            modal.querySelectorAll('.form-group').forEach(group => {
                const label = group.querySelector('label');
                const control = group.querySelector('input:not([type="hidden"]), select, textarea');
                if (label && control && control.id && !label.htmlFor) label.htmlFor = control.id;
            });

            const syncModalFocus = () => {
                const isOpen = !modal.classList.contains('hidden');
                if (isOpen && !this.modalReturnFocus.has(modal.id)) {
                    this.modalReturnFocus.set(modal.id, document.activeElement);
                    requestAnimationFrame(() => {
                        const target = modal.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex="0"]');
                        if (target) target.focus();
                    });
                } else if (!isOpen && this.modalReturnFocus.has(modal.id)) {
                    const trigger = this.modalReturnFocus.get(modal.id);
                    this.modalReturnFocus.delete(modal.id);
                    if (trigger && document.contains(trigger)) trigger.focus();
                }
            };
            const observer = new MutationObserver(syncModalFocus);
            observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
            syncModalFocus();
        };

        document.querySelectorAll('.modal').forEach(prepareModal);
        const dynamicModalObserver = new MutationObserver(records => {
            records.forEach(record => record.addedNodes.forEach(node => {
                if (!(node instanceof HTMLElement)) return;
                if (node.classList.contains('modal')) prepareModal(node);
                node.querySelectorAll?.('.modal').forEach(prepareModal);
            }));
        });
        dynamicModalObserver.observe(document.body, { childList: true, subtree: true });
    },

    // --- 初始化 ---
    init: function() {
        this.populateLocationSelects();
        this.setupModalEvents();
        this.setupAutoStatus();
        this.setupLogAutoStatus();
        this.updateFilterUI();
        this.updateAccFilterUI();
        this.setupAuthListener();
    }
};

// === 混入所有功能模組 ===
Object.assign(app, authModule);
Object.assign(app, membersModule);
Object.assign(app, instrumentsModule);
Object.assign(app, logsModule);
Object.assign(app, accountingModule);
Object.assign(app, inventoryModule);
Object.assign(app, dutyModule);
Object.assign(app, routineModule);
Object.assign(app, employmentModule);

// === 全域 UX 監聽器 ===
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal:not(.hidden)').forEach(m => app.closeModal(m.id));
        // 也關閉手機更多選單
        const drawer = document.getElementById('mobile-more-drawer');
        if (drawer && !drawer.classList.contains('hidden')) drawer.classList.add('hidden');
    }

    if (e.key === 'Tab') {
        const modal = document.querySelector('.modal:not(.hidden)');
        if (!modal) return;
        const focusable = [...modal.querySelectorAll('button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')]
            .filter(element => element.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }
});

window.addEventListener('popstate', () => app.routeFromHash());

window.app = app;

document.addEventListener("DOMContentLoaded", () => app.init());
