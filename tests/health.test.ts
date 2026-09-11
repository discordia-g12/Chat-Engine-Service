import { test } from 'node:test';
import assert from 'node:assert';
import buildApp from '../src/app';

test('GET /livez returns ok', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/livez' });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.strictEqual(body.status, 'ok');
  assert.ok(body.timestamp);
  await app.close();
});

// NOTE: /readyz doesn't actually check Mongo/Redis yet (pre-existing gap,
// see docs/ADR-01-CI-CD-Pipeline.md) — this test matches its current
// (stub) behavior, not the readiness semantics the project spec requires.
test('GET /readyz returns ready', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/readyz' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), { status: 'ready' });
  await app.close();
});
