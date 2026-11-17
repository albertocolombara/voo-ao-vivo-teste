// Uma coleta. Roda no GitHub Actions a cada 10 min (ou no seu computador: node scripts/run.mjs).
// 1. carrega o histórico de data/ num SQLite em memória
// 2. faz a coleta (src/index.js)
// 3. acrescenta as linhas novas em data/AAAA-MM-DD.ndjson e regrava data/watch-active.json
// 4. uma vez por hora, gera o painel em public/ para o GitHub Pages
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';
import { collect, computeStats, renderStats, flightsResponse } from '../src/index.js';
import { createVrsRoutes } from '../src/routes-vrs.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(root, 'data');
const OUT = process.env.OUT_DIR || path.join(root, 'public');
const ACTIVE = path.join(DATA, 'watch-active.json');
const STATE = path.join(DATA, 'state.json');
const LITE = path.join(DATA, 'snapshots-lite.json'); // última foto de cada região: [hex, tempo até o pouso]
const PUBLISH_EVERY_MS = 55 * 60000;
const now = Number(process.env.NOW || Date.now());

fs.mkdirSync(DATA, { recursive: true });
const { DB, insert, all } = openDb(path.join(root, 'schema.sql'));

// 1. histórico
const finished = new Set();
for (const f of fs.readdirSync(DATA).filter((f) => f.endsWith('.ndjson')).sort()) {
  for (const line of fs.readFileSync(path.join(DATA, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const { k, ...row } = JSON.parse(line);
    if (k === 'run') insert('runs', row);
    else if (k === 'ps') insert('point_stats', row);
    else if (k === 'watch') {
      insert('watch', row);
      finished.add(`${row.hex}|${row.first_ts}`);
    }
  }
}
if (fs.existsSync(ACTIVE)) for (const row of JSON.parse(fs.readFileSync(ACTIVE, 'utf8'))) insert('watch', row);
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const maxRun = all('SELECT COALESCE(MAX(id), 0) AS m FROM runs')[0].m;

// 2. coleta
const env = { DB, ADSBLOL_KEY: process.env.ADSBLOL_KEY || '', snapshotsLite: fs.existsSync(LITE) ? JSON.parse(fs.readFileSync(LITE, 'utf8')) : {} };
// Rotas: base aberta do VRS se a pasta existir (o workflow baixa uma vez por dia); senão, routeset do adsb.lol.
const sdDir = process.env.STANDING_DATA_DIR || path.join(root, 'standing-data');
let vrs = null;
if (fs.existsSync(sdDir)) {
  vrs = createVrsRoutes(sdDir);
  env.routeLookup = vrs.lookup;
}
const result = await collect(env, now);

// 3. grava o que é novo
const lines = [
  ...all('SELECT * FROM runs WHERE id > ?', maxRun).map((r) => ({ k: 'run', ...r })),
  ...all('SELECT * FROM point_stats WHERE run_id > ?', maxRun).map((r) => ({ k: 'ps', ...r })),
  ...all("SELECT * FROM watch WHERE status != 'active'")
    .filter((w) => !finished.has(`${w.hex}|${w.first_ts}`))
    .map((w) => ({ k: 'watch', ...w })),
];
const day = new Date(now - 3 * 3600000).toISOString().slice(0, 10); // dia em Brasília
fs.appendFileSync(path.join(DATA, `${day}.ndjson`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
fs.writeFileSync(LITE, JSON.stringify(env.snapshotsLite));
fs.writeFileSync(ACTIVE, JSON.stringify(all("SELECT * FROM watch WHERE status = 'active'")));

// 4. painel (uma vez por hora, ou sempre com FORCE_PUBLISH=1)
const publish = process.env.FORCE_PUBLISH === '1' || !state.lastPublish || now - state.lastPublish >= PUBLISH_EVERY_MS;
if (publish) {
  fs.mkdirSync(OUT, { recursive: true });
  const stats = await computeStats(env, 14, now);
  fs.writeFileSync(path.join(OUT, 'index.html'), renderStats(stats, { json: 'stats.json', flights: 'flights.json' }));
  fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(stats));
  const flights = await (await flightsResponse(env, new URL('https://local/flights'))).text();
  fs.writeFileSync(path.join(OUT, 'flights.json'), flights);
  state.lastPublish = now;
}
fs.writeFileSync(STATE, JSON.stringify(state));

// resumo no log
const pts = result.rows.map((r) => `${r.point}: ${r.status} ${r.coherent}/${r.airborne}`).join(' · ');
if (vrs) console.log(`rotas: base VRS · ${vrs.stats.asked} indicativos · ${vrs.stats.found} com rota · ${vrs.stats.notAirline} sem formato de companhia · ${vrs.stats.missingAirport} com aeroporto desconhecido`);
else console.log('rotas: routeset do adsb.lol');
if (result.failures?.length) console.log('ERROS:\n' + result.failures.join('\n'));
console.log(`coleta ${result.runId} · rotas ${result.routeCalls} chamadas · erros ${result.errors}\n${pts}\npainel: ${publish ? 'gerado' : 'não'}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
