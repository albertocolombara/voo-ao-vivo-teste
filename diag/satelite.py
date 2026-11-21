"""Diagnóstico (temporário): blocos do ESA WorldCover para as cenas de prévia da janela e do globo.

Saída em saida2/ (commitada de volta no branch):
  c{z}_{r}_{c}.jpg  refletância do Sentinel-2 (composto 2021) em raiz quadrada: v = sqrt(refl/10000)*255
  b{z}_{r}_{c}.png  fração de área construída (classe 50 do mapa WorldCover 2021), 0..255
"""
import math, os, time, traceback
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.merge import merge
from rasterio.windows import from_bounds
from PIL import Image

os.environ.update(AWS_NO_SIGN_REQUEST='YES', AWS_REGION='eu-central-1', GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',
                  CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif', GDAL_HTTP_MAX_RETRY='4')
OUT = 'saida2'
os.makedirs(OUT, exist_ok=True)


def nome(lat, lon, w=2, ww=3):
    return f"{'N' if lat >= 0 else 'S'}{abs(lat):0{w}d}{'E' if lon >= 0 else 'W'}{abs(lon):0{ww}d}"


def limites(z, r, c):
    g = 288 / 2**z
    o, n = -180 + c * g, 90 - r * g
    return o, n - g, o + g, n


def cor(z, r, c):
    o, s, l, n = limites(z, r, c)
    fontes = []
    for la in range(math.floor(s), math.ceil(n)):
        for lo in range(math.floor(o), math.ceil(l)):
            nm = nome(la, lo)
            try:
                fontes.append(rasterio.open(f'/vsis3/esa-worldcover-s2/rgbnir/2021/{nm[:3]}/ESA_WorldCover_10m_2021_v200_{nm}_S2RGBNIR.tif'))
            except Exception:
                pass
    if not fontes:
        return None
    a, _ = merge(fontes, bounds=(o, s, l, n), res=(l - o) / 512, indexes=[3, 2, 1], resampling=Resampling.average, nodata=0)
    for f in fontes:
        f.close()
    return a


def construido(z, r, c):
    o, s, l, n = limites(z, r, c)
    acc = np.zeros((512, 512), np.float32)
    achou = False
    for la in range(math.floor(s / 3) * 3, math.ceil(n / 3) * 3, 3):
        for lo in range(math.floor(o / 3) * 3, math.ceil(l / 3) * 3, 3):
            try:
                ds = rasterio.open(f'/vsis3/esa-worldcover/v200/2021/map/ESA_WorldCover_10m_2021_v200_{nome(la, lo)}_Map.tif')
            except Exception:
                continue
            with ds:
                w = from_bounds(max(o, ds.bounds.left), max(s, ds.bounds.bottom), min(l, ds.bounds.right), min(n, ds.bounds.top), ds.transform)
                w = w.round_offsets().round_lengths()
                if w.width <= 0 or w.height <= 0:
                    continue
                m = (ds.read(1, window=w) == 50).astype(np.float32)
                achou = True
                # coloca no quadro de 512 do bloco
                wb = ds.window_bounds(w)
                x0 = round((wb[0] - o) / (l - o) * 512); x1 = round((wb[2] - o) / (l - o) * 512)
                y0 = round((n - wb[3]) / (n - s) * 512); y1 = round((n - wb[1]) / (n - s) * 512)
                if x1 > x0 and y1 > y0:
                    im = Image.fromarray(m).resize((x1 - x0, y1 - y0), Image.BOX)
                    acc[y0:y1, x0:x1] = np.maximum(acc[y0:y1, x0:x1], np.asarray(im))
    return acc if achou else None


CENAS = {'seul': (37.35, 126.75), 'bahia': (-12.5, -40.5), 'saopaulo': (-23.55, -46.63), 'rio': (-22.9, -43.2)}
pedidos = set()
for la, lo in CENAS.values():
    for z, tipo in ((10, 'c'), (8, 'c'), (9, 'b'), (10, 'b')):
        g = 288 / 2**z
        r0 = math.floor((90 - la) / g) - 2; c0 = math.floor((lo + 180) / g) - 2
        for i in range(4):
            for j in range(4):
                pedidos.add((tipo, z, r0 + i, c0 + j))


def fazer(p):
    tipo, z, r, c = p
    t = time.time()
    try:
        if tipo == 'c':
            a = cor(z, r, c)
            if a is None or not a.any():
                return p, 'vazio', time.time() - t
            v = np.sqrt(np.clip(a.astype(np.float32) / 10000, 0, 1)) * 255
            Image.fromarray(v.transpose(1, 2, 0).astype(np.uint8)).save(f'{OUT}/c{z}_{r}_{c}.jpg', quality=93)
        else:
            a = construido(z, r, c)
            if a is None or a.max() == 0:
                return p, 'vazio', time.time() - t
            Image.fromarray((a * 255).round().astype(np.uint8)).save(f'{OUT}/b{z}_{r}_{c}.png', optimize=True)
        return p, 'ok', time.time() - t
    except Exception as e:
        traceback.print_exc()
        return p, repr(e), time.time() - t


with ThreadPoolExecutor(8) as ex:
    for p, st, dt in ex.map(fazer, sorted(pedidos)):
        print(p, st, round(dt, 1))
