import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, degrees } from 'pdf-lib';
import { discoverCuLayout } from '../server/cu-layout.mjs';
import { applyCommand, createCase, hash, reasons } from '../server/domain.mjs';

async function fixture(rotation = 0, coordinateSpace = 'unrotated', unit = 'inch') {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 100]);
  page.setRotation(degrees(rotation));
  const bytes = Buffer.from(await pdf.save());
  const id = hash(bytes);
  const document = { id, sha256: id, filename: 'layout.pdf', pages: [{ number: 1, width: 200, height: 100, rotation }] };
  const proposal = {
    schemaVersion: '1.0', id: 'layout-case', runId: 'layout-run', requestedPart: 'DR-005',
    requiredVariant: '005', documentRevision: 'A', document, evidence: [],
    fields: [{ id: 'length', label: 'Length', valueType: 'number', value: 10, kind: 'extracted', evidenceIds: [], modelScore: 0.9 }]
  };
  const displayed = coordinateSpace === 'display' && [90, 270].includes(rotation);
  const width = unit === 'inch' ? (displayed ? 100 : 200) / 72 : displayed ? 500 : 1000;
  const height = unit === 'inch' ? (displayed ? 200 : 100) / 72 : displayed ? 1000 : 500;
  const layout = {
    documentSha256: id, coordinateSpace,
    analysis: {
      status: 'Succeeded',
      result: {
        analyzerId: 'prebuilt-documentSearch', apiVersion: '2025-11-01',
        contents: [{
          kind: 'document', unit, startPageNumber: 1, endPageNumber: 1,
          pages: [{
            pageNumber: 1, width, height, angle: 22,
            words: [{ content: '10', confidence: 0.99, source: `D(1,${width * 0.1},${height * 0.2},${width * 0.2},${height * 0.3})` }],
            lines: [{ content: 'Length: 10 mm', source: `D(1,0,0,${width},0,${width},${height * 0.1},0,${height * 0.1})` }]
          }]
        }]
      }
    }
  };
  return { bytes, proposal, layout };
}
const code = expected => error => error.code === expected;
const pageOf = layout => layout.analysis.result.contents[0].pages[0];
function close(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((point, index) => point.forEach((value, axis) => assert.ok(Math.abs(value - expected[index][axis]) < 1e-9)));
}

test('discovers CU words and lines without field matching, span slicing, or invented confidence', async () => {
  const { bytes, proposal, layout } = await fixture();
  pageOf(layout).lines[0].content = 'Part \u{1f527}: 10 mm';
  pageOf(layout).lines[0].span = { offset: 999, length: 1 };
  const original = structuredClone(proposal);
  const found = await discoverCuLayout(layout, proposal, bytes);
  assert.equal(found.wordCount, 1);
  assert.equal(found.lineCount, 1);
  assert.equal(found.analysisSha256, hash(JSON.stringify(layout.analysis)));
  assert.equal(found.documentSha256, proposal.document.sha256);
  assert.deepEqual(proposal, original);
  assert.deepEqual(proposal.fields[0].evidenceIds, []);
  const word = found.regions.find(item => item.discovery.kind === 'word');
  const line = found.regions.find(item => item.discovery.kind === 'line');
  close(word.polygon, [[0.1, 0.2], [0.3, 0.2], [0.3, 0.5], [0.1, 0.5]]);
  assert.equal(word.ocrConfidence, 0.99);
  assert.equal(line.ocrConfidence, undefined);
  assert.equal(line.quote, 'Part \u{1f527}: 10 mm');
  assert.equal(line.discovery.elementPath, '/contents/0/pages/0/lines/0');
  assert.equal(word.variant, undefined);
});

test('transforms unrotated coordinates for every PDF quarter-turn, but does not rotate displayed coordinates twice', async () => {
  const expected = new Map([
    [0, [[0.1, 0.2], [0.3, 0.2], [0.3, 0.5], [0.1, 0.5]]],
    [90, [[0.8, 0.1], [0.8, 0.3], [0.5, 0.3], [0.5, 0.1]]],
    [180, [[0.9, 0.8], [0.7, 0.8], [0.7, 0.5], [0.9, 0.5]]],
    [270, [[0.2, 0.9], [0.2, 0.7], [0.5, 0.7], [0.5, 0.9]]]
  ]);
  for (const [rotation, points] of expected) {
    const { bytes, proposal, layout } = await fixture(rotation);
    const found = await discoverCuLayout(layout, proposal, bytes);
    close(found.regions[0].polygon, points);
  }
  for (const unit of ['inch', 'pixel']) {
    const { bytes, proposal, layout } = await fixture(90, 'display', unit);
    const found = await discoverCuLayout(layout, proposal, bytes);
    close(found.regions[0].polygon, expected.get(0));
  }
});

test('rejects mismatched PDF identity, cropped sources, and incompatible page dimensions', async () => {
  const { bytes, proposal, layout } = await fixture();
  await assert.rejects(discoverCuLayout({ ...layout, documentSha256: '0'.repeat(64) }, proposal, bytes), code('layout_source_mismatch'));
  await assert.rejects(discoverCuLayout(layout, proposal, Buffer.from('not the source PDF')), code('source_changed'));
  const wrongPage = structuredClone(layout);
  pageOf(wrongPage).width *= 2;
  await assert.rejects(discoverCuLayout(wrongPage, proposal, bytes), code('layout_page_mismatch'));
  const pdf = await PDFDocument.load(bytes);
  pdf.getPage(0).setCropBox(10, 10, 180, 80);
  const cropped = Buffer.from(await pdf.save());
  const croppedId = hash(cropped);
  await assert.rejects(discoverCuLayout({ ...layout, documentSha256: croppedId },
    { ...proposal, document: { ...proposal.document, id: croppedId, sha256: croppedId } }, cropped), code('unsupported_layout_pdf'));
});

test('rejects partial, failed, empty, and multi-content results instead of silently importing no boxes', async () => {
  const { bytes, proposal, layout } = await fixture();
  const mutations = [
    input => { input.analysis.status = 'Running'; },
    input => { input.analysis.result.contents.push(structuredClone(input.analysis.result.contents[0])); },
    input => { input.analysis.result.contents[0].startPageNumber = 2; },
    input => { pageOf(input).pageNumber = 2; },
    input => { pageOf(input).words = []; pageOf(input).lines = []; },
    input => { delete pageOf(input).words[0].source; },
    input => { input.coordinateSpace = 'guess'; }
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(layout);
    mutate(invalid);
    await assert.rejects(discoverCuLayout(invalid, proposal, bytes), error => error.status === 400);
  }
});

test('rejects malformed, out-of-page, degenerate, and cross-page regions', async () => {
  const { bytes, proposal, layout } = await fixture();
  for (const source of [
    'D(1,NaN,0,1,1)', 'D(1,-1,0,1,1)', 'D(1,0,0,100,100)',
    'D(1,0,0,0,1)', 'D(2,0,0,1,1)', 'D(1,0,0,1)', 'not a source'
  ]) {
    const invalid = structuredClone(layout);
    pageOf(invalid).words[0].source = source;
    await assert.rejects(discoverCuLayout(invalid, proposal, bytes), code('invalid_layout_region'));
  }
});

test('enforces the shared 1000-region limit and does not collide with existing evidence IDs', async () => {
  const { bytes, proposal, layout } = await fixture();
  const full = structuredClone(layout);
  pageOf(full).lines = [];
  pageOf(full).words = Array.from({ length: 1001 }, () => structuredClone(pageOf(layout).words[0]));
  await assert.rejects(discoverCuLayout(full, proposal, bytes), code('layout_region_limit'));
  const found = await discoverCuLayout(layout, proposal, bytes);
  proposal.evidence.push({ ...found.regions[0] });
  await assert.rejects(discoverCuLayout(layout, proposal, bytes), code('layout_id_conflict'));
});

test('discovery cannot clear a wrong-variant flag or supply a variant label', async () => {
  const { bytes, proposal, layout } = await fixture();
  proposal.fields[0].variantScoped = true;
  const found = await discoverCuLayout(layout, proposal, bytes);
  const record = createCase(proposal, { id: 'importer' });
  record.cuLayout = found;
  assert.ok(reasons(record.proposal, record.proposal.fields[0]).includes('variant_mismatch'));
  const command = {
    action: 'correct', fieldId: 'length', value: 10, evidenceIds: [found.regions[0].id],
    reason: 'Read the CU word.', runId: proposal.runId, documentSha256: proposal.document.sha256
  };
  assert.throws(() => applyCommand(record, command, { id: 'reviewer' }, 'variant-check'), code('variant_mismatch'));
});
