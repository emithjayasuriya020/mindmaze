import { localDay, newVault, readVault, writeVault, seal, unseal } from './vault.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const split = text => [...new Set(text.split(',').map(x => x.trim()).filter(Boolean))].slice(0, 25);
const state = { entries: [], session: null, envelope: null, page: 'today', quiet: false, filter: 'all', query: '', saving: false, editing: null, selected: null, photo: null, audio: null };
let recorder = null, mediaStream = null, recordTimer = null, recordStarted = 0, stopPromise = null, resolveStop = null;
let toastTimer, databaseReady = false, editorVersion = 0;

function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function active() { return state.entries.filter(e => !e.archived); }
function time(entry) { return new Date(entry.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function tags(entry) { return state.quiet ? '' : '<div class="chips">' + [...entry.people.map(x => '@' + x), ...entry.tags].slice(0, 4).map(x => '<span class="chip">' + escape(x) + '</span>').join('') + '</div>'; }
function section(title, count = '') { return '<div class="section-title"><h2>' + escape(title) + '</h2><span>' + escape(count) + '</span></div>'; }
function empty(title) { return '<div class="empty"><span aria-hidden="true">⌁</span>' + escape(title) + '</div>'; }
function heading(kicker, title, intro) { return '<p class="eyebrow">' + escape(kicker) + '</p><h1>' + escape(title) + '</h1><p class="intro">' + escape(intro) + '</p>'; }
function card(entry) {
  const mood = { good: 'Good', hard: 'Heavy', neutral: 'Okay' }[entry.mood];
  return '<button class="memory-card" data-open="' + escape(entry.id) + '">' +
    '<div class="meta"><span class="mood-dot ' + escape(entry.mood) + '"></span><span>' + mood + '</span><span>·</span><span>' + escape(entry.date === localDay() ? time(entry) : entry.date) + '</span>' +
    (entry.photo ? '<span aria-label="Photo attached">· Photo</span>' : '') + (entry.audio ? '<span aria-label="Voice attached">· Voice</span>' : '') + '</div>' +
    '<h3>' + escape(entry.title) + '</h3>' + (!state.quiet && entry.body ? '<p>' + escape(entry.body) + '</p>' : '') + tags(entry) + '</button>';
}
function capture(type) { return '<button class="capture ' + (type === 'keep' ? 'keep-capture' : '') + '" data-add="' + type + '"><span class="capture-symbol">＋</span><span><strong>' + (type === 'keep' ? 'A little reminder for yourself' : 'What happened today?') + '</strong><small>' + (type === 'keep' ? 'Only what you want to keep close.' : 'A thought, a photo, a voice note. All welcome.') + '</small></span><span class="arrow">↗</span></button>'; }
function renderToday() {
  const entries = active().filter(e => e.type === 'moment' && e.date === localDay());
  const waiting = active().filter(e => e.type === 'keep' && !e.completed).length;
  return heading('ONE DAY AT A TIME', 'A little space for today.', 'You don’t need the whole story. Just the part you want to keep.') + capture('moment') +
    '<div class="content-grid"><section>' + section('Your day, in moments', entries.length ? entries.length + ' saved' : '') + '<div class="cards">' +
    (entries.length ? entries.map(card).join('') : empty('Nothing here yet. Begin whenever you feel like it.')) + '</div></section>' +
    '<aside class="side-card"><p class="eyebrow">A GENTLE REMINDER</p><h3>Some days are<br>just days.</h3><p>They don’t have to be meaningful to be worth remembering.</p><small>No streaks. No catching up.</small>' +
    (waiting ? '<button data-go="keep">' + waiting + (waiting === 1 ? ' thing' : ' things') + ' kept in mind →</button>' : '') + '</aside></div>';
}
function group(entry) { return entry.completed ? 'Handled' : ['Tonight', 'Tomorrow', 'This week'].includes(entry.review) ? entry.review : 'No rush'; }
function renderKeep() {
  const entries = active().filter(e => e.type === 'keep');
  return heading('A SMALL PLACE FOR WHAT MATTERS', 'Keep in mind.', 'A few things to come back to. At a time that feels right for you.') + capture('keep') +
    ['Tonight', 'Tomorrow', 'This week', 'No rush', 'Handled'].map(name => {
      const items = entries.filter(e => group(e) === name);
      if (!items.length) return '';
      return section(name, items.length) + '<div class="cards">' + items.map(e => '<div class="keep-row ' + (e.completed ? 'handled' : '') + '">' + card(e) +
        '<button class="check-button" role="checkbox" aria-checked="' + !!e.completed + '" aria-label="' + escape((e.completed ? 'Reopen ' : 'Mark handled: ') + e.title) + '" data-complete="' + escape(e.id) + '">' + (e.completed ? '✓' : '○') + '</button></div>').join('') + '</div>';
    }).join('') + (!entries.length ? empty('Your short list is clear. There’s no need to fill it.') : '') +
    '<p class="fine">These are personal groups, not deadlines. No reminder notifications are sent.</p>';
}
function renderLibrary() {
  const since = new Date(); since.setDate(since.getDate() - 6);
  const week = active().filter(e => e.date >= localDay(since) && e.date <= localDay()).length;
  return heading('THE THINGS YOU KEPT', 'Your library.', 'Find your way back to a person, a place, or a few familiar words.') +
    '<p class="summary-line">' + week + ' memories from the last seven days. No score attached.</p>' +
    '<label class="fine" for="search">Search memories</label><input id="search" class="search-field" type="search" placeholder="A name, a feeling, a date…" value="' + escape(state.query) + '">' +
    '<div class="filters" role="group" aria-label="Filter memories">' + [['all','All memories'],['good','Good'],['neutral','Okay'],['hard','Heavy'],['archived','Archived']].map(([id,label]) => '<button data-filter="' + id + '" aria-pressed="' + (state.filter === id) + '">' + label + '</button>').join('') + '</div><div id="search-results" class="cards"></div>';
}
function renderResults() {
  const target = $('search-results'); if (!target) return;
  const results = state.entries.filter(e => {
    if (state.filter === 'archived' ? !e.archived : e.archived) return false;
    if (!['all','archived'].includes(state.filter) && e.mood !== state.filter) return false;
    return [e.title,e.body,e.place,e.date,e.mood,...e.tags,...e.people].join(' ').toLowerCase().includes(state.query.trim().toLowerCase());
  });
  target.innerHTML = results.length ? results.map(card).join('') : empty('No matches yet. Try another word.');
}
function renderConnections() {
  const index = new Map();
  for (const entry of active()) {
    for (const item of [...entry.tags, ...entry.people, entry.place].filter(Boolean)) {
      const key = item.trim().toLowerCase();
      if (!index.has(key)) index.set(key, { label: item, entries: [] });
      if (!index.get(key).entries.some(e => e.id === entry.id)) index.get(key).entries.push(entry);
    }
  }
  const links = [...index.values()].filter(g => g.entries.length > 1).sort((a,b) => b.entries.length - a.entries.length);
  return heading('FOLLOW A FAMILIAR THREAD', 'Things connect.', 'Shared names, places, and tags can bring moments together. Explore only when you feel like it.') +
    (links.length ? links.map(g => '<section class="connection"><span class="connection-mark" aria-hidden="true">⌁</span><div><strong>' + escape(g.label) + ' · ' + g.entries.length + ' memories</strong>' +
      g.entries.map(e => '<button data-open="' + escape(e.id) + '">' + escape(e.title) + ' ↗</button>').join('') + '</div></section>').join('') : empty('Add a shared person, place, or tag to two memories to see a connection.'));
}
function render() {
  if (!state.session) return;
  $('main').innerHTML = ({ today: renderToday, keep: renderKeep, library: renderLibrary, maze: renderConnections })[state.page]();
  document.querySelectorAll('[data-page]').forEach(button => {
    if (button.dataset.page === state.page) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  $('quiet').setAttribute('aria-pressed', String(state.quiet));
  $('quiet').textContent = state.quiet ? 'Quiet view on' : 'Quiet view';
  renderResults();
}
function navigate(page) { state.page = ['today','keep','maze','library'].includes(page) ? page : 'today'; render(); window.scrollTo({ top: 0 }); }
async function saveEntries(entries) {
  if (state.saving) throw new Error('Please wait for the previous change to finish.');
  state.saving = true;
  try {
    const encrypted = await seal(entries, state.session);
    await writeVault(encrypted, state.envelope?.data || null);
    state.entries = entries; state.envelope = encrypted;
  } finally { state.saving = false; }
}
function showApp() {
  $('gate').hidden = true; $('shell').hidden = false;
  $('password').value = ''; $('confirm-password').value = '';
  navigate(state.page);
}
async function refreshGate() {
  if (!window.isSecureContext || !crypto.subtle) throw new Error('Open this website using HTTPS, or localhost for a local preview. Encryption and voice recording need a secure connection.');
  state.envelope = await readVault();
  const exists = !!state.envelope;
  $('password-label').textContent = exists ? 'Your vault password' : 'Create a vault password';
  $('password').autocomplete = exists ? 'current-password' : 'new-password';
  $('password').minLength = exists ? 1 : 10;
  $('password').placeholder = exists ? 'Welcome back' : 'At least 10 characters';
  $('confirm-field').hidden = exists;
  $('confirm-password').required = !exists;
  $('unlock-button').textContent = exists ? 'Open my space' : 'Create my space';
  $('gate-note').textContent = exists ? 'This browser has a saved vault.' : 'Already have memories elsewhere? Restore a web backup below.';
  databaseReady = true;
}
$('unlock-form').addEventListener('submit', async event => {
  event.preventDefault(); $('gate-error').textContent = '';
  if (!databaseReady) { $('gate-error').textContent = 'Storage is unavailable. Please reload in a normal browser window using HTTPS.'; return; }
  $('unlock-button').disabled = true;
  try {
    const password = $('password').value;
    if (state.envelope) {
      const unlocked = await unseal(state.envelope, password); state.session = unlocked.session; state.entries = unlocked.entries;
    } else {
      if (password.length < 10 || password !== $('confirm-password').value) throw new Error('Use at least 10 characters and make sure the passwords match.');
      state.session = await newVault(password);
      await saveEntries([]);
    }
    showApp();
  } catch(error) { state.session = null; $('gate-error').textContent = error.message; }
  finally { $('unlock-button').disabled = false; }
});
$('lock').onclick = () => {
  if (state.saving) return;
  document.querySelectorAll('audio').forEach(audio => audio.pause());
  state.session = null; state.entries = []; state.photo = null; state.audio = null; state.selected = null;
  state.query = ''; state.filter = 'all'; state.editing = null; $('main').replaceChildren(); $('detail-content').replaceChildren(); $('draft-attachments').replaceChildren(); $('entry-form').reset();
  $('shell').hidden = true; $('gate').hidden = false; refreshGate().catch(error => $('gate-error').textContent = error.message);
  $('password').focus();
};
$('quiet').onclick = () => { state.quiet = !state.quiet; render(); };
$('settings-open').onclick = () => $('settings').showModal();
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  try {
    if (button.dataset.page) navigate(button.dataset.page);
    if (button.dataset.go) navigate(button.dataset.go);
    if (button.dataset.add) openEditor(button.dataset.add);
    if (button.dataset.open) openDetail(button.dataset.open);
    if (button.dataset.close) $(button.dataset.close).close();
    if (button.dataset.complete) {
      button.disabled = true;
      const old = state.entries.find(e => e.id === button.dataset.complete);
      await saveEntries(state.entries.map(e => e.id === old.id ? { ...e, completed: !e.completed } : e));
      render(); toast(old.completed ? 'Back on your short list.' : 'Handled. A little less to hold.');
    }
    if (button.dataset.edit) { $('detail').close(); openEditor(null, button.dataset.edit); }
    if (button.dataset.archive) {
      const old = state.entries.find(e => e.id === button.dataset.archive);
      await saveEntries(state.entries.map(e => e.id === old.id ? { ...e, archived: !e.archived } : e));
      $('detail').close(); render(); toast(old.archived ? 'Memory restored.' : 'Archived. You can find it in Library.');
    }
    if (button.dataset.delete) {
      if (!confirm('Delete this memory and its attachments from this vault? This cannot be undone. Existing backup files will still contain it.')) return;
      await saveEntries(state.entries.filter(e => e.id !== button.dataset.delete));
      $('detail').close(); render(); toast('Memory deleted.');
    }
    if (button.dataset.filter) { state.filter = button.dataset.filter; render(); }
    if (button.dataset.remove === 'photo') { state.photo = null; renderDraftAttachments(); }
    if (button.dataset.remove === 'audio') { state.audio = null; renderDraftAttachments(); }
  } catch(error) { toast(error.message); }
  finally { button.disabled = false; }
});
document.addEventListener('input', event => { if (event.target.id === 'search') { state.query = event.target.value; renderResults(); } });

function openDetail(id) {
  const entry = state.entries.find(e => e.id === id); if (!entry) return;
  state.selected = id;
  $('detail-content').innerHTML = '<header class="dialog-header"><h2 id="detail-title">A memory</h2><button data-close="detail">Close</button></header><p class="eyebrow">' + (entry.type === 'keep' ? 'KEEP IN MIND' : 'FROM YOUR DAY') + '</p><h1>' + escape(entry.title) + '</h1><p class="fine">' + escape(entry.date) + ' · ' + escape(time(entry)) + (entry.place ? ' · ' + escape(entry.place) : '') + '</p>' +
    (entry.photo ? '<img class="detail-photo" src="' + entry.photo + '" alt="Photo attached to this memory">' : '') + '<p class="detail-body">' + escape(entry.body) + '</p>' +
    (entry.audio ? '<audio controls preload="metadata" src="' + entry.audio + '"></audio>' : '') + tags(entry) +
    (entry.type === 'keep' ? '<p class="fine">Your group: ' + escape(group(entry)) + '</p>' : '') +
    '<div class="detail-actions"><button class="primary" data-edit="' + escape(id) + '">Edit memory</button><button data-archive="' + escape(id) + '">' + (entry.archived ? 'Restore' : 'Archive') + '</button><button class="danger" data-delete="' + escape(id) + '">Delete</button></div>';
  $('detail').showModal();
}
$('detail').addEventListener('close', () => { $('detail-content').querySelectorAll('audio').forEach(a => a.pause()); $('detail-content').replaceChildren(); });

function openEditor(type, id) {
  editorVersion++;
  const entry = state.entries.find(e => e.id === id);
  state.editing = entry?.id || null; state.photo = entry?.photo || null; state.audio = entry?.audio || null;
  $('entry-form').reset(); $('editor-error').textContent = '';
  $('entry-type').value = entry?.type || type || 'moment';
  $('entry-title').value = entry?.title || ''; $('entry-body').value = entry?.body || '';
  $('entry-people').value = (entry?.people || []).join(', '); $('entry-place').value = entry?.place || ''; $('entry-tags').value = (entry?.tags || []).join(', ');
  $('entry-date').value = entry?.date || localDay(); $('entry-review').value = entry?.review || 'No rush';
  document.querySelector('input[name=mood][value="' + (entry?.mood || 'neutral') + '"]').checked = true;
  $('entry-form').querySelector('details').open = false;
  $('editor-heading').textContent = entry ? 'Edit memory' : 'A new memory';
  updateReview(); renderDraftAttachments(); $('editor').showModal();
}
function updateReview() { $('review-field').hidden = $('entry-type').value !== 'keep'; }
$('entry-type').onchange = updateReview;
function renderDraftAttachments() {
  $('draft-attachments').innerHTML = (state.photo ? '<img src="' + state.photo + '" alt="Selected photo"><button type="button" class="text-button" data-remove="photo">Remove photo</button>' : '') +
    (state.audio ? '<audio controls src="' + state.audio + '"></audio><button type="button" class="text-button" data-remove="audio">Remove voice note</button>' : '');
}
async function cancelEditor(event) {
  event?.preventDefault();
  if (state.saving) return;
  if (!confirm('Leave this draft? Unsaved changes will be discarded.')) return;
  await stopRecording().catch(() => {});
  $('editor').close(); $('entry-form').reset(); state.photo = null; state.audio = null; $('draft-attachments').replaceChildren();
}
$('editor-cancel').onclick = cancelEditor;
$('editor').addEventListener('cancel', cancelEditor);
$('editor').addEventListener('close', () => { editorVersion++; $('draft-attachments').querySelectorAll('audio').forEach(a => a.pause()); });
$('entry-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.saving || $('save-entry').disabled) return;
  $('save-entry').disabled = true; $('editor-error').textContent = '';
  try {
    await stopRecording();
    const title = $('entry-title').value.trim(), body = $('entry-body').value.trim();
    if (!title && !body && !state.photo && !state.audio) throw new Error('A few words, a photo, or a voice note is enough. Add one to save.');
    const old = state.entries.find(e => e.id === state.editing);
    const entry = { id: old?.id || crypto.randomUUID(), title: title || (state.audio ? 'A voice memory' : state.photo ? 'A photo memory' : 'A moment from my day'), body,
      type: $('entry-type').value, mood: document.querySelector('input[name=mood]:checked').value, date: $('entry-date').value,
      createdAt: old?.createdAt || Date.now(), people: split($('entry-people').value), place: $('entry-place').value.trim(), tags: split($('entry-tags').value),
      photo: state.photo, audio: state.audio, review: $('entry-review').value, archived: old?.archived || false, completed: old?.completed || false };
    const next = old ? state.entries.map(e => e.id === old.id ? entry : e) : [entry, ...state.entries];
    await saveEntries(next);
    $('editor').close(); state.photo = null; state.audio = null; $('draft-attachments').replaceChildren(); $('entry-form').reset(); render(); toast('Saved. You can leave it here.');
  } catch(error) { $('editor-error').textContent = error.message; }
  finally { $('save-entry').disabled = false; }
});

function blobData(blob) { return new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); }); }
$('photo-add').onclick = () => $('photo-file').click();
$('photo-file').onchange = async () => {
  const file = $('photo-file').files[0]; if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('Choose a photo smaller than 20 MB.');
    const image = new Image(); const url = URL.createObjectURL(file);
    try {
      image.src = url; await image.decode();
      const scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas'); canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      state.photo = canvas.toDataURL('image/jpeg', .78); renderDraftAttachments();
    } finally { URL.revokeObjectURL(url); }
  } catch(error) { $('editor-error').textContent = error.message || 'This photo format is not supported. Try JPEG or PNG.'; }
  finally { $('photo-file').value = ''; }
};
async function stopRecording() {
  if (recorder?.state === 'recording') recorder.stop();
  if (stopPromise) await stopPromise;
}
$('record').onclick = async () => {
  if (recorder?.state === 'recording') { await stopRecording(); return; }
  $('record').disabled = true;
  const version = editorVersion;
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Voice recording needs HTTPS and a supported browser such as Safari or Chrome.');
    if (state.audio && !confirm('Replace the current voice note?')) return;
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!$('editor').open || version !== editorVersion) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; return; }
    const mime = ['audio/mp4','audio/webm','audio/ogg'].find(type => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
    const chunks = []; let bytes = 0;
    stopPromise = new Promise(resolve => resolveStop = resolve);
    recorder.ondataavailable = event => { if (event.data.size) { chunks.push(event.data); bytes += event.data.size; if (bytes > 4 * 1024 * 1024 && recorder.state === 'recording') recorder.stop(); } };
    recorder.onerror = () => { $('editor-error').textContent = 'Recording was interrupted. Please check the saved audio before keeping it.'; if (recorder.state === 'recording') recorder.stop(); };
    recorder.onstop = async () => {
      clearInterval(recordTimer); mediaStream?.getTracks().forEach(t => t.stop()); mediaStream = null;
      try { if (chunks.length) { const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' }); if (blob.size > 5 * 1024 * 1024) throw new Error('The voice note is too large. Try a shorter recording.'); state.audio = await blobData(blob); renderDraftAttachments(); } }
      catch(error) { $('editor-error').textContent = error.message; }
      finally { recorder = null; $('record').textContent = '● Voice note'; $('record').setAttribute('aria-pressed','false'); $('record-status').textContent = ''; const done = resolveStop; stopPromise = null; resolveStop = null; done?.(); }
    };
    recorder.start(1000); recordStarted = Date.now(); $('record').textContent = '■ Stop recording'; $('record').setAttribute('aria-pressed','true');
    recordTimer = setInterval(() => { const seconds = Math.floor((Date.now() - recordStarted) / 1000); $('record-status').textContent = seconds + ' seconds · up to 2 minutes'; if (seconds >= 120 && recorder?.state === 'recording') recorder.stop(); }, 1000);
  } catch(error) { mediaStream?.getTracks().forEach(t => t.stop()); $('editor-error').textContent = error.name === 'NotAllowedError' ? 'Microphone access was not allowed. You can enable it in your browser settings.' : error.message; }
  finally { $('record').disabled = false; }
};
document.addEventListener('visibilitychange', () => { if (document.hidden) { document.querySelectorAll('audio').forEach(a => a.pause()); if (recorder?.state === 'recording') { recorder.stop(); $('editor-error').textContent = 'Recording stopped when you left the page. You can save it when you return.'; } } });
window.addEventListener('beforeunload', event => { if ($('editor').open || state.saving) { event.preventDefault(); event.returnValue = ''; } });

$('backup').onclick = () => {
  if (!state.envelope || state.saving) return;
  const blob = new Blob([JSON.stringify(state.envelope)], { type: 'application/json' }), url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = 'mind-maze-backup-' + localDay() + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); toast('Keep your backup and its password safe.');
};
function openRestore() { if ($('settings').open) $('settings').close(); $('restore-form').reset(); $('restore-error').textContent = ''; $('restore-dialog').showModal(); }
$('restore').onclick = openRestore; $('gate-restore').onclick = openRestore;
$('restore-form').onsubmit = async event => {
  event.preventDefault(); $('restore-error').textContent = ''; $('restore-submit').disabled = true;
  try {
    const file = $('backup-file').files[0]; if (!file || file.size > 48 * 1024 * 1024) throw new Error('Choose a Mind Maze web backup smaller than 48 MB.');
    const envelope = JSON.parse(await file.text()), opened = await unseal(envelope, $('backup-password').value);
    // Verify the entire backup before atomically replacing local storage.
    await writeVault(envelope);
    state.envelope = envelope; state.session = opened.session; state.entries = opened.entries; databaseReady = true;
    $('restore-dialog').close(); $('restore-form').reset(); showApp(); toast('Your memories are back.');
  } catch(error) { $('restore-error').textContent = error.message; }
  finally { $('restore-submit').disabled = false; }
};
$('persist').onclick = async () => { try { const granted = await navigator.storage?.persist?.(); $('storage-status').textContent = granted ? 'The browser granted persistent storage. Keep making backups too.' : 'The browser decides how long to retain data. A downloaded backup is still the best protection.'; } catch { $('storage-status').textContent = 'Storage retention could not be requested. Keep a downloaded backup.'; } };
$('today-date').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
document.querySelector('.brand').onclick = event => { event.preventDefault(); navigate('today'); };
refreshGate().catch(error => { $('gate-error').textContent = error.message; $('unlock-button').disabled = true; });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => {});
