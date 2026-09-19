const DEFAULT_SERVER_URL = "ws://localhost:8080/ws";
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

let socket = null;
let roomId = null;
let connectionState = "DISCONNECTED";
let reconnectDelay = INITIAL_BACKOFF_MS;
let reconnectTimer = null;
let clientId = null;
const contentTabs = new Set();
let latestState = null;

async function initialize() {
  const stored = await chrome.storage.local.get(["clientId", "roomId"]);
  clientId = stored.clientId || crypto.randomUUID();
  if (!stored.clientId) await chrome.storage.local.set({ clientId });
  if (stored.roomId) joinRoom(stored.roomId);
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ kind: "CONNECTION_STATUS", roomId, connectionState }).catch(() => {});
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
  await chrome.storage.local.set({ roomId });
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) socket.close();
  connect();
}

async function leaveRoom() {
  roomId = null;
  latestState = null;
  await chrome.storage.local.remove("roomId");
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) socket.close();
  socket = null;
  setConnectionState("DISCONNECTED");
}

function connect() {
  if (!roomId || !clientId) return;
  setConnectionState(socket ? "RECONNECTING" : "CONNECTING");
  const url = `${DEFAULT_SERVER_URL}?room=${encodeURIComponent(roomId)}&clientId=${encodeURIComponent(clientId)}`;
  try { socket = new WebSocket(url); } catch (error) { scheduleReconnect(); return; }
  socket.onopen = () => { reconnectDelay = INITIAL_BACKOFF_MS; setConnectionState("CONNECTED"); };
  socket.onmessage = (message) => handleServerMessage(message.data);
  socket.onerror = () => socket?.close();
  socket.onclose = () => { socket = null; if (roomId) scheduleReconnect(); };
}

function scheduleReconnect() {
  if (reconnectTimer || !roomId) return;
  setConnectionState("RECONNECTING");
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_BACKOFF_MS);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

function handleServerMessage(raw) {
  let event;
  try { event = JSON.parse(raw); } catch (_) { console.warn("[WS] ignored malformed message"); return; }
  if (!event || (event.type !== "STATE" && !["PLAY", "PAUSE", "SEEK"].includes(event.type))) return;
  if (event.senderId === clientId) return;
  if (event.type === "STATE") latestState = event;
  for (const tabId of contentTabs) chrome.tabs.sendMessage(tabId, { kind: "REMOTE_EVENT", event }).catch(() => contentTabs.delete(tabId));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab?.id) contentTabs.add(sender.tab.id);
  if (message?.kind === "LOCAL_EVENT") {
    if (socket?.readyState === WebSocket.OPEN && roomId && message.event?.roomId === roomId) socket.send(JSON.stringify(message.event));
    return;
  }
  if (message?.kind === "CONTENT_READY") { sendResponse({ roomId, connectionState, clientId, latestEvent: latestState }); return; }
  if (message?.kind === "GET_STATUS") { sendResponse({ roomId, connectionState }); return; }
  if (message?.kind === "JOIN_ROOM") { joinRoom(message.roomId).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message })); return true; }
  if (message?.kind === "LEAVE_ROOM") { leaveRoom().then(() => sendResponse({ ok: true })); return true; }
});

chrome.tabs.onRemoved.addListener(tabId => contentTabs.delete(tabId));
initialize();
