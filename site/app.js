import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const SVG = 'http://www.w3.org/2000/svg';
const MOBILE = matchMedia('(max-width: 999px)');
const EDIT = new URLSearchParams(location.search).has('edit');
const RAIL = 300, GUTTER = 36, MAP = 60, NOTE_H = 30, OPEN_H = 34, NOTE_GAP = 4;

// Per-viewer preferences only; the page works without them.
const prefs = {
  get(key, fallback) {
    try { const v = localStorage.getItem('chi:' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('chi:' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const S = {
  notes: [], byId: new Map(), byPage: new Map(), lenses: new Map(),
  lensOn: new Set(), notesOn: true,
  active: null, hover: null, open: new Set(),
  mobile: MOBILE.matches, scale: 1, pw: 0, ph: 0,
  pdf: null, pages: [], data: null,
  hooks: { mount: [] }, // edit mode decorates notes as they mount
};

const reader = $('#reader'), doc = $('#doc'), rail = $('#rail'), links = $('#links'), map = $('#map');
const root = document.documentElement;

/* ---------------- Colour: pastel highlight → readable ink ---------------- */
function inkFor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = Math.round(h * 60 + 360) % 360;
  const light = h > 40 && h < 70 ? 38 : 45; // yellows need to go darker to stay visible
  return `hsl(${h} 75% ${light}%)`;
}

/* ---------------- Build ---------------- */
function visible(n) { return S.notesOn && S.lensOn.has(n.lens); }
function visibleNotes() { return S.notes.filter(visible); }

function buildChips() {
  const chips = $('#chips');
  for (const lens of S.lenses.values()) {
    const b = el('button', 'chip');
    b.type = 'button';
    b.dataset.lens = lens.id;
    b.style.setProperty('--c', lens.colour);
    b.style.setProperty('--ink', lens.ink);
    b.title = `${lens.description ? lens.description[0].toUpperCase() + lens.description.slice(1) : lens.name}. Double-click or long-press to show only this lens.`;
    b.append(el('span', 'chip-dot'), el('span', 'chip-name', lens.name), el('span', 'chip-count'));
    chips.append(b);
  }
  const all = el('button', 'chip chip-all', 'Show all');
  all.type = 'button';
  all.hidden = true;
  chips.append(all);

  let pressTimer = null, soloed = false;
  const solo = (id) => { S.lensOn = new Set([id]); applyFilter(); };
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    if (soloed) { soloed = false; return; }
    if (b === all) { S.lensOn = new Set(S.lenses.keys()); return applyFilter(); }
    const id = +b.dataset.lens;
    S.lensOn.has(id) ? S.lensOn.delete(id) : S.lensOn.add(id);
    applyFilter();
  });
  chips.addEventListener('dblclick', (e) => {
    const b = e.target.closest('.chip[data-lens]');
    if (b) solo(+b.dataset.lens);
  });
  chips.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.chip[data-lens]');
    if (!b || e.pointerType === 'mouse') return;
    pressTimer = setTimeout(() => { soloed = true; solo(+b.dataset.lens); navigator.vibrate?.(10); }, 500);
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) chips.addEventListener(t, () => clearTimeout(pressTimer));
  chips.addEventListener('contextmenu', (e) => { if (e.target.closest('.chip')) e.preventDefault(); });
}

function buildPages(count) {
  for (let i = 1; i <= count; i++) {
    const page = el('section', 'page');
    page.id = `page-${i}`;
    page.dataset.page = i;
    page.setAttribute('aria-label', `Page ${i}`);
    const marks = el('div', 'marks');
    const text = el('div', 'textLayer');
    const markers = el('div', 'markers');
    page.append(el('span', 'page-num', i), marks, text, markers);
    doc.append(page);
    S.pages.push({ n: i, el: page, marks, text, markers, canvas: null, scale: 0, textScale: 0, near: false });
  }
}

/* Small icon buttons in an open note (link; edit and delete in edit mode), each with a tooltip. */
const ICONS = {
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  pencil: ['M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z', 'm15 5 4 4'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  // Selection corners around a text cursor: pick a new passage.
  reanchor: ['M4 8V5a1 1 0 0 1 1-1h3', 'M16 4h3a1 1 0 0 1 1 1v3', 'M20 16v3a1 1 0 0 1-1 1h-3', 'M8 20H5a1 1 0 0 1-1-1v-3', 'M12 8v8', 'M10 8h4', 'M10 16h4'],
};

function iconButton(icon, tip, label) {
  const b = el('button', 'note-icon');
  b.type = 'button';
  b.dataset.tip = tip;
  b.setAttribute('aria-label', label);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[icon]) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  b.append(svg);
  return b;
}

/* Copies a link to the note; its tooltip confirms the copy. */
function linkButton(id) {
  const b = iconButton('link', 'Copy link', 'Copy link to this note');
  b.dataset.copy = id;
  return b;
}

/* Each note appears as an underline in the PDF, a margin note, a connector and a map bar.
   Mobile margin dots are rebuilt from the filter state in buildMarkers(). */
function mountNote(n) {
  const lens = S.lenses.get(n.lens);
  n.marks = n.rects.map(([x0, y0, x1, y1]) => {
    const m = el('div', 'mark');
    m.style.cssText = `--x:${x0};--y:${y0};--w:${x1 - x0};--h:${y1 - y0};--c:${lens.colour};--ink:${lens.ink}`;
    S.pages[n.page - 1].marks.append(m);
    return m;
  });

  const note = el('div', 'note' + (n.lens === 8 ? ' is-q' : ''));
  note.dataset.id = n.id;
  note.tabIndex = 0;
  note.setAttribute('role', 'button');
  note.setAttribute('aria-expanded', 'false');
  note.setAttribute('aria-label', `${lens.name} note on page ${n.page}`);
  note.style.setProperty('--c', lens.colour);
  note.style.setProperty('--ink', lens.ink);
  const head = el('div', 'note-head');
  const preview = el('p', 'note-preview', n.text);
  head.append(el('span', 'note-bar'), preview);
  const body = el('div', 'note-body');
  const foot = el('div', 'note-foot');
  const actions = el('span', 'note-actions');
  actions.append(linkButton(n.id));
  foot.append(actions);
  body.append(el('p', 'note-text', n.text), foot);
  note.append(head, body);
  rail.append(note);
  n.el = note;
  n.preview = preview;
  n.actions = actions;

  n.path = document.createElementNS(SVG, 'path');
  n.dot = document.createElementNS(SVG, 'circle');
  n.dot.setAttribute('r', 2);
  for (const e of [n.path, n.dot]) e.style.setProperty('--ink', lens.ink);
  links.append(n.path, n.dot);

  const [x0, , x1] = n.rects[0];
  n.mapSide = x1 - x0 > S.pageW * 0.6 ? 'wide' : (x0 + x1) / 2 < S.pageW / 2 ? 'left' : 'right';
  n.bar = el('div', 'map-bar');
  n.bar.style.setProperty('--ink', lens.ink);
  n.bar.style.left = n.mapSide === 'right' ? '54%' : '10%';
  n.bar.style.right = n.mapSide === 'left' ? '54%' : '10%';
  $('#map-bars').append(n.bar);

  for (const hook of S.hooks.mount) hook(n);
}

function unmountNote(n) {
  for (const m of n.marks) m.remove();
  for (const e of [n.el, n.path, n.dot, n.bar]) e.remove();
  if (S.active === n.id) setActive(null);
  if (S.hover === n.id) S.hover = null;
  S.open.delete(n.id);
}

const byPosition = (a, b) => a.page - b.page || a.rects[0][1] - b.rects[0][1] || a.rects[0][0] - b.rects[0][0];

/* Rebuild lookups, counts and order after notes change, then re-place everything. */
function refresh() {
  S.notes.sort(byPosition);
  S.byId = new Map(S.notes.map((n) => [n.id, n]));
  S.byPage = new Map();
  for (const n of S.notes) {
    if (!S.byPage.has(n.page)) S.byPage.set(n.page, []);
    S.byPage.get(n.page).push(n);
  }
  for (const lens of S.lenses.values()) {
    lens.count = S.notes.filter((n) => n.lens === lens.id).length;
    const count = document.querySelector(`.chip[data-lens="${lens.id}"] .chip-count`);
    if (count) count.textContent = lens.count;
  }
  renderAboutLenses();
  rail.append(...S.notes.map((n) => n.el)); // keep tab order in reading order
  applyFilter();
  layoutMap();
}

/* Replace all notes, e.g. with the latest version fetched in edit mode. */
function setData(data) {
  for (const n of S.notes) unmountNote(n);
  S.data = data;
  renderAbout(data.about);
  S.notes = data.notes.map((n) => ({ ...n }));
  for (const n of S.notes) mountNote(n);
  refresh();
}

/* Add or replace one note; returns the live note. */
function upsertNote(plain) {
  const old = S.byId.get(plain.id);
  const wasOpen = old && S.open.has(old.id);
  if (old) {
    unmountNote(old);
    S.notes.splice(S.notes.indexOf(old), 1);
  }
  const n = { ...plain };
  S.notes.push(n);
  mountNote(n);
  refresh();
  if (wasOpen) setOpen(n, true);
  return n;
}

function removeNote(id) {
  const n = S.byId.get(id);
  if (!n) return;
  unmountNote(n);
  S.notes.splice(S.notes.indexOf(n), 1);
  refresh();
}

function buildMap() {
  for (const p of S.pages) {
    p.mini = el('div', 'map-page');
    $('#map-pages').append(p.mini);
  }
}

/* The About text lives in annotations.json. Blank lines split paragraphs, and
   [text](https://…) becomes a link. Everything else is inserted as plain text. */
function renderAbout(about = '') {
  const box = $('#about-text');
  box.replaceChildren();
  for (const para of about.split(/\n\s*\n/).map((t) => t.trim())) {
    if (!para) continue;
    const p = el('p');
    let last = 0;
    for (const m of para.matchAll(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g)) {
      p.append(para.slice(last, m.index));
      const a = el('a', null, m[1]);
      a.href = m[2];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      p.append(a);
      last = m.index + m[0].length;
    }
    p.append(para.slice(last));
    box.append(p);
  }
}

function renderAboutLenses() {
  const list = $('#about-lenses');
  list.replaceChildren();
  for (const lens of S.lenses.values()) {
    const li = el('li');
    const dot = el('span', 'chip-dot');
    dot.style.setProperty('--c', lens.colour);
    dot.style.setProperty('--ink', lens.ink);
    const about = lens.description ? lens.description[0].toUpperCase() + lens.description.slice(1) : '';
    li.append(dot, el('strong', null, `${lens.name} (${lens.count})`), el('span', null, about));
    list.append(li);
  }
}

/* ---------------- Geometry ---------------- */
function measure() {
  const W = root.clientWidth;
  S.mobile = MOBILE.matches;
  S.pw = S.mobile ? W - 16 : Math.max(480, Math.min(880, W - 48 - RAIL - GUTTER - MAP));
  S.scale = S.pw / S.pageW;
  S.ph = Math.round(S.pageH * S.scale);
  root.style.setProperty('--pw', S.pw + 'px');
  root.style.setProperty('--ph', S.ph + 'px');
  root.style.setProperty('--scale-factor', S.scale);
}

const pageTop = (n) => S.pages[n - 1].el.offsetTop;
const anchorMid = (n) => pageTop(n.page) + ((n.rects[0][1] + n.rects[0][3]) / 2) * S.scale;
const anchorTop = (n) => pageTop(n.page) + n.rects[0][1] * S.scale;

/* Desktop: place each note beside its passage; on collision, push later notes down. */
function layoutRail() {
  if (S.mobile || !S.notesOn) return;
  const shown = visibleNotes();
  const heights = shown.map((n) => n.el.offsetHeight); // read all, then write
  let bottom = -Infinity;
  shown.forEach((n, i) => {
    const headH = S.open.has(n.id) ? OPEN_H : NOTE_H;
    const mid = anchorMid(n);
    const top = Math.max(mid - headH / 2, bottom + NOTE_GAP);
    const noteMid = top + headH / 2;
    n.top = top;
    n.height = heights[i];
    n.el.style.transform = `translateY(${top}px)`;
    n.path.setAttribute('d', `M2 ${mid} C ${GUTTER * 0.6} ${mid}, ${GUTTER * 0.4} ${noteMid}, ${GUTTER} ${noteMid}`);
    n.dot.setAttribute('cx', 2);
    n.dot.setAttribute('cy', mid);
    bottom = top + heights[i];
  });
  rail.style.minHeight = Math.max(0, bottom) + 'px';
  // Animate note movement only after the first placement.
  if (!rail.classList.contains('animate')) requestAnimationFrame(() => requestAnimationFrame(() => rail.classList.add('animate')));
}

/* Map positions are fractions of the whole document, so they only change on resize. */
const docHeight = () => pageTop(S.pages.length) + S.ph;

function layoutMap() {
  if (S.mobile) return;
  const H = docHeight();
  for (const p of S.pages) {
    p.mini.style.top = (pageTop(p.n) / H) * 100 + '%';
    p.mini.style.height = (S.ph / H) * 100 + '%';
  }
  for (const n of S.notes) {
    n.mapY = anchorMid(n) / H;
    n.bar.style.top = n.mapY * 100 + '%';
  }
  updateMapView();
}

/* The grey box: the part of the paper currently on screen. */
function updateMapView() {
  if (S.mobile) return;
  const H = docHeight(), mapH = map.clientHeight, barH = $('#bar').offsetHeight;
  const docTop = doc.getBoundingClientRect().top; // viewport coordinates
  const from = Math.max(0, (barH - docTop) / H), to = Math.min(1, (innerHeight - docTop) / H);
  const view = $('#map-view');
  view.style.top = from * mapH + 'px';
  view.style.height = Math.max(6, (to - from) * mapH) + 'px';
  S.view = { from, to };
}

/* Mobile: dots in the page margin beside each passage; nearby dots merge. */
function buildMarkers() {
  for (const p of S.pages) p.markers.replaceChildren();
  if (!S.mobile) return;
  const near = 26 / S.scale; // merge dots closer than ~26px on screen
  for (const [page, notes] of S.byPage) {
    const sides = { left: [], right: [] };
    for (const n of notes) {
      if (!visible(n)) continue;
      const [x0, , x1] = n.rects[0];
      sides[(x0 + x1) / 2 < S.pageW / 2 ? 'left' : 'right'].push(n);
    }
    for (const [side, list] of Object.entries(sides)) {
      list.sort((a, b) => a.rects[0][1] - b.rects[0][1]);
      const clusters = [];
      for (const n of list) {
        const y = (n.rects[0][1] + n.rects[0][3]) / 2;
        const last = clusters.at(-1);
        if (last && y - last.y < near) last.notes.push(n);
        else clusters.push({ y, notes: [n] });
      }
      for (const c of clusters) {
        const first = c.notes[0], lens = S.lenses.get(first.lens);
        const b = el('button', 'marker' + (c.notes.length > 1 ? ' is-multi' : ''));
        b.type = 'button';
        b.dataset.ids = c.notes.map((n) => n.id).join(',');
        b.style.cssText = `--x:${side === 'left' ? 26 : S.pageW - 26};--y:${c.y};--c:${lens.colour};--ink:${lens.ink}`;
        b.setAttribute('aria-label', c.notes.length > 1 ? `${c.notes.length} notes` : `${lens.name} note`);
        const dot = el('span', null, c.notes.length > 1 ? c.notes.length : '');
        b.append(dot);
        S.pages[page - 1].markers.append(b);
      }
    }
  }
  markActiveMarker();
}

function markActiveMarker() {
  for (const m of document.querySelectorAll('.marker')) {
    m.classList.toggle('is-active', S.active != null && m.dataset.ids.split(',').includes(String(S.active)));
  }
}

/* ---------------- PDF rendering (lazy, only pages near the viewport) ---------------- */
let pumping = false;
const io = new IntersectionObserver((entries) => {
  for (const e of entries) S.pages[+e.target.dataset.page - 1].near = e.isIntersecting;
  pump();
}, { rootMargin: '150% 0px' });

async function pump() {
  if (pumping || !S.pdf) return;
  pumping = true;
  try {
    for (;;) {
      const mid = scrollY + innerHeight / 2;
      const todo = S.pages
        .filter((p) => p.near && p.scale !== S.scale)
        .sort((a, b) => Math.abs(a.el.offsetTop + S.ph / 2 - mid) - Math.abs(b.el.offsetTop + S.ph / 2 - mid));
      if (!todo.length) break;
      await renderPage(todo[0]);
    }
    for (const p of S.pages) {
      if (!p.near && p.canvas) { // free memory for far-away pages
        p.canvas.width = p.canvas.height = 0;
        p.canvas.remove();
        p.canvas = null;
        p.scale = 0;
      }
    }
  } finally {
    pumping = false;
  }
}

async function renderPage(p) {
  const scale = S.scale;
  const page = await S.pdf.getPage(p.n);
  const viewport = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;
  const res = S.mobile ? Math.min(4, dpr * 1.5) : Math.min(3, Math.max(dpr, 1.5));
  const canvas = el('canvas');
  canvas.width = Math.floor(viewport.width * res);
  canvas.height = Math.floor(viewport.height * res);
  canvas.setAttribute('aria-hidden', 'true');
  try {
    await page.render({
      canvasContext: canvas.getContext('2d', { alpha: false }),
      viewport,
      transform: [res, 0, 0, res, 0, 0],
    }).promise;
  } catch (err) {
    console.error(err);
    p.scale = scale;
    return;
  }
  if (p.canvas) { p.canvas.width = p.canvas.height = 0; p.canvas.remove(); }
  p.el.prepend(canvas);
  p.canvas = canvas;
  p.scale = scale;
  if (p.textScale !== scale) {
    p.text.replaceChildren();
    const layer = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: p.text, viewport });
    await layer.render();
    p.textScale = scale;
  }
  if (p.n === 1) $('#status')?.remove();
}

/* ---------------- State changes ---------------- */
function setClass(n, cls, on) {
  if (!n) return;
  n.el.classList.toggle(cls, on);
  for (const m of n.marks) m.classList.toggle(cls, on);
  n.path.classList.toggle(cls, on);
  n.dot.classList.toggle(cls, on);
  n.bar.classList.toggle(cls, on);
}

function setHover(id) {
  if (S.hover === id) return;
  setClass(S.byId.get(S.hover), 'is-hover', false);
  S.hover = id;
  setClass(S.byId.get(id), 'is-hover', true);
}

function setActive(id) {
  if (S.active === id) return;
  setClass(S.byId.get(S.active), 'is-active', false);
  S.active = id;
  setClass(S.byId.get(id), 'is-active', true);
  markActiveMarker();
  const url = location.pathname + location.search + (id ? `#note-${id}` : '');
  history.replaceState(null, '', url);
}

function setOpen(n, open) {
  open ? S.open.add(n.id) : S.open.delete(n.id);
  n.el.classList.toggle('is-open', open);
  n.el.setAttribute('aria-expanded', open);
  n.preview.textContent = open ? `${S.lenses.get(n.lens).name}` : n.text;
}

function applyFilter() {
  for (const n of S.notes) {
    const off = !S.lensOn.has(n.lens);
    n.el.classList.toggle('is-off', off);
    for (const m of n.marks) m.classList.toggle('is-off', off);
    n.path.classList.toggle('is-off', off);
    n.dot.classList.toggle('is-off', off);
    n.bar.classList.toggle('is-off', off);
  }
  for (const b of document.querySelectorAll('.chip[data-lens]')) b.setAttribute('aria-pressed', S.lensOn.has(+b.dataset.lens));
  $('.chip-all').hidden = S.lensOn.size === S.lenses.size;
  document.body.classList.toggle('notes-off', !S.notesOn);
  const active = S.byId.get(S.active);
  if (active && !visible(active)) { closeSheet(); setActive(null); }
  if (S.sheetNote && !visible(S.sheetNote)) closeSheet();
  layoutRail();
  buildMarkers();
  prefs.set('lenses', [...S.lensOn]);
  prefs.set('notesOn', S.notesOn);
}

function scrollToPassage(n, behavior = 'smooth') {
  const bar = $('#bar');
  const barH = bar.classList.contains('is-tucked') ? 0 : bar.offsetHeight;
  const docTop = doc.getBoundingClientRect().top + scrollY;
  const avail = innerHeight - barH - (S.mobile && !$('#sheet').hidden ? $('#sheet').offsetHeight : 0);
  const y = docTop + anchorTop(n);
  const inView = y - scrollY > barH + 12 && y - scrollY < barH + avail - 40;
  if (!inView) scrollTo({ top: y - barH - avail * 0.3, behavior });
}

/* Desktop: open a note in the margin. */
function openNote(n, { scroll = false, behavior } = {}) {
  setOpen(n, true);
  setActive(n.id);
  layoutRail();
  // Keep the passage and the opened note on screen. Uses the note's target position,
  // not its mid-transition one.
  const barH = $('#bar').offsetHeight;
  const docTop = doc.getBoundingClientRect().top + scrollY;
  const passage = docTop + anchorTop(n) - scrollY;
  const top = docTop + n.top - scrollY, bottom = top + n.height;
  const first = scroll ? Math.min(passage, top) : top;
  if (bottom > innerHeight - 16 || first < barH + 8) {
    const target = scroll ? first - barH - (innerHeight - barH) * 0.25 : bottom > innerHeight - 16
      ? Math.min(bottom - innerHeight + 24, top - barH - 12) : top - barH - 12;
    scrollTo({ top: scrollY + target, behavior: behavior || 'smooth' });
  }
}

function toggleNote(n) {
  if (S.open.has(n.id)) {
    setOpen(n, false);
    if (S.active === n.id) setActive(null);
    layoutRail();
  } else {
    openNote(n);
  }
}

/* Mobile: bottom sheet. */
function showSheet(n, behavior) {
  const sheet = $('#sheet'), lens = S.lenses.get(n.lens);
  S.sheetNote = n;
  const tag = $('#sheet-lens');
  const dot = el('span', 'chip-dot');
  dot.style.setProperty('--c', lens.colour);
  dot.style.setProperty('--ink', lens.ink);
  tag.replaceChildren(dot, lens.name);
  sheet.style.setProperty('--ink', lens.ink);
  $('#sheet-passage').textContent = `“${n.passage}”`;
  $('#sheet-text').textContent = n.text;
  $('#sheet-body').scrollTop = 0;
  const list = visibleNotes(), i = list.indexOf(n);
  $('#sheet-count').textContent = `${i + 1} / ${list.length}`;
  $('#sheet-prev').disabled = i <= 0;
  $('#sheet-next').disabled = i >= list.length - 1;
  sheet.hidden = false;
  sheet.style.transform = '';
  setActive(n.id);
  requestAnimationFrame(() => scrollToPassage(n, behavior));
}

function closeSheet() {
  const sheet = $('#sheet');
  if (sheet.hidden) return;
  sheet.hidden = true;
  S.sheetNote = null;
  setActive(null);
}

function step(dir) {
  const list = visibleNotes();
  if (!list.length) return;
  let i = list.findIndex((n) => n.id === S.active);
  if (i === -1) {
    // Start from the first passage below the top of the screen.
    const docTop = doc.getBoundingClientRect().top + scrollY;
    const y = scrollY + $('#bar').offsetHeight - docTop;
    i = list.findIndex((n) => anchorTop(n) >= y);
    if (i === -1) i = list.length;
    i = dir > 0 ? i - 1 : i;
  }
  const next = list[i + dir];
  if (!next) return;
  if (S.mobile) return showSheet(next);
  const prev = S.byId.get(S.active);
  if (prev) setOpen(prev, false);
  openNote(next, { scroll: true });
}

function goTo(n, behavior = 'smooth') {
  if (!n || !visible(n)) return;
  if (S.mobile) showSheet(n, behavior);
  else openNote(n, { scroll: true, behavior });
}

/* ---------------- Events ---------------- */
function hitTest(pageNo, x, y) {
  let best = null, bestArea = Infinity;
  for (const n of S.byPage.get(pageNo) || []) {
    if (!visible(n)) continue;
    for (const [x0, y0, x1, y1] of n.rects) {
      if (x >= x0 - 1 && x <= x1 + 1 && y >= y0 - 1 && y <= y1 + 2) {
        const area = (x1 - x0) * (y1 - y0);
        if (area < bestArea) { best = n; bestArea = area; }
      }
    }
  }
  return best;
}

function pointToPdf(e, pageEl) {
  const r = pageEl.getBoundingClientRect();
  return [(e.clientX - r.left) / S.scale, (e.clientY - r.top) / S.scale];
}

function wireEvents() {
  doc.addEventListener('click', (e) => {
    const marker = e.target.closest('.marker');
    if (marker) return showSheet(S.byId.get(+marker.dataset.ids.split(',')[0]));
    const pageEl = e.target.closest('.page');
    if (!pageEl || !S.notesOn) return;
    if (String(getSelection()).trim()) return; // the reader is selecting text
    const n = hitTest(+pageEl.dataset.page, ...pointToPdf(e, pageEl));
    if (S.mobile) return n ? showSheet(n) : closeSheet();
    if (n) openNote(n);
    else if (S.active) setActive(null);
  });

  let raf = 0;
  doc.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || S.mobile) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const pageEl = e.target.closest?.('.page');
      const n = pageEl && S.notesOn ? hitTest(+pageEl.dataset.page, ...pointToPdf(e, pageEl)) : null;
      for (const p of S.pages) p.el.classList.toggle('over-mark', p.el === pageEl && !!n);
      setHover(n ? n.id : null);
    });
  });
  doc.addEventListener('pointerleave', () => setHover(null));

  rail.addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      e.stopPropagation();
      const url = `${location.origin}${location.pathname}#note-${copy.dataset.copy}`;
      try {
        await navigator.clipboard.writeText(url);
        copy.dataset.tip = 'Link copied';
        copy.classList.add('is-copied');
        clearTimeout(copy.timer);
        copy.timer = setTimeout(() => { copy.dataset.tip = 'Copy link'; copy.classList.remove('is-copied'); }, 1500);
      } catch { prompt('Link to this note', url); }
      return;
    }
    const note = e.target.closest('.note');
    if (note) toggleNote(S.byId.get(+note.dataset.id));
  });
  rail.addEventListener('keydown', (e) => {
    const note = e.target.closest('.note');
    if (note && (e.key === 'Enter' || e.key === ' ') && e.target === note) {
      e.preventDefault();
      toggleNote(S.byId.get(+note.dataset.id));
    }
  });
  rail.addEventListener('pointerover', (e) => {
    const note = e.target.closest('.note');
    setHover(note ? +note.dataset.id : null);
  });
  rail.addEventListener('pointerleave', () => setHover(null));
  rail.addEventListener('focusin', (e) => {
    const note = e.target.closest('.note');
    if (note) setHover(+note.dataset.id);
  });

  wireMap();
  // The header's height changes when the chips wrap; the sticky map is sized from it.
  new ResizeObserver(() => {
    root.style.setProperty('--bar-h', $('#bar').offsetHeight + 'px');
    updateMapView();
  }).observe($('#bar'));

  wireDownloadMenu();

  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet-prev').addEventListener('click', () => step(-1));
  $('#sheet-next').addEventListener('click', () => step(1));

  // Drag the sheet down to dismiss.
  const sheet = $('#sheet');
  let startY = null;
  for (const handle of [$('#sheet-grip'), $('.sheet-head')]) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      startY = e.clientY;
      handle.setPointerCapture(e.pointerId);
      sheet.style.transition = 'none';
    });
    handle.addEventListener('pointermove', (e) => {
      if (startY == null) return;
      sheet.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`;
    });
    const end = (e) => {
      if (startY == null) return;
      const dy = e.clientY - startY;
      startY = null;
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (dy > 70) closeSheet();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  const about = $('#about');
  $('#about-btn').addEventListener('click', () => about.showModal());
  about.addEventListener('click', (e) => { if (e.target === about) about.close(); });

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.matches?.('input, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'm') return toggleTheme(); // also works with the About dialog open
    if (about.open) return;
    if (k === 's') return toggleSession();
    if (k === 'k' || (S.mobile && k === 'arrowright')) { e.preventDefault(); step(1); } // K: next note
    else if (k === 'j' || (S.mobile && k === 'arrowleft')) { e.preventDefault(); step(-1); } // J: previous note
    else if (k === 'n') toggleNotes();
    else if (k === 'escape') {
      if (S.mobile) return closeSheet();
      const n = S.byId.get(S.active);
      if (n) { setOpen(n, false); setActive(null); layoutRail(); }
    }
  });

  // Keep the reader's place across resizes and rotation.
  let resizeTimer = 0, lastW = root.clientWidth;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (root.clientWidth === lastW && MOBILE.matches === S.mobile) return updateMapView(); // height-only resize
      lastW = root.clientWidth;
      const docTop = doc.getBoundingClientRect().top + scrollY;
      const before = (scrollY - docTop) / (S.ph + gap());
      const wasMobile = S.mobile;
      measure();
      if (wasMobile !== S.mobile) { closeSheet(); }
      scrollTo({ top: docTop + before * (S.ph + gap()) });
      layoutRail();
      layoutMap();
      buildMarkers();
      pump();
    }, 120);
  });

  // Mobile: tuck the bar away while reading down, bring it back on scroll up.
  let lastY = scrollY, mapRaf = 0;
  addEventListener('scroll', () => {
    cancelAnimationFrame(mapRaf);
    mapRaf = requestAnimationFrame(updateMapView);
    const y = scrollY, bar = $('#bar');
    if (S.mobile && $('#sheet').hidden) {
      if (y > lastY + 6 && y > 120) bar.classList.add('is-tucked');
      else if (y < lastY - 6) bar.classList.remove('is-tucked');
    } else bar.classList.remove('is-tucked');
    lastY = y;
  }, { passive: true });

  addEventListener('hashchange', () => {
    const m = location.hash.match(/^#note-(\d+)$/);
    if (m) goTo(S.byId.get(+m[1]));
  });
}

function wireMap() {
  const tip = $('#map-tip');
  const frac = (e) => Math.min(1, Math.max(0, (e.clientY - map.getBoundingClientRect().top) / map.clientHeight));

  // Nearest visible note bar within a few pixels of the pointer.
  const barAt = (e) => {
    if (!S.notesOn) return null;
    const r = map.getBoundingClientRect(), y = e.clientY - r.top, rightSide = e.clientX - r.left > r.width / 2;
    let best = null, bestD = 4;
    for (const n of S.notes) {
      if (!visible(n)) continue;
      const otherSide = n.mapSide !== 'wide' && (n.mapSide === 'right') !== rightSide;
      const d = Math.abs(n.mapY * r.height - y) + (otherSide ? 1.5 : 0); // prefer the column under the pointer
      if (d < bestD) { best = n; bestD = d; }
    }
    return best;
  };

  // Scroll so that fraction f of the paper sits at the top of the visible area.
  const scrollToFrac = (f, behavior) => {
    const docTop = doc.getBoundingClientRect().top + scrollY;
    scrollTo({ top: docTop + f * docHeight() - $('#bar').offsetHeight, behavior });
  };

  const showTip = (e, n) => {
    const r = map.getBoundingClientRect();
    tip.replaceChildren();
    const head = el('div', 'tip-head');
    if (n) {
      const lens = S.lenses.get(n.lens), dot = el('span', 'chip-dot');
      dot.style.setProperty('--c', lens.colour);
      dot.style.setProperty('--ink', lens.ink);
      head.append(dot, lens.name);
      tip.append(head, el('div', 'tip-text', n.text));
    } else {
      const y = frac(e) * docHeight();
      const page = Math.min(S.pages.length, Math.max(1, S.pages.findLastIndex((p) => pageTop(p.n) <= y) + 1));
      const count = (S.byPage.get(page) || []).filter(visible).length;
      head.append(`Page ${page}` + (S.notesOn ? ` · ${count} note${count === 1 ? '' : 's'}` : ''));
      tip.append(head);
    }
    tip.style.left = r.right + 10 + 'px';
    tip.style.top = Math.min(innerHeight - 30, Math.max(30, e.clientY)) + 'px';
    tip.hidden = false;
  };

  let drag = null;
  map.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    map.setPointerCapture(e.pointerId);
    const f = frac(e), { from, to } = S.view;
    // Grab the grey box where it was pressed; elsewhere, centre it on the pointer.
    const offset = f >= from && f <= to ? f - from : (to - from) / 2;
    drag = { startY: e.clientY, offset, moved: false, bar: barAt(e) };
    map.classList.add('is-dragging');
  });
  map.addEventListener('pointermove', (e) => {
    if (drag) {
      if (Math.abs(e.clientY - drag.startY) > 3) drag.moved = true;
      if (drag.moved) scrollToFrac(frac(e) - drag.offset, 'instant');
    }
    const n = drag?.moved ? null : barAt(e);
    setHover(n ? n.id : null);
    showTip(e, n);
  });
  const end = (e) => {
    if (!drag) return;
    const { moved, bar, offset } = drag;
    drag = null;
    map.classList.remove('is-dragging');
    if (moved || e.type === 'pointercancel') return;
    if (bar) goTo(bar);
    else scrollToFrac(frac(e) - offset, 'smooth');
  };
  map.addEventListener('pointerup', end);
  map.addEventListener('pointercancel', end);
  map.addEventListener('pointerleave', () => {
    if (drag) return;
    tip.hidden = true;
    setHover(null);
  });
  map.addEventListener('wheel', () => { tip.hidden = true; }, { passive: true });
}

/* Light/dark mode: follows the system until the reader presses M, then remembers the choice. */
const DARK = matchMedia('(prefers-color-scheme: dark)');
function toggleTheme() {
  const current = root.dataset.theme || (DARK.matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  const colour = getComputedStyle(root).getPropertyValue('--bg').trim();
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = colour;
  prefs.set('theme', next);
}

/* S signs the author in or out. Outside edit mode it opens ?edit, which loads the editor. */
function toggleSession() {
  if (EDIT) return S.editor?.toggleSession(); // absent on phones, where editing is off
  const params = new URLSearchParams(location.search);
  params.delete('edit');
  const rest = params.toString();
  location.assign(`${location.pathname}?edit${rest ? '&' + rest : ''}${location.hash}`);
}

function toggleNotes() {
  S.notesOn = !S.notesOn;
  if (!S.notesOn) { closeSheet(); setActive(null); }
  applyFilter();
}

function wireDownloadMenu() {
  const btn = $('#download-btn'), menu = $('#download-menu');
  const items = () => [...menu.querySelectorAll('[role="menuitem"]')];
  const open = (focusFirst) => {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    if (focusFirst) items()[0].focus();
  };
  const close = (refocus) => {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
  };
  btn.addEventListener('click', (e) => (menu.hidden ? open(e.detail === 0) : close()));
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
  menu.addEventListener('keydown', (e) => {
    const list = items(), i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    else if (e.key === 'Escape') { e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close();
  });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu-wrap')) close(); });
}

function gap() {
  return parseFloat(getComputedStyle(root).getPropertyValue('--page-gap')) || 0;
}

/* ---------------- Start ---------------- */
async function main() {
  const data = await (await fetch('annotations.json')).json();
  [S.pageW, S.pageH] = data.pageSize;
  for (const lens of data.lenses) {
    lens.ink = inkFor(lens.colour);
    S.lenses.set(lens.id, lens);
  }
  const saved = prefs.get('lenses', null);
  S.lensOn = new Set(Array.isArray(saved) ? saved.filter((id) => S.lenses.has(id)) : S.lenses.keys());
  S.notesOn = prefs.get('notesOn', true) !== false;

  measure();
  buildChips();
  buildPages(data.pages);
  buildMap();
  wireEvents();
  setData(data);

  for (const p of S.pages) io.observe(p.el);

  // Deep link: #note-42 opens that note.
  const m = location.hash.match(/^#note-(\d+)$/);
  if (m) {
    const n = S.byId.get(+m[1]);
    if (n && !S.lensOn.has(n.lens)) { S.lensOn.add(n.lens); applyFilter(); }
    goTo(n, 'instant');
  }

  // Author-only editing. The module is fetched only with ?edit, so readers never load it.
  if (EDIT) {
    import('./edit.js')
      .then(({ initEditor }) => initEditor({
        S, $, el, prefs, setData, upsertNote, removeNote, openNote, setOpen, setActive, applyFilter, layoutRail, byPosition, iconButton,
      }))
      .catch((err) => console.error('Edit mode failed to load', err));
  }

  try {
    S.pdf = await pdfjsLib.getDocument({ url: data.pdf, isEvalSupported: false }).promise;
    pump();
  } catch (err) {
    console.error(err);
    const status = $('#status');
    status.textContent = 'The paper could not be loaded. ';
    const a = el('a', null, 'Open the PDF directly');
    a.href = data.pdf;
    status.append(a);
  }
  document.fonts?.ready.then(layoutRail);
}

main();
