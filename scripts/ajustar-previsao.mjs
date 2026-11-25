// Aprende o ajuste da previsão de pouso (v5) com os pousos registrados em data/*.ndjson e grava
// src/ajuste-previsao.json. Também confere: ajusta com a metade mais antiga dos pousos e mede o erro
// na metade mais nova, antes de gravar o ajuste final com todos.
//
//   node scripts/ajustar-previsao.mjs            confere e grava
//   node scripts/ajustar-previsao.mjs --conferir só confere
import fs from 'node:fs';
import { etaBase, LIMITE_LONGO_KM } from '../src/previsao.mjs';

const K = 5; // peso da "dúvida": com n pousos, o ajuste vale n/(n+K) do medido
const MINIMO = 5; // pousos mínimos para um destino ou rota ter ajuste
const LIMITE_MIN = 20; // ajuste máximo, em minutos, até 2.500 km
const FATOR = [0.85, 1.25];

const pousos = [];
for (const f of fs.readdirSync('data').filter((n) => n.endsWith('.ndjson')).sort()) {
  for (const linha of fs.readFileSync(`data/${f}`, 'utf8').split('\n')) {
    if (!linha.trim()) continue;
    const r = JSON.parse(linha);
    if (r.k !== 'watch' || r.status !== 'landed' || !r.first_gs || !r.first_rem_km || !r.dest || !r.actual_land) continue;
    const real = (r.actual_land - r.first_ts) / 60000;
    const base = etaBase(r.first_rem_km, r.first_gs, r.first_alt);
    pousos.push({ ts: r.first_ts, orig: r.orig, dest: r.dest, rem: r.first_rem_km, real, base });
  }
}
pousos.sort((a, b) => a.ts - b.ts);

const mediana = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const encolher = (medido, n) => (medido * n) / (n + K);
const limitar = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const redondo = (x, casas) => Math.round(x * 10 ** casas) / 10 ** casas;

function aprender(lista) {
  const curto = {};
  const longoRota = {};
  const longoDestino = {};
  const grupos = (filtro, chave, valor) => {
    const g = new Map();
    for (const p of lista.filter(filtro)) g.set(chave(p), [...(g.get(chave(p)) ?? []), valor(p)]);
    return [...g].filter(([, v]) => v.length >= MINIMO);
  };
  const ehCurto = (p) => p.rem <= LIMITE_LONGO_KM;
  for (const [d, v] of grupos(ehCurto, (p) => p.dest, (p) => p.real - p.base))
    curto[d] = redondo(limitar(encolher(mediana(v), v.length), -LIMITE_MIN, LIMITE_MIN), 1);
  for (const [r, v] of grupos((p) => !ehCurto(p), (p) => `${p.orig}-${p.dest}`, (p) => p.real / p.base))
    longoRota[r] = redondo(limitar(1 + encolher(mediana(v) - 1, v.length), ...FATOR), 3);
  for (const [d, v] of grupos((p) => !ehCurto(p), (p) => p.dest, (p) => p.real / p.base))
    longoDestino[d] = redondo(limitar(1 + encolher(mediana(v) - 1, v.length), ...FATOR), 3);
  return { curto, longoRota, longoDestino };
}

function prever(p, a) {
  if (p.rem <= LIMITE_LONGO_KM) return Math.max(1, p.base + (a.curto[p.dest] ?? 0));
  return p.base * (a.longoRota[`${p.orig}-${p.dest}`] ?? a.longoDestino[p.dest] ?? 1);
}

function erro(lista, a) {
  const e = lista.map((p) => p.real - prever(p, a));
  const abs = e.map(Math.abs).sort((x, y) => x - y);
  return { n: e.length, tipico: redondo(mediana(abs), 1), vies: redondo(mediana(e), 1), p90: redondo(abs[Math.floor(0.9 * (abs.length - 1))], 1) };
}

const metade = pousos.length >> 1;
const treino = pousos.slice(0, metade);
const teste = pousos.slice(metade);
const aTreino = aprender(treino);
const sem = { curto: {}, longoRota: {}, longoDestino: {} };
for (const [nome, f] of [
  ['até 2.500 km', (p) => p.rem <= LIMITE_LONGO_KM],
  ['acima de 2.500 km', (p) => p.rem > LIMITE_LONGO_KM],
]) {
  const t = teste.filter(f);
  console.log(`${nome}: sem ajuste`, erro(t, sem), '| com ajuste', erro(t, aTreino));
}

if (!process.argv.includes('--conferir')) {
  const final = aprender(pousos);
  const saida = { gerado: new Date().toISOString(), pousos: pousos.length, ...final };
  fs.writeFileSync(new URL('../src/ajuste-previsao.json', import.meta.url), JSON.stringify(saida, null, 1) + '\n');
  console.log(`ajuste gravado: ${Object.keys(final.curto).length} destinos (curtos), ${Object.keys(final.longoRota).length} rotas e ${Object.keys(final.longoDestino).length} destinos (longos)`);
}
