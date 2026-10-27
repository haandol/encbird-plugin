import { assertVersions, bumpVersion, updateVersion } from './lib/version.mjs';

const root = new URL('../', import.meta.url);
const usage = 'Usage: node scripts/version.mjs check | bump [patch|minor|major] | set X.Y.Z';

try {
  const [command, value, ...extra] = process.argv.slice(2);
  if (extra.length || !['check', 'bump', 'set'].includes(command) ||
      (command === 'check' && value !== undefined) || (command === 'set' && value === undefined)) {
    throw new Error(usage);
  }
  if (command === 'check') {
    console.log(`Versions synchronized: ${await assertVersions(root)}`);
  } else {
    const next = command === 'bump' ? bumpVersion(await assertVersions(root), value) : value;
    console.log(`Version: ${await updateVersion(root, next)}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
