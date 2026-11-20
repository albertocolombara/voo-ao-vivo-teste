# Blocos de paisagem da janela

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
