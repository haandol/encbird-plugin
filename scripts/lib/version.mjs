import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const files = [
  'package.json',
  'plugins/encbird/package.json',
  'bun.lock',
  'plugins/encbird/plugin.json',
  'plugins/encbird/.codex-plugin/plugin.json',
  'plugins/encbird/.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
];

function parts(version, label = 'Version') {
  const match = typeof version === 'string' && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version);
  if (!match || match[0] !== version) {
    throw new Error(`${label} must be stable SemVer X.Y.Z without leading zeros, prerelease, or build metadata.`);
  }
  return match.slice(1).map(BigInt);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function target(value, label) {
  object(value, label);
  parts(value.version, `${label}.version`);
  return { value, label: `${label}.version` };
}

async function document(root, file) {
  const path = join(root instanceof URL ? fileURLToPath(root) : root, file);
  const original = await readFile(path, 'utf8');
  let data;
  // Bun writes its text lockfile as JSONC; every other version file is strict JSON.
  try { data = file === 'bun.lock' ? Bun.JSONC.parse(original) : JSON.parse(original); }
  catch { throw new Error(`${file} must contain valid JSON.`); }
  object(data, file);
  return { file, path, original, data };
}

function targets({ file, data }) {
  if (file === '.claude-plugin/marketplace.json') {
    if (!Array.isArray(data.plugins)) throw new Error(`${file}.plugins must be an array.`);
    const matches = data.plugins.filter(plugin => plugin?.name === 'encbird');
    if (matches.length !== 1) throw new Error(`${file} must contain exactly one encbird plugin.`);
    return [target(matches[0], `${file}.plugins[encbird]`)];
  }
  if (file === 'bun.lock') {
    const workspaces = object(data.workspaces, `${file}.workspaces`);
    object(workspaces[''], `${file}.workspaces[""]`);
    return [target(workspaces['plugins/encbird'], `${file}.workspaces["plugins/encbird"]`)];
  }
  return [target(data, file)];
}

// Rewrite only the plugin workspace version so Bun's lockfile formatting stays byte-stable.
function lockfileText({ file, original, data }, next) {
  const pattern = /("plugins\/encbird"\s*:\s*\{[^{}]*?"version"\s*:\s*")([^"]*)(")/g;
  const matches = [...original.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`${file} must contain exactly one plugins/encbird workspace version.`);
  const updated = original.replace(pattern, (_, before, _version, after) => `${before}${next}${after}`);
  if (!Bun.deepEquals(Bun.JSONC.parse(updated), data, true)) throw new Error(`${file} could not be updated without changing other lockfile data.`);
  return updated;
}

async function snapshot(root) {
  const documents = await Promise.all(files.map(file => document(root, file)));
  for (const entry of documents) entry.targets = targets(entry);
  const version = documents[0].data.version;
  for (const entry of documents) {
    for (const selected of entry.targets) {
      if (selected.value.version !== version) {
        throw new Error(`${selected.label} is ${selected.value.version}; expected ${version} from package.json.`);
      }
    }
  }
  return { documents, version };
}

export async function readVersion(root) {
  const { data } = await document(root, 'package.json');
  return target(data, 'package.json').value.version;
}

export async function assertVersions(root) {
  return (await snapshot(root)).version;
}

export function bumpVersion(version, kind = 'patch') {
  const index = ['major', 'minor', 'patch'].indexOf(kind);
  if (index === -1) throw new Error('Bump must be patch, minor, or major.');
  return parts(version).map((part, position) => position < index ? part : position === index ? part + 1n : 0n).join('.');
}

export async function updateVersion(root, next) {
  const nextParts = parts(next);
  const { documents, version } = await snapshot(root);
  const currentParts = parts(version);
  const difference = nextParts.findIndex((part, index) => part !== currentParts[index]);
  if (difference !== -1 && nextParts[difference] < currentParts[difference]) {
    throw new Error(`Cannot downgrade version from ${version} to ${next}.`);
  }
  if (next === version) return version;
  const updates = documents.map(entry => {
    for (const selected of entry.targets) selected.value.version = next;
    return { ...entry, updated: entry.file === 'bun.lock' ? lockfileText(entry, next) : JSON.stringify(entry.data, null, 2) + '\n' };
  });
  // Recheck every input before writing so edits made during validation are not overwritten.
  for (const entry of updates) {
    if (await readFile(entry.path, 'utf8') !== entry.original) throw new Error(`${entry.file} changed during version validation; retry.`);
  }
  for (const entry of updates) await writeFile(entry.path, entry.updated);
  return next;
}
