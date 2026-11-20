// Arquivos que o app lê no R2: um JSON por região e um índice.
// Formato em teste: ARCHITECTURE.md §9 do termi-app ("Contrato do cache de voos", [Proposta]).
// Só vira contrato depois de aprovado pelo Alberto.

export const VERSAO = 1;

/** "Londres-Paris" -> "londres-paris"; "São Paulo" -> "sao-paulo". */
export const slug = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const aeroporto = (a) => ({ iata: a.iata, icao: a.icao, nome: a.name, lat: a.lat, lon: a.lon });

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
      companhiaPais: null, // falta o mapa companhia -> país (ROADMAP, Fase 2)
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

/** Envia os arquivos das regiões coletadas agora e atualiza o índice. Erros não param a coleta. */
export async function publicarNoR2(r2, flightsByPoint, agora, atribuicao, indiceAnterior = {}) {
  const indice = { ...indiceAnterior };
  const falhas = [];
  for (const [regiao, voos] of flightsByPoint) {
    const arq = arquivoDaRegiao(regiao, voos, agora, atribuicao);
    try {
      await r2.enviar(`voos/${arq.regiao}.json`, JSON.stringify(arq));
      indice[arq.regiao] = { nome: regiao, coletadoEm: arq.coletadoEm, voos: arq.voos.length };
    } catch (e) {
      falhas.push(String(e.message || e));
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
