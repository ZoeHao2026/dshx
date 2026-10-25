/** Streaming parser for DSH headless --json NDJSON events. */
import { bounded, protocolError, redact } from './errors.js';

export const EVENT_TYPES = Object.freeze([
  'session',
  'status',
  'text',
  'thinking',
  'tool_call',
  'tool_result',
  'error',
  'final',
]);

const ALLOWED = new Set(EVENT_TYPES);
const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Split UTF-8 byte chunks into lines without buffering the whole stream.
 * @param {(line: string) => void} onLine
 */
export function createLineDecoder(onLine, { maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
          throw protocolError(`DSH emitted an oversized output line (>${maxLineBytes} bytes).`);
        }
        onLine(line);
        index = buffer.indexOf('\n');
      }
      if (Buffer.byteLength(buffer, 'utf8') > maxLineBytes) {
        throw protocolError(`DSH emitted an oversized partial output line (>${maxLineBytes} bytes).`);
      }
    },
    end() {
      if (buffer.length === 0) return;
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      buffer = '';
      onLine(line);
    },
  };
}

function short(value, limit = 120) {
  const text = redact(value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function toolSummary(event) {
  const name = typeof event.tool === 'string' && event.tool ? event.tool : 'tool';
  let detail = '';
  const input = event.input;
  if (typeof input === 'string') detail = short(input);
  else if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const key of ['path', 'command', 'pattern', 'query', 'url', 'description']) {
      if (typeof input[key] === 'string' && input[key].length > 0) {
        detail = short(input[key]);
        break;
      }
    }
  }
  return detail ? `${name}: ${detail}` : name;
}

export class EventCollector {
  /** @param {{onProgress?: (message: string) => void}} [options] */
  constructor(options = {}) {
    this.onProgress = options.onProgress;
    this.sessionId = undefined;
    this.sessionCwd = undefined;
    this.finalText = undefined;
    this.error = undefined;
    this.turnEndReason = undefined;
    this.eventTypes = [];
    this.toolCalls = 0;
    this.thinkingEvents = 0;
    this.noise = [];
  }

  handle(line) {
    if (line.trim() === '') return;

    if (!line.trimStart().startsWith('{')) {
      this.noise.push(bounded(line, 1000));
      while (this.noise.length > 20) this.noise.shift();
      return;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw protocolError(`DSH emitted invalid JSON on stdout: ${short(line, 200)}`, 'The installed DSH version may not match the dshx event contract.');
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      throw protocolError('DSH emitted an event without a string type.');
    }
    if (this.finalText !== undefined) {
      throw protocolError(`DSH emitted ${event.type} after its final event.`);
    }
    if (!ALLOWED.has(event.type)) {
      throw protocolError(`Unsupported DSH event type ${JSON.stringify(event.type)}.`);
    }

    this.eventTypes.push(event.type);

    switch (event.type) {
      case 'session': {
        if (typeof event.sessionId !== 'string' || event.sessionId.length === 0) {
          throw protocolError('DSH session event did not carry a sessionId.');
        }
        if (this.sessionId !== undefined && this.sessionId !== event.sessionId) {
          throw protocolError('DSH emitted more than one session identity.');
        }
        this.sessionId = event.sessionId;
        if (typeof event.cwd === 'string') this.sessionCwd = event.cwd;
        break;
      }
      case 'status': {
        if (event.phase === 'turn_end') {
          if (typeof event.reason?.kind === 'string') this.turnEndReason = event.reason.kind;
          if (this.onProgress) this.onProgress(`turn ended: ${event.reason?.kind ?? 'unknown'}`);
        } else if (event.phase === 'turn_start') {
          if (this.onProgress) this.onProgress(`turn ${event.turn ?? '?'} started`);
        } else if (event.phase === 'step_start') {
          if (this.onProgress) this.onProgress(`step ${event.step ?? '?'} started`);
        } else if (event.phase === 'step_end') {
          if (this.onProgress) this.onProgress(`step ${event.step ?? '?'} finished`);
        }
        break;
      }
      case 'text':
      case 'thinking': {
        if (event.type === 'thinking') this.thinkingEvents += 1;
        break;
      }
      case 'tool_call': {
        this.toolCalls += 1;
        if (this.onProgress) this.onProgress(`tool ${toolSummary(event)}`);
        break;
      }
      case 'tool_result': {
        if (this.onProgress) {
          const status = typeof event.status === 'string' ? event.status : 'finished';
          this.onProgress(`tool result ${status}`);
        }
        break;
      }
      case 'error': {
        this.error = {
          code: typeof event.code === 'string' ? event.code : undefined,
          message: typeof event.message === 'string' ? event.message : 'DSH reported an error.',
        };
        break;
      }
      case 'final': {
        if (typeof event.text !== 'string') {
          throw protocolError('DSH final event did not carry a string text.');
        }
        this.finalText = event.text;
        break;
      }
      default:
        throw protocolError(`Unsupported DSH event type ${JSON.stringify(event.type)}.`);
    }
  }

  summary() {
    return {
      events: this.eventTypes.length,
      toolCalls: this.toolCalls,
      thinkingEvents: this.thinkingEvents,
      turnEndReason: this.turnEndReason,
      noiseLines: this.noise.length,
    };
  }

  noiseTail() {
    return this.noise.join('\n');
  }
}
