// Teste de voos ao vivo (adsb.lol): lógica de coleta, medição e painel.
// - collect(): consulta regiões, cruza com rotas, filtra rotas incoerentes,
//   calcula quando cada voo pousa e grava as medições no banco.
// - flightsResponse(): a lista de voos pronta, do jeito que o app consumiria.
// - computeStats() + renderStats(): o painel com os números da validação.
// O banco segue a interface do Cloudflare D1 (prepare/bind/first/all/run, batch);
// scripts/run.mjs a implementa com o SQLite que já vem no Node.

const API = 'https://api.adsb.lol';
const RADIUS_NM = 250;
const SPACING_MS = 2500; // pausa entre chamadas que contam na cota (evita 429)

// Modo mundial: regiões espalhadas pelos fusos horários, consultadas em rodízio a cada execução (10 min).
// Sem chave (500 chamadas/dia): 9 regiões, 3 por execução -> cada região a cada 30 min, 432/dia.
// Com chave (1.000/dia, 300/h): 12 regiões, 6 por execução -> cada região a cada 20 min, 864/dia (36/h).
const WORLD_POINTS = [
  { id: 'Londres-Paris', lat: 50.5, lon: 0.5 },
  { id: 'Nova York', lat: 40.6, lon: -73.8 },
  { id: 'Tóquio', lat: 35.6, lon: 139.8 },
  { id: 'Frankfurt', lat: 50.0, lon: 8.6 },
  { id: 'Los Angeles', lat: 34.0, lon: -118.4 },
  { id: 'Sydney', lat: -33.9, lon: 151.2 },
  { id: 'Dubai', lat: 25.2, lon: 55.4 },
  { id: 'Chicago', lat: 41.9, lon: -87.9 },
  { id: 'São Paulo', lat: -23.0, lon: -46.0 },
  // só com chave
  { id: 'Istambul', lat: 41.0, lon: 28.9 },
  { id: 'Singapura', lat: 1.4, lon: 103.9 },
  { id: 'Dallas-Atlanta', lat: 33.3, lon: -90.5 },
];
const plan = (env) =>
  env.ADSBLOL_KEY ? { points: WORLD_POINTS, groups: 2 } : { points: WORLD_POINTS.slice(0, 9), groups: 3 };
const MUNDO = 'MUNDO';
const FRESH_MS = 40 * 60000; // fotos de região com até 40 min entram na soma mundial
const RADIUS_KM = RADIUS_NM * 1.852;

const BUCKETS = [
  ['b25', 25, 50],
  ['b50', 50, 90],
  ['b90', 90, 180],
  ['b180', 180, 360],
  ['b360', 360, Infinity],
];
const WATCH_SHORT_PER_RUN = 3; // voos com pouso em menos de 90 min
const WATCH_LONG_PER_RUN = 5; // voos de 90 min ou mais (o que ainda falta medir)
const WATCH_MAX_ACTIVE = 500; // inclui os da versão 1 ainda no ar
const WATCH_DEST_KM = 400; // só acompanha voos cujo destino fica dentro de uma das 9 regiões
const LANDED_WINDOW_MS = 45 * 60000; // visto perto do destino há até 45 min e sumiu = pousou
const ATTRIBUTION = 'Dados de voo: adsb.lol (ODbL 1.0) · Rotas: Virtual Radar Server Standing Data (CC0 1.0)';
const UA = 'voo-ao-vivo-teste/0.1 (+https://github.com/albertocolombara/voo-ao-vivo-teste)';

// ---------- geometria ----------
const R_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;
function distKm(aLat, aLon, bLat, bLon) {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(aLat, aLon, bLat, bLon) {
  const y = Math.sin(rad(bLon - aLon)) * Math.cos(rad(bLat));
  const x = Math.cos(rad(aLat)) * Math.sin(rad(bLat)) - Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(rad(bLon - aLon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// ---------- dados ----------
function airborne(ac) {
  const cs = (ac.flight || '').trim();
  return (
    cs.length >= 3 &&
    typeof ac.lat === 'number' &&
    typeof ac.lon === 'number' &&
    typeof ac.alt_baro === 'number' &&
    ac.alt_baro >= 1000 &&
    typeof ac.gs === 'number' &&
    ac.gs >= 80
  );
}

// Escolhe o trecho da rota que bate com a posição do avião e aplica o filtro de coerência.
// Descarta se o desvio passa de 25% ou se o rumo difere 70° ou mais do destino.
function matchLeg(route, ac) {
  const aps = Array.isArray(route?._airports) ? route._airports : [];
  let best = null;
  for (let i = 0; i + 1 < aps.length; i++) {
    const o = aps[i];
    const d = aps[i + 1];
    if (![o.lat, o.lon, d.lat, d.lon].every((v) => typeof v === 'number')) continue;
    const od = distKm(o.lat, o.lon, d.lat, d.lon);
    if (od < 50) continue;
    const op = distKm(o.lat, o.lon, ac.lat, ac.lon);
    const pd = distKm(ac.lat, ac.lon, d.lat, d.lon);
    const ratio = (op + pd) / od;
    if (!best || ratio < best.ratio) best = { o, d, ratio, pd };
  }
  if (!best) return { routed: aps.length >= 2, leg: null };
  const track = typeof ac.track === 'number' ? ac.track : typeof ac.true_heading === 'number' ? ac.true_heading : null;
  const okRatio = best.ratio < 1.25;
  const okHeading = track === null ? true : angleDiff(bearing(ac.lat, ac.lon, best.d.lat, best.d.lon), track) < 70;
  return { routed: true, leg: okRatio && okHeading ? best : null };
}

// Previsão de pouso (versão 3).
// v1: só a velocidade atual. Logo após a decolagem o avião ainda está subindo e lento,
//     e voos longos saíam muito maiores que o real (6 h+: erro típico de ~56 min).
// v2: longe do destino e fora de cruzeiro, usa velocidade de cruzeiro típica (470 kt).
//     6 h+ caiu para ~37 min; até 1h30 ficou ~3-4 min.
// v3: para mais de 2.500 km restantes, parâmetros ajustados em 896 pousos reais
//     (metade para ajustar, metade para conferir): em cruzeiro, média entre a velocidade atual
//     e 440 kt (amortece ventos de cauda fortes); fora de cruzeiro, no mínimo 440 kt.
//     No teste, 6 h+ caiu de ~32 para ~24 min. Até 2.500 km, segue igual à v2.
const ETA_VERSION = 3;
function etaMin(remKm, gs, alt) {
  const cruising = typeof alt === 'number' && alt >= 25000 && gs >= 380;
  if (remKm > 2500) {
    const speed = cruising ? 0.5 * gs + 0.5 * 440 : Math.max(gs, 440);
    return ((0.98 * remKm) / (speed * 1.852)) * 60 + 5;
  }
  let speed = gs;
  if (remKm > 300 && !cruising) speed = Math.max(gs, 470);
  return (remKm / (speed * 1.852)) * 60 + 8;
}const bucketOf = (eta) => (BUCKETS.find(([, lo, hi]) => eta >= lo && eta < hi) || [null])[0];

function toFlight(ac, route, leg) {
  const eta = etaMin(leg.pd, ac.gs, ac.alt_baro);
  return {
    hex: ac.hex,
    cs: ac.flight.trim(),
    airline: route.airline_code || null,
    type: ac.t || null,
    lat: ac.lat,
    lon: ac.lon,
    alt: ac.alt_baro,
    gs: ac.gs,
    track: ac.track ?? null,
    o: { iata: leg.o.iata || null, icao: leg.o.icao || null, name: leg.o.name || null, lat: leg.o.lat, lon: leg.o.lon },
    d: { iata: leg.d.iata || null, icao: leg.d.icao || null, name: leg.d.name || null, lat: leg.d.lat, lon: leg.d.lon },
    remKm: Math.round(leg.pd),
    eta: Math.round(eta),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPoint(env, p) {
  const t0 = Date.now();
  const headers = { accept: 'application/json', 'user-agent': UA };
  if (env.ADSBLOL_KEY) headers['x-api-key'] = env.ADSBLOL_KEY;
  try {
    const res = await fetch(`${API}/v2/point/${p.lat}/${p.lon}/${RADIUS_NM}`, { headers });
    const ms = Date.now() - t0;
    if (res.status === 429) return { status: 'quota', http: 429, ms, ac: [] };
    if (!res.ok) return { status: 'error', http: res.status, ms, ac: [] };
    const body = await res.json();
    return { status: 'ok', http: res.status, ms, ac: Array.isArray(body.ac) ? body.ac : [] };
  } catch (e) {
    return { status: 'error', http: null, ms: Date.now() - t0, ac: [] };
  }
}

// Rotas. Se env.routeLookup existir (base aberta do VRS), usa a base local, sem chamadas.
// Senão, usa o routeset do adsb.lol em lotes. Devolve Map(callsign -> rota), chamadas feitas e erros.
async function fetchRoutes(planes, env = {}) {
  const routes = new Map();
  if (typeof env.routeLookup === 'function') {
    for (const p of planes) {
      const r = env.routeLookup(p.callsign);
      if (r) routes.set(p.callsign, r);
    }
    return { routes, calls: 0, errors: 0, failures: [] };
  }
  let calls = 0;
  const failures = [];
  for (let i = 0; i < planes.length; i += 100) {
    const chunk = planes.slice(i, i + 100);
    calls++;
    try {
      const res = await fetch(`${API}/api/0/routeset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
        body: JSON.stringify({ planes: chunk }),
      });
      const text = await res.text();
      if (!res.ok) {
        failures.push(`routeset HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
        continue;
      }
      const list = JSON.parse(text);
      for (const r of Array.isArray(list) ? list : []) if (r?.callsign) routes.set(r.callsign.trim(), r);
    } catch (e) {
      failures.push(`routeset falhou: ${e?.message || e}${e?.cause ? ' (' + (e.cause.code || e.cause.message || e.cause) + ')' : ''}`);
    }
  }
  return { routes, calls, errors: failures.length, failures };
}

function emptyStats() {
  return { seen: 0, airborne: 0, routed: 0, coherent: 0, b25: 0, b50: 0, b90: 0, b180: 0, b360: 0 };
}

// ---------- coleta (cron) ----------
export async function collect(env, now = Date.now()) {
  const t0 = Date.now();
  const { points: all, groups } = plan(env);
  const slot = Math.floor(now / 600000) % groups;
  const points = all.filter((_, i) => i % groups === slot);

  // 1. aviões por região (chamadas que contam na cota)
  const raw = [];
  let errors = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) await sleep(SPACING_MS);
    const r = await fetchPoint(env, points[i]);
    if (r.status !== 'ok') errors++;
    raw.push({ point: points[i], ...r, air: r.ac.filter(airborne) });
    if (r.status === 'quota') break; // recusas repetidas podem revogar a chave: para e tenta na próxima execução
  }

  // 2. rotas, sem repetir indicativo
  const seenCs = new Map();
  for (const r of raw) for (const a of r.air) if (!seenCs.has(a.flight.trim())) seenCs.set(a.flight.trim(), { callsign: a.flight.trim(), lat: a.lat, lng: a.lon });
  const { routes, calls: routeCalls, errors: routeErrors, failures } = await fetchRoutes([...seenCs.values()], env);
  errors += routeErrors;

  // 3. estatísticas por região
  const rows = [];
  const snapshots = [];
  const airMap = new Map(); // hex -> aeronave no ar nesta execução
  const flightsByPoint = new Map(); // região -> voos coerentes
  for (const r of raw) {
    const s = emptyStats();
    s.seen = r.ac.length;
    const flights = [];
    for (const a of r.air) {
      s.airborne++;
      airMap.set(a.hex, a);
      const route = routes.get(a.flight.trim());
      const { routed, leg } = route ? matchLeg(route, a) : { routed: false, leg: null };
      if (routed) s.routed++;
      const f = leg ? toFlight(a, route, leg) : null;
      if (f) {
        s.coherent++;
        const b = bucketOf(f.eta);
        if (b) s[b]++;
        flights.push(f);
      }
    }
    rows.push({ point: r.point.id, status: r.status, http: r.http, ms: r.ms, ...s });
    if (r.status === 'ok') {
      snapshots.push({ point: r.point.id, json: JSON.stringify(flights) });
      flightsByPoint.set(r.point.id, flights);
    }
  }

  // 4. soma mundial: última foto de cada região (até 40 min), sem repetir avião,
  //    com o tempo de pouso descontado pela idade da foto
  if (env.snapshotsLite) {
    for (const [id, flights] of flightsByPoint) env.snapshotsLite[id] = { ts: now, f: flights.map((f) => [f.hex, f.eta]) };
    const best = new Map();
    let fresh = 0;
    for (const [, snap] of Object.entries(env.snapshotsLite)) {
      if (now - snap.ts > FRESH_MS) continue;
      fresh++;
      for (const [hex, eta] of snap.f) {
        const etaNow = eta - (now - snap.ts) / 60000;
        if (etaNow < 5) continue;
        const prev = best.get(hex);
        if (!prev || prev.ts < snap.ts) best.set(hex, { ts: snap.ts, eta: etaNow });
      }
    }
    const m = emptyStats();
    m.seen = fresh; // quantas regiões entraram na soma
    for (const { eta } of best.values()) {
      m.coherent++;
      const b = bucketOf(eta);
      if (b) m[b]++;
    }
    rows.push({ point: MUNDO, status: fresh ? 'ok' : 'error', http: null, ms: null, ...m });
  }

  // 5. grava
  const runId = await env.DB.prepare(
    'INSERT INTO runs (ts, metered_calls, route_calls, errors, ms) VALUES (?, ?, ?, ?, ?) RETURNING id'
  )
    .bind(now, points.length, routeCalls, errors, Date.now() - t0)
    .first('id');

  const stmts = rows.map((s) =>
    env.DB.prepare(
      'INSERT INTO point_stats (run_id, ts, point, status, http, ms, seen, airborne, routed, coherent, b25, b50, b90, b180, b360) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(runId, now, s.point, s.status, s.http, s.ms, s.seen, s.airborne, s.routed, s.coherent, s.b25, s.b50, s.b90, s.b180, s.b360)
  );
  for (const s of snapshots)
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO snapshot (point, ts, json) VALUES (?, ?, ?)').bind(s.point, now, s.json));
  await env.DB.batch(stmts);

  // 6. acompanhamento de pouso
  await trackLandings(env, now, new Set(flightsByPoint.keys()), airMap, flightsByPoint);

  return { runId, rows, routeCalls, errors, failures };
}

const destPointOf = (lat, lon) => WORLD_POINTS.find((p) => distKm(p.lat, p.lon, lat, lon) < WATCH_DEST_KM) || null;

// Cada voo acompanhado é atualizado sempre que aparece em qualquer região consultada.
// Quando a região do destino é consultada e ele não aparece mais:
// - se foi visto perto do destino há pouco, pousou (o momento é estimado pela última posição);
// - se nunca chegou perto, espera; passou 90 min do previsto, vira "perdido" (sem cobertura no fim da rota).
async function trackLandings(env, now, queried, airMap, flightsByPoint) {
  const active = (await env.DB.prepare("SELECT * FROM watch WHERE status = 'active'").all()).results || [];
  const stmts = [];
  const watching = new Set();
  const finish = (w, status, actual, err) =>
    stmts.push(env.DB.prepare('UPDATE watch SET status = ?, actual_land = ?, error_min = ? WHERE hex = ? AND first_ts = ?').bind(status, actual, err, w.hex, w.first_ts));

  for (const w of active) {
    const a = airMap.get(w.hex);
    if (a) {
      watching.add(w.hex);
      // primeira vez que aparece depois da metade do tempo previsto: guarda a previsão desse momento,
      // que é a que o usuário veria no meio do voo
      if (!w.mid_ts && now - w.first_ts >= (w.pred_land - w.first_ts) / 2) {
        const remKm = distKm(a.lat, a.lon, w.dest_lat, w.dest_lon);
        stmts.push(
          env.DB.prepare('UPDATE watch SET mid_ts = ?, mid_rem_km = ?, mid_pred_land = ? WHERE hex = ? AND first_ts = ?').bind(
            now, remKm, Math.round(now + etaMin(remKm, a.gs, a.alt_baro) * 60000), w.hex, w.first_ts
          )
        );
      }
      stmts.push(
        env.DB.prepare('UPDATE watch SET last_seen = ?, last_dist_km = ?, last_alt = ?, last_gs = ? WHERE hex = ? AND first_ts = ?').bind(
          now, distKm(a.lat, a.lon, w.dest_lat, w.dest_lon), a.alt_baro, a.gs, w.hex, w.first_ts
        )
      );
      continue;
    }
    if (!w.dest_point) { finish(w, 'lost', null, null); continue; } // acompanhamentos antigos, do modo Brasil
    if (!queried.has(w.dest_point)) {
      if (now > w.pred_land + 180 * 60000) finish(w, 'lost', null, null); else watching.add(w.hex);
      continue;
    }
    // a região do destino foi consultada e o avião não apareceu
    if (w.last_dist_km < RADIUS_KM && now - w.last_seen <= LANDED_WINDOW_MS) {
      const kmPerMin = (Math.max(w.last_gs || 0, 180) * 1.852 * 0.75) / 60;
      const actual = Math.min(now, w.last_seen + (w.last_dist_km / kmPerMin) * 60000);
      finish(w, 'landed', Math.round(actual), (actual - w.pred_land) / 60000);
    } else if (now > w.pred_land + 90 * 60000) {
      finish(w, 'lost', null, null);
    } else {
      watching.add(w.hex); // ainda a caminho, fora da cobertura
    }
  }

  // novos voos: destino dentro de uma das regiões; mais voos longos, que ainda não foram medidos
  let room = WATCH_MAX_ACTIVE - watching.size;
  let shortLeft = WATCH_SHORT_PER_RUN, longLeft = WATCH_LONG_PER_RUN;
  const candidates = [];
  for (const [pointId, flights] of flightsByPoint) for (const f of flights) candidates.push({ pointId, f });
  candidates.sort((x, y) => y.f.eta - x.f.eta);
  for (const { pointId, f } of candidates) {
    if (room <= 0 || (shortLeft <= 0 && longLeft <= 0)) break;
    if (watching.has(f.hex) || f.eta < 25 || f.eta > 900) continue;
    const isLong = f.eta >= 90;
    if (isLong ? longLeft <= 0 : shortLeft <= 0) continue;
    const dp = destPointOf(f.d.lat, f.d.lon);
    if (!dp) continue;
    stmts.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO watch (hex, first_ts, point, dest_point, callsign, orig, dest, dest_lat, dest_lon, eta_min, eta_ver, first_rem_km, first_alt, first_gs, pred_land, last_seen, last_dist_km, last_alt, last_gs, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active')"
      ).bind(f.hex, now, pointId, dp.id, f.cs, f.o.iata || f.o.icao, f.d.iata || f.d.icao, f.d.lat, f.d.lon, f.eta, ETA_VERSION, f.remKm, f.alt, f.gs, now + f.eta * 60000, now, f.remKm, f.alt, f.gs)
    );
    watching.add(f.hex);
    room--;
    if (isLong) longLeft--; else shortLeft--;
  }
  if (stmts.length) await env.DB.batch(stmts);
}

// ---------- API para o app ----------
export async function flightsResponse(env, url) {
  const min = Number(url.searchParams.get('min') || 0);
  const only = url.searchParams.get('point');
  const rows = (await env.DB.prepare('SELECT point, ts, json FROM snapshot').all()).results || [];
  const byHex = new Map();
  const sources = [];
  for (const r of rows) {
    if (only && r.point !== only) continue;
    sources.push({ point: r.point, ts: r.ts, ageMin: Math.round((Date.now() - r.ts) / 60000) });
    for (const f of JSON.parse(r.json)) {
      // a previsão envelhece junto com a foto
      const eta = f.eta - Math.max(0, Date.now() - r.ts) / 60000;
      if (eta < min || eta < 5) continue;
      const prev = byHex.get(f.hex);
      if (!prev || prev.snapshotTs < r.ts) byHex.set(f.hex, { ...f, eta: Math.round(eta), snapshotTs: r.ts });
    }
  }
  const flights = [...byHex.values()].sort((a, b) => a.eta - b.eta);
  return json({ attribution: ATTRIBUTION, count: flights.length, sources, flights });
}

// ---------- painel ----------
const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
}

export async function computeStats(env, days = 7, now = Date.now()) {
  const since = now - days * 86400000;
  const db = env.DB;
  const runs = (await db.prepare('SELECT * FROM runs WHERE ts >= ? ORDER BY ts').bind(since).all()).results || [];
  const ps = (await db.prepare('SELECT * FROM point_stats WHERE ts >= ? ORDER BY ts').bind(since).all()).results || [];
  const watch = (await db.prepare('SELECT * FROM watch WHERE first_ts >= ?').bind(since).all()).results || [];

  // por ponto
  const perPoint = {};
  for (const r of ps) {
    const p = (perPoint[r.point] ||= { point: r.point, n: 0, ok: 0, quota: 0, error: 0, seen: 0, airborne: 0, routed: 0, coherent: 0, ms: 0 });
    p.n++;
    p[r.status] = (p[r.status] || 0) + 1;
    if (r.status === 'ok') {
      p.seen += r.seen;
      p.airborne += r.airborne;
      p.routed += r.routed;
      p.coherent += r.coherent;
      p.ms += r.ms || 0;
    }
  }
  const points = Object.values(perPoint).map((p) => ({
    point: p.point,
    runs: p.n,
    failPct: pct(p.quota + p.error, p.n),
    quota: p.quota,
    avgAirborne: p.ok ? Math.round(p.airborne / p.ok) : null,
    avgCoherent: p.ok ? Math.round(p.coherent / p.ok) : null,
    routedPct: pct(p.routed, p.airborne),
    coherentPct: pct(p.coherent, p.routed),
    avgMs: p.ok ? Math.round(p.ms / p.ok) : null,
  }));
  const order = [MUNDO, ...WORLD_POINTS.map((p) => p.id)];
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : 100);
  points.sort((a, b) => rank(a.point) - rank(b.point));

  // disponibilidade no mundo por hora (horário de Brasília), média e pior caso
  const hours = Array.from({ length: 24 }, (_, h) => ({ h, n: 0, sum: {}, min: {} }));
  for (const r of ps) {
    if (r.point !== MUNDO || r.status !== 'ok') continue;
    const h = new Date(r.ts - 3 * 3600000).getUTCHours();
    const slot = hours.at(h);
    slot.n++;
    for (const [b] of BUCKETS) {
      slot.sum[b] = (slot.sum[b] || 0) + r[b];
      slot.min[b] = slot.min[b] === undefined ? r[b] : Math.min(slot.min[b], r[b]);
    }
  }
  const hourly = hours.map((s) => ({
    hour: s.h,
    samples: s.n,
    avg: Object.fromEntries(BUCKETS.map(([b]) => [b, s.n ? Math.round(s.sum[b] / s.n) : null])),
    min: Object.fromEntries(BUCKETS.map(([b]) => [b, s.n ? s.min[b] : null])),
  }));

  // previsão de pouso
  const wm = watch.filter((w) => w.dest_point && w.eta_ver === ETA_VERSION); // modo mundial, versão atual da previsão
  const landed = wm.filter((w) => w.status === 'landed');
  const byEta = [[25, 60, '25–59 min'], [60, 90, '60–89 min'], [90, 180, '1h30–3h'], [180, 360, '3–6 h'], [360, 9999, '6 h+']].map(([lo, hi, label]) => {
    const all = wm.filter((w) => w.eta_min >= lo && w.eta_min < hi && w.status !== 'active');
    const e = landed.filter((w) => w.eta_min >= lo && w.eta_min < hi).map((w) => Math.abs(w.error_min)).sort((a, b) => a - b);
    const m = landed.filter((w) => w.eta_min >= lo && w.eta_min < hi && w.mid_pred_land).map((w) => Math.abs(w.actual_land - w.mid_pred_land) / 60000).sort((a, b) => a - b);
    return { label, finished: all.length, landed: e.length, lost: all.length - e.length, medianAbs: quantile(e, 0.5), p90: quantile(e, 0.9), within10: pct(e.filter((x) => x <= 10).length, e.length), midN: m.length, midMedianAbs: quantile(m, 0.5) };
  });
  const errs = landed.map((w) => w.error_min).sort((a, b) => a - b);
  const absErrs = errs.map(Math.abs).sort((a, b) => a - b);
  const landing = {
    tracked: wm.length,
    active: wm.filter((w) => w.status === 'active').length,
    landed: landed.length,
    lost: wm.filter((w) => w.status === 'lost').length,
    byEta,
    medianError: quantile(errs, 0.5),
    medianAbsError: quantile(absErrs, 0.5),
    p90AbsError: quantile(absErrs, 0.9),
    within10: pct(absErrs.filter((e) => e <= 10).length, absErrs.length),
    worst: landed
      .slice()
      .sort((a, b) => Math.abs(b.error_min) - Math.abs(a.error_min))
      .slice(0, 8)
      .map((w) => ({ cs: w.callsign, route: `${w.orig}→${w.dest}`, eta: Math.round(w.eta_min), error: Math.round(w.error_min) })),
  };

  // cota
  const perDay = {};
  for (const r of runs) {
    const d = new Date(r.ts - 3 * 3600000).toISOString().slice(0, 10);
    perDay[d] = (perDay[d] || 0) + r.metered_calls;
  }
  const quota = {
    runs: runs.length,
    meteredPerDay: perDay,
    quotaHits: ps.filter((r) => r.status === 'quota').length,
    errors: ps.filter((r) => r.status === 'error').length,
    keyConfigured: Boolean(env.ADSBLOL_KEY),
  };

  return { generatedAt: now, days, first: runs[0]?.ts || null, last: runs.at(-1)?.ts || null, quota, points, hourly, landing };
}

const esc = (s) => String(s ?? '—').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (v, suf = '') => (v === null || v === undefined ? '—' : `${typeof v === 'number' ? Math.round(v * 10) / 10 : v}${suf}`);
const brt = (ts) =>
  ts ? new Date(ts - 3 * 3600000).toISOString().replace('T', ' ').slice(0, 16) + ' (Brasília)' : '—';

function heat(v) {
  if (v === null || v === undefined) return 'background:#14161A;color:#6B727B';
  if (v === 0) return 'background:#4a1f17;color:#FF6B4A';
  if (v < 3) return 'background:#3d3214;color:#FFB020';
  return 'background:#143322;color:#3DDC84';
}

const ETA_VERSION_LABEL = ETA_VERSION;
export function renderStats(s, links = { json: '/stats.json', flights: '/flights' }) {
  const L = s.landing;
  const labels = { b25: '25–49 min', b50: '50–89', b90: '90–179', b180: '3–6 h', b360: '6 h+' };
  const head = BUCKETS.map(([b]) => `<th>${labels[b]}</th>`).join('');
  const hourRows = (key) =>
    s.hourly
      .map(
        (h) =>
          `<tr><td>${String(h.hour).padStart(2, '0')}h</td>${BUCKETS.map(([b]) => `<td style="${heat(h[key][b])}">${fmt(h[key][b])}</td>`).join('')}<td class="q">${h.samples}</td></tr>`
      )
      .join('');
  const pointRows = s.points
    .map(
      (p) =>
        `<tr${p.point === MUNDO ? ' class="hl"' : ''}><td>${esc(p.point === MUNDO ? 'Mundo (soma, sem repetir)' : p.point)}</td><td>${p.runs}</td><td>${fmt(p.avgAirborne)}</td><td>${fmt(p.routedPct, '%')}</td><td>${fmt(p.coherentPct, '%')}</td><td>${fmt(p.avgCoherent)}</td><td>${fmt(p.failPct, '%')}</td><td>${fmt(p.avgMs, ' ms')}</td></tr>`
    )
    .join('');
  const days = Object.entries(s.quota.meteredPerDay)
    .map(([d, n]) => `<tr><td>${d}</td><td>${n}</td></tr>`)
    .join('');
  const worst = L.worst.map((w) => `<tr><td>${esc(w.cs)}</td><td>${esc(w.route)}</td><td>${w.eta} min</td><td>${w.error > 0 ? '+' : ''}${w.error} min</td></tr>`).join('');

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Teste de voos ao vivo</title>
<style>
body{background:#0A0B0D;color:#F2F2EE;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:0;padding:24px;max-width:1040px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:32px 0 8px;color:#FFC629;text-transform:uppercase;letter-spacing:.06em}
p{color:#9AA1A9;margin:4px 0 12px}table{border-collapse:collapse;width:100%;margin:8px 0}
th,td{border-bottom:1px solid #262A31;padding:6px 8px;text-align:right}th:first-child,td:first-child{text-align:left}
th{color:#9AA1A9;font-weight:500}.hl td{color:#FFC629}.q{color:#6B727B}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:12px 0}
.card{background:#14161A;border:1px solid #262A31;border-radius:8px;padding:12px}.card b{display:block;font-size:22px;color:#FFC629}
.warn{color:#FF6B4A}footer{margin-top:40px;color:#6B727B}
</style></head><body>
<h1>Teste de voos ao vivo</h1>
<p>Últimos ${s.days} dias · ${s.quota.runs} coletas · de ${brt(s.first)} a ${brt(s.last)} · página gerada em ${brt(s.generatedAt)}</p>
${s.quota.keyConfigured ? '' : '<p class="warn">Sem chave do adsb.lol configurada. O IP do servidor é compartilhado, então a cota sem chave pode acabar por causa de outros usuários.</p>'}

<div class="cards">
<div class="card">Voos prontos no mundo (média)<b>${fmt(s.points.find((p) => p.point === MUNDO)?.avgCoherent)}</b></div>
<div class="card">Erro típico do pouso<b>${fmt(L.medianAbsError, ' min')}</b></div>
<div class="card">Pousos dentro de ±10 min<b>${fmt(L.within10, '%')}</b></div>
<div class="card">Recusas por cota (429)<b>${s.quota.quotaHits}</b></div>
</div>

<h2>1. Tem voo para cada tempo de foco, a qualquer hora?</h2>
<p>Voos no ar somando as 9 regiões (a última foto de cada uma, com até 40 min), por quanto falta para pousar. Vermelho = nenhum voo naquela faixa, amarelo = menos de 3.</p>
<p><b>Pior caso</b> de cada hora (o momento com menos opções):</p>
<table><tr><th>Hora</th>${head}<th>amostras</th></tr>${hourRows('min')}</table>
<p><b>Média</b> de cada hora:</p>
<table><tr><th>Hora</th>${head}<th>amostras</th></tr>${hourRows('avg')}</table>

<h2>2. Qualidade dos dados por região</h2>
<p>"Com rota" = o adsb.lol sabe origem e destino. "Coerentes" = a rota bate com a posição e o rumo do avião.</p>
<table><tr><th>Região</th><th>coletas</th><th>no ar</th><th>com rota</th><th>coerentes</th><th>voos prontos</th><th>falhas</th><th>tempo</th></tr>${pointRows}</table>

<h2>3. O avião pousa quando dissemos? (previsão versão ${ETA_VERSION_LABEL})</h2>
<p>Voos de qualquer região, com destino dentro de uma das 9, acompanhados do primeiro avistamento até sumirem perto do destino. Erro = pouso real menos o previsto no primeiro avistamento. Cada região é vista a cada 30 min, então o pouso é estimado pela última posição perto do destino. "Perdidos" não foram vistos chegando: falta de cobertura no fim da rota ou rota errada.</p>
<div class="cards">
<div class="card">Acompanhados<b>${L.tracked}</b></div>
<div class="card">Pousaram<b>${L.landed}</b></div>
<div class="card">Perdidos<b>${L.lost}</b></div>
<div class="card">Ainda no ar<b>${L.active}</b></div>
<div class="card">Viés mediano<b>${fmt(L.medianError, ' min')}</b></div>
<div class="card">90% erram até<b>${fmt(L.p90AbsError, ' min')}</b></div>
</div>
<p>Por duração prevista no primeiro avistamento:</p>
<table><tr><th>Previsão</th><th>finalizados</th><th>pousaram</th><th>perdidos</th><th>erro típico</th><th>90% até</th><th>dentro de ±10 min</th><th>erro típico no meio do voo</th></tr>${L.byEta.map((r) => `<tr><td>${r.label}</td><td>${r.finished}</td><td>${r.landed}</td><td>${r.lost}</td><td>${fmt(r.medianAbs, ' min')}</td><td>${fmt(r.p90, ' min')}</td><td>${fmt(r.within10, '%')}</td><td>${fmt(r.midMedianAbs, ' min')} (${r.midN})</td></tr>`).join('')}</table>
${worst ? `<p>Maiores erros:</p><table><tr><th>Voo</th><th>Rota</th><th>Previsão</th><th>Erro</th></tr>${worst}</table>` : ''}

<h2>4. Cota do adsb.lol</h2>
<p>Chamadas que contam na cota, por dia. Sem chave, 432 por dia (3 por coleta). Com chave, 864 por dia (6 por coleta), dentro do limite de 1.000.</p>
<table><tr><th>Dia</th><th>chamadas</th></tr>${days || '<tr><td>—</td><td>—</td></tr>'}</table>

<footer>${ATTRIBUTION} · <a style="color:#5CC8FF" href="${links.json}">números em JSON</a> · <a style="color:#5CC8FF" href="${links.flights}">lista de voos</a></footer>
</body></html>`;
}

// ---------- roteamento ----------
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' },
  });
}
