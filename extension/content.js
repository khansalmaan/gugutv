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

  // The first few minutes of a video's timeline are the least trustworthy to
  // sync: ads land on early landing points (0/10/15/20/30s), and a trailer
  // or preview can still be attached to (or briefly race with the real
  // player, see selectVideo()). Rather than chase every individual case,
  // ignore any event under this mark outright — trailers/previews run a
  // couple of minutes at most, so real content is essentially never
  // legitimately paused/sought/played this early.
  const MIN_SYNC_POSITION_SECONDS = 120;
  const isUnsyncedPosition = (position) => position < MIN_SYNC_POSITION_SECONDS;

  // If the extension is reloaded/updated while this tab is already open, the
  // content script's channel to the background script is permanently severed
  // ("Extension context invalidated") — there is no way to reconnect it from
  // here, only a page reload creates a fresh, valid content script. Without
  // this banner that failure is silent: sync just stops working with no clue
  // why.
  function showReloadNeededBanner() {
    if (document.getElementById("gugutv-reload-banner")) return;
    const banner = document.createElement("div");
    banner.id = "gugutv-reload-banner";
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;gap:12px;background:#dc2626;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:10px 16px;";
    const text = document.createElement("span");
    text.textContent = "GuguTV lost connection to the extension. Refresh this page to restore sync.";
    const reload = document.createElement("button");
    reload.textContent = "Refresh now";
    reload.style.cssText = "border:none;border-radius:6px;padding:6px 12px;background:#fff;color:#dc2626;font:inherit;font-weight:700;cursor:pointer;";
    reload.addEventListener("click", () => location.reload());
    banner.append(text, reload);
    document.documentElement.appendChild(banner);
  }

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
      for (let attempt = 0; attempt < 3 && this.video.paused; attempt++) {
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
      for (let attempt = 0; attempt < 3 && !this.video.paused; attempt++) {
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
    if (isUnsyncedPosition(position)) { debug("ignored event before the 2-minute mark", type, position); return; }
    const event = { id: makeID(), senderId: clientId, roomId, type, position, timestamp: Date.now() };
    debug("local", type, event.position);
    chrome.runtime.sendMessage({ kind: "LOCAL_EVENT", event }).catch(showReloadNeededBanner);
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
    // alongside the real player, and can also autoplay a trailer/preview on
    // a title's detail page right before the actual movie starts. Only
    // elements with an actual source are candidates; among those, prefer
    // the longest duration (a trailer runs a couple of minutes, the real
    // movie/episode runs much longer — a behavioral signal that holds
    // regardless of any site's DOM structure), falling back to the largest
    // by area when duration isn't known yet (e.g. metadata still loading).
    const candidates = [...document.querySelectorAll("video")].filter(v => v.currentSrc);
    if (!candidates.length) return null;
    return candidates.reduce((best, v) => {
      const bestDuration = Number.isFinite(best.duration) ? best.duration : 0;
      const duration = Number.isFinite(v.duration) ? v.duration : 0;
      if (duration !== bestDuration) return duration > bestDuration ? v : best;
      return v.videoWidth * v.videoHeight > best.videoWidth * best.videoHeight ? v : best;
    });
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

  function refreshVideoSync() {
    debug("manual refresh requested; reattaching video listeners");
    // detachVideo() nulls out currentVideo, so the next findVideo() call
    // reattaches even if selectVideo() finds the exact same element.
    detachVideo();
    findVideo();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.kind === "REMOTE_EVENT") queueRemoteEvent(message.event);
    if (message?.kind === "CONNECTION_STATUS") changeRoom(message.roomId || null);
    if (message?.kind === "REFRESH_SYNC") refreshVideoSync();
  });

  chrome.runtime.sendMessage({ kind: "CONTENT_READY" }).then(status => {
    changeRoom(status?.roomId || null);
    clientId = status?.clientId || null;
    debug("ready", { roomId, clientId });
    if (!clientId) showReloadNeededBanner();
    if (status?.latestEvent) queueRemoteEvent(status.latestEvent);
  }).catch(showReloadNeededBanner);
  new MutationObserver(findVideo).observe(document.documentElement, { childList: true, subtree: true });
  // The real <video> element's `src` can populate asynchronously without a
  // DOM mutation the observer above would see (e.g. Prime Video setting a
  // blob URL on an already-present element), so also poll briefly.
  setInterval(findVideo, 1000);
  findVideo();
})();
