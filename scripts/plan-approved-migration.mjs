import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { planApprovedMigration } from '../src/approved-migration-plan.js';
const [input, output, ...extra] = process.argv.slice(2);
if (!input || !output || extra.length || resolve(input) === resolve(output)) {
    throw new Error('Usage: node scripts/plan-approved-migration.mjs INPUT.json NEW-REPORT.json');
}
const report = planApprovedMigration(JSON.parse(await readFile(input, 'utf8')));
await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(`唯讀分析完成：${report.rows.length} 位成員；${report.confirmed.length} 位已明確確認。未連線或修改 Firebase。`);
