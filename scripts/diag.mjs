// Diagnóstico do /api/0/routeset: testa variações da chamada e mostra o que volta.
const API = 'https://api.adsb.lol';
const planes = [
  { callsign: 'GLO1101', lat: -23, lng: -46 },
  { callsign: 'TAM3818', lat: -23, lng: -46 },
  { callsign: 'AZU4001', lat: -23, lng: -46 },
];
const body = JSON.stringify({ planes });
const browserUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const variants = {
  'mínimo (só content-type)': { 'content-type': 'application/json' },
  'atual (accept + user-agent do projeto)': {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'voo-ao-vivo-teste/0.1 (+https://github.com/albertocolombara/voo-ao-vivo-teste)',
  },
  'como navegador (origin + referer + UA)': {
    'content-type': 'application/json',
    accept: '*/*',
    origin: 'https://api.adsb.lol',
    referer: 'https://api.adsb.lol/docs',
    'user-agent': browserUA,
  },
  'sem compressão': { 'content-type': 'application/json', 'accept-encoding': 'identity' },
  'com chave (se houver)': { 'content-type': 'application/json', ...(process.env.ADSBLOL_KEY ? { 'x-api-key': process.env.ADSBLOL_KEY } : {}) },
};

for (const [name, headers] of Object.entries(variants)) {
  try {
    const res = await fetch(`${API}/api/0/routeset`, { method: 'POST', headers, body });
    const text = await res.text();
    const h = ['content-type', 'content-length', 'content-encoding', 'server', 'retry-after'].map((k) => `${k}=${res.headers.get(k)}`).join(' ');
    console.log(`\n[${name}] HTTP ${res.status} · ${text.length} caracteres · ${h}\n${text.slice(0, 300) || '(corpo vazio)'}`);
  } catch (e) {
    console.log(`\n[${name}] falhou: ${e?.message} ${e?.cause?.code || ''}`);
  }
}

// e o endpoint de posição, para comparar
const res = await fetch(`${API}/v2/point/-23/-46/50`);
console.log(`\n[v2/point] HTTP ${res.status} · ${(await res.text()).length} caracteres`);
