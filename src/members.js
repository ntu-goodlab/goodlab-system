/**
 * GOODLAB — 人員管理模組
 * Phase 4：從 script.js 抽出人員管理相關邏輯。
 * 所有方法透過 mixin 混入 app 物件，因此使用 this. 存取共享狀態。
 */
import { db, doc, setDoc, updateDoc, runTransaction } from './firebase.js';
import { formatDateForInput, calculateGrade } from './utils.js';
import { showNotification, closeModal } from './ui.js';
import {
    buildMigratedMember,
    createMemberIdMigrationPlan,
    normalizeStudentId,
    validateMemberIdMigration
} from './member-id-migration.js';

const MEMBER_GROUPS = [
    { key: 'phd', label: '博士班', className: 'is-phd' },
    { key: 'master', label: '碩士班', className: 'is-master' },
    { key: 'other', label: '其他在學成員', className: 'is-other' },
    { key: 'alumni', label: '已畢業／離校', className: 'is-alumni' }
];

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
}

function memberGroupKey(member) {
    if (member.Status === 'Alumni') return 'alumni';
    if (member.Degree === 'PhD') return 'phd';
    if (member.Degree === 'Master') return 'master';
    return 'other';
}

function memberDegreeLabel(member) {
    if (member.Degree === 'PhD') return '博士班';
    if (member.Degree === 'Master') return '碩士班';
    if (member.Degree === 'Bachelor') return '大學生';
    return member.Degree || '未設定學位';
}

function studentIdSortParts(value) {
    const normalized = String(value || '').trim().toUpperCase();
    const match = /^([A-Z]+)(\d{2,3})/.exec(normalized);
    const rawYear = match?.[2] || '';
    const parsedYear = Number(rawYear);
    return {
        normalized,
        admissionYear: Number.isFinite(parsedYear)
            ? (rawYear.length === 2 ? parsedYear + 100 : parsedYear)
            : Number.POSITIVE_INFINITY
    };
}

function compareMembersForDirectory(a, b) {
    const groupRank = Object.fromEntries(MEMBER_GROUPS.map((group, index) => [group.key, index]));
    const groupDifference = groupRank[memberGroupKey(a)] - groupRank[memberGroupKey(b)];
    if (groupDifference) return groupDifference;

    if (memberGroupKey(a) === 'alumni') {
        const alumniDegreeRank = { PhD: 0, Master: 1, Bachelor: 2 };
        const degreeDifference = (alumniDegreeRank[a.Degree] ?? 3) - (alumniDegreeRank[b.Degree] ?? 3);
        if (degreeDifference) return degreeDifference;
    }

    const left = studentIdSortParts(a.Student_ID);
    const right = studentIdSortParts(b.Student_ID);
    return left.admissionYear - right.admissionYear
        || left.normalized.localeCompare(right.normalized, 'en', { numeric: true, sensitivity: 'base' });
}

const MEMBER_MIGRATION_WRITE_LIMIT = 450;
const MEMBER_MIGRATION_REQUIRED_DATA = [
    { key: 'members', label: '人員' },
    { key: 'instruments', label: '儀器' },
    { key: 'logs', label: '維修' },
    { key: 'accounting', label: '帳務' },
    { key: 'duty_records', label: '值日' },
    { key: 'employments', label: '聘僱' },
    { key: 'bulletins', label: '公告' }
];

function setHidden(element, hidden) {
    if (!element) return;
    element.hidden = hidden;
    element.classList.toggle('hidden', hidden);
}

function migrationPlanSignature(plan) {
    return JSON.stringify((plan?.operations || []).map(operation => ({
        collection: operation.collection,
        documentId: operation.documentId,
        changes: operation.changes
    })));
}

export const membersModule = {

    memberIdMigrationPlan: null,

    // === 人員列表渲染 ===
    renderMembers: function() {
        const container = document.getElementById('member-list');
        if (!container) return;
        const searchEl = document.getElementById('search-member');
        const term = searchEl ? searchEl.value.trim().toLowerCase() : '';
        const isAdmin = this.currentRole === 'Admin';
        
        const filtered = this.data.members
            .filter(member => {
                const previousIds = Array.isArray(member.Previous_Student_IDs) ? member.Previous_Student_IDs : [];
                const searchable = [
                    member.Name_Ch,
                    member.Name_En,
                    member.Student_ID,
                    member.Department,
                    ...previousIds
                ].filter(Boolean).join(' ').toLowerCase();
                return searchable.includes(term);
            })
            .sort(compareMembersForDirectory);

        if (!filtered.length) {
            container.innerHTML = '<div class="empty-state"><i class="ph ph-users" aria-hidden="true"></i>查無符合的人員</div>';
            return;
        }

        container.innerHTML = MEMBER_GROUPS.map(group => {
            const members = filtered.filter(member => memberGroupKey(member) === group.key);
            if (!members.length) return '';

            const cards = members.map(member => {
                const isAlumni = member.Status === 'Alumni';
                const previousIds = Array.isArray(member.Previous_Student_IDs)
                    ? member.Previous_Student_IDs.filter(Boolean)
                    : [];
                const grade = isAlumni
                    ? '已畢業'
                    : calculateGrade(member.Enrollment_Date, member.Degree);
                const adminBadge = member.Role === 'Admin'
                    ? '<span class="role-badge Admin">Admin</span>'
                    : '';
                const degreeLabel = memberDegreeLabel(member);
                const cardLabel = `${member.Name_Ch || member.Student_ID}，${degreeLabel}，${grade}`;
                const showDegreeBadge = group.key === 'alumni' || group.key === 'other';

                return `<article class="member-directory-card ${group.className}">
                    <button type="button" class="member-directory-card-button"
                        ${isAdmin ? `onclick="app.openMemberModal('${escapeHtml(member.Student_ID)}')"` : 'disabled'}
                        aria-label="${escapeHtml(cardLabel)}${isAdmin ? '，點擊編輯' : ''}">
                        <span class="member-card-topline">
                            ${showDegreeBadge ? `<span class="member-degree-badge ${group.className}">${escapeHtml(degreeLabel)}</span>` : ''}
                            <span class="member-card-status ${isAlumni ? 'is-alumni' : 'is-active'}">
                                <i class="ph ${isAlumni ? 'ph-graduation-cap' : 'ph-student'}" aria-hidden="true"></i>${escapeHtml(grade)}
                            </span>
                            ${adminBadge}
                        </span>
                        <span class="member-card-name">
                            <strong>${escapeHtml(member.Name_Ch || member.Student_ID)}</strong>
                            ${member.Name_En ? `<small>${escapeHtml(member.Name_En)}</small>` : ''}
                        </span>
                        <span class="member-card-meta">
                            <span><i class="ph ph-identification-card" aria-hidden="true"></i>${escapeHtml(member.Student_ID)}</span>
                            <span><i class="ph ph-buildings" aria-hidden="true"></i>${escapeHtml(member.Department || '未填系所')}</span>
                        </span>
                        ${previousIds.length ? `<span class="member-card-previous">曾用學號：${previousIds.map(escapeHtml).join('、')}</span>` : ''}
                        ${isAdmin ? '<span class="member-card-edit"><i class="ph ph-pencil-simple" aria-hidden="true"></i>編輯</span>' : ''}
                    </button>
                </article>`;
            }).join('');

            return `<section class="member-directory-group" aria-labelledby="member-group-${group.key}">
                <div class="member-directory-heading">
                    <h3 id="member-group-${group.key}">${group.label}<span>${members.length} 人</span></h3>
                </div>
                <div class="member-directory-grid">${cards}</div>
            </section>`;
        }).join('');
    },

    // === 人員狀態切換 UI ===
    setMemberStatus: function(status) {
        document.getElementById('Status').value = status;
        const btnActive = document.getElementById('btn-status-active');
        const btnAlumni = document.getElementById('btn-status-alumni');
        
        if(status === 'Active') {
            if(btnActive) btnActive.classList.add('active-success');
            if(btnAlumni) btnAlumni.classList.remove('active-danger');
        } else {
            if(btnAlumni) btnAlumni.classList.add('active-danger');
            if(btnActive) btnActive.classList.remove('active-success');
        }
    },

    // === 人員 Modal 開啟 ===
    openMemberModal: function(id = null) {
        if (this.currentRole !== 'Admin') return;
        const modal = document.getElementById('member-modal');
        // ★ 修復：正確抓取所有 input
        const inputs = document.querySelectorAll('#member-modal input, #member-modal select');
        const btnDel = document.getElementById('btn-del-m');
        const btnMigration = document.getElementById('btn-open-member-id-migration');
        const migrationEntry = document.getElementById('member-id-change-entry');
        const previousGroup = document.getElementById('member-previous-ids-group');
        const previousText = document.getElementById('member-previous-ids');
        
        inputs.forEach(el => el.value = '');
        document.querySelectorAll('#member-id-migration input[type="checkbox"]').forEach(el => { el.checked = false; });
        this._setMemberIdMigrationMode(false, false);

        if (id) {
            document.getElementById('m-modal-title').innerText = "編輯成員";
            if (btnDel) btnDel.classList.remove('hidden'); 
            
            const m = this.data.members.find(x => x.Student_ID === id);
            if (!m) {
                this.showNotification('找不到該成員資料，請重新整理頁面。', 'error');
                return;
            }
            inputs.forEach(el => {
                if (el.closest('#member-id-migration')) return;
                if(el.id && m[el.id] !== undefined) { 
                    let val = m[el.id];
                    if (val && val !== "-") {
                        if (el.type === 'date') el.value = this.formatDateForInput(val);
                        else if (el.id === 'Student_ID' || el.id === 'Email') el.value = val.toLowerCase();
                        else el.value = val;
                    }
                }
            });
            document.getElementById('Student_ID').disabled = true;
            this.setMemberStatus(m.Status || 'Active');
            const previousIds = Array.isArray(m.Previous_Student_IDs) ? m.Previous_Student_IDs.filter(Boolean) : [];
            if (previousText) previousText.textContent = previousIds.length ? previousIds.join('、') : '無';
            if (previousGroup) previousGroup.hidden = false;
            if (btnMigration) btnMigration.classList.remove('hidden');
            if (migrationEntry) migrationEntry.classList.remove('hidden');

            if (m.Google_UID) {
                document.getElementById('Bind_Status').value = "已綁定";
                document.getElementById('btn-unbind').classList.remove('hidden');
            } else {
                document.getElementById('Bind_Status').value = "未綁定";
                document.getElementById('btn-unbind').classList.add('hidden');
            }
        } else {
            document.getElementById('m-modal-title').innerText = "新增成員";
            if (btnDel) btnDel.classList.add('hidden'); 
            document.getElementById('Student_ID').disabled = false;
            document.getElementById('Bind_Status').value = "未綁定";
            document.getElementById('btn-unbind').classList.add('hidden');
            if (previousGroup) previousGroup.hidden = true;
            if (btnMigration) btnMigration.classList.add('hidden');
            if (migrationEntry) migrationEntry.classList.add('hidden');
            this.setMemberStatus('Active');
            document.getElementById('Role').value = 'User';
        }
        if (modal) modal.classList.remove('hidden');
    },

    _setMemberIdMigrationMode: function(open, restoreFocus = true) {
        const section = document.getElementById('member-id-migration');
        const saveButton = document.getElementById('btn-save-m');
        const deleteButton = document.getElementById('btn-del-m');
        setHidden(section, !open);
        if (saveButton) saveButton.disabled = open;
        if (deleteButton) deleteButton.disabled = open;
        if (!open) {
            this.memberIdMigrationPlan = null;
            if (restoreFocus) document.getElementById('btn-open-member-id-migration')?.focus();
        }
    },

    openMemberIdMigration: function() {
        const oldId = normalizeStudentId(document.getElementById('Student_ID')?.value);
        const member = this.data.members.find(item => normalizeStudentId(item.Student_ID) === oldId);
        if (!member) {
            this.showNotification('找不到要異動的成員資料。', 'error');
            return;
        }

        this._setMemberIdMigrationMode(true, false);
        document.getElementById('migration-old-id').value = oldId;
        document.getElementById('migration-new-id').value = '';
        document.getElementById('migration-new-email').value = '';
        document.getElementById('migration-new-email').dataset.edited = 'false';
        document.getElementById('migration-new-degree').value = member.Degree || 'Master';
        document.getElementById('migration-new-enrollment-date').value = this.formatDateForInput(member.Enrollment_Date);
        document.getElementById('migration-preserve-binding').checked = Boolean(member.Google_UID);
        document.getElementById('migration-confirm').checked = false;
        const executeButton = document.getElementById('btn-execute-member-id-migration');
        if (executeButton) {
            executeButton.innerHTML = '<i class="ph ph-arrows-left-right" aria-hidden="true"></i> 確認並執行轉移';
        }
        this.updateMemberIdMigrationPreview();
        document.getElementById('migration-new-id').focus();
        document.getElementById('member-id-migration').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },

    cancelMemberIdMigration: function() {
        this._setMemberIdMigrationMode(false);
    },

    handleMemberMigrationNewIdInput: function() {
        const newId = normalizeStudentId(document.getElementById('migration-new-id')?.value);
        const emailInput = document.getElementById('migration-new-email');
        const confirmCheckbox = document.getElementById('migration-confirm');
        if (confirmCheckbox) confirmCheckbox.checked = false;
        if (emailInput && emailInput.dataset.edited !== 'true') {
            emailInput.value = newId ? `${newId}@ntu.edu.tw` : '';
        }
        this.updateMemberIdMigrationPreview();
    },

    markMemberMigrationEmailEdited: function() {
        const emailInput = document.getElementById('migration-new-email');
        const confirmCheckbox = document.getElementById('migration-confirm');
        if (emailInput) emailInput.dataset.edited = 'true';
        if (confirmCheckbox) confirmCheckbox.checked = false;
        this.updateMemberIdMigrationPreview();
    },

    handleMemberMigrationOptionChange: function() {
        const confirmCheckbox = document.getElementById('migration-confirm');
        if (confirmCheckbox) confirmCheckbox.checked = false;
        this.updateMemberIdMigrationPreview();
    },

    updateMemberIdMigrationPreview: function() {
        const oldId = normalizeStudentId(document.getElementById('migration-old-id')?.value);
        const newId = normalizeStudentId(document.getElementById('migration-new-id')?.value);
        const email = document.getElementById('migration-new-email')?.value || '';
        const errorElement = document.getElementById('migration-error');
        const preview = document.getElementById('migration-impact');
        const confirmText = document.getElementById('migration-confirm-text');
        const confirmCheckbox = document.getElementById('migration-confirm');
        const executeButton = document.getElementById('btn-execute-member-id-migration');
        const newIdInput = document.getElementById('migration-new-id');
        const previousPlanSignature = migrationPlanSignature(this.memberIdMigrationPlan);

        if (confirmText) {
            confirmText.textContent = newId
                ? `我確認將 ${oldId} 變更為 ${newId}，並轉移上述資料。`
                : '輸入新學號後才能確認轉移。';
        }

        const validation = validateMemberIdMigration(this.data.members, oldId, newId, email);
        const plan = newId ? createMemberIdMigrationPlan(this.data, oldId, newId) : null;
        const unavailableData = MEMBER_MIGRATION_REQUIRED_DATA.filter(item =>
            this.realtimeLoadState?.[item.key] !== 'loaded'
        );
        const errors = newId
            ? [...validation.errors, ...(plan?.issues || [])]
            : [];
        if (newId && unavailableData.length) {
            errors.push(`資料尚未完整載入：${unavailableData.map(item => item.label).join('、')}。請稍候或重新整理。`);
        }
        if (plan && plan.totalWrites > MEMBER_MIGRATION_WRITE_LIMIT) {
            errors.push(`本次需要 ${plan.totalWrites} 次寫入，超過網站安全上限，尚未執行。`);
        }

        if (errorElement) errorElement.textContent = errors.join(' ');
        if (newIdInput) {
            newIdInput.setAttribute('aria-invalid', errors.length ? 'true' : 'false');
        }

        if (preview) {
            preview.textContent = '';
            const intro = document.createElement('p');
            if (!newId) {
                intro.textContent = '輸入新學號後，這裡會列出實際受影響的資料。';
                preview.appendChild(intro);
            } else if (!errors.length) {
                intro.innerHTML = `<strong>${oldId}</strong> 將改為 <strong>${newId}</strong>，共更新 ${plan.affectedDocuments} 筆關聯資料。`;
                preview.appendChild(intro);

                const affectedGroups = plan.groups.filter(group => group.count > 0);
                if (affectedGroups.length) {
                    const list = document.createElement('ul');
                    affectedGroups.forEach(group => {
                        const item = document.createElement('li');
                        item.textContent = `${group.label}：${group.count} 筆`;
                        list.appendChild(item);
                    });
                    preview.appendChild(list);
                } else {
                    const empty = document.createElement('p');
                    empty.textContent = '目前沒有其他資料引用原學號，只會轉移成員帳號。';
                    preview.appendChild(empty);
                }
                const note = document.createElement('p');
                note.className = 'member-migration-note';
                note.textContent = '聘僱紀錄會改用新學號並保留原始申報學號；新成員狀態會設為在校。';
                preview.appendChild(note);
            } else {
                intro.textContent = '修正上方問題後才會顯示可執行的轉移內容。';
                preview.appendChild(intro);
            }
        }

        const nextPlan = !errors.length ? plan : null;
        const nextPlanSignature = migrationPlanSignature(nextPlan);
        if (confirmCheckbox?.checked && previousPlanSignature && previousPlanSignature !== nextPlanSignature) {
            confirmCheckbox.checked = false;
        }
        this.memberIdMigrationPlan = nextPlan;
        if (confirmCheckbox) confirmCheckbox.disabled = !this.memberIdMigrationPlan;
        if (executeButton) {
            executeButton.disabled = !this.memberIdMigrationPlan || !confirmCheckbox?.checked;
        }
    },

    executeMemberIdMigration: async function() {
        if (this.currentRole !== 'Admin') return;
        const oldId = normalizeStudentId(document.getElementById('migration-old-id')?.value);
        const newId = normalizeStudentId(document.getElementById('migration-new-id')?.value);
        const newEmail = document.getElementById('migration-new-email')?.value || '';
        const validation = validateMemberIdMigration(this.data.members, oldId, newId, newEmail);
        const plan = createMemberIdMigrationPlan(this.data, oldId, newId);
        const sourceMember = this.data.members.find(member => normalizeStudentId(member.Student_ID) === oldId);
        const confirmed = Boolean(document.getElementById('migration-confirm')?.checked);
        const dataReady = MEMBER_MIGRATION_REQUIRED_DATA.every(item =>
            this.realtimeLoadState?.[item.key] === 'loaded'
        );
        const previewIsCurrent = migrationPlanSignature(this.memberIdMigrationPlan) === migrationPlanSignature(plan);

        if (!validation.valid || plan.issues.length || plan.totalWrites > MEMBER_MIGRATION_WRITE_LIMIT || !sourceMember || !confirmed || !dataReady || !previewIsCurrent) {
            const confirmCheckbox = document.getElementById('migration-confirm');
            if (confirmCheckbox) confirmCheckbox.checked = false;
            this.updateMemberIdMigrationPreview();
            this.showNotification(
                previewIsCurrent
                    ? '尚未符合學號異動條件，未修改任何資料。'
                    : '資料在確認後有更新，請重新檢查影響預覽。',
                'warning'
            );
            return;
        }

        const button = document.getElementById('btn-execute-member-id-migration');
        const changedAt = new Date().toISOString();
        const changedBy = this.currentMember?.Student_ID || this.currentUser?.uid || '';
        const migrationOptions = {
            newId,
            newEmail,
            newDegree: document.getElementById('migration-new-degree')?.value,
            newEnrollmentDate: document.getElementById('migration-new-enrollment-date')?.value,
            preserveGoogleBinding: Boolean(document.getElementById('migration-preserve-binding')?.checked),
            changedAt,
            changedBy
        };

        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="ph ph-spinner ph-spin" aria-hidden="true"></i> 轉移中…';
        }

        try {
            await runTransaction(db, async transaction => {
                const oldMemberRef = doc(db, 'members', oldId);
                const newMemberRef = doc(db, 'members', newId);
                const oldMemberSnapshot = await transaction.get(oldMemberRef);
                const newMemberSnapshot = await transaction.get(newMemberRef);

                if (!oldMemberSnapshot.exists()) {
                    throw new Error('原成員資料已不存在，請重新整理。');
                }
                if (newMemberSnapshot.exists()) {
                    throw new Error('新學號已存在，未執行轉移。');
                }

                transaction.set(
                    newMemberRef,
                    buildMigratedMember(oldMemberSnapshot.data(), migrationOptions)
                );
                plan.operations.forEach(operation => {
                    transaction.update(
                        doc(db, operation.collection, operation.documentId),
                        operation.changes
                    );
                });
                transaction.delete(oldMemberRef);
            });

            this.closeModal('member-modal');
            this.showNotification(`學號已由 ${oldId} 變更為 ${newId}，共轉移 ${plan.affectedDocuments} 筆資料。`, 'success', 6000);
        } catch (error) {
            this.showNotification('學號異動失敗，所有資料均未變更：' + error.message, 'error', 7000);
            if (button) {
                button.disabled = false;
                button.innerHTML = '<i class="ph ph-arrows-left-right" aria-hidden="true"></i> 確認並執行轉移';
            }
        }
    },

    // === 解除 Google 綁定 ===
    unbindMember: async function() {
        const id = document.getElementById('Student_ID').value;
        if (!confirm("確定要解除這位成員的 Google 綁定嗎？\n他下次登入時需要重新輸入學號。")) return;
        const member = this.data.members.find(item => normalizeStudentId(item.Student_ID) === normalizeStudentId(id));
        const previousGoogleUids = [
            ...(Array.isArray(member?.Previous_Google_UIDs) ? member.Previous_Google_UIDs : []),
            member?.Google_UID
        ].filter(Boolean);
        
        try {
            await updateDoc(doc(db, "members", id), {
                Google_UID: null,
                Previous_Google_UIDs: [...new Set(previousGoogleUids)]
            });
            document.getElementById('Bind_Status').value = "未綁定";
            document.getElementById('btn-unbind').classList.add('hidden');
            this.showNotification("已成功解除綁定");
        } catch (e) {
            this.showNotification("解除失敗：" + e.message, 'error');
        }
    },

    // === 儲存人員資料 ===
    saveMember: async function() {
        const idInput = document.getElementById('Student_ID');
        const id = idInput.value.trim().toLowerCase();
        if (!id) { alert("請輸入學號"); return; }
        const isEditingExisting = idInput.disabled;
        const conflict = this.data.members.find(member => {
            const memberId = normalizeStudentId(member.Student_ID);
            if (isEditingExisting && memberId === id) return false;
            return memberId === id
                || (member.Previous_Student_IDs || []).some(previous => normalizeStudentId(previous) === id);
        });
        if (conflict) {
            this.showNotification('此學號已被其他成員使用或列為曾用學號。', 'error');
            return;
        }
        
        const payload = {};
        document.querySelectorAll('#member-modal input, #member-modal select').forEach(el => {
            if (el.closest('#member-id-migration') || el.id === 'Bind_Status') return;
            let val = el.value.trim();
            if (el.id === 'Email' || el.id === 'Student_ID') val = val.toLowerCase();
            payload[el.id] = val;
        });
        payload['Student_ID'] = id;

        const btn = document.getElementById('btn-save-m');
        btn.innerText = "儲存中...";
        btn.disabled = true;

        try {
            await setDoc(doc(db, "members", payload.Student_ID), payload, { merge: true });
            this.closeModal('member-modal');
        } catch (e) {
            this.showNotification("發生錯誤：" + e.message, 'error');
        } finally {
            btn.innerText = "儲存";
            btn.disabled = false;
        }
    },

    // === 離校日期 ↔ 狀態 自動連動 ===
    setupAutoStatus: function() {
        const leaveInput = document.getElementById('Leave_Date');
        const statusSelect = document.getElementById('Status');
        if(!leaveInput || !statusSelect) return;
        
        leaveInput.addEventListener('change', function() {
            if (this.value) statusSelect.value = 'Alumni';
        });
        statusSelect.addEventListener('change', function() {
            if (this.value === 'Active') leaveInput.value = '';
        });
    }
};
