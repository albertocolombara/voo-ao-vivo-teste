"""Diagnóstico (temporário): blocos w10/w8 do R2 no Japão/Coreia, para ver os trechos borrados."""
import io, math, os
import boto3
import numpy as np
from PIL import Image

s3 = boto3.client('s3', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                  aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'], region_name='auto')
B = os.environ['R2_BUCKET']
os.makedirs('saida3', exist_ok=True)


def get(k):
    try:
        return Image.open(io.BytesIO(s3.get_object(Bucket=B, Key=k)['Body'].read())).convert('RGB')
    except Exception:
        return None


def folha(z, la0, la1, lo0, lo1, nome, px):
    g = 288 / 2**z
    r0, r1 = int((90 - la1) / g), int((90 - la0) / g)
    c0, c1 = int((lo0 + 180) / g), int((lo1 + 180) / g)
    out = Image.new('RGB', ((c1 - c0 + 1) * px, (r1 - r0 + 1) * px), (255, 0, 255))
    falta = 0
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            im = get(f'blocos/w{z}/{r}/{c}.webp')
            if im is None:
                falta += 1
                continue
            out.paste(im.resize((px, px)), ((c - c0) * px, (r - r0) * px))
    out.save(f'saida3/{nome}.jpg', quality=85)
    print(nome, out.size, 'faltando', falta)


folha(8, 30, 46, 124, 146, 'japao_coreia_w8', 64)
folha(10, 34.5, 36.5, 131.5, 134.5, 'shimane_w10', 96)
folha(10, 34.6, 35.6, 128.5, 129.6, 'busan_w10', 128)
folha(10, 37.5, 38.5, 138.0, 139.0, 'sado_w10', 128)
