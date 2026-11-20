"""Gera os blocos de paisagem da janela do Termi e envia ao Cloudflare R2.

Fonte: NASA GIBS (EPSG:4326, blocos de 512 px; cada bloco cobre 288/2^z graus).
  w10  Landsat WELD (cor real, anual), nível 10 (~61 m/px): perto do avião
  w8   Landsat WELD, nível 8 (~244 m/px): distância média
  i9   GMIS (áreas construídas, Landsat), nível 9: cidades à noite, em tons de cinza

Mesmo formato do protótipo (termi-prototipo/assets/janela/pk): WebP qualidade ~78, 512x512;
GMIS convertido da paleta para cinza (0 = sem área construída, 255 = 91–100%).
Blocos só de oceano (preto) ou sem área construída não são enviados: no app, bloco ausente = nada a desenhar.

Destino: blocos/{camada}/{linha}/{coluna}.webp no bucket R2.

Uso:
  python blocos/gerar.py --camada w8 --parte 0 --partes 1            (envia ao R2)
  python blocos/gerar.py --camada w10 --limite 20 --saida /tmp/teste (só grava em disco, para testar)

Credenciais (segredos do GitHub): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
Créditos: dados da NASA (GIBS, Landsat WELD, GMIS); ver ARCHITECTURE do termi-app.
"""

import argparse
import gzip
import io
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
UA = 'termi-blocos/1.0 (+https://github.com/albertocolombara/voo-ao-vivo-teste)'
CAMADAS = {
    'w10': ('Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual', 'jpg', 10),
    'w8': ('Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual', 'jpg', 8),
    'i9': ('Landsat_Global_Man-made_Impervious_Surface', 'png', 9),
}
QUALIDADE = 78

# Paleta do GMIS no GIBS (índices 3–13 = 0%, 1–10%, …, 91–100%) -> cinza, como no protótipo
LUT_GMIS = np.zeros(256, np.uint8)
LUT_GMIS[[5, 6, 7, 8, 9, 10, 11, 12, 13]] = [9, 41, 69, 97, 121, 154, 190, 225, 255]


def baixar(camada, linha, coluna, tentativas=4):
    nome, ext, z = CAMADAS[camada]
    url = f'{GIBS}/{nome}/default/default/31.25m/{z}/{linha}/{coluna}.{ext}'
    for t in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception:
            if t == tentativas - 1:
                raise
            time.sleep(2 ** t)


def converter(camada, dados):
    """Devolve o WebP do bloco, ou None se não há nada a desenhar."""
    img = Image.open(io.BytesIO(dados))
    if camada == 'i9':
        cinza = LUT_GMIS[np.asarray(img)]
        if cinza.max() == 0:
            return None
        img = Image.fromarray(cinza)
    else:
        img = img.convert('RGB')
        if np.asarray(img).max() == 0:  # oceano
            return None
    buf = io.BytesIO()
    img.save(buf, 'WEBP', quality=QUALIDADE, method=4)
    return buf.getvalue()


def cliente_r2():
    import boto3  # só no envio
    from botocore.config import Config

    return boto3.client(
        's3',
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
        aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto',
        config=Config(retries={'max_attempts': 5, 'mode': 'standard'}, max_pool_connections=32),
    )


def existentes(s3, bucket, camada):
    """Chaves já enviadas (para retomar sem reenviar)."""
    feitas = set()
    pag = s3.get_paginator('list_objects_v2')
    for p in pag.paginate(Bucket=bucket, Prefix=f'blocos/{camada}/'):
        for o in p.get('Contents', []):
            feitas.add(o['Key'])
    return feitas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--camada', required=True, choices=CAMADAS)
    ap.add_argument('--parte', type=int, default=0)
    ap.add_argument('--partes', type=int, default=1)
    ap.add_argument('--limite', type=int, default=0, help='só os N primeiros blocos da parte (teste)')
    ap.add_argument('--saida', help='grava em disco em vez de enviar ao R2')
    ap.add_argument('--paralelo', type=int, default=12)
    a = ap.parse_args()

    base = Path(__file__).parent
    with gzip.open(base / 'candidatos' / f'{a.camada}.txt.gz', 'rt') as f:
        todos = [tuple(map(int, l.split())) for l in f if l.strip()]
    meus = todos[a.parte :: a.partes]
    if a.limite:
        meus = meus[: a.limite]

    s3 = bucket = None
    pular = set()
    if not a.saida:
        s3, bucket = cliente_r2(), os.environ['R2_BUCKET']
        pular = existentes(s3, bucket, a.camada)

    cont = {'enviados': 0, 'vazios': 0, 'pulados': 0, 'erros': 0, 'bytes': 0}
    trava = threading.Lock()
    t0 = time.time()

    def um(lc):
        linha, coluna = lc
        chave = f'blocos/{a.camada}/{linha}/{coluna}.webp'
        if chave in pular:
            with trava:
                cont['pulados'] += 1
            return
        try:
            webp = converter(a.camada, baixar(a.camada, linha, coluna))
            if webp is None:
                with trava:
                    cont['vazios'] += 1
                return
            if a.saida:
                p = Path(a.saida) / chave
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(webp)
            else:
                s3.put_object(
                    Bucket=bucket,
                    Key=chave,
                    Body=webp,
                    ContentType='image/webp',
                    CacheControl='public, max-age=31536000, immutable',
                )
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
            if n % 1000 == 0:
                print(f'{n}/{len(meus)} · {cont} · {time.time() - t0:.0f}s', flush=True)

    print(f'fim {a.camada} parte {a.parte}/{a.partes}: {len(meus)} blocos · {cont} · {cont["bytes"] / 1e6:.1f} MB · {time.time() - t0:.0f}s')
    if cont['erros'] > max(10, len(meus) // 100):  # mais de 1% de erro: falha, para rodar de novo (retoma)
        sys.exit(1)


if __name__ == '__main__':
    main()
