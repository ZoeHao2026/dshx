import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/dshx.js', import.meta.url));
const fakeDsh = fileURLToPath(new URL('../fixtures/fake-dsh.mjs', import.meta.url));

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-cli-'));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  return {
    root,
    cwd,
    dshHome: path.join(root, 'home'),
    state: path.join(root, 'state'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function run(workspace, args, extraEnv = {}) {
  const env = { ...process.env, DSH_HOME: workspace.dshHome, DSHX_STATE_DIR: workspace.state, ...extraEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith('FAKE_DSH_') && !(key in extraEnv)) delete env[key];
  }
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: workspace.cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
}

test('installed-style CLI: help, version, dry-run and JSON ask', { timeout: 30000 }, () => {
  const workspace = makeWorkspace();
  try {
    const version = run(workspace, ['--version']);
    assert.equal(version.status, 0);
    assert.match(version.stdout, /^dshx 0\.1\.0/);

    const help = run(workspace, ['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage:/);

    const dry = run(workspace, ['ask', '--dsh', fakeDsh, '--cwd', workspace.cwd, '--dry-run', '--json', 'hello'], {
      FAKE_DSH_MODE: 'ok',
    });
    assert.equal(dry.status, 0, dry.stderr);
    const plan = JSON.parse(dry.stdout);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.provider, 'deepseek-account');
    assert.equal(plan.model, 'deepseek-flash');

    const success = run(workspace, ['ask', '--dsh', fakeDsh, '--cwd', workspace.cwd, '--permission-mode', 'read-only', '--json', 'hello'], {
      FAKE_DSH_MODE: 'ok',
      FAKE_DSH_FINAL: 'CLI_OK',
      FAKE_DSH_SESSION_ID: 'session-cli-fixed',
    });
    assert.equal(success.status, 0, success.stderr);
    const result = JSON.parse(success.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.text, 'CLI_OK');
    assert.equal(result.sessionId, 'session-cli-fixed');
    assert.equal(result.cwd, workspace.cwd);

    const list = run(workspace, ['sessions', '--json']);
    assert.equal(list.status, 0);
    const sessions = JSON.parse(list.stdout);
    assert.equal(sessions.sessions[0].sessionId, 'session-cli-fixed');
  } finally {
    workspace.cleanup();
  }
});

test('CLI continue inherits the recorded permission and caps oversized output', { timeout: 30000 }, () => {
  const workspace = makeWorkspace();
  const firstCapture = path.join(workspace.root, 'first.json');
  const secondCapture = path.join(workspace.root, 'second.json');
  const thirdCapture = path.join(workspace.root, 'third.json');
  try {
    const first = run(
      workspace,
      ['ask', '--dsh', fakeDsh, '--cwd', workspace.cwd, '--permission-mode', 'read-only', '--json', 'first'],
      {
        FAKE_DSH_MODE: 'ok',
        FAKE_DSH_SESSION_ID: 'session-cli-continue',
        FAKE_DSH_CAPTURE: firstCapture,
      },
    );
    assert.equal(first.status, 0, first.stderr);

    const second = run(
      workspace,
      ['continue', '--dsh', fakeDsh, '--cwd', workspace.cwd, '--json', '--max-output-bytes', '50', 'second'],
      {
        FAKE_DSH_MODE: 'ok',
        FAKE_DSH_SESSION_ID: 'session-cli-continue',
        FAKE_DSH_SIZE: '200',
        FAKE_DSH_CAPTURE: secondCapture,
      },
    );
    assert.equal(second.status, 0, second.stderr);
    const result = JSON.parse(second.stdout);
    assert.equal(result.sessionId, 'session-cli-continue');
    assert.equal(result.text.length, 50);
    assert.equal(result.truncated, true);
    assert.ok(result.outputPath);
    assert.equal(fs.existsSync(result.outputPath), true);
    assert.equal(result.permissionMode, 'read-only');
    assert.equal(JSON.parse(fs.readFileSync(secondCapture, 'utf8')).env.DSH_PERMISSION_MODE, 'read-only');

    const third = run(
      workspace,
      ['continue', '--dsh', fakeDsh, '--cwd', workspace.cwd, '--permission-mode', 'danger-full-access', '--json', 'third'],
      {
        FAKE_DSH_MODE: 'ok',
        FAKE_DSH_SESSION_ID: 'session-cli-continue',
        FAKE_DSH_CAPTURE: thirdCapture,
      },
    );
    assert.equal(third.status, 0, third.stderr);
    assert.equal(JSON.parse(third.stdout).permissionMode, 'danger-full-access');
    assert.equal(JSON.parse(fs.readFileSync(thirdCapture, 'utf8')).env.DSH_PERMISSION_MODE, 'danger-full-access');
  } finally {
    workspace.cleanup();
  }
});

test('explicit --dsh path does not silently fall back', { timeout: 30000 }, () => {
  const workspace = makeWorkspace();
  try {
    const missing = run(workspace, ['ask', '--dsh', 'C:\\definitely-missing-dsh\\lib\\bin.js', '--json', 'hello']);
    assert.equal(missing.status, 3, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).error.code, 'DSH_UNAVAILABLE');
    assert.match(JSON.parse(missing.stdout).error.message, /explicit DSH entry/);
  } finally {
    workspace.cleanup();
  }
});

test('CLI maps fake auth failure and timeout to documented exit codes', { timeout: 30000 }, () => {
  const workspace = makeWorkspace();
  try {
    const auth = run(workspace, ['ask', '--dsh', fakeDsh, '--cwd', workspace.cwd, '--json', 'hello'], {
      FAKE_DSH_MODE: 'auth',
    });
    assert.equal(auth.status, 3, auth.stderr);
    assert.equal(JSON.parse(auth.stdout).error.code, 'AUTH_UNAVAILABLE');

    const timeout = run(workspace, ['ask', '--dsh', fakeDsh, '--cwd', workspace.cwd, '--timeout', '1', 'hello'], {
      FAKE_DSH_MODE: 'timeout',
    });
    assert.equal(timeout.status, 124);
  } finally {
    workspace.cleanup();
  }
});
