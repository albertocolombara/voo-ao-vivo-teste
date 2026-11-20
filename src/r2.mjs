// Envio de arquivos ao Cloudflare R2 pela API compatível com S3, assinada com AWS Signature V4.
// Sem dependências: usa só o crypto do Node.
// Credenciais (segredos do GitHub): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
import crypto from 'node:crypto';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// Codifica cada parte do caminho como o S3 espera (RFC 3986), mantendo as barras.
const encodePath = (key) =>
  key
    .split('/')
    .map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');

/** Monta os cabeçalhos assinados (SigV4) de um pedido S3. Exportado para os testes. */
export function assinar({ method, host, path, headers, body, accessKeyId, secretAccessKey, region = 'auto', amzDate }) {
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(body ?? '');
  const all = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, date), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  const out = { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
  delete out.host;
  return out;
}

/** Cliente do R2, ou null se as credenciais não estiverem configuradas. */
export function criarR2(env = process.env) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null;
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return {
    async enviar(key, conteudo, { contentType = 'application/json; charset=utf-8', cacheControl = 'public, max-age=60' } = {}) {
      const body = Buffer.from(conteudo);
      const path = `/${R2_BUCKET}/${encodePath(key)}`;
      const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
      const headers = assinar({
        method: 'PUT',
        host,
        path,
        headers: { 'content-type': contentType, 'cache-control': cacheControl },
        body,
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
        amzDate,
      });
      const res = await fetch(`https://${host}${path}`, { method: 'PUT', headers, body });
      if (!res.ok) throw new Error(`R2 ${res.status} em ${key}: ${(await res.text()).slice(0, 300)}`);
    },
  };
}
