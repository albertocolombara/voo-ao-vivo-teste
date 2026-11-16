// Simula 24 h de coletas (144 execuções de scripts/run.mjs) com o adsb.lol falso.
// Uso: npm test   → gera test/out/public/index.html para conferir o painel.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
fs.rmSync(out, { recursive: true, force: true });
const T0 = Date.UTC(2026, 10, 16, 3, 0);
let last = '';
for (let i = 0; i < 144; i++) {
  last = execFileSync(
    process.execPath,
    ['--no-warnings', '--import', path.join(here, 'fake-api.mjs'), path.join(here, '..', 'scripts', 'run.mjs')],
    { env: { ...process.env, NOW: String(T0 + i * 600000), DATA_DIR: path.join(out, 'data'), OUT_DIR: path.join(out, 'public'), ADSBLOL_KEY: 'teste', GITHUB_OUTPUT: '' } }
  ).toString();
  if (i % 36 === 0) console.log(`coleta ${i + 1}/144\n${last}`);
}
console.log(last);
const stats = JSON.parse(fs.readFileSync(path.join(out, 'public', 'stats.json'), 'utf8'));
console.log('coletas', stats.quota.runs, '· chamadas por dia', stats.quota.meteredPerDay, '· recusas', stats.quota.quotaHits);
console.log('pouso', { ...stats.landing, worst: undefined });
console.log('arquivos de dados', fs.readdirSync(path.join(out, 'data')).map((f) => `${f} ${fs.statSync(path.join(out, 'data', f)).size} B`));
