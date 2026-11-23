import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import type { ChannelModel } from 'amqplib';
import { EventConsumer, type ConsumerLogger } from '../src/services/EventConsumer';

const silentLogger: ConsumerLogger = { info: () => {}, warn: () => {}, error: () => {} };

type Handler = (msg: { content: Buffer; fields: { routingKey: string } } | null) => void;

/** Conexión de amqplib falsa: un canal que acepta todo y un close() que emite el evento. */
class FakeConnection extends EventEmitter {
  handler: Handler | null = null;
  acked = 0;
  nacked = 0;
  failChannel = false;
  exchange: string | null = null;
  queue: string | null = null;
  bindings: [string, string][] = [];

  async createChannel() {
    if (this.failChannel) throw new Error('channel error');
    return {
      assertExchange: async (exchange: string) => {
        this.exchange = exchange;
      },
      assertQueue: async (queue: string) => {
        this.queue = queue;
        return { queue };
      },
      bindQueue: async (_queue: string, exchange: string, pattern: string) => {
        this.bindings.push([exchange, pattern]);
      },
      consume: async (_queue: string, handler: Handler) => {
        this.handler = handler;
      },
      ack: () => {
        this.acked += 1;
      },
      nack: () => {
        this.nacked += 1;
      },
      close: async () => undefined,
    };
  }
  async close() {
    this.emit('close');
  }
}

/** Espera hasta que se cumpla la condición (los reintentos usan timers reales cortos). */
async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout esperando la condición');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Con canal de confirmación (publisher confirms): `ack` decide qué contesta el broker. */
class ConfirmingConnection extends FakeConnection {
  ack: 'ok' | 'nack' | 'never' | 'throw' = 'ok';
  confirmed: { routingKey: string; messageId: string }[] = [];

  async createConfirmChannel() {
    return {
      publish: (
        _exchange: string,
        routingKey: string,
        _content: Buffer,
        options: { messageId: string },
        callback: (err: Error | null) => void
      ) => {
        if (this.ack === 'throw') throw new Error('channel closed');
        this.confirmed.push({ routingKey, messageId: options.messageId });
        if (this.ack === 'ok') callback(null);
        if (this.ack === 'nack') callback(new Error('nacked'));
        return true;
      },
      close: async () => undefined,
    };
  }
}

describe('EventConsumer.publishConfirmed (outbox de hilos, D3)', () => {
  afterEach(async () => {
    await EventConsumer.stop();
  });

  it('true solo si el broker confirma; false si rechaza, no contesta o el canal falla', async () => {
    const conn = new ConfirmingConnection();
    EventConsumer.start({ connect: async () => conn as unknown as ChannelModel, logger: silentLogger });
    await waitFor(() => EventConsumer.isConnected);
    await new Promise((r) => setTimeout(r, 5));

    assert.strictEqual(await EventConsumer.publishConfirmed('chat.message.created', { event_id: 'e1' }), true);
    assert.deepStrictEqual(conn.confirmed[0], { routingKey: 'chat.message.created', messageId: 'e1' });

    conn.ack = 'nack';
    assert.strictEqual(await EventConsumer.publishConfirmed('chat.message.created', { event_id: 'e2' }), false);
    conn.ack = 'never';
    assert.strictEqual(await EventConsumer.publishConfirmed('chat.message.created', { event_id: 'e3' }, { timeoutMs: 10 }), false);
    conn.ack = 'throw';
    assert.strictEqual(await EventConsumer.publishConfirmed('chat.message.created', { event_id: 'e4' }), false);
  });

  it('sin conexión, false (el aviso queda en el outbox)', async () => {
    assert.strictEqual(await EventConsumer.publishConfirmed('chat.message.created', {}), false);
  });
});

describe('EventConsumer: conexión a RabbitMQ', () => {
  afterEach(async () => {
    await EventConsumer.stop();
  });

  it('escucha member.*, role.*, server.deleted, channel.deleted y server.updated de Server-Roles y user.suspended de Auth-User en la misma cola', async () => {
    const conn = new FakeConnection();
    EventConsumer.start({ connect: async () => conn as unknown as ChannelModel, logger: silentLogger });
    await waitFor(() => EventConsumer.isConnected);

    assert.deepStrictEqual(conn.bindings, [
      ['server.events', 'member.*'],
      ['server.events', 'role.*'],
      ['server.events', 'server.deleted'],
      ['server.events', 'channel.deleted'],
      ['server.events', 'server.updated'],
      ['server.events', 'server.suspended'],
      ['user.events', 'user.suspended'],
    ]);
  });

  it('reintenta hasta conectar si RabbitMQ no está disponible al arrancar', async () => {
    let calls = 0;
    const connect = async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return new FakeConnection() as unknown as ChannelModel;
    };

    EventConsumer.start({ connect, logger: silentLogger, baseDelayMs: 5, maxDelayMs: 20 });

    await waitFor(() => EventConsumer.isConnected);
    assert.strictEqual(calls, 3);
  });

  it('vuelve a conectar sola si la conexión se cae después', async () => {
    const connections: FakeConnection[] = [];
    const connect = async () => {
      const conn = new FakeConnection();
      connections.push(conn);
      return conn as unknown as ChannelModel;
    };

    EventConsumer.start({ connect, logger: silentLogger, baseDelayMs: 5, maxDelayMs: 20 });
    await waitFor(() => EventConsumer.isConnected);

    connections[0].emit('close'); // RabbitMQ reiniciado / nodo infra caído
    assert.strictEqual(EventConsumer.isConnected, false);

    await waitFor(() => connections.length === 2 && EventConsumer.isConnected);
  });

  it('no reintenta después de stop()', async () => {
    let calls = 0;
    const connect = async () => {
      calls += 1;
      throw new Error('ECONNREFUSED');
    };

    EventConsumer.start({ connect, logger: silentLogger, baseDelayMs: 5, maxDelayMs: 20 });
    await waitFor(() => calls >= 1);
    await EventConsumer.stop();
    const callsAtStop = calls;

    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(calls, callsAtStop);
  });

  it('confirma los eventos válidos y descarta los mal formados sin reencolarlos', async () => {
    const conn = new FakeConnection();
    EventConsumer.start({
      connect: async () => conn as unknown as ChannelModel,
      logger: silentLogger,
      baseDelayMs: 5,
      maxDelayMs: 20,
    });
    await waitFor(() => EventConsumer.isConnected);

    conn.handler!({ content: Buffer.from(JSON.stringify({ user_id: 'u1' })), fields: { routingKey: 'member.left' } });
    conn.handler!({ content: Buffer.from('no es json'), fields: { routingKey: 'member.banned' } });
    conn.handler!(null);

    assert.strictEqual(conn.acked, 1);
    assert.strictEqual(conn.nacked, 1);
  });

  it('si falla al armar el canal, cierra esa conexión y reintenta', async () => {
    const connections: FakeConnection[] = [];
    const connect = async () => {
      const conn = new FakeConnection();
      conn.failChannel = connections.length === 0;
      connections.push(conn);
      return conn as unknown as ChannelModel;
    };

    EventConsumer.start({ connect, logger: silentLogger, baseDelayMs: 5, maxDelayMs: 20 });

    await waitFor(() => EventConsumer.isConnected);
    assert.strictEqual(connections.length, 2);
  });

  it('usa la URL, el exchange y la cola que se le pasan', async () => {
    const conn = new FakeConnection();
    let usedUrl = '';
    EventConsumer.start({
      url: 'amqp://u:p@rabbit:5672/',
      exchange: 'custom.events',
      queue: 'custom_queue',
      connect: async (url) => {
        usedUrl = url;
        return conn as unknown as ChannelModel;
      },
      logger: silentLogger,
    });
    await waitFor(() => EventConsumer.isConnected);

    assert.strictEqual(usedUrl, 'amqp://u:p@rabbit:5672/');
    assert.strictEqual(conn.exchange, 'custom.events');
    assert.strictEqual(conn.queue, 'custom_queue');
  });

  it('toma la configuración de las variables de entorno y, si faltan, usa los valores por defecto', async () => {
    const saved = {
      url: process.env.RABBITMQ_URL,
      exchange: process.env.RABBITMQ_EXCHANGE,
      queue: process.env.RABBITMQ_QUEUE,
    };
    // El logger por defecto es console: se silencia para no ensuciar la salida de los tests
    const info = mock.method(console, 'info', () => {});
    try {
      process.env.RABBITMQ_URL = 'amqp://env:env@rabbit-env:5672/';
      process.env.RABBITMQ_EXCHANGE = 'env.events';
      process.env.RABBITMQ_QUEUE = 'env_queue';
      const fromEnv = new FakeConnection();
      let envUrl = '';
      EventConsumer.start({
        connect: async (url) => {
          envUrl = url;
          return fromEnv as unknown as ChannelModel;
        },
      });
      await waitFor(() => EventConsumer.isConnected);
      assert.strictEqual(envUrl, 'amqp://env:env@rabbit-env:5672/');
      assert.strictEqual(fromEnv.exchange, 'env.events');
      assert.strictEqual(fromEnv.queue, 'env_queue');
      await EventConsumer.stop();

      delete process.env.RABBITMQ_URL;
      delete process.env.RABBITMQ_EXCHANGE;
      delete process.env.RABBITMQ_QUEUE;
      const defaults = new FakeConnection();
      let defaultUrl = '';
      EventConsumer.start({
        connect: async (url) => {
          defaultUrl = url;
          return defaults as unknown as ChannelModel;
        },
      });
      await waitFor(() => EventConsumer.isConnected);
      assert.strictEqual(defaultUrl, 'amqp://admin:admin@rabbitmq:5672/');
      assert.strictEqual(defaults.exchange, 'server.events');
      assert.strictEqual(defaults.queue, 'chat_engine_events');
      assert.ok(info.mock.callCount() >= 2); // registró cada conexión con el logger por defecto
    } finally {
      info.mock.restore();
      if (saved.url === undefined) delete process.env.RABBITMQ_URL;
      else process.env.RABBITMQ_URL = saved.url;

      if (saved.exchange === undefined) delete process.env.RABBITMQ_EXCHANGE;
      else process.env.RABBITMQ_EXCHANGE = saved.exchange;

      if (saved.queue === undefined) delete process.env.RABBITMQ_QUEUE;
      else process.env.RABBITMQ_QUEUE = saved.queue;
    }
  });

  it('sin connect inyectado usa amqplib y reintenta si RabbitMQ no responde', async () => {
    // Puerto 1 en localhost: la conexión se rechaza enseguida, sin depender de un RabbitMQ real
    const warnings: unknown[] = [];
    const logger: ConsumerLogger = { ...silentLogger, warn: (obj: unknown) => void warnings.push(obj) };
    EventConsumer.start({ url: 'amqp://127.0.0.1:1/', logger, baseDelayMs: 5, maxDelayMs: 20 });

    await waitFor(() => warnings.length >= 1, 3000);
    assert.strictEqual(EventConsumer.isConnected, false);
  });

  it('stop() mientras espera para reintentar corta la espera y no vuelve a intentar', async () => {
    let calls = 0;
    const connect = async () => {
      calls += 1;
      throw new Error('ECONNREFUSED');
    };

    // Espera larga: si stop() no la cortara, el test quedaría colgado hasta el timeout
    EventConsumer.start({ connect, logger: silentLogger, baseDelayMs: 60_000, maxDelayMs: 60_000 });
    await waitFor(() => calls === 1);
    await new Promise((r) => setTimeout(r, 10)); // ya está dentro de la espera del backoff

    await EventConsumer.stop();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(calls, 1);
  });

  it('stop() cancela los vencimientos de mute pendientes', async () => {
    EventConsumer.handleEvent('member.muted', {
      user_id: 'u-muted',
      server_id: 's1',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.strictEqual(EventConsumer.pendingMuteCount, 1);

    await EventConsumer.stop();

    assert.strictEqual(EventConsumer.pendingMuteCount, 0);
  });
});
