# Existing document-review projects

Research completed November 10, 2026 by two independent, read-only research
agents: one for Microsoft/Azure samples and one for broader open source.
Canonical READMEs, licenses, and relevant implementation/deployment files were
read for the leading candidates. Nothing from these applications was run or
deployed.

## Decision

Build a small original review service using current PDF.js for PDF rendering.
Do not adopt a full ingestion/LLM platform to provide the review component.

The candidates reviewed supply useful viewers, labeling patterns, or partial
correction workflows, but none of the verified implementations supplies the
complete required combination: evidence navigation, exception routing,
accept/correct/unresolved, explicit sign-off, original-value retention,
actor-derived audit, and optimistic concurrency.

This is a conclusion about the bounded candidates and files examined, not an
exhaustive claim about every public repository.

| Candidate | Source version examined | License | Relevant implementation | Decision |
| --- | --- | --- | --- | --- |
| [Content Processing Solution Accelerator](https://github.com/microsoft/content-processing-solution-accelerator) | `f397463f` | MIT | Deployable extraction platform; browser-native document viewer and editable JSON. Examined save behavior does not provide the required distinct review states/concurrency. | Too much surrounding architecture; no application code copied. |
| [Form Recognizer Toolkit / LabelingUX](https://github.com/microsoft/Form-Recognizer-Toolkit/tree/main/SampleCode/LabelingUX) | `2d5cd28f` | MIT | PDF.js canvas with OCR polygons and a document-result adapter seam. Local labeling app, dated React/PDF.js dependencies, no production review backend. | Useful coordinate/adapter reference; implement current viewer directly. |
| [ARGUS](https://github.com/Azure-Samples/ARGUS) | `0e0d0829` | MIT | Document processing and correction history; examined code lacks the required actor/version/sign-off boundaries. | Do not use as the review service base. |
| [Azure SDK CU labeling sample](https://github.com/Azure/azure-sdk-for-python/tree/main/sdk/contentunderstanding/azure-ai-contentunderstanding/samples) | `5159c882` | MIT | Sample corrected/confirmed labels and an explicit analyzer rebuild workflow. No review UI. | Reference for a future, gated native-label adapter; do not adopt SAS examples. |
| [OpenContracts](https://github.com/Open-Source-Legal/OpenContracts) | `01dd850` | MIT | PDF annotation and extracted-cell correction/approval. Original and corrected values are separate. A multi-service platform with additional workflow gaps for this use case. | Design reference only; avoid importing its ingestion, database, embedding, and worker estate. |
| [react-pdf-highlighter-extended](https://github.com/DanielArnould/react-pdf-highlighter-extended) | `b58a3b3` | MIT | PDF highlights and viewport-independent coordinates. Does not provide a queue, decisions, audit, or backend. Examined dependencies target older React/PDF.js. | Direct current PDF.js avoids the older wrapper/dependency constraints. |
| [Extralit](https://github.com/Extralit/extralit) | `c9fdece` | Apache-2.0 | Extraction/review platform; the examined PDF viewer is a placeholder following a UI migration. | Does not satisfy the source-view requirement in that examined version. |
| [Unstract](https://github.com/Zipstack/unstract) | `da80ed2` | AGPL-3.0 | Full processing platform; the advertised document-highlighting review interface is listed for Cloud/Enterprise. | Not a suitable permissively licensed, minimal standalone base. |

## Files and scope checked

The Microsoft/Azure review included:

- CPSA README, LICENSE, `azure.yaml`, main Bicep, authentication script,
  document viewer/JSON editor, save routes, and confidence handling.
- LabelingUX README/LICENSE, client/server packages, PDF loader, OCR/table
  overlays, normalized result models, adapters, and local storage controller.
- ARGUS README/LICENSE, deployment entry points, document view, correction
  endpoint, and API authentication.
- Azure SDK CU analyzer-with-labels sample and labeled training examples.

The broader review included:

- OpenContracts README/LICENSE, production compose, PDF annotator dependencies,
  data-cell model, review/edit mutations, and corresponding tests.
- PDF highlighter README/LICENSE, package dependencies, highlight types, and
  coordinate transforms.
- Extralit README/LICENSE/NOTICE, compose, frontend package, and actual PDF
  viewer implementation.
- Unstract README/LICENSE and the stated open-source versus hosted features.

Searches and selected-file reads can miss other capabilities. No runtime
performance, deployment, or complete security audit of these repositories was
performed. Counts, star totals, and absence-of-search-hit claims are deliberately
not used as proof of suitability.

## Reuse boundary

No application source or customer assets from the candidates are copied into
this accelerator. The runtime dependencies are consumed under their own package
licenses, including PDF.js under Apache-2.0. Preserve those upstream notices when
packaging the application.

The accelerator owns its review state machine, input contract, source adapter,
Entra authorization, atomic conditional storage updates, and feedback export.
Model confidence remains optional and explicitly typed; absent confidence is
unknown, not invented or merged with OCR.

Feedback export is a curated candidate dataset, not automatic online learning
and not a claim that arbitrary field decisions already match a CU or Document
Intelligence training-label schema.
