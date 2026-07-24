/**
 * GOODLAB — 維修紀錄管理模組
 * Phase 4：從 script.js 抽出維修紀錄 (logs) 相關邏輯。
 * 所有方法透過 mixin 混入 app 物件，因此使用 this. 存取共享狀態。
 */
import { db, doc, setDoc } from './firebase.js';
import { LOCATIONS_WITH_OTHER } from './constants.js';
import { UI } from '../shared.js';
import { generateId, formatDateForInput } from './utils.js';
import { fillInstrumentSelect } from './ui.js';

export const logsModule = {

    // === 篩選器設定 ===
    setLogFilter: function(status) {
        this.logFilterStatus = status;
        this.updateFilterUI();
        this.renderLogs();
    },

    // === 篩選器 UI 更新 ===
    updateFilterUI: function() {
        document.querySelectorAll('.filter-chip').forEach(btn => {
            if (btn.dataset.val === this.logFilterStatus) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    },

    // === 維修紀錄排序 ===
    sortLogs: function(key) {
        if (this.logSortState.key === key) {
            this.logSortState.direction = this.logSortState.direction === 'asc' ? 'desc' : 'asc';
        } else {
            this.logSortState.key = key;
            this.logSortState.direction = 'asc'; // 預設升冪
        }
        this.renderLogs();
    },

    // === 維修紀錄渲染 ===
    renderLogs: function() {
        const tbody = document.getElementById('log-tbody');
        if (!tbody) return;

        // ★ 加入防火牆攔截：User 與 Guest 都不能看維修紀錄
        if (this.currentRole !== 'Admin') {
            tbody.innerHTML = this.guestGuardHtml;
            return;
        }
        const searchEl = document.getElementById('search-log');
        const term = searchEl ? searchEl.value.toLowerCase() : ''; // ★ 安全防呆
        const statusFilter = this.logFilterStatus;
        const isAdmin = this.currentRole === 'Admin';
        // [Phase 2] 移除對不存在的 #filter-log-location 的死參照

        let filtered = this.data.logs.filter(log => {
            const inst = this.data.instruments.find(i => i.Instrument_ID === log.Instrument_ID);
            const instName = inst ? inst.Name : log.Instrument_ID;
            const instLoc = inst ? inst.Location : ""; 
            
            const text = (log.Problem_Desc + instName + log.Log_ID).toLowerCase();
            const matchText = text.includes(term);
            const matchStatus = statusFilter === 'All' ? true : log.Status === statusFilter;
            
            return matchText && matchStatus;
        });

        // 排序邏輯
        const sortKey = this.logSortState.key;
        const dir = this.logSortState.direction === 'asc' ? 1 : -1;
        filtered.sort((a, b) => {
            let valA = a[sortKey] || '';
            let valB = b[sortKey] || '';
            
            if (sortKey === 'Date_Reported') {
                return (new Date(valA) - new Date(valB)) * dir;
            }
            return valA > valB ? dir : (valA < valB ? -dir : 0);
        });

        UI.renderTable({
            containerId: 'log-tbody',
            data: filtered,
            columns: [
                { 
                    width: '80px', align: 'center', 
                    render: row => {
                        const isClosed = row.Status === 'Closed';
                        const color = isClosed ? 'var(--success)' : 'var(--danger)';
                        const titleText = isClosed ? '已結案' : '待處理';
                        const cursor = isAdmin ? 'cursor: pointer;' : 'cursor: default;';
                        
                        return `<span style="color: ${color}; ${cursor}" 
                                      onclick="event.stopPropagation(); ${isAdmin ? `app.quickResolve('${row.Log_ID}')` : ''}" 
                                      title="${isAdmin ? '點擊切換狀態 (' + titleText + ')' : titleText}">
                                    <i class="ph-fill ph-circle" style="font-size:1.2rem;"></i>
                                </span>`;
                    }
                },
                { width: '80px', align: 'center', render: row => `<span style="color:${this.getUrgencyColor(row.Urgency)}; font-weight:bold;">${row.Urgency}</span>` },
                { 
                    width: '110px', 
                    // ★ 日期格式化：只取前面的 YYYY-MM-DD
                    render: row => row.Date_Reported ? row.Date_Reported.split('T')[0].split(' ')[0] : '-' 
                },
                { width: '150px', render: row => {
                    const inst = this.data.instruments.find(i => i.Instrument_ID === row.Instrument_ID);
                    return inst ? inst.Name : '-';
                }},
                { className: 'hide-mobile', render: row => row.Problem_Desc },
                { className: 'hide-mobile', render: row => `<span style="color:var(--success);">${row.Solution || '-'}</span>` },
                { width: '100px', className: 'hide-mobile', render: row => this.getMemberName(row.Owner_ID || row.Reporter_ID || row.Reporter) },
                { width: '80px', align: 'center', render: row => `<button onclick="event.stopPropagation(); app.openLogModal('${row.Log_ID}')" class="btn btn-sm btn-secondary" ${isAdmin?'':'disabled'}><i class="ph ph-pencil-simple"></i></button>` }
            ],
            emptyMessage: "目前沒有任何符合的維修紀錄"
        });
    },

    // === 緊急度顏色 ===
    getUrgencyColor: function(u) {
        if(u >= 5) return '#dc3545'; 
        if(u >= 3) return '#fd7e14'; 
        return '#198754'; 
    },

    // === 快速結案 ===
    quickResolve: function(id) {
        this.openLogModal(id);
        const statusSelect = document.getElementById('Log_Status');
        if (statusSelect.value === 'Open') {
            statusSelect.value = 'Closed';
            statusSelect.dispatchEvent(new Event('change')); 
        }
    },

    // === 開啟維修紀錄 Modal ===
    openLogModal: function(inputData = null) {
        const modalId = 'log-modal';
        const isAdmin = this.currentRole === 'Admin';
        
        // 1. 強制識別資料來源
        let data = null;
        if (typeof inputData === 'string') {
            // 如果傳入的是 ID 字串，加強比對邏輯 (同時比對 Log_ID 與 Firestore id)
            data = this.data.logs.find(l => (l.Log_ID === inputData || l.id === inputData));
            if (!data) {
                console.error("找不到對應的維修紀錄 ID:", inputData);
                this.showNotification("找不到該筆紀錄，請重新整理頁面。", "error");
                return;
            }
        } else if (inputData && typeof inputData === 'object') {
            data = inputData;
        }

        if (data && !isAdmin) {
            this.showNotification('一般成員只能新增設備問題回報。', 'warning');
            return;
        }

        const title = data ? '編輯維修紀錄' : '回報維修問題';

        // 2. 初始化所有下拉選單 (人員、區域)
        this.fillMemberSelect('Owner_ID', data?.Owner_ID || '');
        
        const locSelect = document.getElementById('Log_Location_Filter');
        // ★ Phase 2：改用 constants.js 的 LOCATIONS_WITH_OTHER，移除硬編碼陣列
        locSelect.innerHTML = '<option value="">(選擇區域)</option>' + 
            LOCATIONS_WITH_OTHER.map(a => `<option value="${a}">${a}</option>`).join('');

        // 3. 根據有無資料進行填值 (Data Binding)
        if (data) {
            // === 編輯模式 ===
            document.getElementById('Log_ID').value = data.Log_ID || data.id || '';
            document.getElementById('Problem_Desc').value = data.Problem_Desc || '';
            document.getElementById('Solution').value = data.Solution || '';
            document.getElementById('Date_Reported').value = this.formatDateForInput(data.Date_Reported);
            document.getElementById('Date_Resolved').value = this.formatDateForInput(data.Date_Resolved);
            
            // 下拉選單填值 (回報人)
            const ownerSelect = document.getElementById('Owner_ID');
            ownerSelect.value = data.Owner_ID || '';

            // 更新 UI 狀態按鈕與緊急度
            this.setLogFormStatus(data.Status || 'Open');
            this.setUrgency(data.Urgency || 3);

            // 重要：反查儀器地點並載入儀器選單
            let instLoc = '';
            const inst = this.data.instruments.find(i => i.Instrument_ID === data.Instrument_ID);
            if (inst) instLoc = inst.Location;
            
            locSelect.value = instLoc;
            this.filterLogInstruments(instLoc, data.Instrument_ID);

        } else {
            // === 新增模式 ===
            document.getElementById('Log_ID').value = this.generateId('LOG');
            document.getElementById('Problem_Desc').value = '';
            document.getElementById('Solution').value = '';
            document.getElementById('Date_Reported').value = this.formatDateForInput(new Date());
            document.getElementById('Date_Resolved').value = '';
            
            // 自動帶入當前登入者
            const currentMember = this.data.members.find(m => m.Google_UID === this.currentUser?.uid);
            document.getElementById('Owner_ID').value = currentMember ? currentMember.Student_ID : '';
            
            this.setLogFormStatus('Open');
            this.setUrgency(3);
            locSelect.value = '';
            this.filterLogInstruments('', '');
        }

        // 4. 權限與鎖定邏輯 (修正 Readonly 衝突)
        const isLocked = data && data.Status === 'Closed' && !isAdmin;
        
        const fields = ['Log_Location_Filter', 'Log_Instrument_ID', 'Owner_ID', 'Date_Reported', 'Problem_Desc'];
        fields.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                if (el.tagName === 'SELECT' || el.type === 'date') el.disabled = isLocked;
                else el.readOnly = isLocked;
            }
        });
        const ownerSelect = document.getElementById('Owner_ID');
        if (ownerSelect) ownerSelect.disabled = !isAdmin || isLocked;

        // 一般成員只需要填寫回報內容；處理狀態與結案欄位由 Admin 管理。
        ['Log_Status', 'Solution', 'Date_Resolved'].forEach(id => {
            const fieldGroup = document.getElementById(id)?.closest('.form-group');
            if (fieldGroup) fieldGroup.style.display = isAdmin ? '' : 'none';
        });
        const canEditSolution = isAdmin;
        document.getElementById('Solution').readOnly = !canEditSolution;
        document.getElementById('Date_Resolved').disabled = !canEditSolution;
        document.getElementById('Log_Status').disabled = !isAdmin;

        // 火焰圖示點擊鎖定
        const urgencyDiv = document.getElementById('urgency-rating');
        if (urgencyDiv) {
            urgencyDiv.style.pointerEvents = isLocked ? 'none' : 'auto';
            urgencyDiv.style.opacity = isLocked ? '0.6' : '1';
        }

        // 按鈕顯示隱藏
        const saveBtn = document.getElementById('btn-save-l');
        const delBtn = document.getElementById('btn-del-l');
        if (saveBtn) saveBtn.style.display = isLocked ? 'none' : 'block';
        if (delBtn) delBtn.style.display = (data && isAdmin) ? 'block' : 'none';

        UI.openModal({ modalId, title });
    },

    // === 依區域篩選儀器下拉選單 ===
    filterLogInstruments: function(targetArea = null, targetInstId = null) {
        const locSelect = document.getElementById('Log_Location_Filter');

        // 如果有傳入 targetArea (開窗時)，優先使用；否則抓畫面上的值 (onchange 時)
        const loc = targetArea !== null ? targetArea : locSelect.value;
        
        fillInstrumentSelect(
            'Log_Instrument_ID',
            this.data.instruments,
            loc,
            targetInstId || ''
        );
    },

    // === Log 狀態自動連動 (結案時自動填日期) ===
    setupLogAutoStatus: function() {
        const statusSelect = document.getElementById('Log_Status');
        const dateResolved = document.getElementById('Date_Resolved');
        if (!statusSelect || !dateResolved) return; // ★ 安全防呆
        
        statusSelect.addEventListener('change', function() {
            if (this.value === 'Closed') {
                if (!dateResolved.value) dateResolved.value = app.formatDateForInput(new Date());
            } else {
                dateResolved.value = '';
            }
        });
    },

    // === 儲存維修紀錄 ===
    saveLog: async function() {
        const payload = {};
        document.querySelectorAll('#log-modal input, #log-modal select, #log-modal textarea').forEach(el => {
            // ★ Phase 1 修復：先排除輔助欄位，再做 replace，避免 'Log_Location_Filter' 變成 'Location_Filter' 後判斷失效
            if (el.id === 'Log_Location_Filter') return;
            let key = el.id;
            if (key.startsWith('Log_') && key !== 'Log_ID') {
                key = key.replace('Log_', '');
            }
            payload[key] = el.value;
        });

        if (this.currentRole !== 'Admin') {
            payload.Owner_ID = this.currentMember?.Student_ID || '';
            payload.Reporter_UID = this.currentUser?.uid || '';
            payload.Status = 'Open';
            payload.Solution = '';
            payload.Date_Resolved = '';
        }

        if (!payload.Instrument_ID) { alert("請選擇儀器"); return; }
        if (!payload.Problem_Desc) { alert("請填寫問題描述"); return; }

        const btn = document.getElementById('btn-save-l');
        btn.innerText = "儲存中...";
        btn.disabled = true;

        try {
            await setDoc(doc(db, "logs", payload.Log_ID), payload);
            this.closeModal('log-modal');
            this.showNotification("維修紀錄儲存成功", "success");
            // 若有需要，可以在此補上 this.renderLogs(); 讓畫面自動更新
        } catch (e) {
            this.showNotification("發生錯誤：" + e.message, 'error');
        } finally {
            btn.innerText = "儲存";
            btn.disabled = false;
        }
    },

    // === 維修紀錄狀態切換 UI ===
    setLogFormStatus: function(status) {
        document.getElementById('Log_Status').value = status;
        const btnOpen = document.getElementById('btn-log-open');
        const btnClosed = document.getElementById('btn-log-closed');
        const dateResolved = document.getElementById('Date_Resolved');
        
        if(status === 'Open') {
            if(btnOpen) btnOpen.classList.add('active-danger');
            if(btnClosed) btnClosed.classList.remove('active-success');
            if(dateResolved) dateResolved.value = '';
        } else {
            if(btnClosed) btnClosed.classList.add('active-success');
            if(btnOpen) btnOpen.classList.remove('active-danger');
            if (dateResolved && !dateResolved.value) dateResolved.value = app.formatDateForInput(new Date());
        }
    },

    // === 火焰評分特效 ===
    setUrgency: function(level) {
        document.getElementById('Urgency').value = level;
        const fires = document.querySelectorAll('#urgency-rating .ph-fire');
        fires.forEach((fire, index) => {
            if (index < level) {
                fire.style.color = 'var(--danger)'; 
            } else {
                fire.style.color = '#e2e8f0'; // 灰色代表未點燃
            }
        });
    }
};
