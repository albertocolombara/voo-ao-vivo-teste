"""Diagnóstico (temporário): acesso e amostras de mosaicos de satélite para o globo do Termi."""
import json, math, os, sys, traceback
import boto3
from botocore import UNSIGNED
from botocore.config import Config

s3 = boto3.client('s3', region_name='eu-central-1', config=Config(signature_version=UNSIGNED))
out = {}
for bucket, prefix in [('eox-s2maps', ''), ('eox-s2maps', 'tiles/'), ('eox-s2maps', 'tiles/10/'), ('esa-worldcover-s2', ''), ('esa-worldcover-s2', 'rgbnir/2021/')]:
    try:
        r = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, Delimiter='/', MaxKeys=20)
        out[f'{bucket}/{prefix}'] = {
            'pastas': [p['Prefix'] for p in r.get('CommonPrefixes', [])][:20],
            'arquivos': [(o['Key'], o['Size']) for o in r.get('Contents', [])][:20],
        }
    except Exception as e:
        out[f'{bucket}/{prefix}'] = repr(e)
print(json.dumps(out, indent=1))

import rasterio
from rasterio.windows import from_bounds
from rasterio.enums import Resampling
import numpy as np
from PIL import Image

os.environ['AWS_NO_SIGN_REQUEST'] = 'YES'
os.environ['AWS_REGION'] = 'eu-central-1'
PONTOS = {'rio': (-22.95, -43.2), 'manaus': (-3.1, -60.0), 'alpes': (46.5, 8.0), 'singapura': (1.3, 103.8)}
os.makedirs('saida', exist_ok=True)
# lado da amostra: um bloco do nível 10 da nossa grade (0,28125°), 512 px ≈ 61 m/px
LADO = 288 / 2**10
for nome, (la, lo) in PONTOS.items():
    lat0 = math.floor(la / 3) * 3
    lon0 = math.floor(lo / 3) * 3
    ns = f"{'N' if lat0 >= 0 else 'S'}{abs(lat0):02d}"
    ew = f"{'E' if lon0 >= 0 else 'W'}{abs(lon0):03d}"
    url = f'/vsis3/esa-worldcover-s2/rgbnir/2021/{ns}/ESA_WorldCover_10m_2021_v200_{ns}{ew}_S2RGBNIR.tif'
    try:
        with rasterio.open(url) as ds:
            if nome == 'rio':
                print('worldcover', ds.profile, ds.overviews(1), ds.descriptions, file=sys.stderr)
            w = from_bounds(lo - LADO / 2, la - LADO / 2, lo + LADO / 2, la + LADO / 2, ds.transform)
            a = ds.read([1, 2, 3], window=w, out_shape=(3, 512, 512), resampling=Resampling.average).astype(np.float32)
            print(nome, 'wc', [float(np.percentile(a[i], 2)) for i in range(3)], [float(np.percentile(a[i], 98)) for i in range(3)])
            np.save(f'saida/{nome}_wc.npy', a)
    except Exception:
        traceback.print_exc()
