"""
Nuvens reais do mundo inteiro para a janela do Termi.

Fonte: máscara de nuvens diária do VIIRS (NOAA-20) no NASA GIBS, camadas
"Clear Sky Confidence" de dia e de noite (paleta: índice 1 a 101 = confiança de céu limpo
de 0 a 100%; 0 = sem dado). O GIBS não tem satélite geoestacionário europeu, então o VIIRS é a
única fonte que cobre o planeta inteiro de dia e de noite (teste de 20/11/2026).

A cada execução (a cada 3 h):
1. baixa o dia de hoje e o de ontem (UTC) das duas passagens, no nível 4 da grade EPSG:4326
   (20 × 10 blocos de 512 px, 18° por bloco, ~4 km por pixel);
2. usa hoje onde já existe e ontem no resto, então cada lugar fica com a passagem mais recente;
3. onde uma passagem não tem dado, usa a outra;
4. grava nuvem (0 = céu limpo, 255 = nuvem certa) em WebP cinza e envia ao R2, sempre com o
   mesmo nome (`nuvens/{dia|noite}/{linha}/{coluna}.webp`): o espaço não cresce;
5. por último, `nuvens/indice.json` com a versão, que o app usa para não ler cache velho.

Uso: python nuvens/gerar.py            (envia ao R2; precisa das variáveis R2_*)
     python nuvens/gerar.py --saida X  (grava em disco, para testar)
"""
import argparse
import datetime as dt
import io
import json
import os
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

NIVEL = 4
LINHAS, COLUNAS, PX = 10, 20, 512
GRAUS_POR_BLOCO = 18.0
CAMADAS = {
    'dia': 'VIIRS_NOAA20_Clear_Sky_Confidence_Day',
    'noite': 'VIIRS_NOAA20_Clear_Sky_Confidence_Night',
}
QUALIDADE = 75
URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/{camada}/default/{data}/1km/{nivel}/{linha}/{coluna}.png'
# Os nomes não mudam a cada atualização: cache curto, e o app pede com ?v= da versão do índice.
CACHE_BLOCO = 'public, max-age=3600'
CACHE_INDICE = 'public, max-age=300'


def baixar(camada: str, data: str, linha: int, coluna: int):
    """Índices da paleta (512 × 512) ou None se o GIBS falhar."""
    url = URL.format(camada=camada, data=data, nivel=NIVEL, linha=linha, coluna=coluna)
    for tentativa in range(4):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                img = Image.open(io.BytesIO(r.read()))
                if img.mode != 'P':
                    return None
                return np.asarray(img, dtype=np.uint8)
        except Exception as e:  # rede ou 5xx: tenta de novo com espera
            if tentativa == 3:
                print(f'falhou {camada} {data} {linha}/{coluna}: {e}', file=sys.stderr, flush=True)
            time.sleep(2 * (tentativa + 1))
    return None


def mais_recente(hoje, ontem):
    """Hoje onde já há passagem; ontem no resto."""
    if hoje is None:
        return ontem
    if ontem is None:
        return hoje
    return np.where(hoje > 0, hoje, ontem)


def nuvem(indices):
    """Paleta → nuvem 0..255 (0 sem dado vira céu limpo)."""
    v = 255 - (indices.astype(np.int32) - 1) * 255 // 100
    return np.where(indices == 0, 0, np.clip(v, 0, 255)).astype(np.uint8)


def webp_cinza(a):
    buf = io.BytesIO()
    Image.fromarray(a, mode='L').save(buf, 'WEBP', quality=QUALIDADE, method=6)
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
        config=Config(retries={'max_attempts': 5, 'mode': 'standard'}, max_pool_connections=16),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--saida', help='grava em disco em vez de enviar ao R2')
    ap.add_argument('--paralelo', type=int, default=8)
    ap.add_argument('--data', help='dia "hoje" em UTC (AAAA-MM-DD), para testar')
    a = ap.parse_args()

    agora = dt.datetime.now(dt.timezone.utc)
    hoje = dt.date.fromisoformat(a.data) if a.data else agora.date()
    ontem = hoje - dt.timedelta(days=1)

    s3 = bucket = None
    if not a.saida:
        s3, bucket = cliente_r2(), os.environ['R2_BUCKET']

    cont = {'enviados': 0, 'falhas': 0, 'bytes': 0, 'cobertura_hoje': {'dia': 0, 'noite': 0}}
    trava = threading.Lock()
    t0 = time.time()

    def gravar(chave, corpo, tipo, cache):
        if a.saida:
            p = Path(a.saida) / chave
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(corpo)
        else:
            s3.put_object(Bucket=bucket, Key=chave, Body=corpo, ContentType=tipo, CacheControl=cache)

    def bloco(lc):
        linha, coluna = lc
        passagens = {}
        for nome, camada in CAMADAS.items():
            h = baixar(camada, hoje.isoformat(), linha, coluna)
            o = baixar(camada, ontem.isoformat(), linha, coluna)
            if h is not None:
                with trava:
                    cont['cobertura_hoje'][nome] += int((h > 0).sum())
            passagens[nome] = mais_recente(h, o)
        dia, noite = passagens['dia'], passagens['noite']
        if dia is None and noite is None:
            with trava:
                cont['falhas'] += 1
            return  # fica o bloco anterior no R2
        # Onde uma passagem não tem dado, usa a outra.
        if dia is None:
            dia = noite
        if noite is None:
            noite = dia
        dia_cheio = np.where(dia > 0, dia, noite)
        noite_cheia = np.where(noite > 0, noite, dia)
        for nome, ind in (('dia', dia_cheio), ('noite', noite_cheia)):
            corpo = webp_cinza(nuvem(ind))
            gravar(f'nuvens/{nome}/{linha}/{coluna}.webp', corpo, 'image/webp', CACHE_BLOCO)
            with trava:
                cont['enviados'] += 1
                cont['bytes'] += len(corpo)

    blocos = [(l, c) for l in range(LINHAS) for c in range(COLUNAS)]
    with ThreadPoolExecutor(a.paralelo) as ex:
        list(ex.map(bloco, blocos))

    total_px = LINHAS * COLUNAS * PX * PX
    cobertura = {k: round(100 * v / total_px, 1) for k, v in cont['cobertura_hoje'].items()}
    print(
        f"{cont['enviados']} arquivos, {cont['bytes'] / 1e6:.1f} MB, {cont['falhas']} blocos sem dado, "
        f"hoje já coberto: dia {cobertura['dia']}% · noite {cobertura['noite']}%, {time.time() - t0:.0f}s",
        flush=True,
    )
    if cont['falhas'] > len(blocos) // 10:
        print('falhas demais: o índice não foi atualizado', file=sys.stderr)
        sys.exit(1)

    indice = {
        'versao': agora.strftime('%Y%m%dT%H%MZ'),
        'geradoEm': agora.isoformat(timespec='seconds'),
        'datas': {'hoje': hoje.isoformat(), 'ontem': ontem.isoformat()},
        'fonte': 'NASA GIBS · VIIRS NOAA-20 Clear Sky Confidence',
        'nivel': NIVEL,
        'grausPorBloco': GRAUS_POR_BLOCO,
        'pixels': PX,
        'linhas': LINHAS,
        'colunas': COLUNAS,
        'passagens': list(CAMADAS),
        'coberturaHoje': cobertura,
    }
    gravar('nuvens/indice.json', json.dumps(indice).encode(), 'application/json', CACHE_INDICE)


if __name__ == '__main__':
    main()
