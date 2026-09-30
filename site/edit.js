/* Author-only editing, loaded only when the page is opened with ?edit.

   Notes are read from and committed to site/annotations.json on GitHub through the
   REST API, using a fine-grained personal access token that the author pastes in.

   Token handling:
   - Only fine-grained tokens (github_pat_…) are accepted, and the token must be able
     to write to this repository. Classic tokens reach every repository you own.
   - It is kept in sessionStorage (gone when the tab closes) unless "Remember on this
     device" is ticked, and is only ever sent to api.github.com in a header.
   - The page's Content-Security-Policy allows no connections except this origin and
     api.github.com, and no third-party scripts; note text is only ever set as text.
   - Edit mode refuses to run inside a frame. */

const REPO = { owner: 'Matsenas', name: 'chi-mission', branch: 'main', path: 'site/annotations.json' };
const API = `https://api.github.com/repos/${REPO.owner}/${REPO.name}`;
const TOKEN_KEY = 'chi:gh-token';
const DRAFT_KEY = 'chi:draft';

let app, S, $, el;
let token = null;
let base = null; // { sha, data }: the file as last read from GitHub
let draft = emptyDraft(); // unpublished changes on top of base
let connected = false;
let lastLens = 1;
let busy = false; // connecting
let leaving = false; // signing out

function emptyDraft() { return { upserts: {}, deletes: [], created: [] }; }
const changeCount = () => Object.keys(draft.upserts).length + draft.deletes.length;
const plain = ({ id, page, lens, rects, passage, text }) => ({ id, page, lens, rects, passage, text });

export async function initEditor(api) {
  app = api;
  ({ S, $, el } = api);
  if (window.top !== window.self) return; // never edit inside someone else's frame

  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = 'edit.css';
  document.head.append(css);

  if (S.mobile) return toast('Editing works on a laptop or desktop screen.'); // no room in the phone header
  buildBar();
  S.editor = { toggleSession };

  S.hooks.mount.push(decorate);
  wireSelection();
  addEventListener('beforeunload', (e) => {
    if (changeCount() && !leaving) { e.preventDefault(); e.returnValue = ''; }
  });

  token = readToken();
  if (token) connect();
  else askToken();
}

/* ---------------- GitHub ---------------- */
async function gh(path, { method = 'GET', body } = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(API + path, {
    method, headers, body: body && JSON.stringify(body),
    cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
  });
}

async function errorText(res) {
  const j = await res.json().catch(() => ({}));
  return j.message || `${res.status} ${res.statusText}`;
}

const decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
function encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function loadRemote() {
  const res = await gh(`/contents/${REPO.path}?ref=${REPO.branch}`);
  if (res.status === 401) throw Object.assign(new Error('The token was not accepted.'), { auth: true });
  if (!res.ok) throw new Error(await errorText(res));
  const j = await res.json();
  if (j.encoding !== 'base64' || !j.content) throw new Error('annotations.json is too large for the contents API.');
  return { sha: j.sha, data: JSON.parse(decode(j.content)) };
}

async function connect() {
  busy = true;
  updateBar();
  setState('Connecting…');
  try {
    const res = await gh('');
    if (res.status === 401) throw Object.assign(new Error('GitHub did not accept that token. It may have expired or been revoked.'), { auth: true });
    if (res.status === 404) throw Object.assign(new Error('That token cannot see Matsenas/chi-mission. Give it access to this repository.'), { auth: true });
    if (!res.ok) throw new Error(await errorText(res));
    if (res.headers.get('x-oauth-scopes')) {
      throw Object.assign(new Error('That is a classic token, which reaches all your repositories. Use a fine-grained token limited to chi-mission.'), { auth: true });
    }
    const repo = await res.json();
    if (!repo.permissions?.push) {
      throw Object.assign(new Error('That token can read the repository but not write to it. Set Contents to "Read and write".'), { auth: true });
    }
    base = await loadRemote();
    draft = readDraft();
    connected = true;
    document.body.classList.add('editing');
    showCurrent();
    updateBar();
  } catch (err) {
    if (err.auth) { forgetToken(); askToken(err.message); }
    else { updateBar(); setState(`Could not connect: ${err.message}. Press S to retry.`, true); }
  } finally {
    busy = false;
  }
}

/* Base file plus unpublished changes. New notes whose id was taken meanwhile get a fresh one. */
function applyDraft(data) {
  const out = structuredClone(data);
  const deleted = new Set(draft.deletes);
  out.notes = out.notes.filter((n) => !deleted.has(n.id));
  let next = Math.max(out.nextId || 1, ...out.notes.map((n) => n.id + 1));
  for (const note of Object.values(draft.upserts)) {
    const i = out.notes.findIndex((n) => n.id === note.id);
    if (i >= 0 && !draft.created.includes(note.id)) out.notes[i] = structuredClone(note);
    else if (i >= 0) out.notes.push({ ...structuredClone(note), id: next++ });
    else out.notes.push(structuredClone(note));
  }
  out.nextId = Math.max(next, ...out.notes.map((n) => n.id + 1));
  out.notes.sort(app.byPosition);
  return out;
}

function newId() {
  const ids = [...S.notes.map((n) => n.id), ...draft.created, ...draft.deletes];
  return Math.max(base.data.nextId || 1, ...ids.map((id) => id + 1));
}

function showCurrent() {
  const keep = S.active;
  app.setData(applyDraft(base.data));
  const n = keep && S.byId.get(keep);
  if (n) app.openNote(n);
}

async function publish() {
  if (!changeCount()) return;
  const btn = $('#edit-publish');
  btn.disabled = true;
  setState('Publishing…');
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await loadRemote(); // always merge onto the latest file
      const merged = applyDraft(remote.data);
      const res = await gh(`/contents/${REPO.path}`, {
        method: 'PUT',
        body: { message: commitMessage(), content: encode(JSON.stringify(merged, null, 1) + '\n'), sha: remote.sha, branch: REPO.branch },
      });
      if (res.status === 409) continue; // changed between our read and write: read again
      if (res.status === 401) throw Object.assign(new Error('The token is no longer valid.'), { auth: true });
      if (!res.ok) throw new Error(await errorText(res));
      const j = await res.json();
      base = { sha: j.content.sha, data: merged };
      draft = emptyDraft();
      saveDraft();
      showCurrent();
      toast('Published. The live site updates in about a minute.');
      return;
    }
    throw new Error('annotations.json kept changing on GitHub. Try again.');
  } catch (err) {
    if (err.auth) { forgetToken(); connected = false; askToken(`${err.message} Your unpublished changes are kept.`); }
    else toast(`Publish failed: ${err.message}`);
  } finally {
    updateBar();
  }
}

function commitMessage() {
  const added = draft.created.filter((id) => draft.upserts[id]).length;
  const edited = Object.keys(draft.upserts).length - added;
  const parts = [[added, 'added'], [edited, 'edited'], [draft.deletes.length, 'deleted']]
    .filter(([n]) => n).map(([n, what]) => `${n} ${what}`);
  return `Update notes: ${parts.join(', ')}`;
}

/* ---------------- Token and draft storage ---------------- */
function readToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function saveToken(value, remember) {
  try {
    sessionStorage.setItem(TOKEN_KEY, value);
    if (remember) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable: the token lives only in memory */ }
}
function forgetToken() {
  token = null;
  try { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}
function readDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (d && d.upserts && Array.isArray(d.deletes) && Array.isArray(d.created)) return d;
  } catch { /* ignore */ }
  return emptyDraft();
}
function saveDraft() {
  try {
    if (changeCount()) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else localStorage.removeItem(DRAFT_KEY);
  } catch { /* ignore */ }
  updateBar();
}

/* ---------------- Header bar ----------------
   Status (dot and label) sits left of the info button; Publish is the last control
   on the right, after Download. Signing in and out is the S key. */
function buildBar() {
  const status = el('div', 'edit-status');
  status.id = 'edit-status';
  status.title = 'Press S to sign in or out';
  const state = el('span', 'edit-state');
  state.id = 'edit-state';
  status.append(el('span', 'edit-dot'), state);
  $('.bar-actions').prepend(status);

  const publishBtn = el('button', 'edit-btn primary', 'Publish');
  publishBtn.id = 'edit-publish';
  publishBtn.type = 'button';
  publishBtn.hidden = true;
  publishBtn.addEventListener('click', publish);
  $('.bar-actions').append(publishBtn);
}

function setState(text, isError) {
  const state = $('#edit-state');
  state.textContent = text;
  state.classList.toggle('is-error', !!isError);
}

function updateBar() {
  const n = changeCount();
  const publishBtn = $('#edit-publish');
  publishBtn.hidden = !connected;
  publishBtn.disabled = !n;
  publishBtn.textContent = n ? `Publish ${n}` : 'Publish';
  $('#edit-status').classList.toggle('is-connected', connected);
  if (!connected) setState('Not connected');
  else setState(n ? `${n} unpublished change${n === 1 ? '' : 's'}` : 'All published');
}

/* S key: sign out and leave edit mode, or sign in (retrying with a saved token). */
function toggleSession() {
  if (busy) return;
  if (!connected) return token ? connect() : askToken();
  const pending = changeCount();
  if (pending && !confirm(`Sign out? Your ${pending} unpublished change${pending === 1 ? ' stays' : 's stay'} saved in this browser.`)) return;
  forgetToken();
  leaving = true; // unpublished changes are kept in the draft, so skip the leave-page warning
  const url = new URL(location.href);
  url.searchParams.delete('edit');
  location.replace(url.pathname + url.search + url.hash);
}

/* ---------------- Token dialog ---------------- */
function askToken(message = '') {
  let dlg = $('#token-dialog');
  if (!dlg) {
    dlg = el('dialog', 'about token-dialog');
    dlg.id = 'token-dialog';
    const form = el('form');
    const intro = el('p', null, 'Paste a fine-grained personal access token that can only reach ');
    intro.append(el('strong', null, 'Matsenas/chi-mission'), ', with repository permission ', el('strong', null, 'Contents: Read and write'), ' and nothing else.');
    const create = el('a', null, 'Create a token on GitHub ↗');
    create.href = 'https://github.com/settings/personal-access-tokens/new';
    create.target = '_blank';
    create.rel = 'noopener noreferrer';
    const input = el('input');
    Object.assign(input, { type: 'password', name: 'token', autocomplete: 'off', spellcheck: false, placeholder: 'github_pat_…', required: true });
    input.setAttribute('aria-label', 'GitHub token');
    const remember = el('label', 'token-remember');
    const box = el('input');
    box.type = 'checkbox';
    remember.append(box, ' Remember on this device');
    const hint = el('p', 'token-hint', 'Without it, the token is forgotten when you close this tab.');
    const error = el('p', 'token-error');
    error.setAttribute('role', 'alert');
    const row = el('div', 'token-row');
    const cancel = el('button', 'edit-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => dlg.close());
    const ok = el('button', 'edit-btn primary', 'Connect');
    ok.type = 'submit';
    row.append(cancel, ok);
    const link = el('p');
    link.append(create);
    form.append(el('h2', null, 'Connect to GitHub'), intro, link, input, remember, hint, error, row);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = input.value.trim();
      if (!/^github_pat_[A-Za-z0-9_]{20,}$/.test(value)) {
        error.textContent = 'That does not look like a fine-grained token. They start with github_pat_.';
        return;
      }
      input.value = '';
      token = value;
      saveToken(value, box.checked);
      dlg.close();
      connect();
    });
    dlg.append(form);
    document.body.append(dlg);
  }
  dlg.querySelector('.token-error').textContent = message;
  updateBar();
  dlg.showModal();
  dlg.querySelector('input[type="password"]').focus();
}

/* ---------------- Notes: edit and delete buttons ---------------- */
function decorate(n) {
  const edit = app.iconButton('pencil', 'Edit note', 'Edit this note');
  const del = app.iconButton('trash', 'Delete note', 'Delete this note');
  for (const b of [edit, del]) b.classList.add('edit-only');
  edit.addEventListener('click', (e) => { e.stopPropagation(); openComposer({ note: S.byId.get(n.id) }); });
  del.addEventListener('click', (e) => { e.stopPropagation(); deleteNote(n.id); });
  n.actions.prepend(edit, del);
}

function deleteNote(id) {
  const n = S.byId.get(id);
  if (!n) return;
  const before = structuredClone(draft), snapshot = plain(n);
  delete draft.upserts[id];
  if (draft.created.includes(id)) draft.created = draft.created.filter((x) => x !== id);
  else draft.deletes.push(id);
  saveDraft();
  app.removeNote(id);
  toast('Note deleted.', 'Undo', () => {
    draft = before;
    saveDraft();
    app.openNote(app.upsertNote(snapshot));
  });
}

function saveNote(note, isNew) {
  draft.upserts[note.id] = note;
  if (isNew) draft.created.push(note.id);
  saveDraft();
  lastLens = note.lens;
  // Make sure the note is visible under the current filters.
  if (!S.notesOn || !S.lensOn.has(note.lens)) { S.notesOn = true; S.lensOn.add(note.lens); app.applyFilter(); }
  const live = app.upsertNote(note);
  app.openNote(live);
}

/* ---------------- Selecting a passage ---------------- */
let addBtn, reanchorFor = null;

function wireSelection() {
  addBtn = el('button', 'edit-add', '+ Note');
  addBtn.type = 'button';
  addBtn.hidden = true;
  addBtn.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection
  addBtn.addEventListener('click', () => {
    const anchor = anchorFromSelection();
    if (!anchor || anchor.error) return;
    addBtn.hidden = true;
    getSelection().removeAllRanges();
    if (reanchorFor) {
      const target = reanchorFor;
      reanchorFor = null;
      openComposer({ ...target, anchor });
    } else openComposer({ anchor });
  });
  document.body.append(addBtn);

  const update = () => requestAnimationFrame(placeAddButton);
  $('#doc').addEventListener('pointerup', update);
  $('#doc').addEventListener('keyup', update);
  document.addEventListener('selectionchange', () => { if (getSelection().isCollapsed) addBtn.hidden = true; });
  addEventListener('scroll', () => { addBtn.hidden = true; }, { passive: true });
}

function placeAddButton() {
  if (!connected) return;
  const anchor = anchorFromSelection();
  if (!anchor) { addBtn.hidden = true; return; }
  addBtn.textContent = anchor.error || (reanchorFor ? 'Move note here' : '+ Note');
  addBtn.disabled = !!anchor.error;
  const last = anchor.lastRect;
  addBtn.style.left = Math.min(innerWidth - 160, last.right + 6) + 'px';
  addBtn.style.top = Math.min(innerHeight - 40, last.bottom + 6) + 'px';
  addBtn.hidden = false;
}

/* The selected passage as PDF-point rectangles, one per line, like the extraction script. */
function anchorFromSelection() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const pageOf = (node) => (node.nodeType === 1 ? node : node.parentElement)?.closest('.page');
  const inText = (node) => (node.nodeType === 1 ? node : node.parentElement)?.closest('.textLayer');
  if (!inText(range.startContainer) || !inText(range.endContainer)) return null;
  const page = pageOf(range.startContainer);
  const clientRects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
  if (!clientRects.length) return null;
  const lastRect = clientRects[clientRects.length - 1];
  if (page !== pageOf(range.endContainer)) return { error: 'Select within one page', lastRect };

  const box = page.getBoundingClientRect(), k = S.scale;
  const lines = [];
  for (const r of clientRects) {
    const q = [(r.left - box.left) / k, (r.top - box.top) / k, (r.right - box.left) / k, (r.bottom - box.top) / k];
    const line = lines.find((l) => Math.abs((l[1] + l[3]) / 2 - (q[1] + q[3]) / 2) < 3);
    if (line) { line[0] = Math.min(line[0], q[0]); line[1] = Math.min(line[1], q[1]); line[2] = Math.max(line[2], q[2]); line[3] = Math.max(line[3], q[3]); }
    else lines.push(q);
  }
  lines.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const rects = lines.map(([x0, y0, x1, y1]) => [x0, y0 - 1, x1, y1 + 1].map((v) => Math.round(v * 10) / 10));
  const passage = sel.toString().replace(/\s+/g, ' ').replace(/-\s(?=[a-z])/g, '').trim();
  if (!passage) return null;
  return { page: +page.dataset.page, rects, passage, lastRect };
}

/* ---------------- Composer: write or edit a note ---------------- */
function openComposer({ note, anchor }) {
  closeComposer();
  const editing = note ? plain(note) : null;
  const where = anchor || editing;
  let lens = editing?.lens ?? lastLens;

  const box = el('div', 'composer');
  box.id = 'composer';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', editing ? 'Edit note' : 'New note');
  const quote = el('p', 'composer-passage', `“${where.passage}”`);
  const chips = el('div', 'composer-lenses');
  chips.setAttribute('role', 'radiogroup');
  chips.setAttribute('aria-label', 'Lens');
  for (const l of S.lenses.values()) {
    const b = el('button', 'chip', l.name);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.lens = l.id;
    b.style.setProperty('--c', l.colour);
    b.style.setProperty('--ink', l.ink);
    b.prepend(el('span', 'chip-dot'));
    chips.append(b);
  }
  const syncChips = () => {
    for (const b of chips.children) b.setAttribute('aria-checked', +b.dataset.lens === lens);
  };
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lens]');
    if (b) { lens = +b.dataset.lens; syncChips(); }
  });
  syncChips();

  const text = el('textarea', 'composer-text');
  text.rows = 6;
  text.placeholder = 'Write the note…';
  text.value = editing?.text ?? '';
  text.setAttribute('aria-label', 'Note text');

  const foot = el('div', 'composer-foot');
  if (editing) {
    const move = app.iconButton('reanchor', anchor ? 'Passage changed' : 'Re-anchor: select a new passage', 'Pick a different passage for this note');
    move.classList.add('tip-start'); // leftmost in the footer, so the tooltip opens rightwards
    move.classList.toggle('is-on', !!anchor);
    move.addEventListener('click', () => {
      reanchorFor = { note: { ...editing, lens, text: text.value } };
      closeComposer();
      toast('Select the new passage in the paper.');
    });
    foot.append(move);
  }
  foot.append(el('span', 'composer-spacer'), el('span', 'composer-hint', '⌘/Ctrl + Enter'));
  const cancel = el('button', 'edit-btn', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', closeComposer);
  const save = el('button', 'edit-btn primary', 'Save');
  save.type = 'button';
  const syncSave = () => { save.disabled = !text.value.trim(); };
  text.addEventListener('input', syncSave);
  syncSave();
  save.addEventListener('click', () => {
    const body = text.value.trim();
    if (!body) return;
    const out = editing ? { ...editing, lens, text: body } : { id: newId(), page: where.page, lens, rects: where.rects, passage: where.passage, text: body };
    if (anchor) Object.assign(out, { page: anchor.page, rects: anchor.rects, passage: anchor.passage });
    closeComposer();
    saveNote(out, !editing);
  });
  foot.append(cancel, save);

  box.append(quote, chips, text, foot);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeComposer(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save.click(); }
  });
  document.body.append(box);

  // Place it beside the note being edited, or under the selected passage.
  const width = box.offsetWidth, height = box.offsetHeight;
  let left, top;
  const live = editing && S.byId.get(editing.id);
  if (live && !anchor) {
    const r = live.el.getBoundingClientRect();
    left = r.left - width - 16;
    top = r.top;
  } else {
    left = where.lastRect ? where.lastRect.left : innerWidth / 2 - width / 2;
    top = where.lastRect ? where.lastRect.bottom + 10 : innerHeight / 3;
  }
  box.style.left = Math.max(12, Math.min(innerWidth - width - 12, left)) + 'px';
  box.style.top = Math.max($('#bar').offsetHeight + 8, Math.min(innerHeight - height - 12, top)) + 'px';
  text.focus();
  text.setSelectionRange(text.value.length, text.value.length);
}

function closeComposer() {
  $('#composer')?.remove();
}

/* ---------------- Toast ---------------- */
let toastTimer = 0;
function toast(message, actionLabel, action) {
  let t = $('#edit-toast');
  if (!t) {
    t = el('div', 'edit-toast');
    t.id = 'edit-toast';
    t.setAttribute('role', 'status');
    document.body.append(t);
  }
  t.replaceChildren(el('span', null, message));
  if (actionLabel) {
    const b = el('button', 'link-btn', actionLabel);
    b.type = 'button';
    b.addEventListener('click', () => { t.hidden = true; action(); });
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, actionLabel ? 6000 : 4000);
}
