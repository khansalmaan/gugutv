(() => {
  const MAX_PROCESSED_EVENTS = 1000;
  let currentVideo = null;
  let applyingRemoteEvent = false;
  let suppressEventsUntil = 0;
  let roomId = null;
  let clientId = null;
  let lastSequence = 0;
  let pendingEvent = null;
  const processedEvents = new Set();

  const debug = (...args) => console.debug("[Watch Party]", ...args);
  const isSuppressed = () => applyingRemoteEvent || Date.now() < suppressEventsUntil;
  const makeID = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

  function remember(id) {
    if (!id) return;
    processedEvents.add(id);
    if (processedEvents.size > MAX_PROCESSED_EVENTS) processedEvents.delete(processedEvents.values().next().value);
  }

  class HTML5VideoAdapter {
    constructor(video) { this.video = video; }
    getPosition() { return Number.isFinite(this.video.currentTime) ? this.video.currentTime : 0; }
    async play(position) { this.video.currentTime = position; await this.video.play(); }
    pause(position) { this.video.currentTime = position; this.video.pause(); }
    seek(position) { this.video.currentTime = position; }
  }

  function emitLocalEvent(type) {
    if (!roomId || !clientId || !currentVideo || isSuppressed()) return;
    const event = { id: makeID(), senderId: clientId, roomId, type, position: new HTML5VideoAdapter(currentVideo).getPosition(), timestamp: Date.now() };
    debug("local", type, event.position);
    chrome.runtime.sendMessage({ kind: "LOCAL_EVENT", event }).catch(() => {});
  }

  const onPlay = () => emitLocalEvent("PLAY");
  const onPause = () => emitLocalEvent("PAUSE");
  const onSeeked = () => emitLocalEvent("SEEK");

  function detachVideo() {
    if (!currentVideo) return;
    currentVideo.removeEventListener("play", onPlay);
    currentVideo.removeEventListener("pause", onPause);
    currentVideo.removeEventListener("seeked", onSeeked);
    currentVideo = null;
  }

  function findVideo() {
    const video = document.querySelector("video");
    if (video === currentVideo) return;
    detachVideo();
    if (!video) return;
    currentVideo = video;
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onSeeked);
    debug("attached video listeners");
    if (pendingEvent) {
      const event = pendingEvent;
      pendingEvent = null;
      applyRemoteEvent(event);
    }
  }

  async function applyRemoteEvent(event) {
    if (!event || event.senderId === clientId) return;
    if (!currentVideo) { pendingEvent = event; return; }
    if (event.id && processedEvents.has(event.id)) return;
    if (event.sequence && event.sequence <= lastSequence) return;
    if (!Number.isFinite(event.position) || event.position < 0) return;
    remember(event.id);
    if (event.sequence) lastSequence = event.sequence;
    const type = event.type === "STATE" ? event.playback : event.type;
    if (!["PLAY", "PAUSE", "SEEK"].includes(type)) return;
    applyingRemoteEvent = true;
    suppressEventsUntil = Date.now() + 500;
    try {
      const adapter = new HTML5VideoAdapter(currentVideo);
      if (type === "PLAY") await adapter.play(event.position);
      else if (type === "PAUSE") adapter.pause(event.position);
      else adapter.seek(event.position);
      debug("remote", type, event.position);
    } catch (error) { console.warn("[Watch Party] remote playback action failed", error); }
    finally { applyingRemoteEvent = false; }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.kind === "REMOTE_EVENT") applyRemoteEvent(message.event);
    if (message?.kind === "CONNECTION_STATUS") roomId = message.roomId;
  });

  chrome.runtime.sendMessage({ kind: "CONTENT_READY" }).then(status => {
    roomId = status?.roomId || null;
    clientId = status?.clientId || null;
    if (status?.latestEvent) applyRemoteEvent(status.latestEvent);
  }).catch(() => {});
  new MutationObserver(findVideo).observe(document.documentElement, { childList: true, subtree: true });
  findVideo();
})();
