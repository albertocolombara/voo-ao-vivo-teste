# Teste de voos ao vivo

Coleta automática e gratuita para responder uma pergunta antes de construir o app:
**os dados gratuitos do adsb.lol sustentam o "embarque num voo que está no ar agora"?**

Roda no **GitHub Actions** (de graça em repositório público) e publica um painel no **GitHub Pages**.

A cada 10 minutos ele:

1. consulta 3 regiões do Brasil e 1 região do mundo (em rodízio entre 8);
2. busca a rota de cada avião e descarta as rotas que não batem com a posição e o rumo;
3. calcula quando cada voo pousa e conta quantos há em cada faixa de tempo de foco;
4. acompanha alguns voos brasileiros até o pouso para medir o erro da previsão;
5. salva as medições na pasta `data/` do próprio repositório.

Uma vez por hora, ele atualiza o painel.

São 4 chamadas por coleta ao adsb.lol, no máximo **576 por dia**, dentro da chave gratuita (1.000 por dia).

## Do que você precisa

- **Conta no GitHub** (gratuita).
- **Chave gratuita do adsb.lol (adhoc, 1.000 chamadas por dia)**, pedida no formulário indicado em https://api.adsb.lol/docs. Sem chave, o limite é por IP, e o IP do GitHub é compartilhado com outros usuários; a cota pode acabar por causa deles.

Não precisa instalar nada no computador. Tudo é feito pelo site do GitHub.

## Configurar (uns 10 minutos)

1. **Crie um repositório público** no GitHub, por exemplo `voo-ao-vivo-teste`.
   Precisa ser público: em repositório privado, a cota gratuita de minutos do Actions não cobre uma coleta a cada 10 minutos.
2. **Envie os arquivos.** Descompacte o zip. No repositório, clique em *Add file → Upload files* e arraste **todo o conteúdo** da pasta, incluindo a pasta `.github`. Clique em *Commit changes*.
3. **Cadastre a chave.** *Settings → Secrets and variables → Actions → New repository secret*.
   Nome: `ADSBLOL_KEY`. Valor: a chave do adsb.lol.
4. **Ligue o painel.** *Settings → Pages*. Em *Source*, escolha **GitHub Actions**.
5. **Libere a gravação.** *Settings → Actions → General → Workflow permissions*: marque **Read and write permissions** e salve.
6. **Rode a primeira coleta.** Aba *Actions → Coleta de voos → Run workflow*. Daí em diante, ele roda sozinho a cada 10 minutos.

O painel fica em `https://SEU-USUARIO.github.io/voo-ao-vivo-teste/`.
Na mesma pasta estão `stats.json` (os números) e `flights.json` (a lista de voos, do jeito que o app vai consumir).

## Como ler o painel depois de 1 a 2 semanas

| Pergunta | Onde olhar | Bom sinal |
|---|---|---|
| Tem voo para cada tempo de foco a qualquer hora? | Tabela "Pior caso" | Sem vermelho nas faixas 25–49, 50–89 e 90–179 min, principalmente de madrugada |
| As rotas são confiáveis? | "Rotas coerentes (Brasil)" | 75% ou mais |
| O pouso acontece quando dissemos? | "Pousos dentro de ±10 min" | 80% ou mais |
| A cobertura aguenta? | "Perdidos" | Bem menos que "Pousaram" |
| A API aguenta? | "Recusas por cota" e "falhas" | Perto de zero |

Os limites de "bom sinal" são pontos de partida, não regras. Se a madrugada vier vazia no Brasil, a resposta pode ser mostrar voos do mundo nesse horário (a tabela das regiões do mundo ajuda a decidir).

## Quando terminar

Para parar: aba *Actions → Coleta de voos → ⋯ → Disable workflow*. Os dados continuam na pasta `data/`.

## Limitações conhecidas

- O GitHub não garante o horário dos agendamentos: em momentos de muito uso, uma coleta pode atrasar ou ser pulada. O painel mostra quantas amostras cada hora teve.
- O repositório é público, então os dados coletados também são. Eles só têm números de voo, que já são públicos, e contagens. A chave do adsb.lol fica guardada como segredo e não aparece.
- O pouso é estimado a partir da última posição vista, porque a coleta é a cada 10 minutos.
- "Perdidos" mistura falha de cobertura com rota errada que passou no filtro.
- As regiões do mundo só são consultadas a cada 80 minutos; servem para ter ordem de grandeza.
- A previsão inclui 8 minutos fixos para aproximação e pouso. Se o viés mediano ficar longe de zero, ajuste esse valor em `etaMin`, no arquivo `src/index.js`.
- `flights.json` é atualizado uma vez por hora, então serve para conferir o formato, não para uso real.

## Rodar no seu computador (opcional)

Com Node.js 22 ou mais novo:

- `npm run coleta` faz uma coleta real. Defina antes a variável de ambiente `ADSBLOL_KEY`.
- `npm test` simula 24 horas com um adsb.lol falso e gera `test/out/public/index.html`. Os números da simulação são inventados; servem só para conferir que o código funciona.

Dados de voo: adsb.lol, licença ODbL 1.0. O app final precisa mostrar essa atribuição.
