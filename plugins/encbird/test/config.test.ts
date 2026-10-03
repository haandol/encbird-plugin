import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, DEFAULT_BASE, REDIRECT_URI, resolveBase, validateOAuth, type OAuthConfig } from '../src/config.js';
import { authorizationUrl, proof } from '../src/oauth.js';
import { mock } from './helpers.js';

const resource = 'https://api.encbird.com';
const read = `${resource}/learning.read`;
const write = `${resource}/learning.write`;
const cognito: OAuthConfig = {
  issuer: 'https://cognito-idp.ap-northeast-2.amazonaws.com/ap-northeast-2_fixture',
  clientId: 'public-client', authorizationEndpoint: 'https://fixture.auth.ap-northeast-2.amazoncognito.com/oauth2/authorize',
  tokenEndpoint: 'https://fixture.auth.ap-northeast-2.amazoncognito.com/oauth2/token',
  revocationEndpoint: 'https://fixture.auth.ap-northeast-2.amazoncognito.com/oauth2/revoke',
  resource, scopes: ['openid', read, write], redirectUri: REDIRECT_URI,
};

test('Cognito issuer and hosted domain stay valid with production or local API, with optional write scope', () => {
  for (const base of [DEFAULT_BASE, 'http://localhost:3001/v1/mcp-learning']) {
    for (const scopes of [['openid', read], [write, read, 'openid']]) {
      const config = validateOAuth({ ...cognito, scopes }, base);
      const url = new URL(authorizationUrl(config, proof()));
      assert.equal(url.searchParams.get('resource'), resource);
      assert.equal(url.searchParams.get('scope'), scopes.join(' '));
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    }
  }
});

for (const [name, scopes] of Object.entries({
  'openid alone': ['openid'],
  'unqualified learning scopes': ['openid', 'learning.read', 'learning.write'],
  'write without read': ['openid', write],
  'Cognito admin escalation': ['openid', read, 'aws.cognito.signin.user.admin'],
  'profile escalation': ['openid', read, 'profile'],
  'unrelated resource': ['openid', read, 'https://other.example/learning.write'],
  'duplicate openid': ['openid', read, 'openid'],
  'duplicate read': ['openid', read, read],
  'duplicate write': ['openid', read, write, write],
  'embedded scope separator': ['openid', `${read} ${write}`],
})) {
  test(`bootstrap rejects ${name}`, () => {
    assert.throws(() => validateOAuth({ ...cognito, scopes }, DEFAULT_BASE), { code: 'INVALID_CONFIG' });
  });
}

test('resource must be a secure unambiguous absolute URL even when scopes match its text', () => {
  for (const resource of ['not-a-url', 'javascript:alert(1)', 'http://api.encbird.com', 'https://user@api.encbird.com',
    'https://@api.encbird.com', 'https://api.encbird.com?', 'https://api.encbird.com#',
    'https://api.encbird.com/../other', 'https://api.encbird.com/%2e%2e/other',
    'https://api.encbird.com\\@other.example', 'https://api.encbird.com\u0000']) {
    assert.throws(() => validateOAuth({ ...cognito, resource, scopes: ['openid', `${resource}/learning.read`] }, DEFAULT_BASE),
      { code: 'INVALID_CONFIG' }, resource);
  }
});

test('scope derivation preserves configured resource paths and rejects a conflicting resource', () => {
  const resource = 'https://api.encbird.com/learning';
  const config = { ...cognito, resource, scopes: ['openid', `${resource}/learning.read`] };
  assert.equal(validateOAuth(config, DEFAULT_BASE).resource, resource);
  assert.throws(() => validateOAuth({ ...config, scopes: ['openid', read] }, DEFAULT_BASE), { code: 'INVALID_CONFIG' });
});

test('local HTTP issuer and hosted endpoints must still use the exact API origin', async t => {
  const m = await mock(); t.after(() => m.close());
  assert.deepEqual(validateOAuth(m.config, m.base), m.config);
  const local = { ...m.config, resource: m.origin, scopes: ['openid', `${m.origin}/learning.read`] };
  assert.deepEqual(validateOAuth(local, m.base), local);
  for (const key of ['issuer', 'authorizationEndpoint', 'tokenEndpoint', 'revocationEndpoint']) {
    for (const other of [`${m.origin.replace('127.0.0.1', 'localhost')}/other`, 'http://127.0.0.1:18765/other']) {
      assert.throws(() => validateOAuth({ ...local, [key]: other }, m.base), { code: 'INVALID_CONFIG' });
    }
  }
});

test('local API configuration preserves the distinct HTTP resource with HTTPS Cognito endpoints', async t => {
  const base = 'http://127.0.0.1:18766/v1/mcp-learning';
  const resource = 'http://localhost:18765/mcp';
  for (const scopes of [['openid', `${resource}/learning.read`], ['openid', `${resource}/learning.read`, `${resource}/learning.write`]]) {
    const config = { ...cognito, resource, scopes };
    assert.deepEqual(validateOAuth(config, base), config);
    const parameters = new URL(authorizationUrl(config, proof())).searchParams;
    assert.equal(parameters.get('resource'), resource);
    assert.equal(parameters.get('scope'), scopes.join(' '));
  }
  const config = { ...cognito, resource, scopes: ['openid', `${resource}/learning.read`] };
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    assert.equal(url, `${base}/config`);
    return new Response(JSON.stringify({ apiVersion: '1', oauth: config }));
  });
  assert.deepEqual(await bootstrap(base), config);
  assert.equal(fetch.mock.callCount(), 1);
});

test('HTTP resource identifiers allow explicit loopback hosts and independent ports only in local development', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const resource = `http://${host}:18765/mcp`;
    const config = { ...cognito, resource, scopes: ['openid', `${resource}/learning.read`] };
    assert.deepEqual(validateOAuth(config, 'http://127.0.0.1:18766/v1/mcp-learning'), config);
    assert.throws(() => validateOAuth(config, DEFAULT_BASE), { code: 'INVALID_CONFIG' });
  }
});

test('local development rejects non-loopback HTTP resources even with matching scopes', () => {
  for (const resource of ['http://api.encbird.com/mcp', 'http://other.example:18765/mcp',
    'http://localhost.evil.example:18765/mcp', 'http://127.0.0.1.evil.example/mcp', 'http://192.168.1.1/mcp']) {
    assert.throws(() => validateOAuth({ ...cognito, resource, scopes: ['openid', `${resource}/learning.read`] },
      'http://127.0.0.1:18766/v1/mcp-learning'), { code: 'INVALID_CONFIG' }, resource);
  }
});

test('local HTTP resources retain strict URL integrity and resource-derived scope restrictions', () => {
  const base = 'http://127.0.0.1:18766/v1/mcp-learning';
  for (const resource of ['http://localhost:18765/mcp?', 'http://localhost:18765/mcp#',
    'http://user@localhost:18765/mcp', 'http://localhost:18765/other/../mcp',
    'http://localhost:18765/%2e%2e/mcp', 'http://127.1:18765/mcp', 'http://localhost:18765\\mcp']) {
    assert.throws(() => validateOAuth({ ...cognito, resource, scopes: ['openid', `${resource}/learning.read`] }, base),
      { code: 'INVALID_CONFIG' }, resource);
  }
  const resource = 'http://localhost:18765/mcp';
  for (const scopes of [['openid', read], ['openid', `${resource}/learning.write`],
    ['openid', `${resource}/learning.read`, `${resource}/learning.read`],
    ['openid', `${resource}/learning.read`, 'aws.cognito.signin.user.admin']]) {
    assert.throws(() => validateOAuth({ ...cognito, resource, scopes }, base), { code: 'INVALID_CONFIG' });
  }
});

test('endpoint trust rejects conflicting hosted origins and URL parser normalization', () => {
  for (const key of ['issuer', 'authorizationEndpoint', 'tokenEndpoint', 'revocationEndpoint']) {
    for (const value of ['https://@issuer.example/path', 'https://issuer.example/path?', 'https://issuer.example/path#',
      'https:/issuer.example/path', 'https://issuer.example/path/../other', 'https://issuer.example\\path', 'https://issuer.example/\u0000']) {
      assert.throws(() => validateOAuth({ ...cognito, [key]: value }, DEFAULT_BASE), { code: 'INVALID_CONFIG' }, `${key}: ${value}`);
    }
  }
  for (const key of ['tokenEndpoint', 'revocationEndpoint']) {
    assert.throws(() => validateOAuth({ ...cognito, [key]: 'https://other.example/oauth2/token' }, DEFAULT_BASE), { code: 'INVALID_CONFIG' });
  }
});

test('API override rejects ambiguous loopback spellings and empty URL delimiters', () => {
  for (const value of ['http://127.1/x', 'http://2130706433/x', 'http://0x7f000001/x', 'http://%6cocalhost/x',
    'http://@localhost/x', 'http:/localhost/x', 'http://localhost\\@other.example/x',
    'http://localhost/x?', 'http://localhost/x#', 'http://localhost/x/../admin', 'http://localhost/x/%2e%2e/admin',
    ' http://localhost/x', 'http://local\thost/x', 'http://localhost/x\u0000']) {
    assert.throws(() => resolveBase(value), { code: 'INVALID_CONFIG' }, value);
  }
});

test('malicious bootstrap is rejected before browser navigation, token exchange or persistence', async t => {
  const m = await mock(); t.after(() => m.close());
  m.config.scopes.push('aws.cognito.signin.user.admin');
  const result = await m.auth.connect(); await m.auth.waitForIdle();
  assert.equal((result.error as any)?.code, 'INVALID_CONFIG');
  assert.deepEqual(m.requests.map(r => r.path), ['/v1/mcp-learning/config']);
  assert.equal(await m.read(), undefined);
});

test('bootstrap never accepts an arbitrary API authority supplied by an internal caller', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ apiVersion: '1', oauth: cognito })));
  await assert.rejects(bootstrap('https://other.example/v1/mcp-learning'), { code: 'INVALID_CONFIG' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('conflicting issuer discovery is rejected before browser navigation or code exchange', async t => {
  const m = await mock(); t.after(() => m.close());
  for (const patch of [
    { issuer: `${m.origin}/other-issuer` }, { authorization_endpoint: `${m.origin}/other-authorize` },
    { token_endpoint: `${m.origin}/other-token` }, { revocation_endpoint: `${m.origin}/other-revoke` },
    { jwks_uri: 'https://other.example/keys' }, { jwks_uri: `${m.origin}/issuer/keys#` },
    { jwks_uri: `${m.origin}/issuer/../keys` },
  ]) {
    m.hooks.discovery = patch;
    const first = await m.auth.connect(); await m.auth.waitForIdle();
    assert.equal((first.error as any)?.code, 'INVALID_ID_TOKEN');
    await m.auth.connect(); // Consume the saved failure before the next attempt.
  }
  assert.equal(m.counts.exchange, 0); assert.equal(m.counts.register, 0);
  assert.ok(m.requests.every(r => ['/v1/mcp-learning/config', '/issuer/.well-known/openid-configuration'].includes(r.path)));
  assert.equal(await m.read(), undefined);
});

test('standard discovery without PKCE or revocation metadata still performs an S256 login', async t => {
  const m = await mock(); t.after(() => m.close());
  const { result } = await m.login();
  assert.equal((result.data as any)?.status, 'connected');
  const authorize = m.requests.find(r => r.path.startsWith('/authorize'))!;
  const parameters = new URL(authorize.path, m.origin).searchParams;
  assert.equal(parameters.get('code_challenge_method'), 'S256');
  assert.ok(parameters.get('state')); assert.ok(parameters.get('nonce'));
  assert.deepEqual(parameters.get('scope')?.split(' '), m.config.scopes);
  const firstExchange = m.requests.findIndex(r => r.path === '/token');
  assert.ok(m.requests.findIndex(r => r.path === '/issuer/.well-known/openid-configuration') < firstExchange);
});
