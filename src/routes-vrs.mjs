// Rotas a partir da base aberta "Standing Data" do Virtual Radar Server (CC0 1.0):
// https://github.com/vradarserver/standing-data
// Devolve objetos no mesmo formato do routeset do adsb.lol, para o resto do código não mudar.
import fs from 'node:fs';
import path from 'node:path';

// CSV simples com suporte a campos entre aspas
function parseLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}
function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = parseLine(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(parseLine(l).map((v, i) => [head[i], v])));
}

// Normalização de indicativo, como descrita no README da base (sem a troca de código IATA por ICAO)
const CS_RE = /^([A-Z]{3})(\d[A-Z0-9]*)$/;
const NUM_RE = /^(\d|\d\d|\d[A-Z]|\d\d\d|\d\d[A-Z]|\d[A-Z][A-Z]|\d\d\d\d|\d\d\d[A-Z]|\d\d[A-Z][A-Z])$/;
export function normalize(callsign) {
  const m = CS_RE.exec(String(callsign || '').trim().toUpperCase());
  if (!m) return null; // matrícula ou formato fora do padrão de companhia aérea
  let num = m[2].replace(/^0+/, '');
  if (!num || /^[A-Z]+$/.test(num)) num = '0' + num;
  if (!NUM_RE.test(num)) return null;
  return { code: m[1], number: num, callsign: m[1] + num };
}

export function createVrsRoutes(dir) {
  const routesDir = path.join(dir, 'routes', 'schema-01');
  const airportsDir = path.join(dir, 'airports', 'schema-01');
  if (!fs.existsSync(routesDir) || !fs.existsSync(airportsDir)) throw new Error(`base de rotas não encontrada em ${dir}`);

  // aeroportos: todos de uma vez (cerca de 2,5 MB)
  const airports = new Map();
  for (const sub of fs.readdirSync(airportsDir)) {
    const subDir = path.join(airportsDir, sub);
    if (!fs.statSync(subDir).isDirectory()) continue;
    for (const f of fs.readdirSync(subDir)) {
      if (!f.endsWith('.csv')) continue;
      for (const a of readCsv(path.join(subDir, f))) {
        const ap = {
          icao: a.ICAO || a.Code,
          iata: a.IATA || null,
          name: a.Name,
          location: a.Location,
          countryiso2: a.CountryISO2,
          lat: Number(a.Latitude),
          lon: Number(a.Longitude),
        };
        if (Number.isFinite(ap.lat) && Number.isFinite(ap.lon)) {
          airports.set(a.Code, ap);
          if (a.ICAO) airports.set(a.ICAO, ap);
        }
      }
    }
  }

  // rotas: um arquivo por companhia, carregado só quando aparece um voo dela
  const files = new Map(); // caminho -> Map(callsign -> "SBGR-SBRF")
  function routesFile(code, number) {
    const folder = path.join(routesDir, code[0]);
    const all = path.join(folder, `${code}-all.csv`);
    const split = path.join(folder, `${code}-${number[0]}.csv`);
    const file = fs.existsSync(all) ? all : fs.existsSync(split) ? split : null;
    if (!file) return null;
    if (!files.has(file)) files.set(file, new Map(readCsv(file).map((r) => [r.Callsign, r.AirportCodes])));
    return files.get(file);
  }

  const stats = { asked: 0, found: 0, notAirline: 0, missingAirport: 0 };

  function lookup(callsign) {
    stats.asked++;
    const n = normalize(callsign);
    if (!n) {
      stats.notAirline++;
      return null;
    }
    const codes = routesFile(n.code, n.number)?.get(n.callsign);
    if (!codes) return null;
    const list = codes.split('-').map((c) => airports.get(c) || null);
    if (list.some((a) => !a)) stats.missingAirport++;
    const known = list.filter(Boolean);
    if (known.length < 2) return null;
    stats.found++;
    return {
      callsign: String(callsign).trim(),
      number: n.number,
      airline_code: n.code,
      airport_codes: codes,
      _airport_codes_iata: known.map((a) => a.iata || a.icao).join('-'),
      _airports: known,
      source: 'vrs-standing-data',
    };
  }

  return { lookup, stats, airportCount: airports.size };
}
