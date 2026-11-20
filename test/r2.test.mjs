// node --test test/r2.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { assinar } from '../src/r2.mjs';
import { arquivoDaRegiao, slug } from '../src/publicar.mjs';

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
  const ap = (iata, lat, lon) => ({ iata, icao: null, name: iata, lat, lon });
  const arq = arquivoDaRegiao('Londres-Paris', [
    { hex: 'abc', cs: 'RYR1', airline: 'RYR', type: 'B738', lat: 45, lon: 2, alt: 37000, gs: 450, track: 335, o: ap('BCN', 41.3, 2.1), d: ap('LGW', 51.1, -0.2), remKm: 700, eta: 72 },
  ], agora, 'x');
  assert.equal(arq.regiao, 'londres-paris');
  assert.equal(arq.coletadoEm, '2026-11-19T15:40:00.000Z');
  assert.equal(arq.voos[0].pousoPrevistoEm, '2026-11-19T16:52:00.000Z');
  assert.equal(arq.voos[0].destino.iata, 'LGW');
});
