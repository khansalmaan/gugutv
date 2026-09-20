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

  const debug = (...args) => console.info("[GuguTV Sync]", ...args);
  const isSuppressed = () => applyingRemoteEvent || Date.now() < suppressEventsUntil;
  const makeID = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

  // Ads drive the shared <video> element through play/pause/seek at these
  // landing points (skip-countdown thresholds, ad restarts). They fire only
  // for the viewer seeing the ad, so broadcasting them yanks every other
  // viewer's real playback position.
  const AD_BREAK_POSITIONS = [0, 10, 15, 20, 30];
  const isAdBreakEvent = (position) => AD_BREAK_POSITIONS.some(p => Math.abs(position - p) < 0.5);

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
    if (!roomId || !clientId || !currentVideo || isSuppressed()) {
      if (currentVideo && !isSuppressed()) debug("ignored local event; no active room or client id", type);
      return;
    }
    const position = new HTML5VideoAdapter(currentVideo).getPosition();
    if (isAdBreakEvent(position)) { debug("ignored likely ad event", type, position); return; }
    const event = { id: makeID(), senderId: clientId, roomId, type, position, timestamp: Date.now() };
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

  function changeRoom(nextRoomId) {
    if (roomId === nextRoomId) return;
    debug("room changed; resetting video synchronization", { from: roomId, to: nextRoomId });
    // A room has its own event order. Reattach rather than carrying listeners
    // and deduplication state from a previous synchronization session.
    detachVideo();
    roomId = nextRoomId;
    lastSequence = 0;
    processedEvents.clear();
    pendingEvent = null;
    findVideo();
  }

  async function applyRemoteEvent(event) {
    if (!event || event.senderId === clientId) return;
    if (!currentVideo) { debug("queued remote event until video appears", event.type); pendingEvent = event; return; }
    if (event.id && processedEvents.has(event.id)) { debug("ignored duplicate remote event", event.id); return; }
    if (event.sequence && event.sequence <= lastSequence) { debug("ignored out-of-order remote event", event.sequence); return; }
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
    } catch (error) { console.warn("[GuguTV] remote playback action failed", error); }
    finally { applyingRemoteEvent = false; }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.kind === "REMOTE_EVENT") applyRemoteEvent(message.event);
    if (message?.kind === "CONNECTION_STATUS") changeRoom(message.roomId || null);
  });

  chrome.runtime.sendMessage({ kind: "CONTENT_READY" }).then(status => {
    changeRoom(status?.roomId || null);
    clientId = status?.clientId || null;
    debug("ready", { roomId, clientId });
    if (status?.latestEvent) applyRemoteEvent(status.latestEvent);
  }).catch(() => {});
  new MutationObserver(findVideo).observe(document.documentElement, { childList: true, subtree: true });
  findVideo();
})();
