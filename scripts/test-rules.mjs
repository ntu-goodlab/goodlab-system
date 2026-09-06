import { spawn } from 'node:child_process';
import { existsSync, readdirSync, createWriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This runner never invokes Firebase CLI, loads .env, or uses a real project.
const root = fileURLToPath(new URL('../', import.meta.url));
const project = 'demo-goodlab-security';
const port = 8085;
const host = `127.0.0.1:${port}`;
const local = resolve(root, '.local-tools');
const jar = resolve(local, 'cloud-firestore-emulator-v1.22.0.jar');
if (!existsSync(jar)) throw new Error('缺少本地 Firestore emulator；請依 docs/LOCAL_VALIDATION.md 準備，禁止回落正式環境。');
const portable = readdirSync(local).find(name => name.startsWith('jdk-21') && existsSync(resolve(local, name, 'bin/java.exe')));
const java = portable ? resolve(local, portable, 'bin/java.exe') : 'java';
await new Promise((resolveReady, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`${host} 已使用，停止以避免接觸不明測試服務。`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolveReady));
});
const log = createWriteStream(resolve(local, 'firestore-test.log'));
const emulator = spawn(java, ['-Duser.language=en', '-Duser.country=US', '-jar', jar, '--host', '127.0.0.1', '--port', String(port),
    '--project_id', project, '--single_project_mode', 'true', '--rules', resolve(root, 'firestore.rules')], {
    cwd: local, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
});
let ready = false;
let startupError;
emulator.on('error', error => { startupError = error; });
for (const stream of [emulator.stdout, emulator.stderr]) stream.on('data', chunk => {
    log.write(chunk);
    if (chunk.toString().includes('Dev App Server is now running')) ready = true;
});
try {
    for (let attempt = 0; !ready && attempt < 150; attempt++) {
        if (startupError) throw startupError;
        if (emulator.exitCode !== null) throw new Error('模擬器啟動失敗，請查看 .local-tools/firestore-test.log');
        await new Promise(done => setTimeout(done, 200));
    }
    if (!ready) throw new Error('模擬器未就緒，沒有執行測試。');
    const env = { ...process.env, FIRESTORE_EMULATOR_HOST: host, GCLOUD_PROJECT: project,
        GOOGLE_CLOUD_PROJECT: project, GOODLAB_RULES_TEST: 'local-only' };
    delete env.GOOGLE_APPLICATION_CREDENTIALS;
    delete env.FIREBASE_CONFIG;
    delete env.FIREBASE_TOKEN;
    console.log(`權限測試只使用 ${project} @ ${host}`);
    process.exitCode = await new Promise((done, reject) => {
        const child = spawn(process.execPath, ['--test', 'tests/security.rules.mjs'], {
            cwd: root, env, windowsHide: true, stdio: 'inherit'
        });
        child.on('error', reject);
        child.on('exit', code => done(code ?? 1));
    });
} finally {
    emulator.kill();
    log.end();
}
