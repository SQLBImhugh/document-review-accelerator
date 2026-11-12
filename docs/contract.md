# Review API contract

All data endpoints require `Authorization: Bearer <Entra access token>`.
The token's issuer and tenant must match `AUTH_TENANT_ID`; its audience must be
the API application client ID. Delegated tokens need `Review.Access` and an
assigned role. Application tokens need `idtyp=app` and an assigned application
role. IDs, roles, and actor attribution come from the verified token.

`GET /healthz`, `GET /api/config`, and the static sign-in files are public.
They contain no review data. `GET /api/me` reports the verified actor and roles.

A fresh portal deployment has no sign-in client IDs until the operator runs
identity setup. During that stage, `/api/config` returns
`mode=identity_setup_required` with null client/scope values, and all other
`/api` routes return `503 identity_setup_required` before authentication or
storage access. There is no temporary data-access token or unauthenticated
review mode. Once configured, the normal Entra token/role rules apply.

| Method and route | Role | Behavior |
| --- | --- | --- |
| `POST /api/documents` | Importer | Upload raw `application/pdf`; optional `X-Document-Name`. Returns the canonical descriptor, including SHA-256 ID, page sizes, and page rotations. |
| `POST /api/cases` | Importer | Import the immutable proposal, optionally discovering boxes from an accompanying CU result. The descriptor must match the upload response. Reusing an existing case ID returns `409`. |
| `GET /api/cases` | Reviewer | Complete summary queue, capped at 500 cases. No silent truncation. |
| `GET /api/cases/:id` | Reviewer | Original proposal, optional normalized `cuLayout` candidates, decisions, reason codes, audit, summary, and current ETag. |
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
| `cuLayout` | Optional import-only envelope described below. The raw envelope is removed before the original proposal is stored. |

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

## Optional CU layout import

Include `cuLayout` alongside the ordinary proposal properties in
`POST /api/cases`. Leave the original `fields[].evidenceIds` unchanged, or empty
when no links exist. Discovery never fills those links, changes values,
assigns variants, or replaces confidence signals.

The following is an example of the `cuLayout` member for a one-page PDF:

```json
{
  "documentSha256": "<the exact SHA-256 from the PDF upload>",
  "coordinateSpace": "display",
  "analysis": {
    "status": "Succeeded",
    "result": {
      "analyzerId": "prebuilt-documentSearch",
      "apiVersion": "2025-11-01",
      "contents": [{
        "kind": "document",
        "unit": "inch",
        "startPageNumber": 1,
        "endPageNumber": 1,
        "pages": [{
          "pageNumber": 1,
          "width": 8.5,
          "height": 11,
          "lines": [{
            "content": "Finish: zinc plated",
            "source": "D(1,1,2,2,0.2)"
          }],
          "words": [{
            "content": "zinc",
            "confidence": 0.99,
            "source": "D(1,1.8,2,0.3,0.2)"
          }]
        }]
      }]
    }
  }
}
```

`analysis` accepts the successful CU analyze response or its inner `result`
object. The service reads only `pages[].words` and `pages[].lines`, using each
element's nonempty `content` and `source`. It does not slice Markdown spans,
search for values, infer table relationships, or run another analysis.
Source coordinates can use either documented `D(...)` form. A word/line's
optional `confidence` is retained only as OCR/source confidence.

### Coordinate and source requirements

- `documentSha256` must equal the uploaded descriptor's hash. The stored PDF
  bytes are checked again before discovery.
- `coordinateSpace=display`, the default, means the CU coordinates describe
  the page as displayed after the PDF's rotation. Normalization uses those
  page dimensions without applying rotation again.
- Use `coordinateSpace=unrotated` only when the CU coordinates describe the
  PDF before its rotation. The importer transforms those points by the actual
  PDF quarter-turn rotation. It does not infer the coordinate space or apply
  the CU page's text `angle` as a second rotation.
- Provide one document content object with every original page, numbered
  consecutively from one. Segmented, partial-page, and multi-content results
  are unsupported. Word/line boxes must lie within their declared page.
- `unit=inch` dimensions must agree with the PDF's physical size within the
  greater of one PDF point or 0.5%. `unit=pixel` requires a matching page aspect
  ratio within 0.5%, for a rendering of the same complete PDF page.
- Cropped PDF pages and rotations other than 0, 90, 180, or 270 degrees are
  rejected. New OCR, image registration, and crop reconciliation are outside
  this feature.

The source hash binds the import to a stored PDF; it does not prove that the
submitted CU JSON was generated from that PDF. CU results do not carry that
proof. The importer must pair the original PDF and analysis correctly, and the
reviewer checks the rendered source.

Malformed, empty, out-of-bounds, or incompatible layouts fail the entire case
import. Existing evidence plus discovered boxes must total at most 1,000, and
the complete request, including the CU JSON, remains limited to 2 MB. No boxes
are silently dropped.

### Discovery output and manual selection

`GET /api/cases/:id` returns a normalized top-level `cuLayout` separate from
`proposal`. It contains:

| Property | Meaning |
| --- | --- |
| `documentSha256` | Exact imported PDF identity. |
| `analysisSha256` | SHA-256 of `JSON.stringify(analysis)` from the import, not a hash of the raw JSON file's whitespace. |
| `analyzerId`, `apiVersion` | Optional upstream metadata; null when absent. |
| `coordinateSpace` | The declared input coordinate space. |
| `wordCount`, `lineCount` | Imported region counts. |
| `regions` | Normalized candidates with `id`, `page`, `quote`, `polygon`, optional `ocrConfidence`, and `discovery`. |

`discovery` records `kind` (`word` or `line`), the `elementPath` relative to the
CU result, and the original `source` string. IDs such as `cu-line-1-0` identify
the element kind, page, and index. A collision with supplied evidence IDs fails
the import. The raw CU response is not retained; keep it in the source pipeline
if needed for reproduction or audit.

In the UI, select a field and enable **Show CU boxes**. Choose **Lines** or
**Words**, then select a box on the PDF or a checkbox in **Browse CU regions**.
Keyboard users can focus a box and press Space or Enter. Selections are drafts
until an acceptance or correction is saved.

Review commands can name either original evidence IDs or discovered region
IDs. They still require the case ETag, idempotency key, source hash, run ID, and
normal review permissions. Saved decisions and audit history retain the
explicit human selection; the original proposal and its field links do not
change. Signed-off cases remain read-only.

Discovery does not assign `variant` labels or clear original missing-evidence
and wrong-variant routing reasons. For a variant-scoped field, the existing
requirement for importer-supplied evidence labeled with `requiredVariant`
remains. Selecting an unlabeled CU box alone cannot satisfy that gate.

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
signals. For a CU-enabled case it also includes `cuLayout` provenance without
the complete candidate list. Selected CU regions retain their `discovery`
metadata inside the field's evidence. The full candidate list and audit remain
available on the case endpoint.

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
limit, `428` missing ETag, and `503` pending identity setup or explicit queue limit.
