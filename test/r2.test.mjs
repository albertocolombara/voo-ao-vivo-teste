// node --test test/r2.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { assinar } from '../src/r2.mjs';
import { arquivoDaRegiao, slug, paisDaCompanhia, faixaDoDia, publicarNoR2 } from '../src/publicar.mjs';

// Exemplo oficial da AWS (S3, "GET Object", Signature V4)
test('assinatura SigV4 confere com o exemplo da AWS', () => {
  const h = assinar({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    headers: { range: 'bytes=0-9' },
    body: '',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    amzDate: '20130524T000000Z',
  });
  assert.match(h.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

test('slug das regiões', () => {
  assert.equal(slug('São Paulo'), 'sao-paulo');
  assert.equal(slug('Londres-Paris'), 'londres-paris');
  assert.equal(slug('Tóquio'), 'toquio');
});

test('arquivo da região no formato do app', () => {
  const agora = Date.UTC(2026, 10, 19, 15, 40);
  const ap = (iata, lat, lon) => ({ iata, icao: null, name: iata, city: 'London', country: 'GB', lat, lon });
  const arq = arquivoDaRegiao('Londres-Paris', [
    { hex: 'abc', cs: 'RYR1', airline: 'RYR', type: 'B738', lat: 45, lon: 2, alt: 37000, gs: 450, track: 335, o: ap('BCN', 41.3, 2.1), d: ap('LGW', 51.1, -0.2), remKm: 700, eta: 72 },
  ], agora, 'x');
  assert.equal(arq.regiao, 'londres-paris');
  assert.equal(arq.coletadoEm, '2026-11-19T15:40:00.000Z');
  assert.equal(arq.voos[0].pousoPrevistoEm, '2026-11-19T16:52:00.000Z');
  assert.equal(arq.voos[0].destino.iata, 'LGW');
  assert.equal(arq.voos[0].companhiaPais, 'IE');
  assert.equal(arq.voos[0].companhiaNome, 'Ryanair');
  assert.equal(arq.voos[0].destino.cidade, 'London');
  assert.equal(arq.voos[0].destino.pais, 'GB');
});

test('país da companhia', () => {
  assert.equal(paisDaCompanhia('TAM', 'TAM3300'), 'BR');
  assert.equal(paisDaCompanhia(null, 'KAL017'), 'KR');
  assert.equal(paisDaCompanhia(null, 'N123AB'), null);
});

test('faixa de 20 min do histórico', () => {
  assert.equal(faixaDoDia(Date.UTC(2026, 10, 19, 15, 47)), '1540');
  assert.equal(faixaDoDia(Date.UTC(2026, 10, 19, 0, 0)), '0000');
  assert.equal(faixaDoDia(Date.UTC(2026, 10, 19, 23, 59)), '2340');
});

test('publica o arquivo da região, o histórico e o índice', async () => {
  const enviados = [];
  const r2 = { enviar: async (k) => enviados.push(k) };
  const agora = Date.UTC(2026, 10, 19, 15, 47);
  const { falhas } = await publicarNoR2(r2, new Map([['São Paulo', []]]), agora, 'x');
  assert.deepEqual(falhas, []);
  assert.deepEqual(enviados, ['voos/sao-paulo.json', 'historico/sao-paulo/1540.json', 'voos/indice.json']);
});

test('envia JSON comprimido com Content-Encoding: gzip', async () => {
  const { criarR2 } = await import('../src/r2.mjs');
  const zlib = await import('node:zlib');
  const pedidos = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    pedidos.push({ url, init });
    return { ok: true, text: async () => '' };
  };
  try {
    const r2 = criarR2({ R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b' });
    await r2.enviar('voos/x.json', JSON.stringify({ voos: [1, 2, 3] }));
    await r2.enviar('outro.txt', 'oi', { contentType: 'text/plain' });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(pedidos[0].init.headers['content-encoding'], 'gzip');
  assert.deepEqual(JSON.parse(zlib.gunzipSync(pedidos[0].init.body).toString()), { voos: [1, 2, 3] });
  assert.match(pedidos[0].init.headers.authorization, /content-encoding/);
  assert.equal(pedidos[1].init.headers['content-encoding'], undefined);
  assert.equal(pedidos[1].init.body.toString(), 'oi');
});
