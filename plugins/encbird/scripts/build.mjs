import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { builtinModules } from 'node:module';
await mkdir('dist', { recursive: true });
const result = await build({
  entryPoints: ['src/index.ts'], outfile: 'dist/index.js', bundle: true,
  platform: 'node', target: 'node22', format: 'esm', packages: 'bundle',
  banner: { js: "import { createRequire as __encbirdRequire } from 'node:module'; const require = __encbirdRequire(import.meta.url);" },
  legalComments: 'eof', metafile: true,
});
const inputs = Object.keys(result.metafile.inputs);
const externals = result.metafile.outputs['dist/index.js'].imports.filter(item => item.external).map(item => item.path);
if (externals.some(name => !name.startsWith('node:') && !builtinModules.includes(name))) throw new Error('The installed bundle must not need external packages.');
const contractsSha256 = createHash('sha256').update(await readFile('contracts/tools.json')).digest('hex');
const bundleSha256 = createHash('sha256').update(await readFile('dist/index.js')).digest('hex');
const dependencies = JSON.parse(await readFile('package.json', 'utf8')).dependencies;
await writeFile('dist/build-info.json', JSON.stringify({ node: '>=22.12.0', contractsSha256, bundleSha256, dependencies, externals, inputs }, null, 2) + '\n');
const notices = new Map();
for (const input of inputs.filter(path => path.includes('node_modules/'))) {
  let directory = dirname(resolve(input));
  while (directory.includes('node_modules')) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (pkg.name && pkg.version) {
        if (!notices.has(pkg.name)) {
          let license;
          for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENCE', 'LICENSE-MIT']) {
            try { license = await readFile(join(directory, filename), 'utf8'); break; } catch {}
          }
          if (!license) throw new Error(`Missing bundled license for ${pkg.name}`);
          notices.set(pkg.name, `## ${pkg.name} ${pkg.version}\n\n${license.trim()}`);
        }
        break;
      }
    } catch (error) { if (error.message?.startsWith('Missing bundled license')) throw error; }
    directory = dirname(directory);
  }
}
await writeFile('dist/THIRD_PARTY_LICENSES.txt', [...notices.values()].join('\n\n') + '\n');
