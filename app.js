"use strict";

/* ---------- config ---------- */

const firebaseConfig = {
  apiKey: "AIzaSyBlDzaHlN948HLDPyXVAg5c83Q782gh0V0",
  authDomain: "temporary-chat-69932.firebaseapp.com",
  projectId: "temporary-chat-69932",
  storageBucket: "temporary-chat-69932.firebasestorage.app",
  messagingSenderId: "404102147038",
  appId: "1:404102147038:web:27225b99398c631ca38b4f",
};
const IMGBB_KEY = "854aafcd13a3db005451430c6620fea1";
// No web page hosts this app, so a scanned link can't open anywhere yet — the
// big room code under the QR is the real way to join. Point this at your own
// domain later if you add one, and scanning will open it directly.
const JOIN_LINK_BASE = "https://example.com/join/";

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I/L
const HEARTBEAT_MS = 25000;
const STALE_MS = 55000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024; // ImgBB's own limit
const LS_NAME = "ec_name";
const LS_ROOMS = "ec_rooms";

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const FieldValue = firebase.firestore.FieldValue;
const Timestamp = firebase.firestore.Timestamp;

/* ---------- small helpers ---------- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}
function randomCode(len = 8) {
  return Array.from(crypto.getRandomValues(new Uint8Array(len)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
function initials(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.length ? parts.map((w) => w[0].toUpperCase()).join("") : "?";
}
function fmtTime(ts) {
  const d = ts && ts.toDate ? ts.toDate() : new Date();
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtCountdown(ms) {
  if (ms <= 0) return "Expired";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
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
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2800);
}

/* ---------- local, per-device state (name + recent chats) ---------- */

function getName() { return localStorage.getItem(LS_NAME) || ""; }
function setName(n) { if (n) localStorage.setItem(LS_NAME, n); }
function getRooms() {
  try { return JSON.parse(localStorage.getItem(LS_ROOMS)) || []; } catch { return []; }
}
function saveRooms(list) { localStorage.setItem(LS_ROOMS, JSON.stringify(list.slice(0, 50))); }
function touchRoom(patch) {
  const list = getRooms();
  const idx = list.findIndex((r) => r.code === patch.code);
  const merged = Object.assign({ lastMessage: "", mode: "public" }, idx >= 0 ? list[idx] : {}, patch);
  if (idx >= 0) list[idx] = merged; else list.unshift(merged);
  saveRooms(list);
  if (!$("#screen-home").classList.contains("hidden")) renderHome();
}

function renderHome() {
  const all = getRooms();
  const q = $("#search-input").value.trim().toLowerCase();
  const rooms = q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all;
  $("#empty-home").classList.toggle("hidden", rooms.length > 0);
  $("#empty-home").textContent = all.length === 0
    ? "No chats yet. Tap the + above to create or join a room."
    : "No chats match your search.";
  const list = $("#chat-list");
  list.innerHTML = "";
  for (const r of rooms) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "chat-row";
    const av = document.createElement("div");
    av.className = "avatar";
    av.textContent = initials(r.name);
    const meta = document.createElement("div");
    meta.className = "meta";
    const l1 = document.createElement("div");
    l1.className = "line1";
    const nm = document.createElement("span");
    nm.className = "rname";
    nm.textContent = r.name;
    const tm = document.createElement("span");
    tm.className = "time";
    tm.textContent = expiryLabel(r.expiresAt);
    l1.append(nm, tm);
    const pv = document.createElement("div");
    pv.className = "preview";
    pv.textContent = r.lastMessage || (r.mode === "local" ? "Local Talk room" : "Tap to open");
    meta.append(l1, pv);
    btn.append(av, meta);
    btn.addEventListener("click", () => openRoomFromHome(r));
    li.appendChild(btn);
    list.appendChild(li);
  }
}
function expiryLabel(expiresAt) {
  const left = (expiresAt || 0) - Date.now();
  if (left <= 0) return "expired";
  const m = Math.round(left / 60000);
  return m < 60 ? `${Math.max(m, 1)}m left` : `${Math.round(m / 60)}h left`;
}
async function openRoomFromHome(r) {
  const res = await enterRoom(r.code, { name: getName() });
  if (res.ok) return openChat(res.code, getName());
  if (res.reason === "expired") { touchRoom({ code: r.code, expiresAt: 0 }); return toast("This room has expired."); }
  if (res.reason === "need_password") return toast("This is a Local Talk room — reopen it from Local Talk with its password.");
  toast("Could not reopen this room.");
}

/* ---------- screens & bottom nav ---------- */

const SCREENS = ["home", "servers", "notifications", "you", "create", "chat"];
function showScreen(name) {
  SCREENS.forEach((s) => $("#screen-" + s).classList.toggle("hidden", s !== name));
  if (name === "you") $("#you-name").value = getName();
}
function setActiveTab(tab) {
  $$(".bottom-nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
}
const TAB_SCREEN = { messages: "home", servers: "servers", notifications: "notifications", you: "you" };

document.addEventListener("click", (e) => {
  const tabBtn = e.target.closest("[data-tab]");
  if (tabBtn) { showScreen(TAB_SCREEN[tabBtn.dataset.tab]); setActiveTab(tabBtn.dataset.tab); return; }
  const goBtn = e.target.closest("[data-goto]");
  if (goBtn) { if (goBtn.dataset.goto === "create") openCreateScreen(); else showScreen(goBtn.dataset.goto); }
});

function openCreateScreen() {
  const name = getName();
  $("#create-name").value = name;
  $("#join-name").value = name;
  $("#local-name").value = name;
  $("#create-result").classList.add("hidden");
  $("#form-create").classList.remove("hidden");
  $("#form-join").classList.add("hidden");
  $("#form-local").classList.add("hidden");
  $$(".segmented button").forEach((b) => b.classList.toggle("active", b.dataset.mode === "create"));
  showScreen("create");
}
$("#btn-add").addEventListener("click", openCreateScreen);
$("#search-input").addEventListener("input", renderHome);

$$(".segmented button").forEach((b) => b.addEventListener("click", () => {
  $$(".segmented button").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  const mode = b.dataset.mode;
  $("#form-create").classList.toggle("hidden", mode !== "create");
  $("#form-join").classList.toggle("hidden", mode !== "join");
  $("#form-local").classList.toggle("hidden", mode !== "local");
  $("#create-result").classList.add("hidden");
}));

$("#create-local").addEventListener("change", () => {
  $("#create-password-wrap").classList.toggle("hidden", !$("#create-local").checked);
});
$("#join-code").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase(); });
$("#local-code").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase(); });

/* ---------- Firestore: create / enter a room ---------- */

async function createRoom({ name, minutes, isLocal, password }) {
  if (!auth.currentUser) throw new Error("Still connecting — try again in a moment.");
  const uid = auth.currentUser.uid;
  const expiresAt = Timestamp.fromMillis(Date.now() + minutes * 60000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const ref = db.collection("rooms").doc(code);
    const roomData = {
      name: name || `Room ${code.slice(0, 4)}`,
      mode: isLocal ? "local" : "public",
      hostUid: uid,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
    };
    let hashHex = null;
    if (isLocal) {
      const saltHex = randomHex(16);
      hashHex = await sha256Hex(saltHex + ":" + password);
      roomData.saltHex = saltHex;
    }
    try {
      await ref.set(roomData);
    } catch (err) {
      if (err.code === "permission-denied") continue; // code collision — try another
      throw err;
    }
    if (isLocal) {
      try {
        await ref.collection("secret").doc("config").set({ hashHex });
      } catch {
        throw new Error("Could not finish setting the password. Try creating the room again.");
      }
    }
    return { code };
  }
  throw new Error("Could not create a room right now. Try again.");
}

/**
 * Joins a room, or silently re-enters it if this device already has (in which
 * case no password is asked for again). Returns one of:
 *  {ok:true, code, room}
 *  {ok:false, reason:'not_found'|'expired'|'need_password'|'bad_password', room?}
 */
async function enterRoom(code, { name, password } = {}) {
  if (!auth.currentUser) return { ok: false, reason: "not_found" };
  code = (code || "").toUpperCase().trim();
  if (!code) return { ok: false, reason: "not_found" };
  const ref = db.collection("rooms").doc(code);
  let snap;
  try { snap = await ref.get(); } catch { return { ok: false, reason: "not_found" }; }
  if (!snap.exists) return { ok: false, reason: "not_found" };
  const room = snap.data();
  if (room.expiresAt.toMillis() <= Date.now()) return { ok: false, reason: "expired", room };

  const uid = auth.currentUser.uid;
  const pRef = ref.collection("participants").doc(uid);
  const already = await pRef.get();
  if (already.exists) {
    await pRef.update({ lastActive: FieldValue.serverTimestamp(), name: name || already.data().name }).catch(() => {});
    return { ok: true, code, room };
  }

  if (room.mode === "local") {
    if (password == null) return { ok: false, reason: "need_password", room };
    const hashHex = await sha256Hex(room.saltHex + ":" + password);
    try {
      await pRef.set({ name, hashHex, joinedAt: FieldValue.serverTimestamp(), lastActive: FieldValue.serverTimestamp() });
    } catch (err) {
      if (err.code === "permission-denied") return { ok: false, reason: "bad_password", room };
      throw err;
    }
  } else {
    await pRef.set({ name, joinedAt: FieldValue.serverTimestamp(), lastActive: FieldValue.serverTimestamp() });
  }
  return { ok: true, code, room };
}

/* ---------- create / join / local forms ---------- */

$("#form-create").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#create-name").value.trim();
  if (!name) return;
  const minutes = Number($("#create-duration").value);
  const isLocal = $("#create-local").checked;
  const password = $("#create-password").value;
  if (isLocal && password.length < 4) return toast("Use a password of at least 4 characters.");
  setName(name);
  try {
    const { code } = await createRoom({ name, minutes, isLocal, password });
    await enterRoom(code, { name, password: isLocal ? password : undefined });
    showCreateResult(code);
  } catch (err) {
    toast(err.message || "Could not create the room.");
  }
});

function showCreateResult(code) {
  $("#form-create").classList.add("hidden");
  $("#create-result").classList.remove("hidden");
  $("#result-code").textContent = code;
  const link = JOIN_LINK_BASE + code;
  $("#result-link").textContent = link;
  if (window.QRCode) QRCode.toCanvas($("#result-qr"), link, { width: 200, margin: 1 }, () => {});
  $("#btn-enter-room").onclick = () => openChat(code, getName());
  $("#btn-copy-link").onclick = () => { copyToClipboard(link); toast("Link copied"); };
}

$("#form-join").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#join-name").value.trim();
  const code = $("#join-code").value.trim();
  if (!name || !code) return;
  setName(name);
  const r = await enterRoom(code, { name });
  if (r.ok) return openChat(r.code, name);
  if (r.reason === "need_password") return toast("That room needs a password — use Local Talk instead.");
  if (r.reason === "expired") return toast("That room has expired.");
  toast("Room not found. Check the code and try again.");
});

$("#form-local").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#local-name").value.trim();
  const code = $("#local-code").value.trim();
  const password = $("#local-password").value;
  if (!name || !code || !password) return;
  setName(name);
  const r = await enterRoom(code, { name, password });
  if (r.ok) return openChat(r.code, name);
  if (r.reason === "bad_password") return toast("Wrong password.");
  if (r.reason === "expired") return toast("That room has expired.");
  toast("Room not found. Check the code and try again.");
});

/* ---------- chat screen state ---------- */

let currentRoomCode = null;
let currentRoomRef = null;
let unsubRoom = null, unsubParticipants = null, unsubMessages = null;
let heartbeatTimer = null, countdownTimer = null;
let roomExpiresAtMs = 0;
let myName = "";
let replyTarget = null, editTarget = null;
const msgCache = new Map();
const participantsCache = new Map();

async function openChat(code, name) {
  closeChat();
  currentRoomCode = code;
  currentRoomRef = db.collection("rooms").doc(code);
  myName = name || getName();
  $("#chat-title").textContent = code;
  $("#messages").innerHTML = "";
  msgCache.clear();
  showScreen("chat");

  unsubRoom = currentRoomRef.onSnapshot((snap) => {
    if (!snap.exists) return handleExpired();
    const room = snap.data();
    roomExpiresAtMs = room.expiresAt.toMillis();
    $("#chat-title").textContent = room.name || code;
    touchRoom({ code, name: room.name || code, mode: room.mode, expiresAt: roomExpiresAtMs });
    if (Date.now() >= roomExpiresAtMs) handleExpired();
  }, () => handleExpired());

  unsubParticipants = currentRoomRef.collection("participants").onSnapshot((qs) => {
    participantsCache.clear();
    qs.forEach((d) => participantsCache.set(d.id, d.data()));
    renderParticipants();
  });

  unsubMessages = currentRoomRef.collection("messages").orderBy("createdAt").limit(300).onSnapshot((qs) => {
    msgCache.clear();
    qs.forEach((d) => msgCache.set(d.id, d.data()));
    renderMessages();
    const arr = [...msgCache.values()];
    if (arr.length) touchRoom({ code, lastMessage: previewOf(arr[arr.length - 1]) });
  }, () => toast("Could not load messages."));

  await heartbeat();
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  countdownTimer = setInterval(tick, 1000);
  tick();
}

function previewOf(m) {
  return m.kind === "image" ? `${m.senderName}: 📷 Photo` : `${m.senderName}: ${(m.text || "").slice(0, 60)}`;
}
async function heartbeat() {
  if (!currentRoomRef || !auth.currentUser) return;
  try { await currentRoomRef.collection("participants").doc(auth.currentUser.uid).update({ lastActive: FieldValue.serverTimestamp() }); } catch {}
}
function tick() {
  const left = roomExpiresAtMs - Date.now();
  const el = $("#chat-countdown");
  el.textContent = fmtCountdown(left);
  el.classList.toggle("low", left > 0 && left < 60000);
  renderParticipants();
  if (left <= 0) handleExpired();
}
function handleExpired() {
  $("#expired-banner").classList.remove("hidden");
  $$("#form-send input, #form-send textarea, #form-send button").forEach((el) => (el.disabled = true));
  clearInterval(heartbeatTimer);
  clearInterval(countdownTimer);
}
function closeChat() {
  if (unsubRoom) unsubRoom();
  if (unsubParticipants) unsubParticipants();
  if (unsubMessages) unsubMessages();
  unsubRoom = unsubParticipants = unsubMessages = null;
  clearInterval(heartbeatTimer);
  clearInterval(countdownTimer);
  $("#expired-banner").classList.add("hidden");
  $$("#form-send input, #form-send textarea, #form-send button").forEach((el) => (el.disabled = false));
  $("#btn-send").disabled = true;
  replyTarget = null;
  editTarget = null;
  hideComposerBanner();
  $("#drawer").classList.add("drawer-hidden");
}

$("#btn-leave").addEventListener("click", async () => {
  const ref = currentRoomRef;
  closeChat();
  showScreen("home");
  setActiveTab("messages");
  if (ref && auth.currentUser) { try { await ref.collection("participants").doc(auth.currentUser.uid).delete(); } catch {} }
});

/* ---------- message list ---------- */

function isNearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 80; }

function renderMessages() {
  const wrap = $("#messages");
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
  const row = document.createElement("div");
  row.className = "msg-row" + (grouped ? " grouped" : "");

  const avatarSlot = document.createElement("div");
  avatarSlot.className = "avatar-slot";
  const av = document.createElement("div");
  av.className = "avatar-sm";
  av.textContent = initials(m.senderName);
  avatarSlot.appendChild(av);
  row.appendChild(avatarSlot);

  const body = document.createElement("div");
  body.className = "msg-body";

  if (!grouped) {
    const head = document.createElement("div");
    head.className = "msg-head";
    const sender = document.createElement("span");
    sender.className = "sender";
    sender.textContent = m.senderName || "Anonymous";
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = fmtTime(m.createdAt);
    head.append(sender, time);
    body.appendChild(head);
  }
  if (m.pinned) {
    const pf = document.createElement("div");
    pf.className = "pin-flag";
    pf.textContent = "📌 Pinned";
    body.appendChild(pf);
  }
  if (m.replyTo) {
    const q = document.createElement("div");
    q.className = "reply-quote";
    q.textContent = `↩ ${m.replyTo.sender}: ${m.replyTo.snippet}`;
    body.appendChild(q);
  }
  if (m.kind === "image" && typeof m.imageUrl === "string" && m.imageUrl.startsWith("https://")) {
    const img = document.createElement("img");
    img.className = "msg-image";
    img.src = m.imageUrl;
    img.loading = "lazy";
    img.alt = "Shared photo";
    body.appendChild(img);
  } else if (m.text) {
    const t = document.createElement("div");
    t.className = "msg-text" + (m.edited ? " edited" : "");
    t.textContent = m.text;
    body.appendChild(t);
  }
  const reactions = m.reactions || {};
  const keys = Object.keys(reactions).filter((k) => (reactions[k] || []).length);
  if (keys.length) {
    const rrow = document.createElement("div");
    rrow.className = "reactions-row";
    for (const emoji of keys) {
      const arr = reactions[emoji];
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "reaction-pill" + (auth.currentUser && arr.includes(auth.currentUser.uid) ? " mine" : "");
      pill.textContent = `${emoji} ${arr.length}`;
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
  for (const [id, m] of msgCache) if (m.pinned) latest = m;
  const banner = $("#pinned-banner");
  if (!latest) return banner.classList.add("hidden");
  banner.classList.remove("hidden");
  $("#pinned-text").textContent = `${latest.senderName}: ${(latest.text || "Photo").slice(0, 60)}`;
}

async function toggleReaction(msgId, emoji) {
  const m = msgCache.get(msgId);
  if (!m || !auth.currentUser) return;
  const uid = auth.currentUser.uid;
  const mine = (m.reactions && m.reactions[emoji] || []).includes(uid);
  try {
    await currentRoomRef.collection("messages").doc(msgId).update({
      [`reactions.${emoji}`]: mine ? FieldValue.arrayRemove(uid) : FieldValue.arrayUnion(uid),
    });
  } catch {
    toast("Could not react — the room may have expired.");
  }
}

/* ---------- long-press menu ---------- */

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

const ICON_REPLY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17 4 12l5-5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.8 5.6H19l-4.6 3.3L16 17l-4-3-4 3 1.6-6.1L5 7.6h5.2Z"/></svg>';
const ICON_LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"/></svg>';
const ICON_DELETE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

let currentMenuMsg = null;
let menuConfirmDelete = false;

function openMsgMenu(msgId) {
  if (!msgCache.has(msgId)) return;
  currentMenuMsg = msgId;
  menuConfirmDelete = false;
  renderMenuActions();
  $("#menu-wrap").classList.remove("hidden");
}
function closeMsgMenu() {
  $("#menu-wrap").classList.add("hidden");
  currentMenuMsg = null;
  menuConfirmDelete = false;
}
function actionBtn(action, label, icon) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.action = action;
  b.innerHTML = icon; // fixed constant markup — never user data
  const span = document.createElement("span");
  span.textContent = label;
  b.appendChild(span);
  return b;
}
function renderMenuActions() {
  $("#menu-reactions").classList.toggle("hidden", menuConfirmDelete);
  const actions = $("#menu-actions");
  actions.innerHTML = "";
  if (menuConfirmDelete) {
    const p = document.createElement("div");
    p.className = "menu-confirm-text";
    p.textContent = "Delete this message? This can't be undone.";
    actions.appendChild(p);
    actions.appendChild(actionBtn("cancel-delete", "Cancel", ICON_CLOSE));
    actions.appendChild(actionBtn("confirm-delete", "Delete Message", ICON_DELETE));
    return;
  }
  const m = msgCache.get(currentMenuMsg);
  if (!m || !auth.currentUser) return;
  const mine = m.senderUid === auth.currentUser.uid;
  actions.appendChild(actionBtn("reply", "Reply", ICON_REPLY));
  if (mine) actions.appendChild(actionBtn("edit", "Edit Message", ICON_EDIT));
  actions.appendChild(actionBtn(m.pinned ? "unpin" : "pin", m.pinned ? "Unpin Message" : "Pin Message", ICON_PIN));
  actions.appendChild(actionBtn("copylink", "Copy Message Link", ICON_LINK));
  if (mine) actions.appendChild(actionBtn("delete", "Delete Message", ICON_DELETE));
}

$("#menu-actions").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn || !currentMenuMsg) return;
  const action = btn.dataset.action;
  if (action === "delete") { menuConfirmDelete = true; renderMenuActions(); return; }
  if (action === "cancel-delete") { menuConfirmDelete = false; renderMenuActions(); return; }
  if (action === "confirm-delete") {
    const id = currentMenuMsg;
    closeMsgMenu();
    currentRoomRef.collection("messages").doc(id).delete().catch(() => toast("Could not delete."));
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
  if (!m) return;
  const ref = currentRoomRef.collection("messages").doc(msgId);
  if (action === "reply") {
    editTarget = null;
    replyTarget = { id: msgId, sender: m.senderName, snippet: (m.text || (m.kind === "image" ? "Photo" : "")).slice(0, 80) };
    showComposerBanner();
  } else if (action === "edit") {
    startEdit(msgId, m.text || "");
  } else if (action === "pin" || action === "unpin") {
    ref.update({ pinned: action === "pin" }).catch(() => toast("Could not update the pin."));
  } else if (action === "copylink") {
    copyToClipboard(`${JOIN_LINK_BASE}${currentRoomCode}#msg=${msgId}`);
    toast("Link copied");
  }
}

/* ---------- participants drawer ---------- */

function renderParticipants() {
  const list = $("#p-list");
  list.innerHTML = "";
  const uid = auth.currentUser && auth.currentUser.uid;
  const rows = [...participantsCache.entries()].sort((a, b) => (a[1].joinedAt ? a[1].joinedAt.toMillis() : 0) - (b[1].joinedAt ? b[1].joinedAt.toMillis() : 0));
  let onlineCount = 0;
  for (const [pid, p] of rows) {
    const online = p.lastActive && Date.now() - p.lastActive.toMillis() < STALE_MS;
    if (online) onlineCount++;
    const li = document.createElement("li");
    li.className = "p-row";
    const status = document.createElement("span");
    status.className = "status" + (online ? " on" : "");
    const name = document.createElement("span");
    name.className = "pname";
    name.textContent = p.name || "Anonymous";
    li.append(status, name);
    if (pid === uid) {
      const tag = document.createElement("span");
      tag.className = "you-tag";
      tag.textContent = "you";
      li.appendChild(tag);
    }
    list.appendChild(li);
  }
  $("#online-count").textContent = String(onlineCount || rows.length);
  $("#drawer-count").textContent = `Participants — ${rows.length}`;
}
$("#btn-participants").addEventListener("click", () => $("#drawer").classList.remove("drawer-hidden"));
$("#drawer-back").addEventListener("click", () => $("#drawer").classList.add("drawer-hidden"));

/* ---------- composer: send, reply, edit, attach ---------- */

function autoGrow(ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; }
$("#msg-input").addEventListener("input", () => {
  $("#btn-send").disabled = !$("#msg-input").value.trim();
  autoGrow($("#msg-input"));
});
$("#msg-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#form-send").requestSubmit(); }
});

$("#form-send").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#msg-input").value.trim();
  if (!text) return;
  if (editTarget) return submitEdit(text);
  await sendMessage({ kind: "text", text });
});

async function sendMessage(extra) {
  const base = Object.assign(
    {
      senderUid: auth.currentUser.uid,
      senderName: myName,
      createdAt: FieldValue.serverTimestamp(),
      edited: false,
      pinned: false,
      reactions: {},
      replyTo: replyTarget ? { id: replyTarget.id, sender: replyTarget.sender, snippet: replyTarget.snippet } : null,
      expiresAt: Timestamp.fromMillis(roomExpiresAtMs),
      text: null,
      imageUrl: null,
      imageMime: null,
    },
    extra,
  );
  try {
    await currentRoomRef.collection("messages").add(base);
    resetComposer();
  } catch {
    toast("Message not sent — the room may have expired.");
  }
}
async function submitEdit(text) {
  const id = editTarget;
  try {
    await currentRoomRef.collection("messages").doc(id).update({ text, edited: true });
  } catch {
    toast("Could not save the edit.");
  }
  resetComposer();
}
function resetComposer() {
  $("#msg-input").value = "";
  autoGrow($("#msg-input"));
  $("#btn-send").disabled = true;
  replyTarget = null;
  editTarget = null;
  hideComposerBanner();
}
function startEdit(msgId, text) {
  replyTarget = null;
  editTarget = msgId;
  $("#msg-input").value = text;
  autoGrow($("#msg-input"));
  $("#btn-send").disabled = !text.trim();
  $("#msg-input").focus();
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
  if (!file) return;
  if (!file.type.startsWith("image/")) return toast("Only images can be shared (ImgBB only hosts images).");
  if (file.size > MAX_IMAGE_BYTES) return toast("That image is larger than 32 MB.");
  await uploadAndSend(file);
});
async function uploadAndSend(file) {
  const prog = $("#upload-progress");
  prog.textContent = "Uploading photo…";
  prog.classList.remove("hidden");
  try {
    const expSeconds = Math.min(15552000, Math.max(60, Math.round((roomExpiresAtMs - Date.now()) / 1000)));
    const form = new FormData();
    form.append("image", file);
    form.append("expiration", String(expSeconds));
    const res = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_KEY}`, { method: "POST", body: form });
    const json = await res.json();
    if (!json.success) throw new Error((json.error && json.error.message) || "Upload failed");
    await sendMessage({ kind: "image", imageUrl: json.data.url, imageMime: (json.data.image && json.data.image.mime) || file.type });
  } catch {
    toast("Photo upload failed. Check your connection and try again.");
  } finally {
    prog.classList.add("hidden");
  }
}

/* ---------- You screen ---------- */

$("#btn-save-name").addEventListener("click", () => {
  const n = $("#you-name").value.trim();
  if (!n) return toast("Enter a name first.");
  setName(n);
  toast("Saved");
});
$("#btn-clear-history").addEventListener("click", () => {
  saveRooms([]);
  renderHome();
  toast("Local chat history cleared");
});

/* ---------- boot ---------- */

auth.onAuthStateChanged((user) => {
  if (!user) { auth.signInAnonymously().catch(() => toast("Could not sign in. Check your connection.")); return; }
  $("#you-name").value = getName();
  renderHome();
});
