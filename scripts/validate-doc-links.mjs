import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./validate-doc-links.py', import.meta.url));
const result = spawnSync('python3', ['-B', script, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) console.error('Document link validation requires Python 3 in the project development environment.');
process.exitCode = result.status ?? 1;
