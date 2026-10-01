"use strict";

/* ================= config ================= */

const firebaseConfig = {
  apiKey: "AIzaSyBlDzaHlN948HLDPyXVAg5c83Q782gh0V0",
  authDomain: "temporary-chat-69932.firebaseapp.com",
  projectId: "temporary-chat-69932",
  storageBucket: "temporary-chat-69932.firebasestorage.app",
  messagingSenderId: "404102147038",
  appId: "1:404102147038:web:27225b99398c631ca38b4f",
};
const IMGBB_KEY = "854aafcd13a3db005451430c6620fea1";
// Nothing hosts this app on the web yet, so links built from this are just
// copy-able text. The IDs and QR codes are what actually work inside the app.
const LINK_BASE = "https://example.com/";

const USER_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz"; // 16 chars = permanent user ID
const ROOM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 8 chars = Local Talk server code
const U16 = "[2-9A-HJ-NP-Za-hjkmnp-z]{16}";
const R8 = "[2-9A-HJ-NP-Z]{8}";
const HEARTBEAT_MS = 25000; // Local Talk participant heartbeat AND global presence heartbeat
const STALE_MS = 55000; // beyond this with no heartbeat, treat someone as offline
const RELOCK_MS = 30000; // ask for the App Lock password again after this long in the background
const MAX_IMAGE_BYTES = 32 * 1024 * 1024; // ImgBB's own limit
const LS_PROFILE = "ec2_profile"; // {userId, name, birthday, bio, photoURL, recoverySecret}
const LS_THREADS = "ec2_threads"; // chats + Local Talk rooms known on this device
const LS_HOSTED = "ec2_hosted_rooms"; // Local Talk servers created on this device
const LS_APPLOCK = "ec2_applock"; // {on, hash}
const LS_THEME = "ec2_theme"; // {theme, textColor, font}
const LS_SENT_BYTES = "ec2_sent_bytes"; // running total of image uploads from this device
const SS_UNLOCKED = "ec2_unlocked"; // sessionStorage — survives a pull-to-refresh reload, cleared on full app close

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const FieldValue = firebase.firestore.FieldValue;
const Timestamp = firebase.firestore.Timestamp;

/* ================= helpers ================= */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function randomId(len, alphabet) {
  return Array.from(crypto.getRandomValues(new Uint8Array(len)), (b) => alphabet[b % alphabet.length]).join("");
}
function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function initials(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.length ? parts.map((w) => w[0].toUpperCase()).join("") : "?";
}
/** Fills a plain-div avatar with either a photo (as a background-image) or initials text. */
function renderAvatar(node, name, photoURL) {
  if (!node) return;
  const safe = typeof photoURL === "string" && photoURL.startsWith("https://") ? photoURL : null;
  node.classList.toggle("has-photo", !!safe);
  if (safe) {
    node.style.backgroundImage = `url("${safe}")`;
    node.textContent = "";
  } else {
    node.style.backgroundImage = "";
    node.textContent = initials(name);
  }
}
function fmtTime(ts) {
  const d = ts && ts.toDate ? ts.toDate() : new Date();
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtCountdown(ms) {
  if (ms <= 0) return "Expired";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
function timeLeftLabel(expiresAt) {
  const m = Math.round((expiresAt - Date.now()) / 60000);
  if (m < 60) return `${Math.max(m, 1)}m left`;
  if (m < 1440) return `${Math.round(m / 60)}h left`;
  return `${Math.round(m / 1440)}d left`;
}
/** lastSeen is stored as a plain millisecond number (Date.now()), not a Firestore Timestamp. */
function fmtLastSeen(lastSeenMs) {
  if (!lastSeenMs) return "Offline";
  const mins = Math.max(0, Math.round((Date.now() - lastSeenMs) / 60000));
  if (mins < 1) return "Last seen just now";
  if (mins < 60) return `Last seen ${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Last seen ${hrs}h ago`;
  return `Last seen ${Math.round(hrs / 24)}d ago`;
}
function fmtBytes(n) {
  if (!n) return "0 KB";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand("copy"); } catch {}
  document.body.removeChild(ta);
}
let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2800);
}

/* QR codes are plain <img> tags served by a free QR API (no canvas / JS library needed).
   Only public identifiers are ever encoded — never passwords. */
function setQr(img, data, size) {
  img.onerror = () => toast("The QR image couldn't load — check your connection.");
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(data)}`;
}

/* ---------- ImgBB upload (shared by chat photos and profile pictures) ---------- */

async function uploadToImgbb(file, expirationSeconds) {
  const form = new FormData();
  form.append("image", file);
  if (expirationSeconds) form.append("expiration", String(expirationSeconds));
  const res = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_KEY}`, { method: "POST", body: form });
  const json = await res.json();
  if (!json.success) throw new Error("upload failed");
  return {
    url: json.data.url,
    mime: (json.data.image && json.data.image.mime) || file.type,
    size: Number(json.data.size) || file.size,
  };
}

/* ---------- SHA-256: Web Crypto when available, pure-JS fallback for non-secure WebViews ---------- */

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function sha256Js(bytes) {
  const ror = (x, n) => (x >>> n) | (x << (32 - n));
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 4294967296));
  dv.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i];
      const t2 = (ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, "0")).join("");
}
async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  if (window.crypto && crypto.subtle && crypto.subtle.digest) {
    try {
      const buf = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
    } catch {}
  }
  return sha256Js(bytes);
}

/* ================= Bug fix: pull-to-refresh reloads the app ================= */
/* CSS (overscroll-behavior[-y]: none) does most of the work; this stops the
   gesture at the exact scroll boundary so it never reaches the WebView itself,
   and separately blocks pinch-zoom. */

document.body.style.overscrollBehavior = "none";
let ptrStartY = 0;
document.addEventListener("touchstart", (e) => { ptrStartY = e.touches[0] ? e.touches[0].clientY : 0; }, { passive: true });
document.addEventListener("touchmove", (e) => {
  if (e.touches.length > 1) { e.preventDefault(); return; } // pinch-zoom
  const scroller = e.target.closest(".messages, .pane, .chat-list, .p-list");
  const atTop = !scroller || scroller.scrollTop <= 0;
  if (atTop && e.touches[0].clientY > ptrStartY) e.preventDefault(); // at the top edge, moving down = refresh gesture
}, { passive: false });

/* ================= this device's storage ================= */

function readJson(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch { return fallback; }
}
function getProfile() { return readJson(LS_PROFILE, null); }
function saveProfile(p) { localStorage.setItem(LS_PROFILE, JSON.stringify(p)); }
function patchProfile(patch) { const p = Object.assign({}, getProfile(), patch); saveProfile(p); return p; }
function getThreads() { return readJson(LS_THREADS, []); }
function saveThreads(list) { localStorage.setItem(LS_THREADS, JSON.stringify(list.slice(0, 80))); }
function touchThread(patch) {
  const list = getThreads();
  const idx = list.findIndex((t) => t.id === patch.id);
  const merged = Object.assign({ lastMessage: "" }, idx >= 0 ? list[idx] : {}, patch);
  if (idx >= 0) list[idx] = merged; else list.unshift(merged);
  saveThreads(list);
  if (!$("#screen-messages").classList.contains("hidden")) renderThreadLists();
}
function getHostedRooms() { return readJson(LS_HOSTED, []); }
function addHostedRoom(entry) {
  const list = getHostedRooms().filter((r) => r.id !== entry.id);
  list.unshift(entry);
  localStorage.setItem(LS_HOSTED, JSON.stringify(list.slice(0, 30)));
}
function getSentBytes() { return Number(localStorage.getItem(LS_SENT_BYTES)) || 0; }
function addSentBytes(n) { localStorage.setItem(LS_SENT_BYTES, String(getSentBytes() + (n || 0))); }
function getAppLock() { return readJson(LS_APPLOCK, { on: false, hash: null }); }
function saveAppLock(v) { localStorage.setItem(LS_APPLOCK, JSON.stringify(v)); }

/* ================= live cache of other users (photo + presence) ================= */

const userInfoCache = new Map(); // userId -> {name, bio, photoURL, isOnline, lastSeen}
function getCachedUser(userId) { return userInfoCache.get(userId) || {}; }
function isPresentOnline(info) { return !!(info && info.isOnline && info.lastSeen && Date.now() - info.lastSeen < STALE_MS); }

const listUserSubs = new Map();
/** Keeps a live users/{id} listener for exactly the contacts shown in the current thread list. */
function syncListUserSubs() {
  const ids = new Set(getThreads().filter((t) => t.kind === "convo").map((t) => t.otherUserId));
  for (const id of [...listUserSubs.keys()]) if (!ids.has(id)) { listUserSubs.get(id)(); listUserSubs.delete(id); }
  for (const id of ids) {
    if (listUserSubs.has(id)) continue;
    listUserSubs.set(id, db.collection("users").doc(id).onSnapshot((snap) => {
      userInfoCache.set(id, snap.data() || {});
      if (!$("#screen-messages").classList.contains("hidden")) renderThreadLists();
    }, () => {}));
  }
}
function teardownListUserSubs() { for (const unsub of listUserSubs.values()) unsub(); listUserSubs.clear(); }

const threadUserSubs = new Map();
/** Keeps a live users/{id} listener for exactly the senders visible in the open thread. */
function syncThreadUserSubs() {
  const ids = new Set([...msgCache.values()].map((m) => m.senderUserId).filter(Boolean));
  for (const id of [...threadUserSubs.keys()]) if (!ids.has(id)) { threadUserSubs.get(id)(); threadUserSubs.delete(id); }
  for (const id of ids) {
    if (threadUserSubs.has(id)) continue;
    threadUserSubs.set(id, db.collection("users").doc(id).onSnapshot((snap) => {
      userInfoCache.set(id, snap.data() || {});
      if (thread) renderMessages();
    }, () => {}));
  }
}
function teardownThreadUserSubs() { for (const unsub of threadUserSubs.values()) unsub(); threadUserSubs.clear(); }

/* ================= presence: publish this device's own online/offline status ================= */

let presenceTimer = null;
function setPresence(online) {
  const p = getProfile();
  if (!p || !auth.currentUser) return;
  db.collection("users").doc(p.userId).update({ isOnline: online, lastSeen: Date.now() }).catch(() => {});
}
function startPresence() {
  if (!getProfile()) return;
  setPresence(true);
  clearInterval(presenceTimer);
  presenceTimer = setInterval(() => { if (!document.hidden) setPresence(true); }, HEARTBEAT_MS);
}
document.addEventListener("visibilitychange", () => { if (appStarted) setPresence(!document.hidden); });
window.addEventListener("pagehide", () => setPresence(false));
window.addEventListener("beforeunload", () => setPresence(false));

/* ================= theme ================= */

const THEMES = {
  amoled: { bg: "#000000", surface: "#111111", surface2: "#1c1c1c", surface3: "#262626", line: "#262626", dim: "#a8a8a8", faint: "#6f6f6f", on: "#000000", scheme: "dark" },
  dark: { bg: "#1a1a1a", surface: "#242424", surface2: "#2d2d2d", surface3: "#383838", line: "#383838", dim: "#b0b0b0", faint: "#7a7a7a", on: "#000000", scheme: "dark" },
  light: { bg: "#f4f4f4", surface: "#ffffff", surface2: "#ececec", surface3: "#e2e2e2", line: "#dcdcdc", dim: "#5a5a5a", faint: "#8a8a8a", on: "#ffffff", scheme: "light" },
};
const TEXT_COLORS = {
  white: { dark: "#ffffff", light: "#111111" },
  ivory: { dark: "#f2efe9", light: "#2b2a27" },
  mint: { dark: "#d8f5e6", light: "#12402a" },
  sand: { dark: "#f1e6d0", light: "#43331a" },
};
const FONTS = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  rounded: 'ui-rounded, "Segoe UI Rounded", Verdana, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};
function getThemePrefs() { return Object.assign({ theme: "amoled", textColor: "white", font: "system" }, readJson(LS_THEME, {})); }
function applyTheme(p) {
  const t = THEMES[p.theme] || THEMES.amoled;
  const root = document.documentElement;
  const set = (k, v) => root.style.setProperty(k, v);
  set("--bg", t.bg); set("--surface", t.surface); set("--surface-2", t.surface2); set("--surface-3", t.surface3);
  set("--line", t.line); set("--text-dim", t.dim); set("--text-faint", t.faint); set("--on-accent", t.on);
  set("--text", (TEXT_COLORS[p.textColor] || TEXT_COLORS.white)[t.scheme]);
  set("--font", FONTS[p.font] || FONTS.system);
  root.dataset.theme = t.scheme;
}
function saveThemePrefs(p) { localStorage.setItem(LS_THEME, JSON.stringify(p)); applyTheme(p); }
applyTheme(getThemePrefs());

/* ================= navigation ================= */

const SCREENS = ["onboarding", "messages", "servers", "settings", "thread", "share", "scan", "manage"];
function showScreen(name) { SCREENS.forEach((s) => $("#screen-" + s).classList.toggle("hidden", s !== name)); }
function setActiveTab(tab) { $$(".bottom-nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab)); }
function goTab(tab) {
  if (tab !== "messages") teardownListUserSubs();
  showScreen(tab);
  setActiveTab(tab);
  if (tab === "messages") { renderMessagesHeader(); renderThreadLists(); }
  if (tab === "servers") renderManageList();
  if (tab === "settings") renderSettings();
}
const NAV_ICONS = {
  messages: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l1.8-3.6A8.5 8.5 0 1 1 21 11.5Z"/></svg>',
  servers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
};
function buildNav() {
  const html = [["messages", "Messages"], ["servers", "Servers"], ["settings", "Settings"]]
    .map(([k, label]) => `<button type="button" data-tab="${k}">${NAV_ICONS[k]}<span>${label}</span></button>`).join("");
  $$(".bottom-nav").forEach((n) => (n.innerHTML = html));
}
buildNav();
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) goTab(b.dataset.tab);
});

/* ================= App Lock ================= */

let hiddenAt = 0;
function showLock(onUnlocked) {
  const lock = getAppLock();
  if (!lock.on || !lock.hash || sessionStorage.getItem(SS_UNLOCKED) === "true") { if (onUnlocked) onUnlocked(); return; }
  $("#lock-password").value = "";
  $("#lock-error").textContent = "";
  $("#screen-lock").classList.remove("hidden");
  $("#lock-password").focus();
  $("#form-lock").onsubmit = async (e) => {
    e.preventDefault();
    if ((await sha256Hex($("#lock-password").value)) === lock.hash) {
      try { sessionStorage.setItem(SS_UNLOCKED, "true"); } catch {}
      $("#screen-lock").classList.add("hidden");
      if (onUnlocked) onUnlocked();
    } else {
      $("#lock-error").textContent = "Wrong password.";
      $("#lock-password").value = "";
    }
  };
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  const lock = getAppLock();
  if (lock.on && lock.hash && hiddenAt && Date.now() - hiddenAt > RELOCK_MS && $("#screen-lock").classList.contains("hidden")) {
    try { sessionStorage.removeItem(SS_UNLOCKED); } catch {} // closes the reload-during-relock gap
    showLock();
  }
  hiddenAt = 0;
});

/* ================= account: onboarding, restore, identity sync ================= */

function ensureSignedIn() {
  if (auth.currentUser) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let unsub = null;
    unsub = auth.onAuthStateChanged((u) => { if (u) { if (unsub) unsub(); resolve(); } });
    auth.signInAnonymously().catch(reject);
  });
}

$("#ob-birthday").max = todayStr();
$("#set-birthday").max = todayStr();

$("#form-onboarding").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#ob-name").value.trim();
  const birthday = $("#ob-birthday").value;
  const lockPw = $("#ob-lock-password").value;
  if (!name || !birthday) return toast("Name and birthday are both required.");
  if (lockPw && lockPw.length < 4) return toast("Use an App Lock password of at least 4 characters, or leave it blank.");
  const btn = $("#ob-submit");
  btn.disabled = true;
  try {
    await ensureSignedIn();
    const userId = randomId(16, USER_ALPHABET);
    const recoverySecret = randomHex(24);
    const ownerHash = await sha256Hex(recoverySecret);
    const uref = db.collection("users").doc(userId);
    await uref.set({ name, bio: "", createdAt: FieldValue.serverTimestamp(), authUid: auth.currentUser.uid });
    await uref.collection("private").doc("profile").set({ birthday });
    await uref.collection("secret").doc("config").set({ ownerHash });
    saveProfile({ userId, name, birthday, bio: "", photoURL: null, recoverySecret });
    if (lockPw) saveAppLock({ on: true, hash: await sha256Hex(lockPw) });
    enterApp();
  } catch {
    toast("Could not create your account — check your connection and try again.");
    btn.disabled = false;
  }
});

/** Claim an existing identity on this device using a backup code (proves knowledge of the recovery secret). */
async function restoreFromBackup(raw) {
  const blob = JSON.parse(decodeURIComponent(escape(atob(raw.trim()))));
  if (!blob || !blob.userId || !blob.recoverySecret) throw new Error("bad backup");
  await ensureSignedIn();
  const recoveryProof = await sha256Hex(blob.recoverySecret);
  await db.collection("users").doc(blob.userId).update({ authUid: auth.currentUser.uid, recoveryProof });
  saveProfile({ userId: blob.userId, name: blob.name || "", birthday: blob.birthday || "", bio: blob.bio || "", photoURL: blob.photoURL || null, recoverySecret: blob.recoverySecret });
  if (blob.theme) localStorage.setItem(LS_THEME, JSON.stringify(blob.theme));
  if (blob.applock) saveAppLock(blob.applock);
}
async function runRestore(text) {
  if (!text.trim()) return toast("Paste your backup code first.");
  try {
    await restoreFromBackup(text);
    toast("Account restored");
    location.reload();
  } catch {
    toast("That backup code didn't work.");
  }
}
$("#ob-show-restore").addEventListener("click", () => $("#form-ob-restore").classList.toggle("hidden"));
$("#form-ob-restore").addEventListener("submit", (e) => { e.preventDefault(); runRestore($("#ob-restore-text").value); });
$("#form-import-backup").addEventListener("submit", (e) => { e.preventDefault(); runRestore($("#backup-import-text").value); });

/** If this device's anonymous session changed but the profile survived, re-claim the identity. */
async function syncIdentity() {
  const p = getProfile();
  if (!p || !auth.currentUser) return;
  try {
    const ref = db.collection("users").doc(p.userId);
    const snap = await ref.get();
    if (snap.exists && snap.data().authUid !== auth.currentUser.uid && p.recoverySecret) {
      await ref.update({ authUid: auth.currentUser.uid, recoveryProof: await sha256Hex(p.recoverySecret) });
    }
    if (snap.exists && snap.data().photoURL && snap.data().photoURL !== p.photoURL) patchProfile({ photoURL: snap.data().photoURL });
  } catch {}
}

/* ================= Messages tab ================= */

function renderMessagesHeader() {
  const p = getProfile();
  $("#my-id-text").textContent = p ? p.userId : "";
  renderAvatar($("#my-avatar"), p ? p.name : "", p ? p.photoURL : null);
}
$("#my-avatar").addEventListener("click", () => goTab("settings"));
$("#my-id-text").addEventListener("click", () => { const p = getProfile(); if (p) { copyToClipboard(p.userId); toast("ID copied"); } });

let msgsSubTab = "live";
$$(".subtabs [data-sub]").forEach((b) => b.addEventListener("click", () => setMsgsSubTab(b.dataset.sub)));
function setMsgsSubTab(tab) {
  msgsSubTab = tab;
  $$(".subtabs [data-sub]").forEach((b) => b.classList.toggle("active", b.dataset.sub === tab));
  renderThreadLists();
}

function renderThreadLists() {
  syncListUserSubs();
  const all = getThreads();
  const now = Date.now();
  const live = all.filter((t) => t.kind === "convo" || (t.kind === "room" && (t.expiresAt || 0) > now));
  const past = all.filter((t) => t.kind === "room" && (t.expiresAt || 0) <= now);
  const showLive = msgsSubTab === "live";
  const list = showLive ? live : past;
  const wrap = $("#thread-list");
  wrap.innerHTML = "";
  $("#thread-empty").classList.toggle("hidden", list.length > 0);
  $("#thread-empty").textContent = showLive
    ? "No live chats yet. Tap + to add someone by ID or join a server."
    : "No past rooms yet. Servers you joined appear here after they expire.";
  for (const t of list) {
    const info = t.kind === "convo" ? getCachedUser(t.otherUserId) : {};
    const online = t.kind === "convo" && isPresentOnline(info);
    const li = el("li");
    const btn = el("button", "chat-row");
    btn.type = "button";
    const wrap2 = el("div", "avatar-wrap");
    const av = el("div", "avatar");
    renderAvatar(av, t.kind === "convo" ? (info.name || t.name) : t.name, t.kind === "convo" ? info.photoURL : null);
    wrap2.appendChild(av);
    if (t.kind === "convo") wrap2.appendChild(el("span", "status-dot" + (online ? " online" : "")));
    const meta = el("div", "meta");
    const l1 = el("div", "line1");
    let timeLabel;
    if (t.kind === "room") timeLabel = showLive ? timeLeftLabel(t.expiresAt) : "expired";
    else timeLabel = online ? "online" : (info.lastSeen ? fmtLastSeen(info.lastSeen) : "");
    l1.append(el("span", "rname", t.name), el("span", "time", timeLabel));
    // History shows only the Room ID — never any old messages.
    const preview = showLive ? (t.lastMessage || (t.kind === "convo" ? "Tap to open" : "Local Talk server")) : `Room ID: ${t.id}`;
    meta.append(l1, el("div", "preview", preview));
    btn.append(wrap2, meta);
    btn.addEventListener("click", () => (showLive ? openThreadFromList(t) : toast("This room has expired — its messages are gone.")));
    li.appendChild(btn);
    wrap.appendChild(li);
  }
}
async function openThreadFromList(t) {
  if (t.kind === "convo") return openConvo(t.otherUserId, t.name);
  try {
    const r = await enterRoom(t.id, { name: getProfile().name });
    if (r.ok) return openRoom(r.code, r.room);
    if (r.reason === "expired") { touchThread({ id: t.id, expiresAt: 0 }); return toast("This server has expired."); }
  } catch {}
  toast("Could not reopen this server.");
}

/* -- floating (+) button -- */

$("#fab").addEventListener("click", () => $("#fab-menu").classList.remove("hidden"));
$("#fab-back").addEventListener("click", () => $("#fab-menu").classList.add("hidden"));
$("#fab-my-id").addEventListener("click", () => { $("#fab-menu").classList.add("hidden"); openShareScreen("messages"); });
$("#fab-scan").addEventListener("click", () => { $("#fab-menu").classList.add("hidden"); openScanScreen(); });

/* -- My User ID (share) -- */

function openShareScreen(backTo) {
  const p = getProfile();
  $("#share-id-text").textContent = p.userId;
  $("#share-link-text").textContent = `${LINK_BASE}invite/${p.userId}`;
  setQr($("#share-qr"), "ECID:" + p.userId, 220);
  $("#screen-share").dataset.back = backTo || "messages";
  showScreen("share");
}
$("#share-back").addEventListener("click", () => goTab($("#screen-share").dataset.back || "messages"));
$("#btn-copy-id").addEventListener("click", () => { copyToClipboard(getProfile().userId); toast("ID copied"); });
$("#btn-copy-link").addEventListener("click", () => { copyToClipboard($("#share-link-text").textContent); toast("Invite link copied"); });

/* -- QR scan / manual add -- */

let scanner = null, joinPending = null;

/** Understands ECID:/ECROOM: QR payloads, pasted invite links, and bare IDs / codes. */
function parseTarget(raw) {
  const t = (raw || "").trim();
  let m;
  if ((m = new RegExp("^ECID:(" + U16 + ")$").exec(t)) || (m = new RegExp("/invite/(" + U16 + ")/?$").exec(t)) || (m = new RegExp("^(" + U16 + ")$").exec(t))) {
    return { type: "user", id: m[1] };
  }
  const up = t.toUpperCase();
  if ((m = new RegExp("^ECROOM:(" + R8 + ")$").exec(up)) || (m = new RegExp("/ROOM/(" + R8 + ")/?$").exec(up)) || (m = new RegExp("^(" + R8 + ")$").exec(up))) {
    return { type: "room", code: m[1] };
  }
  return null;
}

function openScanScreen() {
  $("#scan-manual-id").value = "";
  $("#scan-status").textContent = "";
  $("#form-join-room").classList.add("hidden");
  $("#scan-reader-wrap").classList.remove("hidden");
  joinPending = null;
  showScreen("scan");
  startScanner();
}
$("#scan-back").addEventListener("click", () => { stopScanner(); goTab("messages"); });
$("#form-scan-manual").addEventListener("submit", (e) => {
  e.preventDefault();
  const target = parseTarget($("#scan-manual-id").value);
  if (!target) return toast("That isn't a valid user ID or server code.");
  handleTarget(target);
});

/** Bug fix: explicitly probe for camera permission before touching the scanner library,
    so a denial is reported clearly instead of the scanner just silently not opening. */
async function requestCameraPermission() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return { ok: false, reason: "unsupported" };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((t) => t.stop()); // just probing — html5-qrcode opens its own stream next
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err && err.name === "NotAllowedError" ? "denied" : "error" };
  }
}
async function startScanner() {
  stopScanner();
  const status = $("#scan-status");
  if (typeof Html5Qrcode === "undefined") { status.textContent = "The camera scanner didn't load — type the ID or code below instead."; return; }
  status.textContent = "Requesting camera permission…";
  const perm = await requestCameraPermission();
  if (!perm.ok) {
    status.textContent = perm.reason === "denied"
      ? "Camera permission is required to scan QR codes."
      : "Camera access isn't available in this app view — type the ID or code below instead.";
    return;
  }
  const qr = new Html5Qrcode("qr-reader");
  scanner = qr;
  const cfg = { fps: 10, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } };
  status.textContent = "Starting camera…";
  try {
    try {
      await qr.start({ facingMode: "environment" }, cfg, onScanText, () => {});
    } catch {
      const cams = await Html5Qrcode.getCameras();
      if (!cams || !cams.length) throw new Error("no camera");
      const cam = cams.find((c) => /back|rear|environment/i.test(c.label || "")) || cams[cams.length - 1];
      await qr.start(cam.id, cfg, onScanText, () => {});
    }
    if (scanner === qr) status.textContent = "Point the camera at a QR code.";
  } catch {
    if (scanner === qr) status.textContent = "Couldn't open the camera — type the ID or code below instead.";
  }
}
function stopScanner() {
  const s = scanner;
  scanner = null;
  if (!s) return;
  s.stop().then(() => s.clear()).catch(() => { try { s.clear(); } catch {} });
}
function onScanText(text) {
  const target = parseTarget(text);
  if (!target) { $("#scan-status").textContent = "That QR code isn't for this app."; return; }
  handleTarget(target);
}
function handleTarget(target) {
  stopScanner();
  if (target.type === "user") addContactById(target.id); else startRoomJoin(target.code);
}

async function addContactById(userId) {
  const me = getProfile();
  const status = $("#scan-status");
  if (userId === me.userId) { status.textContent = "That's your own ID."; return; }
  status.textContent = "Looking up user…";
  try {
    await ensureSignedIn();
    const snap = await db.collection("users").doc(userId).get();
    if (!snap.exists) { status.textContent = "No user with that ID."; return; }
    await openConvo(userId, snap.data().name || "Unknown");
  } catch {
    status.textContent = "Could not look up that ID. Check your connection.";
  }
}

async function startRoomJoin(code) {
  const status = $("#scan-status");
  status.textContent = "Looking up server…";
  try {
    await ensureSignedIn();
    const snap = await db.collection("rooms").doc(code).get();
    if (!snap.exists) { status.textContent = "No server with that code."; return; }
    const room = snap.data();
    if (room.expiresAt.toMillis() <= Date.now()) { status.textContent = "That server has expired."; return; }
    const again = await enterRoom(code, { name: getProfile().name }); // already a member? no password needed
    if (again.ok) return openRoom(code, again.room);
    joinPending = { code, room };
    $("#join-room-info").textContent = room.name + (room.description ? " — " + room.description : "");
    $("#join-room-password").value = "";
    $("#form-join-room").classList.remove("hidden");
    $("#scan-reader-wrap").classList.add("hidden");
    status.textContent = "Enter the server password to join.";
  } catch {
    status.textContent = "Could not look up that server. Check your connection.";
  }
}
$("#form-join-room").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!joinPending) return;
  try {
    const r = await enterRoom(joinPending.code, { name: getProfile().name, password: $("#join-room-password").value });
    if (r.ok) return openRoom(r.code, r.room);
    toast(r.reason === "bad_password" ? "Wrong password." : "Could not join that server.");
  } catch {
    toast("Could not join that server. Check your connection.");
  }
});

/* ================= permanent conversations ================= */

function convoIdFor(a, b) { return [a, b].sort().join("_"); }

async function openConvo(otherUserId, otherName) {
  const me = getProfile();
  const convoId = convoIdFor(me.userId, otherUserId);
  const ref = db.collection("conversations").doc(convoId);
  try {
    await ensureSignedIn();
    const u = await db.collection("users").doc(otherUserId).get();
    if (u.exists && u.data().name) otherName = u.data().name;
    if (u.exists) userInfoCache.set(otherUserId, u.data());
    const snap = await ref.get();
    if (!snap.exists) await ref.set({ members: [me.userId, otherUserId].sort(), createdAt: FieldValue.serverTimestamp() });
    notifyInbox(otherUserId);
  } catch {
    return toast("Could not open that chat. Check your connection.");
  }
  touchThread({ id: convoId, kind: "convo", name: otherName, otherUserId });
  openThread({ ref, kind: "convo", title: otherName, expiresAtMs: null, canManage: false, threadId: convoId });
}

/** Leave a note in the other person's inbox so the chat shows up on their side too. */
function notifyInbox(otherUserId) {
  const me = getProfile();
  db.collection("users").doc(otherUserId).collection("inbox").doc(me.userId)
    .set({ fromName: me.name, createdAt: FieldValue.serverTimestamp() }).catch(() => {});
}
let inboxUnsub = null;
function startInbox() {
  const me = getProfile();
  if (!me || !auth.currentUser) return;
  if (inboxUnsub) inboxUnsub();
  inboxUnsub = db.collection("users").doc(me.userId).collection("inbox").onSnapshot((qs) => {
    qs.docChanges().forEach((ch) => {
      if (ch.type === "removed") return;
      const fromId = ch.doc.id;
      const convoId = convoIdFor(me.userId, fromId);
      const name = ch.doc.data().fromName || "New chat";
      if (!getThreads().some((t) => t.id === convoId)) {
        touchThread({ id: convoId, kind: "convo", name, otherUserId: fromId });
        toast(`New chat: ${name}`);
      }
      ch.doc.ref.delete().catch(() => {}); // processed
    });
  }, () => {});
}

/* ================= Servers tab ================= */

$$(".servers-subtabs [data-sub]").forEach((b) => b.addEventListener("click", () => {
  $$(".servers-subtabs [data-sub]").forEach((x) => x.classList.toggle("active", x === b));
  $$("#screen-servers .subpane").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== b.dataset.sub));
}));
$$(".lt-subtabs [data-ltsub]").forEach((b) => b.addEventListener("click", () => {
  $$(".lt-subtabs [data-ltsub]").forEach((x) => x.classList.toggle("active", x === b));
  $$("#pane-local .lt-subpane").forEach((p) => p.classList.toggle("hidden", p.dataset.ltpane !== b.dataset.ltsub));
  if (b.dataset.ltsub === "manage") renderManageList();
}));
$("#btn-server-share").addEventListener("click", () => openShareScreen("servers"));

$("#lt-hours-days").addEventListener("change", () => { $("#lt-duration").max = $("#lt-hours-days").value === "days" ? 30 : 720; });
$("#form-lt-create").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#lt-name").value.trim();
  const description = $("#lt-description").value.trim();
  const password = $("#lt-password").value;
  const amount = Number($("#lt-duration").value);
  const unit = $("#lt-hours-days").value;
  const minutes = unit === "days" ? amount * 1440 : amount * 60;
  if (!name || password.length < 4) return toast("Give the server a name and a password of at least 4 characters.");
  if (!(amount > 0) || minutes > 30 * 1440) return toast("Pick an expiry between 1 hour and 30 days.");
  try {
    const { code, expiresAtMs } = await createLocalTalkRoom({ name, description, minutes, password });
    const r = await enterRoom(code, { name: getProfile().name, password });
    if (!r.ok) throw new Error("join failed");
    touchThread({ id: code, kind: "room", name, expiresAt: expiresAtMs });
    $("#form-lt-create").reset();
    toast("Server created");
    openManageDashboard({ id: code, name }, "servers");
  } catch (err) {
    toast(err && err.message && err.message.length < 90 ? err.message : "Could not create the server.");
  }
});

function renderManageList() {
  const wrap = $("#manage-room-list");
  wrap.innerHTML = "";
  const rooms = getHostedRooms();
  $("#manage-empty").classList.toggle("hidden", rooms.length > 0);
  for (const r of rooms) {
    const li = el("li");
    const btn = el("button", "chat-row");
    btn.type = "button";
    const meta = el("div", "meta");
    meta.append(el("div", "rname", r.name), el("div", "preview", r.expiresAt > Date.now() ? timeLeftLabel(r.expiresAt) : "expired"));
    const av = el("div", "avatar");
    renderAvatar(av, r.name, null);
    btn.append(av, meta);
    btn.addEventListener("click", () => openManageDashboard(r, "servers"));
    li.appendChild(btn);
    wrap.appendChild(li);
  }
}

/* ---------- Local Talk rooms ---------- */

async function createLocalTalkRoom({ name, description, minutes, password }) {
  await ensureSignedIn();
  const expiresAt = Timestamp.fromMillis(Date.now() + minutes * 60000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomId(8, ROOM_ALPHABET);
    const ref = db.collection("rooms").doc(code);
    const saltHex = randomHex(16);
    const hashHex = await sha256Hex(saltHex + ":" + password);
    try {
      await ref.set({ name, description, hostUid: auth.currentUser.uid, createdAt: FieldValue.serverTimestamp(), expiresAt, saltHex });
    } catch (err) {
      if (err.code === "permission-denied") continue; // code collision — try another
      throw err;
    }
    try { await ref.collection("secret").doc("config").set({ hashHex, expiresAt }); }
    catch { throw new Error("Could not finish setting the password. Try again."); }
    addHostedRoom({ id: code, name, expiresAt: expiresAt.toMillis() });
    return { code, expiresAtMs: expiresAt.toMillis() };
  }
  throw new Error("Could not create the server right now. Try again.");
}

/** {ok:true, code, room} or {ok:false, reason:'not_found'|'expired'|'need_password'|'bad_password'} */
async function enterRoom(code, { name, password } = {}) {
  await ensureSignedIn();
  const ref = db.collection("rooms").doc(code);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, reason: "not_found" };
  const room = snap.data();
  if (room.expiresAt.toMillis() <= Date.now()) return { ok: false, reason: "expired", room };
  const pRef = ref.collection("participants").doc(auth.currentUser.uid);
  const already = await pRef.get();
  if (already.exists) {
    await pRef.update({ lastActive: FieldValue.serverTimestamp(), name: name || already.data().name }).catch(() => {});
    return { ok: true, code, room };
  }
  if (password == null) return { ok: false, reason: "need_password", room };
  const hashHex = await sha256Hex(room.saltHex + ":" + password);
  try {
    await pRef.set({ name, hashHex, joinedAt: FieldValue.serverTimestamp(), lastActive: FieldValue.serverTimestamp(), expiresAt: room.expiresAt });
  } catch (err) {
    if (err.code === "permission-denied") return { ok: false, reason: "bad_password", room };
    throw err;
  }
  return { ok: true, code, room };
}
function openRoom(code, room) {
  const expiresAtMs = room.expiresAt.toMillis ? room.expiresAt.toMillis() : room.expiresAt;
  touchThread({ id: code, kind: "room", name: room.name || code, expiresAt: expiresAtMs });
  openThread({
    ref: db.collection("rooms").doc(code), kind: "room", title: room.name || code, expiresAtMs,
    canManage: room.hostUid === auth.currentUser.uid, threadId: code,
  });
}

/* ---------- Manage dashboard (host only) ---------- */

let manageUnsub = null, manageTimer = null, manageRoom = null, manageBackTo = "servers";
const manageParticipants = new Map();
function isOnlineParticipant(p) { return !!(p.lastActive && Date.now() - p.lastActive.toMillis() < STALE_MS); }

function openManageDashboard(r, backTo) {
  closeManage();
  manageRoom = r;
  manageBackTo = backTo || "servers";
  manageParticipants.clear();
  $("#manage-title").textContent = r.name;
  $("#manage-code").textContent = r.id;
  $("#manage-desc").textContent = "";
  setQr($("#manage-qr"), "ECROOM:" + r.id, 200);
  renderManageParticipants();
  showScreen("manage");
  const ref = db.collection("rooms").doc(r.id);
  ref.get().then((s) => { if (s.exists && manageRoom === r) $("#manage-desc").textContent = s.data().description || ""; }).catch(() => {});
  manageUnsub = ref.collection("participants").onSnapshot((qs) => {
    manageParticipants.clear();
    qs.forEach((d) => manageParticipants.set(d.id, d.data()));
    renderManageParticipants();
  }, () => {
    const list = $("#manage-participants");
    list.innerHTML = "";
    list.appendChild(el("li", "p-row", "Could not load participants (the server may have expired)."));
  });
  manageTimer = setInterval(renderManageParticipants, 5000);
}
function renderManageParticipants() {
  const list = $("#manage-participants");
  list.innerHTML = "";
  const rows = [...manageParticipants.values()].sort((a, b) => (a.joinedAt ? a.joinedAt.toMillis() : 0) - (b.joinedAt ? b.joinedAt.toMillis() : 0));
  $("#manage-count").textContent = `Inside now: ${rows.filter(isOnlineParticipant).length} online · ${rows.length} joined`;
  if (!rows.length) { list.appendChild(el("li", "p-row", "No one has joined yet.")); return; }
  for (const p of rows) {
    const li = el("li", "p-row");
    li.append(el("span", "status" + (isOnlineParticipant(p) ? " on" : "")), el("span", "pname", p.name || "Anonymous"));
    list.appendChild(li);
  }
}
function closeManage() {
  if (manageUnsub) manageUnsub();
  manageUnsub = null;
  clearInterval(manageTimer);
  manageRoom = null;
}
$("#manage-back").addEventListener("click", () => {
  const back = manageBackTo;
  closeManage();
  if (back === "thread" && thread) showScreen("thread"); else goTab(back === "thread" ? "servers" : back);
});
$("#btn-copy-room").addEventListener("click", () => { if (manageRoom) { copyToClipboard(manageRoom.id); toast("Server code copied"); } });
$("#btn-open-room").addEventListener("click", () => {
  const r = manageRoom;
  if (!r) return;
  const back = manageBackTo;
  closeManage();
  if (back === "thread" && thread) return showScreen("thread");
  openThreadFromList({ kind: "room", id: r.id, name: r.name });
});

/* ================= chat engine (Local Talk servers + permanent conversations) ================= */

let thread = null; // {ref, kind:'room'|'convo', title, expiresAtMs|null, canManage, threadId}
let unsubMessages = null, heartbeatTimer = null, countdownTimer = null;
const msgCache = new Map();
let replyTarget = null, editTarget = null;

function openThread(t) {
  closeThread();
  thread = t;
  $("#thread-title").textContent = t.title;
  $("#thread-manage-btn").classList.toggle("hidden", !t.canManage);
  $("#btn-participants").classList.toggle("hidden", t.kind !== "room");
  $("#thread-leave").classList.toggle("hidden", t.kind !== "room");
  $("#thread-countdown").classList.toggle("hidden", t.expiresAtMs == null);
  $("#thread-messages").innerHTML = "";
  msgCache.clear();
  showScreen("thread");
  unsubMessages = t.ref.collection("messages").orderBy("createdAt").limit(300).onSnapshot((qs) => {
    msgCache.clear();
    qs.forEach((d) => msgCache.set(d.id, d.data()));
    renderMessages();
    const arr = [...msgCache.values()];
    if (arr.length) touchThread({ id: t.threadId, lastMessage: previewOf(arr[arr.length - 1]) });
  }, () => toast("Could not load messages."));
  if (t.kind === "room") {
    heartbeat();
    heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
    countdownTimer = setInterval(tick, 1000);
    tick();
  }
}
function previewOf(m) { return m.kind === "image" ? `${m.senderName}: 📷 Photo` : `${m.senderName}: ${(m.text || "").slice(0, 60)}`; }
async function heartbeat() {
  if (!thread || thread.kind !== "room" || !auth.currentUser) return;
  try { await thread.ref.collection("participants").doc(auth.currentUser.uid).update({ lastActive: FieldValue.serverTimestamp() }); } catch {}
}
function tick() {
  if (!thread || thread.expiresAtMs == null) return;
  const left = thread.expiresAtMs - Date.now();
  const c = $("#thread-countdown");
  c.textContent = fmtCountdown(left);
  c.classList.toggle("low", left > 0 && left < 60000);
  if (left <= 0) handleExpired();
}
function handleExpired() {
  $("#thread-expired").classList.remove("hidden");
  $$("#form-thread-send input, #form-thread-send textarea, #form-thread-send button").forEach((x) => (x.disabled = true));
  clearInterval(heartbeatTimer);
  clearInterval(countdownTimer);
}
function closeThread() {
  if (unsubMessages) unsubMessages();
  unsubMessages = null;
  teardownThreadUserSubs();
  clearInterval(heartbeatTimer);
  clearInterval(countdownTimer);
  $("#thread-expired").classList.add("hidden");
  $$("#form-thread-send input, #form-thread-send textarea, #form-thread-send button").forEach((x) => (x.disabled = false));
  $("#btn-thread-send").disabled = true;
  replyTarget = null;
  editTarget = null;
  hideComposerBanner();
  $("#thread-drawer").classList.add("drawer-hidden");
  thread = null;
}
$("#thread-back").addEventListener("click", () => { closeThread(); goTab("messages"); });
$("#thread-leave").addEventListener("click", async () => {
  const t = thread;
  closeThread();
  goTab("messages");
  if (t && t.kind === "room" && auth.currentUser) { try { await t.ref.collection("participants").doc(auth.currentUser.uid).delete(); } catch {} }
});
$("#thread-manage-btn").addEventListener("click", () => {
  if (thread && thread.canManage) openManageDashboard({ id: thread.threadId, name: thread.title }, "thread");
});

/* -- messages -- */

function isNearBottom(node) { return node.scrollHeight - node.scrollTop - node.clientHeight < 80; }
function renderMessages() {
  syncThreadUserSubs();
  const wrap = $("#thread-messages");
  const nearBottom = isNearBottom(wrap);
  const prevScrollTop = wrap.scrollTop;
  wrap.innerHTML = "";
  let lastSender = null, lastMs = 0;
  for (const [id, m] of msgCache) {
    const ms = m.createdAt ? m.createdAt.toMillis() : Date.now();
    const grouped = m.senderUid === lastSender && ms - lastMs < 5 * 60000 && !m.replyTo;
    wrap.appendChild(buildMsgRow(id, m, grouped));
    lastSender = m.senderUid;
    lastMs = ms;
  }
  updatePinnedBanner();
  wrap.scrollTop = nearBottom ? wrap.scrollHeight : prevScrollTop;
}
function buildMsgRow(id, m, grouped) {
  const row = el("div", "msg-row" + (grouped ? " grouped" : ""));
  const slot = el("div", "avatar-slot");
  const avSm = el("div", "avatar-sm");
  const info = m.senderUserId ? getCachedUser(m.senderUserId) : {};
  renderAvatar(avSm, m.senderName, info.photoURL);
  slot.appendChild(avSm);
  row.appendChild(slot);
  const body = el("div", "msg-body");
  if (!grouped) {
    const head = el("div", "msg-head");
    head.appendChild(el("span", "sender", m.senderName || "Anonymous"));
    if (m.senderUserId) head.appendChild(el("span", "status-dot" + (isPresentOnline(info) ? " online" : "")));
    head.appendChild(el("span", "time", fmtTime(m.createdAt)));
    body.appendChild(head);
  }
  if (m.pinned) body.appendChild(el("div", "pin-flag", "📌 Pinned"));
  if (m.replyTo) body.appendChild(el("div", "reply-quote", `↩ ${m.replyTo.sender}: ${m.replyTo.snippet}`));
  if (m.kind === "image" && typeof m.imageUrl === "string" && m.imageUrl.startsWith("https://")) {
    const img = el("img", "msg-image");
    img.src = m.imageUrl;
    img.loading = "lazy";
    img.alt = "Shared photo";
    body.appendChild(img);
  } else if (m.text) {
    body.appendChild(el("div", "msg-text" + (m.edited ? " edited" : ""), m.text));
  }
  const reactions = m.reactions || {};
  const keys = Object.keys(reactions).filter((k) => (reactions[k] || []).length);
  if (keys.length) {
    const rrow = el("div", "reactions-row");
    for (const emoji of keys) {
      const arr = reactions[emoji];
      const pill = el("button", "reaction-pill" + (auth.currentUser && arr.includes(auth.currentUser.uid) ? " mine" : ""), `${emoji} ${arr.length}`);
      pill.type = "button";
      pill.addEventListener("click", () => toggleReaction(id, emoji));
      rrow.appendChild(pill);
    }
    body.appendChild(rrow);
  }
  row.appendChild(body);
  attachPressHandlers(row, id);
  return row;
}
function updatePinnedBanner() {
  let latest = null;
  for (const [, m] of msgCache) if (m.pinned) latest = m;
  const banner = $("#pinned-banner");
  if (!latest) return banner.classList.add("hidden");
  banner.classList.remove("hidden");
  $("#pinned-text").textContent = `${latest.senderName}: ${(latest.text || "Photo").slice(0, 60)}`;
}
async function toggleReaction(msgId, emoji) {
  const m = msgCache.get(msgId);
  if (!m || !auth.currentUser || !thread) return;
  const uid = auth.currentUser.uid;
  const mine = ((m.reactions && m.reactions[emoji]) || []).includes(uid);
  try {
    await thread.ref.collection("messages").doc(msgId).update({
      [`reactions.${emoji}`]: mine ? FieldValue.arrayRemove(uid) : FieldValue.arrayUnion(uid),
    });
  } catch { toast("Could not react."); }
}

/* -- long-press menu: reactions + reply / edit / pin / copy link / delete -- */

let pressTimer = null;
function attachPressHandlers(row, msgId) {
  const start = () => { pressTimer = setTimeout(() => { openMsgMenu(msgId); pressTimer = null; }, 450); };
  const cancel = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
  row.addEventListener("touchstart", start, { passive: true });
  row.addEventListener("touchend", cancel);
  row.addEventListener("touchmove", cancel);
  row.addEventListener("touchcancel", cancel);
  row.addEventListener("mousedown", start);
  row.addEventListener("mouseup", cancel);
  row.addEventListener("mouseleave", cancel);
  row.addEventListener("contextmenu", (e) => { e.preventDefault(); openMsgMenu(msgId); });
}
const ICON = {
  reply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17 4 12l5-5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.8 5.6H19l-4.6 3.3L16 17l-4-3-4 3 1.6-6.1L5 7.6h5.2Z"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};
let currentMenuMsg = null, menuConfirmDelete = false;
function openMsgMenu(msgId) {
  if (!msgCache.has(msgId)) return;
  currentMenuMsg = msgId;
  menuConfirmDelete = false;
  renderMenuActions();
  $("#menu-wrap").classList.remove("hidden");
}
function closeMsgMenu() { $("#menu-wrap").classList.add("hidden"); currentMenuMsg = null; menuConfirmDelete = false; }
function actionBtn(action, label, icon) {
  const b = el("button");
  b.type = "button";
  b.dataset.action = action;
  b.innerHTML = icon; // fixed constant markup — never user data
  b.appendChild(el("span", "", label));
  return b;
}
function renderMenuActions() {
  $("#menu-reactions").classList.toggle("hidden", menuConfirmDelete);
  const actions = $("#menu-actions");
  actions.innerHTML = "";
  if (menuConfirmDelete) {
    actions.appendChild(el("div", "menu-confirm-text", "Delete this message? This can't be undone."));
    actions.appendChild(actionBtn("cancel-delete", "Cancel", ICON.close));
    actions.appendChild(actionBtn("confirm-delete", "Delete Message", ICON.del));
    return;
  }
  const m = msgCache.get(currentMenuMsg);
  if (!m || !auth.currentUser) return;
  const mine = m.senderUid === auth.currentUser.uid;
  actions.appendChild(actionBtn("reply", "Reply", ICON.reply));
  if (mine) actions.appendChild(actionBtn("edit", "Edit Message", ICON.edit));
  actions.appendChild(actionBtn(m.pinned ? "unpin" : "pin", m.pinned ? "Unpin Message" : "Pin Message", ICON.pin));
  actions.appendChild(actionBtn("copylink", "Copy Message Link", ICON.link));
  if (mine) actions.appendChild(actionBtn("delete", "Delete Message", ICON.del));
}
$("#menu-actions").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn || !currentMenuMsg || !thread) return;
  const action = btn.dataset.action;
  if (action === "delete") { menuConfirmDelete = true; renderMenuActions(); return; }
  if (action === "cancel-delete") { menuConfirmDelete = false; renderMenuActions(); return; }
  if (action === "confirm-delete") {
    const id = currentMenuMsg;
    closeMsgMenu();
    thread.ref.collection("messages").doc(id).delete().catch(() => toast("Could not delete."));
    return;
  }
  const msgId = currentMenuMsg;
  closeMsgMenu();
  handleMsgAction(action, msgId);
});
$("#menu-reactions").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-emoji]");
  if (!btn || !currentMenuMsg) return;
  const msgId = currentMenuMsg;
  closeMsgMenu();
  toggleReaction(msgId, btn.dataset.emoji);
});
$("#menu-back").addEventListener("click", closeMsgMenu);
function handleMsgAction(action, msgId) {
  const m = msgCache.get(msgId);
  if (!m || !thread) return;
  if (action === "reply") {
    editTarget = null;
    replyTarget = { id: msgId, sender: m.senderName, snippet: (m.text || (m.kind === "image" ? "Photo" : "")).slice(0, 80) };
    showComposerBanner();
  } else if (action === "edit") {
    startEdit(msgId, m.text || "");
  } else if (action === "pin" || action === "unpin") {
    thread.ref.collection("messages").doc(msgId).update({ pinned: action === "pin" }).catch(() => toast("Could not update the pin."));
  } else if (action === "copylink") {
    copyToClipboard(`${LINK_BASE}m/${thread.threadId}#${msgId}`);
    toast("Link copied");
  }
}

/* -- participants drawer (Local Talk servers) -- */

$("#btn-participants").addEventListener("click", async () => {
  if (!thread || thread.kind !== "room") return;
  $("#thread-drawer").classList.remove("drawer-hidden");
  const list = $("#p-list");
  list.innerHTML = "";
  list.appendChild(el("li", "p-row", "Loading…"));
  try {
    const qs = await thread.ref.collection("participants").get();
    list.innerHTML = "";
    qs.forEach((d) => {
      const p = d.data();
      const li = el("li", "p-row");
      li.append(el("span", "status" + (isOnlineParticipant(p) ? " on" : "")), el("span", "pname", p.name || "Anonymous"));
      list.appendChild(li);
    });
  } catch {
    list.innerHTML = "";
    list.appendChild(el("li", "p-row", "Could not load."));
  }
});
$("#drawer-back").addEventListener("click", () => $("#thread-drawer").classList.add("drawer-hidden"));

/* -- composer: send / reply / edit / attach -- */

function autoGrow(ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; }
$("#thread-input").addEventListener("input", () => { $("#btn-thread-send").disabled = !$("#thread-input").value.trim(); autoGrow($("#thread-input")); });
$("#thread-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#form-thread-send").requestSubmit(); } });
$("#form-thread-send").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#thread-input").value.trim();
  if (!text) return;
  if (editTarget) return submitEdit(text);
  await sendMessage({ kind: "text", text });
});
async function sendMessage(extra) {
  if (!thread) return;
  const me = getProfile();
  const base = Object.assign({
    senderUid: auth.currentUser.uid, senderUserId: me ? me.userId : "", senderName: me ? me.name : "Anonymous",
    createdAt: FieldValue.serverTimestamp(), edited: false, pinned: false, reactions: {},
    replyTo: replyTarget ? { id: replyTarget.id, sender: replyTarget.sender, snippet: replyTarget.snippet } : null,
    text: null, imageUrl: null, imageMime: null, imageSize: null,
  }, thread.kind === "room" ? { expiresAt: Timestamp.fromMillis(thread.expiresAtMs) } : {}, extra);
  try {
    await thread.ref.collection("messages").add(base);
    resetComposer();
  } catch { toast("Message not sent."); }
}
async function submitEdit(text) {
  const id = editTarget;
  try { await thread.ref.collection("messages").doc(id).update({ text, edited: true }); }
  catch { toast("Could not save the edit."); }
  resetComposer();
}
function resetComposer() {
  $("#thread-input").value = "";
  autoGrow($("#thread-input"));
  $("#btn-thread-send").disabled = true;
  replyTarget = null;
  editTarget = null;
  hideComposerBanner();
}
function startEdit(msgId, text) {
  replyTarget = null;
  editTarget = msgId;
  $("#thread-input").value = text;
  autoGrow($("#thread-input"));
  $("#btn-thread-send").disabled = !text.trim();
  $("#thread-input").focus();
  showComposerBanner();
}
function showComposerBanner() {
  $("#reply-text").textContent = editTarget ? "Editing message" : `Replying to ${replyTarget.sender}`;
  $("#reply-banner").classList.remove("hidden");
}
function hideComposerBanner() { $("#reply-banner").classList.add("hidden"); }
$("#btn-cancel-reply").addEventListener("click", resetComposer);

$("#btn-attach").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", async () => {
  const file = $("#file-input").files[0];
  $("#file-input").value = "";
  if (!file || !thread) return;
  if (!file.type.startsWith("image/")) return toast("Only images can be shared (ImgBB only hosts images).");
  if (file.size > MAX_IMAGE_BYTES) return toast("That image is larger than 32 MB.");
  await uploadAndSend(file);
});
async function uploadAndSend(file) {
  const prog = $("#upload-progress");
  prog.textContent = "Uploading photo…";
  prog.classList.remove("hidden");
  try {
    const expSeconds = thread.expiresAtMs
      ? Math.min(15552000, Math.max(60, Math.round((thread.expiresAtMs - Date.now()) / 1000)))
      : undefined;
    const { url, mime, size } = await uploadToImgbb(file, expSeconds);
    addSentBytes(size);
    await sendMessage({ kind: "image", imageUrl: url, imageMime: mime, imageSize: size });
  } catch { toast("Photo upload failed. Check your connection and try again."); }
  finally { prog.classList.add("hidden"); }
}

/* ================= Settings tab ================= */

function renderSettings() {
  const p = getProfile();
  if (!p) return;
  renderAvatar($("#set-avatar-preview"), p.name, p.photoURL);
  $("#set-name").value = p.name || "";
  $("#set-birthday").value = p.birthday || "";
  $("#set-bio").value = p.bio || "";
  const t = getThemePrefs();
  $("#set-theme").value = t.theme;
  $("#set-text-color").value = t.textColor;
  $("#set-font").value = t.font;
  const lock = getAppLock();
  $("#set-applock-toggle").checked = lock.on;
  $("#set-applock-fields").classList.toggle("hidden", !lock.on);
  $("#storage-used").textContent = `${fmtBytes(getSentBytes())} of photos uploaded from this device (estimate)`;
  $("#storage-detail").textContent = `${getThreads().length} chats and ${getHostedRooms().length} servers remembered on this device`;
}
$("#set-avatar-preview").addEventListener("click", () => $("#avatar-input").click());
$("#btn-change-avatar").addEventListener("click", () => $("#avatar-input").click());
$("#avatar-input").addEventListener("change", async () => {
  const file = $("#avatar-input").files[0];
  $("#avatar-input").value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) return toast("Please choose an image file.");
  if (file.size > MAX_IMAGE_BYTES) return toast("That image is larger than 32 MB.");
  const prog = $("#avatar-progress");
  prog.textContent = "Uploading photo…";
  prog.classList.remove("hidden");
  try {
    const { url } = await uploadToImgbb(file); // no expiration — profile pictures don't self-delete
    const p = patchProfile({ photoURL: url });
    await ensureSignedIn();
    await db.collection("users").doc(p.userId).update({ photoURL: url });
    renderAvatar($("#set-avatar-preview"), p.name, url);
    renderMessagesHeader();
    toast("Profile picture updated");
  } catch {
    toast("Could not upload that photo. Check your connection and try again.");
  } finally {
    prog.classList.add("hidden");
  }
});
$("#form-set-profile").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#set-name").value.trim();
  const birthday = $("#set-birthday").value;
  const bio = $("#set-bio").value.trim();
  if (!name || !birthday) return toast("Name and birthday are required.");
  const p = patchProfile({ name, birthday, bio });
  try {
    await ensureSignedIn();
    const uref = db.collection("users").doc(p.userId);
    await uref.update({ name, bio });
    await uref.collection("private").doc("profile").set({ birthday });
    renderMessagesHeader();
    toast("Profile saved");
  } catch { toast("Saved on this device, but couldn't sync to the cloud right now."); }
});
["#set-theme", "#set-text-color", "#set-font"].forEach((sel) => $(sel).addEventListener("change", () => {
  saveThemePrefs({ theme: $("#set-theme").value, textColor: $("#set-text-color").value, font: $("#set-font").value });
}));
$("#set-applock-toggle").addEventListener("change", (e) => {
  if (e.target.checked) {
    $("#set-applock-fields").classList.remove("hidden");
  } else {
    saveAppLock({ on: false, hash: null });
    $("#set-applock-fields").classList.add("hidden");
    toast("App Lock turned off");
  }
});
$("#btn-set-applock-save").addEventListener("click", async () => {
  const pw = $("#set-applock-new").value;
  if (pw.length < 4) return toast("Use a password of at least 4 characters.");
  saveAppLock({ on: true, hash: await sha256Hex(pw) });
  $("#set-applock-new").value = "";
  toast("App Lock password saved");
});

/* clear cache: this device's history + the messages you've sent from the cloud (asks first) */
$("#btn-clear-cache").addEventListener("click", () => $("#clear-confirm").classList.remove("hidden"));
$("#btn-clear-cancel").addEventListener("click", () => $("#clear-confirm").classList.add("hidden"));
$("#btn-clear-go").addEventListener("click", async () => {
  const go = $("#btn-clear-go");
  go.disabled = true;
  const uid = auth.currentUser && auth.currentUser.uid;
  let removed = 0;
  for (const t of getThreads()) {
    try {
      const col = db.collection(t.kind === "convo" ? "conversations" : "rooms").doc(t.id).collection("messages");
      const qs = await col.where("senderUid", "==", uid).limit(400).get();
      if (!qs.empty) {
        const batch = db.batch();
        qs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        removed += qs.size;
      }
    } catch {}
  }
  saveThreads([]);
  localStorage.removeItem(LS_HOSTED);
  localStorage.setItem(LS_SENT_BYTES, "0");
  renderThreadLists();
  renderManageList();
  renderSettings();
  $("#clear-confirm").classList.add("hidden");
  go.disabled = false;
  toast(`Cache cleared${removed ? ` (${removed} of your messages removed)` : ""}`);
});

$("#btn-export-backup").addEventListener("click", () => {
  const p = getProfile();
  const blob = { v: 3, userId: p.userId, recoverySecret: p.recoverySecret, name: p.name, birthday: p.birthday, bio: p.bio, photoURL: p.photoURL || null, theme: getThemePrefs(), applock: getAppLock() };
  const code = btoa(unescape(encodeURIComponent(JSON.stringify(blob))));
  $("#backup-export-text").value = code;
  copyToClipboard(code);
  toast("Backup code copied");
});

/* ================= boot ================= */

let appStarted = false;
function enterApp() {
  if (appStarted) return;
  appStarted = true;
  goTab("messages");
  startPresence();
  syncIdentity().then(startInbox, startInbox);
}
showLock(() => {
  auth.onAuthStateChanged((user) => {
    if (!user) { auth.signInAnonymously().catch(() => toast("Could not sign in. Check your connection.")); return; }
    if (!getProfile()) { showScreen("onboarding"); return; }
    enterApp();
  });
});
