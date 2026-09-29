import { FastifyInstance } from 'fastify';
import { toProblem } from '../errors';

/**
 * Central HTTP error handling. Must be called on the root instance BEFORE the
 * route plugins are registered so every child context inherits it.
 *
 * It also covers errors thrown in `preValidation` on WebSocket routes: those
 * happen before the upgrade, so the client gets a normal HTTP problem response.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, req, reply) => {
    const problem = toProblem(error, req.url);

    if (problem.status >= 500) {
      req.log.error({ err: error }, 'Request failed');
    } else {
      req.log.info({ status: problem.status, detail: problem.detail }, 'Request rejected');
    }

    return reply.status(problem.status).type('application/problem+json').send(problem);
  });

  app.setNotFoundHandler((req, reply) => {
    return reply
      .status(404)
      .type('application/problem+json')
      .send({ type: 'about:blank', title: 'Not Found', status: 404, detail: `Route ${req.method} ${req.url} not found`, instance: req.url });
  });
}
