/** Zero-dependency command grammar for dshx. Values are never guessed from DSH state. */
import { usageError } from './errors.js';

const COMMANDS = new Set(['ask', 'run', 'continue', 'sessions', 'doctor', 'brief']);

export const RUN_DEFAULTS = Object.freeze({
  profile: 'headless',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
  permissionMode: 'danger-full-access',
  timeout: 1800,
  maxOutputBytes: 65536,
  authOverlay: true,
  allowUnvalidatedVersion: false,
});

const VALUE_FLAGS = new Map([
  ['--cwd', 'cwd'],
  ['-C', 'cwd'],
  ['--session', 'sessionId'],
  ['--provider', 'provider'],
  ['--model', 'model'],
  ['--reasoning-effort', 'reasoningEffort'],
  ['--permission-mode', 'permissionMode'],
  ['--profile', 'profile'],
  ['--patch', 'patches'],
  ['--dsh', 'dsh'],
  ['--dsh-home', 'dshHome'],
  ['--timeout', 'timeout'],
  ['--max-output-bytes', 'maxOutputBytes'],
  ['--limit', 'limit'],
]);

const EFFORTS = new Set(['off', 'low', 'high', 'max']);
const PERMISSIONS = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function nextValue(args, index, flag) {
  const value = args[index + 1];
  if (value === undefined) throw usageError(`${flag} requires a value`);
  if (value === '' && flag !== '--patch') throw usageError(`${flag} requires a non-empty value`);
  return value;
}

function parseInteger(value, flag, { min = 0 } = {}) {
  if (!/^\d+$/.test(String(value))) throw usageError(`${flag} must be a non-negative integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > 2147483647 || number < min) {
    throw usageError(`${flag} is out of range`);
  }
  return number;
}

function defaultRunOptions(command) {
  return {
    command,
    profile: RUN_DEFAULTS.profile,
    provider: RUN_DEFAULTS.provider,
    model: RUN_DEFAULTS.model,
    reasoningEffort: RUN_DEFAULTS.reasoningEffort,
    permissionMode: RUN_DEFAULTS.permissionMode,
    timeout: RUN_DEFAULTS.timeout,
    maxOutputBytes: RUN_DEFAULTS.maxOutputBytes,
    authOverlay: RUN_DEFAULTS.authOverlay,
    allowUnvalidatedVersion: RUN_DEFAULTS.allowUnvalidatedVersion,
    cwd: undefined,
    sessionId: undefined,
    patches: [],
    dsh: undefined,
    dshHome: undefined,
    prompt: undefined,
    json: false,
    progress: false,
    verbose: false,
    dryRun: false,
    help: false,
  };
}

function parseRun(command, args) {
  const options = defaultRunOptions(command === 'continue' ? 'continue' : 'ask');
  const positionals = [];
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (token === '-h' || token === '--help') {
      help = true;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--progress') {
      options.progress = true;
      continue;
    }
    if (token === '--verbose') {
      options.verbose = true;
      continue;
    }
    if (token === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (token === '--no-auth-overlay') {
      options.authOverlay = false;
      continue;
    }
    if (token === '--allow-unvalidated-version') {
      options.allowUnvalidatedVersion = true;
      continue;
    }
    if (token === '-') {
      positionals.push(token);
      continue;
    }
    if (token.startsWith('-')) {
      const equal = token.indexOf('=');
      const flag = equal < 0 ? token : token.slice(0, equal);
      const key = VALUE_FLAGS.get(flag);
      if (key === undefined) throw usageError(`Unknown option ${flag}`);
      let value;
      if (equal >= 0) {
        value = token.slice(equal + 1);
        if (value === '') throw usageError(`${flag} requires a value`);
      } else {
        value = nextValue(args, index, flag);
        index += 1;
      }
      if (key === 'patches') options.patches.push(value);
      else options[key] = value;
      continue;
    }
    positionals.push(token);
  }

  options.help = help;

  if (positionals.includes('-') && positionals.length > 1) {
    throw usageError('The stdin marker - must be the only prompt argument');
  }
  if (positionals.length === 1 && positionals[0] === '-') options.prompt = '-';
  else if (positionals.length > 0) options.prompt = positionals.join(' ');

  if (options.sessionId !== undefined && options.sessionId === '') {
    throw usageError('--session requires a non-empty id');
  }
  if (options.profile === undefined || !PROFILE_PATTERN.test(options.profile)) {
    throw usageError('Invalid profile name');
  }
  if (!EFFORTS.has(options.reasoningEffort)) {
    throw usageError('--reasoning-effort must be off, low, high, or max');
  }
  if (!PERMISSIONS.has(options.permissionMode)) {
    throw usageError('--permission-mode must be read-only, workspace-write, or danger-full-access');
  }
  if (options.timeout !== undefined && typeof options.timeout === 'string') {
    options.timeout = parseInteger(options.timeout, '--timeout');
  }
  if (options.maxOutputBytes !== undefined && typeof options.maxOutputBytes === 'string') {
    options.maxOutputBytes = parseInteger(options.maxOutputBytes, '--max-output-bytes');
  }
  if (options.provider !== undefined && options.provider.trim() === '') {
    throw usageError('--provider requires a value');
  }
  if (options.model !== undefined && options.model.trim() === '') {
    throw usageError('--model requires a value');
  }
  if (command === 'continue' && options.sessionId !== undefined) {
    throw usageError('--session cannot be combined with the continue command');
  }

  return options;
}

function parseSessions(args) {
  const options = {
    command: 'sessions',
    all: false,
    json: false,
    limit: 50,
    cwd: undefined,
    profile: RUN_DEFAULTS.profile,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '-h' || token === '--help') {
      options.help = true;
      continue;
    }
    if (token === '--all') {
      options.all = true;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--limit' || token === '--cwd' || token === '--profile') {
      const value = nextValue(args, index, token);
      index += 1;
      if (token === '--limit') options.limit = parseInteger(value, '--limit', { min: 1 });
      else if (token === '--cwd') options.cwd = value;
      else options.profile = value;
      continue;
    }
    if (token.startsWith('--limit=')) {
      options.limit = parseInteger(token.slice('--limit='.length), '--limit', { min: 1 });
      continue;
    }
    if (token.startsWith('--cwd=')) {
      options.cwd = token.slice('--cwd='.length);
      continue;
    }
    if (token.startsWith('--profile=')) {
      options.profile = token.slice('--profile='.length);
      continue;
    }
    throw usageError(`Unknown sessions argument ${token}`);
  }
  if (!PROFILE_PATTERN.test(options.profile)) throw usageError('Invalid profile name');
  return options;
}

function parseDoctor(args) {
  const options = {
    command: 'doctor',
    json: false,
    live: false,
    verbose: false,
    help: false,
    dsh: undefined,
    dshHome: undefined,
    profile: RUN_DEFAULTS.profile,
    provider: RUN_DEFAULTS.provider,
    model: RUN_DEFAULTS.model,
    reasoningEffort: RUN_DEFAULTS.reasoningEffort,
    permissionMode: RUN_DEFAULTS.permissionMode,
    timeout: 120,
    allowUnvalidatedVersion: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '-h' || token === '--help') {
      options.help = true;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--live') {
      options.live = true;
      continue;
    }
    if (token === '--verbose') {
      options.verbose = true;
      continue;
    }
    if (token === '--allow-unvalidated-version') {
      options.allowUnvalidatedVersion = true;
      continue;
    }
    if (token.startsWith('-')) {
      const equal = token.indexOf('=');
      const flag = equal < 0 ? token : token.slice(0, equal);
      const key = VALUE_FLAGS.get(flag);
      if (!['--dsh', '--dsh-home', '--profile', '--provider', '--model', '--reasoning-effort', '--permission-mode', '--timeout'].includes(flag) || key === undefined) {
        throw usageError(`Unknown doctor option ${flag}`);
      }
      let value;
      if (equal >= 0) value = token.slice(equal + 1);
      else {
        value = nextValue(args, index, flag);
        index += 1;
      }
      if (key === 'timeout') options.timeout = parseInteger(value, '--timeout', { min: 1 });
      else options[key] = value;
      continue;
    }
    throw usageError(`Unexpected doctor argument ${token}`);
  }
  if (!EFFORTS.has(options.reasoningEffort)) throw usageError('--reasoning-effort must be off, low, high, or max');
  if (!PERMISSIONS.has(options.permissionMode)) throw usageError('--permission-mode must be read-only, workspace-write, or danger-full-access');
  if (!PROFILE_PATTERN.test(options.profile)) throw usageError('Invalid profile name');
  return options;
}

function parseBrief(args) {
  const options = { command: 'brief', help: false, json: false };
  for (const token of args) {
    if (token === '-h' || token === '--help') options.help = true;
    else if (token === '--json') options.json = true;
    else throw usageError(`Unexpected brief argument ${token}`);
  }
  return options;
}

/**
 * Parse argv into a command invocation. A first token that is not a command is
 * treated as a prompt for `ask`, so `dshx "do the thing"` works like DSH headless.
 * @param {string[]} argv
 */
export function parse(argv) {
  const args = [...argv];
  if (args.length === 0) return { command: 'help', topic: undefined };
  const first = args[0];

  if (first === '--version' || first === '-V' || first === 'version') return { command: 'version' };
  if (first === '--help' || first === '-h' || first === 'help') {
    return { command: 'help', topic: COMMANDS.has(args[1]) ? args[1] : undefined };
  }

  let command;
  if (first === '-p' || first === '--print') {
    command = 'ask';
    args.shift();
  } else if (COMMANDS.has(first)) {
    command = first;
    args.shift();
  } else {
    command = 'ask';
  }

  switch (command) {
    case 'ask':
    case 'run':
    case 'continue':
      return parseRun(command, args);
    case 'sessions':
      return parseSessions(args);
    case 'doctor':
      return parseDoctor(args);
    case 'brief':
      return parseBrief(args);
    default:
      throw usageError(`Unknown command ${command}`);
  }
}

export const TOP_HELP = `dshx ${'{version}'} - delegate one task to DeepSeek Harness (DSH)

Usage:
  dshx ask [options] [prompt...]        run one DSH task (alias: run, -p)
  dshx continue [options] [prompt...]   resume the newest dshx session in this cwd
  dshx sessions [options]                list dshx-recorded sessions
  dshx doctor [options]                  inspect DSH, login, overlay and permission mode
  dshx brief                             print a ready-to-paste brief for Codex
  dshx <prompt...>                       shorthand for "ask"

Codex should call "dshx.cmd" on Windows. Do not add anything to Codex: paste
the output of "dshx brief" into the Codex conversation and it can use this CLI.

Examples:
  dshx ask "Review the current diff and list concrete risks"
  dshx ask --json "Reply with exactly OK"
  dshx continue "Now implement the highest-risk fix"
  @'
  Long task description...
  '@ | dshx ask

Exit codes: 0 success, 1 task failed, 2 usage, 3 unavailable, 4 protocol,
124 timeout, 130 interrupted, 143 terminated.
Run "dshx <command> --help" for command options.`;

export const RUN_HELP = `Usage: dshx ask [options] [prompt...]
       dshx continue [options] [prompt...]

Runs the official "dsh --profile <profile>" one-shot agent. The prompt is sent
over stdin (never through a shell). With no prompt (or a lone "-"), UTF-8 text
is read from stdin. A non-empty positional prompt is used as-is and stdin is not
read.

Options:
  -C, --cwd DIR                 working directory for DSH (default: current)
  --session ID                  resume an existing headless-compatible session
  --provider ID                 deepseek-account (default) or deepseek-official
  --model ID                    default: deepseek-flash
  --reasoning-effort LEVEL      off | low | high | max (default: max)
  --permission-mode MODE        read-only | workspace-write | danger-full-access
                                (default: danger-full-access)
  --profile NAME                DSH profile (default: headless)
  --patch FILE                  extra DSH overlay; repeatable
  --dsh FILE                    path to @deepseek-ai/dsh/lib/bin.js
  --dsh-home DIR                value for the child DSH_HOME
  --timeout SECONDS             whole invocation deadline; 0 disables (default 1800)
  --max-output-bytes N          cap printed answer; 0 disables (default 65536)
  --json                        print one JSON result envelope
  --progress                    print timestamped turn/step/tool summaries to stderr
  --verbose                     print resolved paths, timing and DSH stderr
  --dry-run                     validate overlay/config without running a model
  --no-auth-overlay             do not enable the stored-account rows
  --allow-unvalidated-version   permit an unvalidated DSH version
  --                            everything after this is literal prompt text
  -h, --help                    show this help

Defaults use the DeepSeek account sign-in already stored by the desktop app:
provider=deepseek-account, model=deepseek-flash, reasoningEffort=max. The CLI
adds a temporary overlay that re-enables credentials, authorization and
deepseek-account in the headless profile. It never rewrites the DSH profile.

danger-full-access gives DSH the same file/network power as the current user.
Use --permission-mode workspace-write or read-only when that is too broad.

Exit codes: 0 success, 1 task failed, 2 usage, 3 unavailable, 4 protocol,
124 timeout, 130 interrupted, 143 terminated.`;

export const SESSIONS_HELP = `Usage: dshx sessions [options]

Lists sessions recorded by dshx (not arbitrary DSH/GUI sessions). No prompt
text is stored. Use "dshx continue" to resume the newest one in this cwd.

Options:
  --all                 include sessions from other working directories
  --cwd DIR             filter by this working directory instead of the current one
  --profile NAME        profile to filter (default: headless)
  --limit N             maximum rows (default 50)
  --json                print one JSON envelope
  -h, --help            show this help`;

export const DOCTOR_HELP = `Usage: dshx doctor [options]

Read-only checks: Node/platform, DSH location and version, DSH_HOME, the
generated auth overlay against "dsh --dump-config", stored DeepSeek account
grant, DEEPSEEK_API_KEY presence, state directory, and permission mode. No
credential value is printed and no model request runs unless --live is given.

Options:
  --json                        print one JSON envelope
  --live                        also run a tiny read-only prompt (billable)
  --dsh FILE                    path to @deepseek-ai/dsh/lib/bin.js
  --dsh-home DIR                inspect this DSH_HOME
  --profile NAME                profile to validate (default headless)
  --provider ID                 expected provider (default deepseek-account)
  --model ID                    expected model (default deepseek-flash)
  --reasoning-effort LEVEL      expected effort (default max)
  --permission-mode MODE        expected permission mode
  --timeout SECONDS             deadline for --live (default 120)
  --verbose                     print extra diagnostics
  -h, --help                    show this help

Exit code 0 means no failed check; 3 means a required check failed.`;

export const BRIEF_HELP = `Usage: dshx brief

Prints the exact block to paste into a Codex conversation. It tells Codex how
to call dshx.cmd, how to continue a session, how to pass long prompts, and what
the exit codes mean. Nothing is written into Codex.`;

/** @param {string|undefined} topic */
export function helpFor(topic, version) {
  if (topic === 'ask' || topic === 'run' || topic === 'continue') return RUN_HELP;
  if (topic === 'sessions') return SESSIONS_HELP;
  if (topic === 'doctor') return DOCTOR_HELP;
  if (topic === 'brief') return BRIEF_HELP;
  return TOP_HELP.replace('{version}', version);
}
