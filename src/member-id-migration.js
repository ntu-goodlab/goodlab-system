const MEMBER_REFERENCE_DEFINITIONS = [
    {
        dataKey: 'instruments',
        collection: 'instruments',
        label: '儀器管理者',
        idFields: ['Instrument_ID'],
        referenceFields: ['Manager_ID']
    },
    {
        dataKey: 'logs',
        collection: 'logs',
        label: '維修紀錄',
        idFields: ['Log_ID', 'id'],
        referenceFields: ['Owner_ID', 'Reporter_ID', 'Reporter']
    },
    {
        dataKey: 'accounting',
        collection: 'accounting',
        label: '帳務紀錄',
        idFields: ['Txn_ID'],
        referenceFields: ['Payer']
    },
    {
        dataKey: 'duty_records',
        collection: 'duty_records',
        label: '值日紀錄',
        idFields: ['_id', 'week_start'],
        referenceFields: ['scheduled_to', 'assigned_to', 'substitute_pending', 'substitute_from']
    },
    {
        dataKey: 'employments',
        collection: 'employments',
        label: '聘僱紀錄',
        idFields: ['_id'],
        referenceFields: ['student_id'],
        preserveOriginalStudentId: true
    },
    {
        dataKey: 'bulletins',
        collection: 'bulletins',
        label: '公告更新紀錄',
        idFields: ['_id'],
        referenceFields: ['updated_by']
    }
];

const STUDENT_ID_PATTERN = /^[a-z][a-z0-9]{5,19}$/;

export function normalizeStudentId(value) {
    return String(value ?? '').trim().toLowerCase();
}

function sameStudentId(value, targetId) {
    return Boolean(value) && normalizeStudentId(value) === normalizeStudentId(targetId);
}

function firstRecordId(record, fields) {
    for (const field of fields) {
        if (record?.[field]) return String(record[field]);
    }
    return '';
}

export function validateMemberIdMigration(members, oldId, newId, email = '') {
    const sourceId = normalizeStudentId(oldId);
    const targetId = normalizeStudentId(newId);
    const records = Array.isArray(members) ? members : [];
    const errors = [];

    if (!records.some(member => sameStudentId(member?.Student_ID, sourceId))) {
        errors.push('找不到原學號的成員資料。');
    }
    if (!targetId) {
        errors.push('請輸入新學號。');
    } else if (!STUDENT_ID_PATTERN.test(targetId)) {
        errors.push('新學號須以英文字母開頭，並只包含英文字母與數字。');
    } else if (targetId === sourceId) {
        errors.push('新學號不可與原學號相同。');
    }

    const conflictingMember = records.find(member => {
        if (sameStudentId(member?.Student_ID, sourceId)) return false;
        if (sameStudentId(member?.Student_ID, targetId)) return true;
        return (member?.Previous_Student_IDs || []).some(id => sameStudentId(id, targetId));
    });
    if (conflictingMember) {
        errors.push(`新學號已被 ${conflictingMember.Name_Ch || conflictingMember.Student_ID} 使用或列為曾用學號。`);
    }

    const normalizedEmail = String(email || '').trim();
    if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        errors.push('新電子信箱格式不正確。');
    }

    return {
        valid: errors.length === 0,
        errors,
        oldId: sourceId,
        newId: targetId
    };
}

export function createMemberIdMigrationPlan(data, oldId, newId) {
    const sourceId = normalizeStudentId(oldId);
    const targetId = normalizeStudentId(newId);
    const operations = [];
    const groups = [];
    const issues = [];

    MEMBER_REFERENCE_DEFINITIONS.forEach(definition => {
        const records = Array.isArray(data?.[definition.dataKey]) ? data[definition.dataKey] : [];
        let count = 0;

        records.forEach(record => {
            const changes = {};
            definition.referenceFields.forEach(field => {
                if (sameStudentId(record?.[field], sourceId)) changes[field] = targetId;
            });
            if (Object.keys(changes).length === 0) return;

            const documentId = firstRecordId(record, definition.idFields);
            if (!documentId) {
                issues.push(`${definition.label}有一筆資料缺少文件 ID，無法安全轉移。`);
                return;
            }

            if (definition.preserveOriginalStudentId && !record.original_student_id) {
                changes.original_student_id = sourceId;
            }

            operations.push({
                collection: definition.collection,
                documentId,
                changes,
                label: definition.label
            });
            count += 1;
        });

        groups.push({
            collection: definition.collection,
            label: definition.label,
            count
        });
    });

    return {
        oldId: sourceId,
        newId: targetId,
        operations,
        groups,
        issues,
        affectedDocuments: operations.length,
        totalWrites: operations.length + 2
    };
}

export function buildMigratedMember(sourceMember, options) {
    const oldId = normalizeStudentId(sourceMember?.Student_ID);
    const newId = normalizeStudentId(options?.newId);
    const previousIds = [
        ...(Array.isArray(sourceMember?.Previous_Student_IDs) ? sourceMember.Previous_Student_IDs : []),
        oldId
    ]
        .map(normalizeStudentId)
        .filter(id => id && id !== newId);
    const uniquePreviousIds = [...new Set(previousIds)];
    const history = Array.isArray(sourceMember?.Student_ID_History)
        ? [...sourceMember.Student_ID_History]
        : [];
    const previousGoogleUids = Array.isArray(sourceMember?.Previous_Google_UIDs)
        ? [...sourceMember.Previous_Google_UIDs]
        : [];
    if (!options.preserveGoogleBinding && sourceMember?.Google_UID) {
        previousGoogleUids.push(sourceMember.Google_UID);
    }
    const previousGoogleEmails = Array.isArray(sourceMember?.Previous_Google_Emails)
        ? [...sourceMember.Previous_Google_Emails]
        : [];
    if (!options.preserveGoogleBinding && sourceMember?.Google_Email) {
        previousGoogleEmails.push(sourceMember.Google_Email);
    }
    const previousGoogleDisplayNames = Array.isArray(sourceMember?.Previous_Google_Display_Names)
        ? [...sourceMember.Previous_Google_Display_Names]
        : [];
    if (!options.preserveGoogleBinding && sourceMember?.Google_Display_Name) {
        previousGoogleDisplayNames.push(sourceMember.Google_Display_Name);
    }

    history.push({
        from: oldId,
        to: newId,
        changed_at: options.changedAt,
        changed_by: options.changedBy || ''
    });

    const migrated = {
        ...sourceMember,
        Student_ID: newId,
        Email: String(options.newEmail || sourceMember?.Email || '').trim().toLowerCase(),
        Degree: options.newDegree || sourceMember?.Degree || '',
        Enrollment_Date: options.newEnrollmentDate || sourceMember?.Enrollment_Date || '',
        Status: 'Active',
        Leave_Date: '',
        Google_UID: options.preserveGoogleBinding ? (sourceMember?.Google_UID || null) : null,
        Google_Email: options.preserveGoogleBinding ? (sourceMember?.Google_Email || null) : null,
        Google_Display_Name: options.preserveGoogleBinding ? (sourceMember?.Google_Display_Name || null) : null,
        Previous_Google_UIDs: [...new Set(previousGoogleUids.filter(Boolean))],
        Previous_Google_Emails: [...new Set(previousGoogleEmails.filter(Boolean))],
        Previous_Google_Display_Names: [...new Set(previousGoogleDisplayNames.filter(Boolean))],
        Previous_Student_IDs: uniquePreviousIds,
        Student_ID_History: history,
        Student_ID_Changed_At: options.changedAt,
        Student_ID_Changed_By: options.changedBy || ''
    };

    delete migrated.Bind_Status;
    return migrated;
}
