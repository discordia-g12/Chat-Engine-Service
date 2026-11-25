import { describe, it } from 'node:test';
import assert from 'node:assert';
import { awsUriEncode, presignS3Get, s3ObjectPath } from '../src/helpers/s3Presign';

describe('presignS3Get (AWS SigV4 por query string)', () => {
  // Ejemplo de la documentación de AWS: "Authenticating Requests: Using Query Parameters (AWS Signature
  // Version 4)", https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
  it('da la firma del ejemplo oficial de AWS', () => {
    const url = presignS3Get({
      bucket: 'examplebucket',
      host: 'examplebucket.s3.amazonaws.com',
      key: 'test.txt',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      expiresIn: 86400,
      signedAt: new Date('2013-05-24T00:00:00Z'),
    });

    assert.strictEqual(
      url,
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z' +
        '&X-Amz-Expires=86400' +
        '&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
    );
  });

  it('usa el host regional por defecto y suma el token de sesión si hay', () => {
    const url = new URL(
      presignS3Get({
        bucket: 'b',
        key: 'attachments/c/a.png',
        region: 'us-east-1',
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
        sessionToken: 'tok/en+=',
        expiresIn: 60,
        signedAt: new Date('2026-01-01T00:00:00Z'),
      })
    );
    assert.strictEqual(url.host, 'b.s3.us-east-1.amazonaws.com');
    assert.strictEqual(url.searchParams.get('X-Amz-Security-Token'), 'tok/en+=');
  });

  it('codifica como pide SigV4: cada segmento, sin tocar las barras', () => {
    assert.strictEqual(awsUriEncode("a b!'()*~._-"), "a%20b%21%27%28%29%2A~._-");
    assert.strictEqual(s3ObjectPath('attachments/dm-1/att-x-mi foto.png'), '/attachments/dm-1/att-x-mi%20foto.png');
  });
});
