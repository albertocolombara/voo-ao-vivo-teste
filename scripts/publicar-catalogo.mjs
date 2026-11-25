// Publica o catálogo da coleção do Termi (colecao/catalogo.json) no R2, em /colecao/catalogo.json.
// O app junta o remoto com o que já conhecia: a coleção só cresce (RN-16). Por isso este script
// recusa o arquivo se algum id do catálogo publicado antes sumir, e confere o formato.
//
//   node scripts/publicar-catalogo.mjs            confere e publica (precisa dos segredos do R2)
//   node scripts/publicar-catalogo.mjs --conferir só confere
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { criarR2 } from '../src/r2.mjs';

const ARQUIVO = 'colecao/catalogo.json';
const texto = fs.readFileSync(ARQUIVO, 'utf8');
const c = JSON.parse(texto);

const erros = [];
if (c.versao !== 1) erros.push('versao tem de ser 1');
if (!Array.isArray(c.souvenirs) || c.souvenirs.length === 0) erros.push('sem souvenirs');
const ids = new Set();
for (const s of c.souvenirs ?? []) {
  if (!s.id || ids.has(s.id)) erros.push(`id vazio ou repetido: ${s.id}`);
  ids.add(s.id);
  if (!/^[A-Z]{2}$/.test(s.pais ?? '')) erros.push(`${s.id}: pais deve ser ISO alfa-2`);
  if (!s.nome) erros.push(`${s.id}: sem nome`);
  if (!['pais', 'cidade', 'rara'].includes(s.tipo)) erros.push(`${s.id}: tipo inválido`);
}
// A coleção só cresce: nenhum id da versão anterior do arquivo pode sumir.
try {
  const antes = JSON.parse(execSync(`git show HEAD~1:${ARQUIVO}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  for (const s of antes.souvenirs ?? []) if (!ids.has(s.id)) erros.push(`${s.id} sumiu (a coleção só cresce)`);
} catch {
  // primeira versão do arquivo
}
if (erros.length) {
  console.error('Catálogo recusado:\n- ' + erros.join('\n- '));
  process.exit(1);
}
console.log(`catálogo ok: ${ids.size} souvenirs`);

if (!process.argv.includes('--conferir')) {
  const r2 = criarR2();
  if (!r2) throw new Error('faltam os segredos do R2');
  const saida = JSON.stringify({ ...c, atualizadoEm: new Date().toISOString() });
  await r2.enviar('colecao/catalogo.json', saida, { cacheControl: 'public, max-age=3600' });
  console.log('publicado em colecao/catalogo.json');
}
