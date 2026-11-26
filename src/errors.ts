/**
 * A small error type that carries an actionable hint for the UI.
 * The UI shows `message` and, when present, `hint`; the original error stays in
 * `cause` and is logged to the console for debugging.
 */
export class AppError extends Error {
  readonly hint?: string;
  readonly code: string;

  constructor(
    message: string,
    options: {
      hint?: string;
      code?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.hint = options.hint;
    this.code = options.code ?? 'APP_ERROR';
  }
}

export function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  return error instanceof Error && error.name === 'AbortError';
}

export function abortError(message = 'The operation was cancelled.'): DOMException {
  return new DOMException(message, 'AbortError');
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'An unexpected error occurred.';
}
