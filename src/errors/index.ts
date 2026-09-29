
export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly title: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly title = 'Bad Request';
}

export class UnauthorizedError extends AppError {
  readonly statusCode = 401;
  readonly title = 'Unauthorized';
}

export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly title = 'Forbidden';
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly title = 'Not Found';
}

/** A dependency (e.g. Core) is down or misbehaving: transient, safe to retry. */
export class UpstreamUnavailableError extends AppError {
  readonly statusCode = 503;
  readonly title = 'Service Unavailable';
}

/** RFC 7807 problem details. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
}

type MongooseValidationError = Error & { errors: Record<string, { message: string }> };

function isMongooseValidationError(error: unknown): error is MongooseValidationError {
  return error instanceof Error && error.name === 'ValidationError' && typeof (error as MongooseValidationError).errors === 'object';
}

export function toProblem(error: unknown, instance?: string): ProblemDetails {
  if (error instanceof AppError) {
    return { type: 'about:blank', title: error.title, status: error.statusCode, detail: error.message, instance };
  }

  if (isMongooseValidationError(error)) {
    const first = Object.values(error.errors)[0];
    return { type: 'about:blank', title: 'Bad Request', status: 400, detail: first?.message ?? 'Invalid input', instance };
  }

  const statusCode = (error as { statusCode?: unknown })?.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return { type: 'about:blank', title: 'Bad Request', status: statusCode, detail: (error as Error).message, instance };
  }

  return { type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'An unexpected error occurred', instance };
}
