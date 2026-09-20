(() => {
  const MAX_PROCESSED_EVENTS = 1000;
  let currentVideo = null;
  let applyingRemoteEvent = false;
  let suppressEventsUntil = 0;
  let roomId = null;
  let clientId = null;
  let lastSequence = 0;
  let pendingEvent = null;
  let eventQueue = Promise.resolve();
  let pendingPlayback = null;
  const processedEvents = new Set();
  const PLAYBACK_DEBOUNCE_MS = 400;

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
    async play(position) {
      this.video.currentTime = position;
      // Some players (e.g. Prime Video) run their own controller that can
      // call pause() on the raw <video> element moments after we call
      // play(), aborting our promise. That's a one-off reconciliation, not
      // a real refusal to play, so retry briefly instead of giving up.
      for (let attempt = 0; attempt < 2 && this.video.paused; attempt++) {
        try { await this.video.play(); }
        catch (error) {
          if (error?.name !== "AbortError") throw error;
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
      if (this.video.paused) console.warn("[GuguTV] remote play kept getting reverted by the page's own player");
    }
    async pause(position) {
      this.video.currentTime = position;
      // Mirrors play()'s retry: the page's own controller can resume
      // playback shortly after we pause it, so confirm it actually stuck
      // and retry briefly if it got reverted.
      for (let attempt = 0; attempt < 2 && !this.video.paused; attempt++) {
        this.video.pause();
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      if (!this.video.paused) console.warn("[GuguTV] remote pause kept getting reverted by the page's own player");
    }
    seek(position) { this.video.currentTime = position; }
  }

  function cancelPendingPlayback() {
    if (!pendingPlayback) return;
    clearTimeout(pendingPlayback.timer);
    pendingPlayback = null;
  }

  function sendLocalEvent(type) {
    // Re-checked here (not just in emitLocalEvent) because PLAY/PAUSE go
    // through a debounce delay first, during which a remote event could
    // arrive and start suppressing echoes, or the room/video could change.
    if (!roomId || !clientId || !currentVideo || isSuppressed()) return;
    const position = new HTML5VideoAdapter(currentVideo).getPosition();
    if (isAdBreakEvent(position)) { debug("ignored likely ad event", type, position); return; }
    const event = { id: makeID(), senderId: clientId, roomId, type, position, timestamp: Date.now() };
    debug("local", type, event.position);
    chrome.runtime.sendMessage({ kind: "LOCAL_EVENT", event }).catch(() => {});
  }

  function emitLocalEvent(type) {
    if (!roomId || !clientId || !currentVideo || isSuppressed()) {
      if (currentVideo && !isSuppressed()) debug("ignored local event; no active room or client id", type);
      return;
    }
    if (type === "SEEK") { sendLocalEvent(type); return; }
    // Some players (e.g. Prime Video) internally toggle play/pause on the raw
    // <video> element in fast blips unrelated to the viewer (buffering or DRM
    // re-checks). A real pause immediately reversed by a real play looks
    // identical to one of these blips, so briefly hold PLAY/PAUSE before
    // broadcasting; a same-position flip within the window is treated as
    // noise and dropped instead of yanking every other viewer's playback.
    if (pendingPlayback) {
      const wasType = pendingPlayback.type;
      cancelPendingPlayback();
      if (wasType !== type) { debug("ignored transient play/pause blip", wasType, "->", type); return; }
    }
    pendingPlayback = { type, timer: setTimeout(() => { pendingPlayback = null; sendLocalEvent(type); }, PLAYBACK_DEBOUNCE_MS) };
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
    cancelPendingPlayback();
  }

  function selectVideo() {
    // Some players (e.g. Prime Video) keep extra empty <video> placeholders
    // alongside the real player. Only elements with an actual source are
    // candidates; among those, prefer the largest (the real player, not an
    // ad/thumbnail slot).
    const candidates = [...document.querySelectorAll("video")].filter(v => v.currentSrc);
    if (!candidates.length) return null;
    return candidates.reduce((best, v) => (v.videoWidth * v.videoHeight > best.videoWidth * best.videoHeight ? v : best));
  }

  function findVideo() {
    const video = selectVideo();
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
      queueRemoteEvent(event);
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
    try {
      const adapter = new HTML5VideoAdapter(currentVideo);
      if (type === "PLAY") await adapter.play(event.position);
      else if (type === "PAUSE") await adapter.pause(event.position);
      else adapter.seek(event.position);
      debug("remote", type, event.position);
    } catch (error) { console.warn("[GuguTV] remote playback action failed", error); }
    finally {
      applyingRemoteEvent = false;
      // play()/pause() may have spent up to ~450ms retrying against the
      // page's own controller; start the echo-suppression window now, not
      // before the retries, so trailing native events right after we
      // finish are still covered.
      suppressEventsUntil = Date.now() + 500;
    }
  }

  // Remote PLAY/PAUSE/SEEK arrive as separate async messages. Applying them
  // concurrently lets a later pause() abort an in-flight play() (AbortError)
  // and leave playback in whatever order the promises happened to settle,
  // so each one is queued to run only after the previous one fully finishes.
  function queueRemoteEvent(event) {
    eventQueue = eventQueue.then(() => applyRemoteEvent(event));
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.kind === "REMOTE_EVENT") queueRemoteEvent(message.event);
    if (message?.kind === "CONNECTION_STATUS") changeRoom(message.roomId || null);
  });

  chrome.runtime.sendMessage({ kind: "CONTENT_READY" }).then(status => {
    changeRoom(status?.roomId || null);
    clientId = status?.clientId || null;
    debug("ready", { roomId, clientId });
    if (status?.latestEvent) queueRemoteEvent(status.latestEvent);
  }).catch(() => {});
  new MutationObserver(findVideo).observe(document.documentElement, { childList: true, subtree: true });
  // The real <video> element's `src` can populate asynchronously without a
  // DOM mutation the observer above would see (e.g. Prime Video setting a
  // blob URL on an already-present element), so also poll briefly.
  setInterval(findVideo, 1000);
  findVideo();
})();
