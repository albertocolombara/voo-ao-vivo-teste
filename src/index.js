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

// Brasil: consultado em toda execução. O "BR" junta os três sem contar avião repetido.
const BR_POINTS = [
  { id: 'BR-Sudeste', lat: -23.0, lon: -46.0 },
  { id: 'BR-Centro', lat: -15.8, lon: -47.9 },
  { id: 'BR-Nordeste', lat: -9.5, lon: -37.0 },
];
// Mundo: um ponto por execução, em rodízio (cada um volta a cada 80 min).
const WORLD_POINTS = [
  { id: 'Londres-Paris', lat: 50.5, lon: 0.5 },
  { id: 'Frankfurt', lat: 50.0, lon: 8.6 },
  { id: 'Nova York', lat: 40.6, lon: -73.8 },
  { id: 'Los Angeles', lat: 34.0, lon: -118.4 },
  { id: 'Dubai', lat: 25.2, lon: 55.4 },
  { id: 'Tóquio', lat: 35.6, lon: 139.8 },
  { id: 'Singapura', lat: 1.4, lon: 103.9 },
  { id: 'Atlântico Norte', lat: 52.0, lon: -30.0 }, // mede cobertura sobre o oceano
];

const BUCKETS = [
  ['b25', 25, 50],
  ['b50', 50, 90],
  ['b90', 90, 180],
  ['b180', 180, 360],
  ['b360', 360, Infinity],
];
const WATCH_NEW_PER_RUN = 8;
const WATCH_MAX_ACTIVE = 200;
const WATCH_DEST_KM = 400; // só acompanha voos que pousam dentro da cobertura do Brasil
const LOST_AFTER_MS = 20 * 60000;
const LANDED_KM = 200; // sumiu a menos disso do destino = pousou (fora disso = perdido)
const ATTRIBUTION = 'Dados de voo: adsb.lol (ODbL 1.0)';
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

const etaMin = (remKm, gs) => (remKm / (gs * 1.852)) * 60 + 8;
const bucketOf = (eta) => (BUCKETS.find(([, lo, hi]) => eta >= lo && eta < hi) || [null])[0];

function toFlight(ac, route, leg) {
  const eta = etaMin(leg.pd, ac.gs);
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

// Rotas: endpoint grátis, em lotes. Devolve Map(callsign -> rota), quantas chamadas fez e os erros.
async function fetchRoutes(planes) {
  const routes = new Map();
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
  const world = WORLD_POINTS[Math.floor(now / 600000) % WORLD_POINTS.length];
  const points = [...BR_POINTS, world];

  // 1. aviões por ponto (chamadas que contam na cota)
  const raw = [];
  let errors = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) await sleep(SPACING_MS);
    const r = await fetchPoint(env, points[i]);
    if (r.status !== 'ok') errors++;
    raw.push({ point: points[i], ...r, air: r.ac.filter(airborne) });
  }

  // 2. rotas (grátis), sem repetir indicativo
  const seenCs = new Map();
  for (const r of raw) for (const a of r.air) if (!seenCs.has(a.flight.trim())) seenCs.set(a.flight.trim(), { callsign: a.flight.trim(), lat: a.lat, lng: a.lon });
  const { routes, calls: routeCalls, errors: routeErrors, failures } = await fetchRoutes([...seenCs.values()]);
  errors += routeErrors;

  // 3. estatísticas por ponto + total do Brasil sem repetição
  const rows = [];
  const snapshots = [];
  const br = { status: 'ok', ms: 0, stats: emptyStats(), hexes: new Set() };
  const brFlights = new Map(); // hex -> voo coerente (para o acompanhamento de pouso)
  const brAir = new Map(); // hex -> aeronave no ar (para achar quem já pousou)

  for (const r of raw) {
    const s = emptyStats();
    s.seen = r.ac.length;
    const flights = [];
    const isBR = BR_POINTS.includes(r.point);
    for (const a of r.air) {
      s.airborne++;
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
      if (isBR) {
        brAir.set(a.hex, a);
        if (!br.hexes.has(a.hex)) {
          br.hexes.add(a.hex);
          br.stats.airborne++;
          if (routed) br.stats.routed++;
          if (f) {
            br.stats.coherent++;
            const b = bucketOf(f.eta);
            if (b) br.stats[b]++;
            brFlights.set(a.hex, f);
          }
        }
      }
    }
    if (isBR) {
      br.stats.seen += s.seen;
      br.ms += r.ms;
      if (r.status !== 'ok') br.status = r.status;
    }
    rows.push({ point: r.point.id, status: r.status, http: r.http, ms: r.ms, ...s });
    if (r.status === 'ok') snapshots.push({ point: r.point.id, json: JSON.stringify(flights) });
  }
  rows.push({ point: 'BR', status: br.status, http: null, ms: br.ms, ...br.stats });

  // 4. grava
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

  // 5. acompanhamento de pouso (só Brasil, consultado em toda execução)
  if (br.status === 'ok') await trackLandings(env, now, brAir, brFlights);

  return { runId, rows, routeCalls, errors, failures };
}

async function trackLandings(env, now, brAir, brFlights) {
  const active = (await env.DB.prepare("SELECT * FROM watch WHERE status = 'active'").all()).results || [];
  const stmts = [];
  const watching = new Set();

  for (const w of active) {
    watching.add(w.hex);
    const a = brAir.get(w.hex);
    if (a) {
      stmts.push(
        env.DB.prepare('UPDATE watch SET last_seen = ?, last_dist_km = ?, last_alt = ?, last_gs = ? WHERE hex = ? AND first_ts = ?').bind(
          now,
          distKm(a.lat, a.lon, w.dest_lat, w.dest_lon),
          a.alt_baro,
          a.gs,
          w.hex,
          w.first_ts
        )
      );
    } else if (now - w.last_seen > LOST_AFTER_MS || now - w.first_ts > 12 * 3600000) {
      // sumiu perto do destino: pousou. Como a coleta é a cada 10 min, o pouso é estimado
      // a partir da última posição: distância que faltava, a 75% da velocidade (descida).
      const landed = w.last_dist_km < LANDED_KM;
      if (landed) {
        const kmPerMin = (Math.max(w.last_gs || 0, 180) * 1.852 * 0.75) / 60;
        const actual = w.last_seen + (w.last_dist_km / kmPerMin) * 60000;
        const err = (actual - w.pred_land) / 60000;
        stmts.push(
          env.DB.prepare("UPDATE watch SET status = 'landed', actual_land = ?, error_min = ? WHERE hex = ? AND first_ts = ?").bind(
            Math.round(actual),
            err,
            w.hex,
            w.first_ts
          )
        );
      } else {
        stmts.push(env.DB.prepare("UPDATE watch SET status = 'lost' WHERE hex = ? AND first_ts = ?").bind(w.hex, w.first_ts));
      }
    }
  }

  // novos voos para acompanhar: destino dentro da cobertura, pouso entre 25 min e 4 h
  let room = Math.min(WATCH_NEW_PER_RUN, WATCH_MAX_ACTIVE - active.length);
  for (const f of brFlights.values()) {
    if (room <= 0) break;
    if (watching.has(f.hex) || f.eta < 25 || f.eta > 240) continue;
    const near = BR_POINTS.some((p) => distKm(p.lat, p.lon, f.d.lat, f.d.lon) < WATCH_DEST_KM);
    if (!near) continue;
    const point = BR_POINTS.reduce((a, p) => (distKm(p.lat, p.lon, f.lat, f.lon) < distKm(a.lat, a.lon, f.lat, f.lon) ? p : a)).id;
    stmts.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO watch (hex, first_ts, point, callsign, orig, dest, dest_lat, dest_lon, eta_min, pred_land, last_seen, last_dist_km, last_alt, last_gs, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active')"
      ).bind(f.hex, now, point, f.cs, f.o.iata || f.o.icao, f.d.iata || f.d.icao, f.d.lat, f.d.lon, f.eta, now + f.eta * 60000, now, f.remKm, f.alt, f.gs)
    );
    room--;
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
  const order = ['BR', ...BR_POINTS.map((p) => p.id), ...WORLD_POINTS.map((p) => p.id)];
  points.sort((a, b) => order.indexOf(a.point) - order.indexOf(b.point));

  // disponibilidade no Brasil por hora (horário de Brasília), média e pior caso
  const hours = Array.from({ length: 24 }, (_, h) => ({ h, n: 0, sum: {}, min: {} }));
  for (const r of ps) {
    if (r.point !== 'BR' || r.status !== 'ok') continue;
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
  const landed = watch.filter((w) => w.status === 'landed');
  const errs = landed.map((w) => w.error_min).sort((a, b) => a - b);
  const absErrs = errs.map(Math.abs).sort((a, b) => a - b);
  const landing = {
    tracked: watch.length,
    active: watch.filter((w) => w.status === 'active').length,
    landed: landed.length,
    lost: watch.filter((w) => w.status === 'lost').length,
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
        `<tr${p.point === 'BR' ? ' class="hl"' : ''}><td>${esc(p.point === 'BR' ? 'Brasil (sem repetir)' : p.point)}</td><td>${p.runs}</td><td>${fmt(p.avgAirborne)}</td><td>${fmt(p.routedPct, '%')}</td><td>${fmt(p.coherentPct, '%')}</td><td>${fmt(p.avgCoherent)}</td><td>${fmt(p.failPct, '%')}</td><td>${fmt(p.avgMs, ' ms')}</td></tr>`
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
<div class="card">Rotas coerentes (Brasil)<b>${fmt(s.points.find((p) => p.point === 'BR')?.coherentPct, '%')}</b></div>
<div class="card">Voos prontos por coleta (Brasil)<b>${fmt(s.points.find((p) => p.point === 'BR')?.avgCoherent)}</b></div>
<div class="card">Erro típico do pouso<b>${fmt(L.medianAbsError, ' min')}</b></div>
<div class="card">Pousos dentro de ±10 min<b>${fmt(L.within10, '%')}</b></div>
<div class="card">Recusas por cota (429)<b>${s.quota.quotaHits}</b></div>
</div>

<h2>1. Tem voo para cada tempo de foco, a qualquer hora?</h2>
<p>Voos no ar sobre o Brasil, por quanto falta para pousar. Vermelho = nenhum voo naquela faixa, amarelo = menos de 3.</p>
<p><b>Pior caso</b> de cada hora (o momento com menos opções):</p>
<table><tr><th>Hora</th>${head}<th>amostras</th></tr>${hourRows('min')}</table>
<p><b>Média</b> de cada hora:</p>
<table><tr><th>Hora</th>${head}<th>amostras</th></tr>${hourRows('avg')}</table>

<h2>2. Qualidade dos dados por região</h2>
<p>"Com rota" = o adsb.lol sabe origem e destino. "Coerentes" = a rota bate com a posição e o rumo do avião.</p>
<table><tr><th>Região</th><th>coletas</th><th>no ar</th><th>com rota</th><th>coerentes</th><th>voos prontos</th><th>falhas</th><th>tempo</th></tr>${pointRows}</table>

<h2>3. O avião pousa quando dissemos?</h2>
<p>Voos sobre o Brasil acompanhados do primeiro avistamento até sumirem perto do destino. Erro = pouso real menos o previsto. Como a coleta é a cada 10 min, o momento do pouso é estimado a partir da última posição vista. "Perdidos" sumiram a mais de 200 km do destino: falha de cobertura ou rota errada.</p>
<div class="cards">
<div class="card">Acompanhados<b>${L.tracked}</b></div>
<div class="card">Pousaram<b>${L.landed}</b></div>
<div class="card">Perdidos (sumiram a mais de 200 km)<b>${L.lost}</b></div>
<div class="card">Ainda no ar<b>${L.active}</b></div>
<div class="card">Viés mediano<b>${fmt(L.medianError, ' min')}</b></div>
<div class="card">90% erram até<b>${fmt(L.p90AbsError, ' min')}</b></div>
</div>
${worst ? `<p>Maiores erros:</p><table><tr><th>Voo</th><th>Rota</th><th>Previsão</th><th>Erro</th></tr>${worst}</table>` : ''}

<h2>4. Cota do adsb.lol</h2>
<p>Chamadas que contam na cota, por dia. O plano deve ficar em 576 por dia (4 por coleta).</p>
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
