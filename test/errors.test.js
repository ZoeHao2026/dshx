import test from 'node:test';
import assert from 'node:assert/strict';
import { mapDshFailure, redact } from '../src/errors.js';

test('credential failure codes map to exit 3', () => {
  for (const code of ['ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_TOKEN_INVALID', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL']) {
    const error = mapDshFailure({ code, message: 'bad credential' }, { exitCode: 1 });
    assert.equal(error.code, 'AUTH_UNAVAILABLE', code);
    assert.equal(error.exitCode, 3, code);
  }
});

test('redact masks credentials while keeping session ids readable', () => {
  const session = 'session-12345678-1234-1234-1234-123456789abc';
  const token = 'a'.repeat(64);
  const output = redact(`session=${session} token=${token} key=sk-fakevalue`);
  assert.match(output, new RegExp(session));
  assert.doesNotMatch(output, new RegExp(token));
  assert.match(output, /sk-<redacted>/);
});
