import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { FastifyInstance } from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';
import buildApp from '../src/app';
import { connectDB, disconnectDB } from '../src/config/db';
import { Message } from '../src/models/Message';
import { Conversation } from '../src/models/Conversation';
import { RelationsService } from '../src/services/RelationsService';
import { toDmChannelId } from '../src/helpers/directMessages';

/** Búsqueda dentro de un DM o de un canal (GET /channels/:channelId/messages/search, ADR-04). */

// Con login federado, Alicia entra como 'google|alice' (X-User-Id) y su id canónico es 'alice'
const ALIASES = new Map([['google|alice', 'alice']]);

describe('Message search in a DM or channel (GET /channels/:channelId/messages/search)', () => {
  let app: FastifyInstance;
  let mongoServer: MongoMemoryServer;
  let originalFetch: typeof globalThis.fetch;
  let dmId: string;
  let otherDmId: string;
  let coreCanView = true;

  before(async () => {
    originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      const json = (body: unknown) => ({ status: 200, json: async () => body }) as Response;
      const canonical = url.pathname.match(/^\/internal\/users\/(.+)\/canonical$/);
      if (canonical) {
        const id = decodeURIComponent(canonical[1]);
        return json({ user_id: ALIASES.get(id) ?? id, suspended: false });
      }
      if (url.pathname.startsWith('/internal/channels/')) {
        return coreCanView ? json({ server_id: 'srv-1', can_send: true }) : ({ status: 403 } as Response);
      }
      throw new Error(`Unexpected fetch: ${url}`);
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

  const conversation = async (a: string, b: string) => {
    const participantIds = [a, b].sort();
    const conv = await Conversation.create({
      participantKey: JSON.stringify(participantIds),
      participantIds,
      status: 'accepted',
      requestedBy: a,
      lastMessageAt: new Date(),
    });
    return toDmChannelId(conv._id);
  };

  beforeEach(async () => {
    coreCanView = true;
    RelationsService.clearCache();
    await Message.deleteMany({});
    await Conversation.deleteMany({});
    dmId = await conversation('alice', 'bob');
    otherDmId = await conversation('bob', 'carla');
  });

  const search = (channelId: string, query: Record<string, string>, userId = 'alice') =>
    app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages/search?${new URLSearchParams(query)}`,
      headers: { 'x-user-id': userId },
    });

  const seed = (content: string, channelId: string, authorId: string) => Message.create({ content, channelId, authorId });
  const contents = (res: { json: () => { messages: { content: string }[] } }) => res.json().messages.map((m) => m.content);

  it('CA 1: encuentra los mensajes del DM que contienen el término, sin los de otros DMs', async () => {
    await seed('mañana hacemos el deploy', dmId, 'alice');
    await seed('el DEPLOY salió', dmId, 'bob');
    await seed('nada que ver', dmId, 'bob');
    await seed('deploy de otra conversación', otherDmId, 'bob');

    const res = await search(dmId, { q: 'deploy' });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(contents(res), ['el DEPLOY salió', 'mañana hacemos el deploy']);
  });

  it('CA 2: filtra por el otro participante', async () => {
    await seed('hola de alice', dmId, 'alice');
    await seed('hola de bob', dmId, 'bob');

    const res = await search(dmId, { q: 'hola', authorId: 'bob' });

    assert.deepStrictEqual(contents(res), ['hola de bob']);
  });

  it('"mis mensajes" con el X-User-Id crudo (alias federado) encuentra los guardados con el id canónico', async () => {
    await seed('lo escribí yo', dmId, 'alice');
    await seed('lo escribió bob', dmId, 'bob');

    const res = await search(dmId, { authorId: 'google|alice' }, 'google|alice');

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(contents(res), ['lo escribí yo']);
  });

  it('CA 3: sin coincidencias devuelve una lista vacía', async () => {
    await seed('hola', dmId, 'bob');

    const res = await search(dmId, { q: 'inexistente' });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), { messages: [], hasMore: false, nextCursor: null });
  });

  it('403 si no participa del DM, aunque conozca el id', async () => {
    await seed('secreto', otherDmId, 'bob');

    const res = await search(otherDmId, { q: 'secreto' }, 'alice');

    assert.strictEqual(res.statusCode, 403);
  });

  it('404 si el DM no existe', async () => {
    const res = await search('dm-0123456789abcdef01234567', { q: 'hola' });
    assert.strictEqual(res.statusCode, 404);
  });

  it('pagina con before y no devuelve mensajes borrados', async () => {
    for (let i = 1; i <= 3; i++) await seed(`deploy ${i}`, dmId, 'bob');
    const deleted = await seed('deploy borrado', dmId, 'bob');
    await Message.updateOne({ _id: deleted._id }, { isDeleted: true, deletedAt: new Date() });

    const first = (await search(dmId, { q: 'deploy', limit: '2' })).json();
    assert.deepStrictEqual(first.messages.map((m: { content: string }) => m.content), ['deploy 3', 'deploy 2']);
    assert.strictEqual(first.hasMore, true);

    const second = (await search(dmId, { q: 'deploy', limit: '2', before: first.nextCursor })).json();
    assert.deepStrictEqual(second.messages.map((m: { content: string }) => m.content), ['deploy 1']);
    assert.strictEqual(second.hasMore, false);
  });

  it('400 sin término ni autor', async () => {
    const res = await search(dmId, { q: '  ' });
    assert.strictEqual(res.statusCode, 400);
  });

  it('en un canal de servidor busca solo en ese canal, con el permiso de verlo', async () => {
    await seed('deploy en general', 'general', 'bob');
    await seed('deploy en random', 'random', 'bob');

    const res = await search('general', { q: 'deploy' });
    assert.deepStrictEqual(contents(res), ['deploy en general']);

    coreCanView = false;
    const forbidden = await search('general', { q: 'deploy' });
    assert.strictEqual(forbidden.statusCode, 403);
  });
});
