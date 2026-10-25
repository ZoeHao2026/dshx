import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineDecoder, EventCollector } from '../src/events.js';

test('line decoder handles split chunks and a final line without newline', () => {
  const lines = [];
  const decoder = createLineDecoder((line) => lines.push(line));
  decoder.push('{"type":"session","sessionId":"s1"}\n{"type":');
  decoder.push('"status","phase":"turn_end"}\r\nlast');
  decoder.end();
  assert.deepEqual(lines, [
    '{"type":"session","sessionId":"s1"}',
    '{"type":"status","phase":"turn_end"}',
    'last',
  ]);
});

test('line decoder rejects an oversized line', () => {
  const decoder = createLineDecoder(() => {}, { maxLineBytes: 4 });
  assert.throws(() => decoder.push('123456789'), (error) => error.code === 'PROTOCOL_ERROR');
});

test('collector captures session, tools and final text', () => {
  const progress = [];
  const collector = new EventCollector({ onProgress: (message) => progress.push(message) });
  collector.handle('{"type":"session","sessionId":"session-1"}');
  collector.handle('{"type":"status","phase":"turn_start"}');
  collector.handle('{"type":"tool_call","tool":"write","input":{"path":"a.txt"}}');
  collector.handle('{"type":"tool_result","status":"completed"}');
  collector.handle('{"type":"text","text":"working"}');
  collector.handle('{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}');
  collector.handle('{"type":"final","text":"done"}');

  assert.equal(collector.sessionId, 'session-1');
  assert.equal(collector.finalText, 'done');
  assert.equal(collector.turnEndReason, 'completed');
  assert.equal(collector.toolCalls, 1);
  assert.deepEqual(progress, [
    'turn ? started',
    'tool write: a.txt',
    'tool result completed',
    'turn ended: completed',
  ]);
});

test('collector reports step boundaries through progress', () => {
  const progress = [];
  const collector = new EventCollector({ onProgress: (message) => progress.push(message) });
  collector.handle('{"type":"status","phase":"turn_start","turn":2}');
  collector.handle('{"type":"status","phase":"step_start","turn":2,"step":1}');
  collector.handle('{"type":"status","phase":"step_end","turn":2,"step":1}');
  collector.handle('{"type":"status","phase":"turn_end","turn":2,"reason":{"kind":"completed"}}');
  assert.deepEqual(progress, [
    'turn 2 started',
    'step 1 started',
    'step 1 finished',
    'turn ended: completed',
  ]);
});

test('collector ignores plugin noise on stdout', () => {
  const collector = new EventCollector();
  collector.handle('PLUGIN NOISE');
  collector.handle('{"type":"session","sessionId":"s1"}');
  collector.handle('{"type":"final","text":"ok"}');
  assert.equal(collector.finalText, 'ok');
  assert.equal(collector.noise.length, 1);
});

test('collector rejects malformed JSON, unknown events and events after final', () => {
  assert.throws(() => new EventCollector().handle('{not json'), (error) => error.code === 'PROTOCOL_ERROR');
  assert.throws(() => {
    const collector = new EventCollector();
    collector.handle('{"type":"mystery"}');
  }, (error) => error.code === 'PROTOCOL_ERROR');
  assert.throws(() => {
    const collector = new EventCollector();
    collector.handle('{"type":"final","text":"ok"}');
    collector.handle('{"type":"text","text":"late"}');
  }, (error) => error.code === 'PROTOCOL_ERROR');
});

test('collector captures an error event', () => {
  const collector = new EventCollector();
  collector.handle('{"type":"error","code":"ACCOUNT_SIGN_IN_REQUIRED","message":"missing"}');
  assert.deepEqual(collector.error, { code: 'ACCOUNT_SIGN_IN_REQUIRED', message: 'missing' });
});
