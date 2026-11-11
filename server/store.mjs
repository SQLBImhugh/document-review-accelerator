import { BlobServiceClient } from '@azure/storage-blob';
import { ManagedIdentityCredential } from '@azure/identity';
import { createHash } from 'node:crypto';
import { fail } from './domain.mjs';

const etagFor = value => `"${createHash('sha256').update(value).digest('hex')}"`;
const encode = value => Buffer.from(JSON.stringify(value));

export class MemoryStore {
  constructor() { this.cases = new Map(); this.documents = new Map(); }
  async list() { return [...this.cases.values()].map(item => ({ record: structuredClone(item.record), etag: item.etag })); }
  async get(id) {
    const item = this.cases.get(id);
    if (!item) fail(404, 'case_not_found', 'Review case not found.');
    return { record: structuredClone(item.record), etag: item.etag };
  }
  async create(record) {
    const id = record.proposal.id;
    if (this.cases.has(id)) fail(409, 'case_exists', 'That case ID already exists. Use a new ID for a new run.');
    const item = { record: structuredClone(record), etag: etagFor(encode(record)) };
    this.cases.set(id, item);
    return item.etag;
  }
  async update(id, record, etag) {
    if (!this.cases.has(id) || this.cases.get(id).etag !== etag) fail(412, 'stale_version', 'This case changed. Reload before reviewing the new version.');
    const next = { record: structuredClone(record), etag: etagFor(encode(record)) };
    this.cases.set(id, next);
    return next.etag;
  }
  async putDocument(document, bytes) {
    if (!this.documents.has(document.id)) this.documents.set(document.id, { document: structuredClone(document), bytes: Buffer.from(bytes) });
    return structuredClone(this.documents.get(document.id).document);
  }
  async getDocument(id) {
    const item = this.documents.get(id);
    if (!item) fail(404, 'document_not_found', 'Source PDF not found.');
    return { document: structuredClone(item.document), bytes: Buffer.from(item.bytes) };
  }
}

export class BlobStore {
  constructor({ accountUrl, reviewContainer = 'review', documentContainer = 'documents', credential }) {
    const url = new URL(accountUrl);
    if (url.protocol !== 'https:' || !/^[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname) ||
        url.search || url.hash || url.username || url.password || url.port || url.pathname !== '/') {
      throw new Error('STORAGE_ACCOUNT_URL must be an Azure commercial Blob endpoint without credentials.');
    }
    const service = new BlobServiceClient(accountUrl, credential ?? new ManagedIdentityCredential());
    this.review = service.getContainerClient(reviewContainer);
    this.documents = service.getContainerClient(documentContainer);
  }
  async list() {
    const result = [];
    for await (const item of this.review.listBlobsFlat({ prefix: 'cases/' })) {
      if (result.length >= 500) fail(503, 'queue_limit', 'The 500-case POC limit was reached; archive cases or add indexed pagination.');
      result.push(await this.get(item.name.slice(6, -5)));
    }
    return result;
  }
  async get(id) {
    try {
      const response = await this.review.getBlobClient(`cases/${id}.json`).download();
      const chunks = [];
      for await (const chunk of response.readableStreamBody) chunks.push(chunk);
      return { record: JSON.parse(Buffer.concat(chunks).toString('utf8')), etag: response.etag };
    } catch (error) {
      if (error.statusCode === 404) fail(404, 'case_not_found', 'Review case not found.');
      throw error;
    }
  }
  async create(record) {
    try {
      const bytes = encode(record);
      const result = await this.review.getBlockBlobClient(`cases/${record.proposal.id}.json`).uploadData(bytes, {
        conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: 'application/json' }
      });
      return result.etag;
    } catch (error) {
      if ([409, 412].includes(error.statusCode)) fail(409, 'case_exists', 'That case ID already exists. Use a new ID for a new run.');
      throw error;
    }
  }
  async update(id, record, etag) {
    try {
      const result = await this.review.getBlockBlobClient(`cases/${id}.json`).uploadData(encode(record), {
        conditions: { ifMatch: etag }, blobHTTPHeaders: { blobContentType: 'application/json' }
      });
      return result.etag;
    } catch (error) {
      if (error.statusCode === 412) fail(412, 'stale_version', 'This case changed. Reload before reviewing the new version.');
      throw error;
    }
  }
  async putDocument(document, bytes) {
    const pdf = this.documents.getBlockBlobClient(`${document.id}.pdf`);
    try {
      await pdf.uploadData(bytes, { conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: 'application/pdf' } });
    } catch (error) {
      if (![409, 412].includes(error.statusCode)) throw error;
    }
    try {
      await this.documents.getBlockBlobClient(`${document.id}.json`).uploadData(encode(document), {
        conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: 'application/json' }
      });
    } catch (error) {
      if (![409, 412].includes(error.statusCode)) throw error;
    }
    return JSON.parse((await this.documents.getBlobClient(`${document.id}.json`).downloadToBuffer()).toString('utf8'));
  }
  async getDocument(id) {
    try {
      const json = await this.documents.getBlobClient(`${id}.json`).downloadToBuffer();
      const bytes = await this.documents.getBlobClient(`${id}.pdf`).downloadToBuffer();
      return { document: JSON.parse(json.toString('utf8')), bytes };
    } catch (error) {
      if (error.statusCode === 404) fail(404, 'document_not_found', 'Source PDF not found.');
      throw error;
    }
  }
}
