"""
Blocos do globo do Termi (Blue Marble de dia, Black Marble à noite), recomprimidos em WebP e
enviados ao R2 em `globo/{dia|noite}/{z}/{linha}/{coluna}.webp`, níveis 1 a 7 da grade EPSG:4326
do GIBS ("500m": no nível z cada bloco cobre 288/2^z graus).

Por quê (20/11/2026): o app baixava direto do GIBS. O Black Marble só existe em PNG (~300 KB por
bloco) e cada abertura do globo pedia até 48 blocos (~17 MB medidos pelo Alberto). Em WebP: ~30 KB
(noite) e ~18 KB (dia).
Blocos noturnos todos pretos (oceano) não são enviados: o app trata 404 como "sem luzes".
Retoma de onde parou (pula o que já está no R2). Uso:
  python globo/gerar.py --parte 0 --partes 8          (envia ao R2; precisa das variáveis R2_*)
  python globo/gerar.py --saida X --limite 20         (teste em disco)
"""
import argparse
import io
import math
import os
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best'
UA = 'termi-globo/1.0 (+https://github.com/albertocolombara/voo-ao-vivo-teste)'
CAMADAS = {
    'dia': ('BlueMarble_NextGeneration', 'default', 'jpeg'),
    'noite': ('VIIRS_Black_Marble', '2016-01-01', 'png'),
}
NIVEIS = range(1, 8)
QUALIDADE = 75


def blocos():
    out = []
    for z in NIVEIS:
        g = 288 / 2**z
        for r in range(math.ceil(180 / g)):
            for c in range(math.ceil(360 / g)):
                for camada in CAMADAS:
                    out.append((camada, z, r, c))
    return out


def baixar(camada, z, r, c, tentativas=4):
    nome, data, ext = CAMADAS[camada]
    url = f'{GIBS}/{nome}/default/{data}/500m/{z}/{r}/{c}.{ext}'
    for t in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read()
        except Exception:
            if t == tentativas - 1:
                raise
            time.sleep(2**t)


def converter(camada, dados):
    img = Image.open(io.BytesIO(dados)).convert('RGB')
    if camada == 'noite' and np.asarray(img).max() < 8:
        return None  # sem luzes: o app trata como vazio
    buf = io.BytesIO()
    img.save(buf, 'WEBP', quality=QUALIDADE, method=4)
    return buf.getvalue()


def cliente_r2():
    import boto3
    from botocore.config import Config

    return boto3.client(
        's3',
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
        aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto',
        config=Config(retries={'max_attempts': 5, 'mode': 'standard'}, max_pool_connections=32),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--parte', type=int, default=0)
    ap.add_argument('--partes', type=int, default=1)
    ap.add_argument('--limite', type=int, default=0)
    ap.add_argument('--saida')
    ap.add_argument('--paralelo', type=int, default=8)
    a = ap.parse_args()

    meus = blocos()[a.parte :: a.partes]
    if a.limite:
        meus = meus[: a.limite]
    s3 = bucket = None
    pular = set()
    if not a.saida:
        s3, bucket = cliente_r2(), os.environ['R2_BUCKET']
        for p in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix='globo/'):
            for o in p.get('Contents', []):
                pular.add(o['Key'])

    cont = {'enviados': 0, 'vazios': 0, 'pulados': 0, 'erros': 0, 'bytes': 0}
    trava = threading.Lock()
    t0 = time.time()

    def um(b):
        camada, z, r, c = b
        chave = f'globo/{camada}/{z}/{r}/{c}.webp'
        if chave in pular:
            with trava:
                cont['pulados'] += 1
            return
        try:
            webp = converter(camada, baixar(camada, z, r, c))
            if webp is None:
                with trava:
                    cont['vazios'] += 1
                return
            if a.saida:
                p = Path(a.saida) / chave
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(webp)
            else:
                s3.put_object(Bucket=bucket, Key=chave, Body=webp, ContentType='image/webp',
                              CacheControl='public, max-age=31536000, immutable')
            with trava:
                cont['enviados'] += 1
                cont['bytes'] += len(webp)
        except Exception as e:
            with trava:
                cont['erros'] += 1
                if cont['erros'] <= 20:
                    print(f'erro {chave}: {e}', file=sys.stderr, flush=True)

    with ThreadPoolExecutor(a.paralelo) as ex:
        for n, _ in enumerate(ex.map(um, meus), 1):
            if n % 500 == 0:
                print(f'{n}/{len(meus)} · {cont} · {time.time() - t0:.0f}s', flush=True)
    print(f'fim: {cont} · {cont["bytes"] / 1e6:.1f} MB · {time.time() - t0:.0f}s', flush=True)
    if cont['erros'] > len(meus) // 50:
        sys.exit(1)


if __name__ == '__main__':
    main()
