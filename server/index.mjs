import { createApp } from './app.mjs';
import { BlobStore } from './store.mjs';
import { entraAuthenticator } from './auth.mjs';

const config = {
  tenantId: process.env.AUTH_TENANT_ID,
  apiClientId: process.env.AUTH_API_CLIENT_ID,
  spaClientId: process.env.AUTH_SPA_CLIENT_ID
};
if (!config.spaClientId || !process.env.STORAGE_ACCOUNT_URL) throw new Error('Entra application IDs and STORAGE_ACCOUNT_URL are required. No unauthenticated production mode exists.');
const app = createApp({
  config,
  store: new BlobStore({
    accountUrl: process.env.STORAGE_ACCOUNT_URL,
    reviewContainer: process.env.REVIEW_CONTAINER ?? 'review',
    documentContainer: process.env.DOCUMENT_CONTAINER ?? 'documents'
  }),
  authenticate: entraAuthenticator(config)
});
const port = Number(process.env.PORT ?? 8080);
app.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ event: 'listening', port, authentication: 'entra', storage: 'managed_identity_blob' })));
