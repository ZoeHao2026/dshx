/** Generate and validate the temporary DSH profile overlay used for every run. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bounded, unavailable } from './errors.js';

const EFFORTS = new Set(['off', 'low', 'high', 'max']);

/**
 * Build the overlay array. Auth rows are only meaningful for the account route.
 * @param {{provider: string, model: string, reasoningEffort: string, auth?: boolean}} options
 */
export function buildOverlay(options) {
  const { provider, model, reasoningEffort } = options;
  if (!provider || !model) throw new TypeError('provider and model are required');
  if (!EFFORTS.has(reasoningEffort)) throw new TypeError(`unsupported reasoning effort ${reasoningEffort}`);
  const auth = options.auth !== false && provider === 'deepseek-account';
  const rows = [];
  if (auth) {
    rows.push(
      { id: 'credentials', disabled: false },
      { id: 'authorization', disabled: false },
      { id: 'deepseek-account', disabled: false },
    );
  }
  rows.push({
    id: 'agent-default-model',
    config: { provider, model, reasoningEffort },
  });
  return rows;
}

/**
 * Write the overlay to a private temp file. Call cleanup() in a finally block.
 * @param {unknown[]} overlay
 */
export function writeOverlay(overlay) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-'));
  const file = path.join(directory, 'overlay.json');
  try {
    fs.writeFileSync(file, `${JSON.stringify(overlay, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw unavailable('OVERLAY_INVALID', `Could not write the temporary overlay: ${error.message}`, 'Check that the system temp directory is writable.');
  }
  return {
    path: file,
    directory,
    cleanup() {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        // Temp cleanup is best effort; it must never override the task result.
      }
    },
  };
}

function dshArgs(dshBin, profile, overlayPath, userPatches, extra = []) {
  const args = [dshBin, '--profile', profile, '--patch', overlayPath];
  for (const patch of userPatches) args.push('--patch', patch);
  args.push(...extra);
  return args;
}

/**
 * Compose the profile without mounting a model. This is the same dump-config
 * contract used by dsh itself; it never runs an agent turn.
 */
export function dumpConfig({ dshBin, profile, overlayPath, userPatches = [], cwd, env = process.env }) {
  const args = dshArgs(dshBin, profile, overlayPath, userPatches, ['--dump-config']);
  try {
    return execFileSync(process.execPath, args, {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : '';
    const stdout = error?.stdout ? String(error.stdout) : '';
    throw unavailable(
      'OVERLAY_INVALID',
      `DSH rejected the composed profile: ${error.message}${stderr ? `\n${bounded(stderr.slice(-1600), 1600)}` : ''}${stdout ? `\n${bounded(stdout.slice(-800), 800)}` : ''}`,
      'Run dshx doctor; if a custom --patch is involved, remove it and try again.',
      error,
    );
  }
}

/** Split a dump-config document into the last block for each row id. */
export function parseConfigRows(text) {
  const rows = new Map();
  let current;
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line);
    if (match) {
      current = { id: match[1].replace(/^['"]|['"]$/g, ''), lines: [] };
      rows.set(current.id, current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return rows;
}

function scalar(block, field) {
  const match = new RegExp(`^\\s+${field}:\\s*(.+?)\\s*$`, 'm').exec(block);
  if (!match) return undefined;
  return match[1].replace(/^['"]|['"]$/g, '');
}

/**
 * Check that the composed tree really enables the expected rows and model.
 * @param {string} text
 * @param {{provider: string, model: string, reasoningEffort: string, auth: boolean}} expected
 */
export function validateDump(text, expected) {
  const rows = parseConfigRows(text);
  const problems = [];

  if (expected.auth) {
    for (const id of ['credentials', 'authorization', 'deepseek-account']) {
      const row = rows.get(id);
      if (!row) problems.push(`row ${id} is missing`);
      else {
        const block = row.lines.join('\n');
        if (/^\s*disabled:\s*true\b/m.test(block)) problems.push(`row ${id} is still disabled`);
      }
    }
  }

  const modelRow = rows.get('agent-default-model');
  if (!modelRow) {
    problems.push('row agent-default-model is missing');
  } else {
    const block = modelRow.lines.join('\n');
    const provider = scalar(block, 'provider');
    const model = scalar(block, 'model');
    const effort = scalar(block, 'reasoningEffort');
    if (provider !== expected.provider) problems.push(`agent-default-model.provider is ${provider ?? 'missing'}, expected ${expected.provider}`);
    if (model !== expected.model) problems.push(`agent-default-model.model is ${model ?? 'missing'}, expected ${expected.model}`);
    if (effort !== expected.reasoningEffort) problems.push(`agent-default-model.reasoningEffort is ${effort ?? 'missing'}, expected ${expected.reasoningEffort}`);
  }

  return { ok: problems.length === 0, problems, rowIds: [...rows.keys()] };
}

export function assertDumpValid(text, expected) {
  const result = validateDump(text, expected);
  if (!result.ok) {
    throw unavailable(
      'OVERLAY_INVALID',
      `The composed DSH profile does not match the requested model/auth route: ${result.problems.join('; ')}`,
      'Run dshx doctor and inspect the overlay output; a conflicting --patch may be overriding these rows.',
    );
  }
  return result;
}

/** A secret-free description used by --dry-run and doctor diagnostics. */
export function describeOverlay(overlay, expected) {
  return {
    rows: overlay.map((row) => row.id),
    provider: expected.provider,
    model: expected.model,
    reasoningEffort: expected.reasoningEffort,
    auth: expected.auth,
  };
}
