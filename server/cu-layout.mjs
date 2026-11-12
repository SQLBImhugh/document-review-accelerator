import { PDFDocument } from 'pdf-lib';
import { fail, hash, validateDocument } from './domain.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isFinite(value) && value > 0;
const numberText = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const rotate = ([x, y], angle) => {
  if (angle === 90) return [1 - y, x];
  if (angle === 180) return [1 - x, 1 - y];
  if (angle === 270) return [y, 1 - x];
  return [x, y];
};

function polygonFor(source, page, rotation) {
  const invalid = () => fail(400, 'invalid_layout_region', 'Each CU region needs an in-page D(page,x,y,width,height) or four-point source polygon.');
  if (typeof source !== 'string' || source.length > 2000 || !/^D\([^()]+\)$/.test(source)) invalid();
  const parts = source.slice(2, -1).split(',').map(part => part.trim());
  if (![5, 9].includes(parts.length) || parts.some(part => !numberText.test(part))) invalid();
  const values = parts.map(Number);
  if (values.some(value => !Number.isFinite(value)) || values[0] !== page.pageNumber) invalid();
  let points;
  if (values.length === 5) {
    const [, left, top, width, height] = values;
    if (width <= 0 || height <= 0) invalid();
    points = [[left, top], [left + width, top], [left + width, top + height], [left, top + height]];
  } else {
    points = Array.from({ length: 4 }, (_, index) => values.slice(index * 2 + 1, index * 2 + 3));
  }
  const normalized = points.map(([x, y]) => [x / page.width, y / page.height]);
  if (normalized.some(point => point.some(value => value < -1e-7 || value > 1 + 1e-7))) invalid();
  const area = normalized.reduce((sum, [x, y], index) => {
    const [nextX, nextY] = normalized[(index + 1) % normalized.length];
    return sum + x * nextY - nextX * y;
  }, 0);
  if (Math.abs(area) < 1e-12) invalid();
  return normalized.map(point => rotate(point.map(value => Math.min(1, Math.max(0, value))), rotation));
}

export async function discoverCuLayout(layout, proposal, bytes) {
  if (!proposal.document) fail(400, 'layout_source_required', 'CU box discovery requires the matching source PDF.');
  validateDocument(proposal.document);
  if (!object(layout) || layout.documentSha256 !== proposal.document.sha256) {
    fail(400, 'layout_source_mismatch', 'Bind the CU layout to the exact uploaded PDF SHA-256.');
  }
  if (!Buffer.isBuffer(bytes) || hash(bytes) !== proposal.document.sha256) {
    fail(409, 'source_changed', 'The stored PDF does not match the layout source.');
  }
  const coordinateSpace = layout.coordinateSpace ?? 'display';
  if (!['display', 'unrotated'].includes(coordinateSpace)) {
    fail(400, 'invalid_layout', 'CU coordinateSpace must be display or unrotated.');
  }
  const analysis = layout.analysis;
  const result = object(analysis) ? analysis.result ?? analysis : null;
  if (!object(result) || (analysis.status !== undefined && analysis.status !== 'Succeeded') ||
      !Array.isArray(result.contents) || result.contents.length !== 1) {
    fail(400, 'invalid_layout', 'Import one successful CU document result, not a pending or multi-content analysis.');
  }
  const content = result.contents[0];
  if (!object(content) || content.kind !== 'document' || !['inch', 'pixel'].includes(content.unit) ||
      !Array.isArray(content.pages) || content.pages.length !== proposal.document.pages.length ||
      (content.startPageNumber !== undefined && content.startPageNumber !== 1) ||
      (content.endPageNumber !== undefined && content.endPageNumber !== proposal.document.pages.length)) {
    fail(400, 'invalid_layout', 'The CU document must describe every page of the original PDF in inches or pixels.');
  }
  let pdf;
  try { pdf = await PDFDocument.load(bytes); } catch {
    fail(400, 'unsupported_layout_pdf', 'The source PDF cannot be read for CU layout validation.');
  }
  if (pdf.getPageCount() !== content.pages.length) fail(400, 'layout_page_mismatch', 'CU and PDF page counts differ.');
  const regions = [];
  const ids = new Set(proposal.evidence.map(item => item.id));
  let wordCount = 0, lineCount = 0;
  for (const [pageIndex, page] of content.pages.entries()) {
    if (!object(page) || page.pageNumber !== pageIndex + 1 || !positive(page.width) || !positive(page.height)) {
      fail(400, 'invalid_layout', 'CU pages need consecutive original page numbers and positive dimensions.');
    }
    const pdfPage = pdf.getPage(pageIndex);
    const media = pdfPage.getMediaBox();
    const crop = pdfPage.getCropBox();
    const angle = ((pdfPage.getRotation().angle % 360) + 360) % 360;
    if (![0, 90, 180, 270].includes(angle) || Object.keys(media).some(key => Math.abs(media[key] - crop[key]) > 0.01)) {
      fail(400, 'unsupported_layout_pdf', 'CU discovery supports uncropped PDF pages with quarter-turn rotation only.');
    }
    const swapped = coordinateSpace === 'display' && [90, 270].includes(angle);
    const width = swapped ? media.height : media.width;
    const height = swapped ? media.width : media.height;
    const mismatch = content.unit === 'inch'
      ? Math.abs(page.width * 72 - width) > Math.max(1, width * 0.005) ||
        Math.abs(page.height * 72 - height) > Math.max(1, height * 0.005)
      : Math.abs(page.width / page.height - width / height) > width / height * 0.005;
    if (mismatch) fail(400, 'layout_page_mismatch', 'CU dimensions do not match the PDF in the declared coordinate space.');
    for (const kind of ['word', 'line']) {
      const elements = page[`${kind}s`] ?? [];
      if (!Array.isArray(elements)) fail(400, 'invalid_layout', 'CU words and lines must be arrays.');
      if (proposal.evidence.length + regions.length + elements.length > 1000) {
        fail(400, 'layout_region_limit', 'Existing evidence and discovered CU boxes together exceed the 1,000-region POC limit. No regions were imported.');
      }
      for (const [index, element] of elements.entries()) {
        if (!object(element) || typeof element.content !== 'string' || !element.content.trim() ||
            element.content.length > 2000 || (element.confidence != null &&
              (!Number.isFinite(element.confidence) || element.confidence < 0 || element.confidence > 1))) {
          fail(400, 'invalid_layout_region', 'CU words and lines need source text of at most 2,000 characters and a valid optional OCR confidence.');
        }
        const id = `cu-${kind}-${page.pageNumber}-${index}`;
        if (ids.has(id)) fail(400, 'layout_id_conflict', 'A discovered CU region ID collides with existing evidence.');
        ids.add(id);
        regions.push({
          id, page: page.pageNumber, quote: element.content,
          polygon: polygonFor(element.source, page, coordinateSpace === 'unrotated' ? angle : 0),
          ...(element.confidence != null ? { ocrConfidence: element.confidence } : {}),
          discovery: { kind, elementPath: `/contents/0/pages/${pageIndex}/${kind}s/${index}`, source: element.source }
        });
        if (kind === 'word') wordCount++; else lineCount++;
      }
    }
  }
  if (!regions.length) fail(400, 'invalid_layout', 'The CU result has no word or line boxes. No discovery was performed.');
  const metadata = key => typeof result[key] === 'string' && result[key].length <= 200 ? result[key] : null;
  return {
    documentSha256: proposal.document.sha256, analysisSha256: hash(JSON.stringify(analysis)),
    analyzerId: metadata('analyzerId'), apiVersion: metadata('apiVersion'),
    coordinateSpace, wordCount, lineCount, regions
  };
}
