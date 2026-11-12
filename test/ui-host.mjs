import { createApp } from '../server/app.mjs';
import { MemoryStore } from '../server/store.mjs';
import { createCase, fail } from '../server/domain.mjs';
import { discoverCuLayout } from '../server/cu-layout.mjs';
import { syntheticFixture } from '../scripts/synthetic.mjs';

const { bytes, document, proposals } = await syntheticFixture();
const store = new MemoryStore();
await store.putDocument(document, bytes);
for (const { cuLayout, ...proposal } of proposals) {
  const record = createCase(proposal, { id: 'synthetic-importer' });
  if (cuLayout) record.cuLayout = await discoverCuLayout(cuLayout, proposal, bytes);
  await store.create(record);
}
const app = createApp({
  store,
  config: { tenantId: '11111111-1111-4111-8111-111111111111', apiClientId: '22222222-2222-4222-8222-222222222222', spaClientId: '33333333-3333-4333-8333-333333333333' },
  authenticate: async request => {
    if (request.headers.authorization !== 'Bearer synthetic-ui-test') fail(401, 'authentication_required', 'Test identity required.');
    return { id: 'synthetic-reviewer', roles: ['Reviewer', 'Importer'] };
  }
});
app.listen(8088, '127.0.0.1', () => console.log('Synthetic test-only UI host: http://127.0.0.1:8088'));
