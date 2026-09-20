const tabs = document.querySelectorAll(".tab");
const panels = { sync: document.querySelector("#tab-sync"), info: document.querySelector("#tab-info") };
tabs.forEach(tab => tab.addEventListener("click", () => {
  tabs.forEach(t => t.classList.toggle("active", t === tab));
  for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== tab.dataset.tab;
}));

const roomInput = document.querySelector("#room");
const status = document.querySelector("#status");
const error = document.querySelector("#error");
const join = document.querySelector("#join");
const leave = document.querySelector("#leave");
const refresh = document.querySelector("#refresh");

function render({ roomId, connectionState }) {
  if (roomId) roomInput.value = roomId;
  const label = { CONNECTED: "Connected", CONNECTING: "Connecting…", RECONNECTING: "Reconnecting…", DISCONNECTED: "Disconnected" }[connectionState] || "Disconnected";
  status.textContent = label;
  status.className = `status ${(connectionState || "DISCONNECTED").toLowerCase()}`;
  join.hidden = Boolean(roomId);
  leave.hidden = !roomId;
}

function getStatus() { chrome.runtime.sendMessage({ kind: "GET_STATUS" }).then(render); }
join.addEventListener("click", async () => {
  error.textContent = "";
  const result = await chrome.runtime.sendMessage({ kind: "JOIN_ROOM", roomId: roomInput.value });
  if (!result?.ok) { error.textContent = result?.error || "Could not join room."; return; }
  getStatus();
});
leave.addEventListener("click", async () => { await chrome.runtime.sendMessage({ kind: "LEAVE_ROOM" }); roomInput.value = ""; getStatus(); });
refresh.addEventListener("click", async () => {
  const original = refresh.textContent;
  refresh.disabled = true;
  refresh.textContent = "Refreshing…";
  await chrome.runtime.sendMessage({ kind: "REFRESH_SYNC" }).catch(() => {});
  refresh.disabled = false;
  refresh.textContent = original;
});
chrome.runtime.onMessage.addListener(message => { if (message?.kind === "CONNECTION_STATUS") render(message); });
getStatus();
