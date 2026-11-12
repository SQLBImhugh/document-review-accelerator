import express from 'express';
import { PDFDocument } from 'pdf-lib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readFileSync } from 'node:fs';
import { applyCommand, commandDigest, createCase, exportReviewed, fail, hash, reasons, summary, validId } from './domain.mjs';
import { identityConfigured, requireRole } from './auth.mjs';
import { discoverCuLayout } from './cu-layout.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const view = (record, etag) => ({
  ...record, summary: summary(record), etag,
  fieldReasons: Object.fromEntries(record.proposal.fields.map(field => [field.id, reasons(record.proposal, field)]))
});

export function createApp({ store, authenticate, config }) {
  const app = express();
  const identityReady = identityConfigured(config);
  async function verifiedSource(record) {
    const source = await store.getDocument(record.proposal.document.id);
    if (hash(source.bytes) !== record.proposal.document.sha256 || source.document.sha256 !== record.proposal.document.sha256) {
      fail(409, 'source_changed', 'Source integrity verification failed.');
    }
    return source;
  }
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.set({
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' https://login.microsoftonline.com; frame-src 'self' https://login.microsoftonline.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    next();
  });
  app.get('/healthz', (request, response) => response.json({ status: 'ok', component: 'document-review' }));
  app.get('/api/config', (request, response) => response.set('Cache-Control', 'no-store').json({
    tenantId: config.tenantId ?? null, spaClientId: identityReady ? config.spaClientId : null,
    apiScope: identityReady ? `api://${config.apiClientId}/Review.Access` : null,
    mode: identityReady ? 'connected' : 'identity_setup_required', version
  }));
  app.use('/api', async (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!identityReady) fail(503, 'identity_setup_required', 'An administrator must finish Microsoft Entra setup before this workbench can access review data.');
    request.actor = await authenticate(request);
    next();
  });
  app.get('/api/me', (request, response) => response.json({ id: request.actor.id, roles: request.actor.roles }));
  app.post('/api/documents', express.raw({ type: 'application/pdf', limit: '10mb' }), async (request, response) => {
    requireRole(request.actor, 'Importer');
    if (!Buffer.isBuffer(request.body) || !request.body.length || request.body.subarray(0, 5).toString() !== '%PDF-') fail(400, 'invalid_pdf', 'Upload a PDF with Content-Type application/pdf.');
    let pdf;
    try { pdf = await PDFDocument.load(request.body); } catch { fail(400, 'invalid_pdf', 'The PDF is unreadable or encrypted.'); }
    if (pdf.getPageCount() < 1 || pdf.getPageCount() > 100) fail(400, 'pdf_page_limit', 'The POC supports PDFs of 1-100 pages.');
    const id = hash(request.body);
    const filename = String(request.headers['x-document-name'] ?? 'source.pdf').replace(/[^\w .-]/g, '_').slice(0, 180);
    const document = { id, sha256: id, filename, pages: pdf.getPages().map((page, index) => ({
      number: index + 1, width: page.getWidth(), height: page.getHeight(), rotation: page.getRotation().angle
    })) };
    const canonical = await store.putDocument(document, request.body);
    response.status(201).json(canonical);
  });
  app.use('/api', express.json({ limit: '2mb' }));
  app.param('id', (request, response, next, id) => {
    if (!validId(id)) fail(400, 'invalid_id', 'Invalid case ID.');
    next();
  });
  app.post('/api/cases', async (request, response) => {
    requireRole(request.actor, 'Importer');
    const { cuLayout, ...input } = request.body ?? {};
    const record = createCase(input, request.actor);
    if (input.document) {
      const { document, bytes } = await store.getDocument(input.document.id);
      if (!isDeepStrictEqual(input.document, document)) fail(409, 'document_mismatch', 'Use the descriptor returned by the document upload endpoint.');
      if (cuLayout !== undefined) record.cuLayout = await discoverCuLayout(cuLayout, input, bytes);
    } else if (cuLayout !== undefined) {
      fail(400, 'layout_source_required', 'CU box discovery requires the matching source PDF.');
    }
    const etag = await store.create(record);
    response.status(201).set('ETag', etag).json(view(record, etag));
  });
  app.get('/api/cases', async (request, response) => {
    requireRole(request.actor, 'Reviewer');
    const items = (await store.list()).map(item => ({ ...summary(item.record), etag: item.etag }));
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    response.json({ items, limit: 500, complete: true });
  });
  app.get('/api/cases/:id', async (request, response) => {
    requireRole(request.actor, 'Reviewer');
    const { record, etag } = await store.get(request.params.id);
    response.set('ETag', etag).json(view(record, etag));
  });
  app.get('/api/cases/:id/document', async (request, response) => {
    requireRole(request.actor, 'Reviewer');
    const { record } = await store.get(request.params.id);
    if (!record.proposal.document) fail(404, 'document_not_found', 'This case has no source document.');
    const { bytes } = await verifiedSource(record);
    response.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="source.pdf"' }).send(bytes);
  });
  app.post('/api/cases/:id/commands', async (request, response) => {
    requireRole(request.actor, 'Reviewer');
    const current = await store.get(request.params.id);
    const key = request.headers['idempotency-key'];
    const digest = commandDigest(request.body);
    const prior = current.record.commands.find(item => item.key === key);
    if (!prior) {
      if (!request.headers['if-match']) fail(428, 'version_required', 'Supply the current case ETag in If-Match.');
      if (request.headers['if-match'] !== current.etag) fail(412, 'stale_version', 'This case changed. Reload before reviewing the new version.');
    } else if (prior.digest !== digest || prior.actorId !== request.actor.id) {
      fail(409, 'idempotency_conflict', 'This command key was already used for a different action.');
    }
    if (!prior && request.body.action !== 'unresolved' && current.record.proposal.document) {
      try { await verifiedSource(current.record); } catch (error) {
        if (error.status === 404) fail(409, 'source_unavailable', 'The source PDF is unavailable. Record missing information or import a new source/run.');
        throw error;
      }
    }
    const result = applyCommand(current.record, request.body, request.actor, key);
    const etag = result.duplicate ? current.etag : await store.update(request.params.id, result.record, current.etag);
    response.set('ETag', etag).json({ ...view(result.record, etag), duplicate: result.duplicate });
  });
  app.get('/api/cases/:id/export', async (request, response) => {
    requireRole(request.actor, 'Reviewer');
    const { record } = await store.get(request.params.id);
    response.json(exportReviewed(record, request.query.kind === 'feedback'));
  });
  app.use('/vendor/pdfjs', express.static(path.join(root, 'node_modules', 'pdfjs-dist'), { dotfiles: 'deny' }));
  app.use('/vendor/msal', express.static(path.join(root, 'node_modules', '@azure', 'msal-browser', 'lib'), { dotfiles: 'deny' }));
  app.use(express.static(path.join(root, 'public'), { dotfiles: 'deny' }));
  app.use((request, response) => response.status(404).json({ error: 'not_found', message: 'Route not found.' }));
  app.use((error, request, response, next) => {
    const status = error.status ?? (error.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error(JSON.stringify({ event: 'request_failed', code: error.code ?? 'internal_error', path: request.path }));
    response.status(status).json({ error: error.code ?? 'internal_error', message: status < 500 ? error.message : 'The service could not complete the request.' });
  });
  return app;
}
