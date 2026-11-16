// adsb.lol falso, determinístico pelo horário (NOW). Carregado com: node --import ./test/fake-api.mjs
// Os voos são inventados: servem para testar o código, não para tirar conclusões.
globalThis.setTimeout = (fn) => (fn(), 0); // pula as pausas entre chamadas

const AP = {
  GRU: [-23.43, -46.47], BSB: [-15.87, -47.92], REC: [-8.13, -34.92], SSA: [-12.91, -38.33], GIG: [-22.81, -43.25],
  CNF: [-19.63, -43.97], FOR: [-3.78, -38.53], POA: [-29.99, -51.17], CWB: [-25.53, -49.17], MAO: [-3.04, -60.05],
  LHR: [51.47, -0.45], CDG: [49.0, 2.55], FRA: [50.03, 8.57], JFK: [40.64, -73.78], LAX: [33.94, -118.4],
  DXB: [25.25, 55.36], HND: [35.55, 139.78], SIN: [1.36, 103.99], LIS: [38.77, -9.13], MAD: [40.47, -3.56],
};
const codes = Object.keys(AP);
const brCodes = codes.slice(0, 10);
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const R = 6371, rad = (d) => (d * Math.PI) / 180;
const dist = (a, b) => {
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const brg = (a, b) => {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

// agenda fixa de voos a partir de T0
export const T0 = Date.UTC(2026, 10, 16, 3, 0);
const flights = [];
for (let i = 0; i < 1400; i++) {
  const pool = rnd() < 0.6 ? brCodes : codes;
  const o = pick(pool);
  let d = pick(pool);
  while (d === o) d = pick(pool);
  const gs = 420 + rnd() * 60;
  const dur = (dist(AP[o], AP[d]) / (gs * 1.852)) * 3600000 + (rnd() - 0.4) * 20 * 60000;
  flights.push({ hex: 'h' + i, cs: 'TST' + i, o, d, gs, start: T0 - 10 * 3600000 + rnd() * 50 * 3600000, dur, wrong: rnd() < 0.2 });
}
const now = () => Number(process.env.NOW || Date.now());
const callRnd = () => Math.abs(Math.sin(now() / 1000 + (callRnd.n = (callRnd.n || 0) + 1))) % 1;

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const t = now();
  if (url.includes('/v2/point/')) {
    if (callRnd() < 0.03) return new Response('', { status: 429 });
    const [, lat, lon, r] = url.match(/point\/([-\d.]+)\/([-\d.]+)\/(\d+)/).map(Number);
    const ac = [{ hex: 'gnd', flight: '', lat, lon, alt_baro: 'ground', gs: 0 }];
    for (const f of flights) {
      const p = (t - f.start) / f.dur;
      if (p < 0 || p >= 1) continue;
      const a = AP[f.o], b = AP[f.d];
      const la = a[0] + (b[0] - a[0]) * p, lo = a[1] + (b[1] - a[1]) * p;
      if (dist([lat, lon], [la, lo]) > r * 1.852) continue;
      const alt = Math.min(35000, Math.round(dist([la, lo], b) * 160));
      ac.push({ hex: f.hex, flight: f.cs + '  ', t: 'A320', lat: la, lon: lo, alt_baro: alt < 300 ? 'ground' : alt, gs: f.gs, track: brg([la, lo], b) });
    }
    return Response.json({ ac, now: t, total: ac.length });
  }
  if (url.includes('/routeset')) {
    const { planes } = JSON.parse(opts.body);
    const ap = (c) => ({ iata: c, icao: 'X' + c, name: 'Aeroporto ' + c, lat: AP[c][0], lon: AP[c][1] });
    const out = [];
    for (const p of planes) {
      const f = flights.find((x) => x.cs === p.callsign);
      if (!f || Number(f.hex.slice(1)) % 10 === 0) continue; // 10% sem rota
      const d = f.wrong ? codes.find((c) => c !== f.d && c !== f.o) : f.d;
      out.push({ callsign: f.cs, airline_code: 'TST', airport_codes: `${f.o}-${d}`, _airports: [ap(f.o), ap(d)], plausible: true });
    }
    return Response.json(out);
  }
  return new Response('?', { status: 404 });
};
