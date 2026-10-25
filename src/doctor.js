/** Static (and optional live) environment checks. Never prints a credential value. */
import fs from 'node:fs';
import path from 'node:path';
import { bounded, redact } from './errors.js';
import { checkNodeVersion, checkPlatform, locateDsh, resolveDshHome } from './locate.js';
import { buildOverlay, dumpConfig, validateDump, writeOverlay } from './overlay.js';
import { runTask } from './runner.js';
import { ensureStateDir, resolveStateDir } from './sessions.js';

function detailOf(error) {
  return bounded(error?.message ?? String(error), 800).replace(/\n/g, ' ');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * @param {{
 *   dsh?: string, dshHome?: string, profile: string, provider: string, model: string,
 *   reasoningEffort: string, permissionMode: string, timeout?: number, live?: boolean,
 *   allowUnvalidatedVersion?: boolean
 * }} options
 */
export async function runDoctor(options) {
  const checks = [];
  const add = (name, status, detail = '') => checks.push({ name, status, detail });
  const dshHome = resolveDshHome(options.dshHome);
  const stateDir = resolveStateDir();

  try {
    checkNodeVersion();
    add('node', 'ok', process.version);
  } catch (error) {
    add('node', 'fail', detailOf(error));
  }
  try {
    checkPlatform();
    add('platform', 'ok', process.platform);
  } catch (error) {
    add('platform', 'fail', detailOf(error));
  }

  let located;
  try {
    located = locateDsh({ dsh: options.dsh, allowUnvalidatedVersion: options.allowUnvalidatedVersion });
    add(
      'dsh',
      located.validated ? 'ok' : 'warn',
      `${located.version} at ${located.bin}${located.validated ? '' : ' (unvalidated version allowed)'}`,
    );
  } catch (error) {
    add('dsh', 'fail', detailOf(error));
  }

  try {
    if (!fs.existsSync(dshHome)) add('dsh-home', 'warn', `${dshHome} does not exist yet; DSH will create it`);
    else {
      fs.accessSync(dshHome, fs.constants.W_OK);
      add('dsh-home', 'ok', dshHome);
    }
  } catch (error) {
    add('dsh-home', 'fail', `${dshHome} is not writable (${detailOf(error)})`);
  }

  const credentialsText = readText(path.join(dshHome, '.credentials.yaml'));
  const grantPresent = credentialsText.includes('deepseek-account-platform/default') && /\btoken\s*:/.test(credentialsText);
  const envText = readText(path.join(dshHome, '.env'));
  const projectEnvText = readText(path.join(process.cwd(), '.env'));
  const apiKeyPresent =
    Boolean(process.env.DEEPSEEK_API_KEY?.trim()) ||
    /^\s*DEEPSEEK_API_KEY\s*=/m.test(envText) ||
    /^\s*DEEPSEEK_API_KEY\s*=/m.test(projectEnvText);
  if (options.provider === 'deepseek-account') {
    if (grantPresent) add('account-grant', 'ok', 'stored DeepSeek account grant record present');
    else add('account-grant', 'fail', 'no stored DeepSeek account grant found');
    if (apiKeyPresent) add('api-key', 'ok', 'DEEPSEEK_API_KEY is configured');
    else add('api-key', 'warn', 'DEEPSEEK_API_KEY is not configured (account route does not need it)');
  } else if (options.provider === 'deepseek-official') {
    if (apiKeyPresent) add('api-key', 'ok', 'DEEPSEEK_API_KEY is configured');
    else add('api-key', 'fail', 'DEEPSEEK_API_KEY is not configured');
  }

  try {
    ensureStateDir(stateDir);
    add('state-dir', 'ok', stateDir);
  } catch (error) {
    add('state-dir', 'fail', detailOf(error));
  }

  add(
    'permission',
    options.permissionMode === 'danger-full-access' ? 'warn' : 'ok',
    `${options.permissionMode}${options.permissionMode === 'danger-full-access' ? ' (DSH has full user-level file/network access)' : ''}`,
  );

  let overlayBundle;
  if (located) {
    try {
      const overlay = buildOverlay({
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        auth: options.provider === 'deepseek-account',
      });
      overlayBundle = writeOverlay(overlay);
      const expected = {
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        auth: options.provider === 'deepseek-account',
      };
      const dumpEnv = { ...process.env, DSH_HOME: dshHome };
      for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL']) {
        delete dumpEnv[key];
      }
      const dump = dumpConfig({
        dshBin: located.bin,
        profile: options.profile,
        overlayPath: overlayBundle.path,
        cwd: process.cwd(),
        env: dumpEnv,
      });
      const validation = validateDump(dump, expected);
      if (validation.ok) add('overlay', 'ok', `profile ${options.profile} composes ${options.provider}/${options.model}/${options.reasoningEffort}`);
      else add('overlay', 'fail', validation.problems.join('; '));
    } catch (error) {
      add('overlay', 'fail', detailOf(error));
    } finally {
      try {
        overlayBundle?.cleanup();
      } catch {
        // A temp-file cleanup failure must not replace the checks above.
      }
    }
  }

  if (options.live && located) {
    let liveOverlay;
    try {
      const overlay = buildOverlay({
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        auth: options.provider === 'deepseek-account',
      });
      liveOverlay = writeOverlay(overlay);
      const result = await runTask({
        dshBin: located.bin,
        profile: options.profile,
        overlayPath: liveOverlay.path,
        userPatches: [],
        cwd: process.cwd(),
        dshHome,
        prompt: 'Reply with exactly OK. Do not use any tools.',
        timeoutSec: options.timeout ?? 120,
        permissionMode: 'read-only',
        progress: false,
        verbose: false,
      });
      add('live', 'ok', `model replied in ${Math.round(result.durationMs / 1000)}s using session ${result.sessionId}`);
    } catch (error) {
      add('live', 'fail', redact(detailOf(error)));
    } finally {
      try {
        liveOverlay?.cleanup();
      } catch {
        // Keep the diagnostic result even if temp cleanup fails.
      }
    }
  }

  return { ok: !checks.some((check) => check.status === 'fail'), checks, dshHome, stateDir };
}
