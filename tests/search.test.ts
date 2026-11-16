import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { FastifyInstance } from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';
import buildApp from '../src/app';
import { connectDB, disconnectDB } from '../src/config/db';
import { Message } from '../src/models/Message';
import { buildContainsPattern, foldAccents, MAX_SEARCH_LIMIT, MAX_SEARCH_QUERY_LENGTH } from '../src/helpers/search';

/** Búsqueda de mensajes (ver ADR-04). */

const SERVER = '11111111-1111-4111-8111-111111111111';
const FOREIGN_SERVER = '22222222-2222-4222-8222-222222222222';
// Lo que Core dice que el usuario ve en SERVER. 'hidden' es del mismo servidor pero sin VIEW_CHANNELS y
// 'other' es de otro servidor: ninguno de los dos tiene que aparecer
const VISIBLE = ['general', 'random'];

describe('Message search (GET /servers/:serverId/messages/search)', () => {
  let app: FastifyInstance;
  let mongoServer: MongoMemoryServer;
  let originalFetch: typeof globalThis.fetch;
  let coreDown = false;
  let lastCoreUrl = '';

  before(async () => {
    originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      const urlStr = url.toString();
      lastCoreUrl = urlStr;
      if (coreDown) throw new Error('fetch failed');
      if (urlStr.includes(`server_id=${SERVER}`)) {
        return { status: 200, json: async () => ({ channel_ids: VISIBLE, role_ids: [] }) } as Response;
      }
      // No es miembro del servidor pedido
      return { status: 200, json: async () => ({ channel_ids: [], role_ids: [] }) } as Response;
    });

    mongoServer = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongoServer.getUri();
    await connectDB();

    app = buildApp();
    await app.ready();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
    await disconnectDB();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    coreDown = false;
    await Message.deleteMany({});
  });

  const search = (query: Record<string, string>, userId: string | null = 'auth0|me', serverId = SERVER) =>
    app.inject({
      method: 'GET',
      url: `/servers/${serverId}/messages/search?${new URLSearchParams(query)}`,
      headers: userId ? { 'x-user-id': userId } : {},
    });

  const seed = (content: string, channelId = 'general', authorId = 'auth0|ana') =>
    Message.create({ content, channelId, authorId });

  // ---------- CA 1: búsqueda por texto ----------

  it('devuelve los mensajes que contienen el término, en los canales visibles', async () => {
    await seed('el deploy salió bien', 'general');
    await seed('mañana hacemos el DEPLOY', 'random');
    await seed('nada que ver', 'general');

    const res = await search({ q: 'deploy' });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    assert.deepStrictEqual(
      body.messages.map((m: { content: string }) => m.content),
      ['mañana hacemos el DEPLOY', 'el deploy salió bien']
    );
    assert.strictEqual(body.hasMore, false);
    assert.strictEqual(body.nextCursor, null);
    assert.ok(lastCoreUrl.includes(`/internal/users/auth0%7Cme/visible-channels?server_id=${SERVER}`));
  });

  it('no devuelve mensajes de canales que no ve ni de otros servidores', async () => {
    await seed('secreto deploy', 'hidden');
    await seed('deploy de otro server', 'other');
    await seed('deploy visible', 'general');

    const res = await search({ q: 'deploy' });

    assert.deepStrictEqual(res.json().messages.map((m: { content: string }) => m.content), ['deploy visible']);
  });

  it('no distingue mayúsculas ni tildes', async () => {
    await seed('Qué linda CANCIÓN');
    await seed('cancion sin tilde');

    const res = await search({ q: 'canción' });

    assert.strictEqual(res.json().messages.length, 2);
  });

  it('busca el término literal: los caracteres especiales no son una expresión regular', async () => {
    await seed('cuesta $5.00 (oferta)');
    await seed('cuesta 5500 oferta');

    const res = await search({ q: '$5.00 (' });

    assert.deepStrictEqual(res.json().messages.map((m: { content: string }) => m.content), ['cuesta $5.00 (oferta)']);
  });

  it('no devuelve mensajes borrados', async () => {
    await seed('deploy vivo');
    // Aunque quedara texto, la marca de borrado alcanza para que no aparezca
    const deleted = await seed('deploy borrado');
    await Message.updateOne({ _id: deleted._id }, { isDeleted: true, deletedAt: new Date() });

    const res = await search({ q: 'deploy' });

    assert.deepStrictEqual(res.json().messages.map((m: { content: string }) => m.content), ['deploy vivo']);
  });

  it('pagina con limit y before (nextCursor), del más nuevo al más viejo', async () => {
    for (let i = 1; i <= 5; i++) await seed(`deploy ${i}`);

    const first = (await search({ q: 'deploy', limit: '2' })).json();
    assert.deepStrictEqual(first.messages.map((m: { content: string }) => m.content), ['deploy 5', 'deploy 4']);
    assert.strictEqual(first.hasMore, true);
    assert.strictEqual(first.nextCursor, first.messages[1].id);

    const second = (await search({ q: 'deploy', limit: '2', before: first.nextCursor })).json();
    assert.deepStrictEqual(second.messages.map((m: { content: string }) => m.content), ['deploy 3', 'deploy 2']);

    const last = (await search({ q: 'deploy', limit: '2', before: second.nextCursor })).json();
    assert.deepStrictEqual(last.messages.map((m: { content: string }) => m.content), ['deploy 1']);
    assert.strictEqual(last.hasMore, false);
    assert.strictEqual(last.nextCursor, null);
  });

  // ---------- CA 2: filtro por autor ----------

  it('con authorId limita los resultados a ese autor', async () => {
    await seed('deploy de ana', 'general', 'auth0|ana');
    await seed('deploy de beto', 'random', 'auth0|beto');

    const res = await search({ q: 'deploy', authorId: 'auth0|beto' });

    const messages = res.json().messages;
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].authorId, 'auth0|beto');
  });

  it('se puede buscar solo por autor, sin término', async () => {
    await seed('hola', 'general', 'auth0|beto');
    await seed('chau', 'random', 'auth0|beto');
    await seed('otro', 'general', 'auth0|ana');

    const res = await search({ authorId: 'auth0|beto' });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json().messages.map((m: { content: string }) => m.content), ['chau', 'hola']);
  });

  // ---------- CA 3: sin resultados ----------

  it('sin coincidencias devuelve una lista vacía', async () => {
    await seed('hola mundo');

    const res = await search({ q: 'inexistente' });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), { messages: [], hasMore: false, nextCursor: null });
  });

  it('en un servidor donde no es miembro no hay resultados', async () => {
    await seed('deploy', 'general');

    const res = await search({ q: 'deploy' }, 'auth0|me', FOREIGN_SERVER);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json().messages, []);
  });

  // ---------- Validaciones y errores ----------

  it('401 sin X-User-Id', async () => {
    const res = await search({ q: 'deploy' }, null);
    assert.strictEqual(res.statusCode, 401);
  });

  it('400 sin término ni autor (los espacios no cuentan)', async () => {
    const res = await search({ q: '   ' });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.json().detail, /search term \(q\) or an author/);
  });

  it(`400 con un término de más de ${MAX_SEARCH_QUERY_LENGTH} caracteres`, async () => {
    const res = await search({ q: 'a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1) });
    assert.strictEqual(res.statusCode, 400);
  });

  for (const limit of ['0', String(MAX_SEARCH_LIMIT + 1), 'abc', '2.5']) {
    it(`400 con limit=${limit}`, async () => {
      const res = await search({ q: 'deploy', limit });
      assert.strictEqual(res.statusCode, 400);
    });
  }

  it('400 con un before que no es un id de mensaje', async () => {
    const res = await search({ q: 'deploy', before: 'not-an-object-id' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json().detail, 'before must be a valid message id');
  });

  it('400 con un serverId que no es un UUID (sin preguntarle a Core)', async () => {
    lastCoreUrl = '';
    const res = await search({ q: 'deploy' }, 'auth0|me', 'not-a-uuid');
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(lastCoreUrl, '');
  });

  it('503 si Core no responde', async () => {
    coreDown = true;
    const res = await search({ q: 'deploy' });
    assert.strictEqual(res.statusCode, 503);
  });
});

describe('helpers/search', () => {
  it('foldAccents saca tildes y pasa a minúsculas', () => {
    assert.strictEqual(foldAccents('Canción Ñandú'), 'cancion nandu');
  });

  it('buildContainsPattern escapa los especiales y acepta las variantes con tilde', () => {
    const pattern = buildContainsPattern('a.b');
    // eslint-disable-next-line security/detect-non-literal-regexp
    const regex = new RegExp(pattern, 'i');
    assert.ok(regex.test('Á.B'));
    assert.ok(!regex.test('axb'));
  });
});
