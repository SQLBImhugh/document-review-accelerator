import { createHash, randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const fail = (status, code, message) => { throw new HttpError(status, code, message); };
export const hash = value => createHash('sha256').update(value).digest('hex');
export const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);
const primitive = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const score = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
const text = (value, limit = 500) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
export const resolved = decision => decision && ['accepted', 'corrected'].includes(decision.kind);
const decisionFor = (record, id) => Object.hasOwn(record.decisions, id) ? record.decisions[id] : undefined;

export function validateDocument(document) {
  if (!document || !/^[a-f0-9]{64}$/.test(document.id) || document.sha256 !== document.id ||
      !text(document.filename, 200) || !Array.isArray(document.pages) || document.pages.length < 1 ||
      document.pages.length > 100) fail(400, 'invalid_document', 'A verified PDF document descriptor is required.');
  document.pages.forEach((page, index) => {
    if (!page || page.number !== index + 1 || !Number.isFinite(page.width) || page.width <= 0 ||
        !Number.isFinite(page.height) || page.height <= 0) fail(400, 'invalid_pages', 'Invalid PDF page metadata.');
  });
}

export function validateProposal(input) {
  if (!input || input.schemaVersion !== '1.0' || !validId(input.id) || !text(input.requestedPart, 120) ||
      !validId(input.runId) || !text(input.documentRevision, 120) ||
      !Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > 100 ||
      !Array.isArray(input.evidence) || input.evidence.length > 1000) {
    fail(400, 'invalid_proposal', 'Invalid review proposal. See the input contract.');
  }
  if (input.document !== null) validateDocument(input.document);
  if (!score(input.modelReviewThreshold ?? 0.8)) fail(400, 'invalid_policy', 'The review threshold must be between zero and one.');
  if (input.requiredVariant !== undefined && !text(input.requiredVariant, 100)) fail(400, 'invalid_variant', 'Invalid variant selector.');
  const fieldIds = new Set();
  const evidenceIds = new Set();
  for (const item of input.evidence) {
    if (!item || !validId(item.id) || evidenceIds.has(item.id) || !input.document ||
        !Number.isInteger(item.page) || item.page < 1 || item.page > input.document.pages.length ||
        !text(item.quote, 2000) || !Array.isArray(item.polygon) || item.polygon.length < 4 ||
        item.polygon.length > 16 || item.polygon.some(point =>
          !Array.isArray(point) || point.length !== 2 || point.some(n => !Number.isFinite(n) || n < 0 || n > 1)) ||
        !score(item.ocrConfidence ?? null) || (item.variant !== undefined && !text(item.variant, 100))) {
      fail(400, 'invalid_evidence', 'Evidence needs a valid page and normalized source polygon.');
    }
    evidenceIds.add(item.id);
  }
  for (const field of input.fields) {
    if (!field || !validId(field.id) || fieldIds.has(field.id) || !text(field.label, 150) ||
        !['string', 'number', 'boolean'].includes(field.valueType) || !primitive(field.value) ||
        (field.value !== null && typeof field.value !== field.valueType) ||
        (typeof field.value === 'number' && !Number.isFinite(field.value)) ||
        (typeof field.value === 'string' && field.value.length > 4000) ||
        !['extracted', 'derived', 'classified'].includes(field.kind) ||
        !score(field.modelScore ?? null) || !score(field.nativeConfidence ?? null) ||
        !Array.isArray(field.evidenceIds) || field.evidenceIds.some(id => !evidenceIds.has(id)) ||
        ['required', 'critical', 'variantScoped'].some(key => field[key] !== undefined && typeof field[key] !== 'boolean') ||
        (field.unit !== undefined && (typeof field.unit !== 'string' || field.unit.length > 30))) {
      fail(400, 'invalid_field', 'Invalid field type, confidence, or source reference.');
    }
    fieldIds.add(field.id);
  }
}

export function reasons(proposal, field) {
  const result = [];
  if (!proposal.document) result.push('missing_document');
  if (!field.evidenceIds.length) result.push('missing_evidence');
  if (field.modelScore === null || field.modelScore === undefined) result.push('unknown_model_score');
  else if (field.modelScore < (proposal.modelReviewThreshold ?? 0.8)) result.push('low_model_score');
  if (field.value === null && field.required !== false) result.push('missing_value');
  if (field.critical) result.push('critical_field');
  if (field.variantScoped && proposal.requiredVariant) {
    const sources = field.evidenceIds.map(id => proposal.evidence.find(item => item.id === id));
    if (!sources.some(item => item.variant === proposal.requiredVariant)) result.push('variant_mismatch');
  }
  return result;
}

export function createCase(input, actor, now = new Date().toISOString()) {
  validateProposal(input);
  return {
    schemaVersion: '1.0', proposal: structuredClone(input), status: 'needs_review',
    decisions: {}, reviewerFlags: [], commands: [], approved: null,
    createdAt: now, updatedAt: now,
    audit: [{ id: randomUUID(), at: now, actorId: actor.id, action: 'imported', fieldId: null, reason: 'Existing extraction result imported for human review.' }]
  };
}

export function summary(record) {
  const fields = record.proposal.fields;
  const flagged = fields.filter(field => reasons(record.proposal, field).length || record.reviewerFlags.includes(field.id));
  const open = flagged.filter(field => !resolved(decisionFor(record, field.id)));
  return {
    id: record.proposal.id, requestedPart: record.proposal.requestedPart,
    runId: record.proposal.runId, documentRevision: record.proposal.documentRevision,
    status: record.status, fields: fields.length, flagged: flagged.length, open: open.length,
    updatedAt: record.updatedAt
  };
}

export function commandDigest(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command) ||
      !['accept', 'correct', 'unresolved', 'signoff'].includes(command.action) ||
      !validId(command.runId) ||
      (command.action !== 'signoff' && !validId(command.fieldId)) ||
      (command.evidenceIds !== undefined && (!Array.isArray(command.evidenceIds) ||
        command.evidenceIds.length > 1000 || command.evidenceIds.some(id => !validId(id))))) {
    fail(400, 'invalid_command', 'Supply a review command with a valid action, run, field, and evidence list.');
  }
  return hash(JSON.stringify({
    action: command.action, fieldId: command.fieldId ?? null, value: command.value ?? null,
    reason: command.reason ?? '', evidenceIds: [...(command.evidenceIds ?? [])].sort(),
    runId: command.runId, documentSha256: command.documentSha256 ?? null
  }));
}

export function applyCommand(record, command, actor, idempotencyKey, now = new Date().toISOString()) {
  if (!text(idempotencyKey, 120) || !/^[\w.-]+$/.test(idempotencyKey)) fail(400, 'idempotency_required', 'Supply a valid Idempotency-Key.');
  const digest = commandDigest(command);
  const prior = record.commands.find(item => item.key === idempotencyKey);
  if (prior) {
    if (prior.digest !== digest || prior.actorId !== actor.id) fail(409, 'idempotency_conflict', 'This command key was already used for a different action.');
    return { record, duplicate: true };
  }
  if (record.approved) fail(409, 'case_read_only', 'This case is signed off. Import a new extraction run instead of overwriting it.');
  if (command.runId !== record.proposal.runId ||
      (command.documentSha256 ?? null) !== (record.proposal.document?.sha256 ?? null)) {
    fail(409, 'source_changed', 'The submitted source/run identity does not match this case.');
  }
  if (record.commands.length >= 1000) fail(409, 'audit_limit', 'This case reached the documented command limit; archive it rather than dropping history.');
  const next = structuredClone(record);
  let event;
  if (command.action === 'signoff') {
    if (!next.proposal.document || summary(next).open > 0) fail(409, 'unresolved_fields', 'Resolve all blocking fields before sign-off.');
    next.approved = { at: now, actorId: actor.id, runId: next.proposal.runId, documentSha256: next.proposal.document.sha256 };
    next.status = 'validated';
    event = { action: 'signed_off', fieldId: null, reason: 'Explicit human case sign-off.' };
  } else {
    if (!['accept', 'correct', 'unresolved'].includes(command.action)) fail(400, 'invalid_action', 'Unsupported review action.');
    const field = next.proposal.fields.find(item => item.id === command.fieldId);
    if (!field) fail(404, 'field_not_found', 'The requested field does not exist.');
    const note = command.reason ?? '';
    if (typeof note !== 'string' || note.length > 1000) fail(400, 'invalid_reason', 'A review note must be text of at most 1,000 characters.');
    const reason = note.trim();
    if (command.action !== 'accept' && !reason) fail(400, 'reason_required', 'A review reason is required.');
    const selected = command.evidenceIds ?? [];
    if (!Array.isArray(selected) || selected.some(id => !next.proposal.evidence.some(item => item.id === id))) {
      fail(400, 'invalid_evidence', 'Select source evidence from this case.');
    }
    let value = command.action === 'accept' ? field.value : command.value;
    if (command.action !== 'unresolved') {
      if (!next.proposal.document || !selected.length) fail(409, 'source_required', 'A decision needs the actual source document and evidence.');
      if (!primitive(value) || value === null || typeof value !== field.valueType ||
          (typeof value === 'number' && !Number.isFinite(value)) ||
          (typeof value === 'string' && (!value.trim() || value.length > 4000))) {
        fail(400, 'invalid_value', 'The reviewed value does not match the field type.');
      }
      if (field.variantScoped && next.proposal.requiredVariant &&
          !selected.some(id => next.proposal.evidence.find(item => item.id === id).variant === next.proposal.requiredVariant)) {
        fail(409, 'variant_mismatch', 'Select evidence for the requested part variant.');
      }
      if (command.action === 'accept' && reasons(next.proposal, field).includes('variant_mismatch')) {
        fail(409, 'correction_required', 'The original proposal used another variant. Record a correction and its source rather than accepting it.');
      }
    } else {
      value = null;
      if (!next.reviewerFlags.includes(field.id)) next.reviewerFlags.push(field.id);
    }
    const before = decisionFor(next, field.id) ?? null;
    next.decisions[field.id] = {
      kind: command.action === 'accept' ? 'accepted' : command.action === 'correct' ? 'corrected' : 'unresolved',
      value, evidenceIds: selected, reason, actorId: actor.id, at: now
    };
    next.status = Object.values(next.decisions).some(item => item.kind === 'unresolved') ? 'needs_information' : 'in_review';
    event = { action: command.action, fieldId: field.id, before, after: next.decisions[field.id], reason };
  }
  next.updatedAt = now;
  next.audit.push({ id: randomUUID(), at: now, actorId: actor.id, ...event });
  next.commands.push({ key: idempotencyKey, digest, actorId: actor.id, at: now });
  return { record: next, duplicate: false };
}

export function exportReviewed(record, feedback = false) {
  if (!record.approved || record.status !== 'validated') fail(409, 'not_validated', 'Export requires an explicitly signed-off case.');
  return {
    schemaVersion: '1.0', kind: feedback ? 'curated_feedback_candidate' : 'reviewed_result',
    automaticTraining: false, requestedPart: record.proposal.requestedPart,
    requiredVariant: record.proposal.requiredVariant ?? null,
    runId: record.proposal.runId, document: record.proposal.document,
    documentRevision: record.proposal.documentRevision, approvedAt: record.approved.at,
    fields: record.proposal.fields.map(field => {
      const decision = decisionFor(record, field.id);
      return {
        id: field.id, valueType: field.valueType, unit: field.unit ?? '',
        originalValue: field.value,
        reviewedValue: resolved(decision) ? decision.value : field.value,
        decision: decision?.kind ?? 'included_in_case_signoff',
        reason: decision?.reason ?? '',
        evidence: (decision?.evidenceIds ?? field.evidenceIds)
          .map(id => record.proposal.evidence.find(item => item.id === id)),
        modelScore: field.modelScore ?? null, nativeConfidence: field.nativeConfidence ?? null
      };
    })
  };
}
