import test from 'node:test';
import assert from 'node:assert/strict';
import { manualReviewFixture } from '../scripts/synthetic.mjs';
import { discoverCuLayout } from '../server/cu-layout.mjs';
import { applyCommand, createCase, exportReviewed, reasons, summary } from '../server/domain.mjs';

test('simple demo starts without field connections and releases only after manual CU source selection', async () => {
  const fixture = await manualReviewFixture();
  for (const input of fixture.proposals) {
    const { cuLayout, ...proposal } = structuredClone(input);
    let record = createCase(proposal, { id: 'importer' });
    record.cuLayout = await discoverCuLayout(cuLayout, proposal, fixture.bytes);
    assert.ok(record.proposal.fields.every(field => field.evidenceIds.length === 0));
    assert.deepEqual(record.proposal.evidence, []);
    assert.equal(record.proposal.requiredVariant, undefined);
    assert.ok(record.proposal.fields.every(field => reasons(record.proposal, field).includes('missing_evidence')));
    const command = (action, fieldId, value, evidenceIds = []) => ({
      action, fieldId, value, evidenceIds,
      ...(action === 'correct' ? { reason: 'Read 30.0 mm from the source.' } : {}),
      runId: proposal.runId, documentSha256: proposal.document.sha256
    });
    assert.throws(() => applyCommand(record, command('accept', 'part'), { id: 'reviewer' }, 'without-source'),
      error => error.code === 'source_required');
    assert.throws(() => exportReviewed(record), error => error.code === 'not_validated');
    for (const [fieldId, quote] of [
      ['part', 'Part number: SP-101'], ['length', 'Length: 30.0 mm'], ['finish', 'Finish: zinc plated']
    ]) {
      const region = record.cuLayout.regions.find(item => item.discovery.kind === 'line' && item.quote === quote);
      assert.ok(region);
      const correction = fieldId === 'length' && proposal.fields.find(field => field.id === fieldId).value !== 30;
      record = applyCommand(record, command(correction ? 'correct' : 'accept', fieldId, correction ? 30 : undefined, [region.id]),
        { id: 'reviewer' }, `review-${fieldId}`).record;
    }
    assert.equal(summary(record).open, 0);
    record = applyCommand(record, command('signoff'), { id: 'reviewer' }, 'signoff').record;
    const result = exportReviewed(record);
    assert.equal(result.fields.find(field => field.id === 'length').reviewedValue, 30);
    assert.equal(result.fields.find(field => field.id === 'length').originalValue, proposal.fields.find(field => field.id === 'length').value);
    assert.ok(record.proposal.fields.every(field => field.evidenceIds.length === 0));
    assert.ok(result.fields.every(field => field.evidence.length === 1 && field.evidence[0].discovery.kind === 'line'));
  }
});
