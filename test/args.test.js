import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, RUN_DEFAULTS } from '../src/args.js';

test('implicit ask with a prompt', () => {
  const options = parse(['review this diff']);
  assert.equal(options.command, 'ask');
  assert.equal(options.prompt, 'review this diff');
  assert.equal(options.provider, RUN_DEFAULTS.provider);
  assert.equal(options.model, RUN_DEFAULTS.model);
  assert.equal(options.permissionMode, 'danger-full-access');
  assert.equal(options.timeout, 1800);
  assert.equal(options.maxOutputBytes, 65536);
});

test('ask parses flags and keeps prompt words together', () => {
  const options = parse([
    'ask',
    '--json',
    '--progress',
    '--cwd',
    'D:\\work',
    '--provider',
    'deepseek-official',
    '--model',
    'deepseek-flash',
    '--reasoning-effort',
    'high',
    '--permission-mode',
    'workspace-write',
    '--timeout',
    '30',
    '--max-output-bytes',
    '10',
    '--patch',
    'a.yml',
    '--patch=b.yml',
    'do',
    'the',
    'thing',
  ]);
  assert.equal(options.command, 'ask');
  assert.equal(options.json, true);
  assert.equal(options.progress, true);
  assert.equal(options.cwd, 'D:\\work');
  assert.equal(options.provider, 'deepseek-official');
  assert.equal(options.reasoningEffort, 'high');
  assert.equal(options.permissionMode, 'workspace-write');
  assert.equal(options.timeout, 30);
  assert.equal(options.maxOutputBytes, 10);
  assert.deepEqual(options.patches, ['a.yml', 'b.yml']);
  assert.equal(options.prompt, 'do the thing');
});

test('-- stops flag parsing and keeps literal dashes', () => {
  const options = parse(['ask', '--', '--this-is-the-prompt']);
  assert.equal(options.prompt, '--this-is-the-prompt');
});

test('a lone dash requests stdin', () => {
  const options = parse(['ask', '-']);
  assert.equal(options.prompt, '-');
});

test('a dash with other words is rejected', () => {
  assert.throws(() => parse(['ask', '-', 'more']), (error) => error.code === 'INVALID_ARGUMENT');
});

test('continue rejects an explicit session', () => {
  assert.throws(
    () => parse(['continue', '--session', 'session-x', 'more']),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('invalid enum values are rejected', () => {
  assert.throws(() => parse(['ask', '--permission-mode', 'bad', 'x']), (error) => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => parse(['ask', '--reasoning-effort', 'bad', 'x']), (error) => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => parse(['ask', '--timeout', 'nope', 'x']), (error) => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => parse(['ask', '--profile', 'bad name', 'x']), (error) => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => parse(['ask', '--limit', '5', 'x']), (error) => error.code === 'INVALID_ARGUMENT');
});

test('sessions and doctor options', () => {
  const sessions = parse(['sessions', '--all', '--limit', '3', '--json', '--profile', 'other']);
  assert.equal(sessions.all, true);
  assert.equal(sessions.limit, 3);
  assert.equal(sessions.json, true);
  assert.equal(sessions.profile, 'other');
  assert.equal(parse(['sessions']).profile, 'headless');

  const doctor = parse(['doctor', '--live', '--json', '--provider', 'deepseek-official']);
  assert.equal(doctor.live, true);
  assert.equal(doctor.json, true);
  assert.equal(doctor.provider, 'deepseek-official');
});

test('help and version are top-level commands', () => {
  assert.equal(parse(['--version']).command, 'version');
  assert.equal(parse(['--help']).command, 'help');
  assert.equal(parse(['ask', '--help']).help, true);
  assert.equal(parse(['help', 'doctor']).topic, 'doctor');
});
