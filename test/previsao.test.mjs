import { test } from 'node:test';
import assert from 'node:assert/strict';
import { etaBase, etaMin } from '../src/previsao.mjs';

const ajuste = { curto: { ICN: 6 }, longoRota: { 'LHR-JFK': 1.1 }, longoDestino: { JFK: 1.05 } };

test('até 2.500 km soma os minutos do destino', () => {
  assert.equal(etaMin(800, 450, 35000, 'NRT', 'ICN', ajuste), etaBase(800, 450, 35000) + 6);
  assert.equal(etaMin(800, 450, 35000, 'NRT', 'XXX', ajuste), etaBase(800, 450, 35000));
});

test('acima de 2.500 km usa o fator da rota, ou o do destino', () => {
  assert.equal(etaMin(5000, 480, 37000, 'LHR', 'JFK', ajuste), etaBase(5000, 480, 37000) * 1.1);
  assert.equal(etaMin(5000, 480, 37000, 'CDG', 'JFK', ajuste), etaBase(5000, 480, 37000) * 1.05);
});

test('vento de proa forte em cruzeiro não vira "subindo" (v4)', () => {
  // 323 kt a 34.000 pés, 400 km: antes usava 470 kt
  assert.ok(etaBase(400, 323, 34000) > 46);
});
