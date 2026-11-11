import { createApp } from './app.mjs';
import { BlobStore } from './store.mjs';
import { entraAuthenticator, identityConfigured } from './auth.mjs';

const config = {
  tenantId: process.env.AUTH_TENANT_ID,
  apiClientId: process.env.AUTH_API_CLIENT_ID,
  spaClientId: process.env.AUTH_SPA_CLIENT_ID
};
if (!process.env.STORAGE_ACCOUNT_URL) throw new Error('STORAGE_ACCOUNT_URL is required. Review APIs stay locked until Entra application IDs are configured.');
const identityReady = identityConfigured(config);
const app = createApp({
  config,
  store: new BlobStore({
    accountUrl: process.env.STORAGE_ACCOUNT_URL,
    reviewContainer: process.env.REVIEW_CONTAINER ?? 'review',
    documentContainer: process.env.DOCUMENT_CONTAINER ?? 'documents'
  }),
  authenticate: identityReady ? entraAuthenticator(config) : null
});
const port = Number(process.env.PORT ?? 8080);
app.listen(port, '0.0.0.0', () => console.log(JSON.stringify({
  event: 'listening', port, authentication: identityReady ? 'entra' : 'identity_setup_required', storage: 'managed_identity_blob'
})));
