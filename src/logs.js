/**
 * GOODLAB — 維修紀錄管理模組
 * Phase 4：從 script.js 抽出維修紀錄 (logs) 相關邏輯。
 * 所有方法透過 mixin 混入 app 物件，因此使用 this. 存取共享狀態。
 */
import { db, doc, setDoc } from './firebase.js';
import { LOCATIONS_WITH_OTHER } from './constants.js';
import { UI } from '../shared.js';
import { generateId, formatDateForInput, escapeHtml } from './utils.js';
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
        document.querySelectorAll('#page-logs .filter-chip').forEach(btn => {
            btn.setAttribute('aria-pressed', String(btn.dataset.val === this.logFilterStatus));
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

        // 維修紀錄僅提供管理員與已登入成員查看。
        if (!['Admin', 'User'].includes(this.currentRole)) {
            tbody.innerHTML = this.guestGuardHtml;
            return;
        }
        const searchEl = document.getElementById('search-log');
        const term = searchEl ? searchEl.value.trim().toLowerCase() : '';
        const statusFilter = this.logFilterStatus;
        const isAdmin = this.currentRole === 'Admin';
        // [Phase 2] 移除對不存在的 #filter-log-location 的死參照

        let filtered = this.data.logs.filter(log => {
            const inst = this.data.instruments.find(i => i.Instrument_ID === log.Instrument_ID);
            const instName = inst ? inst.Name : log.Instrument_ID;
            const ownerName = this.getMemberName(log.Owner_ID || log.Reporter_ID || log.Reporter || '');
            const text = [
                log.Problem_Desc,
                log.Solution,
                instName,
                log.Instrument_ID,
                log.Log_ID,
                ownerName
            ].filter(Boolean).join(' ').toLowerCase();
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

        const countEl = document.getElementById('log-result-count');
        if (countEl) countEl.textContent = `${{ All: '全部', Open: '待處理', Closed: '已結案' }[statusFilter] || '全部'} · ${filtered.length} 筆${term ? '搜尋結果' : '紀錄'}`;
        const actionId = row => escapeHtml(JSON.stringify(String(row.Log_ID || row.id || '')));

        UI.renderTable({
            containerId: 'log-tbody',
            data: filtered,
            columns: [
                { 
                    className: 'log-status-cell',
                    render: row => {
                        const isClosed = row.Status === 'Closed';
                        const titleText = isClosed ? '已結案' : '待處理';
                        const content = `<span class="log-status-dot" aria-hidden="true"></span>${titleText}`;
                        const className = `log-status ${isClosed ? 'is-closed' : 'is-open'}`;
                        return isAdmin
                            ? `<button type="button" class="${className}" onclick="event.stopPropagation(); app.quickResolve(${actionId(row)})" aria-label="${isClosed ? '編輯結案紀錄' : '處理維修紀錄'}：${escapeHtml(row.Problem_Desc)}">${content}</button>`
                            : `<span class="${className}">${content}</span>`;
                    }
                },
                { className: 'log-urgency-cell', render: row => `<span class="log-urgency ${row.Urgency >= 5 ? 'is-high' : row.Urgency >= 3 ? 'is-medium' : ''}" aria-label="緊急度 ${escapeHtml(row.Urgency || '—')}，最高 5 級">${escapeHtml(row.Urgency || '—')}<span> / 5</span></span>` },
                { className: 'log-report-cell', render: row => `<span class="log-report-date">${escapeHtml(row.Date_Reported ? row.Date_Reported.split('T')[0].split(' ')[0] : '—')}</span><span class="log-reporter">${escapeHtml(this.getMemberName(row.Owner_ID || row.Reporter_ID || row.Reporter))}</span>` },
                { className: 'log-instrument-cell', render: row => {
                    const inst = this.data.instruments.find(i => i.Instrument_ID === row.Instrument_ID);
                    return escapeHtml(inst ? inst.Name : (row.Instrument_ID || '未指定儀器'));
                }},
                { className: 'log-problem-cell', render: row => `<span class="log-mobile-label">問題描述</span><div class="log-description">${escapeHtml(row.Problem_Desc || '未填寫問題描述')}</div>` },
                { className: 'log-solution-cell', render: row => `<span class="log-mobile-label">處理進度／解決方案</span><div class="log-description ${row.Solution ? '' : 'log-unfilled'}">${escapeHtml(row.Solution || '尚未填寫')}</div>` },
                { className: 'log-actions-cell', render: row => `<button type="button" onclick="event.stopPropagation(); app.openLogModal(${actionId(row)})" class="btn btn-sm btn-secondary log-edit-button" aria-label="${isAdmin ? '編輯' : '查看'}維修紀錄：${escapeHtml(row.Problem_Desc)}">${isAdmin ? '編輯' : '查看'}</button>` }
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
        if (this.currentRole !== 'Admin') return;
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

        if (!isAdmin) {
            if (this.currentRole === 'User' && typeof inputData === 'string') {
                this.openLogDetails(inputData);
                return;
            }
            this.showNotification('設備問題回報目前僅由 Admin 建立。', 'warning');
            return;
        }
        
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

        // 4. 維修表單目前只開放 Admin。
        const fields = ['Log_Location_Filter', 'Log_Instrument_ID', 'Owner_ID', 'Date_Reported', 'Problem_Desc'];
        fields.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                if (el.tagName === 'SELECT' || el.type === 'date') el.disabled = false;
                else el.readOnly = false;
            }
        });
        const ownerSelect = document.getElementById('Owner_ID');
        if (ownerSelect) ownerSelect.disabled = false;

        ['Log_Status', 'Solution', 'Date_Resolved'].forEach(id => {
            const fieldGroup = document.getElementById(id)?.closest('.form-group');
            if (fieldGroup) fieldGroup.style.display = '';
        });
        document.getElementById('Solution').readOnly = false;
        document.getElementById('Date_Resolved').disabled = false;
        document.getElementById('Log_Status').disabled = false;

        const urgencyDiv = document.getElementById('urgency-rating');
        if (urgencyDiv) {
            urgencyDiv.style.pointerEvents = 'auto';
            urgencyDiv.style.opacity = '1';
        }

        const saveBtn = document.getElementById('btn-save-l');
        const delBtn = document.getElementById('btn-del-l');
        if (saveBtn) saveBtn.style.display = 'block';
        if (delBtn) delBtn.style.display = (data && isAdmin) ? 'block' : 'none';

        UI.openModal({ modalId, title });
    },

    openLogDetails: function(id) {
        if (!['Admin', 'User'].includes(this.currentRole)) return;
        const record = this.data.logs.find(item => item.Log_ID === id || item.id === id);
        if (!record) return;
        const instrument = this.data.instruments.find(item => item.Instrument_ID === record.Instrument_ID);
        document.getElementById('log-details-modal')?.remove();
        const modal = document.createElement('div');
        modal.id = 'log-details-modal';
        modal.className = 'modal';
        const rows = [
            ['儀器', instrument?.Name || record.Instrument_ID || '未指定'],
            ['狀態', record.Status === 'Closed' ? '已結案' : '待處理'],
            ['回報日期', record.Date_Reported || '未填寫'],
            ['問題描述', record.Problem_Desc || '未填寫'],
            ['處理方式', record.Solution || '尚未填寫處理方式'],
            ['負責人', this.getMemberName(record.Owner_ID || record.Reporter_ID || record.Reporter) || '未指定'],
            ['結案日期', record.Date_Resolved || '尚未結案']
        ];
        modal.innerHTML = `<div class="modal-content record-details-dialog"><div class="modal-header"><h3>維修紀錄</h3><button type="button" class="close" aria-label="關閉維修紀錄" onclick="app.closeModal('log-details-modal')">&times;</button></div><div class="modal-body"><p class="form-help">紀錄由管理員維護；如有補充資訊，請聯絡設備負責人。</p><dl class="record-details">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl></div><div class="modal-footer"><button type="button" class="btn btn-secondary" onclick="app.closeModal('log-details-modal')">關閉</button></div></div>`;
        document.body.appendChild(modal);
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
        if (this.currentRole !== 'Admin') {
            this.showNotification('設備問題回報目前僅由 Admin 建立。', 'warning');
            return;
        }
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

        if (!payload.Instrument_ID) { alert("請選擇儀器"); return; }
        payload.Problem_Desc = String(payload.Problem_Desc || '').trim();
        payload.Solution = String(payload.Solution || '').trim();
        if (!payload.Problem_Desc) { alert("請填寫問題描述"); return; }
        if (payload.Problem_Desc.length > 2000) { alert("問題描述請控制在 2000 字以內"); return; }
        if (payload.Solution.length > 3000) { alert("解決方案請控制在 3000 字以內"); return; }

        const existing = this.data.logs.find(log =>
            log.Log_ID === payload.Log_ID || log._id === payload.Log_ID || log.id === payload.Log_ID
        );
        const now = new Date().toISOString();
        payload.Updated_At = now;
        if (existing?.Created_At) payload.Created_At = existing.Created_At;
        else if (!existing) payload.Created_At = now;

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
