import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const json = value => `${JSON.stringify(value, null, 2)}\n`;
export const clone = value => structuredClone(value);
export const same = (a, b) => canonical(a) === canonical(b);
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function relativeName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..') || name.includes(':')) {
    throw new Error('UNSAFE_RELATIVE_PATH');
  }
  return name;
}

// Check every component and the final descriptor; guidance never follows links.
export async function readScoped(root, name, maxBytes = MAX_FILE_BYTES) {
  relativeName(name);
  const base = path.resolve(root);
  if ((await lstat(base)).isSymbolicLink() || await realpath(base) !== base) throw new Error('SYMLINK_SCOPE');
  let cursor = base;
  for (const part of name.split('/')) {
    cursor = path.join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('SYMLINK_SCOPE');
  }
  const handle = await open(cursor, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('INVALID_FILE_SIZE');
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new Error('INVALID_FILE_SIZE');
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readJSON(root, name) {
  return JSON.parse(await readScoped(root, name));
}

export async function writeNew(root, name, content) {
  relativeName(name);
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(typeof content === 'string' || Buffer.isBuffer(content) ? content : json(content)); }
  finally { await handle.close(); }
  return file;
}

export async function filesUnder(root, prefix = '') {
  const found = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    relativeName(name);
    if (entry.isSymbolicLink()) throw new Error('SYMLINK_SCOPE');
    if (entry.isDirectory()) found.push(...await filesUnder(root, name));
    else if (entry.isFile()) found.push(name);
    else throw new Error('UNSUPPORTED_FILE');
    if (found.length > 4000) throw new Error('TOO_MANY_ARTIFACTS');
  }
  return found.sort();
}

export async function sealRun(root) {
  const names = await filesUnder(root);
  const hashes = {};
  for (const name of names) hashes[name] = sha256(await readScoped(root, name));
  await writeNew(root, 'seal.json', { schemaVersion: 1, hashes });
  for (const name of [...names, 'seal.json']) await chmod(path.join(root, name), 0o444);
  async function freezeDirectory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await freezeDirectory(path.join(directory, entry.name));
    await chmod(directory, 0o555);
  }
  await freezeDirectory(root);
}

export async function verifySeal(root) {
  const seal = await readJSON(root, 'seal.json');
  if (seal.schemaVersion !== 1 || !seal.hashes || typeof seal.hashes !== 'object') throw new Error('INVALID_SEAL');
  const names = (await filesUnder(root)).filter(name => name !== 'seal.json');
  if (!same(names, Object.keys(seal.hashes).sort())) throw new Error('ARTIFACT_SET_CHANGED');
  for (const name of names) if (sha256(await readScoped(root, name)) !== seal.hashes[name]) throw new Error('ARTIFACT_CHANGED');
  return seal;
}

