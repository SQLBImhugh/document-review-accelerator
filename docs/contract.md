# Review API contract

All data endpoints require `Authorization: Bearer <Entra access token>`.
The token's issuer and tenant must match `AUTH_TENANT_ID`; its audience must be
the API application client ID. Delegated tokens need `Review.Access` and an
assigned role. Application tokens need `idtyp=app` and an assigned application
role. IDs, roles, and actor attribution come from the verified token.

`GET /healthz`, `GET /api/config`, and the static sign-in files are public.
They contain no review data. `GET /api/me` reports the verified actor and roles.

| Method and route | Role | Behavior |
| --- | --- | --- |
| `POST /api/documents` | Importer | Upload raw `application/pdf`; optional `X-Document-Name`. Returns the canonical descriptor, including SHA-256 ID, page sizes, and page rotations. |
| `POST /api/cases` | Importer | Import the immutable proposal below. The descriptor must match the upload response. Reusing an existing case ID returns `409`. |
| `GET /api/cases` | Reviewer | Complete summary queue, capped at 500 cases. No silent truncation. |
| `GET /api/cases/:id` | Reviewer | Original proposal, decisions, reason codes, audit, summary, and current ETag. |
| `GET /api/cases/:id/document` | Reviewer | Actual PDF bytes, checked against the proposal's source hash. |
| `POST /api/cases/:id/commands` | Reviewer | Apply one versioned, idempotent review command. |
| `GET /api/cases/:id/export` | Reviewer | Reviewed result; requires explicit sign-off. |
| `GET /api/cases/:id/export?kind=feedback` | Reviewer | Same provenance with `kind=curated_feedback_candidate` and `automaticTraining=false`. |

## Proposal

`scripts\synthetic.mjs` and `scripts\seed.mjs` generate and import a complete
runnable example. The proposal has:

| Property | Meaning |
| --- | --- |
| `schemaVersion` | Exactly `"1.0"`. |
| `id`, `runId` | Case and extraction-run IDs. Alphanumeric first character, followed by up to 99 alphanumeric, period, underscore, or hyphen characters. |
| `requestedPart` | Requested business item, including its suffix; nonempty, at most 120 characters. |
| `requiredVariant` | Optional exact variant/suffix selector, at most 100 characters. |
| `documentRevision` | Nonempty source revision label, at most 120 characters. |
| `document` | The upload response, unchanged, or `null` for an explicitly source-missing case. |
| `modelReviewThreshold` | Optional 0-1 routing threshold; defaults to `0.8`. |
| `fields` | 1-100 proposed fields. |
| `evidence` | Up to 1,000 source regions, each tied to this PDF. Empty when `document=null`. |

Each field contains `id`, `label`, `valueType` (`string`, `number`, or `boolean`),
`value` (that primitive type or `null`), `kind` (`extracted`, `derived`, or
`classified`), and `evidenceIds`. Optional properties are `unit`,
`modelScore`, `nativeConfidence`, `required`, `critical`, and `variantScoped`.
`required` defaults to true; `critical` and `variantScoped` default to false.
Confidence/score values are 0-1 or null/absent. They are never substituted for
one another.

Each evidence region contains `id`, one-based `page`, nonempty `quote`,
`polygon`, and optional `variant` and `ocrConfidence`. `polygon` has 4-16
`[x,y]` points normalized to 0-1, with the origin at the top-left of the
**displayed page after its PDF rotation**. Coordinates must describe the
original page, not a crop or thumbnail. Convert inch/pixel boxes in the existing
pipeline before importing. A quote is supplied source metadata, not proof that
the text actually exists at that location; the human checks the rendered PDF.

The upload descriptor includes each page's width/height in PDF points and
rotation. The content hash, not the filename, identifies a document. Uploading
identical bytes again returns the first canonical descriptor. Changing the
filename does not change document identity.

## Review commands

Supply the current case `ETag` as `If-Match` and a new `Idempotency-Key`
(1-120 letters, digits, underscore, period, or hyphen characters).

```json
{
  "action": "correct",
  "fieldId": "length",
  "value": 140,
  "evidenceIds": ["row-B"],
  "reason": "The requested suffix is B; the proposal used row A.",
  "runId": "synthetic-run-01",
  "documentSha256": "<the exact SHA-256 from the imported proposal>"
}
```

Actions:

- `accept`: retains the original proposed value. Requires selected source
  evidence, but no review reason. An optional note is retained; an omitted or
  blank note is stored as an empty string. The acceptance action, reviewer,
  timestamp, value, and source evidence are still audited. A proposal originally
  sourced to the wrong variant cannot be accepted; record a correction instead.
- `correct`: saves a value of the field's declared type, a reason, and selected
  evidence. Variant-scoped fields require evidence for `requiredVariant`.
- `unresolved`: records the reason that more information is needed. It adds a
  blocking field even when the field was not originally flagged. The UI labels
  this action **Needs information**: use it when the reviewer cannot verify the
  field yet. It blocks case sign-off until the field is accepted or corrected.
  It does not notify anyone, request another document, or rerun extraction.
- `signoff`: requires zero unresolved blocking fields and an attached PDF.
  This separate command sets the case to validated/read-only. Ordinary fields
  without individual decisions are explicitly included in case sign-off.

Every command binds to the imported `runId` and document SHA-256. For a missing
document use `documentSha256=null`; only unresolved decisions are allowed.
A reviewer cannot attach another document or overwrite the original values.

The server saves state, actor, old/new decision, reason, timestamp, and command
key/digest in one conditional blob write. Retrying the identical request with
the same actor and key returns the saved result, even if its old ETag is stale.
Using a key for another payload or actor returns `409`. A new key with a stale
ETag returns `412`; reload and review the current source/state before retrying.
Do not silently rebase a human decision onto a newer case version.

Before a new accept, correction, or sign-off, the API rereads and verifies the
stored PDF's hash. A missing or changed stored source blocks the command even
when the proposal still contains a document descriptor. Unresolved decisions
remain available. Replaying a previously committed command does not create
another decision.

## Output and feedback integration

Reviewed export includes requested part, required suffix, source descriptor,
source revision, run identity, approval time, and fields with original/reviewed
values, decision, reason, selected source regions, and separate confidence
signals. The full audit is available on the case endpoint.

The source pipeline can poll validated cases and consume their reviewed export.
No automatic callback, extraction rerun, model update, or downstream business
transaction is performed by this component.

Keep feedback candidates in a curated dataset. Map them to the destination's
native labels or agent examples, split training/evaluation data, evaluate a new
version, and approve promotion separately. A corrected business field is not
necessarily an OCR label or an error in the extraction analyzer.

Errors use JSON `{ "error": "<code>", "message": "<description>" }`.
Important statuses are `400` invalid input, `401` invalid/missing identity,
`403` missing role, `409` state/source conflict, `412` stale ETag, `413` body
limit, `428` missing ETag, and `503` explicit queue limit.
