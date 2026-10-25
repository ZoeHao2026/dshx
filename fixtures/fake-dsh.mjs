#!/usr/bin/env node
/** Deterministic stand-in for @deepseek-ai/dsh used by dshx tests. */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

function patchRows() {
  const rows = new Map([
    ['credentials', { disabled: true }],
    ['authorization', { disabled: true }],
    ['deepseek-account', { disabled: true }],
    ['agent-default-model', { config: { provider: 'deepseek-official', model: 'deepseek-flash' } }],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--patch') continue;
    const file = argv[index + 1];
    const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string') continue;
      const previous = rows.get(entry.id) ?? {};
      rows.set(entry.id, {
        ...previous,
        ...(Object.hasOwn(entry, 'disabled') ? { disabled: entry.disabled } : {}),
        ...(entry.config ? { config: { ...(previous.config ?? {}), ...entry.config } } : {}),
      });
    }
  }
  return rows;
}

if (argv.includes('--version')) {
  process.stdout.write('0.2.1-rc.2\n');
  process.exit(0);
}

if (argv.includes('--dump-config')) {
  if (process.env.FAKE_DSH_DUMP_FILE) {
    process.stdout.write(fs.readFileSync(process.env.FAKE_DSH_DUMP_FILE, 'utf8'));
    process.exit(0);
  }
  const rows = patchRows();
  const lines = [];
  for (const id of ['credentials', 'authorization', 'deepseek-account']) {
    const row = rows.get(id);
    lines.push(`- id: ${id}`, `  disabled: ${row?.disabled === true ? 'true' : 'false'}`);
  }
  const model = rows.get('agent-default-model').config;
  lines.push(
    '- id: agent-default-model',
    '  config:',
    `    provider: ${model.provider}`,
    `    model: ${model.model}`,
    `    reasoningEffort: ${model.reasoningEffort ?? 'high'}`,
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const capture = process.env.FAKE_DSH_CAPTURE;
if (capture) fs.writeFileSync(capture, JSON.stringify({ argv, cwd: process.cwd(), prompt }));
const pidFile = process.env.FAKE_DSH_PID_FILE;
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));

const mode = process.env.FAKE_DSH_MODE ?? 'ok';
const sessionId = process.env.FAKE_DSH_SESSION_ID ?? `session-fake-${process.pid}`;
const expectedPrompt = process.env.FAKE_DSH_EXPECT_PROMPT;

emit({ type: 'session', sessionId, cwd: process.cwd() });
emit({ type: 'status', phase: 'turn_start', turn: 1 });

if (expectedPrompt !== undefined && prompt !== expectedPrompt) {
  emit({ type: 'error', code: 'TASK_FAILED', message: 'prompt mismatch' });
  process.exit(1);
}

if (mode === 'timeout') {
  // Keep the process alive without an unsettled top-level await (Node would exit 13).
  await new Promise((resolve) => setTimeout(resolve, 600000));
}

if (mode === 'noise') process.stdout.write('PLUGIN NOISE\n');

if (mode === 'fail') {
  emit({ type: 'error', code: 'TASK_FAILED', message: 'fake task failure' });
  emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error' } });
  process.exit(1);
}
if (mode === 'auth') {
  emit({ type: 'error', code: 'ACCOUNT_SIGN_IN_REQUIRED', message: 'fake account missing' });
  emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error' } });
  process.exit(1);
}
if (mode === 'session-missing') {
  emit({ type: 'error', code: 'SESSION_NOT_FOUND', message: 'fake session missing' });
  emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error' } });
  process.exit(1);
}
if (mode === 'session-missing-stderr') {
  process.stderr.write('dsh: session "fake" does not exist; omit --session-id to start a new Session\n');
  process.exit(1);
}
if (mode === 'unknown') {
  emit({ type: 'mystery', value: true });
  process.exit(0);
}
if (mode === 'empty') {
  emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
  process.exit(0);
}
if (mode === 'badjson') {
  process.stdout.write('{not json\n');
}

if (process.env.FAKE_DSH_TOOL === '1') {
  emit({ type: 'tool_call', callId: 'call-1', tool: 'write', input: { path: 'hello.txt' } });
  emit({ type: 'tool_result', callId: 'call-1', status: 'completed', result: 'ok' });
}
emit({ type: 'text', text: 'working' });
emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
const size = Number(process.env.FAKE_DSH_SIZE ?? '0');
const text = size > 0 ? 'x'.repeat(size) : process.env.FAKE_DSH_FINAL ?? 'OK';
emit({ type: 'final', text });
if (mode === 'after-final') emit({ type: 'text', text: 'too late' });
process.exit(0);
