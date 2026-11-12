import { manualReviewFixture } from './synthetic.mjs';

const origin = process.argv[2]?.replace(/\/$/, '');
const token = process.env.DOCUMENT_REVIEW_TOKEN;
if (!origin || !/^https:\/\/[^/?#]+$/.test(origin) || !token) throw new Error('Usage: DOCUMENT_REVIEW_TOKEN=<Entra access token> node scripts/seed.mjs https://<app-host>. Token stays in process memory.');
async function request(route, options = {}) {
  const response = await fetch(`${origin}/api${route}`, {
    ...options, headers: { authorization: `Bearer ${token}`, ...options.headers }
  });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}
const { bytes, document, proposals } = await manualReviewFixture();
const uploaded = await request('/documents', {
  method: 'POST', headers: { 'content-type': 'application/pdf', 'x-document-name': document.filename }, body: bytes
});
let created = 0, existing = 0;
const queue = await request('/cases');
for (const proposal of proposals) {
  if (queue.items.some(item => item.id === proposal.id)) { existing++; continue; }
  if (proposal.document) proposal.document = uploaded;
  await request('/cases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proposal) });
  created++;
}
const verified = await request('/cases');
let discoveredRegions = 0;
for (const proposal of proposals) {
  if (!verified.items.some(item => item.id === proposal.id)) throw new Error(`Seed did not persist ${proposal.id}.`);
  const actual = await request(`/cases/${proposal.id}`);
  if (actual.proposal.document?.sha256 !== uploaded.sha256 || !actual.cuLayout?.regions?.length ||
      actual.proposal.fields.some(field => field.evidenceIds.length) || actual.proposal.evidence.length) {
    throw new Error(`${proposal.id} is not the manual-only discovery sample. Existing cases were not overwritten; use new case IDs or an empty review container.`);
  }
  discoveredRegions += actual.cuLayout.regions.length;
}
console.log(JSON.stringify({
  created, existing, verifiedSyntheticCases: proposals.length, actualPdfSha256: uploaded.sha256,
  discoveredRegions, prelinkedFields: 0
}));
