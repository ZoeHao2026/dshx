import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOverlay, writeOverlay } from '../src/overlay.js';
import { runTask } from '../src/runner.js';

const fakeDsh = fileURLToPath(new URL('../fixtures/fake-dsh.mjs', import.meta.url));

function setEnv(values) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function temporaryWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-runner-'));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  return {
    root,
    cwd,
    dshHome: path.join(root, 'home'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function baseOptions(workspace, overrides = {}) {
  const overlay = writeOverlay(buildOverlay({
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
  }));
  return {
    overlay,
    options: {
      dshBin: fakeDsh,
      profile: 'headless',
      overlayPath: overlay.path,
      userPatches: [],
      cwd: workspace.cwd,
      dshHome: workspace.dshHome,
      prompt: 'say hello',
      timeoutSec: 10,
      permissionMode: 'read-only',
      progress: false,
      verbose: false,
      ...overrides,
    },
  };
}

test('successful task returns final text and captures prompt/argv', { timeout: 20000 }, async () => {
  const workspace = temporaryWorkspace();
  const capture = path.join(workspace.root, 'capture.json');
  const restore = setEnv({
    FAKE_DSH_MODE: 'ok',
    FAKE_DSH_FINAL: 'HELLO',
    FAKE_DSH_CAPTURE: capture,
    FAKE_DSH_SESSION_ID: 'session-unit-1',
    FAKE_DSH_TOOL: '1',
  });
  const { overlay, options } = await baseOptions(workspace);
  try {
    const result = await runTask(options);
    assert.equal(result.text, 'HELLO');
    assert.equal(result.sessionId, 'session-unit-1');
    assert.equal(result.eventSummary.toolCalls, 1);
    const seen = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.equal(seen.prompt, 'say hello');
    assert.equal(seen.cwd, workspace.cwd);
    assert.ok(seen.argv.includes('--json'));
    assert.ok(seen.argv.includes('-'));
    assert.equal(seen.argv.includes('--session-id'), false);
  } finally {
    restore();
    overlay.cleanup();
    workspace.cleanup();
  }
});

test('explicit session id is passed to DSH', { timeout: 20000 }, async () => {
  const workspace = temporaryWorkspace();
  const capture = path.join(workspace.root, 'capture.json');
  const restore = setEnv({ FAKE_DSH_MODE: 'ok', FAKE_DSH_CAPTURE: capture });
  const { overlay, options } = await baseOptions(workspace, { sessionId: 'session-resume' });
  try {
    await runTask(options);
    const seen = JSON.parse(fs.readFileSync(capture, 'utf8'));
    const index = seen.argv.indexOf('--session-id');
    assert.notEqual(index, -1);
    assert.equal(seen.argv[index + 1], 'session-resume');
  } finally {
    restore();
    overlay.cleanup();
    workspace.cleanup();
  }
});

test('auth and missing-session failures map to exit code 3', { timeout: 20000 }, async () => {
  for (const mode of ['auth', 'session-missing', 'session-missing-stderr']) {
    const workspace = temporaryWorkspace();
    const restore = setEnv({ FAKE_DSH_MODE: mode });
    const { overlay, options } = await baseOptions(workspace);
    try {
      await assert.rejects(
        runTask(options),
        (error) => error.exitCode === 3 && ['AUTH_UNAVAILABLE', 'SESSION_UNAVAILABLE'].includes(error.code),
      );
    } finally {
      restore();
      overlay.cleanup();
      workspace.cleanup();
    }
  }
});

test('generic task failure maps to exit code 1', { timeout: 20000 }, async () => {
  const workspace = temporaryWorkspace();
  const restore = setEnv({ FAKE_DSH_MODE: 'fail' });
  const { overlay, options } = await baseOptions(workspace);
  try {
    await assert.rejects(runTask(options), (error) => error.code === 'TASK_FAILED' && error.exitCode === 1);
  } finally {
    restore();
    overlay.cleanup();
    workspace.cleanup();
  }
});

test('protocol violations map to exit code 4', { timeout: 20000 }, async () => {
  for (const mode of ['unknown', 'empty', 'after-final']) {
    const workspace = temporaryWorkspace();
    const restore = setEnv({ FAKE_DSH_MODE: mode });
    const { overlay, options } = await baseOptions(workspace);
    try {
      await assert.rejects(runTask(options), (error) => error.code === 'PROTOCOL_ERROR' && error.exitCode === 4);
    } finally {
      restore();
      overlay.cleanup();
      workspace.cleanup();
    }
  }
});

test('large final text is returned intact for the renderer to cap', { timeout: 20000 }, async () => {
  const workspace = temporaryWorkspace();
  const restore = setEnv({ FAKE_DSH_MODE: 'ok', FAKE_DSH_SIZE: '100000' });
  const { overlay, options } = await baseOptions(workspace);
  try {
    const result = await runTask(options);
    assert.equal(result.text.length, 100000);
  } finally {
    restore();
    overlay.cleanup();
    workspace.cleanup();
  }
});

test('timeout kills the process tree and returns exit code 124', { timeout: 25000 }, async () => {
  const workspace = temporaryWorkspace();
  const pidFile = path.join(workspace.root, 'pid.txt');
  const restore = setEnv({ FAKE_DSH_MODE: 'timeout', FAKE_DSH_PID_FILE: pidFile });
  const { overlay, options } = await baseOptions(workspace, { timeoutSec: 1 });
  try {
    await assert.rejects(runTask(options), (error) => error.code === 'TIMEOUT' && error.exitCode === 124);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        alive = false;
        break;
      }
    }
    assert.equal(alive, false, `fake DSH pid ${pid} is still alive after timeout`);
  } finally {
    restore();
    overlay.cleanup();
    workspace.cleanup();
  }
});
