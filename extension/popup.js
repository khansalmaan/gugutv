const roomInput = document.querySelector("#room");
const status = document.querySelector("#status");
const error = document.querySelector("#error");
const join = document.querySelector("#join");
const leave = document.querySelector("#leave");

function render({ roomId, connectionState }) {
  if (roomId) roomInput.value = roomId;
  const label = { CONNECTED: "Connected", CONNECTING: "Connecting…", RECONNECTING: "Reconnecting…", DISCONNECTED: "Disconnected" }[connectionState] || "Disconnected";
  status.textContent = `● ${label}`;
  status.className = `status ${(connectionState || "DISCONNECTED").toLowerCase()}`;
  leave.disabled = !roomId;
}

function getStatus() { chrome.runtime.sendMessage({ kind: "GET_STATUS" }).then(render); }
join.addEventListener("click", async () => {
  error.textContent = "";
  const result = await chrome.runtime.sendMessage({ kind: "JOIN_ROOM", roomId: roomInput.value });
  if (!result?.ok) { error.textContent = result?.error || "Could not join room."; return; }
  getStatus();
});
leave.addEventListener("click", async () => { await chrome.runtime.sendMessage({ kind: "LEAVE_ROOM" }); roomInput.value = ""; getStatus(); });
chrome.runtime.onMessage.addListener(message => { if (message?.kind === "CONNECTION_STATUS") render(message); });
getStatus();
