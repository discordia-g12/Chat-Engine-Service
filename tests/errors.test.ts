import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  toProblem,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  UpstreamUnavailableError,
  ConflictError,
} from '../src/errors';
import { Message } from '../src/models/Message';

describe('toProblem', () => {
  it('adds the business code only when the error has one', () => {
    assert.strictEqual(toProblem(new ForbiddenError('no', { code: 'DM_PENDING' })).code, 'DM_PENDING');
    assert.ok(!('code' in toProblem(new ForbiddenError('no'))));
  });

  it('maps each AppError subclass to its own status and title', () => {
    const cases: [Error, number, string][] = [
      [new ValidationError('bad'), 400, 'Bad Request'],
      [new UnauthorizedError('who?'), 401, 'Unauthorized'],
      [new ForbiddenError('no'), 403, 'Forbidden'],
      [new NotFoundError('gone'), 404, 'Not Found'],
      [new ConflictError('taken'), 409, 'Conflict'],
      [new UpstreamUnavailableError('down'), 503, 'Service Unavailable'],
    ];
    for (const [error, status, title] of cases) {
      const problem = toProblem(error, '/x');
      assert.strictEqual(problem.status, status);
      assert.strictEqual(problem.title, title);
      assert.strictEqual(problem.detail, error.message);
      assert.strictEqual(problem.instance, '/x');
    }
  });

  it('sets the subclass name and keeps the cause', () => {
    const cause = new Error('ECONNREFUSED');
    const error = new UpstreamUnavailableError('down', { cause });
    assert.strictEqual(error.name, 'UpstreamUnavailableError');
    assert.strictEqual(error.cause, cause);
  });

  it('maps Mongoose validation errors to 400 with the first field message', async () => {
    const error = await new Message({ authorId: 'u', channelId: 'c', content: '' }).validate().catch((e) => e);
    const problem = toProblem(error);
    assert.strictEqual(problem.status, 400);
    assert.match(problem.detail, /Content is required|cannot be empty/);
  });

  it('passes through Fastify 4xx errors', () => {
    const error = Object.assign(new Error('body must be object'), { statusCode: 400 });
    assert.strictEqual(toProblem(error).status, 400);
    assert.strictEqual(toProblem(error).detail, 'body must be object');
  });

  it('hides unknown errors behind a generic 500', () => {
    const problem = toProblem(new Error('E11000 duplicate key in discordia_chat.messages'));
    assert.strictEqual(problem.status, 500);
    assert.strictEqual(problem.detail, 'An unexpected error occurred');
    assert.strictEqual(toProblem('not even an Error').status, 500);
  });
});
