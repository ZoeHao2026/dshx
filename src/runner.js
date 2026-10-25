/** Spawn one official DSH headless process and fold its NDJSON stream into one outcome. */
import { spawn, spawnSync } from 'node:child_process';
import { DshxError, EXIT, mapDshFailure, protocolError, redact, unavailable } from './errors.js';
import { EventCollector, createLineDecoder } from './events.js';

const STDERR_LIMIT = 64 * 1024;

function cleanEnvironment(permissionMode, dshHome, base = process.env) {
  const env = { ...base };
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL']) {
    delete env[key];
  }
  env.DSH_PERMISSION_MODE = permissionMode;
  if (dshHome) env.DSH_HOME = dshHome;
  return env;
}

export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 10000,
      });
    } catch {
      // The process may already be gone.
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function timeoutError(message, hint, details) {
  return new DshxError('TIMEOUT', message, { exitCode: EXIT.TIMEOUT, hint, details });
}

function attachSession(error, sessionId) {
  if (sessionId && error instanceof DshxError) {
    error.details = { ...(error.details ?? {}), sessionId };
  }
  return error;
}

/**
 * Run a single DSH task. The prompt travels only through stdin.
 * @param {{
 *   dshBin: string, profile: string, overlayPath: string, userPatches?: string[],
 *   cwd: string, dshHome?: string, prompt: string, timeoutSec?: number,
 *   permissionMode?: string, progress?: boolean, verbose?: boolean, sessionId?: string
 * }} options
 */
export async function runTask(options) {
  const {
    dshBin,
    profile,
    overlayPath,
    userPatches = [],
    cwd,
    dshHome,
    prompt,
    timeoutSec = 1800,
    permissionMode = 'danger-full-access',
    progress = false,
    verbose = false,
    sessionId,
  } = options;

  const env = cleanEnvironment(permissionMode, dshHome);
  const args = [dshBin, '--profile', profile, '--patch', overlayPath];
  for (const patch of userPatches) args.push('--patch', patch);
  args.push('--', '--json');
  if (sessionId) args.push('--session-id', sessionId);
  args.push('-');

  const startedAt = Date.now();
  const collector = new EventCollector({
    onProgress: progress
      ? (message) => {
          const clock = new Date().toLocaleTimeString('en-GB', { hour12: false });
          process.stderr.write(`dshx: [${clock}] ${message}\n`);
        }
      : undefined,
  });

  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw unavailable('DSH_UNAVAILABLE', `Could not start DSH: ${error.message}`, 'Run dshx doctor to inspect the DSH installation.', error);
  }

  let stderrTail = '';
  let timedOut = false;
  let interrupted;
  let stdoutFailure;
  let closed = false;
  let resolveClose;
  let forceCloseTimer;

  const closePromise = new Promise((resolve, reject) => {
    resolveClose = resolve;
    child.once('error', reject);
    child.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });

  // A kill request must not make the CLI wait forever if the OS refuses to
  // deliver a close event. Ten seconds is long enough for taskkill and short
  // enough to keep a timed-out Codex command from hanging.
  const scheduleForceClose = () => {
    if (forceCloseTimer) return;
    forceCloseTimer = setTimeout(() => {
      if (closed) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // Best effort; the timeout error reports that close was not confirmed.
      }
      resolveClose({ code: null, signal: null, forced: true });
    }, 10000);
  };

  const decoder = createLineDecoder((line) => collector.handle(line));

  child.stdout.on('data', (chunk) => {
    try {
      decoder.push(chunk);
    } catch (error) {
      if (!stdoutFailure) {
        stdoutFailure = error;
        killTree(child.pid);
      }
    }
  });
  child.stdout.on('end', () => {
    try {
      decoder.end();
    } catch (error) {
      if (!stdoutFailure) stdoutFailure = error;
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    if (verbose) process.stderr.write(redact(text));
    stderrTail = `${stderrTail}${text}`.slice(-STDERR_LIMIT);
  });
  child.stdin.on('error', () => {
    // EPIPE is expected when DSH rejects the invocation before reading stdin.
  });
  try {
    child.stdin.end(prompt);
  } catch {
    // The close path reports the real failure.
  }

  const timer =
    timeoutSec > 0
      ? setTimeout(() => {
          if (timedOut || closed) return;
          timedOut = true;
          killTree(child.pid);
          scheduleForceClose();
        }, timeoutSec * 1000)
      : undefined;

  const onSigint = () => {
    if (closed) return;
    if (interrupted === undefined) {
      interrupted = 'SIGINT';
      killTree(child.pid);
      scheduleForceClose();
    }
  };
  const onSigterm = () => {
    if (closed) return;
    if (interrupted === undefined) {
      interrupted = 'SIGTERM';
      killTree(child.pid);
      scheduleForceClose();
    }
  };
  const onExit = () => {
    if (!closed) killTree(child.pid);
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  process.once('exit', onExit);

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (forceCloseTimer) clearTimeout(forceCloseTimer);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('exit', onExit);
  };

  let exit;
  try {
    exit = await closePromise;
  } catch (error) {
    cleanup();
    throw unavailable('DSH_UNAVAILABLE', `Could not start DSH: ${error.message}`, 'Run dshx doctor to inspect the DSH installation.', error);
  }

  cleanup();
  const durationMs = Date.now() - startedAt;

  if (timedOut) {
    const stopDetail = exit?.forced
      ? 'a final SIGKILL was requested, but the child did not confirm exit within 10 seconds'
      : 'its process tree was stopped';
    throw timeoutError(
      `DSH did not finish within ${timeoutSec} seconds; ${stopDetail}.` +
        (collector.sessionId ? ` Session: ${collector.sessionId}.` : ''),
      'Increase --timeout for longer tasks, or split the task into smaller calls.',
      { sessionId: collector.sessionId, stderrTail, durationMs },
    );
  }
  if (interrupted === 'SIGINT') {
    throw new DshxError('INTERRUPTED', 'DSH run interrupted by SIGINT.', { exitCode: EXIT.INTERRUPTED });
  }
  if (interrupted === 'SIGTERM') {
    throw new DshxError('TERMINATED', 'DSH run terminated by SIGTERM.', { exitCode: EXIT.TERMINATED });
  }
  if (stdoutFailure) {
    throw attachSession(stdoutFailure, collector.sessionId);
  }

  const failureContext = {
    turnEndReason: collector.turnEndReason,
    stderrTail,
    exitCode: exit.code,
    resumeRequested: Boolean(sessionId),
    sessionStarted: Boolean(collector.sessionId),
  };

  if (collector.error) {
    throw attachSession(mapDshFailure(collector.error, failureContext), collector.sessionId);
  }

  if (exit.code !== 0) {
    throw attachSession(mapDshFailure(undefined, failureContext), collector.sessionId);
  }

  if (collector.turnEndReason && collector.turnEndReason !== 'completed') {
    throw attachSession(
      mapDshFailure(
        { code: 'TASK_FAILED', message: `DSH turn ended with reason ${collector.turnEndReason}` },
        failureContext,
      ),
      collector.sessionId,
    );
  }

  if (collector.finalText === undefined) {
    throw attachSession(
      protocolError(
        `DSH exited successfully without a final event${collector.turnEndReason ? ` (turn reason: ${collector.turnEndReason})` : ''}.`,
        'The DSH version may not match the dshx event contract, or a plugin wrote to stdout.',
      ),
      collector.sessionId,
    );
  }
  if (!collector.sessionId) {
    throw protocolError('DSH completed without emitting a session event; continuity is unavailable.');
  }

  return {
    ok: true,
    sessionId: collector.sessionId,
    sessionCwd: collector.sessionCwd,
    text: collector.finalText,
    durationMs,
    stderrTail,
    eventSummary: collector.summary(),
  };
}
