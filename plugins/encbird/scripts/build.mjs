import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { builtinModules } from 'node:module';
const bunVersion = (await readFile(new URL('../../../.bun-version', import.meta.url), 'utf8')).trim();
if (Bun.version !== bunVersion) throw new Error(`Reproducible builds require Bun ${bunVersion}; found ${Bun.version}.`);
await mkdir('dist', { recursive: true });
const result = await Bun.build({
  entrypoints: ['src/index.ts', 'src/cli.ts'], outdir: 'dist', naming: '[name].[ext]',
  target: 'bun', format: 'esm', packages: 'bundle', metafile: true,
});
if (!result.success) throw new AggregateError(result.logs, 'The installed bundle could not be built.');
const inputs = Object.keys(result.metafile.inputs).sort();
const externals = [...new Set(Object.values(result.metafile.outputs).flatMap(output => output.imports.filter(item => item.external).map(item => item.path)))].sort();
if (externals.some(name => name !== 'bun' && !name.startsWith('node:') && !builtinModules.includes(name))) throw new Error('The installed bundle must not need external packages.');
const contractsSha256 = createHash('sha256').update(await readFile('contracts/tools.json')).digest('hex');
const bundleSha256 = createHash('sha256').update(await readFile('dist/index.js')).digest('hex');
const cliSha256 = createHash('sha256').update(await readFile('dist/cli.js')).digest('hex');
const { dependencies, engines } = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile('dist/build-info.json', JSON.stringify({ bun: engines.bun, builtWithBun: Bun.version, contractsSha256, bundleSha256, cliSha256, dependencies, externals, inputs }, null, 2) + '\n');
const notices = new Map();
for (const input of inputs.filter(path => path.includes('node_modules/'))) {
  let directory = dirname(resolve(input));
  while (directory.includes('node_modules')) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (pkg.name && pkg.version) {
        if (!notices.has(pkg.name)) {
          let license;
          for (const filename of ['LICENSE', 'License', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENCE', 'LICENSE-MIT']) {
            try { license = await readFile(join(directory, filename), 'utf8'); break; } catch {}
          }
          if (!license) throw new Error(`Missing bundled license for ${pkg.name}`);
          notices.set(pkg.name, `## ${pkg.name} ${pkg.version}\n\n${license.trim().split('\n').map(line => line.trimEnd()).join('\n')}`);
        }
        break;
      }
    } catch (error) { if (error.message?.startsWith('Missing bundled license')) throw error; }
    directory = dirname(directory);
  }
}
await writeFile('dist/THIRD_PARTY_LICENSES.txt', [...[...notices.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, notice]) => notice)].join('\n\n') + '\n');
