import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';
import { MemoryStore, BlobStore } from '../server/store.mjs';
import { fail } from '../server/domain.mjs';
import { syntheticFixture } from '../scripts/synthetic.mjs';

const fixture = await syntheticFixture();
const store = new MemoryStore();
const app = createApp({
  store,
  config: {
    tenantId: '11111111-1111-4111-8111-111111111111',
    apiClientId: '22222222-2222-4222-8222-222222222222',
    spaClientId: '33333333-3333-4333-8333-333333333333'
  },
  authenticate: async request => {
    if (!request.headers['x-test-role']) fail(401, 'authentication_required', 'Test identity required.');
    return { id: 'test-reviewer', roles: request.headers['x-test-role'].split(',') };
  }
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise(resolve => server.close(resolve)));
const request = (route, options = {}) => fetch(`${base}${route}`, {
  ...options, headers: { 'x-test-role': 'Reviewer,Importer', ...options.headers }
});
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('API enforces roles, source descriptors, immutable imports, ETags, replay, and real PDF bytes', async () => {
  assert.equal((await fetch(`${base}/api/cases`)).status, 401);
  assert.equal((await request('/api/cases', { headers: { 'x-test-role': 'Importer' } })).status, 403);
  assert.equal((await request('/api/documents', { method: 'POST', headers: { 'x-test-role': 'Reviewer' } })).status, 403);
  const uploaded = await request('/api/documents', {
    method: 'POST', headers: { 'content-type': 'application/pdf', 'x-document-name': fixture.document.filename }, body: fixture.bytes
  });
  assert.equal(uploaded.status, 201);
  const document = await uploaded.json();
  const input = structuredClone(fixture.proposals[0]);
  input.document = { pages: document.pages, filename: document.filename, sha256: document.sha256, id: document.id };
  let response = await request('/api/cases', json(input));
  assert.equal(response.status, 201, await response.clone().text());
  let record = await response.json();
  const initialEtag = record.etag;
  assert.equal((await request('/api/cases', json(input))).status, 409);
  assert.deepEqual(Buffer.from(await (await request(`/api/cases/${input.id}/document`)).arrayBuffer()), fixture.bytes);
  const route = `/api/cases/${input.id}/commands`;
  const command = {
    action: 'correct', fieldId: 'length', value: 140, evidenceIds: ['row-B'], reason: 'Requested suffix is B.',
    runId: input.runId, documentSha256: document.sha256
  };
  const send = (body, etag, key) => request(route, {
    ...json(body), headers: { ...json(body).headers, ...(etag ? { 'if-match': etag } : {}), 'idempotency-key': key }
  });
  assert.equal((await send(command, null, 'one')).status, 428);
  response = await send(command, initialEtag, 'one');
  assert.equal(response.status, 200);
  record = await response.json();
  assert.notEqual(record.etag, initialEtag);
  assert.equal((await send(command, initialEtag, 'different-key')).status, 412);
  const replay = await send(command, initialEtag, 'one');
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicate, true);
  assert.equal((await send({ ...command, value: 141 }, record.etag, 'one')).status, 409);
  assert.equal((await send(null, record.etag, 'null-body')).status, 400);
  assert.equal((await send({ ...command, evidenceIds: 'row-B' }, record.etag, 'bad-evidence')).status, 400);
  const loaded = await (await request(`/api/cases/${input.id}`)).json();
  assert.equal(loaded.decisions.length.value, 140);
  assert.equal(loaded.proposal.fields[1].value, 120);
  assert.equal(loaded.audit.length, 2);
});

test('null imports and invalid PDFs are rejected without an internal error', async () => {
  assert.equal((await request('/api/cases', json(null))).status, 400);
  assert.equal((await request('/api/documents', {
    method: 'POST', headers: { 'content-type': 'application/pdf' }, body: '%PDF-not a real document'
  })).status, 400);
});

test('duplicate PDF uploads return one canonical immutable descriptor', async () => {
  const upload = filename => request('/api/documents', {
    method: 'POST', headers: { 'content-type': 'application/pdf', 'x-document-name': filename }, body: fixture.bytes
  });
  const first = await (await upload('first.pdf')).json();
  const second = await (await upload('second.pdf')).json();
  assert.deepEqual(second, first);
});

test('Blob endpoint rejects credentials, fragments, paths, and noncommercial endpoints', () => {
  for (const accountUrl of [
    'https://user:password@demo.blob.core.windows.net',
    'https://demo.blob.core.windows.net/path',
    'https://demo.blob.core.windows.net#fragment',
    'https://demo.blob.core.windows.net?sig=not-allowed',
    'http://demo.blob.core.windows.net',
    'https://not-azure.example'
  ]) assert.throws(() => new BlobStore({ accountUrl }));
});

test('durable upload writes a descriptor before reading its canonical version', async () => {
  const blob = new BlobStore({ accountUrl: 'https://synthetic.blob.core.windows.net' });
  const objects = new Map();
  blob.documents = {
    getBlockBlobClient: name => ({
      uploadData: async bytes => {
        if (objects.has(name)) throw { statusCode: 412 };
        objects.set(name, Buffer.from(bytes));
      }
    }),
    getBlobClient: name => ({ downloadToBuffer: async () => {
      assert.ok(objects.has(name), `Missing descriptor: ${name}`);
      return objects.get(name);
    } })
  };
  const first = await blob.putDocument(fixture.document, fixture.bytes);
  const again = await blob.putDocument({ ...fixture.document, filename: 'another-name.pdf' }, fixture.bytes);
  assert.deepEqual(first, fixture.document);
  assert.deepEqual(again, fixture.document);
  assert.equal(objects.size, 2);
});

test('decisions recheck actual source availability and integrity, but unresolved remains possible', async () => {
  const proposal = structuredClone(fixture.proposals[0]);
  proposal.id = 'source-integrity-check';
  proposal.document = (await store.getDocument(fixture.document.id)).document;
  const created = await (await request('/api/cases', json(proposal))).json();
  const original = await store.getDocument(fixture.document.id);
  const body = {
    action: 'correct', fieldId: 'length', value: 140, evidenceIds: ['row-B'], reason: 'Read the requested suffix.',
    runId: proposal.runId, documentSha256: proposal.document.sha256
  };
  const send = command => request(`/api/cases/${proposal.id}/commands`, {
    ...json(command), headers: { ...json(command).headers, 'if-match': created.etag, 'idempotency-key': command.action }
  });
  try {
    store.documents.delete(fixture.document.id);
    assert.equal((await send(body)).status, 409);
    store.documents.set(fixture.document.id, { document: original.document, bytes: Buffer.from('not the original PDF') });
    const corrupt = await send(body);
    assert.equal(corrupt.status, 409);
    assert.equal((await corrupt.json()).error, 'source_changed');
    assert.equal((await send({ ...body, action: 'unresolved', value: null, evidenceIds: [] })).status, 200);
  } finally { store.documents.set(fixture.document.id, original); }
});

test('API accepts the original with no reason, audits it once, and still rejects unexplained changes', async () => {
  const document = await (await request('/api/documents', {
    method: 'POST', headers: { 'content-type': 'application/pdf' }, body: fixture.bytes
  })).json();
  const proposal = structuredClone(fixture.proposals[0]);
  proposal.id = 'accept-without-reason';
  proposal.document = document;
  const record = await (await request('/api/cases', json(proposal))).json();
  const body = { action: 'accept', fieldId: 'type', evidenceIds: ['type'], runId: proposal.runId, documentSha256: document.sha256 };
  const send = (input, key) => request(`/api/cases/${proposal.id}/commands`, {
    ...json(input), headers: { ...json(input).headers, 'if-match': record.etag, 'idempotency-key': key }
  });
  for (const action of ['correct', 'unresolved']) {
    const rejected = await send({ ...body, action, value: 'tubular spacer' }, `${action}-no-note`);
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error, 'reason_required');
  }
  const response = await send(body, 'accept-no-note');
  assert.equal(response.status, 200);
  const accepted = await response.json();
  assert.equal(accepted.decisions.type.kind, 'accepted');
  assert.equal(accepted.decisions.type.reason, '');
  assert.equal(accepted.proposal.fields[4].value, 'tubular spacer');
  assert.equal(accepted.audit.length, 2);
  const replay = await send({ ...body, reason: '' }, 'accept-no-note');
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicate, true);
  const loaded = await (await request(`/api/cases/${proposal.id}`)).json();
  assert.equal(loaded.decisions.type.value, 'tubular spacer');
  assert.equal(loaded.audit.length, 2);
});

test('CU bounding boxes stay unlinked until a reviewer saves evidence, then survive export and reload', async () => {
  const document = await (await request('/api/documents', {
    method: 'POST', headers: { 'content-type': 'application/pdf' }, body: fixture.bytes
  })).json();
  const proposal = structuredClone(fixture.proposals[0]);
  proposal.id = 'cu-manual-review';
  proposal.document = document;
  proposal.fields = [{ ...proposal.fields[4], evidenceIds: [] }];
  const region = proposal.evidence.find(item => item.id === 'type');
  const analysis = {
    status: 'Succeeded',
    result: {
      analyzerId: 'prebuilt-documentSearch', apiVersion: '2025-11-01',
      contents: [{
        kind: 'document', unit: 'inch', startPageNumber: 1, endPageNumber: 2,
        pages: document.pages.map(page => ({
          pageNumber: page.number, width: page.width / 72, height: page.height / 72,
          lines: page.number === 1 ? [{
            content: region.quote,
            source: `D(1,${region.polygon.flatMap(([x, y]) => [x * page.width / 72, y * page.height / 72]).join(',')})`
          }] : []
        }))
      }]
    }
  };
  const response = await request('/api/cases', json({
    ...proposal, cuLayout: { documentSha256: document.sha256, analysis }
  }));
  assert.equal(response.status, 201, await response.clone().text());
  let record = await response.json();
  assert.deepEqual(record.proposal, proposal);
  assert.equal(record.cuLayout.regions.length, 1);
  assert.deepEqual(record.proposal.fields[0].evidenceIds, []);
  assert.ok(record.fieldReasons.type.includes('missing_evidence'));
  const discovered = record.cuLayout.regions[0];
  assert.equal(discovered.quote, region.quote);
  assert.equal(discovered.discovery.kind, 'line');
  assert.equal(discovered.variant, undefined);
  const route = `/api/cases/${proposal.id}/commands`;
  const send = (body, key) => request(route, {
    ...json({ ...body, runId: proposal.runId, documentSha256: document.sha256 }),
    headers: { ...json(body).headers, 'if-match': record.etag, 'idempotency-key': key }
  });
  let saved = await send({ action: 'accept', fieldId: 'type', evidenceIds: [discovered.id] }, 'select-cu-source');
  assert.equal(saved.status, 200, await saved.clone().text());
  record = await saved.json();
  assert.deepEqual(record.decisions.type.evidenceIds, [discovered.id]);
  assert.deepEqual(record.proposal, proposal);
  saved = await send({ action: 'signoff' }, 'release-cu-case');
  assert.equal(saved.status, 200);
  record = await saved.json();
  const loaded = await (await request(`/api/cases/${proposal.id}`)).json();
  assert.deepEqual(loaded.cuLayout, record.cuLayout);
  assert.deepEqual(loaded.decisions.type.evidenceIds, [discovered.id]);
  const exported = await (await request(`/api/cases/${proposal.id}/export`)).json();
  assert.deepEqual(exported.fields[0].evidence, [discovered]);
  assert.equal(exported.cuLayout.analysisSha256, record.cuLayout.analysisSha256);
  assert.equal(exported.cuLayout.regions, undefined);
  assert.equal((await send({ action: 'accept', fieldId: 'type', evidenceIds: [discovered.id] }, 'signed-case')).status, 409);
});

test('portal deployment stays locked until identity setup, even with a bearer token', async t => {
  let authenticationCalls = 0;
  const pending = createApp({
    config: { tenantId: '11111111-1111-4111-8111-111111111111', apiClientId: '', spaClientId: '' },
    store: new Proxy({}, { get: () => { throw new Error('Pending setup must not access review storage.'); } }),
    authenticate: async () => {
      authenticationCalls++;
      return { id: 'unexpected', roles: ['Reviewer', 'Importer'] };
    }
  });
  const host = pending.listen(0, '127.0.0.1');
  await once(host, 'listening');
  t.after(() => new Promise(resolve => host.close(resolve)));
  const origin = `http://127.0.0.1:${host.address().port}`;
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  const config = await (await fetch(`${origin}/api/config`)).json();
  assert.equal(config.mode, 'identity_setup_required');
  assert.equal(config.apiScope, null);
  assert.equal(config.spaClientId, null);
  for (const [method, route] of [
    ['GET', '/api/me'], ['GET', '/api/cases'], ['POST', '/api/cases'],
    ['POST', '/api/documents'], ['GET', '/api/cases/example/document'],
    ['POST', '/api/cases/example/commands'], ['GET', '/api/cases/example/export']
  ]) {
    const response = await fetch(origin + route, { method, headers: { authorization: 'Bearer not-a-setup-bypass' } });
    assert.equal(response.status, 503, `${method} ${route}`);
    assert.equal((await response.json()).error, 'identity_setup_required');
  }
  assert.equal(authenticationCalls, 0);
});
