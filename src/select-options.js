function normalizeId(value) {
    return String(value ?? '').trim();
}

function appendSelectedLegacyItem(items, records, selectedId, getId, getLabel, inactiveLabel) {
    const selected = normalizeId(selectedId);
    if (!selected || items.some(item => item.value === selected)) return items;

    const record = records.find(item => normalizeId(getId(item)) === selected);
    if (record) {
        items.push({
            value: selected,
            label: `${getLabel(record)}${inactiveLabel}`
        });
    } else {
        items.push({
            value: selected,
            label: `${selected}（舊資料）`
        });
    }
    return items;
}

/**
 * 新增資料只列出目前在學成員；編輯舊資料時，保留該筆資料原本綁定的成員。
 */
export function buildMemberSelectItems(members, selectedId = '', { showStudentId = true } = {}) {
    const records = Array.isArray(members) ? members : [];
    const getId = member => member?.Student_ID;
    const getLabel = member => {
        const id = normalizeId(member?.Student_ID);
        const name = normalizeId(member?.Name_Ch) || id;
        return showStudentId && id ? `${name} (${id})` : name;
    };

    const items = records
        .filter(member => member?.Status === 'Active' && normalizeId(getId(member)))
        .map(member => ({
            value: normalizeId(getId(member)),
            label: getLabel(member)
        }));

    return appendSelectedLegacyItem(
        items,
        records,
        selectedId,
        getId,
        getLabel,
        '（已離校）'
    );
}

export function buildPayerSelectItems(members, selectedId = '') {
    const selectedMemberId = normalizeId(selectedId) === 'Fund' ? '' : selectedId;
    return [
        { value: 'Fund', label: '公積金戶頭 (Fund)' },
        ...buildMemberSelectItems(members, selectedMemberId, { showStudentId: false })
    ];
}

/**
 * 新增維修紀錄只列出指定區域仍在使用的儀器；編輯舊紀錄時保留原儀器。
 */
export function buildInstrumentSelectItems(instruments, location = '', selectedId = '') {
    const records = Array.isArray(instruments) ? instruments : [];
    const normalizedLocation = normalizeId(location);
    const getId = instrument => instrument?.Instrument_ID;
    const getLabel = instrument => normalizeId(instrument?.Name) || normalizeId(getId(instrument));

    const items = records
        .filter(instrument =>
            instrument?.Is_Active === true
            && normalizeId(instrument?.Location) === normalizedLocation
            && normalizeId(getId(instrument))
        )
        .map(instrument => ({
            value: normalizeId(getId(instrument)),
            label: getLabel(instrument)
        }));

    return appendSelectedLegacyItem(
        items,
        records,
        selectedId,
        getId,
        getLabel,
        '（已停用）'
    );
}
