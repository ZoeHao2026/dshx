/** Command dispatch for dshx. */
import { DshxError, EXIT, bounded, unavailable, usageError } from './errors.js';
import { helpFor, parse } from './args.js';
import { locateDsh, resolveCwd, resolveDshHome, resolvePatchPaths } from './locate.js';
import { buildOverlay, describeOverlay, dumpConfig, validateDump, writeOverlay } from './overlay.js';
import { runTask } from './runner.js';
import { renderDoctor, renderFailure, renderSessions, renderSuccess } from './render.js';
import {
  appendSession,
  latestSession,
  listSessions,
  markSessionInvalid,
  resolveStateDir,
} from './sessions.js';
import { runDoctor } from './doctor.js';
import { BRIEF, printBrief } from './brief.js';
import { VERSION } from './version.js';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

function write(text) {
  process.stdout.write(text);
}

function warn(text) {
  process.stderr.write(`dshx: ${text}\n`);
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      total += chunk.length;
      if (total > MAX_INPUT_BYTES) {
        throw usageError(`Piped input exceeds ${MAX_INPUT_BYTES} bytes`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof DshxError) throw error;
    throw usageError(`Could not read stdin: ${error.message}`);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function resolvePrompt(options) {
  if (options.prompt !== undefined && options.prompt !== '-') {
    if (options.prompt.trim() === '') throw usageError('The prompt must not be blank');
    return options.prompt;
  }
  const piped = await readStdin();
  if (piped.trim() === '') {
    throw usageError('A prompt or piped UTF-8 input is required', 'Pass the task as an argument or pipe it on stdin.');
  }
  return piped;
}

function dumpEnvironment(dshHome) {
  const env = { ...process.env, DSH_HOME: dshHome };
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL']) {
    delete env[key];
  }
  return env;
}

function planFor({ located, options, cwd, dshHome, userPatches, overlay, expected, sessionId, prompt, permissionMode }) {
  return {
    dryRun: true,
    dshVersion: located.version,
    dshBin: located.bin,
    profile: options.profile,
    provider: options.provider,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    permissionMode,
    cwd,
    dshHome,
    userPatches,
    overlayRows: describeOverlay(overlay, expected).rows,
    sessionId: sessionId ?? null,
    promptBytes: Buffer.byteLength(prompt ?? '', 'utf8'),
  };
}

function printPlan(plan, { json }) {
  if (json) {
    write(`${JSON.stringify({ schemaVersion: 1, ok: true, ...plan })}\n`);
    return;
  }
  const lines = [
    'dshx dry-run',
    `dsh: ${plan.dshVersion} at ${plan.dshBin}`,
    `profile: ${plan.profile}`,
    `model: ${plan.provider}/${plan.model}/${plan.reasoningEffort}`,
    `permission: ${plan.permissionMode}`,
    `cwd: ${plan.cwd}`,
    `dsh-home: ${plan.dshHome}`,
    `overlay: ${plan.overlayRows.join(', ')}`,
    `session: ${plan.sessionId ?? '(new)'}`,
    `prompt: ${plan.promptBytes} bytes`,
    `patches: ${plan.userPatches.length ? plan.userPatches.join(', ') : '(none)'}`,
  ];
  write(`${lines.join('\n')}\n`);
}

async function runAsk(options) {
  if (options.help) {
    write(`${helpFor(options.command, VERSION)}\n`);
    return EXIT.OK;
  }

  const dryRun = options.dryRun;
  const prompt = dryRun
    ? options.prompt && options.prompt !== '-'
      ? options.prompt
      : ''
    : await resolvePrompt(options);

  const cwd = resolveCwd(options.cwd);
  const dshHome = resolveDshHome(options.dshHome);
  const userPatches = resolvePatchPaths(options.patches, cwd);
  const located = locateDsh({ dsh: options.dsh, allowUnvalidatedVersion: options.allowUnvalidatedVersion });
  const auth = options.authOverlay && options.provider === 'deepseek-account';
  const expected = {
    provider: options.provider,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    auth,
  };
  const overlay = buildOverlay({
    provider: options.provider,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    auth,
  });
  const stateDir = resolveStateDir();
  const continueMode = options.command === 'continue';
  let sessionId = options.sessionId;
  let sessionRecord;

  if (continueMode) {
    sessionRecord = latestSession({ stateDir, cwd, dshHome, profile: options.profile });
    if (!sessionRecord) {
      throw unavailable(
        'SESSION_UNAVAILABLE',
        `No dshx session is recorded for ${cwd} under ${dshHome}.`,
        'Run `dshx ask ...` first, or pass --session with a compatible headless session id.',
      );
    }
    sessionId = sessionRecord.sessionId;
  }

  let permissionMode = options.permissionMode;
  if (
    continueMode &&
    !options.permissionModeExplicit &&
    sessionRecord &&
    ['read-only', 'workspace-write', 'danger-full-access'].includes(sessionRecord.permissionMode)
  ) {
    permissionMode = sessionRecord.permissionMode;
  }

  if (options.verbose) {
    warn(
      `using DSH ${located.version} at ${located.bin}; profile=${options.profile}; ` +
        `provider=${options.provider}; model=${options.model}; permission=${permissionMode}; cwd=${cwd}`,
    );
  }

  const overlayBundle = writeOverlay(overlay);
  try {
    if (dryRun) {
      const dump = dumpConfig({
        dshBin: located.bin,
        profile: options.profile,
        overlayPath: overlayBundle.path,
        userPatches,
        cwd,
        env: dumpEnvironment(dshHome),
      });
      const validation = validateDump(dump, expected);
      if (!validation.ok) {
        throw unavailable(
          'OVERLAY_INVALID',
          `The composed DSH profile does not match the requested route: ${validation.problems.join('; ')}`,
          'Run dshx doctor; a conflicting --patch may be overriding the auth/model rows.',
        );
      }
      printPlan(
        planFor({ located, options, cwd, dshHome, userPatches, overlay, expected, sessionId, prompt, permissionMode }),
        { json: options.json },
      );
      return EXIT.OK;
    }

    const result = await runTask({
      dshBin: located.bin,
      profile: options.profile,
      overlayPath: overlayBundle.path,
      userPatches,
      cwd,
      dshHome,
      prompt,
      timeoutSec: options.timeout,
      permissionMode,
      progress: options.progress,
      verbose: options.verbose,
      sessionId,
    });

    try {
      appendSession(
        {
          sessionId: result.sessionId,
          cwd,
          dshHome,
          profile: options.profile,
          provider: options.provider,
          model: options.model,
          permissionMode,
          ok: true,
        },
        { stateDir },
      );
    } catch (error) {
      warn(`warning: could not record the session: ${bounded(error.message, 400)}`);
    }

    renderSuccess(
      {
        ...result,
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        permissionMode,
        cwd,
        dshHome,
      },
      {
        json: options.json,
        maxOutputBytes: options.maxOutputBytes,
        stateDir,
        verbose: options.verbose,
      },
    );
    return EXIT.OK;
  } catch (error) {
    if (continueMode && sessionId && error instanceof DshxError && error.code === 'SESSION_UNAVAILABLE') {
      try {
        markSessionInvalid(
          {
            sessionId,
            cwd,
            dshHome,
            profile: options.profile,
            provider: options.provider,
            model: options.model,
            permissionMode,
          },
          { stateDir },
        );
      } catch {
        // A failed tombstone must not hide the original error.
      }
    }
    return renderFailure(error, { json: options.json, verbose: options.verbose });
  } finally {
    try {
      overlayBundle.cleanup();
    } catch {
      // Never turn a completed task into a failure because temp cleanup failed.
    }
  }
}

function runSessionsCommand(options) {
  if (options.help) {
    write(`${helpFor('sessions', VERSION)}\n`);
    return EXIT.OK;
  }
  const cwd = resolveCwd(options.cwd);
  const dshHome = resolveDshHome();
  const stateDir = resolveStateDir();
  const rows = listSessions({
    stateDir,
    cwd,
    dshHome,
    profile: options.profile,
    all: options.all,
    limit: options.limit,
  });
  renderSessions(rows, { json: options.json });
  return EXIT.OK;
}

async function runDoctorCommand(options) {
  if (options.help) {
    write(`${helpFor('doctor', VERSION)}\n`);
    return EXIT.OK;
  }
  const report = await runDoctor({
    dsh: options.dsh,
    dshHome: options.dshHome,
    profile: options.profile,
    provider: options.provider,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    permissionMode: options.permissionMode,
    timeout: options.timeout,
    live: options.live,
    allowUnvalidatedVersion: options.allowUnvalidatedVersion,
  });
  renderDoctor(report, { json: options.json });
  return report.ok ? EXIT.OK : EXIT.UNAVAILABLE;
}

function runBriefCommand(options) {
  if (options.help) {
    write(`${helpFor('brief', VERSION)}\n`);
    return EXIT.OK;
  }
  if (options.json) {
    write(`${JSON.stringify({ schemaVersion: 1, ok: true, brief: BRIEF })}\n`);
    return EXIT.OK;
  }
  printBrief((text) => write(text));
  return EXIT.OK;
}

/** Run one CLI invocation and return its process exit code. */
export async function main(argv) {
  let options;
  try {
    options = parse(argv);
  } catch (error) {
    return renderFailure(error, { json: argv.includes('--json') });
  }

  if (options.command === 'help') {
    write(`${helpFor(options.topic, VERSION)}\n`);
    return EXIT.OK;
  }
  if (options.command === 'version') {
    write(`dshx ${VERSION}\n`);
    return EXIT.OK;
  }

  try {
    if (options.command === 'ask' || options.command === 'continue') return await runAsk(options);
    if (options.command === 'sessions') return runSessionsCommand(options);
    if (options.command === 'doctor') return await runDoctorCommand(options);
    if (options.command === 'brief') return runBriefCommand(options);
    throw usageError(`Unknown command ${options.command}`);
  } catch (error) {
    const dshxError =
      error instanceof DshxError
        ? error
        : new DshxError('INTERNAL_ERROR', error?.message ?? String(error), {
            exitCode: EXIT.TASK_FAILED,
            cause: error,
          });
    return renderFailure(dshxError, { json: Boolean(options.json), verbose: Boolean(options.verbose) });
  }
}
