/**
 * GOODLAB — 公積金管理模組 (Accounting)
 * Phase 4：從 script.js 抽出所有公積金報帳相關邏輯。
 */
import { db, doc, setDoc } from './firebase.js';
import { generateId, formatDateForInput, getMemberName } from './utils.js';
import { showNotification, closeModal, fillPayerSelect } from './ui.js';

function cleanAccountingDescription(value) {
    return String(value || '').replace(/^(?:🏧|💰)\s*/u, '');
}

export const accountingModule = {

    getAccountingSummary: function() {
        let bankBalance = 0;
        let cashBalance = 0;
        let payable = 0;
        let receivable = 0;

        this.data.accounting.forEach(acc => {
            const amt = Math.abs(parseFloat(acc.Amount) || 0);
            const type = acc.Type;
            const source = acc.Fund_Source || 'Bank';
            const isFund = acc.Payer === 'Fund';
            const isRecharged = Boolean(acc.Recharge_Date);
            const isPaidBack = Boolean(acc.Payback_Date);

            if (!isFund && !isPaidBack && (type === 'School' || type === 'Lab')) payable += amt;
            if (type === 'School' && !isRecharged) receivable += amt;

            if (type === 'Income' || type === 'Deposit') {
                if (source === 'Cash') cashBalance += amt;
                else bankBalance += amt;
            } else if (type === 'Withdraw' || type === 'Withdrawal') {
                bankBalance -= amt;
                cashBalance += amt;
            } else if (type === 'School' || type === 'Lab') {
                if (isFund || (!isFund && isPaidBack)) {
                    if (source === 'Cash') cashBalance -= amt;
                    else bankBalance -= amt;
                }
                if (type === 'School' && isRecharged) bankBalance += amt;
            }
        });

        return {
            bankBalance,
            cashBalance,
            totalBalance: bankBalance + cashBalance,
            payable,
            receivable
        };
    },

    getDebtSummary: function() {
        const debts = new Map();
        this.data.accounting.forEach(acc => {
            const isDebt = acc.Payer !== 'Fund'
                && !acc.Payback_Date
                && (acc.Type === 'School' || acc.Type === 'Lab');
            if (!isDebt) return;
            const name = getMemberName(this.data.members, acc.Payer);
            debts.set(name, (debts.get(name) || 0) + Math.abs(parseFloat(acc.Amount) || 0));
        });
        return [...debts.entries()]
            .map(([name, amount]) => ({ name, amount }))
            .sort((a, b) => b.amount - a.amount);
    },

    // === 篩選控制 ===
    setAccFilter: function(status) {
        this.accFilterStatus = status;
        this.updateAccFilterUI();
        this.renderAccounting();
    },

    updateAccFilterUI: function() {
        document.querySelectorAll('.filter-chip[data-acc-val]').forEach(btn => {
            if (btn.dataset.accVal === this.accFilterStatus) btn.classList.add('active');
            else btn.classList.remove('active');
        });
    },

    // === 計算儀表板數字 (相容舊資料版) ===
    calcDashboard: function() {
        const summary = this.getAccountingSummary();
        const setCurrency = (id, value) => {
            const element = document.getElementById(id);
            if (element) element.innerText = "$" + value.toLocaleString('zh-TW');
        };
        setCurrency('val-balance', summary.totalBalance);
        setCurrency('val-bank', summary.bankBalance);
        setCurrency('val-cash', summary.cashBalance);
        setCurrency('val-payable', summary.payable);
        setCurrency('val-receivable', summary.receivable);
    },

    // 顯示欠款明細（持久對話框）
    showDebtsDetail: function() {
        const rows = this.getDebtSummary();
        const tbody = document.getElementById('debt-detail-tbody');
        const total = document.getElementById('debt-detail-total');
        const modal = document.getElementById('debt-detail-modal');
        if (!tbody || !total || !modal) return;

        const escapeText = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        })[character]);
        tbody.innerHTML = rows.length
            ? rows.map(item => `<tr><td>${escapeText(item.name)}</td><td class="debt-amount">$${item.amount.toLocaleString('zh-TW')}</td></tr>`).join('')
            : '<tr><td colspan="2" class="empty">目前沒有待還款紀錄</td></tr>';
        total.textContent = `$${rows.reduce((sum, item) => sum + item.amount, 0).toLocaleString('zh-TW')}`;
        modal.classList.remove('hidden');
    },

    showDebtTransactions: function() {
        this.closeModal('debt-detail-modal');
        this.setAccFilter('Debt');
        const table = document.getElementById('acc-tbody');
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (table) table.closest('.table-container')?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    },

    renderAccounting: function() {
        const tbody = document.getElementById('acc-tbody');
        const dashboard = document.querySelector('.dashboard-cards');
        if(!tbody) return;

        // ★ 防火牆：非 Admin 進入時，蓋上鎖頭並隱藏上方的金錢儀表板
        if (this.currentRole !== 'Admin') {
            tbody.innerHTML = this.guestGuardHtml;
            if (dashboard) dashboard.style.display = 'none'; 
            return;
        }

        // Admin 進入時，顯示儀表板
        if (dashboard) dashboard.style.display = 'grid'; 

        const searchEl = document.getElementById('search-acc');
        const term = searchEl ? searchEl.value.toLowerCase() : ''; 
        const filter = this.accFilterStatus;

        let filtered = this.data.accounting.filter(acc => {
            const payerName = getMemberName(this.data.members, acc.Payer);
            const text = (acc.Description + payerName + acc.Type).toLowerCase();
            if (!text.includes(term)) return false;
            const isDebt = (acc.Payer !== 'Fund' && !acc.Payback_Date && (acc.Type === 'School' || acc.Type === 'Lab'));
            const isWait = (acc.Type === 'School' && !acc.Recharge_Date);
            if (filter === 'Debt') return isDebt;
            if (filter === 'Wait') return isWait;
            return true;
        });

        filtered.sort((a, b) => new Date(b.Date) - new Date(a.Date));
        if (filtered.length === 0) { tbody.innerHTML = '<tr><td colspan="8" class="empty">查無紀錄</td></tr>'; return; }

        tbody.innerHTML = filtered.map(acc => {
            const payerName = getMemberName(this.data.members, acc.Payer);
            const description = cleanAccountingDescription(acc.Description);
            const amt = parseFloat(acc.Amount);
            const isFund = acc.Payer === 'Fund';
            let statusIcon = '<i class="ph-fill ph-circle" style="color: var(--success); font-size:1.2rem;"></i>'; 
            if (!isFund && !acc.Payback_Date) statusIcon = '<i class="ph-fill ph-circle" style="color: var(--danger); font-size:1.2rem;"></i>'; 
            else if (acc.Type === 'School' && !acc.Recharge_Date) statusIcon = '<i class="ph-fill ph-circle" style="color: var(--warning); font-size:1.2rem;"></i>';
            
            const dateRecharge = acc.Recharge_Date ? formatDateForInput(acc.Recharge_Date) : `<span class="date-empty">等待</span>`;
            const datePayback = isFund ? `<span class="date-empty">-</span>` : (acc.Payback_Date ? formatDateForInput(acc.Payback_Date) : `<span style="color:#dc3545">未還款</span>`);
            const showRecharge = (acc.Type !== 'School') ? '<span class="date-empty">-</span>' : dateRecharge;

            return `
            <tr onclick="app.openAccModal('${acc.Txn_ID}')" style="cursor:pointer">
                <td style="text-align:center; font-size:1.2rem;">${statusIcon}</td>
                <td>${formatDateForInput(acc.Date).substring(5)}</td> <td>
                    <div class="mobile-truncate" title="${description}">${description}</div>
                    <br><small style="color:#888">${this.getAccTypeName(acc.Type)}</small>
                </td>
                <td style="text-align:right; font-weight:bold;" class="${amt >= 0 ? 'amount-pos' : 'amount-neg'}">${amt}</td>
                <td class="hide-mobile">${payerName}</td>
                <td class="hide-mobile">${showRecharge}</td>
                <td class="hide-mobile">${datePayback}</td>
                <td style="text-align:center;"><button type="button" class="btn btn-sm btn-secondary" aria-label="編輯帳務"><i class="ph ph-pencil-simple" aria-hidden="true"></i></button></td>
            </tr>`;
        }).join('');
    },

    getAccTypeName: function(type) {
        if(type === 'School') return '<i class="ph ph-buildings"></i> 報帳';
        if(type === 'Lab') return '<i class="ph ph-flask"></i> 內帳';
        if(type === 'Income' || type === 'Deposit') return '<i class="ph ph-download-simple"></i> 匯入';
        if(type === 'Withdraw' || type === 'Withdrawal') return '<i class="ph ph-money"></i> 提款';
        return type;
    },

    openAccModal: function(id = null) {
        if (this.currentRole !== 'Admin') return;
        const modal = document.getElementById('acc-modal');
        const btnDel = document.getElementById('btn-del-a');
        const inputs = document.querySelectorAll('#acc-modal input, #acc-modal select, #acc-modal textarea');
        const acc = id ? this.data.accounting.find(x => x.Txn_ID === id) : null;

        if (id && !acc) {
            showNotification('找不到該筆帳務紀錄，請重新整理頁面。', 'error');
            return;
        }
        
        fillPayerSelect('Acc_Payer', this.data.members, acc?.Payer || 'Fund');
        inputs.forEach(el => el.value = '');

        if (id) {
            document.getElementById('a-modal-title').innerText = "編輯帳務";
            if (btnDel) btnDel.classList.remove('hidden');
            
            document.getElementById('Txn_ID').value = acc.Txn_ID;
            document.getElementById('Acc_Type').value = acc.Type;
            document.getElementById('Acc_Date').value = formatDateForInput(acc.Date);
            document.getElementById('Acc_Description').value = cleanAccountingDescription(acc.Description);
            document.getElementById('Acc_Amount').value = acc.Amount;
            document.getElementById('Acc_Payer').value = acc.Payer;
            document.getElementById('Recharge_Date').value = formatDateForInput(acc.Recharge_Date);
            document.getElementById('Payback_Date').value = formatDateForInput(acc.Payback_Date);
        } else {
            document.getElementById('a-modal-title').innerText = "新增帳務";
            if (btnDel) btnDel.classList.add('hidden');
            const now = new Date();
            document.getElementById('Txn_ID').value = generateId('ACC');
            document.getElementById('Acc_Date').value = formatDateForInput(new Date());
            document.getElementById('Acc_Type').value = 'School';
            document.getElementById('Acc_Payer').value = 'Fund';
        }
        
        this.handleAccTypeChange();
        this.handleAccPayerChange();
        if (modal) modal.classList.remove('hidden');
    },

    // 控制扣款來源按鈕的 UI 與取值
    setFundSource: function(source) {
        const fsInput = document.getElementById('Fund_Source');
        if (fsInput) fsInput.value = source;
        
        const btnBank = document.getElementById('btn-fs-bank');
        const btnCash = document.getElementById('btn-fs-cash');
        if (btnBank) {
            if(source === 'Bank') btnBank.classList.add('active'); else btnBank.classList.remove('active');
        }
        if (btnCash) {
            if(source === 'Cash') btnCash.classList.add('active-success'); else btnCash.classList.remove('active-success');
        }
    },

    // === UI 連動：類型改變時 ===
    handleAccTypeChange: function() {
        const type = document.getElementById('Acc_Type').value;
        const divRecharge = document.getElementById('grp-recharge');
        const payerSelect = document.getElementById('Acc_Payer');
        const descInput = document.getElementById('Acc_Description');
        
        // 只有 School 需要回沖日期
        divRecharge.style.visibility = (type === 'School') ? 'visible' : 'hidden';

        // ★ 自動化防呆：提款或匯入時，自動填寫名稱
        if (type === 'Withdraw') {
            descInput.value = "銀行提款";
            this.setFundSource('Bank');
        } else if (type === 'Income') {
            descInput.value = "匯入公積金";
            // Income 不強制設為 Bank，讓 User 可以自己選 Bank 或 Cash
        } else {
            // 切換回報帳/內帳時，清空預設字
            if (["銀行提款", "匯入公積金", "🏧 銀行提款", "💰 匯入公積金"].includes(descInput.value)) {
                descInput.value = "";
            }
        }

        // ★ 核心修復：提款或匯入，強制 Payer 鎖定為 Fund (公積金)
        if (type === 'Withdraw' || type === 'Income') {
            payerSelect.value = 'Fund';
            payerSelect.disabled = true;
        } else {
            payerSelect.disabled = false;
        }
        
        this.handleAccPayerChange(); 
    },

    // === UI 連動：代墊人改變時 ===
    handleAccPayerChange: function() {
        const payer = document.getElementById('Acc_Payer').value;
        const type = document.getElementById('Acc_Type').value;
        const divPayback = document.getElementById('grp-payback');
        const divFundSource = document.getElementById('grp-fund-source');

        // 還款日期：只有在代墊人不是 Fund 且「不是匯入/提款」時才顯示
        if (payer === 'Fund' || type === 'Income' || type === 'Withdraw') {
            divPayback.style.display = 'none';
        } else {
            divPayback.style.display = 'flex';
        }

        // 資金來源 (戶頭/現金) 顯示邏輯：
        if (type === 'Withdraw') {
            // 提款固定是 Bank -> Cash，不需要給 User 選
            divFundSource.style.display = 'none';
        } else if (type === 'Income' || payer === 'Fund') {
            // 匯入(Income)，或由公積金直接扣款時，必須顯示讓 User 選 Bank 或 Cash
            divFundSource.style.display = 'flex';
        } else {
            divFundSource.style.display = 'none'; 
        }
    },

    saveAccounting: async function() {
        let rawAmount = parseFloat(document.getElementById('Acc_Amount').value);
        const type = document.getElementById('Acc_Type').value;

        if (isNaN(rawAmount)) rawAmount = 0;

        // 自動正負號邏輯
        if (type === 'School' || type === 'Lab') {
            rawAmount = -Math.abs(rawAmount); 
        } else {
            rawAmount = Math.abs(rawAmount);  
        }

        const fundSourceVal = document.getElementById('Fund_Source').value || 'Bank';
        
        // ★ 強制防呆：如果是匯入或提款，直接從後端將代墊人鎖定為公積金 (Fund)
        let finalPayer = document.getElementById('Acc_Payer').value;
        if (type === 'Income' || type === 'Withdraw') {
            finalPayer = 'Fund';
        }

        const txnId = document.getElementById('Txn_ID').value;
        const isNew = !this.data.accounting.find(a => a.Txn_ID === txnId);
        const now = new Date().toISOString();

        const payload = {
            Txn_ID: txnId,
            Type: type,
            Date: document.getElementById('Acc_Date').value,
            Description: document.getElementById('Acc_Description').value,
            Amount: rawAmount,
            Payer: finalPayer,
            Recharge_Date: document.getElementById('Recharge_Date').value,
            Payback_Date: document.getElementById('Payback_Date').value,
            Invoice_Link: document.getElementById('Invoice_Link').value,
            Remark: document.getElementById('Acc_Remark').value,
            Fund_Source: fundSourceVal,
            // ★ Phase 3：稽核時間戳
            Updated_At: now
        };
        if (isNew) payload.Created_At = now;

        if (!payload.Description || !payload.Amount) { showNotification("請填寫項目和金額", 'error'); return; }

        const btn = document.getElementById('btn-save-a');
        btn.innerText = "儲存中...";
        btn.disabled = true;

        try {
            await setDoc(doc(db, "accounting", payload.Txn_ID), payload);
            closeModal('acc-modal');
        } catch (e) {
            showNotification("發生錯誤：" + e.message, 'error');
        } finally {
            btn.innerText = "儲存";
            btn.disabled = false;
        }
    }
};
