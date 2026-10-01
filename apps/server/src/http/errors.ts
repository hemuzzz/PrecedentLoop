import type { RestErrorDetail } from "./contracts/index.js";

export class RestError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 405 | 409 | 500 | 503,
    readonly detail: RestErrorDetail,
  ) {
    super(detail.message);
    this.name = "RestError";
  }
}

export function invalidRequest(code: string, message: string): RestError {
  return new RestError(400, { code, message, retryable: false });
}
