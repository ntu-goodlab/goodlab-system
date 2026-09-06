import { doc, runTransaction } from 'firebase/firestore';

/** Each chunk atomically archives and updates its documents. A retry reuses the job ID. */
export async function writeInventoryImportChunk(db, payloads, jobId) {
    if (!jobId || payloads.length > 100) throw new Error('匯入批次格式不正確');
    return runTransaction(db, async tx => {
        const rows = [];
        for (const payload of payloads) {
            const ref = doc(db, 'inventory', payload.Property_ID);
            const archive = doc(db, 'inventory_archive', `${jobId}_${payload.Property_ID}`);
            rows.push({ payload, ref, archive, current: await tx.get(ref), backup: await tx.get(archive) });
        }
        for (const { payload, ref, archive, current, backup } of rows) {
            const { _initialLocal, _isNew, ...school } = payload;
            if (!backup.exists()) tx.set(archive, {
                _Archive_ID: jobId, _Archived_At: new Date().toISOString(),
                Property_ID: payload.Property_ID, existed: current.exists(),
                before: current.exists() ? current.data() : null
            });
            if (current.exists()) tx.update(ref, school);
            else tx.set(ref, { ...school, ..._initialLocal });
        }
    });
}
