// Arquivos que o app lê no R2: um JSON por região e um índice.
// Formato em teste: ARCHITECTURE.md §9 do termi-app ("Contrato do cache de voos", [Proposta]).
// Só vira contrato depois de aprovado pelo Alberto.

import fs from 'node:fs';

export const VERSAO = 1;

// Código ICAO da companhia -> país (ISO 3166-1 alfa-2). Gerado por scripts/gerar-companhias.mjs (OpenFlights, ODbL).
// Formato: { ICAO: "BR" } (antigo) ou { ICAO: ["BR", "LATAM Brasil"] }.
const COMPANHIAS = JSON.parse(fs.readFileSync(new URL('./companhias.json', import.meta.url), 'utf8'));
const registro = (codigo, callsign) => COMPANHIAS[codigo] ?? COMPANHIAS[String(callsign || '').slice(0, 3).toUpperCase()] ?? null;

/** País da companhia pelo código da rota ou, sem ele, pelas 3 primeiras letras do indicativo. */
export const paisDaCompanhia = (codigo, callsign) => {
  const r = registro(codigo, callsign);
  return Array.isArray(r) ? r[0] : r;
};

/** Nome da companhia (OpenFlights), para a linha do painel de partidas. */
export const nomeDaCompanhia = (codigo, callsign) => {
  const r = registro(codigo, callsign);
  return Array.isArray(r) ? r[1] ?? null : null;
};

/** "Londres-Paris" -> "londres-paris"; "São Paulo" -> "sao-paulo". */
export const slug = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const aeroporto = (a) => ({ iata: a.iata, icao: a.icao, nome: a.name, cidade: a.city ?? null, pais: a.country ?? null, lat: a.lat, lon: a.lon });

/** Converte os voos coerentes de uma região para o formato do app. */
export function arquivoDaRegiao(regiao, voos, agora, atribuicao) {
  return {
    versao: VERSAO,
    regiao: slug(regiao),
    nome: regiao,
    coletadoEm: new Date(agora).toISOString(),
    atribuicao,
    voos: voos.map((f) => ({
      hex: f.hex,
      callsign: f.cs,
      companhia: f.airline,
      companhiaPais: paisDaCompanhia(f.airline, f.cs),
      companhiaNome: nomeDaCompanhia(f.airline, f.cs),
      aeronave: f.type,
      origem: aeroporto(f.o),
      destino: aeroporto(f.d),
      lat: f.lat,
      lon: f.lon,
      altitudePes: typeof f.alt === 'number' ? f.alt : null,
      velocidadeNos: f.gs ?? null,
      rumo: f.track,
      distanciaRestanteKm: f.remKm,
      pousoPrevistoEm: new Date(agora + f.eta * 60000).toISOString(),
    })),
  };
}

/**
 * Faixa de 20 min do dia (UTC) para o histórico do "voo de ontem" (RN-12): "1540" para 15:47.
 * Cada região é coletada a cada 20 min, então cada faixa recebe uma coleta por dia e é
 * sobrescrita 24 h depois. Se a coleta parar, o arquivo da faixa continua sendo o de ontem.
 */
export const faixaDoDia = (agora) => {
  const d = new Date(agora);
  const min = Math.floor(d.getUTCMinutes() / 20) * 20;
  return String(d.getUTCHours()).padStart(2, '0') + String(min).padStart(2, '0');
};

/** Envia os arquivos das regiões coletadas agora e atualiza o índice. Erros não param a coleta. */
/**
 * `areas` (opcional): centro e raio de cada região, gravados no índice. O app usa para saber se o
 * avião está fora da área coletada (posição estimada, sem aviso) ou se sumiu dentro dela (aviso de
 * sem sinal). Campo novo e opcional no contrato v1: apps antigos ignoram.
 */
export async function publicarNoR2(r2, flightsByPoint, agora, atribuicao, indiceAnterior = {}, areas = {}) {
  const indice = { ...indiceAnterior };
  const falhas = [];
  for (const [regiao, voos] of flightsByPoint) {
    const arq = arquivoDaRegiao(regiao, voos, agora, atribuicao);
    const corpo = JSON.stringify(arq);
    try {
      await r2.enviar(`voos/${arq.regiao}.json`, corpo);
      indice[arq.regiao] = { nome: regiao, coletadoEm: arq.coletadoEm, voos: arq.voos.length, ...(areas[regiao] ? { area: areas[regiao] } : {}) };
    } catch (e) {
      falhas.push(String(e.message || e));
      continue;
    }
    // cópia para o "voo de ontem": lida pelo app só quando os dados ao vivo estão fora do ar
    try {
      await r2.enviar(`historico/${arq.regiao}/${faixaDoDia(agora)}.json`, corpo, { cacheControl: 'public, max-age=600' });
    } catch (e) {
      falhas.push('histórico: ' + String(e.message || e));
    }
  }
  if (Object.keys(indice).length) {
    const corpo = { versao: VERSAO, atualizadoEm: new Date(agora).toISOString(), regioes: indice };
    try {
      await r2.enviar('voos/indice.json', JSON.stringify(corpo));
    } catch (e) {
      falhas.push(String(e.message || e));
    }
  }
  return { indice, falhas };
}
