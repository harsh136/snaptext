const $ = (id) => document.getElementById(id);

const uploadView = $('uploadView'), workView = $('workView');
const fileInput = $('fileInput'), dropzone = $('dropzone');
const previewImg = $('previewImg'), overlay = $('overlay'), stage = $('stage'), dragRect = $('dragRect');
const progressWrap = $('progressWrap'), progressBar = $('progressBar');
const selectedText = $('selectedText'), fullText = $('fullText');
const selCount = $('selCount'), sheetLabel = $('sheetLabel'), hint = $('hint');
const copyBtn = $('copyBtn'), copyAllBtn = $('copyAllBtn'), toast = $('toast');
const phoneRow = $('phoneRow');

let words = [];
let imgW = 0, imgH = 0;   // display size (original)
let ocrW = 0, ocrH = 0;   // size actually scanned (downscaled)
let mode = 'click';
let showBoxes = true;
let showingAll = false;
let dragStart = null, dragged = false, longPressT = null;

/* ---------- PWA ---------- */
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e;
  $('installBtn').classList.remove('hidden');
});
$('installBtn').onclick = async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('installBtn').classList.add('hidden');
};

/* ---------- one-time offline pack (engine + English data) ---------- */
const OFFLINE_PACK = [
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.1.1/tesseract-core-simd-lstm.wasm.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.1.1/tesseract-core-lstm.wasm.js',
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
];
const offlineBtn = $('offlineBtn');
async function packReady() {
  try {
    if (!('caches' in window)) return false;
    const c = await caches.open('snaptext-cdn-v1');
    return (await Promise.all(OFFLINE_PACK.map(u => c.match(u)))).every(Boolean);
  } catch { return false; }
}
async function refreshOfflineBtn(label) {
  offlineBtn.textContent = label || ((await packReady()) ? '✓ offline' : '↓ offline');
  offlineBtn.classList.toggle('ready', offlineBtn.textContent.startsWith('✓'));
}
async function savePack(onStep) {
  const c = await caches.open('snaptext-cdn-v1'); // same cache the worker uses
  for (let i = 0; i < OFFLINE_PACK.length; i++) {
    if (!(await c.match(OFFLINE_PACK[i]))) {
      const r = await fetch(OFFLINE_PACK[i]);
      if (!r.ok) throw new Error('net');
      await c.put(OFFLINE_PACK[i], r.clone());
    }
    onStep?.(i + 1);
  }
}
offlineBtn.onclick = async () => {
  if (offlineBtn.textContent.startsWith('✓') || offlineBtn.textContent.startsWith('saving')) return;
  try {
    await savePack((n) => { offlineBtn.textContent = `saving… ${n}/${OFFLINE_PACK.length}`; });
    await refreshOfflineBtn();
    say('saved — works offline now ✓');
  } catch { say('need internet once to save'); await refreshOfflineBtn(); }
};
// Save once, automatically, on first visit — the chip is only a fallback/retry.
refreshOfflineBtn().then(async () => {
  if (offlineBtn.textContent.startsWith('✓') || !navigator.onLine || navigator.connection?.saveData) return;
  try {
    await savePack((n) => { offlineBtn.textContent = `saving… ${n}/${OFFLINE_PACK.length}`; });
    await refreshOfflineBtn();
  } catch { await refreshOfflineBtn(); } // stay on manual chip
});

/* ---------- views ---------- */
function showWork() {
  uploadView.classList.add('hidden');
  workView.classList.remove('hidden');
  $('resetBtn').classList.remove('hidden');
}
function showUpload() {
  workView.classList.add('hidden');
  uploadView.classList.remove('hidden');
  $('resetBtn').classList.add('hidden');
  clearAll();
}

/* ---------- mode / tools ---------- */
$('modeClick').onclick = () => setMode('click');
$('modeBox').onclick = () => setMode('box');
function setMode(m) {
  mode = m;
  $('modeClick').classList.toggle('active', m === 'click');
  $('modeBox').classList.toggle('active', m === 'box');
  buzz(8);
}
$('eyeBtn').onclick = () => {
  showBoxes = !showBoxes;
  overlay.classList.toggle('show', showBoxes);
  $('eyeBtn').classList.toggle('on', showBoxes);
};
$('selectAllBtn').onclick = () => { words.forEach(w => setSel(w, true)); updateSelection(); buzz(15); };
$('clearBtn').onclick = () => { clearSelection(); buzz(10); };
$('changeBtn').onclick = () => fileInput.click();
$('resetBtn').onclick = showUpload;

copyAllBtn.onclick = () => {
  showingAll = !showingAll;
  fullText.classList.toggle('hidden', !showingAll);
  if (showingAll && !selectedText.classList.contains('hidden')) selectedText.classList.add('hidden');
  updateSelection();
  copyAllBtn.textContent = showingAll ? '← back' : 'all text →';
};

/* ---------- intake ---------- */
fileInput.onchange = (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); fileInput.value = ''; };
dropzone.onclick = () => fileInput.click();

window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});
$('pasteBtn').onclick = async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const t = it.types.find(t => t.startsWith('image/'));
      if (t) { loadFile(await it.getType(t)); return; }
    }
    say('nothing in clipboard');
  } catch { say('use device paste instead'); }
};

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) return say('not an image');
  const url = URL.createObjectURL(file);
  previewImg.onload = () => {
    imgW = previewImg.naturalWidth; imgH = previewImg.naturalHeight;
    URL.revokeObjectURL(url);
    showWork();
    runOCR(file);
  };
  previewImg.src = url;
  clearAll();
}

/* ---------- OCR (CDN engine + fast English integer model) ---------- */
let worker = null;
let scanId = 0;
async function getWorker(logger) {
  if (worker) return worker;
  worker = await Tesseract.createWorker('eng', 1, {
    langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int',
    gzip: true,
    logger,
  });
  return worker;
}
const STATUS_SHORT = {
  'loading tesseract core': 'loading engine…',
  'initializing tesseract': 'starting…',
  'loading language traineddata': 'loading language…',
  'initializing api': 'starting…',
};
async function runOCR(file) {
  const my = ++scanId; // stale scans (image switched mid-read) are discarded below
  words = []; overlay.innerHTML = ''; showingAll = false;
  fullText.classList.add('hidden'); copyAllBtn.textContent = 'all text →';
  progressWrap.classList.remove('hidden');
  setProgress(0.02);
  saySilent('starting…');
  try {
    const w = await getWorker((m) => {
      if (m.status === 'recognizing text') { setProgress(m.progress); saySilent(`reading… ${Math.round(m.progress * 100)}%`); }
      else if (STATUS_SHORT[m.status]) saySilent(STATUS_SHORT[m.status]);
    });
    if (my !== scanId) return;
    const scan = await prepImage(file); // shrink big screenshots: fewer pixels, faster scan
    if (my !== scanId) return;
    const { data } = await w.recognize(scan);
    if (my !== scanId) return; // a newer image was picked while this one read
    words = (data.words || [])
      .map(w => ({ text: (w.text || '').trim(), x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, conf: w.confidence, selected: false, el: null }))
      .filter(w => w.text);
    renderWords();
    fullText.textContent = data.text?.trim() || '—';
    progressWrap.classList.add('hidden');
    hint.textContent = words.length ? 'tap words' : 'no text found';
    buzz(20);
    updateSelection();
    refreshOfflineBtn(); // a finished online scan means the pack is cached
  } catch (err) {
    console.error(err);
    progressWrap.classList.add('hidden');
    say('couldn’t read — retry');
  }
}
function setProgress(p) { progressBar.style.width = `${Math.round(p * 100)}%`; }

// Shrink images whose longest side exceeds 2000px. Same aspect ratio,
// so boxes still line up — but far fewer pixels for the engine to chew.
// Dark screenshots (chat apps, dark mode) are Otsu-binarized: flat UI
// colors threshold cleanly, while colored bubbles otherwise defeat the
// engine's own thresholding and text gets dropped or misboxed.
async function prepImage(file) {
  ocrW = imgW; ocrH = imgH;
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    ocrW = Math.round(bmp.width * s); ocrH = Math.round(bmp.height * s);
    const c = document.createElement('canvas');
    c.width = ocrW; c.height = ocrH;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, ocrW, ocrH);
    bmp.close();
    binarizeIfDark(g, ocrW, ocrH);
    return await new Promise((r) => c.toBlob(r, 'image/png')) || file;
  } catch { return file; }
}

// Binarize dark screenshots (chat apps, dark mode) at a fixed threshold.
// Dark UI palettes are constrained (backgrounds/bubbles < ~70, text > ~130),
// while adaptive methods get fooled by the huge background peak and erase
// the text. Light images are left untouched.
function binarizeIfDark(g, w, h) {
  const id = g.getImageData(0, 0, w, h), d = id.data;
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) {
    sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++;
  }
  if (sum / n >= 128) return; // light image: leave alone
  for (let i = 0; i < d.length; i += 4) {
    const v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) > 100 ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(id, 0, 0);
}

function renderWords() {
  overlay.innerHTML = '';
  for (const w of words) {
    const d = document.createElement('div');
    d.className = 'word';
    d.style.left = (w.x0 / ocrW * 100) + '%';
    d.style.top = (w.y0 / ocrH * 100) + '%';
    d.style.width = (Math.max(w.x1 - w.x0, 2) / ocrW * 100) + '%';
    d.style.height = (Math.max(w.y1 - w.y0, 2) / ocrH * 100) + '%';
    w.el = d;
    overlay.appendChild(d);
  }
}

/* ---------- touch selection ---------- */
function stagePos(e) {
  const r = stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function wordAtPoint(px, py) {
  const r = stage.getBoundingClientRect();
  const ix = px * (ocrW / r.width), iy = py * (ocrH / r.height);
  // pad hit-area for fingers (~14px in image space)
  const pad = 14 * (ocrW / r.width);
  return words.find(w => ix >= w.x0 - pad && ix <= w.x1 + pad && iy >= w.y0 - pad && iy <= w.y1 + pad);
}
function setSel(w, on) { w.selected = on; w.el?.classList.toggle('selected', on); }

stage.addEventListener('pointerdown', (e) => {
  if (!words.length) return;
  dragStart = stagePos(e); dragged = false;
  try { stage.setPointerCapture(e.pointerId); } catch {}
  clearTimeout(longPressT);
  longPressT = setTimeout(() => { if (dragStart && !dragged && mode !== 'box') setMode('box'); }, 450);
});
stage.addEventListener('pointermove', (e) => {
  if (!dragStart) return;
  const p = stagePos(e);
  if (Math.hypot(p.x - dragStart.x, p.y - dragStart.y) > 10) { dragged = true; clearTimeout(longPressT); }
  if (dragged) {
    dragRect.classList.remove('hidden');
    dragRect.style.left = Math.min(p.x, dragStart.x) + 'px';
    dragRect.style.top = Math.min(p.y, dragStart.y) + 'px';
    dragRect.style.width = Math.abs(p.x - dragStart.x) + 'px';
    dragRect.style.height = Math.abs(p.y - dragStart.y) + 'px';
  }
});
const endTouch = (e) => {
  clearTimeout(longPressT);
  if (!dragStart) return;
  const p = stagePos(e);
  if (!dragged) {
    const w = wordAtPoint(p.x, p.y);
    if (w) { setSel(w, !w.selected); updateSelection(); buzz(8); }
  } else boxSelect(dragStart, p);
  dragStart = null; dragged = false;
  dragRect.classList.add('hidden');
};
stage.addEventListener('pointerup', endTouch);
stage.addEventListener('pointercancel', () => { dragStart = null; dragged = false; dragRect.classList.add('hidden'); });

function boxSelect(a, b) {
  const r = stage.getBoundingClientRect();
  const sx = ocrW / r.width, sy = ocrH / r.height;
  const x0 = Math.min(a.x, b.x) * sx, x1 = Math.max(a.x, b.x) * sx;
  const y0 = Math.min(a.y, b.y) * sy, y1 = Math.max(a.y, b.y) * sy;
  let n = 0;
  for (const w of words) {
    const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
    if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1 && !w.selected) { setSel(w, true); n++; }
  }
  updateSelection(); buzz(n ? 20 : 5);
  if (!n) say('nothing there — widen');
}

function clearSelection() { words.forEach(w => setSel(w, false)); updateSelection(); }
function clearAll() { words = []; overlay.innerHTML = ''; fullText.textContent = ''; updateSelection(); }

function selectedInOrder() {
  const sel = words.filter(w => w.selected);
  sel.sort((a, b) => ((a.y0 + a.y1) / 2) - ((b.y0 + b.y1) / 2));
  const lines = [];
  for (const w of sel) {
    const cy = (w.y0 + w.y1) / 2, h = (w.y1 - w.y0) || 10;
    let line = lines.find(l => Math.abs(l.cy - cy) < h * 0.6);
    if (!line) { line = { cy, items: [] }; lines.push(line); }
    else line.cy = (line.cy * line.items.length + cy) / (line.items.length + 1);
    line.items.push(w);
  }
  lines.sort((a, b) => a.cy - b.cy);
  lines.forEach(l => l.items.sort((a, b) => a.x0 - b.x0));
  return lines.map(l => l.items.map(w => w.text).join(' ')).join('\n');
}

function updateSelection() {
  const n = words.filter(w => w.selected).length;
  const text = selectedInOrder();
  selCount.textContent = n;
  const allText = fullText.textContent.trim();
  const canCopyAll = showingAll && allText && allText !== '—';
  copyBtn.disabled = canCopyAll ? false : !n;
  copyBtn.textContent = canCopyAll ? 'Copy all' : (n ? `Copy ${n} word${n > 1 ? 's' : ''}` : 'Copy');
  const has = n > 0;
  selectedText.classList.toggle('hidden', !has || showingAll);
  selectedText.textContent = text;
  sheetLabel.textContent = !words.length ? 'reading…' : has ? `${text.split('\n').length} line${text.includes('\n') ? 's' : ''}` : 'tap words on image';
  hint.textContent = !words.length ? 'reading…' : has ? `${n} selected` : 'tap words · drag for more';
  renderPhones(findPhones(showingAll ? fullText.textContent : text));
}

/* ---------- phone numbers → WhatsApp ---------- */
// Finds Indian mobiles (bare 10-digit, 0/91/+91 prefixed, spaced/dashed)
// plus other explicitly international (+CC…) numbers. Returns [{wa, display}].
function normPhone(raw) {
  const hadPlus = raw.trim().startsWith('+');
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1); // trunk prefix
  if (d.length === 12 && d.startsWith('91') && /^[6-9]/.test(d.slice(2))) return { wa: d, display: fmtPhone(d) };
  if (d.length === 10) {
    if (/^[6-9]/.test(d)) return { wa: '91' + d, display: fmtPhone('91' + d) }; // assume India
    return null;
  }
  if (hadPlus && d.length >= 11 && d.length <= 14) return { wa: d, display: '+' + d };
  return null;
}
function fmtPhone(d) { return `+${d.slice(0, 2)} ${d.slice(2, 7)} ${d.slice(7)}`; }
function findPhones(text) {
  const out = [], seen = new Set();
  for (const m of (text || '').match(/\+?[\d][\d\s\-().]{7,}[\d]/g) || []) {
    const p = normPhone(m);
    if (p && !seen.has(p.wa)) { seen.add(p.wa); out.push(p); }
  }
  return out;
}
function waButton(p) {
  const b = document.createElement('button');
  b.className = 'wa';
  const dot = document.createElement('span'); dot.className = 'wa-dot';
  const num = document.createElement('span'); num.className = 'wa-num'; num.textContent = p.display;
  const go = document.createElement('span'); go.className = 'wa-go'; go.textContent = 'WhatsApp ›';
  b.append(dot, num, go);
  b.onclick = () => window.open('https://wa.me/' + p.wa, '_blank', 'noopener');
  return b;
}
function renderPhones(list) {
  phoneRow.innerHTML = '';
  phoneRow.classList.toggle('hidden', !list.length);
  list.slice(0, 3).forEach(p => phoneRow.appendChild(waButton(p)));
}

/* ---------- manual number → chat (no screenshot needed) ---------- */
const numInput = $('numInput'), numRow = $('numRow');
numInput.addEventListener('input', () => {
  const list = findPhones(numInput.value).slice(0, 3);
  numRow.innerHTML = '';
  numRow.classList.toggle('hidden', !list.length);
  list.forEach(p => numRow.appendChild(waButton(p)));
});
numInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') numRow.querySelector('.wa')?.click();
});

/* ---------- copy ---------- */
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  say('copied ✓'); buzz(25);
}
copyBtn.onclick = () => {
  const t = (showingAll ? fullText.textContent : selectedText.textContent) || '';
  if (t.trim() && t.trim() !== '—') copyText(t);
};

let toastT;
function say(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastT);
  toastT = setTimeout(() => toast.classList.add('hidden'), 1600);
}
function saySilent(msg) { hint.textContent = msg; }
function buzz(ms) { try { navigator.vibrate?.(ms); } catch {} }

window.__snaptext = { get words() { return words; }, selectedInOrder, findPhones };
