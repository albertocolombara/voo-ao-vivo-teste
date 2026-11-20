// Gera src/companhias.json: código ICAO da companhia -> país (ISO 3166-1 alfa-2), para a bandeira na cauda.
// Fonte: OpenFlights (airlines.dat e countries.dat), Open Database License (ODbL 1.0),
// mais correções manuais em dados/companhias-correcoes.json (companhias novas ou com país errado na base).
// Uso: node scripts/gerar-companhias.mjs   (baixa os arquivos do GitHub da OpenFlights)
import fs from 'node:fs';

const BASE = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/';

function linhas(texto) {
  return texto
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const out = [];
      let cur = '';
      let q = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (q) {
          if (c === '"' && l[i + 1] === '"') (cur += '"'), i++;
          else if (c === '"') q = false;
          else cur += c;
        } else if (c === '"') q = true;
        else if (c === ',') out.push(cur), (cur = '');
        else cur += c;
      }
      out.push(cur);
      return out;
    });
}

// Nomes da airlines.dat que não batem com a countries.dat
const APELIDOS = {
  'Republic of Korea': 'KR',
  'South Korea': 'KR',
  "Democratic People's Republic of Korea": 'KP',
  'Hong Kong SAR of China': 'HK',
  'Kyrgyzstan': 'KG',
  'Burma': 'MM',
  'Ivory Coast': 'CI',
  'Russian Federation': 'RU',
  'Faroe Islands': 'FO',
  'Republic of the Congo': 'CG',
  'Congo (Kinshasa)': 'CD',
  'Lao Peoples Democratic Republic': 'LA',
  'Brunei': 'BN',
  'Syrian Arab Republic': 'SY',
  'Saint Vincent and the Grenadines': 'VC',
};

const [airlines, countries] = await Promise.all(
  ['airlines.dat', 'countries.dat'].map(async (f) => {
    const res = await fetch(BASE + f);
    if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
    return res.text();
  })
);
const iso = { ...Object.fromEntries(linhas(countries).filter((r) => r[1]).map((r) => [r[0], r[1]])), ...APELIDOS };

const mapa = {};
const nomes = {};
const ativa = {};
for (const r of linhas(airlines)) {
  const icao = r[4];
  if (!/^[A-Z]{3}$/.test(icao || '')) continue;
  // Linhas com vírgula sobrando no nome: o país e o "ativa" são sempre os dois últimos campos.
  const pais = iso[r[r.length - 2]];
  const ehAtiva = r[r.length - 1] === 'Y';
  if (!pais) continue;
  if (!(icao in mapa) || (ehAtiva && !ativa[icao])) {
    mapa[icao] = pais;
    // nome: campos entre o id e o alias (vírgula sobrando no nome junta os pedaços)
    nomes[icao] = r.length === 8 ? r[1] : r.slice(1, r.length - 6).join(',');
    ativa[icao] = ehAtiva;
  }
}
const correcoes = JSON.parse(fs.readFileSync('dados/companhias-correcoes.json', 'utf8'));
for (const [icao, v] of Object.entries(correcoes.companhias)) {
  const [pais, nome] = Array.isArray(v) ? v : [v, null];
  mapa[icao] = pais;
  if (nome) nomes[icao] = nome;
}

const ordenado = Object.fromEntries(Object.keys(mapa).sort().map((k) => [k, nomes[k] ? [mapa[k], nomes[k].trim()] : [mapa[k]]]));
fs.writeFileSync('src/companhias.json', JSON.stringify(ordenado) + '\n');
console.log(`${Object.keys(ordenado).length} companhias (${Object.keys(correcoes.companhias).length} correções manuais)`);
