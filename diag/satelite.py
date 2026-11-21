"""Diagnóstico (temporário): amostras do mosaico ESA WorldCover S2 RGBNIR 2021 na grade do globo."""
import math, os, sys, time, traceback
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from rasterio.merge import merge

os.environ['AWS_NO_SIGN_REQUEST'] = 'YES'
os.environ['AWS_REGION'] = 'eu-central-1'
os.environ['GDAL_DISABLE_READDIR_ON_OPEN'] = 'EMPTY_DIR'
os.environ['CPL_VSIL_CURL_ALLOWED_EXTENSIONS'] = '.tif'


def arq(lat, lon):
    ns = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}"
    ew = f"{'E' if lon >= 0 else 'W'}{abs(lon):03d}"
    return f'/vsis3/esa-worldcover-s2/rgbnir/2021/{ns}/ESA_WorldCover_10m_2021_v200_{ns}{ew}_S2RGBNIR.tif'


def bloco(z, r, c):
    g = 288 / 2**z
    oeste, norte = -180 + c * g, 90 - r * g
    leste, sul = oeste + g, norte - g
    # arquivos 1x1 grau: nome = canto inferior esquerdo (sul, oeste)
    fontes = []
    for la in range(math.floor(sul), math.ceil(norte)):
        for lo in range(math.floor(oeste), math.ceil(leste)):
            try:
                fontes.append(rasterio.open(arq(la + 1 if False else la, lo)))
            except Exception:
                pass
    if not fontes:
        return None
    # nível de visão geral adequado: ~2x mais fino que o destino
    res = g / 512
    a, _ = merge(fontes, bounds=(oeste, sul, leste, norte), res=res, indexes=[3, 2, 1], resampling=Resampling.average, nodata=0)
    for f in fontes:
        f.close()
    return a


os.makedirs('saida', exist_ok=True)
PONTOS = {'rio': (-22.95, -43.2), 'manaus': (-3.1, -60.0), 'alpes': (46.5, 8.0), 'singapura': (1.3, 103.8), 'saopaulo': (-23.55, -46.63)}
for nome, (la, lo) in PONTOS.items():
    for z in (8, 9, 10, 11):
        g = 288 / 2**z
        r, c = int((90 - la) / g), int((lo + 180) / g)
        t = time.time()
        try:
            a = bloco(z, r, c)
            if a is None:
                print(nome, z, 'sem arquivos'); continue
            np.save(f'saida/{nome}_{z}.npy', a.astype(np.uint16))
            print(nome, z, a.shape, round(time.time() - t, 1), 's', [int(np.percentile(a[i][a[i] > 0], 50)) if (a[i] > 0).any() else 0 for i in range(3)])
        except Exception:
            traceback.print_exc()

# Prévias: Blue Marble (nível 7 ampliado) | WorldCover tom simples | WorldCover com a cor do Blue Marble
import io, urllib.request
from PIL import Image, ImageFilter

GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best'


def bm(z, r, c):
    # recorte do bloco do nível 7 que contém (z, r, c), ampliado a 512
    k = 2 ** (z - 7)
    r7, c7 = r // k, c // k
    u = f'{GIBS}/BlueMarble_NextGeneration/default/default/500m/7/{r7}/{c7}.jpeg'
    im = Image.open(io.BytesIO(urllib.request.urlopen(u, timeout=60).read())).convert('RGB')
    s = 512 // k
    x, y = (c % k) * s, (r % k) * s
    return np.asarray(im.crop((x, y, x + s, y + s)).resize((512, 512), Image.BICUBIC)).astype(np.float32) / 255


def tom(a):
    x = np.clip(a.transpose(1, 2, 0).astype(np.float32) / 10000 * 3.2, 0, 1)
    return x ** (1 / 1.8)


def casar(wc, ref, raio=24):
    # cor de baixa frequência do Blue Marble, detalhe do WorldCover
    def borra(x):
        return np.asarray(Image.fromarray((np.clip(x, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(raio))).astype(np.float32) / 255 + 1e-3
    return np.clip(wc * borra(ref) / borra(wc), 0, 1)


linhas = []
for nome, (la, lo) in PONTOS.items():
    for z in (9, 10, 11):
        p = f'saida/{nome}_{z}.npy'
        if not os.path.exists(p):
            continue
        g = 288 / 2**z
        r, c = int((90 - la) / g), int((lo + 180) / g)
        try:
            ref = bm(z, r, c)
        except Exception:
            traceback.print_exc(); continue
        raw = np.load(p)
        wc = tom(raw)
        vazio = (raw.sum(0) == 0)[..., None]
        wc = np.where(vazio, ref, wc)
        cs = np.where(vazio, ref, casar(wc, ref))
        fila = np.concatenate([ref, wc, cs], axis=1)
        im = Image.fromarray((fila * 255).astype(np.uint8))
        im.save(f'saida/{nome}_{z}.jpg', quality=82)
        b = io.BytesIO(); Image.fromarray((wc * 255).astype(np.uint8)).save(b, 'WEBP', quality=75, method=4)
        b2 = io.BytesIO(); Image.fromarray((cs * 255).astype(np.uint8)).save(b2, 'WEBP', quality=75, method=4)
        print(nome, z, 'webp KB', len(b.getvalue()) // 1024, len(b2.getvalue()) // 1024)
