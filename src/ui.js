/**
 * GOODLAB — UI 共用模組
 * 將 shared.js 的邏輯搬入 src 目錄，並整合 script.js 中散落的 UI 工具。
 */
import { LOCATIONS, LOCATIONS_WITH_OTHER } from './constants.js';
import {
    buildInstrumentSelectItems,
    buildMemberSelectItems,
    buildPayerSelectItems
} from './select-options.js';

// === 通知系統 ===
export function showNotification(msg, type = 'info', duration = 3000) {
    showToast(msg, type, duration);
}

export function showToast(msg, type = 'info', duration = 3000) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        container.setAttribute('aria-live', 'polite');
        container.setAttribute('aria-atomic', 'false');
        document.body.appendChild(container);
    }

    const iconMap = {
        success: '<i class="ph-fill ph-check-circle" style="color:#22c55e"></i>',
        error: '<i class="ph-fill ph-x-circle" style="color:#ef4444"></i>',
        warning: '<i class="ph-fill ph-warning-circle" style="color:#f59e0b"></i>',
        info: '<i class="ph-fill ph-info" style="color:#3b82f6"></i>'
    };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.innerHTML = `<span class="toast-icon" aria-hidden="true">${iconMap[type] || ''}</span><span class="toast-message"></span>`;
    toast.querySelector('.toast-message').textContent = msg;
    
    container.appendChild(toast);
    requestAnimationFrame(() => {
        toast.classList.add('is-visible');
    });

    setTimeout(() => {
        toast.classList.remove('is-visible');
        toast.classList.add('fadeOut');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// === Modal 操作 ===
export function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('hidden');
}

export function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('hidden');
}

// === 通用表格渲染器 ===
export function renderTable({ tbody, data, emptyText, renderRow, colSpan }) {
    if (!tbody) return;
    if (!data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${colSpan || 6}" class="empty" style="text-align:center; padding:20px;">${emptyText || '暫無資料'}</td></tr>`;
        return;
    }
    tbody.innerHTML = data.map(renderRow).join('');
}

// === 共用下拉選單填充 ===
export function populateLocationSelects() {
    const ids = [
        'Inst_Location', 'Log_Location', 'Log_Location_Filter',
        'filter-location', 'Link_Location', 'filter-inv-location'
    ];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;

        const isFilter = id.startsWith('filter') || id === 'Log_Location_Filter';
        const list = isFilter ? LOCATIONS_WITH_OTHER : LOCATIONS;
        const firstOpt = isFilter
            ? '<option value="">全部區域</option>'
            : '<option value="">（請選擇區域）</option>';

        el.innerHTML = firstOpt + list.map(loc => `<option value="${loc}">${loc}</option>`).join('');
    });
}

function replaceSelectOptions(select, placeholder, items, selectedId = '') {
    select.textContent = '';

    const placeholderOption = document.createElement('option');
    placeholderOption.value = '';
    placeholderOption.textContent = placeholder;
    select.appendChild(placeholderOption);

    items.forEach(item => {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        select.appendChild(option);
    });

    if (selectedId) select.value = String(selectedId);
}

export function fillMemberSelect(selectId, members, selectedId = '') {
    const select = document.getElementById(selectId);
    if (!select) return;

    const items = buildMemberSelectItems(members, selectedId);
    const placeholder = (!members || members.length === 0) && !selectedId
        ? '(讀取中或無成員資料)'
        : '(請選擇人員)';
    replaceSelectOptions(select, placeholder, items, selectedId);
}

export function fillPayerSelect(selectId, members, selectedId = '') {
    const select = document.getElementById(selectId);
    if (!select) return;

    const items = buildPayerSelectItems(members, selectedId);
    replaceSelectOptions(select, '(請選擇付款人)', items, selectedId || 'Fund');
}

export function fillInstrumentSelect(selectId, instruments, location = '', selectedId = '') {
    const select = document.getElementById(selectId);
    if (!select) return;

    const items = buildInstrumentSelectItems(instruments, location, selectedId);
    const placeholder = !location && !selectedId
        ? '請先選擇實驗區域...'
        : (items.length === 0 ? '該區域無設備...' : '請選擇故障儀器...');
    replaceSelectOptions(select, placeholder, items, selectedId);
}

// === 複製到剪貼簿 ===
export function copyEmail(emails) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(emails).then(() => {
            showNotification('已複製到剪貼簿！', 'success');
        }).catch(() => {
            fallbackCopy(emails);
        });
    } else {
        fallbackCopy(emails);
    }
}

function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
        document.execCommand('copy');
        showNotification('已複製到剪貼簿！', 'success');
    } catch (e) {
        showNotification('複製失敗，請手動複製。', 'error');
    }
    document.body.removeChild(textarea);
}
