/** Error vocabulary and stable process exit codes used by every dshx surface. */

export const EXIT = Object.freeze({
  OK: 0,
  TASK_FAILED: 1,
  USAGE: 2,
  UNAVAILABLE: 3,
  PROTOCOL: 4,
  TIMEOUT: 124,
  INTERRUPTED: 130,
  TERMINATED: 143,
});

export class DshxError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {string} message short human message
   * @param {{exitCode?: number, hint?: string, cause?: unknown, details?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DshxError';
    this.code = code;
    this.exitCode = options.exitCode ?? EXIT.TASK_FAILED;
    this.hint = options.hint;
    this.details = options.details;
  }
}

export function usageError(message, hint) {
  return new DshxError('INVALID_ARGUMENT', message, { exitCode: EXIT.USAGE, hint });
}

export function unavailable(code, message, hint, cause) {
  return new DshxError(code, message, { exitCode: EXIT.UNAVAILABLE, hint, cause });
}

export function protocolError(message, hint) {
  return new DshxError('PROTOCOL_ERROR', message, { exitCode: EXIT.PROTOCOL, hint });
}

export function taskError(code, message, hint, details) {
  return new DshxError(code, message, { exitCode: EXIT.TASK_FAILED, hint, details });
}

/** Remove long credential-shaped strings from diagnostics before they reach a terminal. */
export function redact(value) {
  let text = String(value ?? '');
  text = text.replace(/x-dsh-auth-token\s*[:=]\s*\S+/gi, 'x-dsh-auth-token: <redacted>');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer <redacted>');
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>');
  text = text.replace(/[A-Za-z0-9+/=_-]{64,}/g, '<redacted>');
  return text;
}

/** Bound a diagnostic string after redaction. */
export function bounded(value, limit = 2000) {
  const text = redact(value);
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

const AUTH_CODES = new Set([
  'ACCOUNT_SIGN_IN_REQUIRED',
  'ACCOUNT_TOKEN_INVALID',
  'ACCOUNT_QUOTA',
  'MISSING_CREDENTIAL',
  'PROVIDER_NOT_FOUND',
  'CAPABILITY_UNAVAILABLE',
]);

const SESSION_CODES = new Set(['SESSION_NOT_FOUND']);

/**
 * Map a DSH error code/message to a dshx failure with an actionable hint.
 * @param {{code?: string, message?: string}|undefined} error
 * @param {{turnEndReason?: string, stderrTail?: string, exitCode?: number|null}} context
 */
export function mapDshFailure(error, context = {}) {
  const rawCode = typeof error?.code === 'string' ? error.code : undefined;
  const rawMessage = typeof error?.message === 'string' ? error.message : '';
  const message = rawMessage || `DSH exited with code ${context.exitCode ?? 'unknown'}`;
  const turn = context.turnEndReason ? ` (turn reason: ${context.turnEndReason})` : '';
  const stderr = context.stderrTail ? `\nDSH stderr:\n${bounded(context.stderrTail, 1600)}` : '';

  if (rawCode && AUTH_CODES.has(rawCode)) {
    return unavailable(
      'AUTH_UNAVAILABLE',
      `DSH could not authenticate the model request (${rawCode}): ${message}${turn}${stderr}`,
      'Confirm the DeepSeek Harness desktop app is signed in. Alternatively set DEEPSEEK_API_KEY and use --provider deepseek-official (with --no-auth-overlay).',
    );
  }

  if (rawCode && SESSION_CODES.has(rawCode)) {
    return unavailable(
      'SESSION_UNAVAILABLE',
      `DSH could not resume the requested session: ${message}${turn}${stderr}`,
      'Run `dshx ask ...` to start a new session, or pass --session with a compatible headless session id. GUI sessions are not resumable through dshx.',
    );
  }

  const stderrText = context.stderrTail ?? '';
  if (!rawCode || rawCode === 'TASK_FAILED') {
    if (/session[^\n]*does not exist|--session-id[^\n]*does not exist/i.test(stderrText)) {
      return unavailable(
        'SESSION_UNAVAILABLE',
        `DSH could not resume the requested session: ${message}${turn}${stderr}`,
        'Run `dshx ask ...` to start a new session, or drop --session and retry.',
      );
    }
    if (/ACCOUNT_SIGN_IN_REQUIRED|ACCOUNT_TOKEN_INVALID|ACCOUNT_QUOTA|MISSING_CREDENTIAL/i.test(stderrText)) {
      return unavailable(
        'AUTH_UNAVAILABLE',
        `DSH could not authenticate the model request: ${message}${turn}${stderr}`,
        'Confirm the DeepSeek Harness desktop app is signed in. Alternatively set DEEPSEEK_API_KEY and use --provider deepseek-official (with --no-auth-overlay).',
      );
    }
    if (/profile[^\n]*(does not exist|not found|cannot be used)/i.test(stderrText)) {
      return unavailable(
        'PROFILE_UNAVAILABLE',
        `DSH could not compose the requested profile: ${message}${turn}${stderr}`,
        'Check --profile; dshx supports headless-compatible DSH profiles only.',
      );
    }
  }

  return new DshxError('TASK_FAILED', `DSH task failed (${rawCode ?? 'no-error-code'}): ${message}${turn}${stderr}`, {
    exitCode: EXIT.TASK_FAILED,
    hint: 'Inspect the DSH session, rerun with --verbose, or retry with a smaller task.',
  });
}
