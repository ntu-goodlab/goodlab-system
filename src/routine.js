/**
 * GOODLAB — 實驗室行事模組
 *
 * 資料模型（向下相容 interval_days 與舊分類）：
 * routines/{id}: {
 *   name, category, schedule_type, interval_value, interval_unit, interval_days,
 *   last_done, next_due, schedule_anchor, completed, completed_at, remind_days,
 *   url, notes, visible_to_users, created_at, updated_at
 * }
 */
import { db, doc, setDoc, deleteDoc } from './firebase.js';
import { ROUTINE_CATEGORIES } from './constants.js';
import { generateId } from './utils.js';
import {
    ROUTINE_UNIT_LABELS,
    toLocalDateString,
    parseLocalDate,
    getRoutineScheduleType,
    getRoutineInterval,
    routineIntervalToDays,
    addRoutineInterval,
    calculateNextScheduledDue
} from './routine-schedule.js';

const ROUTINE_FILTERS = [
    { value: 'all', label: '全部' },
    ...ROUTINE_CATEGORIES.map(category => ({ value: category, label: category }))
];

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
}

function normalizeRoutineCategory(value) {
    if (ROUTINE_CATEGORIES.includes(value)) return value;
    if (value === '行政' || value === 'license購買') return '行政';
    return '例行工作';
}

function routineCategoryClass(value) {
    const category = normalizeRoutineCategory(value);
    if (category === '活動') return 'is-activity';
    if (category === '行政') return 'is-admin';
    return 'is-routine';
}

function isCompletedOneTime(routine) {
    return getRoutineScheduleType(routine) === 'one_time' && Boolean(routine.completed);
}

function sortRoutineItems(a, b) {
    const aCompleted = isCompletedOneTime(a);
    const bCompleted = isCompletedOneTime(b);
    if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;

    if (!aCompleted) {
        const dueCompare = (a.next_due || '9999-12-31').localeCompare(b.next_due || '9999-12-31');
        if (dueCompare !== 0) return dueCompare;
    } else {
        const completedCompare = (b.last_done || '').localeCompare(a.last_done || '');
        if (completedCompare !== 0) return completedCompare;
    }

    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant');
}

export const routineModule = {
    routineView: 'overview',
    routineFilter: 'all',

    getUpcomingRoutines: function(limit = 5) {
        return [...this.data.routines]
            .filter(routine => routine.next_due && !isCompletedOneTime(routine))
            .sort(sortRoutineItems)
            .slice(0, limit);
    },

    getRoutineIntervalLabel: function(routine) {
        if (getRoutineScheduleType(routine) === 'one_time') return '一次性';
        const interval = getRoutineInterval(routine);
        return `${interval.value} ${ROUTINE_UNIT_LABELS[interval.unit]}`;
    },

    setRoutineFilter: function(filter) {
        const allowedFilters = new Set(ROUTINE_FILTERS.map(item => item.value));
        this.routineFilter = allowedFilters.has(filter) ? filter : 'all';
        this.renderRoutine();
    },

    _renderRoutineFilters: function() {
        return `<div class="routine-filter-tabs" role="group" aria-label="行事分類篩選">
            ${ROUTINE_FILTERS.map(filter => {
                const active = this.routineFilter === filter.value;
                return `<button type="button" class="routine-filter-tab${active ? ' active' : ''}"
                    aria-pressed="${active}" onclick="app.setRoutineFilter('${filter.value}')">${filter.label}</button>`;
            }).join('')}
        </div>`;
    },

    _getFilteredRoutines: function() {
        const routines = Array.isArray(this.data.routines) ? this.data.routines : [];
        if (this.routineFilter === 'all') return routines;
        return routines.filter(routine => normalizeRoutineCategory(routine.category) === this.routineFilter);
    },

    renderRoutine: function() {
        const container = document.getElementById('routine-content');
        if (!container) return;

        if (this.currentRole !== 'Admin') {
            container.innerHTML = `<div class="empty-state"><i class="ph-fill ph-lock-key" aria-hidden="true"></i>此頁面僅限 Admin 檢視</div>`;
            return;
        }

        if (this.routineView === 'edit') this._renderRoutineEdit(container);
        else this._renderRoutineOverview(container);
    },

    _renderRoutineOverview: function(container) {
        const routines = [...this._getFilteredRoutines()].sort(sortRoutineItems);
        const today = toLocalDateString(new Date());
        const rows = routines.map(routine => {
            const category = normalizeRoutineCategory(routine.category);
            const completed = isCompletedOneTime(routine);
            const dueDate = parseLocalDate(routine.next_due);
            const todayDate = parseLocalDate(today);
            const daysUntil = dueDate ? Math.round((dueDate - todayDate) / 86400000) : null;
            const warnDays = Array.isArray(routine.remind_days) ? routine.remind_days : [7, 3, 0];
            const warningThreshold = Math.max(...warnDays, 0);
            let statusClass = 'routine-status-ok';
            let statusIcon = 'ph-check-circle';
            let statusText = '正常';

            if (completed) {
                statusClass = 'routine-status-completed';
                statusText = '已完成';
            } else if (daysUntil !== null && daysUntil < 0) {
                statusClass = 'routine-status-overdue';
                statusIcon = 'ph-warning-circle';
                statusText = `逾期 ${Math.abs(daysUntil)} 天`;
            } else if (daysUntil === 0) {
                statusClass = 'routine-status-warn';
                statusIcon = 'ph-clock';
                statusText = '今天到期';
            } else if (daysUntil !== null && daysUntil <= warningThreshold) {
                statusClass = 'routine-status-warn';
                statusIcon = 'ph-clock';
                statusText = `${daysUntil} 天後`;
            } else if (daysUntil === null) {
                statusClass = 'routine-status-muted';
                statusIcon = 'ph-minus-circle';
                statusText = '未設定日期';
            }

            const safeName = escapeHtml(routine.name);
            const safeUrl = /^https?:\/\//i.test(routine.url || '') ? escapeHtml(routine.url) : '';
            const nameHtml = safeUrl
                ? `<a class="routine-name-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeName}<i class="ph ph-arrow-square-out" aria-hidden="true"></i></a>`
                : this._linkifyText(safeName);

            return `<tr${completed ? ' class="routine-row-completed"' : ''}>
                <td class="routine-complete-column">
                    <input type="checkbox" aria-label="${completed ? `${safeName} 已完成` : `將 ${safeName} 標記為今天完成`}"
                        ${completed ? 'checked disabled' : `onchange="app.completeRoutine('${routine._id}')"`}>
                </td>
                <td class="routine-item-cell">
                    <span class="routine-category-label ${routineCategoryClass(category)}">${escapeHtml(category)}</span>
                    <span class="routine-overview-item-name">${nameHtml}</span>
                    ${routine.notes ? `<div class="routine-notes">${this._linkifyText(escapeHtml(routine.notes))}</div>` : ''}
                </td>
                <td class="routine-cycle-cell">${this.getRoutineIntervalLabel(routine)}</td>
                <td class="date-cell">${routine.last_done || '-'}</td>
                <td class="date-cell">${routine.next_due || '-'}</td>
                <td class="routine-status-cell"><span class="${statusClass}"><i class="ph ${statusIcon}" aria-hidden="true"></i> ${statusText}</span></td>
            </tr>`;
        }).join('');

        container.innerHTML = `
            <div class="section-toolbar">
                <h2>實驗室行事</h2>
                <button class="btn btn-primary btn-sm" onclick="app.routineView='edit'; app.renderRoutine();">
                    <i class="ph ph-pencil-simple" aria-hidden="true"></i> 編輯行事
                </button>
            </div>
            ${this._renderRoutineFilters()}
            ${routines.length ? `<div class="table-container"><table class="routine-table routine-overview-table">
                    <colgroup>
                        <col class="routine-col-complete">
                        <col class="routine-col-item">
                        <col class="routine-col-cycle">
                        <col class="routine-col-date">
                        <col class="routine-col-date">
                        <col class="routine-col-status">
                    </colgroup>
                    <thead><tr>
                        <th class="routine-complete-column">完成</th>
                        <th>項目</th>
                        <th>執行方式</th>
                        <th>上次完成</th>
                        <th>下次日期</th>
                        <th>狀態</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table></div>` : '<div class="empty-state"><i class="ph ph-calendar-blank" aria-hidden="true"></i>此分類目前沒有行事項目</div>'}`;
    },

    _renderRoutineEdit: function(container) {
        const rows = [...this._getFilteredRoutines()]
            .sort(sortRoutineItems)
            .map(routine => {
                const category = normalizeRoutineCategory(routine.category);
                const completed = isCompletedOneTime(routine);
                return `<tr${completed ? ' class="routine-row-completed"' : ''}>
                    <td class="routine-item-cell">
                        <span class="routine-category-label ${routineCategoryClass(category)}">${escapeHtml(category)}</span>
                        <span class="routine-edit-item-name">${escapeHtml(routine.name)}</span>
                    </td>
                    <td>${routine.visible_to_users ? '<span class="status-badge status-badge-success"><i class="ph ph-eye" aria-hidden="true"></i> 顯示</span>' : '<span class="status-badge"><i class="ph ph-eye-slash" aria-hidden="true"></i> 不顯示</span>'}</td>
                    <td>${this.getRoutineIntervalLabel(routine)}</td>
                    <td class="date-cell">${routine.last_done || '-'}</td>
                    <td class="date-cell">${routine.next_due || (completed ? '已完成' : '-')}</td>
                    <td class="routine-action-cell">
                        <div class="table-actions">
                            <button class="btn btn-sm btn-secondary" aria-label="編輯 ${escapeHtml(routine.name)}" onclick="app.openRoutineEditModal('${routine._id}')"><i class="ph ph-pencil-simple" aria-hidden="true"></i></button>
                            <button class="btn btn-sm btn-secondary btn-icon-danger" aria-label="刪除 ${escapeHtml(routine.name)}" onclick="app.deleteRoutineItem('${routine._id}')"><i class="ph ph-trash" aria-hidden="true"></i></button>
                        </div>
                    </td>
                </tr>`;
            }).join('');

        container.innerHTML = `
            <div class="section-toolbar">
                <h2>編輯實驗室行事</h2>
                <div class="toolbar-actions">
                    <button class="btn btn-secondary btn-sm" onclick="app.routineView='overview'; app.renderRoutine();"><i class="ph ph-arrow-left" aria-hidden="true"></i> 返回行事</button>
                    <button class="btn btn-primary btn-sm" onclick="app.openRoutineEditModal()"><i class="ph ph-plus" aria-hidden="true"></i> 新增項目</button>
                </div>
            </div>
            ${this._renderRoutineFilters()}
            <div class="table-container"><table class="routine-table routine-edit-table">
                <colgroup>
                    <col class="routine-col-item">
                    <col class="routine-col-visibility">
                    <col class="routine-col-cycle">
                    <col class="routine-col-date">
                    <col class="routine-col-date">
                    <col class="routine-col-actions">
                </colgroup>
                <thead><tr><th>項目</th><th>成員總覽</th><th>執行方式</th><th>上次完成</th><th>下次日期</th><th>操作</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="6" class="empty">此分類目前沒有行事項目</td></tr>'}</tbody>
            </table></div>`;
    },

    _linkifyText: function(text) {
        if (!text) return '';
        return text.replace(/https?:\/\/[^\s<>"'，。；、）)]+/g, url => {
            let label = '開啟連結';
            try {
                label = new URL(url.replaceAll('&amp;', '&')).hostname.replace(/^www\./, '');
            } catch (_) {
                // 無法解析網域時仍保留可辨識的通用連結文字。
            }
            return `<a class="routine-inline-link" href="${url}" target="_blank" rel="noopener noreferrer" title="${url}" aria-label="開啟 ${escapeHtml(label)}"><i class="ph ph-link" aria-hidden="true"></i>${escapeHtml(label)}</a>`;
        });
    },

    completeRoutine: async function(id) {
        const routine = this.data.routines.find(item => item._id === id);
        if (!routine) return;

        const today = toLocalDateString(new Date());
        const oneTime = getRoutineScheduleType(routine) === 'one_time';
        const now = new Date().toISOString();
        const payload = oneTime
            ? { last_done: today, next_due: null, schedule_anchor: null, completed: true, completed_at: now, updated_at: now }
            : {
                last_done: today,
                next_due: calculateNextScheduledDue(routine, today),
                schedule_anchor: routine.schedule_anchor || routine.next_due || routine.last_done || today,
                completed: false,
                completed_at: null,
                updated_at: now
            };

        try {
            await setDoc(doc(db, 'routines', id), payload, { merge: true });
            this.showNotification(oneTime ? '一次性行事已完成並停止提醒' : `已完成；下次日期為 ${payload.next_due}`, 'success');
        } catch (error) {
            this.showNotification('更新失敗：' + error.message, 'error');
            this.renderRoutine();
        }
    },

    openRoutineEditModal: function(id) {
        const routine = id ? this.data.routines.find(item => item._id === id) : null;
        const interval = getRoutineInterval(routine || {});
        const scheduleType = getRoutineScheduleType(routine || {});
        const selectedCategory = normalizeRoutineCategory(routine?.category);
        const categoryOptions = ROUTINE_CATEGORIES.map(category =>
            `<option value="${escapeHtml(category)}" ${selectedCategory === category ? 'selected' : ''}>${escapeHtml(category)}</option>`
        ).join('');

        document.getElementById('routine-edit-modal')?.remove();
        this.modalReturnFocus?.delete('routine-edit-modal');
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'routine-edit-modal';
        modal.innerHTML = `
            <div class="modal-content routine-edit-dialog">
                <div class="modal-header">
                    <h3>${routine ? '編輯' : '新增'}行事項目</h3>
                    <button type="button" class="close" aria-label="關閉" onclick="app.closeModal('routine-edit-modal')">&times;</button>
                </div>
                <div class="modal-body">
                    <input type="hidden" id="routine-edit-id" value="${id || ''}">
                    <div class="form-group"><label for="routine-name">項目</label><input type="text" id="routine-name" value="${escapeHtml(routine?.name || '')}" required></div>
                    <div class="form-row-two">
                        <div class="form-group"><label for="routine-category">分類</label><select id="routine-category">${categoryOptions}</select></div>
                        <div class="form-group"><label for="routine-schedule-type">執行方式</label><select id="routine-schedule-type" onchange="app.toggleRoutineScheduleFields()">
                            <option value="recurring" ${scheduleType === 'recurring' ? 'selected' : ''}>週期性</option>
                            <option value="one_time" ${scheduleType === 'one_time' ? 'selected' : ''}>一次性</option>
                        </select></div>
                    </div>
                    <div class="form-row-two routine-interval-fields" id="routine-interval-fields">
                        <div class="form-group"><label for="routine-interval-value">每隔</label><input type="number" id="routine-interval-value" value="${interval.value}" min="1" required></div>
                        <div class="form-group"><label for="routine-interval-unit">週期單位</label><select id="routine-interval-unit">
                            <option value="day" ${interval.unit === 'day' ? 'selected' : ''}>天</option>
                            <option value="month" ${interval.unit === 'month' ? 'selected' : ''}>月</option>
                            <option value="year" ${interval.unit === 'year' ? 'selected' : ''}>年</option>
                        </select></div>
                    </div>
                    <div id="routine-schedule-help" class="form-help routine-schedule-help"></div>
                    <div class="form-row-two">
                        <div class="form-group"><label for="routine-last-done">上次完成日期</label><input type="date" id="routine-last-done" value="${routine?.last_done || ''}"></div>
                        <div class="form-group"><label for="routine-next-due" id="routine-next-due-label">下次日期</label><input type="date" id="routine-next-due" value="${routine?.next_due || ''}"></div>
                    </div>
                    <div class="form-group"><label for="routine-remind">提前提醒天數</label><input type="text" id="routine-remind" value="${escapeHtml((routine?.remind_days || [7, 3, 0]).join(','))}" aria-describedby="routine-remind-help"><div id="routine-remind-help" class="form-help">用逗號分隔，例如 7,3,0。</div></div>
                    <div class="form-group"><label for="routine-url">相關連結（選填）</label><input type="url" id="routine-url" value="${escapeHtml(routine?.url || '')}"></div>
                    <div class="form-group"><label for="routine-notes">備註（選填）</label><textarea id="routine-notes" rows="4">${escapeHtml(routine?.notes || '')}</textarea></div>
                    <label class="overview-check"><input type="checkbox" id="routine-visible" ${routine?.visible_to_users ? 'checked' : ''}>顯示於一般成員總覽</label>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="app.closeModal('routine-edit-modal')">取消</button>
                    <button class="btn btn-primary" id="btn-save-routine" onclick="app.saveRoutineItem()">儲存</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        this.toggleRoutineScheduleFields();
    },

    toggleRoutineScheduleFields: function() {
        const typeSelect = document.getElementById('routine-schedule-type');
        const intervalFields = document.getElementById('routine-interval-fields');
        const intervalValue = document.getElementById('routine-interval-value');
        const intervalUnit = document.getElementById('routine-interval-unit');
        const help = document.getElementById('routine-schedule-help');
        const dueLabel = document.getElementById('routine-next-due-label');
        if (!typeSelect || !intervalFields) return;

        const oneTime = typeSelect.value === 'one_time';
        intervalFields.hidden = oneTime;
        intervalValue.disabled = oneTime;
        intervalUnit.disabled = oneTime;
        if (help) {
            help.textContent = oneTime
                ? '一次性項目完成後會保留紀錄，不再產生下一次日期。'
                : '下次日期也是固定排程的基準；延後完成不會改變節奏。若日期曾經偏移，請把下次日期改回正確日期一次。';
        }
        if (dueLabel) dueLabel.textContent = oneTime ? '預定日期' : '下次日期';
    },

    saveRoutineItem: async function() {
        const editId = document.getElementById('routine-edit-id').value;
        const id = editId || generateId('RTN');
        const existing = editId ? this.data.routines.find(item => item._id === editId) : null;
        const name = document.getElementById('routine-name').value.trim();
        const scheduleType = document.getElementById('routine-schedule-type').value;
        const oneTime = scheduleType === 'one_time';
        const intervalValue = oneTime ? null : Math.max(1, parseInt(document.getElementById('routine-interval-value').value, 10) || 1);
        const intervalUnit = oneTime ? null : document.getElementById('routine-interval-unit').value;
        const lastDone = document.getElementById('routine-last-done').value || null;
        let nextDue = document.getElementById('routine-next-due').value || null;
        const remindDays = document.getElementById('routine-remind').value
            .split(',').map(value => parseInt(value.trim(), 10)).filter(Number.isFinite);

        if (!name) {
            this.showNotification('請輸入項目名稱', 'warning');
            document.getElementById('routine-name').focus();
            return;
        }

        const preserveCompleted = oneTime && Boolean(existing?.completed) && !nextDue;
        if (oneTime && !preserveCompleted && !nextDue) {
            this.showNotification('請設定一次性項目的預定日期', 'warning');
            document.getElementById('routine-next-due').focus();
            return;
        }
        if (!oneTime && !nextDue && lastDone) {
            nextDue = addRoutineInterval(lastDone, { interval_value: intervalValue, interval_unit: intervalUnit });
        }

        const intervalChanged = Boolean(existing) && (
            Number(existing.interval_value) !== intervalValue || existing.interval_unit !== intervalUnit
        );
        const nextDueChanged = Boolean(existing) && existing.next_due !== nextDue;
        const scheduleAnchor = oneTime
            ? null
            : (!existing || intervalChanged || nextDueChanged
                ? nextDue
                : (existing.schedule_anchor || existing.next_due || nextDue));

        const now = new Date().toISOString();
        const payload = {
            name,
            category: document.getElementById('routine-category').value,
            schedule_type: scheduleType,
            interval_value: intervalValue,
            interval_unit: intervalUnit,
            interval_days: oneTime ? null : routineIntervalToDays(intervalValue, intervalUnit),
            last_done: lastDone,
            next_due: preserveCompleted ? null : nextDue,
            schedule_anchor: preserveCompleted ? null : scheduleAnchor,
            completed: preserveCompleted,
            completed_at: preserveCompleted ? (existing.completed_at || now) : null,
            remind_days: remindDays.length ? remindDays : [7, 3, 0],
            url: document.getElementById('routine-url').value.trim() || null,
            notes: document.getElementById('routine-notes').value.trim() || null,
            visible_to_users: Boolean(document.getElementById('routine-visible').checked),
            created_at: existing?.created_at || now,
            updated_at: now
        };

        const button = document.getElementById('btn-save-routine');
        button.disabled = true;
        button.textContent = '儲存中...';
        try {
            await setDoc(doc(db, 'routines', id), payload, { merge: true });
            this.closeModal('routine-edit-modal');
            this.showNotification('行事項目已儲存', 'success');
        } catch (error) {
            this.showNotification('儲存失敗：' + error.message, 'error');
        } finally {
            button.disabled = false;
            button.textContent = '儲存';
        }
    },

    deleteRoutineItem: async function(id) {
        if (!confirm('確定要刪除此行事項目？')) return;
        try {
            await deleteDoc(doc(db, 'routines', id));
            this.showNotification('行事項目已刪除', 'success');
        } catch (error) {
            this.showNotification('刪除失敗：' + error.message, 'error');
        }
    }
};
