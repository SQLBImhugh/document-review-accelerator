import * as pdfjs from '/vendor/pdfjs/build/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';

const $ = id => document.getElementById(id);
const labels = {
  missing_document: 'Source PDF missing', missing_evidence: 'No linked evidence', unknown_model_score: 'Model score not provided',
  low_model_score: 'Low model score', missing_value: 'Required value missing', critical_field: 'Critical field',
  variant_mismatch: 'Wrong variant / row', needs_review: 'Needs review', in_review: 'In review',
  needs_information: 'Needs information', validated: 'Validated'
};
let identity, account, config, cases = [], current, fieldId, pdf, pdfBytes, pdfLoadingTask, renderTask;
let pageNumber = 1, generation = 0, selectedEvidence = new Set(), busy = false, caseLoading = false;
const sourceEvidence = () => [...current.proposal.evidence, ...(current.cuLayout?.regions ?? [])];
const pageRegions = () => (current.cuLayout?.regions ?? [])
  .filter(item => item.page === pageNumber && item.discovery.kind === $('cu-kind').value);
const display = value => value === null || value === undefined ? '(not provided)' : String(value);
const signal = value => value === null || value === undefined ? 'Not provided' : `${Math.round(value * 100)}%`;
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function message(text, kind = '') { $('message').textContent = text; $('message').className = `message ${kind}`; }
function report(error) { message(error.message ?? 'The operation failed.', 'error'); }
async function token() {
  if (!account) throw new Error('Sign in before reviewing a case.');
  try {
    return (await identity.acquireTokenSilent({ account, scopes: [config.apiScope] })).accessToken;
  } catch { throw new Error('Your sign-in needs attention. Select Sign in to renew it. Unsaved input has not been submitted.'); }
}
async function api(route, options = {}) {
  const response = await fetch(`/api${route}`, {
    ...options, headers: { authorization: `Bearer ${await token()}`, ...options.headers }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message ?? `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return response;
}
async function signIn() {
  try {
    if (!identity) throw new Error('Sign-in is still initializing. Try again.');
    const result = await identity.loginPopup({ scopes: [config.apiScope], prompt: 'select_account' });
    account = result.account;
    identity.setActiveAccount(account);
    const me = await (await api('/me')).json();
    if (!me.roles.includes('Reviewer')) throw new Error('This identity has no Reviewer role. Ask the deployment administrator for access.');
    $('identity').textContent = account.name ?? 'Signed in';
    $('signin').textContent = 'Renew sign-in';
    $('signout').hidden = false;
    $('refresh').disabled = false;
    await loadQueue();
  } catch (error) { report(error); }
}
async function loadQueue() {
  cases = (await (await api('/cases')).json()).items;
  paintQueue();
  message(`${cases.length} cases loaded from durable review storage.`);
  if (!current && cases.length) await openCase(cases[0].id);
}
function paintQueue() {
  const query = $('search').value.toLowerCase();
  const status = $('status-filter').value;
  const filtered = cases.filter(item => (!status || item.status === status) &&
    `${item.id} ${item.requestedPart}`.toLowerCase().includes(query));
  $('queue').replaceChildren();
  $('queue-count').textContent = `${filtered.length} shown / ${cases.length} total`;
  for (const item of filtered) {
    const button = node('button', undefined, 'queue-item');
    button.setAttribute('aria-pressed', String(current?.proposal.id === item.id));
    const pending = item.status !== 'validated';
    const statusText = !pending ? 'Signed off' : item.open ? `${item.open} field${item.open === 1 ? '' : 's'} need review` : 'Needs case sign-off';
    button.append(node('strong', item.requestedPart), node('small', item.id, 'queue-id'),
      node('small', statusText, `queue-state ${pending ? 'needs-input' : 'resolved'}`));
    button.addEventListener('click', () => openCase(item.id).catch(report));
    $('queue').append(button);
  }
  if (!filtered.length) $('queue').append(node('p', 'No matching cases.', 'empty'));
}
async function openCase(id) {
  const thisGeneration = ++generation;
  caseLoading = true;
  if (current) { paintFields(); paintSources(); paintHighlights(); paintDecisionControls(); }
  renderTask?.cancel();
  try {
    const record = await (await api(`/cases/${encodeURIComponent(id)}`)).json();
    if (thisGeneration !== generation) return;
    const previousTask = pdfLoadingTask;
    pdfLoadingTask = null;
    pdf = null;
    pdfBytes = null;
    await renderPdf();
    await previousTask?.destroy();
    if (thisGeneration !== generation) return;
    current = record;
    pageNumber = 1;
    $('show-cu-boxes').checked = false;
    $('cu-kind').value = current.cuLayout?.lineCount ? 'line' : 'word';
    $('cu-sources').open = false;
    paintCase();
    paintQueue();
    fieldId = current.proposal.fields.find(field => reviewState(field).needsInput)?.id ?? current.proposal.fields[0].id;
    chooseField(fieldId, false);
    $('page').replaceChildren(node('option', '--'));
    $('page-total').textContent = 'of --';
    $('source-caption').textContent = current.proposal.document ? 'Loading the authenticated source PDF.' : 'No source PDF or source regions are attached to this case.';
    $('pdf-sheet').hidden = true;
    $('pdf-empty').hidden = false;
    $('pdf-empty').replaceChildren(node('h3', current.proposal.document ? 'Loading the source PDF...' : 'Source PDF missing'),
      node('p', current.proposal.document ? 'Retrieving the authenticated, integrity-checked source.' : 'Record what is missing. Acceptance and sign-off are blocked until a new case includes the source.'));
    if (!current.proposal.document) return;
    try {
      const response = await api(`/cases/${encodeURIComponent(id)}/document`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (thisGeneration !== generation) return;
      const loadingTask = pdfjs.getDocument({ data: bytes.slice(), cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', isEvalSupported: false });
      pdfLoadingTask = loadingTask;
      const loaded = await loadingTask.promise;
      if (thisGeneration !== generation) { await loadingTask.destroy(); return; }
      pdf = loaded;
      pdfBytes = bytes;
      $('page').replaceChildren(...Array.from({ length: pdf.numPages }, (_, index) => {
        const option = node('option', String(index + 1)); option.value = String(index + 1); return option;
      }));
      $('page-total').textContent = `of ${pdf.numPages}`;
      $('download-pdf').disabled = false;
      const first = sourceEvidence().find(item => selectedEvidence.has(item.id));
      pageNumber = first?.page ?? 1;
      await renderPdf();
    } catch (error) {
      if (thisGeneration !== generation) return;
      $('pdf-empty').replaceChildren(node('h3', 'The source could not be opened'), node('p', error.message));
      report(error);
    }
  } finally {
    if (thisGeneration === generation && current) {
      caseLoading = false;
      paintFields();
      paintSources();
      paintHighlights();
      paintDecisionControls();
    }
  }
}
const decisionFor = id => Object.hasOwn(current.decisions, id) ? current.decisions[id] : undefined;
const isResolved = id => ['accepted', 'corrected'].includes(decisionFor(id)?.kind);
function reviewState(field) {
  const decision = decisionFor(field.id);
  const resolved = isResolved(field.id);
  const needsInput = !resolved && (current.fieldReasons[field.id].length > 0 ||
    current.reviewerFlags.includes(field.id) || decision?.kind === 'unresolved');
  const label = resolved ? decision.kind === 'corrected' ? 'Resolved: correction saved' : 'Resolved: original accepted'
    : needsInput ? decision?.kind === 'unresolved' ? 'Needs information' : 'Needs review' : '';
  return { decision, resolved, needsInput, label, tone: needsInput ? 'needs-input' : resolved ? 'resolved' : 'neutral' };
}
function reviewExplanation(field, state) {
  const value = `${display(state.resolved ? state.decision.value : field.value)} ${field.unit ?? ''}`.trim();
  if (state.resolved) return [`Saved value: ${value}. No further input is required for this field.`];
  if (!state.needsInput) return [];
  const reasons = current.fieldReasons[field.id];
  if (reasons.includes('missing_document')) return [
    'The source PDF is missing, so this field cannot be approved.',
    'Keep it as Needs information until a new source-linked run is supplied.'
  ];
  if (reasons.includes('variant_mismatch')) {
    const variants = [...new Set(field.evidenceIds.map(id => current.proposal.evidence.find(item => item.id === id)?.variant).filter(Boolean))];
    return [
      `This case requests ${current.proposal.requestedPart} (suffix ${current.proposal.requiredVariant}).`,
      `The original ${value} proposal cites ${variants.length ? `suffix ${variants.join(', ')}` : 'no matching suffix'}: the wrong variant.`,
      `Select suffix ${current.proposal.requiredVariant} evidence, verify the value, and save a correction.`
    ];
  }
  if (reasons.includes('missing_value')) return ['No required value was supplied.', 'Verify the source and enter the value, or keep the field as Needs information.'];
  if (reasons.includes('missing_evidence')) return ['No supporting source region was linked to this value.', 'Select the relevant source evidence before accepting or correcting it.'];
  if (reasons.includes('unknown_model_score')) return [
    'No model review score was supplied. This does not mean the value is wrong.',
    'Check the source, then accept the original value or save a correction.'
  ];
  if (reasons.includes('low_model_score')) return ['The original model score is below the review threshold.', 'Check the source, then accept the original value or save a correction.'];
  if (reasons.includes('critical_field')) return [
    'This critical field requires human confirmation, even when the value looks correct.',
    'Check the source, then accept the original value or save a correction.'
  ];
  return ['A reviewer left this field unresolved.', 'Accept or correct it when the source is verified; saving Needs information keeps it open.'];
}
function paintCase() {
  const { proposal, summary, approved } = current;
  $('case-title').textContent = proposal.requestedPart;
  $('case-status').textContent = labels[current.status];
  $('case-status').className = `tag ${current.status}`;
  $('case-meta').textContent = `${proposal.id} / ${proposal.runId} / revision ${proposal.documentRevision}`;
  $('source-request').textContent = `Requested part: ${proposal.requestedPart}${proposal.requiredVariant ? ` / suffix ${proposal.requiredVariant}` : ''}`;
  $('document-name').textContent = proposal.document?.filename ?? 'Source unavailable';
  $('document-meta').textContent = proposal.document ? `${proposal.document.pages.length} pages / SHA-256 ${proposal.document.sha256.slice(0, 12)}... / required suffix ${proposal.requiredVariant ?? '(none)'}` : 'No source attached to this extraction run.';
  $('field-summary').textContent = summary.open ? `${summary.open} field${summary.open === 1 ? ' needs' : 's need'} your input` : 'No field reviews remaining';
  $('field-summary').className = `field-summary ${summary.open ? 'needs-input' : 'resolved'}`;
  $('release-state').textContent = approved ? 'Signed off / read-only' : summary.open ? `${summary.open} field${summary.open === 1 ? ' still needs' : 's still need'} your input` : 'Ready for case sign-off';
  $('release-state').className = approved ? 'resolved' : 'needs-input';
  const pendingFields = proposal.fields.filter(field => reviewState(field).needsInput).map(field => field.label);
  $('release-detail').textContent = approved ? `Approved ${new Date(approved.at).toLocaleString()}. Feedback export is a candidate dataset, not automatic training.`
    : summary.open ? `Awaiting input: ${pendingFields.join(', ')}. Then sign off once to release the case.`
    : 'No field corrections remain. Sign off once to release the reviewed result.';
  $('signoff').disabled = busy || Boolean(approved) || summary.open > 0 || !pdf;
  $('export').disabled = !approved;
  $('feedback').disabled = !approved;
  $('audit-count').textContent = `(${current.audit.length})`;
  $('audit').replaceChildren(...[...current.audit].reverse().map(event => {
    const li = node('li');
    li.append(node('b', `${event.action}${event.fieldId ? ` / ${event.fieldId}` : ''}`),
      node('p', event.reason), node('time', `${new Date(event.at).toLocaleString()} / actor ${event.actorId.slice(0, 12)}`));
    return li;
  }));
  paintFields();
}
function paintFields() {
  $('fields').replaceChildren(...current.proposal.fields.map(field => {
    const state = reviewState(field);
    const button = node('button', undefined, `field-item ${state.tone}`);
    button.disabled = caseLoading || busy;
    button.setAttribute('aria-pressed', String(field.id === fieldId));
    button.append(node('span', field.label), node('span', `${display(state.resolved ? state.decision.value : field.value)} ${field.unit ?? ''}`, 'field-value'));
    if (state.label) button.append(node('span', state.label, `field-state ${state.tone}`));
    button.addEventListener('click', () => chooseField(field.id));
    return button;
  }));
}
function chooseField(id, render = true) {
  fieldId = id;
  const field = current.proposal.fields.find(item => item.id === id);
  const decision = decisionFor(id);
  const state = reviewState(field);
  selectedEvidence = new Set(decision?.evidenceIds ?? field.evidenceIds);
  $('inspector').hidden = false;
  $('field-title').textContent = field.label;
  $('field-kind').textContent = field.kind;
  $('requested-part').textContent = current.proposal.requestedPart;
  $('requested-variant').textContent = current.proposal.requiredVariant ? `Required suffix: ${current.proposal.requiredVariant}` : 'No suffix restriction';
  $('review-callout').hidden = !state.label;
  $('review-callout').className = `review-callout ${state.tone}`;
  $('review-state-label').textContent = state.label;
  $('review-explanation').replaceChildren(...reviewExplanation(field, state).map(text => node('p', text)));
  $('routing-signals').open = false;
  $('value-label').textContent = state.needsInput ? 'Value to review' : state.resolved ? 'Reviewed value' : 'Value';
  $('pdf-sheet').dataset.reviewState = state.tone;
  $('source-legend').dataset.reviewState = state.tone;
  $('field-reasons').replaceChildren(...current.fieldReasons[id].map(reason => node('span', labels[reason])));
  $('model-score').textContent = signal(field.modelScore);
  $('native-score').textContent = signal(field.nativeConfidence);
  $('field-unit').textContent = field.unit ? `(${field.unit})` : '';
  $('reviewed-value').type = field.valueType === 'number' ? 'number' : 'text';
  $('reviewed-value').step = 'any';
  $('reviewed-value').value = display(isResolved(id) ? decision.value : field.value).replace(/^\(not provided\)$/, '');
  $('reviewed-value').disabled = Boolean(current.approved) || busy;
  $('original-value').textContent = `Original proposal: ${display(field.value)} ${field.unit ?? ''}${field.valueType === 'boolean' ? ' / enter true or false' : ''}`;
  $('reason').value = decision?.reason ?? '';
  $('reason').disabled = Boolean(current.approved) || busy;
  const first = sourceEvidence().find(item => selectedEvidence.has(item.id));
  if (first) pageNumber = first.page;
  paintSources();
  paintDecisionControls();
  paintFields();
  if (render) renderPdf().catch(report);
}
function selectEvidence(item, checked) {
  if (busy || caseLoading || current.approved || !pdf) return;
  if (checked) selectedEvidence.add(item.id); else selectedEvidence.delete(item.id);
  const changedPage = pageNumber !== item.page;
  pageNumber = item.page;
  if (item.discovery) {
    $('show-cu-boxes').checked = true;
    $('cu-sources').open = true;
  }
  paintSources();
  if (changedPage) renderPdf().catch(report); else paintHighlights();
}
function paintSources() {
  if (!current) return;
  const focused = document.activeElement?.id;
  const field = current.proposal.fields.find(item => item.id === fieldId);
  const locked = Boolean(current.approved) || busy || caseLoading || !pdf;
  const option = item => {
    const label = node('label', undefined, 'evidence-option');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `evidence-${item.id}`;
    checkbox.value = item.id;
    checkbox.checked = selectedEvidence.has(item.id);
    checkbox.disabled = locked;
    checkbox.addEventListener('change', () => selectEvidence(item, checkbox.checked));
    const details = node('span', item.quote);
    if (field.variantScoped && current.proposal.requiredVariant && item.variant) {
      details.append(node('strong', item.variant === current.proposal.requiredVariant
        ? `Matches requested suffix ${item.variant}` : `Different suffix ${item.variant}`,
      item.variant === current.proposal.requiredVariant ? 'evidence-target' : 'evidence-other'));
    }
    details.append(node('small', `${item.discovery ? `CU ${item.discovery.kind} / ` : ''}Page ${item.page}${item.variant ? ` / suffix ${item.variant}` : ''} / OCR confidence ${signal(item.ocrConfidence)}`));
    label.append(checkbox, details);
    return label;
  };
  const discovered = current.cuLayout?.regions ?? [];
  $('evidence-list').replaceChildren(...current.proposal.evidence.map(option),
    ...discovered.filter(item => selectedEvidence.has(item.id)).map(option));
  if (!current.proposal.evidence.length && !selectedEvidence.size) {
    $('evidence-list').append(node('p', discovered.length ? 'No source is linked yet. Choose a CU box manually.' : 'No source regions were supplied.', 'micro'));
  }
  $('cu-toolbar').hidden = !discovered.length;
  $('show-cu-boxes').disabled = !pdf || caseLoading;
  $('cu-kind').disabled = !pdf || caseLoading;
  for (const kind of ['word', 'line']) $('cu-kind').querySelector(`option[value="${kind}"]`).disabled = !discovered.some(item => item.discovery.kind === kind);
  const candidates = pageRegions();
  $('cu-layout-caption').textContent = `${discovered.length} imported boxes / select supporting evidence manually`;
  $('cu-sources').hidden = !discovered.length;
  $('cu-region-count').textContent = `(${candidates.length} ${$('cu-kind').value} boxes on page ${pageNumber})`;
  $('cu-source-list').replaceChildren(...candidates.filter(item => !selectedEvidence.has(item.id)).map(option));
  if (!candidates.length) $('cu-source-list').append(node('p', 'No CU boxes of this kind on this page.', 'micro'));
  const saved = decisionFor(fieldId)?.evidenceIds ?? field.evidenceIds;
  const pending = selectedEvidence.size !== saved.length || saved.some(id => !selectedEvidence.has(id));
  $('evidence-selection').textContent = `${selectedEvidence.size} source${selectedEvidence.size === 1 ? '' : 's'} selected.${pending ? ' Save an acceptance or correction to retain this selection.' : ''}`;
  if (focused?.startsWith('evidence-')) $(focused)?.focus({ preventScroll: true });
}
function paintDecisionControls() {
  const locked = busy || caseLoading || Boolean(current.approved);
  $('reviewed-value').disabled = locked;
  $('reason').disabled = locked;
  $('accept').disabled = locked || !pdf || current.fieldReasons[fieldId].includes('variant_mismatch');
  $('correct').disabled = locked || !pdf;
  $('unresolved').disabled = locked;
  $('unresolved').className = reviewState(current.proposal.fields.find(field => field.id === fieldId)).needsInput ? 'attention' : '';
  $('signoff').disabled = locked || current.summary.open > 0 || !pdf;
}
async function renderPdf() {
  if (!pdf) {
    $('page').disabled = true;
    $('previous-page').disabled = true;
    $('next-page').disabled = true;
    $('download-pdf').disabled = true;
    $('discovery-overlay').replaceChildren();
    $('evidence-overlay').replaceChildren();
    return;
  }
  renderTask?.cancel();
  const source = pdf;
  const targetPage = pageNumber;
  const thisGeneration = generation;
  let page;
  try { page = await source.getPage(targetPage); } catch (error) { if (thisGeneration !== generation) return; throw error; }
  if (source !== pdf || thisGeneration !== generation || targetPage !== pageNumber) return;
  const scale = Math.max(0.3, ($('pdf-scroll').clientWidth - 48) / page.getViewport({ scale: 1 }).width) * Number($('zoom').value) / 100;
  const viewport = page.getViewport({ scale });
  const canvas = $('pdf-canvas');
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  $('pdf-sheet').style.width = `${viewport.width}px`;
  $('pdf-sheet').style.height = `${viewport.height}px`;
  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
  renderTask = task;
  try { await task.promise; } catch (error) { if (error.name === 'RenderingCancelledException') return; throw error; }
  if (source !== pdf || thisGeneration !== generation || targetPage !== pageNumber) return;
  $('pdf-empty').hidden = true;
  $('pdf-sheet').hidden = false;
  $('page').disabled = false;
  $('page').value = String(pageNumber);
  $('previous-page').disabled = pageNumber <= 1;
  $('next-page').disabled = pageNumber >= pdf.numPages;
  paintSources();
  paintHighlights();
}
function paintHighlights() {
  if (!pdf || !current) return;
  const visible = sourceEvidence().filter(item => item.page === pageNumber && selectedEvidence.has(item.id));
  const candidates = $('show-cu-boxes').checked ? pageRegions() : [];
  const candidateIds = new Set(candidates.map(item => item.id));
  const polygonFor = item => {
    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', item.polygon.map(point => point.join(',')).join(' '));
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = item.quote;
    polygon.append(title);
    return polygon;
  };
  $('evidence-overlay').replaceChildren(...visible.filter(item => !candidateIds.has(item.id)).map(polygonFor));
  const focused = document.activeElement?.dataset.evidenceId;
  $('discovery-overlay').replaceChildren(...candidates.map(item => {
    const polygon = polygonFor(item);
    const locked = Boolean(current.approved) || busy || caseLoading;
    polygon.dataset.evidenceId = item.id;
    polygon.setAttribute('role', 'checkbox');
    polygon.setAttribute('tabindex', locked ? '-1' : '0');
    polygon.setAttribute('aria-label', `Use CU ${item.discovery.kind}: ${item.quote}`);
    polygon.setAttribute('aria-checked', String(selectedEvidence.has(item.id)));
    polygon.setAttribute('aria-disabled', String(locked));
    const toggle = () => selectEvidence(item, !selectedEvidence.has(item.id));
    polygon.addEventListener('click', toggle);
    polygon.addEventListener('keydown', event => {
      if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); toggle(); }
    });
    return polygon;
  }));
  if (focused) $('discovery-overlay').querySelector(`[data-evidence-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  $('source-caption').textContent = visible.length ? visible.map(item => item.quote).join(' / ')
    : candidates.length ? `Choose a CU box as supporting evidence for ${current.proposal.fields.find(item => item.id === fieldId).label}. Nothing is linked automatically.`
    : 'No selected evidence on this page. Select a supporting source to locate it.';
}
async function submit(action) {
  if (!current || busy) return;
  const field = current.proposal.fields.find(item => item.id === fieldId);
  let value = $('reviewed-value').value;
  if (field.valueType === 'number') value = value.trim() ? Number(value) : null;
  if (field.valueType === 'boolean') value = value === 'true' ? true : value === 'false' ? false : null;
  const command = {
    action, fieldId, value, evidenceIds: [...selectedEvidence], reason: $('reason').value,
    runId: current.proposal.runId, documentSha256: current.proposal.document?.sha256 ?? null
  };
  busy = true;
  ['accept', 'correct', 'unresolved', 'signoff'].forEach(id => { $(id).disabled = true; });
  paintFields();
  paintDecisionControls();
  paintSources();
  paintHighlights();
  const key = crypto.randomUUID();
  const options = { method: 'POST', headers: { 'content-type': 'application/json', 'if-match': current.etag, 'idempotency-key': key }, body: JSON.stringify(command) };
  try {
    let response;
    try { response = await api(`/cases/${encodeURIComponent(current.proposal.id)}/commands`, options); }
    catch (error) {
      if (error.status) throw error;
      response = await api(`/cases/${encodeURIComponent(current.proposal.id)}/commands`, options);
    }
    current = await response.json();
    busy = false;
    paintCase();
    chooseField(fieldId);
    await loadQueue();
    message(action === 'signoff' ? 'Case signed off. The original, reviewed result, and audit history are retained.' : 'Review decision saved to durable storage.', 'success');
  } catch (error) {
    busy = false;
    if (error.status === 412) {
      await openCase(current.proposal.id);
      message('Another reviewer changed this case. The current version was reloaded; your attempted decision was not applied.', 'error');
    } else { paintCase(); paintSources(); paintHighlights(); paintDecisionControls(); report(error); }
  }
}
function download(bytes, filename, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = node('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function exportCase(feedback) {
  const result = await (await api(`/cases/${encodeURIComponent(current.proposal.id)}/export${feedback ? '?kind=feedback' : ''}`)).json();
  download(JSON.stringify(result, null, 2), `${current.proposal.id}-${feedback ? 'feedback-candidate' : 'reviewed'}.json`, 'application/json');
}
$('signin').addEventListener('click', signIn);
$('signout').addEventListener('click', async () => {
  await identity.clearCache();
  location.reload();
});
$('refresh').addEventListener('click', async () => {
  try { await loadQueue(); if (current) await openCase(current.proposal.id); } catch (error) { report(error); }
});
$('search').addEventListener('input', paintQueue);
$('status-filter').addEventListener('change', paintQueue);
$('page').addEventListener('change', () => { pageNumber = Number($('page').value); renderPdf().catch(report); });
$('zoom').addEventListener('change', () => renderPdf().catch(report));
$('show-cu-boxes').addEventListener('change', () => {
  if ($('show-cu-boxes').checked) $('cu-sources').open = true;
  paintHighlights();
});
$('cu-kind').addEventListener('change', () => { paintSources(); paintHighlights(); });
$('previous-page').addEventListener('click', () => { pageNumber--; renderPdf().catch(report); });
$('next-page').addEventListener('click', () => { pageNumber++; renderPdf().catch(report); });
$('download-pdf').addEventListener('click', () => { if (pdfBytes) download(pdfBytes, current.proposal.document.filename, 'application/pdf'); });
for (const action of ['accept', 'correct', 'unresolved', 'signoff']) $(action).addEventListener('click', () => submit(action).catch(report));
$('export').addEventListener('click', () => exportCase(false).catch(report));
$('feedback').addEventListener('click', () => exportCase(true).catch(report));
try {
  config = await (await fetch('/api/config', { cache: 'no-store' })).json();
  if (config.mode === 'identity_setup_required') {
    $('setup-notice').hidden = false;
    message('Application deployed. Microsoft Entra setup is still required before anyone can sign in or review documents.');
  } else {
    identity = new window.msal.PublicClientApplication({
      auth: { clientId: config.spaClientId, authority: `https://login.microsoftonline.com/${config.tenantId}`, redirectUri: `${location.origin}/auth.html` },
      cache: { cacheLocation: 'memoryStorage' }
    });
    await identity.initialize();
    $('signin').disabled = false;
  }
} catch (error) { report(new Error(`Sign-in could not initialize: ${error.message}`)); }
