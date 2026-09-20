const DEFAULT_SERVER_URL = "wss://gugutv.onrender.com/ws";
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

const HEALTH_CHECK_ALARM = "gugutv-health-check";

let socket = null;
let roomId = null;
let connectionState = "DISCONNECTED";
let reconnectDelay = INITIAL_BACKOFF_MS;
let reconnectTimer = null;
let clientId = null;
const contentTabs = new Set();
let latestState = null;
let initialization;
// Bumped on every connect() call so a superseded connection's async
// onopen/onmessage/onclose handlers can recognize they're stale and avoid
// clobbering the state of whichever connection attempt is actually current.
let connectionGeneration = 0;

const debug = (...args) => console.info("[GuguTV WS]", ...args);

async function initialize() {
  const stored = await chrome.storage.local.get(["clientId", "roomId"]);
  clientId = stored.clientId || crypto.randomUUID();
  if (!stored.clientId) await chrome.storage.local.set({ clientId });
  debug("initialized", { clientId, roomId: stored.roomId || null });
  if (stored.roomId) joinRoom(stored.roomId);
}

function broadcastStatus() {
  const payload = { kind: "CONNECTION_STATUS", roomId, connectionState };
  chrome.runtime.sendMessage(payload).catch(() => {});
  for (const tabId of contentTabs) chrome.tabs.sendMessage(tabId, payload).catch(() => contentTabs.delete(tabId));
}

function setConnectionState(next) {
  connectionState = next;
  broadcastStatus();
}

function normalizeRoomId(value) { return String(value || "").trim().toUpperCase(); }
function validRoomId(value) { return /^[A-Z0-9]{4,12}$/.test(value); }

async function joinRoom(value) {
  const nextRoom = normalizeRoomId(value);
  if (!validRoomId(nextRoom)) throw new Error("Room IDs must contain 4–12 letters or numbers.");
  roomId = nextRoom;
  latestState = null;
  debug("joining room", roomId);
  await chrome.storage.local.set({ roomId });
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) socket.close();
  connect();
}

async function leaveRoom() {
  roomId = null;
  latestState = null;
  debug("leaving room");
  await chrome.storage.local.remove("roomId");
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) socket.close();
  socket = null;
  setConnectionState("DISCONNECTED");
}

function connect() {
  if (!roomId || !clientId) return;
  const generation = ++connectionGeneration;
  setConnectionState(socket ? "RECONNECTING" : "CONNECTING");
  const url = `${DEFAULT_SERVER_URL}?room=${encodeURIComponent(roomId)}&clientId=${encodeURIComponent(clientId)}`;
  debug("connecting", { roomId, state: connectionState });
  let ws;
  try { ws = new WebSocket(url); } catch (error) { scheduleReconnect(); return; }
  socket = ws;
  ws.onopen = () => {
    if (generation !== connectionGeneration) return;
    reconnectDelay = INITIAL_BACKOFF_MS;
    setConnectionState("CONNECTED");
    debug("connected", roomId);
  };
  ws.onmessage = (message) => { if (generation === connectionGeneration) handleServerMessage(message.data); };
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    if (generation !== connectionGeneration) return; // superseded by a newer connection attempt
    debug("socket closed", roomId);
    socket = null;
    if (roomId) scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer || !roomId) return;
  setConnectionState("RECONNECTING");
  const delay = reconnectDelay;
  debug("reconnecting in", delay, "ms");
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_BACKOFF_MS);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

function handleServerMessage(raw) {
  let event;
  try { event = JSON.parse(raw); } catch (_) { console.warn("[WS] ignored malformed message"); return; }
  if (!event || (event.type !== "STATE" && !["PLAY", "PAUSE", "SEEK"].includes(event.type))) return;
  if (event.senderId === clientId) return;
  if (event.type === "STATE") latestState = event;
  debug("received", event.type, "position=", event.position, "sequence=", event.sequence);
  for (const tabId of contentTabs) chrome.tabs.sendMessage(tabId, { kind: "REMOTE_EVENT", event }).catch(() => contentTabs.delete(tabId));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab?.id) contentTabs.add(sender.tab.id);
  if (message?.kind === "LOCAL_EVENT") {
    if (socket?.readyState === WebSocket.OPEN && roomId && message.event?.roomId === roomId) {
      debug("sending", message.event.type, "position=", message.event.position);
      socket.send(JSON.stringify(message.event));
    } else {
      debug("dropped local event while disconnected", message.event?.type);
    }
    return;
  }
  if (message?.kind === "CONTENT_READY") {
    initialization.then(() => sendResponse({ roomId, connectionState, clientId, latestEvent: latestState }));
    return true;
  }
  if (message?.kind === "GET_STATUS") { sendResponse({ roomId, connectionState }); return; }
  if (message?.kind === "JOIN_ROOM") { joinRoom(message.roomId).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
  if (message?.kind === "LEAVE_ROOM") { leaveRoom().then(() => sendResponse({ ok: true })); return true; }
  if (message?.kind === "REFRESH_SYNC") {
    debug("relaying manual refresh to content tabs", contentTabs.size);
    for (const tabId of contentTabs) chrome.tabs.sendMessage(tabId, { kind: "REFRESH_SYNC" }).catch(() => contentTabs.delete(tabId));
    sendResponse({ ok: true });
    return;
  }
});

chrome.tabs.onRemoved.addListener(tabId => contentTabs.delete(tabId));

// A suspended service worker loses its in-memory reconnectTimer entirely.
// This alarm periodically wakes the worker back up (chrome.alarms wakes even
// a fully-suspended MV3 worker), so a stuck DISCONNECTED/CLOSED state can't
// persist indefinitely just because nothing else happened to trigger it.
chrome.alarms.create(HEALTH_CHECK_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEALTH_CHECK_ALARM) return;
  initialization.then(() => {
    if (roomId && (!socket || socket.readyState === WebSocket.CLOSED)) {
      debug("health check: connection missing, reconnecting", roomId);
      connect();
    }
  });
});

initialization = initialize();
