import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { RelationsService } from '../src/services/RelationsService';
import { UpstreamUnavailableError } from '../src/errors';

const RELATIONS = { exists: true, suspended: false, friends: true, blocked_by_actor: false, blocked_by_other: true };

describe('RelationsService', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalUrl: string | undefined;
  let fetchMock: ReturnType<typeof mock.fn>;

  const respond = (status: number, body?: unknown) => {
    fetchMock = mock.fn(async () => ({ status, json: async () => body }) as Response);
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  };
  const calledUrl = () => String(fetchMock.mock.calls[0].arguments[0]);

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalUrl = process.env.AUTH_SERVICE_URL;
    process.env.AUTH_SERVICE_URL = 'http://auth:8000';
    RelationsService.clearCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.AUTH_SERVICE_URL;
    else process.env.AUTH_SERVICE_URL = originalUrl;
  });

  describe('getCanonical', () => {
    it('encodes the id and maps the response', async () => {
      respond(200, { user_id: 'real', suspended: false });

      assert.deepStrictEqual(await RelationsService.getCanonical('google|123'), { userId: 'real', suspended: false });
      assert.strictEqual(calledUrl(), 'http://auth:8000/internal/users/google%7C123/canonical');
    });

    it('sets a timeout', async () => {
      respond(200, { user_id: 'real', suspended: false });
      await RelationsService.getCanonical('u');

      const init = fetchMock.mock.calls[0].arguments[1] as RequestInit;
      assert.ok(init.signal instanceof AbortSignal);
    });

    it('caches the answer', async () => {
      respond(200, { user_id: 'real', suspended: false });
      await RelationsService.getCanonical('u');
      await RelationsService.getCanonical('u');

      assert.strictEqual(fetchMock.mock.callCount(), 1);
    });

    it('asks again once the cache expires', async (t) => {
      t.mock.timers.enable({ apis: ['Date'] });
      respond(200, { user_id: 'real', suspended: false });
      await RelationsService.getCanonical('u');

      t.mock.timers.tick(61_000);
      await RelationsService.getCanonical('u');

      assert.strictEqual(fetchMock.mock.callCount(), 2);
    });

    it('keeps the cache bounded, dropping the oldest entry', async () => {
      respond(200, { user_id: 'real', suspended: false });
      for (let i = 0; i <= 5000; i++) await RelationsService.getCanonical(`u${i}`);
      assert.strictEqual(fetchMock.mock.callCount(), 5001);

      await RelationsService.getCanonical('u5000');
      assert.strictEqual(fetchMock.mock.callCount(), 5001);
      await RelationsService.getCanonical('u0');
      assert.strictEqual(fetchMock.mock.callCount(), 5002);
    });

    it('returns null for an unknown user, and does not cache it', async () => {
      respond(404);

      assert.strictEqual(await RelationsService.getCanonical('ghost'), null);
      await RelationsService.getCanonical('ghost');
      assert.strictEqual(fetchMock.mock.callCount(), 2);
    });

    for (const [label, status, body] of [
      ['an unexpected status', 500, undefined],
      ['a body without user_id', 200, { suspended: false }],
      ['a body without suspended', 200, { user_id: 'real' }],
      ['an empty body', 200, null],
    ] as const) {
      it(`fails closed on ${label}`, async () => {
        respond(status, body);
        await assert.rejects(RelationsService.getCanonical('u'), UpstreamUnavailableError);
      });
    }

    it('fails closed on invalid JSON', async () => {
      fetchMock = mock.fn(async () => ({ status: 200, json: async () => JSON.parse('nope') }) as Response);
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      await assert.rejects(RelationsService.getCanonical('u'), UpstreamUnavailableError);
    });

    it('fails closed if Auth cannot be reached', async () => {
      globalThis.fetch = (async () => {
        throw new Error('timeout');
      }) as typeof globalThis.fetch;

      await assert.rejects(RelationsService.getCanonical('u'), UpstreamUnavailableError);
    });

    it('defaults to localhost without AUTH_SERVICE_URL', async () => {
      delete process.env.AUTH_SERVICE_URL;
      respond(200, { user_id: 'real', suspended: false });
      await RelationsService.getCanonical('u');

      assert.match(calledUrl(), /^http:\/\/localhost:8000\//);
    });
  });

  describe('getRelations', () => {
    it('sends both ids and maps the response', async () => {
      respond(200, RELATIONS);

      assert.deepStrictEqual(await RelationsService.getRelations('a|1', 'b'), {
        exists: true,
        suspended: false,
        friends: true,
        blockedByActor: false,
        blockedByOther: true,
      });
      assert.strictEqual(calledUrl(), 'http://auth:8000/internal/relations?actor=a%7C1&other=b');
    });

    it('never caches: a block applies from the next message', async () => {
      respond(200, RELATIONS);
      await RelationsService.getRelations('a', 'b');
      await RelationsService.getRelations('a', 'b');

      assert.strictEqual(fetchMock.mock.callCount(), 2);
    });

    it('fails closed on an unexpected status', async () => {
      respond(500);
      await assert.rejects(RelationsService.getRelations('a', 'b'), UpstreamUnavailableError);
    });

    it('fails closed if a flag is missing', async () => {
      respond(200, { ...RELATIONS, blocked_by_other: undefined });
      await assert.rejects(RelationsService.getRelations('a', 'b'), UpstreamUnavailableError);
    });
  });
});
