import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';

// Explicit setup only; the test runner itself never downloads or contacts production.
const filename = 'cloud-firestore-emulator-v1.22.0.jar';
const sha256 = '9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c';
const directory = new URL('../.local-tools/', import.meta.url);
const destination = new URL(filename, directory);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(directory, { recursive: true });
let existing;
try { existing = await readFile(destination); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
if (existing) {
    if (digest(existing) !== sha256) throw new Error('現有模擬器校驗失敗，未執行或覆寫檔案。');
    console.log('Firestore emulator checksum verified (cached).');
} else {
    const response = await fetch(`https://storage.googleapis.com/firebase-preview-drop/emulator/${filename}`, {
        signal: AbortSignal.timeout(120000)
    });
    if (!response.ok) throw new Error(`模擬器下載失敗 (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== sha256) throw new Error('下載檔案校驗失敗，未儲存或執行。');
    const temporary = new URL(`${filename}.${process.pid}.tmp`, directory);
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, destination);
    console.log('Firestore emulator downloaded and checksum verified.');
}
