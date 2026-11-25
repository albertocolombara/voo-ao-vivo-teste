import fs from 'node:fs';

// Previsão de pouso. Histórico das versões:
// v1: só a velocidade atual. Logo após a decolagem o avião ainda está subindo e lento,
//     e voos longos saíam muito maiores que o real (6 h+: erro típico de ~56 min).
// v2: longe do destino e fora de cruzeiro, usa velocidade de cruzeiro típica (470 kt).
//     6 h+ caiu para ~37 min; até 1h30 ficou ~3-4 min.
// v3: para mais de 2.500 km restantes, parâmetros ajustados em 896 pousos reais
//     (metade para ajustar, metade para conferir): em cruzeiro, média entre a velocidade atual
//     e 440 kt (amortece ventos de cauda fortes); fora de cruzeiro, no mínimo 440 kt.
//     No teste, 6 h+ caiu de ~32 para ~24 min. Até 2.500 km, segue igual à v2.
// v4: em cruzeiro é a altitude (25.000 pés ou mais), não a velocidade. Com vento de proa forte
//     (velocidade no solo abaixo de 380 kt), o avião era tratado como "subindo" e a previsão usava
//     470 kt: pouso previsto ~14 min cedo demais (123 pousos reais nessa situação; até 2.500 km,
//     típico de 14,3 para 5,1 min). Caso relatado: TWB242 NRT→ICN, 25/11/2026.
export function etaBase(remKm, gs, alt) {
  const cruising = typeof alt === 'number' && alt >= 25000;
  if (remKm > 2500) {
    const speed = cruising ? 0.5 * gs + 0.5 * 440 : Math.max(gs, 440);
    return ((0.98 * remKm) / (speed * 1.852)) * 60 + 5;
  }
  let speed = gs;
  if (remKm > 300 && !cruising) speed = Math.max(gs, 470);
  return (remKm / (speed * 1.852)) * 60 + 8;
}
// v5: ajuste aprendido com os pousos registrados (scripts/ajustar-previsao.mjs, src/ajuste-previsao.json).
//     Até 2.500 km: minutos a mais ou a menos por aeroporto de destino (espera, aproximação).
//     Acima: fator por rota (origem-destino), ou por destino se a rota tem poucos pousos (desvios das
//     rotas oceânicas, ventos). Cada ajuste é puxado para zero quando há poucos pousos.
//     No teste (metade antiga ajusta, metade nova confere): até 2.500 km, típico 3,6 → 3,4 min;
//     acima, 31,9 → 21,9 min.
export const ETA_VERSION = 5;
export const LIMITE_LONGO_KM = 2500;

const AJUSTE = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('./ajuste-previsao.json', import.meta.url), 'utf8'));
  } catch {
    return { curto: {}, longoRota: {}, longoDestino: {} };
  }
})();

/** Minutos até o pouso, com o ajuste aprendido para o destino ou a rota. */
export function etaMin(remKm, gs, alt, orig, dest, ajuste = AJUSTE) {
  const base = etaBase(remKm, gs, alt);
  if (remKm <= LIMITE_LONGO_KM) return Math.max(1, base + (ajuste.curto?.[dest] ?? 0));
  const fator = ajuste.longoRota?.[`${orig}-${dest}`] ?? ajuste.longoDestino?.[dest] ?? 1;
  return base * fator;
}
