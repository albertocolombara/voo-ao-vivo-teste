"""
Envia a playlist de lofi do Termi ao R2 (`musica/lofi/{id}.m4a` e `musica/lofi/playlist.json`).
Os arquivos vêm do branch `musica-lofi` (gerados por scripts/preparar-lofi.sh do termi-app).
As faixas não mudam (cache de 1 ano); a playlist tem cache curto, para entrar música nova sem
atualizar o app.
Uso: python musica/enviar.py <pasta com as faixas e a playlist.json>
"""
import json
import os
import sys
from pathlib import Path


def main():
    pasta = Path(sys.argv[1])
    playlist = json.loads((pasta / 'playlist.json').read_text())
    import boto3
    from botocore.config import Config

    s3 = boto3.client(
        's3',
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
        aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto',
        config=Config(retries={'max_attempts': 5, 'mode': 'standard'}),
    )
    bucket = os.environ['R2_BUCKET']
    total = 0
    for f in playlist['faixas']:
        corpo = (pasta / f"{f['id']}.m4a").read_bytes()
        s3.put_object(Bucket=bucket, Key=f"musica/lofi/{f['id']}.m4a", Body=corpo, ContentType='audio/mp4',
                      CacheControl='public, max-age=31536000, immutable')
        total += len(corpo)
    # Por último, para o app nunca ver uma faixa que ainda não subiu.
    s3.put_object(Bucket=bucket, Key='musica/lofi/playlist.json', Body=json.dumps(playlist, ensure_ascii=False).encode(),
                  ContentType='application/json', CacheControl='public, max-age=300')
    print(f"{len(playlist['faixas'])} faixas, {total / 1e6:.1f} MB enviados")


if __name__ == '__main__':
    main()
