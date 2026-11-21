# Blocos de paisagem da janela

> **Desde 21/11/2026 as camadas vêm do Sentinel-2 (ESA WorldCover 2021):** `gerar_s2.py`, workflow
> "Blocos de paisagem (Sentinel-2)". `w10` e `w8` foram regravadas por cima do Landsat; a camada de
> luzes passou a ser `l9` (R = área construída do WorldCover, G = luz real do Black Marble), no lugar
> da `i9`. O globo do app usa os mesmos blocos de perto. Amostra de 160 grupos: ~7,3 GB (`w10`, WebP 70),
> ~0,5 GB (`w8`), ~0,25 GB (`l9`). Crédito obrigatório (CC BY 4.0): "© ESA WorldCover project 2021 /
> Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium". A máscara
> do mar vem do OSM Land/Water do GIBS (© colaboradores do OpenStreetMap, ODbL).
> Depois da geração, `limpar_antigos.py` (modo "limpar" do workflow) apaga os blocos do Landsat que
> sobraram; a `i9` só sai quando nenhum app em teste a usar.
>
> O texto abaixo descreve o gerador antigo (`gerar.py`, Landsat), mantido para referência.

Gera os blocos de terra que a janela do Termi desenha em volta do avião e envia ao Cloudflare R2 (`blocos/{camada}/{linha}/{coluna}.webp`).

| Camada | Fonte (NASA GIBS, EPSG:4326) | Nível | Uso |
|---|---|---|---|
| `w10` | Landsat WELD, cor real anual | 10 (~61 m/px) | perto do avião |
| `w8` | Landsat WELD, cor real anual | 8 (~244 m/px) | distância média |
| `i9` | GMIS (áreas construídas), em cinza | 9 | cidades à noite |

- Cobre toda a terra menos a Antártida (decisão do Alberto, 19/11/2026). Listas de blocos em `candidatos/` (terra com 1 bloco de margem na costa).
- Mesmo formato do protótipo: WebP qualidade 78, 512×512. Blocos só de oceano ou sem área construída não são enviados.
- Tamanho medido numa amostra: ~7,8 GB no total (w10 ~7,2 GB, w8 ~0,55 GB, i9 ~0,16 GB).
- Para gerar: Actions → "Blocos de paisagem" → escolher a camada. Retoma de onde parou.
- Teste local, sem enviar: `python blocos/gerar.py --camada w10 --limite 20 --saida /tmp/teste`.
