import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DshxError } from '../src/errors.js';
import {
  renderFailure,
  renderSessions,
  renderSuccess,
  truncateUtf8,
} from '../src/render.js';

function capture(fn) {
  const stdout = [];
  const stderr = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    const code = fn();
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

test('truncateUtf8 preserves whole code points', () => {
  assert.equal(truncateUtf8('汉字abc', 4), '汉');
  assert.equal(truncateUtf8('short', 100), 'short');
  assert.equal(truncateUtf8('anything', 0), 'anything');
});

test('renderSuccess truncates text and saves the full answer', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-render-'));
  try {
    const text = 'x'.repeat(100);
    const result = { text, sessionId: 'session-render', durationMs: 12, eventSummary: {} };
    const run = capture(() =>
      renderSuccess(result, { maxOutputBytes: 10, stateDir }),
    );
    assert.equal(run.stdout, `${'x'.repeat(10)}\n`);
    assert.match(run.stderr, /answer truncated/);
    const runs = fs.readdirSync(path.join(stateDir, 'runs'));
    assert.equal(runs.length, 1);
    assert.equal(fs.readFileSync(path.join(stateDir, 'runs', runs[0]), 'utf8'), text);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('renderSuccess JSON envelope carries metadata without prompt', () => {
  const result = {
    text: 'ok',
    sessionId: 'session-json',
    durationMs: 5,
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
    permissionMode: 'read-only',
    cwd: 'C:\\work',
    dshHome: 'C:\\Users\\me\\.dsh',
    eventSummary: {},
  };
  const run = capture(() => renderSuccess(result, { json: true, maxOutputBytes: 0 }));
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sessionId, 'session-json');
  assert.equal(parsed.provider, 'deepseek-account');
  assert.equal(parsed.text, 'ok');
});

test('renderFailure writes a JSON envelope and returns its exit code', () => {
  const error = new DshxError('AUTH_UNAVAILABLE', 'no login', {
    exitCode: 3,
    hint: 'sign in',
    details: { sessionId: 'session-partial' },
  });
  const run = capture(() => renderFailure(error, { json: true }));
  const parsed = JSON.parse(run.stdout);
  assert.equal(run.code, 3);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.sessionId, 'session-partial');
  assert.equal(parsed.error.code, 'AUTH_UNAVAILABLE');
  assert.equal(parsed.exitCode, 3);
});

test('renderSessions emits a JSON envelope', () => {
  const run = capture(() =>
    renderSessions(
      [{ sessionId: 's1', cwd: 'C:\\work', provider: 'deepseek-account', model: 'deepseek-flash', at: '2026-01-01T00:00:00.000Z' }],
      { json: true },
    ),
  );
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sessions[0].sessionId, 's1');
});
