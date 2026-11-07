/** Client errors — never include secrets in messages. */

export class ExnessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExnessConfigError";
  }
}

export class ExnessApiError extends Error {
  statusCode?: number;
  errorCode?: string | number | null;
  errorMessage?: string | null;
  body?: unknown;
  /** Seconds to wait before retrying (from Retry-After or our own backoff). */
  retryAfterSec?: number;

  constructor(
    message: string,
    opts: {
      statusCode?: number;
      errorCode?: string | number | null;
      errorMessage?: string | null;
      body?: unknown;
      retryAfterSec?: number;
    } = {},
  ) {
    super(message);
    this.name = "ExnessApiError";
    this.statusCode = opts.statusCode;
    this.errorCode = opts.errorCode;
    this.errorMessage = opts.errorMessage;
    this.body = opts.body;
    this.retryAfterSec = opts.retryAfterSec;
  }
}
