/**
 * GOODLAB — 總覽與公告模組
 *
 * bulletins/meeting：本學期 Meeting 固定資訊
 * bulletins/{id}：一般公告
 */
import { db, doc, setDoc, deleteDoc } from './firebase.js';
import { DUTY_CLEANING_TASKS, DUTY_SUPPLY_ITEMS, DUTY_NOTES } from './constants.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
})[character]);

const safeUrl = value => {
    const url = String(value || '').trim();
    return /^https?:\/\//i.test(url) ? escapeHtml(url) : '';
};

const localDateString = (date = new Date()) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const displayDate = value => {
    if (!value) return '';
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return escapeHtml(value);
    return date.toLocaleDateString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric' });
};

const startOfLocalWeek = (date = new Date()) => {
    const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const daysSinceMonday = (result.getDay() + 6) % 7;
    result.setDate(result.getDate() - daysSinceMonday);
    return result;
};

const getCurrentWeekRange = () => {
    const start = startOfLocalWeek();
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const displayEnd = new Date(end);
    displayEnd.setDate(displayEnd.getDate() - 1);
    return {
        start: localDateString(start),
        end: localDateString(end),
        label: `${start.getMonth() + 1}/${start.getDate()}–${displayEnd.getMonth() + 1}/${displayEnd.getDate()}`
    };
};

const recordDate = value => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.length <= 10) return raw.slice(0, 10);
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? raw.slice(0, 10) : localDateString(date);
};

const getMaintenanceChangeRange = () => {
    const today = new Date();
    const start = startOfLocalWeek(today);
    start.setDate(start.getDate() - 7);
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    end.setDate(end.getDate() + 1);
    return {
        start: localDateString(start),
        end: localDateString(end),
        label: `${start.getMonth() + 1}/${start.getDate()}–今天`
    };
};

const formatMoney = value => {
    const amount = Number(value) || 0;
    return `${amount < 0 ? '-' : ''}$${Math.abs(amount).toLocaleString('zh-TW')}`;
};

export const dashboardModule = {
    overviewEditorOpen: false,
    overviewMeetingEditorOpen: false,
    overviewNoticeEditId: null,

    _getVisibleBulletins: function() {
        const today = localDateString();
        return [...(this.data.bulletins || [])]
            .filter(item => item.published === true && (!item.expires_on || item.expires_on >= today))
            .sort((a, b) => {
                if (a.kind !== b.kind) return a.kind === 'meeting' ? -1 : 1;
                if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
                if (a.priority !== b.priority) return a.priority === 'important' ? -1 : 1;
                return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
            });
    },

    _getLatestDutyHandoff: function() {
        return [...this.data.duty_records]
            .filter(record => record.submitted && String(record.note || '').trim())
            .sort((a, b) => String(b.submitted_at || b._id || '').localeCompare(String(a.submitted_at || a._id || '')))[0] || null;
    },

    _getOverviewDutyData: function() {
        const result = typeof this._getCurrentDutyPerson === 'function' ? this._getCurrentDutyPerson() : null;
        const record = result?.record || null;
        const assignedTo = result?.assignedTo || record?.assigned_to || record?.scheduled_to || '';
        const isCurrentUser = Boolean(this.currentMember?.Student_ID && this.currentMember.Student_ID === assignedTo);
        const completedCount = record
            ? [...DUTY_CLEANING_TASKS.map(task => Boolean(record.cleaning?.[task.id])),
               ...DUTY_SUPPLY_ITEMS.map(item => Boolean(record.supplies?.[item.id]))].filter(Boolean).length
            : 0;
        const totalCount = DUTY_CLEANING_TASKS.length + DUTY_SUPPLY_ITEMS.length;

        let nextMember = null;
        let nextLabel = '完成後下一位';
        if (result?.roster?.length) {
            const nextDate = new Date();
            nextDate.setDate(nextDate.getDate() + 7);
            const nextWeekId = this._getDutyWeekId(nextDate);
            const nextRecord = this.data.duty_records.find(item => item._id === nextWeekId);
            const nextId = nextRecord?.assigned_to || nextRecord?.scheduled_to;
            if (nextId && nextRecord?.assignment_source === 'admin') {
                nextMember = result.roster.find(member => member.Student_ID === nextId) || null;
                nextLabel = '下週已指定';
            } else if (!record?.submitted) {
                // 尚未提交時不預告換人，因為實際規則是原值日生順延。
                nextMember = result.member || result.roster.find(member => member.Student_ID === assignedTo) || null;
                nextLabel = '未完成將順延';
            } else {
                nextMember = nextId
                    ? result.roster.find(member => member.Student_ID === nextId)
                    : this._getNextDutyMember(result.roster, result.scheduledTo || assignedTo);
            }
        }

        return {
            result,
            record,
            assignedTo,
            isCurrentUser,
            completedCount,
            totalCount,
            nextMember,
            nextLabel,
            submitted: Boolean(record?.submitted)
        };
    },

    _getOverviewTasks: function(dutyData) {
        const tasks = [];
        const settings = this.data.inventory.find(item => item.Property_ID === '_SETTINGS_');
        const inventoryOpen = Boolean(settings?.IsOpen);

        if (inventoryOpen) {
            const pendingCount = this.data.inventory.filter(item =>
                item.Property_ID !== '_SETTINGS_' && item.Status !== 'Checked'
            ).length;
            tasks.push({
                icon: 'ph-list-checks',
                title: '產編清點目前開放中',
                detail: pendingCount ? `尚有 ${pendingCount} 筆未完成` : '目前項目皆已完成',
                action: "app.switchTab('inventory')",
                label: '前往清點',
                tone: pendingCount ? 'warning' : 'success'
            });
        }

        return tasks;
    },

    _renderOverviewTasks: function(tasks) {
        if (!tasks.length) return '';

        const rows = tasks.map(task => `<div class="overview-task overview-task-${task.tone}">
                <span class="overview-task-icon"><i class="ph ${task.icon}" aria-hidden="true"></i></span>
                <span class="overview-task-copy"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.detail)}</span></span>
                <button type="button" class="btn btn-secondary btn-sm" onclick="${task.action}">${escapeHtml(task.label)}</button>
            </div>`).join('');

        return `<section class="overview-panel" aria-labelledby="overview-task-heading">
            <div class="overview-panel-header"><div><h3 id="overview-task-heading">待處理事項</h3><p>需要成員確認或操作的項目</p></div></div>
            <div class="overview-task-list">${rows}</div>
        </section>`;
    },

    _renderBulletins: function(isAdmin) {
        const visibleBulletins = this._getVisibleBulletins();
        const source = isAdmin ? [...(this.data.bulletins || [])] : visibleBulletins;
        const meeting = source.find(item => item._id === 'meeting' || item.kind === 'meeting')
            || (isAdmin ? { _id: 'meeting', kind: 'meeting', title: '本學期 Meeting', published: false } : null);
        const notices = source
            .filter(item => item.kind !== 'meeting' && item._id !== 'meeting')
            .sort((a, b) => {
                if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
                if (a.priority !== b.priority) return a.priority === 'important' ? -1 : 1;
                return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
            });
        const today = localDateString();

        const meetingStatus = isAdmin && meeting.published === false
            ? '<span class="status-badge">未顯示</span>'
            : '<span class="status-badge status-badge-info">固定資訊</span>';
        const meetingHtml = meeting ? `<article class="overview-meeting">
            <span class="overview-bulletin-icon"><i class="ph ph-calendar-dots" aria-hidden="true"></i></span>
            <div class="overview-bulletin-copy">
                <div class="overview-bulletin-title"><strong>${escapeHtml(meeting.title || '本學期 Meeting')}</strong>${meetingStatus}</div>
                <div class="overview-meeting-meta">
                    ${meeting.schedule ? `<span><i class="ph ph-clock" aria-hidden="true"></i>${escapeHtml(meeting.schedule)}</span>` : ''}
                    ${meeting.location ? `<span><i class="ph ph-map-pin" aria-hidden="true"></i>${escapeHtml(meeting.location)}</span>` : ''}
                </div>
                ${meeting.content ? `<p>${escapeHtml(meeting.content).replace(/\n/g, '<br>')}</p>` : ''}
                ${safeUrl(meeting.link_url) ? `<a class="overview-inline-link" href="${safeUrl(meeting.link_url)}" target="_blank" rel="noopener noreferrer"><i class="ph ph-arrow-square-out" aria-hidden="true"></i>${escapeHtml(meeting.link_label || '開啟 Meeting 連結')}</a>` : ''}
            </div>
            ${isAdmin ? '<div class="overview-bulletin-actions"><button type="button" class="btn btn-secondary btn-sm" onclick="app.editMeetingInfo()"><i class="ph ph-pencil-simple" aria-hidden="true"></i>編輯</button></div>' : ''}
        </article>${isAdmin && this.overviewMeetingEditorOpen ? this._renderMeetingEditor(meeting) : ''}` : '';

        const noticeHtml = notices.map(item => {
            const visibilityBadges = isAdmin
                ? `${item.published === false ? '<span class="status-badge">未發布</span>' : ''}${item.expires_on && item.expires_on < today ? '<span class="status-badge">已下架</span>' : ''}`
                : '';
            return `<article class="overview-notice ${item.priority === 'important' ? 'is-important' : ''}">
            <span class="overview-bulletin-icon"><i class="ph ${item.priority === 'important' ? 'ph-warning-circle' : 'ph-megaphone'}" aria-hidden="true"></i></span>
            <div class="overview-bulletin-copy">
                <div class="overview-bulletin-title"><strong>${escapeHtml(item.title)}</strong>${item.priority === 'important' ? '<span class="status-badge status-badge-warning">重要</span>' : ''}${visibilityBadges}</div>
                ${item.content ? `<p>${escapeHtml(item.content).replace(/\n/g, '<br>')}</p>` : ''}
                <div class="overview-notice-meta">
                    ${item.expires_on ? `<span>顯示至 ${displayDate(item.expires_on)}</span>` : ''}
                    ${this._renderLinkedRoutine(item, isAdmin)}
                    ${safeUrl(item.link_url) ? `<a class="overview-inline-link" href="${safeUrl(item.link_url)}" target="_blank" rel="noopener noreferrer"><i class="ph ph-arrow-square-out" aria-hidden="true"></i>${escapeHtml(item.link_label || '開啟相關連結')}</a>` : ''}
                </div>
            </div>
            ${isAdmin ? `<div class="overview-bulletin-actions"><button type="button" class="btn btn-secondary btn-sm" onclick="app.editOverviewNotice('${escapeHtml(item._id)}')"><i class="ph ph-pencil-simple" aria-hidden="true"></i>編輯</button></div>` : ''}
        </article>${isAdmin && this.overviewNoticeEditId === item._id ? this._renderNoticeEditor(item) : ''}`;
        }).join('');

        const emptyHtml = !meetingHtml && !noticeHtml
            ? '<div class="overview-empty-compact">目前沒有公告。</div>'
            : '';

        return `<section class="overview-panel" aria-labelledby="overview-bulletin-heading">
            <div class="overview-panel-header">
                <div><h3 id="overview-bulletin-heading">實驗室公告</h3><p>包含本學期 Meeting 與近期通知</p></div>
                ${isAdmin ? '<button type="button" class="btn btn-primary btn-sm" onclick="app.openOverviewNoticeComposer()"><i class="ph ph-plus" aria-hidden="true"></i>新增公告</button>' : ''}
            </div>
            ${isAdmin && this.overviewEditorOpen ? this._renderNoticeEditor({}) : ''}
            <div class="overview-bulletin-list">${meetingHtml}${noticeHtml}${emptyHtml}</div>
        </section>`;
    },

    _renderLinkedRoutine: function(item, canOpenRoutine = false) {
        if (!item.routine_id) return '';
        const routine = (this.data.routines || []).find(entry => entry._id === item.routine_id);
        if (!routine) return '';
        const detail = [routine.category, routine.next_due].filter(Boolean).join(' · ');
        const label = escapeHtml(detail || routine.name || '相關行事');
        return canOpenRoutine
            ? `<button type="button" class="overview-linked-routine" onclick="app.switchTab('routine')"><i class="ph ph-calendar-check" aria-hidden="true"></i>${label}</button>`
            : `<span class="overview-linked-routine is-static"><i class="ph ph-calendar-check" aria-hidden="true"></i>${label}</span>`;
    },

    _renderStatusStrip: function(dutyData, isAdmin, accounting = null, openLogs = 0) {
        const currentName = dutyData.result?.member?.Name_Ch || '尚未排定';
        const statusLabel = dutyData.submitted ? '本週已完成' : '尚未提交';
        const statusClass = dutyData.submitted ? 'status-badge-success' : 'status-badge-warning';
        const handoff = this._getLatestDutyHandoff();
        const handoffName = handoff ? this.getMemberName(handoff.assigned_to || handoff.scheduled_to) : '';
        const handoffText = handoff
            ? `<span class="overview-duty-handoff"><i class="ph ph-note" aria-hidden="true"></i>${escapeHtml(handoff.note)}<small>${escapeHtml(handoffName)}</small></span>`
            : '';

        return `<section class="overview-status-strip${isAdmin ? '' : ' is-user'}" aria-label="本週值日與實驗室摘要">
            <button type="button" class="overview-duty-primary" onclick="app.switchTab('duty')">
                <span class="overview-duty-icon"><i class="ph ph-broom" aria-hidden="true"></i></span>
                <span class="overview-duty-main">
                    <span class="overview-duty-label">本週值日生</span>
                    <span class="overview-duty-name-row"><strong>${escapeHtml(currentName)}</strong><span class="status-badge ${statusClass}">${statusLabel}</span></span>
                    <span class="overview-duty-progress">已完成 ${dutyData.completedCount}/${dutyData.totalCount} 項 · ${escapeHtml(dutyData.nextLabel)} ${escapeHtml(dutyData.nextMember?.Name_Ch || '尚未排定')}</span>
                    ${handoffText}
                </span>
                <span class="overview-duty-action">查看值日工作<i class="ph ph-arrow-right" aria-hidden="true"></i></span>
            </button>
            ${isAdmin ? `<div class="overview-mini-stats">
                <button type="button" onclick="app.switchTab('accounting')">
                    <span><i class="ph ph-wallet" aria-hidden="true"></i>帳務可用餘額</span>
                    <strong>${formatMoney(accounting?.totalBalance || 0)}</strong>
                    <small>戶頭與現金合計</small>
                </button>
                <button type="button" onclick="app.switchTab('logs')">
                    <span><i class="ph ph-wrench" aria-hidden="true"></i>待處理維修</span>
                    <strong>${openLogs} <small>筆</small></strong>
                    <small>查看目前狀態</small>
                </button>
            </div>` : ''}
        </section>`;
    },

    _getMaintenanceOverview: function() {
        const range = getMaintenanceChangeRange();
        const open = (this.data.logs || [])
            .filter(log => log.Status !== 'Closed')
            .sort((a, b) => String(b.Date_Reported || '').localeCompare(String(a.Date_Reported || '')));
        const items = (this.data.logs || [])
            .map(log => {
                const changeDates = [log.Updated_At, log.Date_Resolved, log.Created_At, log.Date_Reported]
                    .map(recordDate)
                    .filter(Boolean)
                    .sort((a, b) => b.localeCompare(a));
                return { log, changedOn: changeDates[0] || '' };
            })
            .filter(item => item.changedOn >= range.start && item.changedOn < range.end)
            .sort((a, b) => b.changedOn.localeCompare(a.changedOn));
        return { open, items, range };
    },

    _getAccountingChanges: function() {
        const range = getCurrentWeekRange();
        const events = [];
        (this.data.accounting || []).forEach(item => {
            const createdDate = recordDate(item.Created_At || item.Date);
            if (createdDate >= range.start && createdDate < range.end) {
                events.push({ type: 'created', date: createdDate, sortDate: item.Created_At || item.Date, item });
            }
            const paybackDate = recordDate(item.Payback_Date);
            if (item.Payer !== 'Fund' && paybackDate >= range.start && paybackDate < range.end) {
                events.push({ type: 'payback', date: paybackDate, sortDate: item.Payback_Date, item });
            }
        });
        return events.sort((a, b) => String(b.sortDate || '').localeCompare(String(a.sortDate || '')));
    },

    _renderOperationsOverview: function() {
        const maintenance = this._getMaintenanceOverview();
        const accountingEvents = this._getAccountingChanges();
        const routines = typeof this.getUpcomingRoutines === 'function' ? this.getUpcomingRoutines(6) : [];
        const instrumentName = id => this.data.instruments.find(item => item.Instrument_ID === id)?.Name || id || '未指定儀器';

        const maintenanceRows = maintenance.items.map(({ log, changedOn }) => {
            const closed = log.Status === 'Closed';
            const detail = `${log.Problem_Desc || '未填問題描述'}${closed && log.Solution ? `；處理：${log.Solution}` : ''}`;
            return `<button type="button" class="overview-feed-row" onclick="app.openLogModal('${escapeHtml(log.Log_ID || log._id)}')">
                <span class="overview-feed-dot ${closed ? 'is-closed' : 'is-open'}"></span>
                <span class="overview-feed-copy"><strong>${escapeHtml(instrumentName(log.Instrument_ID))}</strong><small>${escapeHtml(detail)}</small></span>
                <span class="overview-feed-meta"><span class="status-badge ${closed ? 'status-badge-success' : 'status-badge-danger'}">${closed ? '已解決' : '待處理'}</span><small>${escapeHtml(changedOn)}</small></span>
            </button>`;
        }).join('');

        const typeNames = { School: '報帳', Lab: '內帳', Income: '匯入', Deposit: '匯入', Withdraw: '提款', Withdrawal: '提款' };
        const accountingRows = accountingEvents.slice(0, 6).map(event => {
            const item = event.item;
            const isPayback = event.type === 'payback';
            const payer = isPayback ? this.getMemberName(item.Payer) : '';
            const title = isPayback ? `${payer} 完成還款` : (item.Description || '未填帳務項目');
            const detail = isPayback ? (item.Description || '帳務還款') : (typeNames[item.Type] || item.Type || '帳務');
            return `<button type="button" class="overview-feed-row" onclick="app.openAccModal('${escapeHtml(item.Txn_ID || item._id)}')">
                <span class="overview-feed-dot ${isPayback ? 'is-paid' : 'is-accounting'}"></span>
                <span class="overview-feed-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span>
                <span class="overview-feed-meta"><strong>${formatMoney(isPayback ? Math.abs(Number(item.Amount) || 0) : item.Amount)}</strong><small>${escapeHtml(event.date)}</small></span>
            </button>`;
        }).join('');

        const routineRows = routines.map(routine => {
            const today = localDateString();
            const overdue = routine.next_due && routine.next_due < today;
            const dateLabel = routine.next_due || '未設定日期';
            return `<button type="button" class="overview-feed-row" onclick="app.switchTab('routine')">
                <span class="overview-feed-dot ${overdue ? 'is-open' : 'is-routine'}"></span>
                <span class="overview-feed-copy"><strong>${escapeHtml(routine.name)}</strong><small>${escapeHtml(routine.category || '實驗室行事')}</small></span>
                <span class="overview-feed-meta"><span class="${overdue ? 'routine-status-overdue' : 'routine-status-ok'}">${overdue ? '已逾期' : escapeHtml(dateLabel)}</span></span>
            </button>`;
        }).join('');

        return `<section class="overview-panel overview-live-panel" aria-labelledby="overview-live-heading">
            <div class="overview-panel-header">
                <div><h3 id="overview-live-heading">本週實驗室近況</h3><p>內容會隨網站資料即時更新</p></div>
            </div>
            <div class="overview-live-grid">
                <article class="overview-live-column">
                    <div class="overview-live-heading"><div><span>維修異動 ${maintenance.range.label}</span><strong>${maintenance.open.length} 筆待處理</strong></div><button type="button" onclick="app.switchTab('logs')">查看全部</button></div>
                    <div class="overview-feed-list">${maintenanceRows || '<div class="overview-empty-compact">上週一至今天沒有維修異動。</div>'}</div>
                </article>
                <article class="overview-live-column">
                    <div class="overview-live-heading"><div><span>帳務變動</span><strong>本週 ${accountingEvents.length} 筆</strong></div><button type="button" onclick="app.switchTab('accounting')">查看全部</button></div>
                    <div class="overview-feed-list">${accountingRows || '<div class="overview-empty-compact">本週尚無帳務變動。</div>'}</div>
                </article>
                <article class="overview-live-column">
                    <div class="overview-live-heading"><div><span>近期行事</span><strong>${routines.length} 項</strong></div><button type="button" onclick="app.switchTab('routine')">查看全部</button></div>
                    <div class="overview-feed-list">${routineRows || '<div class="overview-empty-compact">目前沒有近期行事。</div>'}</div>
                </article>
            </div>
        </section>`;
    },

    _renderRoutineSummary: function(isAdmin) {
        const routines = typeof this.getUpcomingRoutines === 'function'
            ? this.getUpcomingRoutines(isAdmin ? 6 : 5)
            : [];
        const today = localDateString();
        const rows = routines.map(routine => {
            let stateClass = 'routine-status-ok';
            let stateText = routine.next_due || '未設定日期';
            if (routine.next_due && routine.next_due < today) {
                stateClass = 'routine-status-overdue';
                stateText = `${routine.next_due} · 已逾期`;
            } else if (routine.next_due === today) {
                stateClass = 'routine-status-warn';
                stateText = `${routine.next_due} · 今天`;
            }

            const body = `<span>${escapeHtml(routine.name)}</span><span class="${stateClass}">${escapeHtml(stateText)}</span>`;
            if (isAdmin) return `<button type="button" class="overview-routine-row" onclick="app.switchTab('routine')">${body}</button>`;
            const url = safeUrl(routine.url);
            return url
                ? `<a class="overview-routine-row" href="${url}" target="_blank" rel="noopener noreferrer">${body}</a>`
                : `<div class="overview-routine-row is-static">${body}</div>`;
        }).join('');

        return `<section class="overview-panel" aria-labelledby="overview-routine-heading">
            <div class="overview-panel-header">
                <div><h3 id="overview-routine-heading">${isAdmin ? '近期實驗室行事' : '近期行事'}</h3><p>依日期排序</p></div>
                ${isAdmin ? '<button class="btn btn-secondary btn-sm" onclick="app.switchTab(\'routine\')">查看全部</button>' : ''}
            </div>
            <div class="overview-routine-list">${rows || '<div class="overview-empty-compact">目前沒有近期事項。</div>'}</div>
        </section>`;
    },

    _renderQuickLinks: function() {
        const vendorResource = DUTY_NOTES.find(note => note.link)?.link;
        return `<section class="overview-panel" aria-labelledby="overview-links-heading">
            <div class="overview-panel-header"><div><h3 id="overview-links-heading">常用入口</h3><p>快速進入常用工作與資料</p></div></div>
            <div class="overview-shortcuts">
                <button type="button" onclick="app.switchTab('duty')"><i class="ph ph-broom" aria-hidden="true"></i><span><strong>值日生工作</strong><small>清潔與耗材清點</small></span></button>
                <button type="button" onclick="app.switchTab('inventory')"><i class="ph ph-list-checks" aria-hidden="true"></i><span><strong>產編清點</strong><small>查看或進行盤點</small></span></button>
                <button type="button" onclick="app.switchTab('instruments')"><i class="ph ph-microscope" aria-hidden="true"></i><span><strong>儀器設備</strong><small>查詢儀器資料</small></span></button>
                ${vendorResource ? `<a href="${safeUrl(vendorResource.url)}" target="_blank" rel="noopener noreferrer"><i class="ph ph-address-book" aria-hidden="true"></i><span><strong>廠商聯絡資料</strong><small>${escapeHtml(vendorResource.label)}</small></span></a>` : ''}
            </div>
        </section>`;
    },

    _renderMeetingEditor: function(meeting) {
        return `<section class="overview-inline-editor" aria-labelledby="meeting-editor-heading">
            <div class="overview-editor-heading"><div><h4 id="meeting-editor-heading">編輯本學期 Meeting</h4><p>變更會直接顯示在這張資訊卡。</p></div></div>
            <div class="overview-editor-grid">
                <div class="form-group"><label for="meeting-title">標題</label><input id="meeting-title" type="text" value="${escapeHtml(meeting.title || '本學期 Meeting')}"></div>
                <div class="form-group"><label for="meeting-schedule">時間</label><input id="meeting-schedule" type="text" value="${escapeHtml(meeting.schedule || '')}" placeholder="例如：每週三 14:00–16:00"></div>
                <div class="form-group"><label for="meeting-location">地點</label><input id="meeting-location" type="text" value="${escapeHtml(meeting.location || '')}" placeholder="例如：電機二館 301"></div>
                <div class="form-group"><label for="meeting-link-url">相關連結（選填）</label><input id="meeting-link-url" type="url" value="${escapeHtml(meeting.link_url || '')}"></div>
                <div class="form-group overview-editor-wide"><label for="meeting-content">補充說明（選填）</label><textarea id="meeting-content" rows="3">${escapeHtml(meeting.content || '')}</textarea></div>
                <label class="overview-check overview-editor-wide"><input id="meeting-published" type="checkbox" ${meeting.published !== false ? 'checked' : ''}>顯示於一般成員總覽</label>
            </div>
            <div class="overview-editor-actions"><button type="button" class="btn btn-secondary" onclick="app.cancelMeetingInfoEdit()">取消</button><button type="button" class="btn btn-primary" id="btn-save-meeting" onclick="app.saveMeetingInfo()">儲存 Meeting</button></div>
        </section>`;
    },

    _renderNoticeEditor: function(editing = {}) {
        const isEditing = Boolean(this.overviewNoticeEditId);
        const routineOptions = [...(this.data.routines || [])]
            .sort((a, b) => String(a.next_due || '9999').localeCompare(String(b.next_due || '9999')))
            .map(routine => `<option value="${escapeHtml(routine._id)}" ${editing.routine_id === routine._id ? 'selected' : ''}>${escapeHtml(routine.name || '未命名行事')}${routine.next_due ? `｜${escapeHtml(routine.next_due)}` : ''}</option>`)
            .join('');

        return `<section class="overview-inline-editor ${isEditing ? 'is-editing' : 'is-new'}" aria-labelledby="notice-editor-heading">
            <div class="overview-editor-heading"><div><h4 id="notice-editor-heading">${isEditing ? '編輯公告' : '新增公告'}</h4><p>可選擇一項實驗室行事；日期更新後，公告會同步顯示最新日期。</p></div></div>
            <div class="overview-editor-grid">
                <div class="form-group overview-editor-wide"><label for="notice-title">標題</label><input id="notice-title" type="text" value="${escapeHtml(editing.title || '')}"></div>
                <div class="form-group overview-editor-wide"><label for="notice-content">內容</label><textarea id="notice-content" rows="4">${escapeHtml(editing.content || '')}</textarea></div>
                <div class="form-group"><label for="notice-priority">重要程度</label><select id="notice-priority"><option value="normal" ${editing.priority !== 'important' ? 'selected' : ''}>一般</option><option value="important" ${editing.priority === 'important' ? 'selected' : ''}>重要</option></select></div>
                <div class="form-group"><label for="notice-expires">下架日期（選填）</label><input id="notice-expires" type="date" value="${escapeHtml(editing.expires_on || '')}"></div>
                <div class="form-group overview-editor-wide"><label for="notice-routine">連結實驗室行事（選填）</label><select id="notice-routine"><option value="">不連結行事</option>${routineOptions}</select></div>
                <div class="form-group"><label for="notice-link-label">連結文字（選填）</label><input id="notice-link-label" type="text" value="${escapeHtml(editing.link_label || '')}"></div>
                <div class="form-group"><label for="notice-link-url">連結網址（選填）</label><input id="notice-link-url" type="url" value="${escapeHtml(editing.link_url || '')}"></div>
                <label class="overview-check"><input id="notice-pinned" type="checkbox" ${editing.pinned ? 'checked' : ''}>置頂顯示</label>
                <label class="overview-check"><input id="notice-published" type="checkbox" ${editing.published !== false ? 'checked' : ''}>發布給一般成員</label>
            </div>
            <div id="overview-notice-error" class="form-error" role="alert"></div>
            <div class="overview-editor-actions">
                ${isEditing ? `<button type="button" class="btn btn-secondary btn-icon-danger overview-delete-action" onclick="app.deleteOverviewNotice('${escapeHtml(editing._id)}')"><i class="ph ph-trash" aria-hidden="true"></i>刪除公告</button>` : ''}
                <span class="overview-editor-action-spacer"></span>
                <button type="button" class="btn btn-secondary" onclick="app.cancelOverviewNoticeEdit()">取消</button>
                <button type="button" class="btn btn-primary" id="btn-save-notice" onclick="app.saveOverviewNotice()">${isEditing ? '儲存變更' : '新增公告'}</button>
            </div>
        </section>`;
    },

    renderOverview: function() {
        const container = document.getElementById('overview-content');
        if (!container || !this.currentMember) return;

        const isAdmin = this.currentRole === 'Admin';
        const dutyData = this._getOverviewDutyData();
        const tasks = this._getOverviewTasks(dutyData);

        if (isAdmin) {
            const accounting = typeof this.getAccountingSummary === 'function' ? this.getAccountingSummary() : null;
            const openLogs = this.data.logs.filter(item => item.Status !== 'Closed').length;
            container.innerHTML = `
                ${this._renderStatusStrip(dutyData, true, accounting, openLogs)}
                ${this._renderOperationsOverview()}
                ${this._renderBulletins(true)}`;
            return;
        }

        container.innerHTML = `
            ${this._renderStatusStrip(dutyData, false)}
            ${this._renderOverviewTasks(tasks)}
            ${this._renderBulletins(false)}
            ${this._renderRoutineSummary(false)}
            ${this._renderQuickLinks()}`;
    },

    toggleOverviewEditor: function() {
        this.openOverviewNoticeComposer();
    },

    openOverviewNoticeComposer: function() {
        if (this.currentRole !== 'Admin') return;
        this.overviewEditorOpen = true;
        this.overviewMeetingEditorOpen = false;
        this.overviewNoticeEditId = null;
        this.renderOverview();
        document.getElementById('notice-title')?.focus();
    },

    editMeetingInfo: function() {
        if (this.currentRole !== 'Admin') return;
        this.overviewMeetingEditorOpen = true;
        this.overviewEditorOpen = false;
        this.overviewNoticeEditId = null;
        this.renderOverview();
        document.getElementById('meeting-title')?.focus();
    },

    cancelMeetingInfoEdit: function() {
        this.overviewMeetingEditorOpen = false;
        this.renderOverview();
    },

    editOverviewNotice: function(id) {
        if (this.currentRole !== 'Admin') return;
        this.overviewNoticeEditId = id;
        this.overviewEditorOpen = false;
        this.overviewMeetingEditorOpen = false;
        this.renderOverview();
        document.getElementById('notice-title')?.focus();
    },

    cancelOverviewNoticeEdit: function() {
        this.overviewNoticeEditId = null;
        this.overviewEditorOpen = false;
        this.renderOverview();
    },

    saveMeetingInfo: async function() {
        if (this.currentRole !== 'Admin') return;
        const button = document.getElementById('btn-save-meeting');
        const payload = {
            kind: 'meeting',
            title: document.getElementById('meeting-title')?.value.trim() || '本學期 Meeting',
            schedule: document.getElementById('meeting-schedule')?.value.trim() || '',
            location: document.getElementById('meeting-location')?.value.trim() || '',
            content: document.getElementById('meeting-content')?.value.trim() || '',
            link_url: document.getElementById('meeting-link-url')?.value.trim() || '',
            link_label: '開啟 Meeting 連結',
            published: Boolean(document.getElementById('meeting-published')?.checked),
            pinned: true,
            priority: 'normal',
            updated_at: new Date().toISOString(),
            updated_by: this.currentMember.Student_ID
        };

        if (button) { button.disabled = true; button.textContent = '儲存中…'; }
        try {
            await setDoc(doc(db, 'bulletins', 'meeting'), payload, { merge: true });
            this.overviewMeetingEditorOpen = false;
            this.showNotification('Meeting 資訊已儲存', 'success');
        } catch (error) {
            this.showNotification('Meeting 儲存失敗：' + error.message, 'error');
        } finally {
            if (button) { button.disabled = false; button.textContent = '儲存 Meeting'; }
        }
    },

    saveOverviewNotice: async function() {
        if (this.currentRole !== 'Admin') return;
        const title = document.getElementById('notice-title')?.value.trim() || '';
        const content = document.getElementById('notice-content')?.value.trim() || '';
        const errorElement = document.getElementById('overview-notice-error');
        if (!title || !content) {
            if (errorElement) errorElement.textContent = '請填寫公告標題與內容。';
            (!title ? document.getElementById('notice-title') : document.getElementById('notice-content'))?.focus();
            return;
        }

        const existing = this.overviewNoticeEditId
            ? this.data.bulletins.find(item => item._id === this.overviewNoticeEditId)
            : null;
        const id = this.overviewNoticeEditId || this.generateId('NTC');
        const button = document.getElementById('btn-save-notice');
        const payload = {
            kind: 'announcement',
            title,
            content,
            priority: document.getElementById('notice-priority')?.value || 'normal',
            expires_on: document.getElementById('notice-expires')?.value || null,
            link_label: document.getElementById('notice-link-label')?.value.trim() || '',
            link_url: document.getElementById('notice-link-url')?.value.trim() || '',
            routine_id: document.getElementById('notice-routine')?.value || null,
            pinned: Boolean(document.getElementById('notice-pinned')?.checked),
            published: Boolean(document.getElementById('notice-published')?.checked),
            created_at: existing?.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
            updated_by: this.currentMember.Student_ID
        };

        if (button) { button.disabled = true; button.textContent = '儲存中…'; }
        try {
            await setDoc(doc(db, 'bulletins', id), payload, { merge: true });
            this.overviewNoticeEditId = null;
            this.overviewEditorOpen = false;
            this.showNotification(existing ? '公告已更新' : '公告已新增', 'success');
        } catch (error) {
            this.showNotification('公告儲存失敗：' + error.message, 'error');
        } finally {
            if (button) { button.disabled = false; button.textContent = existing ? '更新公告' : '新增公告'; }
        }
    },

    deleteOverviewNotice: async function(id) {
        if (this.currentRole !== 'Admin' || !confirm('確定要刪除這則公告？')) return;
        try {
            await deleteDoc(doc(db, 'bulletins', id));
            if (this.overviewNoticeEditId === id) this.overviewNoticeEditId = null;
            this.overviewEditorOpen = false;
            this.showNotification('公告已刪除', 'success');
        } catch (error) {
            this.showNotification('公告刪除失敗：' + error.message, 'error');
        }
    }
};
