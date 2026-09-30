const DB = 'mind-maze-web';
const ITERATIONS = 600000;
const MAX_BACKUP = 48 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let database;
export const localDay = (d = new Date()) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
export function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(text);
}
function fromBase64(text) {
  if (typeof text !== 'string') throw new Error('Invalid backup data.');
  return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}
async function db() {
  if (database) return database;
  database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('vault');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('This browser could not open storage. Try a normal browser window instead of private browsing.'));
  });
  return database;
}
export async function readVault() {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction('vault').objectStore('vault').get('current');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(new Error('Your saved vault could not be read.'));
  });
}
export async function writeVault(envelope, expectedData) {
  const database = await db();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction('vault', 'readwrite');
    let conflict = false;
    const store = transaction.objectStore('vault');
    const current = store.get('current');
    current.onsuccess = () => {
      if (expectedData !== undefined && (current.result?.data || null) !== expectedData) {
        conflict = true; transaction.abort(); return;
      }
      store.put(envelope, 'current');
    };
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = () => reject(new Error(conflict ? 'Your vault changed in another tab. Copy your draft, then reload and unlock before saving again.' : 'The browser could not save this change. Check available storage and try again. Your previous vault was not replaced.'));
  });
}
async function derive(password, salt) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function newVault(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { key: await derive(password, salt), salt: toBase64(salt) };
}
export function validateEnvelope(envelope) {
  if (!envelope || envelope.format !== 'mind-maze-web' || envelope.version !== 1 || envelope.iterations !== ITERATIONS) throw new Error('This is not a supported Mind Maze web backup.');
  if (fromBase64(envelope.salt).length !== 16 || fromBase64(envelope.iv).length !== 12 || typeof envelope.data !== 'string' || envelope.data.length > MAX_BACKUP) throw new Error('The backup is incomplete or too large.');
}
function validAttachment(value, kind) {
  return value === null || value === undefined || (typeof value === 'string' && value.length <= 8 * 1024 * 1024 && (kind === 'photo' ? /^data:image\/(jpeg|png|webp);base64,[a-z0-9+/=]+$/i : /^data:audio\/(webm|mp4|ogg|wav|mpeg)(;codecs=[a-z0-9.-]+)?;base64,[a-z0-9+/=]+$/i).test(value));
}
export function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 10000) throw new Error('Invalid memory list.');
  const ids = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || ids.has(entry.id) || typeof entry.title !== 'string' || entry.title.length > 160 || typeof entry.body !== 'string' || entry.body.length > 20000 || !['moment', 'keep'].includes(entry.type) || !['good', 'neutral', 'hard'].includes(entry.mood) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !Number.isFinite(entry.createdAt) || typeof entry.place !== 'string' || !Array.isArray(entry.people) || !Array.isArray(entry.tags) || [...entry.people, ...entry.tags].some(v => typeof v !== 'string' || v.length > 500) || !validAttachment(entry.photo, 'photo') || !validAttachment(entry.audio, 'audio')) throw new Error('A memory in this backup is invalid. Your existing vault has not been changed.');
    ids.add(entry.id);
  }
  return entries;
}
export async function seal(entries, session) {
  validateEntries(entries);
  const plain = encoder.encode(JSON.stringify(entries));
  if (plain.length > 30 * 1024 * 1024) throw new Error('This vault has reached its 30 MB limit. Download a backup, then remove unneeded attachments or notes.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, session.key, plain);
  return { format: 'mind-maze-web', version: 1, iterations: ITERATIONS, salt: session.salt, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}
export async function unseal(envelope, password) {
  validateEnvelope(envelope);
  const session = { key: await derive(password, fromBase64(envelope.salt)), salt: envelope.salt };
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv) }, session.key, fromBase64(envelope.data)); }
  catch { throw new Error('The password does not match, or the backup is damaged. Please try again.'); }
  return { session, entries: validateEntries(JSON.parse(decoder.decode(plain))) };
}
