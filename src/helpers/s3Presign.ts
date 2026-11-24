import crypto from 'node:crypto';

/**
 * URL firmada de S3 para leer un objeto (GET), con AWS Signature Version 4 en la query string:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 *
 * Es sincrónica a propósito: se llama desde toPayload (ChatService), que arma cada mensaje que sale hacia
 * los clientes. El presigner del SDK es asíncrono y es una dependencia más; firmar es solo HMAC-SHA256.
 */
export interface PresignGetOptions {
  bucket: string;
  key: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Credenciales temporales (rol de STS). */
  sessionToken?: string;
  /** Segundos de validez desde `signedAt` (S3 acepta hasta 7 días). */
  expiresIn: number;
  signedAt: Date;
  /** Por defecto `<bucket>.s3.<region>.amazonaws.com`. */
  host?: string;
}

/** Codificación de URI de SigV4: todo menos A-Z a-z 0-9 - _ . ~ va en %XX con mayúsculas. */
export function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function s3Host(bucket: string, region: string): string {
  return `${bucket}.s3.${region}.amazonaws.com`;
}

/** La ruta del objeto en la URL: cada segmento codificado, las barras tal cual. */
export function s3ObjectPath(key: string): string {
  return `/${key.split('/').map(awsUriEncode).join('/')}`;
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/** 20130524T000000Z */
function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function presignS3Get(options: PresignGetOptions): string {
  const host = options.host ?? s3Host(options.bucket, options.region);
  const timestamp = amzDate(options.signedAt);
  const dateStamp = timestamp.slice(0, 8);
  const scope = `${dateStamp}/${options.region}/s3/aws4_request`;
  const path = s3ObjectPath(options.key);

  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${options.accessKeyId}/${scope}`,
    'X-Amz-Date': timestamp,
    'X-Amz-Expires': String(options.expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };
  if (options.sessionToken) params['X-Amz-Security-Token'] = options.sessionToken;

  const query = Object.keys(params)
    .sort()
    .map((name) => `${awsUriEncode(name)}=${awsUriEncode(params[name])}`)
    .join('&');

  const canonicalRequest = ['GET', path, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, dateStamp), options.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}
