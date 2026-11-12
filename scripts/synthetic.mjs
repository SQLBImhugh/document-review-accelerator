import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { hash } from '../server/domain.mjs';

export async function syntheticFixture() {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Synthetic component drawing - DR-742');
  pdf.setAuthor('Document Review Accelerator');
  pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = [pdf.addPage([612, 792]), pdf.addPage([612, 792])];
  const evidence = [];
  const cuPages = pages.map((page, index) => ({
    pageNumber: index + 1, width: 8.5, height: 11, words: [], lines: []
  }));
  function write(pageNumber, text, x, y, size = 12, strong = false) {
    const font = strong ? bold : regular;
    pages[pageNumber - 1].drawText(text, { x, y, size, font, color: rgb(0.12, 0.18, 0.22) });
    const region = (content, left) => ({
      content, source: `D(${pageNumber},${(left - 1) / 72},${(792 - y - size - 1) / 72},${(font.widthOfTextAtSize(content, size) + 2) / 72},${(size + 3) / 72})`
    });
    cuPages[pageNumber - 1].lines.push(region(text, x));
    for (const match of text.matchAll(/\S+/g)) {
      cuPages[pageNumber - 1].words.push({
        ...region(match[0], x + font.widthOfTextAtSize(text.slice(0, match.index), size)), confidence: 0.99
      });
    }
    return { x, y, width: font.widthOfTextAtSize(text, size), height: size };
  }
  function source(id, page, quote, box, variant) {
    const left = (box.x - 4) / 612;
    const right = (box.x + box.width + 4) / 612;
    const top = (792 - box.y - box.height - 4) / 792;
    const bottom = (792 - box.y + 4) / 792;
    evidence.push({
      id, page, quote, polygon: [[left, top], [right, top], [right, bottom], [left, bottom]],
      ocrConfidence: 0.99, ...(variant ? { variant } : {})
    });
  }
  for (let n = 1; n <= 2; n++) {
    write(n, 'SYNTHETIC SAMPLE / NOT A CUSTOMER DOCUMENT', 42, 752, 10, true);
    write(n, 'DR-742  |  Component specification', 42, 716, 23, true);
    write(n, `Revision C   /   January 2026                                      Sheet ${n} of 2`, 42, 690, 10);
    write(n, 'Training and demonstration only. Dimensions must not be used for manufacturing.', 42, 32, 9);
  }
  source('part', 1, 'Requested item: DR-742-B', write(1, 'Requested item: DR-742-B', 42, 645, 16, true), 'B');
  source('type', 1, 'Item type: tubular spacer', write(1, 'Item type: tubular spacer', 42, 612));
  source('finish', 1, 'Finish: zinc plated', write(1, 'Finish: zinc plated', 42, 584));
  write(1, 'Side view - dimensions in millimeters', 42, 530, 12, true);
  const first = pages[0];
  first.drawRectangle({ x: 118, y: 380, width: 360, height: 72, borderWidth: 2, borderColor: rgb(0.2, 0.3, 0.4) });
  first.drawEllipse({ x: 118, y: 416, xScale: 14, yScale: 36, borderWidth: 2, borderColor: rgb(0.2, 0.3, 0.4) });
  first.drawLine({ start: { x: 100, y: 350 }, end: { x: 490, y: 350 }, thickness: 1 });
  write(1, 'L - select the requested suffix from sheet 2', 163, 330, 11);
  source('diameter', 1, 'Outside diameter: 25.0 mm', write(1, 'Outside diameter: 25.0 mm', 42, 278, 14, true));
  write(1, 'Do not use the first table row as a default. Each suffix has a different length.', 42, 226, 11);
  write(2, 'Variant selection table', 42, 636, 18, true);
  write(2, 'Suffix', 62, 594, 12, true);
  write(2, 'Part number', 158, 594, 12, true);
  write(2, 'Length L (mm)', 348, 594, 12, true);
  for (const [index, variant] of ['A', 'B', 'C'].entries()) {
    const y = 550 - index * 52;
    pages[1].drawRectangle({ x: 42, y: y - 14, width: 528, height: 44, color: index === 1 ? rgb(0.9, 0.95, 0.97) : rgb(0.96, 0.97, 0.98) });
    write(2, variant, 62, y, 14, true);
    write(2, `DR-742-${variant}`, 158, y, 14);
    write(2, `${120 + index * 20}.0`, 348, y, 14, true);
    source(`row-${variant}`, 2, `${variant} | DR-742-${variant} | ${120 + index * 20}.0 mm`,
      { x: 50, y: y - 3, width: 500, height: 22 }, variant);
  }
  write(2, 'Selection rule: the requested suffix, not the highest score, determines the row.', 42, 374, 11);
  const bytes = Buffer.from(await pdf.save());
  const id = hash(bytes);
  const document = { id, sha256: id, filename: 'synthetic-DR-742-rev-C.pdf', pages: pages.map((page, index) => ({
    number: index + 1, width: page.getWidth(), height: page.getHeight(), rotation: 0
  })) };
  const base = {
    schemaVersion: '1.0', id: 'synthetic-01', requestedPart: 'DR-742-B', requiredVariant: 'B',
    runId: 'synthetic-run-01', documentRevision: 'C', modelReviewThreshold: 0.8, document, evidence,
    fields: [
      { id: 'part', label: 'Part number', valueType: 'string', kind: 'extracted', value: 'DR-742-B', modelScore: 0.98, nativeConfidence: 0.99, evidenceIds: ['part'] },
      { id: 'length', label: 'Length', valueType: 'number', kind: 'extracted', value: 120, unit: 'mm', modelScore: 0.94, nativeConfidence: 0.99, critical: true, variantScoped: true, evidenceIds: ['row-A'] },
      { id: 'diameter', label: 'Outside diameter', valueType: 'number', kind: 'extracted', value: 24.8, unit: 'mm', modelScore: 0.57, nativeConfidence: 0.99, evidenceIds: ['diameter'] },
      { id: 'finish', label: 'Finish', valueType: 'string', kind: 'extracted', value: 'zinc plated', modelScore: 0.91, nativeConfidence: 0.98, evidenceIds: ['finish'] },
      { id: 'type', label: 'Item type', valueType: 'string', kind: 'classified', value: 'tubular spacer', modelScore: null, nativeConfidence: null, evidenceIds: ['type'] }
    ]
  };
  const proposals = Array.from({ length: 10 }, (_, index) => {
    const proposal = structuredClone(base);
    proposal.id = `synthetic-${String(index + 1).padStart(2, '0')}`;
    proposal.runId = `synthetic-run-${String(index + 1).padStart(2, '0')}`;
    if (index >= 2 && index <= 6) {
      proposal.fields[1].value = 140;
      proposal.fields[1].evidenceIds = ['row-B'];
    }
    if (index === 3) proposal.fields[3].evidenceIds = [];
    if (index === 4) proposal.fields[2].value = null;
    if (index === 5) proposal.fields[2].modelScore = 0.79;
    if (index === 6) proposal.fields[4].modelScore = 0.9;
    if (index === 7) {
      proposal.document = null;
      proposal.evidence = [];
      proposal.fields.forEach(field => { field.evidenceIds = []; });
    }
    if (index === 8) {
      proposal.fields[1].modelScore = 0.99;
      proposal.fields[3].evidenceIds = [];
      proposal.cuLayout = {
        documentSha256: document.sha256, coordinateSpace: 'display',
        analysis: {
          status: 'Succeeded',
          result: {
            analyzerId: 'synthetic-layout-fixture', apiVersion: '2025-11-01',
            contents: [{ kind: 'document', unit: 'inch', startPageNumber: 1, endPageNumber: 2, pages: cuPages }]
          }
        }
      };
    }
    if (index === 9) proposal.fields[2].nativeConfidence = 0.42;
    return proposal;
  });
  return { bytes, document, proposals };
}
