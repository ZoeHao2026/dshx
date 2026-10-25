/** Locate the official DSH JavaScript entry and validate the supported runtime contract. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unavailable, usageError } from './errors.js';

export const SUPPORTED_VERSIONS = Object.freeze(['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3']);

export function checkNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if ((major === 22 && minor >= 19) || major >= 24) return;
  throw unavailable(
    'NODE_UNSUPPORTED',
    `Node ${process.versions.node} is not supported by DSH; use Node ^22.19 or >=24.`,
    'Install a supported Node.js and run dshx with that executable.',
  );
}

export function checkPlatform() {
  if (process.platform === 'win32') return;
  throw unavailable(
    'PLATFORM_UNSUPPORTED',
    `dshx v0.1 supports Windows PowerShell; this process is ${process.platform}.`,
    'Codex on this machine runs its agent shell in Windows PowerShell. WSL/native Linux DSH needs a separate Linux install and is out of scope for v0.1.',
  );
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(file) {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function explicitCandidates(value) {
  const looksLikePath = value.includes('/') || value.includes('\\') || path.isAbsolute(value);
  if (!looksLikePath) {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    try {
      const output = execFileSync(command, [value], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap(candidatesFromCommand);
    } catch {
      return [];
    }
  }
  const resolved = path.resolve(value);
  if (isDirectory(resolved)) {
    return [
      path.join(resolved, 'lib', 'bin.js'),
      path.join(resolved, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ];
  }
  if (isFile(resolved) && /\.(?:mjs|cjs|js)$/i.test(resolved)) return [resolved];
  return candidatesFromCommand(resolved);
}

function candidatesFromCommand(commandPath) {
  const resolved = path.resolve(commandPath);
  if (isFile(resolved) && /bin\.js$/i.test(resolved)) return [resolved];
  const directory = path.dirname(resolved);
  const candidates = [
    path.join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];
  const marker = `${path.sep}node_modules${path.sep}@deepseek-ai${path.sep}dsh`;
  const index = resolved.toLowerCase().indexOf(marker.toLowerCase());
  if (index >= 0) {
    candidates.push(path.join(resolved.slice(0, index), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  }
  return candidates;
}

function findOnPath() {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const output = execFileSync(command, ['dsh'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function fallbackCandidates() {
  const candidates = [];
  const appData = process.env.APPDATA;
  if (appData) {
    candidates.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  }
  candidates.push(
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  );
  return candidates;
}

function readVersion(bin) {
  try {
    const output = execFileSync(process.execPath, [bin, '--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const version = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
      throw new Error(`unexpected version output: ${JSON.stringify(output.slice(0, 200))}`);
    }
    return version;
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : '';
    throw unavailable(
      'DSH_UNAVAILABLE',
      `Could not run the DSH entry at ${bin}: ${error.message}${stderr ? `\n${stderr.slice(-800)}` : ''}`,
      'Pass --dsh C:\\path\\to\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js or reinstall the official DSH CLI.',
      error,
    );
  }
}

export function isSupportedVersion(version) {
  return SUPPORTED_VERSIONS.includes(version);
}

/**
 * Resolve the DSH JavaScript entry and its version.
 * @param {{dsh?: string, allowUnvalidatedVersion?: boolean}} [options]
 */
export function locateDsh(options = {}) {
  checkNodeVersion();
  checkPlatform();

  const candidates = [];
  const explicit = options.dsh
    ? { value: options.dsh, source: '--dsh' }
    : process.env.DSHX_DSH
      ? { value: process.env.DSHX_DSH, source: 'DSHX_DSH' }
      : undefined;
  if (explicit) {
    const resolved = explicitCandidates(explicit.value);
    const matches = resolved.filter(isFile);
    if (matches.length === 0) {
      throw unavailable(
        'DSH_UNAVAILABLE',
        `The explicit DSH entry from ${explicit.source} was not found: ${explicit.value}` +
          (resolved.length ? `\nChecked: ${resolved.join(', ')}` : ''),
        'Fix the path. dshx never silently falls back to PATH or npm-global when an explicit location was given.',
      );
    }
    for (const bin of matches) candidates.push({ bin, source: explicit.source });
  }
  for (const commandPath of findOnPath()) {
    for (const candidate of candidatesFromCommand(commandPath)) {
      candidates.push({ bin: candidate, source: 'PATH' });
    }
  }
  for (const candidate of fallbackCandidates()) {
    candidates.push({ bin: candidate, source: 'npm-global' });
  }

  const seen = new Set();
  const found = candidates.find((candidate) => {
    const key = candidate.bin.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return isFile(candidate.bin);
  });

  if (!found) {
    throw unavailable(
      'DSH_UNAVAILABLE',
      'Could not find @deepseek-ai/dsh/lib/bin.js. Checked: ' +
        candidates.map((candidate) => candidate.bin).join(', '),
      'Install the official DSH CLI (npm i -g @deepseek-ai/dsh) or pass --dsh <...\\lib\\bin.js>.',
    );
  }

  const version = readVersion(found.bin);
  if (!isSupportedVersion(version) && !options.allowUnvalidatedVersion) {
    throw unavailable(
      'DSH_VERSION_UNSUPPORTED',
      `DSH ${version} is not a validated CLI version (${SUPPORTED_VERSIONS.join(', ')}).`,
      'Install a validated version, or pass --allow-unvalidated-version and re-run the acceptance checks.',
    );
  }

  return { bin: found.bin, version, source: found.source, validated: isSupportedVersion(version) };
}

export function resolveDshHome(explicit) {
  if (explicit) return path.resolve(explicit);
  const fromEnvironment = process.env.DSH_HOME;
  if (fromEnvironment && fromEnvironment.trim() !== '') return path.resolve(fromEnvironment);
  return path.join(os.homedir(), '.dsh');
}

export function resolveCwd(explicit) {
  const cwd = path.resolve(explicit ?? process.cwd());
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw usageError(`Working directory does not exist or is not a directory: ${cwd}`, 'Pass --cwd with an existing directory.');
  }
  return cwd;
}

export function resolvePatchPaths(patches, cwd) {
  return (patches ?? []).map((patch) => {
    const resolved = path.resolve(cwd, patch);
    if (!isFile(resolved)) {
      throw usageError(`Patch file not found: ${resolved}`, '--patch paths are resolved against the invocation working directory.');
    }
    return resolved;
  });
}

