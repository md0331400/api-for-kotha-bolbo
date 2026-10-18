/** Structured API errors. Responses never contain stack traces or secrets. */

export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "DUPLICATE"
  | "QUOTA_EXCEEDED"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "CONFIG_MISSING"
  | "PROVIDER_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "UPLOAD_TICKET_EXPIRED"
  | "UPLOAD_NOT_CONFIRMED"
  | "INTERNAL";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  TOKEN_INVALID: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DUPLICATE: 409,
  QUOTA_EXCEEDED: 413,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  CONFIG_MISSING: 503,
  PROVIDER_ERROR: 502,
  PROVIDER_UNAVAILABLE: 503,
  UPLOAD_TICKET_EXPIRED: 410,
  UPLOAD_NOT_CONFIRMED: 409,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(code: ErrorCode, message: string, options?: { details?: unknown; status?: number; cause?: unknown }) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "ApiError";
    this.code = code;
    this.status = options?.status ?? STATUS_BY_CODE[code];
    this.details = options?.details;
    this.expose = true;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export type ErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: unknown;
  };
};

export function errorBody(err: ApiError, requestId: string): ErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      requestId,
      ...(err.details !== undefined ? { details: err.details } : {}),
    },
  };
}

/** Internal error with an unexposed message; clients get a generic message. */
export function internalError(cause: unknown): ApiError {
  return new ApiError("INTERNAL", "An internal error occurred.", { cause });
}
