# Document Review Accelerator

A standalone human-review workbench for an existing document extraction pipeline.
Reviewers open the actual PDF, inspect linked source regions, accept or correct
fields, record missing information, and explicitly sign off the case.

The default deployment contains **one Node.js web app and one Blob Storage
account, using public HTTPS endpoints with Entra authentication**. It creates
no VNet, private endpoints, private DNS zones, or network integration.
Private networking is optional. The accelerator does not deploy ingestion, OCR,
an agent, Content Understanding, Document Intelligence, a database, or a
model-training service.

## Review flow

1. An existing pipeline uploads a source PDF and an immutable extraction proposal.
2. The queue flags low or unknown model scores, critical fields, missing evidence,
   missing values, and wrong part variants.
3. A reviewer selects a field and sees its page and source polygon on the PDF.
4. The reviewer accepts the original, saves a sourced correction, or records
   missing information with a reason.
5. Explicit case sign-off releases a reviewed JSON result. The original proposal
   and actor-derived audit history remain available.

**Accept original** needs no written reason: the acceptance itself records that
the reviewer confirmed the original value. An optional note is retained.
**Save correction** and **Needs information** require a note.
Use **Needs information** when the source is missing, unreadable, or insufficient
to verify the field. It keeps the field open and blocks sign-off; it does not
send a notification or rerun extraction.

- Red field statuses mean input is still required.
- Green field statuses mean an acceptance or correction is saved.
- Unflagged values have no field action badge. Case sign-off is one final
  release action, not a separate request on every value.

The requested part appears beside both the PDF and the selected field.
Wrong-variant reviews identify the requested suffix and the original source
suffix in plain language. Original routing flags and confidence remain available
in a collapsed details section rather than appearing as unresolved errors after
a correction.

Model review scores, native extraction confidence, and OCR confidence are
separate optional signals. A high score does not override a wrong part suffix.
Feedback export produces a **curated feedback candidate**, not automatic
retraining or a ready-made native model-label file.

## Deploy

Supports Azure commercial cloud. Requires PowerShell 7, Azure CLI with Bicep,
Node.js 24 LTS, and an authenticated
deployment identity with:

- Resource creation and role-assignment rights in the selected subscription.
- Permission to create application registrations and service principals.
- Permission to assign the API's application roles and preauthorize its clients.

Use the tenant that owns the subscription. The script reselects the subscription
and checks its tenant before Azure operations.

```powershell
git clone https://github.com/SQLBImhugh/document-review-accelerator.git
Set-Location .\document-review-accelerator
npm ci --ignore-scripts --omit=optional --no-fund --no-audit
npm test
.\scripts\deploy.ps1 `
  -SubscriptionId "<subscription-guid>" `
  -TenantId "<tenant-guid>" `
  -ResourceGroup "rg-document-review-poc" `
  -NamePrefix "docreview"
```

**Public networking is the default.** Deploy from a workstation or build agent
with Azure access; no private network connection or DNS setup is required.
Public endpoints do not mean public documents: anonymous Blob access, shared
keys, and basic publishing remain disabled. The app uses managed identity for
Blob access, and every data API requires an assigned Entra application role.

Add `-Seed` to create ten synthetic review cases and a real two-page PDF.
The sign-in shell and health/configuration endpoints are publicly reachable;
review data is not anonymously accessible.

### Optional private networking

| Options | Web frontend | Blob endpoint | Network resources |
| --- | --- | --- | --- |
| No networking switches | Public, Entra-protected data APIs | Public, Entra-only data access | None |
| `-PrivateNetworking` | Private | Private | VNet, two private endpoints, private DNS |
| `-PrivateNetworking -PublicFrontend` | Public, Entra-protected data APIs | Private | VNet, one private endpoint, private DNS |

Use `-PrivateNetworking` in tenants whose governance requires private endpoints
or automatically disables public network access. The public default will not
remain reachable in those environments; do not disable their governance
controls. `-PublicFrontend` only affects the optional private-networking mode.

For a private frontend, run the deployment agent on a network that can reach
the new private endpoint and resolve its private DNS. Connect that network to
the created VNet, or adapt `infra\main.bicep` to approved subnets and DNS.
Network peering/VPN is not provisioned. The script cannot publish through a
private SCM endpoint that its agent cannot reach.

The script creates two single-tenant registrations: a browser SPA using PKCE
and a role-protected API. It assigns the deployment user `Reviewer` and
`Importer`; add other users or groups to the API enterprise application's roles.
No application secret, storage key, SAS token, or service connection string is
created. The browser uses MSAL's memory token cache and the v5 redirect bridge.
After a page reload, sign in again; saved reviews remain in Blob Storage.

A credential-free receipt is written to `.local\deployment.json`. Rerunning the
same deployment reuses its applications and resources. Keep the receipt for
teardown; do not add `.local` to a customer package.
Reuse the same networking options when updating an existing deployment.
Older receipts represent private-networked deployments. The script refuses
silent mode changes or adoption of an existing group without its receipt;
use a fresh resource group and checkout for a different networking mode.

## Cost and network behavior

The B1 Linux plan runs continuously. Using the example rates checked
November 10, 2026, the public default has about **$13.14/month** of fixed compute
cost ($0.018/hour at 730 hours), with no private endpoint or private DNS charges.
Storage, versions, transactions, transfer, and tax are additional.

At those example rates, private Blob with a public frontend adds approximately
$7.80/month; a private frontend adds approximately $15.60/month in total for two
private endpoints and two DNS zones. Verify current regional prices before
deployment. There are no paid software-license add-ons.

Public mode uses App Service platform egress and public HTTPS Blob endpoints.
In private mode, Blob traffic uses VNet integration and private DNS.
`vnetRouteAllEnabled=false` keeps Entra/JWK traffic on platform egress; the
delegated subnet has `defaultOutboundAccess=false`. No NAT Gateway or implicit
VNet internet egress is assumed. An organization that routes all traffic through
its VNet must supply explicit outbound access and update this setting.

Tenant-specific cost automation can stop or resize demo resources. The optional
`-KeepDemoRunning` switch adds `CostControl=Ignore` to these dedicated resources.
Use it only if your tenant supports that tag and its owner approves the
exception. Otherwise, follow your organization's cost-control process.
The switch does not exempt private storage or disable security governance.

## Integrate an existing pipeline

Use the [API and input contract](docs/contract.md).
The existing pipeline chooses the source regions and any business-critical
fields. This service does not invent confidence or discover missing PDF boxes.
`scripts\seed.mjs` is a runnable integration example.

For service-to-service import, assign the existing pipeline's managed identity
the API's `Importer` application role. Request an access token for the API, not
for Storage or Microsoft Graph. A reviewer identity needs `Reviewer`.
All assigned reviewers can see all cases in this POC; there is no per-customer,
per-case, or tenant-to-tenant sharing layer.

To run the production entry point on a managed-identity-enabled host, set the
variables in `.env.example` in the process and run `npm start`. That host needs
access to the selected Blob endpoint; private mode additionally needs the
private network and DNS connection. `.env.example` is documentation, not
automatically loaded. There is no unauthenticated production mode or filesystem
fallback.

## Checks and packaging

```powershell
npm run check
npm test
npm run test:deployment
npm run test:e2e
az bicep build --file .\infra\main.bicep --stdout | Out-Null
.\scripts\package.ps1 -Source
```

Browser tests use installed Microsoft Edge through Playwright; no browser
download is needed. The test-only host binds to loopback and injects an isolated
identity/store. It is not part of the production runtime ZIP.
Deployment-option tests use PowerShell 7 and do not call Azure or change resources.

`dist\document-review-accelerator-source.zip` contains reusable source, tests,
contracts, and deployment scripts. It excludes customer documents, deployment
receipts, access tokens, logs, dependencies, and lab evidence. `package.ps1`
without `-Source` creates the runtime ZIP with installed dependencies and
upstream licenses. No Docker build, container registry, frontend build tool,
or cloud package-feed access is needed for runtime deployment.

The [reuse assessment](docs/reuse-assessment.md) records the existing projects
examined and the reason for choosing a smaller standalone component.

## POC boundaries

- PDFs: 10 MB maximum, 1-100 pages, not encrypted. Source files are content-hashed
  and immutable through this API.
- Proposals: 100 fields, 1,000 evidence regions, and 2 MB JSON maximum.
- Queue: up to 500 cases; exceeding it fails explicitly rather than hiding cases.
- A case retains up to 1,000 commands; the service refuses further changes
  instead of dropping audit history.
- Case state and audit update atomically in one conditional-write JSON blob.
  Stale edits return `412`; retrying the same actor/key/payload is idempotent.
- Signed-off cases are read-only. Import a new case ID and run ID for a new
  extraction or source revision. Missing source blocks acceptance and sign-off.
- Blob versioning and seven-day soft delete are enabled. The audit is
  application-level history, not immutable/WORM regulatory evidence.
- The POC has no indexed queue, background webhook delivery, case assignment,
  redaction, malware scanning, retention scheduler, HA/SLA design, or production
  load test. Review these requirements before using real business documents.

## Remove the deployment

```powershell
.\scripts\teardown.ps1 -ReceiptPath .\.local\deployment.json -ConfirmResourceGroup "rg-document-review-poc"
```

Teardown deletes the dedicated resource group **and its documents/reviews**,
then the two recorded Entra registrations. Export anything needed first.
The script verifies the subscription, tenant, ownership tags, and exact group
name immediately before deletion. Charges continue until resources are removed.
