/** School-owned fields only. Local locations, notes and checks are never overwritten. */
export function parseInventoryRows(rows, existingItems = []) {
    const existing = new Map(existingItems.map(item => [item.Property_ID, item]));
    const seen = new Set();
    return rows.filter(row => row['財物編號'] || row['校號']).map((row, index) => {
        if (!row['財物編號'] || !row['校號']) throw new Error(`第 ${index + 1} 筆缺少財物編號或校號。`);
        const value = key => String(row[key] ?? '').trim();
        const id = `${value('財物編號')}-${value('校號')}-${value('附件') || '00'}`;
        if (!/^[A-Za-z0-9_.-]+$/.test(id) || seen.has(id)) throw new Error(`財產編號重複或格式錯誤：${id}`);
        seen.add(id);
        const price = Number(value('單價').replaceAll(',', '') || 0);
        if (!Number.isFinite(price) || price < 0) throw new Error(`單價不正確：${id}`);
        const school = {
            Property_ID: id, Name: value('財物名稱'), Brand: value('廠牌'),
            Model: value('型式') || value('形式'), Price: price,
            Acquire_Date: value('取得日期'), Lifespan: value('年限'), Add_No: value('增加單號'),
            Manager: value('管理人'), Original_Location: value('存置地點'),
            Category: value('分類'), Scrap_Status: value('報銷狀態'), System_Remark: value('保管組備註')
        };
        return { ...school, _isNew: !existing.has(id), _initialLocal: {
            Status: 'Pending', Checked_By: null, Checked_By_Student_ID: null,
            Location: value('實驗區域'), Personal_Remark: value('細項位置')
        } };
    });
}
