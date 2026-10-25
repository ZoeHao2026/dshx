import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendSession,
  latestSession,
  listSessions,
  markSessionInvalid,
  readRecords,
  sessionFile,
} from '../src/sessions.js';

function workspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-sessions-'));
  return {
    directory,
    stateDir: path.join(directory, 'state'),
    cwd: path.join(directory, 'work'),
    dshHome: path.join(directory, 'home'),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test('append, list and latest within one workspace', () => {
  const w = workspace();
  try {
    appendSession({ sessionId: 's1', cwd: w.cwd, dshHome: w.dshHome, profile: 'headless', ok: true, at: '2026-01-01T00:00:00.000Z' }, { stateDir: w.stateDir });
    appendSession({ sessionId: 's2', cwd: w.cwd, dshHome: w.dshHome, profile: 'headless', ok: true, at: '2026-01-02T00:00:00.000Z' }, { stateDir: w.stateDir });
    assert.equal(readRecords(w.stateDir).length, 2);
    assert.equal(latestSession(w).sessionId, 's2');
    assert.deepEqual(listSessions({ ...w, limit: 10 }).map((row) => row.sessionId), ['s2', 's1']);
  } finally {
    w.cleanup();
  }
});

test('a tombstone prevents a broken session from being selected', () => {
  const w = workspace();
  try {
    appendSession({ sessionId: 's1', cwd: w.cwd, dshHome: w.dshHome, profile: 'headless', ok: true, at: '2026-01-01T00:00:00.000Z' }, { stateDir: w.stateDir });
    markSessionInvalid({ sessionId: 's1', cwd: w.cwd, dshHome: w.dshHome, profile: 'headless' }, { stateDir: w.stateDir });
    assert.equal(latestSession(w), undefined);
  } finally {
    w.cleanup();
  }
});

test('workspace filtering and --all', () => {
  const w = workspace();
  try {
    appendSession({ sessionId: 's1', cwd: w.cwd, dshHome: w.dshHome, profile: 'headless', ok: true, at: '2026-01-01T00:00:00.000Z' }, { stateDir: w.stateDir });
    appendSession({ sessionId: 'other', cwd: path.join(w.directory, 'other'), dshHome: w.dshHome, profile: 'headless', ok: true, at: '2026-01-02T00:00:00.000Z' }, { stateDir: w.stateDir });
    assert.deepEqual(listSessions({ ...w, limit: 10 }).map((row) => row.sessionId), ['s1']);
    assert.deepEqual(listSessions({ ...w, all: true, limit: 10 }).map((row) => row.sessionId), ['other', 's1']);
  } finally {
    w.cleanup();
  }
});

test('corrupt lines are ignored and pruning keeps the file bounded', () => {
  const w = workspace();
  try {
    appendSession({ sessionId: 's1', cwd: w.cwd, dshHome: w.dshHome, profile: 'headless', ok: true }, { stateDir: w.stateDir });
    fs.appendFileSync(sessionFile(w.stateDir), '{broken\n');
    assert.equal(readRecords(w.stateDir).length, 1);
    for (let index = 0; index < 520; index += 1) {
      appendSession({
        sessionId: `s-${index}`,
        cwd: w.cwd,
        dshHome: w.dshHome,
        profile: 'headless',
        ok: true,
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      }, { stateDir: w.stateDir });
    }
    const lines = fs.readFileSync(sessionFile(w.stateDir), 'utf8').split(/\r?\n/).filter(Boolean);
    assert.ok(lines.length <= 500, `expected pruning, got ${lines.length}`);
  } finally {
    w.cleanup();
  }
});
