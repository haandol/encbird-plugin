import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { smokeInstalledPlugin } from '../runtime-smoke.mjs';
import { fixture } from './check-fixture.mjs';

test('the installed MCP bundle and skill entry point work without dependency installation', async t => {
  const f = await fixture(t);
  await smokeInstalledPlugin(f.root);
  assert.deepEqual(await f.commands(), []);
});

test('an installed CLI cannot borrow a dependency from the development checkout', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'node_modules/development-only'), { recursive: true });
  await writeFile(join(f.root, 'node_modules/development-only/package.json'), '{"type":"module","exports":"./index.js"}');
  await writeFile(join(f.root, 'node_modules/development-only/index.js'), 'export {};');
  await writeFile(join(f.root, 'plugins/encbird/skills/encbird-learning/scripts/encbird.mjs'), "import 'development-only';\n");
  await assert.rejects(smokeInstalledPlugin(f.root), /Runtime closed.*exit 1/);
});

test('runtime discovery must return fourteen tools, not just initialize successfully', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'plugins/encbird/dist/index.js'), `import { createInterface } from 'node:readline';
const input = createInterface({input:process.stdin});
input.on('line', line => {
  const request = JSON.parse(line);
  if (!request.id) return;
  const result = request.method === 'initialize'
    ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
    : {tools:Array.from({length:13}, (_, index) => ({name:'tool' + index}))};
  console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
});
`);
  await assert.rejects(smokeInstalledPlugin(f.root), /all 14 tools/);
});

test('a stuck installed process has a finite timeout and is reaped', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const pidFile = join(f.base, 'runtime.pid');
  await writeFile(join(f.root, 'plugins/encbird/dist/index.js'), `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`);
  await assert.rejects(smokeInstalledPlugin(f.root, { timeoutMs: 500 }), /timed out/);
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
