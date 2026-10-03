import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('malformed and absolute-form callback targets cannot crash the process or redeem a code', async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { request } from 'node:http';
    import { callback, proof } from './src/oauth.ts';
    const values = proof();
    const listener = await callback(values.state, new AbortController().signal, 3000);
    const send = path => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: 18765, path, headers: { host: 'localhost:18765' } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject); req.end();
    });
    try {
      for (const path of ['//[', '//other.example/oauth/callback', 'http://other.example/oauth/callback', '/other/../oauth/callback']) {
        assert.equal(await send(path + '?state=' + values.state + '&code=attacker-code'), 400);
      }
      assert.equal(await send('/oauth/callback?state=' + values.state + '&code=legitimate-code'), 200);
      assert.equal(await listener.result, 'legitimate-code');
    } finally { listener.cancel(); }
  `], { timeout: 8000 });
  assert.equal(stdout, ''); assert.equal(stderr, '');
});
