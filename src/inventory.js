/**
 * GOODLAB — 產編清點模組 (Inventory / Property Management)
 * Phase 4：從 script.js 抽出產編清點、Excel 匯入匯出、關聯作業等邏輯。
 * 所有方法透過 mixin 混入 app 物件，因此使用 this. 存取共享狀態。
 */
import { db, doc, setDoc, updateDoc, deleteDoc, writeBatch, arrayUnion } from './firebase.js';
import { LOCATIONS } from './constants.js';
import { UI } from '../shared.js';
import { generateId, escapeHtml } from './utils.js';

export const inventoryModule = {

    // ================= 產編篩選 =================

    setInvFilter: function(status) {
        this.invFilterStatus = status;
        document.querySelectorAll('.filter-chip[data-inv-val]').forEach(btn => {
            if (btn.dataset.invVal === status) btn.classList.add('active');
            else btn.classList.remove('active');
        });
        this.renderInventory();
    },

    // ================= Excel 兩階段匯入：階段一 (智慧預覽解析) =================

    previewExcel: function(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

                // ★ 智慧偵測標題列：掃描前 20 行，尋找「財物編號」在哪一行
                const rawArray = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
                let headerIndex = 0;
                for (let i = 0; i < Math.min(rawArray.length, 20); i++) {
                    if (rawArray[i] && rawArray[i].includes('財物編號')) {
                        headerIndex = i;
                        break;
                    }
                }

                // 使用找到的正確標題列 (headerIndex) 開始解析為 JSON
                const rows = XLSX.utils.sheet_to_json(firstSheet, { range: headerIndex, defval: "" });

                const existingMap = new Map();
                this.data.inventory.forEach(item => existingMap.set(item.Property_ID, item));

                this.tempImportPayloads = []; 
                const tbody = document.getElementById('import-preview-tbody');
                tbody.innerHTML = ''; 

                rows.forEach(row => {
                    // 如果這行沒有財物編號或校號，直接跳過
                    if (!row['財物編號'] || !row['校號']) return;

                    const propId = `${String(row['財物編號']).trim()}-${String(row['校號']).trim()}-${row['附件'] ? String(row['附件']).trim() : '00'}`;
                    const existingItem = existingMap.get(propId);

                    const payload = {
                        Property_ID: propId,
                        Name: row['財物名稱'] ? String(row['財物名稱']).trim() : '',
                        Brand: row['廠牌'] ? String(row['廠牌']).trim() : '',
                        Model: (row['型式'] || row['形式']) ? String(row['型式'] || row['形式']).trim() : '',
                        Price: row['單價'] ? Number(String(row['單價']).replace(/,/g, '')) : 0,
                        Acquire_Date: row['取得日期'] ? String(row['取得日期']).trim() : '',
                        Lifespan: row['年限'] ? String(row['年限']).trim() : '',
                        Add_No: row['增加單號'] ? String(row['增加單號']).trim() : '',
                        Manager: row['管理人'] ? String(row['管理人']).trim() : '',
                        Original_Location: row['存置地點'] ? String(row['存置地點']).trim() : '',
                        Category: row['分類'] ? String(row['分類']).trim() : '',
                        Scrap_Status: row['報銷狀態'] ? String(row['報銷狀態']).trim() : '',
                        System_Remark: row['保管組備註'] ? String(row['保管組備註']).trim() : '',
                        
                        // 處理盤點狀態與自訂區域
                        Status: (row['已盤得\n請打v'] && String(row['已盤得\n請打v']).toLowerCase() === 'v') ? 'Checked' : 'Pending',
                        Location: row['實驗區域'] ? String(row['實驗區域']).trim() : '', 
                        Personal_Remark: row['細項位置'] ? String(row['細項位置']).trim() : '' 
                    };

                    // 若系統內已有紀錄，比對是否為新增或更新
                    let actionText = '全新建立';
                    let actionColor = 'var(--success)';

                    if (existingItem) {
                        actionText = '同步更新';
                        actionColor = 'var(--primary)';
                    } 

                    this.tempImportPayloads.push(payload);

                    // 畫出預覽列
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td style="padding: 6px 8px; border-bottom: 1px solid var(--border-color); font-family: monospace;">${payload.Property_ID}</td>
                        <td style="padding: 6px 8px; border-bottom: 1px solid var(--border-color);">${payload.Name}</td>
                        <td style="padding: 6px 8px; border-bottom: 1px solid var(--border-color); font-size: 0.85rem;">${payload.Location || payload.Original_Location || '-'}</td>
                        <td style="padding: 6px 8px; border-bottom: 1px solid var(--border-color); font-weight: bold; color: ${actionColor}; font-size: 0.85rem;">${actionText}</td>
                    `;
                    tbody.appendChild(tr);
                });

                document.getElementById('preview-count').innerText = this.tempImportPayloads.length;
                UI.openModal({ modalId: 'import-preview-modal', title: '全量同步預覽 (將刪除不在清單內的項目)' });

            } catch (error) {
                console.error("Excel 解析失敗:", error);
                this.showNotification("檔案解析失敗，請確認是否為符合格式的 Excel 檔。", 'error');
            } finally {
                event.target.value = ''; // 清空 input 檔案，讓下次選同一個檔案也能觸發
            }
        };
        reader.readAsArrayBuffer(file);
    },

    // ================= Excel 兩階段匯入：階段二 (全量同步寫入) =================

    confirmImport: async function() {
        if (!this.tempImportPayloads || this.tempImportPayloads.length === 0) return;

        const btn = document.getElementById('btn-confirm-import');
        btn.innerText = "執行全量同步中...";
        btn.disabled = true;

        try {
            // ★ Phase 3：備份機制 — 匯入前先將現有資料複製到 inventory_archive
            const archiveId = 'ARCHIVE_' + new Date().toISOString().replace(/[:.]/g, '-');
            const archiveBatches = [];
            let archiveBatch = writeBatch(db);
            let archiveCount = 0;
            this.data.inventory.forEach(item => {
                if (item.Property_ID === '_SETTINGS_') return;
                archiveBatch.set(doc(db, 'inventory_archive', archiveId + '_' + item.Property_ID), {
                    ...item,
                    _Archive_ID: archiveId,
                    _Archived_At: new Date().toISOString()
                });
                archiveCount++;
                if (archiveCount % 400 === 0) {
                    archiveBatches.push(archiveBatch.commit());
                    archiveBatch = writeBatch(db);
                }
            });
            if (archiveCount % 400 !== 0) archiveBatches.push(archiveBatch.commit());
            await Promise.all(archiveBatches);
            console.log(`[Phase 3] 已備份 ${archiveCount} 筆產編至 inventory_archive (${archiveId})`);

            const batchArray = [];
            let currentBatch = writeBatch(db);
            let count = 0;

            // 1. 找出要刪除的項目：資料庫有但 Excel 沒出現的
            const importedIDs = new Set(this.tempImportPayloads.map(p => p.Property_ID));
            const itemsToDelete = this.data.inventory.filter(item => 
                item.Property_ID !== '_SETTINGS_' && !importedIDs.has(item.Property_ID)
            );

            // 執行刪除
            itemsToDelete.forEach(item => {
                currentBatch.delete(doc(db, "inventory", item.Property_ID));
                count++;
                if (count % 400 === 0) {
                    batchArray.push(currentBatch.commit());
                    currentBatch = writeBatch(db);
                }
            });

            // 2. 執行新增與更新
            this.tempImportPayloads.forEach(payload => {
                currentBatch.set(doc(db, "inventory", payload.Property_ID), payload, { merge: true });
                count++;
                if (count % 400 === 0) {
                    batchArray.push(currentBatch.commit());
                    currentBatch = writeBatch(db);
                }
            });

            if (count % 400 !== 0) batchArray.push(currentBatch.commit());
            await Promise.all(batchArray);

            this.showNotification(`同步成功：更新/新增 ${this.tempImportPayloads.length} 筆，刪除 ${itemsToDelete.length} 筆。`, 'success');
            app.closeModal('import-preview-modal');
            this.tempImportPayloads = [];
        } catch (e) {
            this.showNotification("同步失敗: " + e.message, 'error');
        } finally {
            btn.innerText = "確認並寫入系統";
            btn.disabled = false;
        }
    },

    // ================= 產編排序 =================

    sortInventory: function(key) {
        if (this.invSortState.key === key) {
            this.invSortState.direction = this.invSortState.direction === 'asc' ? 'desc' : 'asc';
        } else {
            this.invSortState.key = key;
            this.invSortState.direction = 'asc';
        }
        
        const dir = this.invSortState.direction === 'asc' ? 1 : -1;
        this.data.inventory.sort((a, b) => {
            let valA = a[key] || '';
            let valB = b[key] || '';
            // 針對 Status 與 Location 的字串比對
            return valA.localeCompare(valB, 'zh-Hant') * dir;
        });
        
        this.renderInventory();
    },

    // ================= 權限檢查 =================

    checkInvEditPermission: function() {
        if (this.currentRole === 'Admin') return true; // Admin 永遠可以編輯
        if (this.currentRole !== 'User') return false; // Guest 絕對不行

        // 去資料庫找我們的全域設定檔 (如果找不到，預設為關閉)
        const settingsDoc = this.data.inventory.find(i => i.Property_ID === '_SETTINGS_');
        return settingsDoc ? settingsDoc.IsOpen : false;
    },

    // ================= 產編年度盤點：總開關引擎 =================

    toggleInventoryMode: async function(targetMode) {
        if (this.currentRole !== 'Admin') return;

        const isOpen = targetMode === 'open';
        let shouldReset = false;

        if (isOpen) {
            shouldReset = confirm("【開放盤點】\n是否要清空先前的盤點紀錄，重新開始新的一輪？\n\n- 按 [確定]：全部重置為未盤點(紅燈)\n- 按 [取消]：保留現有紅綠燈，僅『重新開放』編輯權限");
        } else {
            if (!confirm("確定要關閉盤點嗎？\nUser 的所有編輯權限將被關閉，僅能檢視現有進度。")) return;
        }

        const btnOpen = document.getElementById('btn-inv-open');
        const btnClosed = document.getElementById('btn-inv-closed');
        if (isOpen) { btnOpen.innerText = "開放中..."; btnOpen.disabled = true; } 
        else { btnClosed.innerText = "關閉中..."; btnClosed.disabled = true; }

        try {
            // 1. 將開關狀態寫入隱藏的全域設定檔，所有人的網頁都會即時同步！
            await setDoc(doc(db, "inventory", "_SETTINGS_"), { 
                Property_ID: '_SETTINGS_', 
                IsOpen: isOpen 
            }, { merge: true });

            // 2. 如果 Admin 選擇重置，把大家變回紅燈
            if (isOpen && shouldReset) {
                const batchArray = [];
                let currentBatch = writeBatch(db);
                let count = 0;

                this.data.inventory.forEach(item => {
                    if (item.Property_ID === '_SETTINGS_') return; // 跳過設定檔
                    
                    const docRef = doc(db, "inventory", item.Property_ID);
                    currentBatch.update(docRef, { Status: 'Pending', Checked_By: null });
                    
                    count++;
                    if (count % 400 === 0) {
                        batchArray.push(currentBatch.commit());
                        currentBatch = writeBatch(db);
                    }
                });
                if (count % 400 !== 0) batchArray.push(currentBatch.commit());
                await Promise.all(batchArray);
            }
            
            this.showNotification(isOpen ? "盤點已開放，User 已獲得編輯權限。" : "盤點已關閉，User 編輯權限已鎖定。", "success");
        } catch (e) {
            this.showNotification("操作失敗: " + e.message, "error");
        } finally {
            if (btnOpen) { btnOpen.innerHTML = '<i class="ph ph-lock-open"></i> 開放'; btnOpen.disabled = false; }
            if (btnClosed) { btnClosed.innerHTML = '<i class="ph ph-lock-key"></i> 關閉'; btnClosed.disabled = false; }
        }
    },

    // ================= 產編主畫面渲染 =================

    renderInventory: function() {
        const tbody = document.getElementById('inv-tbody');
        if (!tbody) return;

        if (this.currentRole === 'Guest') {
            tbody.innerHTML = this.guestGuardHtml;
            return;
        }
        
        const isAdmin = this.currentRole === 'Admin';
        
        // ★ 核心：取得目前的「檔期權限」，決定畫面上要不要顯示鉛筆跟手指
        const canEdit = this.checkInvEditPermission(); 
        
        // 抓取目前的設定狀態，給頂部的切換器使用
        const settingsDoc = this.data.inventory.find(i => i.Property_ID === '_SETTINGS_');
        const isInventoryOpen = settingsDoc ? settingsDoc.IsOpen : false;

        const toggleContainer = document.getElementById('inv-mode-toggle');
        if (toggleContainer) {
            toggleContainer.style.display = isAdmin ? 'flex' : 'none'; 
            if (isAdmin) {
                const btnOpen = document.getElementById('btn-inv-open');
                const btnClosed = document.getElementById('btn-inv-closed');
                if (btnOpen && btnClosed) {
                    if (isInventoryOpen) {
                        btnOpen.classList.add('active-success');
                        btnClosed.classList.remove('active-danger');
                    } else {
                        btnClosed.classList.add('active-danger');
                        btnOpen.classList.remove('active-success');
                    }
                }
            }
        }

        const term = document.getElementById('search-inv').value.toLowerCase();
        const statusFilter = this.invFilterStatus || 'All';
        const locFilter = document.getElementById('filter-inv-location') ? document.getElementById('filter-inv-location').value : '';
        const standardLocs = ["多腔體區", "機房", "製程區", "黃光室", "量測區", "辦公區", "頂樓"];

        let filtered = this.data.inventory.filter(item => {
            if (item.Property_ID === '_SETTINGS_') return false; // 隱藏全域設定檔

            const text = (String(item.Property_ID || '') + String(item.Name || '') + String(item.Location || '') + String(item.Personal_Remark || '')).toLowerCase();
            const matchText = text.includes(term);
            const matchStatus = statusFilter === 'All' ? true : item.Status === statusFilter;
            let matchLoc = true;
            if (locFilter === '其他') matchLoc = item.Location && !standardLocs.includes(item.Location);
            else if (locFilter) matchLoc = item.Location === locFilter;
            
            return matchText && matchStatus && matchLoc;
        });

        const sortKey = this.invSortState.key;
        const dir = this.invSortState.direction === 'asc' ? 1 : -1;
        filtered.sort((a, b) => {
            let valA = a[sortKey] || ''; let valB = b[sortKey] || '';
            if (sortKey === 'Status') { valA = a.Status === 'Checked' ? 1 : 0; valB = b.Status === 'Checked' ? 1 : 0; }
            return valA > valB ? dir : (valA < valB ? -dir : 0);
        });

        UI.renderTable({
            containerId: 'inv-tbody',
            data: filtered,
            columns: [
                { 
                    width: '80px', align: 'center', 
                    render: row => {
                        const isChecked = row.Status === 'Checked';
                        const color = isChecked ? 'var(--success)' : 'var(--danger)';
                        const titleText = isChecked ? '已盤點' : '未盤點';
                        
                        let checkerName = '';
                        if (isChecked && row.Checked_By) {
                            const checker = row.Checked_By_Student_ID
                                ? this.data.members.find(member => member.Student_ID === row.Checked_By_Student_ID)
                                : this.data.members.find(member => member.Google_UID === row.Checked_By);
                            checkerName = checker?.Name_Ch || '已盤點';
                        }
                        
                        return `<div style="text-align:center; ${canEdit ? 'cursor: pointer;' : 'cursor: default; opacity: 0.8;'}" 
                                     onclick="${canEdit ? `event.stopPropagation(); app.toggleInvStatus('${row.Property_ID}', '${row.Status}')` : 'event.stopPropagation();'}"
                                     title="${canEdit ? '點擊切換 (' + titleText + ')' : titleText + ' (已鎖定)'}">
                                    <div style="line-height: 1;"><i class="ph-fill ph-circle" style="color: ${color}; font-size: 1.3rem;"></i></div>
                                    ${checkerName ? `<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">${checkerName}</div>` : ''}
                                </div>`;
                    }
                },
                { width: '150px', className: 'inventory-desktop-only', render: row => `<strong style="font-family: monospace;">${escapeHtml(row.Property_ID)}</strong>` },
                { 
                    render: row => {
                        const linkedInst = this.data.instruments.find(inst => inst.Linked_Property_IDs && inst.Linked_Property_IDs.includes(row.Property_ID));
                        let html = `<div class="inventory-item-name">${escapeHtml(row.Name || '未命名')}</div>`;
                        html += `<div class="inventory-mobile-meta"><span><i class="ph ph-tag" aria-hidden="true"></i>${escapeHtml(row.Property_ID)}</span><span><i class="ph ph-map-pin" aria-hidden="true"></i>${escapeHtml(row.Location || '未填區域')}</span></div>`;
                        if (row.Brand || row.Model) html += `<div class="inventory-item-model">${escapeHtml(row.Brand || '')} ${escapeHtml(row.Model || '')}</div>`;
                        if (linkedInst) html += `<div style="margin-top: 4px;"><span class="inventory-link-badge"><i class="ph ph-link" aria-hidden="true"></i> 已綁定至：${escapeHtml(linkedInst.Name)}</span></div>`;
                        if (canEdit) html += `<div class="inventory-mobile-actions"><button type="button" class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); app.openInvLocationModal('${row.Property_ID}')"><i class="ph ph-map-pin" aria-hidden="true"></i>區域</button><button type="button" class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); app.openInvRemarkModal('${row.Property_ID}')"><i class="ph ph-note-pencil" aria-hidden="true"></i>細項位置</button></div>`;
                        return html;
                    }
                },
                { 
                    width: '120px', 
                    className: 'inventory-desktop-only',
                    render: row => {
                        return `<div style="${canEdit ? 'cursor:pointer;' : 'cursor:default; opacity:0.6;'} display:flex; justify-content:space-between; align-items:center;" 
                                     onclick="${canEdit ? `event.stopPropagation(); app.openInvLocationModal('${row.Property_ID}')` : 'event.stopPropagation();'}" 
                                     title="${canEdit ? '點擊編輯區域' : '已鎖定'}">
                                    <span>${escapeHtml(row.Location || '-')}</span>
                                    ${canEdit ? '<i class="ph ph-pencil-simple" style="color: var(--primary); opacity: 0.3;"></i>' : ''}
                                </div>`;
                    }
                },
                { 
                    width: '200px', 
                    className: 'inventory-desktop-only',
                    render: row => {
                        const text = row.Personal_Remark
                            ? escapeHtml(row.Personal_Remark)
                            : `<span style="color:#aaa; font-style:italic;">${canEdit ? '點擊編輯...' : '-'}</span>`;
                        return `<div style="${canEdit ? 'cursor:pointer;' : 'cursor:default; opacity:0.6;'} display:flex; justify-content:space-between; align-items:center;" 
                                    onclick="${canEdit ? `event.stopPropagation(); app.openInvRemarkModal('${row.Property_ID}')` : 'event.stopPropagation();'}" 
                                    title="${canEdit ? '點擊編輯細項位置' : '已鎖定'}">
                                    <span>${text}</span>
                                    ${canEdit ? '<i class="ph ph-pencil-simple" style="color: var(--primary); opacity: 0.6;"></i>' : ''}
                                </div>`;
                    }
                },
                { 
                    width: '110px', align: 'center', 
                    render: row => {
                        const linkedInst = this.data.instruments.find(inst => inst.Linked_Property_IDs && inst.Linked_Property_IDs.includes(row.Property_ID));
                        const infoBtn = `<button type="button" aria-label="查看${escapeHtml(row.Name || row.Property_ID)}詳細資料" onclick="event.stopPropagation(); app.openInvDetailsModal('${row.Property_ID}')" class="btn btn-sm btn-secondary" title="查看詳細資料" style="padding: 4px 8px;"><i class="ph ph-info" aria-hidden="true"></i></button>`;
                        const linkBtn = !isAdmin ? '' : linkedInst
                            ? `<button type="button" onclick="event.stopPropagation(); app.unlinkProperty('${row.Property_ID}', '${linkedInst.Instrument_ID}')" class="btn btn-sm btn-danger" title="解除綁定" style="padding: 4px 8px;"><i class="ph ph-link-break" aria-hidden="true"></i></button>`
                            : `<button type="button" onclick="event.stopPropagation(); app.openLinkModal('${row.Property_ID}')" class="btn btn-sm btn-primary" title="新增關聯" style="padding: 4px 8px;"><i class="ph ph-link" aria-hidden="true"></i></button>`;

                        return `<div style="display: flex; justify-content: center; gap: 6px;">${infoBtn}${linkBtn}</div>`;
                    }
                }
            ],
            emptyMessage: "目前沒有盤點資料！",
            onRowClick: (rowData) => { if (canEdit) app.toggleInvStatus(rowData.Property_ID, rowData.Status); }
        });
    }, 

    // ================= 狀態切換 (紅/綠燈自由反悔版) =================

    toggleInvStatus: async function(propId, currentStatus) {
        if (!this.checkInvEditPermission()) {
            this.showNotification("盤點已關閉，無法更改狀態", "warning");
            return;
        }
        const newStatus = currentStatus === 'Checked' ? 'Pending' : 'Checked';
        const checkedBy = newStatus === 'Checked' ? this.currentUser.uid : null;
        const checkedByStudentId = newStatus === 'Checked' ? (this.currentMember?.Student_ID || '') : null;
        try {
            await updateDoc(doc(db, "inventory", propId), {
                Status: newStatus,
                Checked_By: checkedBy,
                Checked_By_Student_ID: checkedByStudentId,
                Updated_By_UID: this.currentUser?.uid || '',
                Updated_By_Student_ID: this.currentMember?.Student_ID || '',
                Updated_At: new Date().toISOString()
            });
        } catch (e) { this.showNotification("狀態更新失敗: " + e.message, 'error'); }
    },

    // ================= 區域編輯 =================

    openInvLocationModal: function(propId) {
        if (!this.checkInvEditPermission()) return;
        const item = this.data.inventory.find(i => i.Property_ID === propId);
        if (!item) return;
        document.getElementById('Loc_Prop_ID').value = propId;
        document.getElementById('Loc_Select_Value').value = item.Location || '其他';
        UI.openModal({ modalId: 'inv-loc-modal', title: '編輯實驗區域' });
    },

    saveInvLocation: async function() {
        if (!this.checkInvEditPermission()) return;
        const propId = document.getElementById('Loc_Prop_ID').value;
        const newLoc = document.getElementById('Loc_Select_Value').value;
        try {
            await updateDoc(doc(db, "inventory", propId), {
                Location: newLoc,
                Updated_By_UID: this.currentUser?.uid || '',
                Updated_By_Student_ID: this.currentMember?.Student_ID || '',
                Updated_At: new Date().toISOString()
            });
            app.closeModal('inv-loc-modal');
            this.showNotification("區域已更新", 'success');
            this.renderInventory(); 
        } catch (e) {
            this.showNotification("更新失敗: " + e.message, 'error');
        }
    },

    // ================= 備註編輯 =================

    openInvRemarkModal: function(propId) {
        if (!this.checkInvEditPermission()) return;
        const item = this.data.inventory.find(i => i.Property_ID === propId);
        if (!item) return;
        document.getElementById('Remark_Prop_ID').value = propId;
        document.getElementById('Remark_Text').value = item.Personal_Remark || '';
        UI.openModal({ modalId: 'remark-modal', title: '編輯細項位置' });
    },

    saveInvRemark: async function() {
        if (!this.checkInvEditPermission()) return;
        const propId = document.getElementById('Remark_Prop_ID').value;
        const text = document.getElementById('Remark_Text').value.trim();
        if (text.length > 500) {
            this.showNotification('細項位置請控制在 500 字以內', 'warning');
            return;
        }
        try {
            await updateDoc(doc(db, "inventory", propId), {
                Personal_Remark: text,
                Updated_By_UID: this.currentUser?.uid || '',
                Updated_By_Student_ID: this.currentMember?.Student_ID || '',
                Updated_At: new Date().toISOString()
            });
            app.closeModal('remark-modal');
            this.showNotification("備註已更新", 'success');
            this.renderInventory(); 
        } catch (e) {
            this.showNotification("更新失敗: " + e.message, 'error');
        }
    },

    // ================= 產編詳細資訊 Modal (唯讀，大家都能點) =================

    openInvDetailsModal: function(propId) {
        const item = this.data.inventory.find(i => i.Property_ID === propId);
        if (!item) return;

        const formatMoney = (num) => num ? new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', maximumFractionDigits: 0 }).format(num) : '無紀錄';
        const tbody = document.getElementById('inv-details-tbody');
        const labelStyle = "padding: 10px 8px; color: var(--text-muted); width: 100px; white-space: nowrap; vertical-align: top;";
        const valueStyle = "padding: 10px 8px; word-break: break-word; vertical-align: top;";

        tbody.innerHTML = `
            <tr style="border-bottom: 1px solid var(--border-color);"><td style="${labelStyle}">財產編號</td><td style="${valueStyle} font-family: monospace; font-weight: bold;">${escapeHtml(item.Property_ID)}</td></tr>
            <tr style="border-bottom: 1px solid var(--border-color);"><td style="${labelStyle}">財物名稱</td><td style="${valueStyle} font-weight: bold;">${escapeHtml(item.Name || '-')}</td></tr>
            <tr style="border-bottom: 1px solid var(--border-color);"><td style="${labelStyle}">廠牌 / 型式</td><td style="${valueStyle}">${escapeHtml(item.Brand || '-')} / ${escapeHtml(item.Model || '-')}</td></tr>
            <tr style="border-bottom: 1px solid var(--border-color);"><td style="${labelStyle}">取得單價</td><td style="${valueStyle} color: var(--danger); font-weight: bold;">${formatMoney(item.Price)}</td></tr>
            <tr style="border-bottom: 1px solid var(--border-color);"><td style="${labelStyle}">取得日期</td><td style="${valueStyle}">${escapeHtml(item.Acquire_Date || '-')}</td></tr>
            <tr style="border-bottom: 1px solid var(--border-color);"><td style="${labelStyle}">使用年限</td><td style="${valueStyle}">${escapeHtml(item.Lifespan ? item.Lifespan + ' 年' : '-')}</td></tr>
            <tr style="border-bottom: 1px solid var(--border-color);"><td style="${labelStyle}">實驗區域</td><td style="${valueStyle} color: var(--primary); font-weight: 600;">${escapeHtml(item.Location || '-')}</td></tr>
            <tr><td style="${labelStyle}">細項備註</td><td style="${valueStyle}">${escapeHtml(item.Personal_Remark || '-')}</td></tr>
        `;
        UI.openModal({ modalId: 'inv-details-modal', title: '財產詳細資訊' });
    },

    // ================= Excel 匯出 =================

    exportInventoryExcel: function() {
        if (this.data.inventory.length === 0) return;

        const exportData = this.data.inventory
            .filter(i => i.Property_ID !== '_SETTINGS_')
            .map(item => {
                const parts = (item.Property_ID || '').split('-');
                return {
                    '財物編號': parts[0] || '',
                    '校號': parts[1] || '',
                    '附件': parts[2] || '',
                    '財物名稱': item.Name || '',
                    '廠牌': item.Brand || '',
                    '型式': item.Model || '',
                    '單價': item.Price || '',
                    '增加單號': item.Add_No || '',
                    '取得日期': item.Acquire_Date || '',
                    '年限': item.Lifespan || '',
                    '管理人': item.Manager || '',
                    '存置地點': item.Original_Location || '',
                    '分類': item.Category || '',
                    '報銷狀態': item.Scrap_Status || '',
                    '保管組備註': item.System_Remark || '',
                    '個人備註': '', // 依要求留空或填入舊備註
                    '已盤得\n請打v': item.Status === 'Checked' ? 'v' : '',
                    '實驗區域': item.Location || '',      // 對齊 Location
                    '細項位置': item.Personal_Remark || '' // 對齊 Personal_Remark
                };
            });

        const worksheet = XLSX.utils.json_to_sheet(exportData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "盤點清冊");
        XLSX.writeFile(workbook, `實驗室全量同步清冊_${new Date().toISOString().split('T')[0]}.xlsx`);
    },

    // ================= 產編關聯作業 (綁定新舊儀器) =================

    openLinkModal: function(propId) {
        if (!this.checkInvEditPermission()) return;
        const item = this.data.inventory.find(i => i.Property_ID === propId);
        if (!item) return;

        document.getElementById('Link_Prop_ID').value = propId;
        document.getElementById('Link_Prop_Name').innerText = item.Name;
        document.getElementById('Link_Prop_Code').innerText = propId;
        document.getElementById('Link_New_Name').value = item.Name; 
        document.getElementById('Link_Location').value = ''; 
        this.selectLinkMode('existing');
        UI.openModal({ modalId: 'link-modal', title: '產編關聯作業' });
    },

    selectLinkMode: function(mode) {
        document.getElementById('Link_Mode_Selected').value = mode;
        const btnExisting = document.getElementById('mode-btn-existing');
        const btnNew = document.getElementById('mode-btn-new');
        if (btnExisting) btnExisting.classList.toggle('active', mode === 'existing');
        if (btnNew) btnNew.classList.toggle('active', mode === 'new');

        if (mode === 'existing') {
            document.getElementById('link-existing-section').classList.remove('hidden');
            document.getElementById('link-new-section').classList.add('hidden');
            document.getElementById('btn-link-existing').classList.remove('hidden');
            document.getElementById('btn-link-new').classList.add('hidden');
            this.onLinkLocationChange();
        } else {
            document.getElementById('link-existing-section').classList.add('hidden');
            document.getElementById('link-new-section').classList.remove('hidden');
            document.getElementById('btn-link-existing').classList.add('hidden');
            document.getElementById('btn-link-new').classList.remove('hidden');
        }
    },

    onLinkLocationChange: function() {
        if (document.getElementById('Link_Mode_Selected').value !== 'existing') return;
        const loc = document.getElementById('Link_Location').value;
        const select = document.getElementById('Link_Select_Inst');
        
        if (!loc) {
            select.innerHTML = '<option value="">請先選擇上方區域...</option>';
            return;
        }
        const availableInsts = this.data.instruments.filter(i => i.Is_Active && i.Location === loc);
        if (availableInsts.length === 0) {
            select.innerHTML = '<option value="">此區域目前沒有任何儀器！</option>';
        } else {
            select.innerHTML = '<option value="">請選擇儀器...</option>' + availableInsts.map(inst => `<option value="${inst.Instrument_ID}">${inst.Name}</option>`).join('');
        }
    },

    submitLinkInst: async function() {
        if (!this.checkInvEditPermission()) {
            this.showNotification("盤點已關閉，無法操作", "warning");
            return;
        }
        const propId = document.getElementById('Link_Prop_ID').value;
        const mode = document.getElementById('Link_Mode_Selected').value;
        const loc = document.getElementById('Link_Location').value;
        
        if (!loc) { this.showNotification("請先選擇實驗室區域！", "warning"); return; }

        if (mode === 'existing') {
            const instId = document.getElementById('Link_Select_Inst').value;
            if (!instId) { this.showNotification("請選擇要連結的儀器！", "warning"); return; }
            try {
                await updateDoc(doc(db, "instruments", instId), { Linked_Property_IDs: arrayUnion(propId) });
                await updateDoc(doc(db, "inventory", propId), { Location: loc });
                this.showNotification("成功關聯！", 'success');
                app.closeModal('link-modal');
                this.renderInventory(); 
            } catch (e) { this.showNotification("錯誤: " + e.message, 'error'); }
        } else {
            const newName = document.getElementById('Link_New_Name').value.trim();
            if (!newName) { this.showNotification("請輸入名稱！", "warning"); return; }
            this.tempLinkedPropId = propId; 
            app.closeModal('link-modal');
            this.openInstModal(); 
            
            setTimeout(() => {
                const nameInput = document.getElementById('Name') || document.getElementById('Inst_Name'); 
                const locInput = document.getElementById('Location') || document.getElementById('Inst_Location'); 
                const idInput = document.getElementById('Instrument_ID') || document.getElementById('Inst_ID');
                if (nameInput) nameInput.value = newName;
                if (locInput) locInput.value = loc;
                if (idInput) idInput.value = this.generateId('INST');
                this.showNotification("已自動帶入產編、名稱與區域！", "info");
            }, 150);
        }
    },

    // ================= 解除關聯 =================

    unlinkProperty: async function(propId, instId) {
        if (!this.checkInvEditPermission()) {
            this.showNotification("盤點已關閉，無法編輯", "warning");
            return;
        }
        if (!confirm(`確定要解除產編 [${propId}] 的綁定嗎？\n解除後，該產編將回到「未分配」狀態。`)) return;

        try {
            const inst = this.data.instruments.find(i => i.Instrument_ID === instId);
            if (inst) {
                const updatedTags = (inst.Linked_Property_IDs || []).filter(id => id !== propId);
                await updateDoc(doc(db, "instruments", instId), { Linked_Property_IDs: updatedTags });
            }
            await updateDoc(doc(db, "inventory", propId), { Location: "" });
            this.showNotification("已成功解除綁定", 'success');
            if (this.currentEditingInstTags && this.currentEditingInstTags.includes(propId)) {
                this.currentEditingInstTags = this.currentEditingInstTags.filter(id => id !== propId);
                this.renderModalInstTags();
            }
            this.renderInventory();
        } catch (e) { this.showNotification("解除綁定失敗: " + e.message, 'error'); }
    }
};
