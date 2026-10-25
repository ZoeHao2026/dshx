/** Human/machine rendering. stdout carries only the answer or one JSON envelope. */
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, redact } from './errors.js';

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Truncate to a UTF-8 byte budget without emitting half a code point. */
export function truncateUtf8(text, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return text;
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let sliced = buffer.subarray(0, maxBytes).toString('utf8');
  while (sliced.endsWith('\uFFFD')) sliced = sliced.slice(0, -1);
  return sliced;
}

export function saveFullText(text, { stateDir, sessionId }) {
  if (!stateDir) return undefined;
  try {
    const directory = path.join(stateDir, 'runs');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const safeId = String(sessionId ?? 'session').replace(/[^A-Za-z0-9._-]/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(directory, `${stamp}-${safeId}.md`);
    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return file;
  } catch (error) {
    process.stderr.write(`dshx: warning: could not save the full answer: ${redact(error.message)}\n`);
    return undefined;
  }
}

/**
 * @param {{text: string, sessionId: string, durationMs: number, eventSummary?: object}} result
 * @param {{json?: boolean, maxOutputBytes?: number, stateDir?: string, verbose?: boolean}} options
 */
export function renderSuccess(result, options = {}) {
  const maxBytes = options.maxOutputBytes ?? 65536;
  const truncated = maxBytes > 0 && Buffer.byteLength(result.text, 'utf8') > maxBytes;
  const outputPath = truncated
    ? saveFullText(result.text, { stateDir: options.stateDir, sessionId: result.sessionId })
    : undefined;
  const text = truncated ? truncateUtf8(result.text, maxBytes) : result.text;

  if (options.json) {
    const envelope = {
      schemaVersion: 1,
      ok: true,
      sessionId: result.sessionId,
      text,
      truncated,
      ...(outputPath ? { outputPath } : {}),
      durationMs: result.durationMs,
      ...(result.provider ? { provider: result.provider } : {}),
      ...(result.model ? { model: result.model } : {}),
      ...(result.reasoningEffort ? { reasoningEffort: result.reasoningEffort } : {}),
      ...(result.permissionMode ? { permissionMode: result.permissionMode } : {}),
      ...(result.cwd ? { cwd: result.cwd } : {}),
      ...(result.dshHome ? { dshHome: result.dshHome } : {}),
    };
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }

  if (text.length > 0) {
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }
  if (truncated) {
    process.stderr.write(
      `dshx: answer truncated at ${maxBytes} bytes${outputPath ? `; full text: ${outputPath}` : ''}\n`,
    );
  }
  if (options.verbose) {
    const summary = result.eventSummary ?? {};
    process.stderr.write(
      `dshx: session ${result.sessionId}; ${formatDuration(result.durationMs)}; events=${summary.events ?? '?'}; tools=${summary.toolCalls ?? '?'}` +
        `${summary.turnEndReason ? `; turn=${summary.turnEndReason}` : ''}\n`,
    );
  }
}

/**
 * @param {import('./errors.js').DshxError} error
 * @param {{json?: boolean, verbose?: boolean}} options
 */
export function renderFailure(error, options = {}) {
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
  const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : EXIT.TASK_FAILED;
  const message = redact(error?.message ?? String(error));
  const hint = error?.hint ? redact(error.hint) : undefined;
  const sessionId =
    typeof error?.details?.sessionId === 'string' && error.details.sessionId
      ? error.details.sessionId
      : undefined;

  if (options.json) {
    const envelope = {
      schemaVersion: 1,
      ok: false,
      ...(sessionId ? { sessionId } : {}),
      error: { code, message, ...(hint ? { hint } : {}) },
      exitCode,
    };
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    if (sessionId) process.stderr.write(`dshx: partial session: ${sessionId}\n`);
    if (hint) process.stderr.write(`dshx: ${code}: ${message}\ndshx: hint: ${hint}\n`);
    return exitCode;
  }

  process.stderr.write(`dshx: ${code}: ${message}\n`);
  if (sessionId) process.stderr.write(`dshx: partial session: ${sessionId} (resume with --session)\n`);
  if (hint) process.stderr.write(`dshx: hint: ${hint}\n`);
  if (options.verbose && error?.stack) process.stderr.write(`${redact(error.stack)}\n`);
  return exitCode;
}

/** @param {Array<{sessionId: string, cwd: string, provider?: string, model?: string, at: string, ok: boolean}>} rows */
export function renderSessions(rows, { json = false } = {}) {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        ok: true,
        sessions: rows.map((row) => ({
          sessionId: row.sessionId,
          cwd: row.cwd,
          provider: row.provider,
          model: row.model,
          permissionMode: row.permissionMode,
          at: row.at,
        })),
      })}\n`,
    );
    return;
  }
  if (rows.length === 0) {
    process.stdout.write('No dshx sessions recorded for this selection.\n');
    return;
  }
  for (const row of rows) {
    process.stdout.write(
      `${row.at}  ${row.sessionId}  ${row.provider ?? '?'}/${row.model ?? '?'}  ${row.cwd}\n`,
    );
  }
}

/** @param {{checks: Array<{name: string, status: string, detail?: string}>, ok: boolean}} report */
export function renderDoctor(report, { json = false } = {}) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: report.ok, checks: report.checks })}\n`);
    return;
  }
  for (const check of report.checks) {
    const prefix = check.status === 'ok' ? '[ok]  ' : check.status === 'warn' ? '[warn]' : '[fail]';
    process.stdout.write(`${prefix} ${check.name}${check.detail ? `: ${check.detail}` : ''}\n`);
  }
  process.stdout.write(report.ok ? 'dshx doctor: ready\n' : 'dshx doctor: required checks failed\n');
}
