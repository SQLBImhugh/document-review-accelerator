import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createCase, exportReviewed, reasons, summary, validateProposal } from '../server/domain.mjs';
import { syntheticFixture } from '../scripts/synthetic.mjs';

const fixture = await syntheticFixture();
const actor = { id: 'reviewer-1' };
const proposal = () => structuredClone(fixture.proposals[0]);
const command = (record, action, fieldId, value, evidenceIds) => ({
  action, fieldId, value, evidenceIds, reason: 'Verified against the actual synthetic PDF.',
  runId: record.proposal.runId, documentSha256: record.proposal.document?.sha256 ?? null
});
const change = (record, action, fieldId, value, evidenceIds, key = `${action}-${fieldId}`) =>
  applyCommand(record, command(record, action, fieldId, value, evidenceIds), actor, key).record;
const code = expected => error => error.code === expected;

test('flags separate model score, unknown score, critical field, and wrong variant', () => {
  const input = proposal();
  assert.deepEqual(reasons(input, input.fields[1]), ['critical_field', 'variant_mismatch']);
  assert.deepEqual(reasons(input, input.fields[2]), ['low_model_score']);
  assert.deepEqual(reasons(input, input.fields[4]), ['unknown_model_score']);
  assert.equal(summary(createCase(input, actor)).open, 3);
});

test('requires a correction for wrong-row proposals, retains original, then explicitly signs off', () => {
  let record = createCase(proposal(), actor);
  assert.throws(() => change(record, 'accept', 'length', null, ['row-A']), code('variant_mismatch'));
  assert.throws(() => change(record, 'accept', 'length', null, ['row-B']), code('correction_required'));
  record = change(record, 'correct', 'length', 140, ['row-B']);
  record = change(record, 'correct', 'diameter', 25, ['diameter']);
  assert.throws(() => change(record, 'signoff'), code('unresolved_fields'));
  record = change(record, 'accept', 'type', null, ['type']);
  assert.equal(summary(record).open, 0);
  assert.equal(record.status, 'in_review');
  record = change(record, 'signoff');
  const output = exportReviewed(record, true);
  assert.equal(output.kind, 'curated_feedback_candidate');
  assert.equal(output.automaticTraining, false);
  assert.equal(output.fields.find(field => field.id === 'length').originalValue, 120);
  assert.equal(output.fields.find(field => field.id === 'length').reviewedValue, 140);
  assert.equal(record.proposal.fields[1].value, 120);
  assert.equal(record.audit.length, 5);
  assert.throws(() => change(record, 'correct', 'length', 160, ['row-C'], 'new-key'), code('case_read_only'));
});

test('unresolved decisions block sign-off, including initially unflagged fields', () => {
  let record = createCase(proposal(), actor);
  record = change(record, 'unresolved', 'finish', null, []);
  assert.equal(record.status, 'needs_information');
  assert.equal(summary(record).open, 4);
  assert.throws(() => exportReviewed(record), code('not_validated'));
  record = change(record, 'accept', 'finish', null, ['finish']);
  assert.equal(summary(record).open, 3);
});

test('missing source cannot be accepted, corrected, or signed off', () => {
  const record = createCase(fixture.proposals[7], actor);
  assert.throws(() => change(record, 'accept', 'part', null, []), code('source_required'));
  assert.throws(() => change(record, 'signoff'), code('unresolved_fields'));
  const unresolved = change(record, 'unresolved', 'part', null, []);
  assert.equal(unresolved.decisions.part.kind, 'unresolved');
});

test('command replay is idempotent and bound to actor, payload, source, and run', () => {
  const original = createCase(proposal(), actor);
  const input = command(original, 'correct', 'length', 140, ['row-B']);
  const result = applyCommand(original, input, actor, 'retry-1');
  assert.equal(result.duplicate, false);
  assert.equal(original.commands.length, 0);
  assert.equal(applyCommand(result.record, input, actor, 'retry-1').duplicate, true);
  assert.throws(() => applyCommand(result.record, { ...input, value: 141 }, actor, 'retry-1'), code('idempotency_conflict'));
  assert.throws(() => applyCommand(result.record, input, { id: 'reviewer-2' }, 'retry-1'), code('idempotency_conflict'));
  assert.throws(() => applyCommand(original, { ...input, runId: 'new-run' }, actor, 'retry-2'), code('source_changed'));
});

test('invalid input returns contract errors instead of property-access exceptions', () => {
  for (const input of [null, [], { ...proposal(), evidence: [null] }, { ...proposal(), fields: [null] }]) {
    assert.throws(() => validateProposal(input), error => error.status === 400);
  }
  const record = createCase(proposal(), actor);
  for (const input of [null, [], 'accept', { action: 'accept', evidenceIds: 'row-B' }]) {
    assert.throws(() => applyCommand(record, input, actor, 'bad-command'), error => error.status === 400);
  }
  assert.throws(() => change(record, 'correct', 'diameter', '25', ['diameter']), code('invalid_value'));
});

test('valid field IDs do not inherit decisions from JavaScript object properties', () => {
  const input = proposal();
  input.fields[0].id = 'constructor';
  const record = change(createCase(input, actor), 'accept', 'constructor', null, ['part']);
  assert.equal(record.audit.at(-1).before, null);
  assert.doesNotThrow(() => structuredClone(record));
});

test('accepting the original needs no note and still preserves source, actor, audit, and replay', () => {
  const record = createCase(proposal(), actor);
  for (const reason of [undefined, '', '   ', ' Confirmed the source label. ']) {
    const input = { ...command(record, 'accept', 'type', null, ['type']), reason };
    const result = applyCommand(record, input, actor, 'accept-type');
    assert.equal(result.record.decisions.type.kind, 'accepted');
    assert.equal(result.record.decisions.type.value, 'tubular spacer');
    assert.equal(result.record.decisions.type.reason, reason?.trim() ?? '');
    assert.equal(result.record.decisions.type.actorId, actor.id);
    assert.deepEqual(result.record.decisions.type.evidenceIds, ['type']);
    assert.equal(result.record.audit.at(-1).action, 'accept');
    assert.equal(result.record.audit.at(-1).reason, reason?.trim() ?? '');
    assert.equal(summary(result.record).open, 2);
    assert.equal(applyCommand(result.record, input, actor, 'accept-type').duplicate, true);
  }
  const noNote = { ...command(record, 'accept', 'type', null, ['type']), reason: undefined };
  assert.throws(() => applyCommand(record, { ...noNote, evidenceIds: [] }, actor, 'no-source'), code('source_required'));
  assert.throws(() => applyCommand(record, { ...noNote, fieldId: 'length', evidenceIds: ['row-B'] }, actor, 'wrong-row'), code('correction_required'));
  for (const reason of [42, {}, 'x'.repeat(1001)]) {
    assert.throws(() => applyCommand(record, { ...noNote, reason }, actor, 'bad-note'), code('invalid_reason'));
  }
});

test('corrections and needs-information still require a nonempty reason', () => {
  const record = createCase(proposal(), actor);
  for (const action of ['correct', 'unresolved']) {
    for (const reason of [undefined, '', '   ']) {
      const input = { ...command(record, action, 'diameter', 25, ['diameter']), reason };
      assert.throws(() => applyCommand(record, input, actor, `${action}-no-reason`), code('reason_required'));
    }
  }
  assert.equal(record.audit.length, 1);
});
