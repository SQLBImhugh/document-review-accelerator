import { createRemoteJWKSet, jwtVerify } from 'jose';
import { fail } from './domain.mjs';

export function entraAuthenticator({ tenantId, apiClientId }, keyResolver) {
  if (![tenantId, apiClientId].every(value => /^[a-f0-9-]{36}$/i.test(value ?? ''))) throw new Error('Explicit Entra tenant and API application IDs are required.');
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const keys = keyResolver ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
  return async request => {
    const bearer = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '');
    if (!bearer) fail(401, 'authentication_required', 'Sign in with Microsoft Entra ID.');
    try {
      const { payload } = await jwtVerify(bearer[1], keys, {
        issuer, audience: apiClientId, algorithms: ['RS256'], clockTolerance: 30
      });
      if (payload.tid !== tenantId || !payload.oid) throw new Error('Invalid tenant or subject');
      const roles = Array.isArray(payload.roles) ? payload.roles : [];
      const delegated = typeof payload.scp === 'string' && payload.scp.split(' ').includes('Review.Access');
      const application = payload.idtyp === 'app';
      if ((!delegated && !application) || !roles.some(role => ['Reviewer', 'Importer'].includes(role))) {
        fail(403, 'role_required', 'An assigned Reviewer or Importer application role is required.');
      }
      return { id: payload.oid, tenantId: payload.tid, roles };
    } catch (error) {
      if (error.status === 403) throw error;
      fail(401, 'invalid_token', 'The access token is invalid or expired.');
    }
  };
}

export function requireRole(actor, role) {
  if (!actor.roles.includes(role)) fail(403, 'role_required', `The ${role} role is required for this operation.`);
}
