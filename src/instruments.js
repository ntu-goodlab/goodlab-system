/**
 * GOODLAB — 儀器管理模組
 * Phase 4：從 script.js 抽出儀器管理相關邏輯。
 * 所有方法透過 mixin 混入 app 物件，因此使用 this. 存取共享狀態。
 */
import { db, doc, setDoc } from './firebase.js';
import { LOCATIONS } from './constants.js';
import { generateId, formatDateForInput } from './utils.js';
import { UI } from '../shared.js';

export const instrumentsModule = {

    // === 儀器排序切換 ===
    sortInstruments: function(key) {
        if (this.sortState.key === key) {
            this.sortState.direction = this.sortState.direction === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortState.key = key;
            this.sortState.direction = 'asc';
        }
        this.renderInstruments();
    },

    // === 1. 儀器渲染 ===
    renderInstruments: function() {
        const tbody = document.getElementById('inst-tbody');
        if (!tbody) return;

        // ★ 加入防火牆攔截
        if (this.currentRole === 'Guest') {
            tbody.innerHTML = this.guestGuardHtml;
            return;
        }
        const term = document.getElementById('search-inst').value.toLowerCase();
        const locFilter = document.getElementById('filter-inst-location').value;
        const isAdmin = this.currentRole === 'Admin';

        let filtered = this.data.instruments.filter(inst => {
            const matchText = (String(inst.Name || '') + String(inst.Instrument_ID || '')).toLowerCase().includes(term);
            const matchLoc = (locFilter === "" || inst.Location === locFilter); // ★ 區域過濾判斷
            return matchText && matchLoc;
        });

        const sortKey = this.sortState.key;
        const dir = this.sortState.direction === 'asc' ? 1 : -1;
        filtered.sort((a, b) => {
            let valA = a[sortKey] || ''; let valB = b[sortKey] || '';
            if (sortKey === 'Is_Active') { valA = a.Is_Active ? 1 : 0; valB = b.Is_Active ? 1 : 0; }
            return valA > valB ? dir : (valA < valB ? -dir : 0);
        });

        UI.renderTable({
            containerId: 'inst-tbody',
            data: filtered,
            columns: [
                { 
                    width: '80px', align: 'center', 
                    render: row => {
                        const color = row.Is_Active ? 'var(--success)' : 'var(--danger)';
                        const title = row.Is_Active ? '正常運作' : '報廢停用';
                        return `<i class="ph-fill ph-circle" style="color:${color}; font-size:1.2rem;" title="${title}"></i>`;
                    } 
                },
                { 
                    render: row => {
                        let html = `<strong>${row.Name}</strong>`;
                        if (row.Linked_Property_IDs && row.Linked_Property_IDs.length > 0) {
                            html += `<div style="margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px;">`;
                            row.Linked_Property_IDs.forEach(pid => {
                                html += `<span style="background: #e2e8f0; font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; color: #475569;"><i class="ph ph-tag"></i> ${pid}</span>`;
                            });
                            html += `</div>`;
                        }
                        return html;
                    }
                },
                { width: '120px', render: row => row.Location },
                { width: '150px', className: 'hide-mobile', render: row => row.Vendor_Info || '-' },
                { width: '120px', className: 'hide-mobile', render: row => this.getMemberName(row.Manager_ID) },
                { width: '80px', align: 'center', render: row => `<button onclick="event.stopPropagation(); app.openInstModal('${row.Instrument_ID}')" class="btn btn-sm btn-secondary" ${isAdmin?'':'disabled'}><i class="ph ph-pencil-simple"></i></button>` }
            ],
            emptyMessage: "查無符合的儀器資料",
            // 一般成員不會載入完整維修紀錄；只有 Admin 才能展開歷史，
            // 避免把「未載入」誤顯示成「沒有維修紀錄」。
            onRowClick: isAdmin ? ((rowData, tr) => this.toggleInstLogs(rowData, tr)) : null
        });
    },

    // === 2. 點擊展開儀器維修歷史 (In-Memory Cache 實作) ===
    toggleInstLogs: function(instData, tr) {
        // 如果已經展開了，就關閉它
        const nextTr = tr.nextElementSibling;
        if (nextTr && nextTr.classList.contains('sub-row')) {
            nextTr.remove(); 
            return;
        }

        // 關閉其他已展開的面板 (保持畫面乾淨)
        document.querySelectorAll('.sub-row').forEach(el => el.remove());

        // 從記憶體中過濾該儀器的所有 logs (零延遲、不消耗 Firebase 讀取數)
        const logs = this.data.logs.filter(log => log.Instrument_ID === instData.Instrument_ID);
        
        // 組合子面板 HTML
        let logsHtml = `<div style="padding: 15px; background: var(--bg-hover); border-radius: var(--radius-sm); border-left: 4px solid var(--primary); margin: 5px 0;">`;
        
        if (logs.length === 0) {
            logsHtml += `<div style="color: var(--text-muted); font-size: 0.9rem;"><i class="ph ph-info"></i> 此儀器目前無任何維修紀錄。</div>`;
        } else {
            logsHtml += `<strong style="display:block; margin-bottom:10px; font-size:0.95rem; color:var(--primary);"><i class="ph ph-clock-counter-clockwise"></i> 歷史維修紀錄 (${logs.length} 筆)</strong>`;
            
            // ★ 加入 table-layout: fixed，並為欄位分配精準比例
            logsHtml += `<table style="width:100%; font-size:0.9rem; margin:0; background: white; box-shadow: var(--shadow-sm); table-layout: fixed;">`;
            // ★ 修改表頭：給解決方案加上 hide-mobile
            logsHtml += `<tr style="background: #f1f5f9;">
                <th style="padding: 8px; width: 100px;">日期</th>
                <th style="padding: 8px; width: auto;">問題描述</th>
                <th style="padding: 8px; width: 30%;" class="hide-mobile">解決方案</th>
                <th style="padding: 8px; width: 80px; text-align: center;">狀態</th>
            </tr>`;
            
            logs.sort((a,b) => new Date(b.Date_Reported) - new Date(a.Date_Reported)).forEach(log => {
                const isClosed = log.Status === 'Closed';
                const color = isClosed ? 'var(--success)' : 'var(--danger)';
                const titleText = isClosed ? '已結案' : '待處理';
                const statusIcon = `<span style="color: ${color};" title="${titleText}"><i class="ph-fill ph-circle" style="font-size:1.2rem;"></i></span>`;
                
                const dateFormatted = log.Date_Reported ? log.Date_Reported.split('T')[0].split(' ')[0] : '-';

                // ★ 修改行資料：讓整行可點擊，加入 mobile-truncate 與 hide-mobile
                logsHtml += `<tr style="cursor: pointer;" onclick="app.openLogModal('${log.Log_ID}', true)" title="點擊檢視詳細紀錄">
                    <td style="padding: 8px; border-bottom: 1px solid var(--border-color);">${dateFormatted}</td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border-color);">
                        <div class="mobile-truncate" style="max-width: 150px;">${log.Problem_Desc}</div>
                    </td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border-color);" class="hide-mobile">${log.Solution || '-'}</td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border-color); text-align: center;">${statusIcon}</td>
                </tr>`;
            });
            logsHtml += `</table>`;
        }
        logsHtml += `</div>`;

        // 插入子列到表格中
        const subTr = document.createElement('tr');
        subTr.className = 'sub-row';
        subTr.innerHTML = `<td colspan="6" style="padding: 0; border: none;">${logsHtml}</td>`;
        tr.after(subTr);
    },

    // === Modal 內的產編標籤系統 ===
    renderModalInstTags: function() {
        const container = document.getElementById('Modal_Linked_Tags');
        if (!container) return;

        if (this.currentEditingInstTags.length === 0) {
            container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.9rem; padding: 20px; text-align: center; border: 1px dashed var(--border-color); border-radius: 8px;">目前無關聯的產編</div>';
            return;
        }

        container.innerHTML = this.currentEditingInstTags.map(pid => {
            const invItem = this.data.inventory.find(inv => inv.Property_ID === pid);
            const propName = invItem ? invItem.Name : '未知財產名稱';

            return `
            <div class="inv-tag">
                <span class="inv-tag-name">${propName}</span>
                <span class="inv-tag-id">${pid}</span>
                <i class="inv-tag-remove ph ph-x" onclick="app.removeModalInstTag('${pid}')"></i>
            </div>`;
        }).join('');
    },

    removeModalInstTag: function(pid) {
        const instId = document.getElementById('Instrument_ID').value;
        // 如果是「新增儀器」狀態 (尚未存入資料庫)，只需從記憶體中移除
        if (!instId || instId.startsWith('INST_')) {
            const existingInst = this.data.instruments.find(i => i.Instrument_ID === instId);
            if (!existingInst) {
                this.currentEditingInstTags = this.currentEditingInstTags.filter(id => id !== pid);
                this.renderModalInstTags();
                return;
            }
        }
        // 如果是編輯既有儀器，則呼叫強大的解綁引擎
        this.unlinkProperty(pid, instId);
    },

    // === 儀器狀態專用控制函式 ===
    setInstActive: function(isActive) {
        this.currentInstIsActive = isActive; // ★ Phase 2：改用狀態變數，移除字串布林轉換
        const btnTrue = document.getElementById('btn-inst-active-true');
        const btnFalse = document.getElementById('btn-inst-active-false');
        
        if (isActive) {
            if(btnTrue) { 
                btnTrue.classList.add('active-success'); 
                btnTrue.innerHTML = '<i class="ph-fill ph-check-circle"></i> 正常運作'; 
            }
            if(btnFalse) { 
                btnFalse.classList.remove('active-danger'); 
                btnFalse.innerHTML = '<i class="ph ph-x-circle"></i> 報廢停用'; 
            }
        } else {
            if(btnFalse) { 
                btnFalse.classList.add('active-danger'); 
                btnFalse.innerHTML = '<i class="ph-fill ph-x-circle"></i> 報廢停用'; 
            }
            if(btnTrue) { 
                btnTrue.classList.remove('active-success'); 
                btnTrue.innerHTML = '<i class="ph ph-check-circle"></i> 正常運作'; 
            }
        }
    },

    // === 更新 openInstModal (確保打開時按鈕顏色正確) ===
    openInstModal: function(id = null) {
        if (this.currentRole !== 'Admin') return;
        const modal = document.getElementById('inst-modal');
        const btnDel = document.getElementById('btn-del-i');
        const inputs = document.querySelectorAll('#inst-modal input, #inst-modal select');
        const inst = id ? this.data.instruments.find(x => x.Instrument_ID === id) : null;

        if (id && !inst) {
            this.showNotification('找不到該筆儀器資料，請重新整理頁面。', 'error');
            return;
        }
        
        this.fillMemberSelect('Manager_ID', inst?.Manager_ID || '');
        const locSelect = modal.querySelector('#Location');
        // ★ Phase 2：改用 constants.js 的 LOCATIONS 常數，不再動態從資料建構
        locSelect.innerHTML = '<option value="">請選擇區域</option>' + LOCATIONS.map(loc => `<option value="${loc}">${loc}</option>`).join('');

        inputs.forEach(el => el.value = '');
        
        if (id) {
            document.getElementById('i-modal-title').innerText = "編輯儀器";
            if (btnDel) btnDel.classList.remove('hidden');
            this.currentEditingInstTags = inst.Linked_Property_IDs ? [...inst.Linked_Property_IDs] : [];

            inputs.forEach(el => {
                if (el.id && inst[el.id] !== undefined) el.value = inst[el.id];
            });
            // ★ 強制寫入 ID
            document.getElementById('Instrument_ID').value = id;
            this.setInstActive(inst.Is_Active);
        } else {
            document.getElementById('i-modal-title').innerText = "新增儀器";
            if (btnDel) btnDel.classList.add('hidden');
            this.currentEditingInstTags = []; 
            document.getElementById('Instrument_ID').value = this.generateId('INST');
            this.setInstActive(true);
        }
        
        this.renderModalInstTags();
        modal.classList.remove('hidden');
    },

    saveInstrument: async function() {
        const id = document.getElementById('Instrument_ID').value;
        if (!id) { alert("請輸入儀器 ID"); return; }
        
        const payload = {};
        // ★ 修復核心：強制手動將 ID 寫入，避免被過濾器漏掉
        payload.Instrument_ID = id;

        // 抓取其他表單內容，略過 Property_ID、Instrument_ID 和 Is_Active（Is_Active 改用狀態變數）
        document.querySelectorAll('#inst-modal input, #inst-modal select').forEach(el => {
            if (el.id && el.id !== 'Property_ID' && el.id !== 'Instrument_ID' && el.id !== 'Is_Active') {
                payload[el.id] = el.value;
            }
        });
        // ★ Phase 2：直接使用狀態變數，寫入原生 Boolean（不再依賴 hidden input 字串）
        payload.Is_Active = this.currentInstIsActive;

        // 寫入我們編輯好的標籤陣列
        payload.Linked_Property_IDs = this.currentEditingInstTags;

        // 如果是從產編盤點按「下一步」帶過來的，一併加入陣列
        if (this.tempLinkedPropId && !payload.Linked_Property_IDs.includes(this.tempLinkedPropId)) {
            payload.Linked_Property_IDs.push(this.tempLinkedPropId);
        }

        const btn = document.getElementById('btn-save-i');
        btn.innerText = "儲存中...";
        btn.disabled = true;

        try {
            // ★ 修復：使用絕對存在的 id 變數作為文件路徑
            await setDoc(doc(db, "instruments", id), payload);
            
            this.closeModal('inst-modal');
            this.showNotification("儀器儲存成功", "success");
            if (typeof this.renderInstruments === 'function') this.renderInstruments();
            this.renderInventory();
        } catch (e) {
            this.showNotification("發生錯誤: " + e.message, 'error');
        } finally {
            btn.innerText = "儲存";
            btn.disabled = false;
            this.tempLinkedPropId = null;
            this.currentEditingInstTags = [];
        }
    }
};
