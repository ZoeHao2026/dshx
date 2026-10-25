/** Append-only session registry used by `dshx continue` and `dshx sessions`. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unavailable } from './errors.js';

export function resolveStateDir(explicit) {
  if (explicit) return path.resolve(explicit);
  const fromEnvironment = process.env.DSHX_STATE_DIR;
  if (fromEnvironment && fromEnvironment.trim() !== '') return path.resolve(fromEnvironment);
  return path.join(os.homedir(), '.dshx');
}

export function ensureStateDir(stateDir) {
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw unavailable(
      'STATE_UNAVAILABLE',
      `Could not create the dshx state directory at ${stateDir}: ${error.message}`,
      'Set DSHX_STATE_DIR to a writable directory.',
      error,
    );
  }
  return stateDir;
}

export function sessionFile(stateDir) {
  return path.join(stateDir, 'sessions.jsonl');
}

export function readRecords(stateDir) {
  const file = sessionFile(stateDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw unavailable('STATE_UNAVAILABLE', `Could not read ${file}: ${error.message}`, 'Check DSHX_STATE_DIR permissions.', error);
  }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record.sessionId === 'string' && typeof record.cwd === 'string') records.push(record);
    } catch {
      // A torn last line must not make continuity unusable.
    }
  }
  return records;
}

function latestById(records) {
  const latest = new Map();
  for (const record of records) {
    const previous = latest.get(record.sessionId);
    if (!previous) {
      latest.set(record.sessionId, record);
      continue;
    }
    const previousAt = Date.parse(previous.at ?? '') || 0;
    const currentAt = Date.parse(record.at ?? '') || 0;
    if (currentAt >= previousAt) latest.set(record.sessionId, record);
  }
  return [...latest.values()];
}

function sameWorkspace(record, { cwd, dshHome, profile }) {
  return record.cwd === cwd && record.dshHome === dshHome && record.profile === profile;
}

export function listSessions({ stateDir, cwd, dshHome, profile = 'headless', all = false, limit = 50 }) {
  const records = latestById(readRecords(stateDir)).filter((record) => record.ok === true);
  const filtered = all ? records : records.filter((record) => sameWorkspace(record, { cwd, dshHome, profile }));
  filtered.sort((a, b) => (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0));
  return filtered.slice(0, limit);
}

export function latestSession(options) {
  return listSessions({ ...options, all: false, limit: 1 })[0];
}

export function appendSession(record, { stateDir }) {
  ensureStateDir(stateDir);
  const file = sessionFile(stateDir);
  const line = `${JSON.stringify({ v: 1, ...record, at: record.at ?? new Date().toISOString() })}\n`;
  fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
  prune(stateDir);
}

export function markSessionInvalid(record, { stateDir }) {
  appendSession({ ...record, ok: false, at: new Date().toISOString() }, { stateDir });
}

function prune(stateDir) {
  const file = sessionFile(stateDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 500) return;
  const kept = lines.slice(-200);
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${kept.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best effort.
    }
  }
}
