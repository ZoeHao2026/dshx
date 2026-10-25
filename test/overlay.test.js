import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildOverlay,
  parseConfigRows,
  validateDump,
  writeOverlay,
} from '../src/overlay.js';

test('account overlay enables the three auth rows and sets the model', () => {
  const overlay = buildOverlay({
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
    auth: true,
  });
  assert.deepEqual(overlay.map((row) => row.id), [
    'credentials',
    'authorization',
    'deepseek-account',
    'agent-default-model',
  ]);
  assert.deepEqual(overlay[3].config, {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
  });
});

test('official overlay does not enable account rows', () => {
  const overlay = buildOverlay({
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
    auth: true,
  });
  assert.deepEqual(overlay.map((row) => row.id), ['agent-default-model']);
});

test('writeOverlay creates a private file and cleanup removes the directory', () => {
  const bundle = writeOverlay(buildOverlay({
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
  }));
  assert.equal(fs.existsSync(bundle.path), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(bundle.path, 'utf8'))[0], { id: 'credentials', disabled: false });
  const directory = bundle.directory;
  bundle.cleanup();
  assert.equal(fs.existsSync(directory), false);
});

const validDump = [
  '- id: credentials',
  '  disabled: false',
  '- id: authorization',
  '  disabled: false',
  '- id: deepseek-account',
  '  disabled: false',
  '  config:',
  '    desktopPlatform: null',
  '- id: agent-default-model',
  '  config:',
  '    provider: deepseek-account',
  '    model: deepseek-flash',
  '    reasoningEffort: max',
].join('\n');

test('validateDump accepts a complete composition', () => {
  const result = validateDump(validDump, {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
    auth: true,
  });
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.deepEqual(parseConfigRows(validDump).get('credentials').lines, ['  disabled: false']);
});

test('validateDump reports disabled auth rows and wrong model', () => {
  const disabled = validDump.replace('  disabled: false\n- id: authorization', '  disabled: true\n- id: authorization');
  const result = validateDump(disabled, {
    provider: 'deepseek-account',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'max',
    auth: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes('credentials')));
  assert.ok(result.problems.some((problem) => problem.includes('model')));
});

test('validateDump omits auth requirements for the official route', () => {
  const dump = [
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-official',
    '    model: deepseek-flash',
    '    reasoningEffort: max',
  ].join('\n');
  const result = validateDump(dump, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
    auth: false,
  });
  assert.equal(result.ok, true);
});
