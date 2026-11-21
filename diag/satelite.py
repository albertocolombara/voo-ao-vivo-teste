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
