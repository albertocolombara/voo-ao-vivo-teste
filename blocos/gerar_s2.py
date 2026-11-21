"""Blocos de paisagem da janela e do globo do Termi a partir do Sentinel-2 (ESA WorldCover 2021).

Substitui o Landsat WELD (2000) nas camadas `w10` e `w8` (mesma grade, mesmas chaves no R2) e cria a
camada de luzes `l10`, que substitui a `i9` (GMIS):

  w10  cor, nível 10 (~61 m/px)   janela (perto do avião) e globo de perto
  w8   cor, nível 8 (~244 m/px)   janela (distância média) e globo
  l10  luzes, nível 10            R = fração de área construída (WorldCover, 10 m)
                                  G = luz real à noite (Black Marble 2016, VIIRS, 500 m)

Fontes (todas com uso comercial permitido):
  - ESA WorldCover Sentinel-2 RGBNIR median composite 2021 (CC BY 4.0), s3://esa-worldcover-s2
  - ESA WorldCover 10 m 2021 v200, mapa de cobertura (CC BY 4.0), s3://esa-worldcover
  - NASA GIBS: Blue Marble (mar), Black Marble (luzes), OSM Land/Water (máscara do mar)
Crédito obrigatório (CC BY): "ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data
(2021) processed by ESA WorldCover consortium". Vai na tela de créditos do app.

Como funciona: o trabalho é dividido por bloco do nível 8 (1,125°). Para cada um, lê de uma vez o
Sentinel-2 da área (com margem), gera os 16 blocos do nível 10 e o do nível 8, e, se há luz, lê o mapa
de cobertura e gera os blocos de luzes. Cor: curvas por canal casadas com o Landsat atual (a janela
foi calibrada nele), uma para terra e outra para água (curvas_s2.json). Água: rios e lagos ficam com
a cor real; o mar (OSM) usa a água do satélite perto da costa e passa ao Blue Marble onde o mosaico
de satélite acaba. Bloco sem terra nem água interior não é enviado (o app trata 404 como vazio).

Uso:
  python blocos/gerar_s2.py --amostra 300                    (projeta o tamanho total, sem enviar)
  python blocos/gerar_s2.py --parte 0 --partes 20           (envia ao R2; retoma de onde parou)
  python blocos/gerar_s2.py --limite 2 --saida /tmp/s2       (teste em disco)
"""

import argparse
import gzip
import io
import json
import math
import os
import random
import sys
import time
import urllib.request
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

os.environ.update(
    AWS_NO_SIGN_REQUEST='YES',
    AWS_REGION='eu-central-1',
    GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif',
    GDAL_HTTP_MAX_RETRY='5',
    GDAL_HTTP_RETRY_DELAY='2',
    GDAL_CACHEMAX='512',
    VSI_CACHE='TRUE',
)

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

BASE = Path(__file__).parent
GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best'
UA = 'termi-blocos/2.0 (+https://github.com/albertocolombara/voo-ao-vivo-teste)'
QUALIDADE = {'w10': 78, 'w8': 78, 'l10': 80}
CACHE_CONTROL = 'public, max-age=604800'
MARGEM = 80  # px do nível 10 em volta do grupo (~5 km), para a água do mar sumir sem emenda
LUZ_MIN = 0.02  # bloco de luzes só onde há área construída com luz de verdade

_C = json.loads((BASE / 'curvas_s2.json').read_text())
CURVAS = {k: (np.array(v['x'], np.float32), np.array(v['y'], np.float32)) for k, v in _C.items() if k != 'nota'}


# ---------- grade ----------

def graus(z):
    return 288 / 2**z


def limites(z, r, c):
    g = graus(z)
    o, n = -180 + c * g, 90 - r * g
    return o, n - g, o + g, n


# ---------- fontes ----------

def http(url, tentativas=5):
    for t in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if t == tentativas - 1:
                raise
        except Exception:
            if t == tentativas - 1:
                raise
        time.sleep(2**t)


def gibs(nome, data, tms, ext, z, r, c, modo):
    b = http(f'{GIBS}/{nome}/default/{data}/{tms}/{z}/{r}/{c}.{ext}')
    if b is None:
        return None
    return np.asarray(Image.open(io.BytesIO(b)).convert(modo)).astype(np.float32) / 255


def recorte_ampliado(img, z_img, r_img, c_img, z, r, c, lado):
    """Parte de um bloco de nível menor (z_img) que cobre o bloco (z, r, c), ampliada a `lado` px."""
    k = 2 ** (z - z_img)
    s = img.shape[0] // k
    x, y = (c - c_img * k) * s, (r - r_img * k) * s
    parte = img[y:y + s, x:x + s]
    import cv2

    return cv2.resize(parte, (lado, lado), interpolation=cv2.INTER_CUBIC)


def nome_1grau(lat, lon):
    return f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}{'E' if lon >= 0 else 'W'}{abs(lon):03d}"


def ler_s2(o, s, l, n, px):
    """Refletância (4, px, px) R, G, B, NIR do composto 2021 (0 = sem dado)."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.merge import merge

    fontes = []
    for la in range(math.floor(s), math.ceil(n)):
        for lo in range(math.floor(o), math.ceil(l)):
            nm = nome_1grau(la, lo)
            try:
                fontes.append(rasterio.open(f'/vsis3/esa-worldcover-s2/rgbnir/2021/{nm[:3]}/ESA_WorldCover_10m_2021_v200_{nm}_S2RGBNIR.tif'))
            except Exception:
                pass  # sem arquivo: oceano
    if not fontes:
        return None
    try:
        a, _ = merge(fontes, bounds=(o, s, l, n), res=(l - o) / px, indexes=[3, 2, 1, 4], resampling=Resampling.average, nodata=0)
    finally:
        for f in fontes:
            f.close()
    a = a[:, :px, :px]
    if a.shape[1] < px or a.shape[2] < px:
        a = np.pad(a, ((0, 0), (0, px - a.shape[1]), (0, px - a.shape[2])))
    return a.astype(np.float32) / 10000


def ler_construido(o, s, l, n, px):
    """Fração de área construída (classe 50 do WorldCover 2021) em (px, px)."""
    import cv2
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds

    # lido a ~20 m (vizinho mais próximo) e reduzido por área
    alvo = px * 3
    out = np.zeros((alvo, alvo), np.uint8)
    achou = False
    for la in range(math.floor(s / 3) * 3, math.ceil(n / 3) * 3, 3):
        for lo in range(math.floor(o / 3) * 3, math.ceil(l / 3) * 3, 3):
            try:
                ds = rasterio.open(f'/vsis3/esa-worldcover/v200/2021/map/ESA_WorldCover_10m_2021_v200_{nome_1grau(la, lo)}_Map.tif')
            except Exception:
                continue
            with ds:
                b = ds.bounds
                bo, bs, bl, bn = max(o, b.left), max(s, b.bottom), min(l, b.right), min(n, b.top)
                if bl <= bo or bn <= bs:
                    continue
                x0 = round((bo - o) / (l - o) * alvo); x1 = round((bl - o) / (l - o) * alvo)
                y0 = round((n - bn) / (n - s) * alvo); y1 = round((n - bs) / (n - s) * alvo)
                if x1 <= x0 or y1 <= y0:
                    continue
                w = from_bounds(bo, bs, bl, bn, ds.transform)
                m = ds.read(1, window=w, out_shape=(y1 - y0, x1 - x0), resampling=Resampling.nearest)
                out[y0:y1, x0:x1] = (m == 50).astype(np.uint8) * 255
                achou = True
    if not achou:
        return None
    return cv2.resize(out, (px, px), interpolation=cv2.INTER_AREA).astype(np.float32) / 255


# ---------- cor ----------

def curva(a, nome):
    x, y = CURVAS[nome]
    out = np.empty(a.shape, np.float32)
    for ch in range(3):
        out[ch] = np.interp(a[ch], np.concatenate([[0], x[ch], [1]]), np.concatenate([[0], y[ch], [1]]))
    return out


def cor_do_grupo(a, oceano, mar_bm, px_km):
    """RGB (3, H, W) 0..1 e a máscara do que veio do satélite (terra e água interior)."""
    from scipy.ndimage import distance_transform_edt

    rgb4 = a[:3]
    nir = a[3]
    valido = rgb4.max(0) > 0.0004
    agua = valido & ((rgb4[1] - nir) / (rgb4[1] + nir + 1e-6) > 0.0)
    terra = valido & ~agua
    # mar: água do satélite some aos poucos até onde o mosaico acaba (~4 km)
    dist = distance_transform_edt(valido) * px_km if (~valido).any() else np.full(valido.shape, 99.0, np.float32)
    t = np.clip(dist / 4.0, 0, 1)
    al_agua = (1 - oceano) + oceano * (t * t * (3 - 2 * t))
    al = np.where(terra, 1.0, np.where(agua, al_agua, 0.0)).astype(np.float32)
    rgb = np.where(agua[None], curva(rgb4, 'agua'), curva(rgb4, 'terra'))
    rgb = rgb * al[None] + mar_bm * (1 - al[None])
    # "veio do satélite": terra ou água interior (o mar sozinho não justifica um bloco)
    proprio = terra | (agua & (oceano < 0.5))
    return rgb, proprio


def webp(rgb, q):
    im = Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8).transpose(1, 2, 0))
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=q, method=4)
    return buf.getvalue()


# ---------- um grupo (bloco do nível 8) ----------

def grupo(r8, c8, filhos_w10, faz_w8, filhos_l10):
    """Devolve {chave: bytes} dos blocos do grupo e estatísticas."""
    import cv2
    from scipy.ndimage import gaussian_filter

    o, s, l, n = limites(8, r8, c8)
    lado = 2048  # nível 10 dentro do grupo
    g10 = graus(10) / 512
    m = MARGEM
    a = ler_s2(o - m * g10, s - m * g10, l + m * g10, n + m * g10, lado + 2 * m)
    saida = {}
    if a is not None and a[:3].max() > 0:
        r7, c7 = r8 // 2, c8 // 2
        dia7 = gibs('BlueMarble_NextGeneration', 'default', '500m', 'jpeg', 7, r7, c7, 'RGB')
        mar = recorte_ampliado(dia7, 7, r7, c7, 8, r8, c8, lado) if dia7 is not None else np.zeros((lado, lado, 3), np.float32)
        mar = np.pad(mar, ((m, m), (m, m), (0, 0)), mode='edge').transpose(2, 0, 1)
        osm = gibs('OSM_Land_Water_Map', 'default', '250m', 'png', 8, r8, c8, 'L')
        oc = (osm > 100 / 255).astype(np.float32) if osm is not None else np.zeros((512, 512), np.float32)
        oc = cv2.resize(oc, (lado, lado), interpolation=cv2.INTER_LINEAR)
        oc = np.clip(gaussian_filter(np.pad(oc, m, mode='edge'), 6), 0, 1)
        rgb, proprio = cor_do_grupo(a, oc, mar, graus(10) * 111.2 / 512)
        rgb, proprio = rgb[:, m:m + lado, m:m + lado], proprio[m:m + lado, m:m + lado]
        for (r, c) in filhos_w10:
            i, j = (r - r8 * 4) * 512, (c - c8 * 4) * 512
            if proprio[i:i + 512, j:j + 512].any():
                saida[f'blocos/w10/{r}/{c}.webp'] = webp(rgb[:, i:i + 512, j:j + 512], QUALIDADE['w10'])
        if faz_w8 and proprio.any():
            red = cv2.resize(rgb.transpose(1, 2, 0), (512, 512), interpolation=cv2.INTER_AREA).transpose(2, 0, 1)
            saida[f'blocos/w8/{r8}/{c8}.webp'] = webp(red, QUALIDADE['w8'])
    if filhos_l10:
        r7, c7 = r8 // 2, c8 // 2
        noite7 = gibs('VIIRS_Black_Marble', '2016-01-01', '500m', 'png', 7, r7, c7, 'L')
        if noite7 is not None:
            luz = np.clip(recorte_ampliado(noite7, 7, r7, c7, 8, r8, c8, lado), 0, 1)
            if luz.max() > LUZ_MIN:
                built = ler_construido(o, s, l, n, lado)
                if built is not None:
                    for (r, c) in filhos_l10:
                        i, j = (r - r8 * 4) * 512, (c - c8 * 4) * 512
                        b, g = built[i:i + 512, j:j + 512], luz[i:i + 512, j:j + 512]
                        if (b * g).max() < LUZ_MIN:
                            continue
                        saida[f'blocos/l10/{r}/{c}.webp'] = webp(np.stack([b, g, np.zeros_like(b)]), QUALIDADE['l10'])
    return saida


# ---------- R2 ----------

def cliente_r2():
    import boto3
    from botocore.config import Config

    return boto3.client(
        's3',
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
        aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto',
        config=Config(retries={'max_attempts': 6, 'mode': 'standard'}, max_pool_connections=16),
    )


def progresso(parte, partes):
    return f'blocos/_s2/feitos-{parte}-de-{partes}.txt'


def ler_progresso(s3, chave):
    try:
        corpo = s3.get_object(Bucket=os.environ['R2_BUCKET'], Key=chave)['Body'].read().decode()
        return {tuple(map(int, x.split())) for x in corpo.splitlines() if x.strip()}
    except Exception:
        return set()


_S3 = None


def trabalhar(args):
    """Roda num processo: gera o grupo e envia (ou grava em disco)."""
    global _S3
    r8, c8, w10, w8, l10, saida_dir, enviar = args
    t = time.time()
    try:
        blocos = grupo(r8, c8, w10, w8, l10)
    except Exception as e:
        return (r8, c8), None, repr(e), time.time() - t
    tam = {}
    for k, v in blocos.items():
        cam = k.split('/')[1]
        tam[cam] = tam.get(cam, 0) + len(v)
        tam[cam + '#'] = tam.get(cam + '#', 0) + 1
        if saida_dir:
            p = Path(saida_dir) / k
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(v)
        elif enviar:
            if _S3 is None:
                _S3 = cliente_r2()
            _S3.put_object(Bucket=os.environ['R2_BUCKET'], Key=k, Body=v, ContentType='image/webp', CacheControl=CACHE_CONTROL)
    return (r8, c8), tam, None, time.time() - t


def candidatos():
    def ler(nome):
        with gzip.open(BASE / 'candidatos' / f'{nome}.txt.gz', 'rt') as f:
            return [tuple(map(int, x.split())) for x in f if x.strip()]

    grupos = {}
    for r, c in ler('w10'):
        g = grupos.setdefault((r // 4, c // 4), [[], False, []])
        g[0].append((r, c))
        g[2].append((r, c))  # luzes só em terra: mesmos candidatos
    for r, c in ler('w8'):
        grupos.setdefault((r, c), [[], False, []])[1] = True
    return grupos, len(ler('w10')), len(ler('w8'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--parte', type=int, default=0)
    ap.add_argument('--partes', type=int, default=1)
    ap.add_argument('--amostra', type=int, default=0, help='N grupos aleatórios: projeta o tamanho total, sem enviar')
    ap.add_argument('--limite', type=int, default=0)
    ap.add_argument('--saida', help='grava em disco em vez de enviar')
    ap.add_argument('--processos', type=int, default=4)
    a = ap.parse_args()

    grupos, n_w10, n_w8 = candidatos()
    chaves = sorted(grupos)
    if a.amostra:
        random.seed(7)
        meus = random.sample(chaves, a.amostra)
    else:
        meus = chaves[a.parte::a.partes]
    if a.limite:
        meus = meus[: a.limite]

    enviar = not a.saida and not a.amostra
    s3, feitos = None, set()
    if enviar:
        # retoma: os grupos terminados de cada parte ficam num arquivo pequeno no R2
        s3 = cliente_r2()
        feitos = ler_progresso(s3, progresso(a.parte, a.partes))
        print(f'grupos já feitos nesta parte: {len(feitos)}', flush=True)
    tarefas = [(g[0], g[1], *grupos[g], a.saida, enviar) for g in meus if g not in feitos]
    print(f'grupos: {len(tarefas)} de {len(meus)} (parte {a.parte}/{a.partes})', flush=True)
    tot, erros, t0 = {}, 0, time.time()
    with ProcessPoolExecutor(a.processos) as ex:
        futs = [ex.submit(trabalhar, t) for t in tarefas]
        for k, f in enumerate(as_completed(futs), 1):
            g, tam, erro, dt = f.result()
            if erro:
                erros += 1
                if erros <= 30:
                    print(f'erro grupo {g}: {erro}', file=sys.stderr, flush=True)
                continue
            for kk, v in tam.items():
                tot[kk] = tot.get(kk, 0) + v
            feitos.add(g)
            if enviar and (k % 100 == 0 or k == len(futs)):
                corpo = '\n'.join(f'{x} {y}' for x, y in sorted(feitos))
                s3.put_object(Bucket=os.environ['R2_BUCKET'], Key=progresso(a.parte, a.partes), Body=corpo.encode(), ContentType='text/plain')
            if k % 50 == 0 or k == len(futs):
                mb = {kk: round(v / 1e6, 1) for kk, v in tot.items() if '#' not in kk}
                print(f'{k}/{len(futs)} · {time.time() - t0:.0f}s · MB {mb} · blocos { {kk[:-1]: v for kk, v in tot.items() if "#" in kk} } · erros {erros}', flush=True)

    if a.amostra:
        n = len(meus)
        total_grupos = len(chaves)
        print('--- projeção para o mundo (menos a Antártida) ---')
        soma = 0
        for cam in ('w10', 'w8', 'l10'):
            gb = tot.get(cam, 0) / n * total_grupos / 1e9
            blocos = tot.get(cam + '#', 0) / n * total_grupos
            soma += gb
            print(f'{cam}: ~{blocos:,.0f} blocos, ~{gb:.2f} GB (média {tot.get(cam, 0) / max(1, tot.get(cam + "#", 0)) / 1024:.1f} KB)')
        print(f'total: ~{soma:.2f} GB; candidatos w10 {n_w10}, w8 {n_w8}; tempo por grupo {(time.time() - t0) / max(1, n) * a.processos:.1f}s')
    if erros > max(5, len(tarefas) // 100):
        sys.exit(1)


if __name__ == '__main__':
    main()
