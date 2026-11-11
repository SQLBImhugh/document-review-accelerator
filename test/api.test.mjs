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
  config: { tenantId: 'test', apiClientId: 'test-api', spaClientId: 'test-spa' },
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
