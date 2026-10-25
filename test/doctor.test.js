import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor } from '../src/doctor.js';

const fakeDsh = fileURLToPath(new URL('../fixtures/fake-dsh.mjs', import.meta.url));

function makeHome(withGrant) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-doctor-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  if (withGrant) {
    fs.writeFileSync(
      path.join(home, '.credentials.yaml'),
      [
        'version: 1',
        'records:',
        '  deepseek-account-platform/default:',
        '    kind: grant',
        '    payload:',
        '      token: fake-test-token',
      ].join('\n'),
      'utf8',
    );
  }
  return {
    root,
    home,
    state: path.join(root, 'state'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function withState(state, fn) {
  const previous = process.env.DSHX_STATE_DIR;
  process.env.DSHX_STATE_DIR = state;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.DSHX_STATE_DIR;
    else process.env.DSHX_STATE_DIR = previous;
  }
}

test('doctor validates a fake account composition without a model request', { timeout: 30000 }, async () => {
  const fixture = makeHome(true);
  try {
    const report = await withState(fixture.state, () =>
      runDoctor({
        dsh: fakeDsh,
        dshHome: fixture.home,
        profile: 'headless',
        provider: 'deepseek-account',
        model: 'deepseek-flash',
        reasoningEffort: 'max',
        permissionMode: 'danger-full-access',
        live: false,
      }),
    );
    assert.equal(report.ok, true, JSON.stringify(report.checks));
    assert.ok(report.checks.some((check) => check.name === 'overlay' && check.status === 'ok'));
    assert.ok(report.checks.some((check) => check.name === 'account-grant' && check.status === 'ok'));
  } finally {
    fixture.cleanup();
  }
});

test('doctor fails the account check without a stored grant', { timeout: 30000 }, async () => {
  const fixture = makeHome(false);
  try {
    const report = await withState(fixture.state, () =>
      runDoctor({
        dsh: fakeDsh,
        dshHome: fixture.home,
        profile: 'headless',
        provider: 'deepseek-account',
        model: 'deepseek-flash',
        reasoningEffort: 'max',
        permissionMode: 'danger-full-access',
        live: false,
      }),
    );
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((check) => check.name === 'account-grant' && check.status === 'fail'));
  } finally {
    fixture.cleanup();
  }
});
