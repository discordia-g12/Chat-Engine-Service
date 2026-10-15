import { describe, it, afterEach } from 'node:test';
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

  async createChannel() {
    if (this.failChannel) throw new Error('channel error');
    return {
      assertExchange: async () => undefined,
      assertQueue: async (queue: string) => ({ queue }),
      bindQueue: async () => undefined,
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

describe('EventConsumer: conexión a RabbitMQ', () => {
  afterEach(async () => {
    await EventConsumer.stop();
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
});
