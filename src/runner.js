/** Spawn one official DSH headless process and fold its NDJSON stream into one outcome. */
import { spawn, spawnSync } from 'node:child_process';
import { DshxError, EXIT, mapDshFailure, protocolError, unavailable } from './errors.js';
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

  const closePromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });

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
    if (verbose) process.stderr.write(text);
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
        }, timeoutSec * 1000)
      : undefined;

  const onSigint = () => {
    if (interrupted === undefined) {
      interrupted = 'SIGINT';
      killTree(child.pid);
    }
  };
  const onSigterm = () => {
    if (interrupted === undefined) {
      interrupted = 'SIGTERM';
      killTree(child.pid);
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
    throw timeoutError(
      `DSH did not finish within ${timeoutSec} seconds; its process tree was stopped.` +
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
    throw stdoutFailure;
  }

  if (collector.error) {
    throw mapDshFailure(collector.error, {
      turnEndReason: collector.turnEndReason,
      stderrTail,
      exitCode: exit.code,
    });
  }

  if (exit.code !== 0) {
    throw mapDshFailure(undefined, {
      turnEndReason: collector.turnEndReason,
      stderrTail,
      exitCode: exit.code,
    });
  }

  if (collector.finalText === undefined) {
    throw protocolError(
      `DSH exited successfully without a final event${collector.turnEndReason ? ` (turn reason: ${collector.turnEndReason})` : ''}.`,
      'The DSH version may not match the dshx event contract, or a plugin wrote to stdout.',
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
