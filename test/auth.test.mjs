import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { entraAuthenticator } from '../server/auth.mjs';

const tenantId = '11111111-1111-4111-8111-111111111111';
const apiClientId = '22222222-2222-4222-8222-222222222222';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const authenticate = entraAuthenticator({ tenantId, apiClientId }, createLocalJWKSet({ keys: [jwk] }));
const token = (claims = {}, audience = apiClientId, expires = '2m') =>
  new SignJWT({ tid: tenantId, oid: 'reviewer-id', scp: 'Review.Access', roles: ['Reviewer'], ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
    .setAudience(audience).setIssuedAt().setExpirationTime(expires).sign(privateKey);
const request = value => ({ headers: { authorization: `Bearer ${value}` } });

test('accepts a signed scoped role token and an explicitly identified application role token', async () => {
  assert.deepEqual((await authenticate(request(await token()))).roles, ['Reviewer']);
  const application = await authenticate(request(await token({ idtyp: 'app', scp: undefined, roles: ['Importer'] })));
  assert.deepEqual(application.roles, ['Importer']);
});

test('rejects anonymous, expired, wrong-audience, wrong-tenant, and unscoped tokens', async () => {
  await assert.rejects(() => authenticate({ headers: {} }), error => error.status === 401);
  for (const value of [
    await token({}, 'wrong-api'), await token({ tid: 'wrong-tenant' }),
    await token({}, apiClientId, '-2m'), 'invalid.jwt.value'
  ]) await assert.rejects(() => authenticate(request(value)), error => error.status === 401);
  for (const claims of [{ roles: [] }, { scp: 'Other.Scope' }, { idtyp: 'user', scp: undefined }]) {
    await assert.rejects(() => authenticateToken(claims), error => error.status === 403);
  }
});

async function authenticateToken(claims) { return authenticate(request(await token(claims))); }
