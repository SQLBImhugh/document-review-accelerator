import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { manualReviewFixture } from './synthetic.mjs';
import { hash } from '../server/domain.mjs';

const origin = process.argv[2]?.replace(/\/$/, '');
const token = process.env.DOCUMENT_REVIEW_TOKEN;
if (!origin || !/^https:\/\/[^/?#]+$/.test(origin) || !token) throw new Error('Provide an HTTPS origin and DOCUMENT_REVIEW_TOKEN in the process environment.');
const checks = [];
async function call(route, options = {}, expected = 200) {
  const response = await fetch(`${origin}/api${route}`, {
    ...options, headers: { authorization: `Bearer ${token}`, ...options.headers }
  });
  assert.equal(response.status, expected, `${route}: ${response.status} ${expected === response.status ? '' : await response.text()}`);
  return response;
}
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
assert.equal((await fetch(`${origin}/api/cases`)).status, 401);
assert.equal((await fetch(`${origin}/api/cases`, { headers: { authorization: 'Bearer invalid' } })).status, 401);
checks.push('anonymous_and_invalid_token_denied');
const fixture = await manualReviewFixture();
const document = await (await call('/documents', {
  method: 'POST', headers: { 'content-type': 'application/pdf', 'x-document-name': fixture.document.filename }, body: fixture.bytes
}, 201)).json();
const proposal = structuredClone(fixture.proposals[1]);
proposal.id = `verify-manual-${Date.now()}`;
proposal.runId = proposal.id;
proposal.document = document;
let record = await (await call('/cases', json(proposal), 201)).json();
await call('/cases', json(proposal), 409);
const pdf = Buffer.from(await (await call(`/cases/${proposal.id}/document`)).arrayBuffer());
assert.equal(hash(pdf), document.sha256);
assert.deepEqual(pdf, fixture.bytes);
checks.push('real_pdf_hash_and_immutable_import');
assert.ok(record.cuLayout?.regions.length);
assert.ok(record.proposal.fields.every(field => field.evidenceIds.length === 0));
assert.equal(Object.keys(record.decisions).length, 0);
assert.ok(Object.values(record.fieldReasons).every(items => items.includes('missing_evidence')));
checks.push('cu_boxes_discovered_without_automatic_field_links');
const source = quote => {
  const region = record.cuLayout.regions.find(item => item.discovery.kind === 'line' && item.quote === quote);
  assert.ok(region, `Missing synthetic source: ${quote}`);
  return region.id;
};
const command = (action, fieldId, value, evidenceIds = []) => ({
  action, fieldId, value, evidenceIds, reason: 'Synthetic live acceptance check.',
  runId: proposal.runId, documentSha256: document.sha256
});
const send = async (body, expected = 200, key = randomUUID(), etag = record.etag) => call(`/cases/${proposal.id}/commands`, {
  ...json(body), headers: { ...json(body).headers, 'if-match': etag, 'idempotency-key': key }
}, expected);
await send(command('accept', 'part', null), 409);
const acceptPart = command('accept', 'part', null, [source('Part number: SP-101')]);
delete acceptPart.reason;
record = await (await send(acceptPart)).json();
const stale = record.etag;
const correction = command('correct', 'length', 30, [source('Length: 30.0 mm')]);
const key = randomUUID();
record = await (await send(correction, 200, key)).json();
assert.equal(record.proposal.fields[1].value, 29);
assert.equal(record.decisions.length.value, 30);
await send(correction, 412, randomUUID(), stale);
assert.equal((await (await send(correction, 200, key, stale)).json()).duplicate, true);
await send({ ...correction, value: 31 }, 409, key);
checks.push('correction_original_retained_stale_412_and_idempotency');
record = await (await send(command('unresolved', 'finish', null))).json();
assert.equal(record.status, 'needs_information');
await send(command('signoff'), 409);
const acceptFinish = command('accept', 'finish', null, [source('Finish: zinc plated')]);
delete acceptFinish.reason;
record = await (await send(acceptFinish)).json();
assert.equal(record.decisions.finish.reason, '');
assert.equal(record.audit.at(-1).action, 'accept');
assert.equal(record.summary.open, 0);
assert.equal(record.status, 'in_review');
record = await (await send(command('signoff'))).json();
assert.equal(record.status, 'validated');
await send(correction, 409);
checks.push('unresolved_gate_explicit_signoff_and_read_only');
checks.push('accept_original_without_reason_retains_audit');
const output = await (await call(`/cases/${proposal.id}/export?kind=feedback`)).json();
assert.equal(output.kind, 'curated_feedback_candidate');
assert.equal(output.automaticTraining, false);
assert.equal(output.fields.find(field => field.id === 'length').reviewedValue, 30);
assert.equal(output.fields.find(field => field.id === 'length').originalValue, 29);
assert.ok(output.fields.every(field => field.evidence.every(item => item.discovery?.kind === 'line')));
assert.ok(record.proposal.fields.every(field => field.evidenceIds.length === 0));
const loaded = await (await call(`/cases/${proposal.id}`)).json();
assert.equal(loaded.etag, record.etag);
assert.equal(loaded.audit.length, 6);
checks.push('feedback_export_and_durable_reload');
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(), caseId: proposal.id, documentSha256: document.sha256,
  discoveredRegions: record.cuLayout.regions.length, prelinkedFields: 0, checks, status: 'passed'
}, null, 2));
