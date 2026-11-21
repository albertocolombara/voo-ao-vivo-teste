"""Apaga do R2 os blocos que a troca pelo Sentinel-2 não regravou (Landsat WELD que sobrou).

Lista `blocos/w10/` e `blocos/w8/` e apaga o que foi gravado antes de `--antes` (início da geração
do Sentinel-2). Com `--i9`, apaga também a camada antiga de luzes (GMIS), depois que nenhum app
em teste a usar mais. Sem `--apagar`, só conta.

  python blocos/limpar_antigos.py --antes 2026-11-21T03:00 [--i9] [--apagar]
"""
import argparse
import os
from datetime import datetime, timezone

from gerar_s2 import cliente_r2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--antes', required=True)
    ap.add_argument('--i9', action='store_true')
    ap.add_argument('--apagar', action='store_true')
    a = ap.parse_args()
    antes = datetime.fromisoformat(a.antes).replace(tzinfo=timezone.utc)
    s3, bucket = cliente_r2(), os.environ['R2_BUCKET']
    prefixos = ['blocos/w10/', 'blocos/w8/'] + (['blocos/i9/'] if a.i9 else [])
    for pre in prefixos:
        velhos, tam = [], 0
        for p in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=pre):
            for ob in p.get('Contents', []):
                if pre == 'blocos/i9/' or ob['LastModified'] < antes:
                    velhos.append(ob['Key'])
                    tam += ob['Size']
        print(f'{pre}: {len(velhos)} antigos, {tam / 1e9:.2f} GB')
        if a.apagar:
            for i in range(0, len(velhos), 1000):
                s3.delete_objects(Bucket=bucket, Delete={'Objects': [{'Key': k} for k in velhos[i:i + 1000]], 'Quiet': True})
            print(f'{pre}: apagados')


if __name__ == '__main__':
    main()
