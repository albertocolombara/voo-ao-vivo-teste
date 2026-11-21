"""Diagnóstico (temporário): o r2.dev serve um objeto gravado com Content-Encoding: gzip?"""
import gzip, json, os, subprocess
import boto3
s3 = boto3.client('s3', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                  aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'], region_name='auto')
B = os.environ['R2_BUCKET']
PUB = 'https://pub-10aaf652e29a4aa99f9726219b1a3995.r2.dev'
orig = s3.get_object(Bucket=B, Key='voos/indice.json')['Body'].read()
idx = json.loads(orig)
reg = next(iter(idx['regioes']))
corpo = s3.get_object(Bucket=B, Key=f'voos/{reg}.json')['Body'].read()
gz = gzip.compress(corpo, 9)
print('região', reg, 'bruto', len(corpo), 'gzip', len(gz))
s3.put_object(Bucket=B, Key='teste/gzip.json', Body=gz, ContentType='application/json; charset=utf-8', ContentEncoding='gzip', CacheControl='no-cache')
for ae in ['gzip', 'identity', None]:
    cmd = ['curl', '-s', '-D', '-', '-o', '/tmp/r.bin', PUB + '/teste/gzip.json']
    if ae: cmd[1:1] = ['-H', f'Accept-Encoding: {ae}']
    h = subprocess.run(cmd, capture_output=True, text=True).stdout
    tam = os.path.getsize('/tmp/r.bin')
    cab = [l for l in h.splitlines() if l.lower().split(':')[0] in ('http/1.1', 'http/2', 'content-encoding', 'content-length', 'content-type')] + [h.splitlines()[0]]
    raw = open('/tmp/r.bin', 'rb').read()
    print('Accept-Encoding', ae, '| bytes recebidos', tam, '| é gzip?', raw[:2] == b'\x1f\x8b', '|', cab)
# Python urllib (como um cliente sem gzip)
s3.delete_object(Bucket=B, Key='teste/gzip.json')
