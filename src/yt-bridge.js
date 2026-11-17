(function initClearVoiceYtBridge() {
  if (window.__clearvoiceBridgeInstalled) return;
  window.__clearvoiceBridgeInstalled = true;

  const BRIDGE_SOURCE = 'clearvoice-bridge';
  const CONTENT_SOURCE = 'clearvoice-content';

  const cachedSignedUrls = new Map();
  const cachedJson3ByVideo = new Map();
  const lastResultByVideo = new Map();

  let currentExtractionToken = 0;
  let lastDispatchedKey = '';

  function getCurrentVideoId() {
    const url = new URL(window.location.href);
    const vParam = url.searchParams.get('v');
    if (vParam) return vParam;

    const shortsMatch = url.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]+)/);
    if (shortsMatch) return shortsMatch[1];

    const liveMatch = url.pathname.match(/^\/live\/([a-zA-Z0-9_-]+)/);
    if (liveMatch) return liveMatch[1];

    return null;
  }

  function postToContent(payload) {
    if (payload.type === 'CV_CAPTIONS_RESULT' && payload.videoId) {
      lastResultByVideo.set(payload.videoId, payload);
    }
    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        ...payload,
      },
      '*'
    );
  }

  function captureTimedtextUrl(rawUrl, jsonPayload) {
    try {
      const parsed = new URL(rawUrl, window.location.origin);
      if (!parsed.pathname.includes('/api/timedtext')) return;
      const v = parsed.searchParams.get('v') || getCurrentVideoId();
      const lang = parsed.searchParams.get('lang') || '';
      if (!v || !/^en(?:-|$)/i.test(lang)) return;

      parsed.searchParams.set('fmt', 'json3');
      cachedSignedUrls.set(v, parsed.toString());

      if (jsonPayload && Array.isArray(jsonPayload.events)) {
        cachedJson3ByVideo.set(v, {
          events: jsonPayload.events,
          languageCode: lang,
          trackKind: parsed.searchParams.get('kind') === 'asr' ? 'asr' : 'manual',
        });
      }
    } catch {
      // Ignore malformed URLs
    }
  }

  // Intercept fetch & XHR for /api/timedtext to reuse signed player URLs if present
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function wrappedFetch(input, init) {
      const urlStr = typeof input === 'string' ? input : input?.url || '';
      const response = await originalFetch.apply(this, arguments);
      if (urlStr.includes('/api/timedtext')) {
        try {
          const clone = response.clone();
          const text = await clone.text();
          if (text) {
            const parsed = JSON.parse(text);
            captureTimedtextUrl(urlStr, parsed);
          } else {
            captureTimedtextUrl(urlStr, null);
          }
        } catch {
          captureTimedtextUrl(urlStr, null);
        }
      }
      return response;
    };
  }

  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function wrappedOpen(method, url) {
    this.__cvUrl = typeof url === 'string' ? url : '';
    return origXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function wrappedSend() {
    if (this.__cvUrl && this.__cvUrl.includes('/api/timedtext')) {
      this.addEventListener('load', () => {
        try {
          const text = typeof this.responseText === 'string' ? this.responseText : '';
          if (text) {
            captureTimedtextUrl(this.__cvUrl, JSON.parse(text));
          } else {
            captureTimedtextUrl(this.__cvUrl, null);
          }
        } catch {
          captureTimedtextUrl(this.__cvUrl, null);
        }
      });
    }
    return origXhrSend.apply(this, arguments);
  };

  function selectBestEnglishTrack(tracks) {
    if (!Array.isArray(tracks) || tracks.length === 0) return null;

    const englishTracks = tracks.filter((t) =>
      /^en(?:-|$)/i.test(String(t?.languageCode || ''))
    );
    if (englishTracks.length === 0) return null;

    const scoreTrack = (track) => {
      let score = 0;
      if (track.kind !== 'asr') score += 100; // Prefer manual over auto-generated
      const code = String(track.languageCode || '').toLowerCase();
      if (code === 'en') score += 20;
      else if (code === 'en-us') score += 15;
      else if (code === 'en-gb') score += 10;
      return score;
    };

    return englishTracks.slice().sort((a, b) => scoreTrack(b) - scoreTrack(a))[0];
  }

  function getPlayerResponseForVideo(videoId) {
    const player = document.querySelector('#movie_player');
    if (player && typeof player.getPlayerResponse === 'function') {
      try {
        const resp = player.getPlayerResponse();
        if (resp && (!resp.videoDetails?.videoId || resp.videoDetails.videoId === videoId)) {
          return resp;
        }
      } catch {
        // Ignore transient player access errors
      }
    }

    const initial = window.ytInitialPlayerResponse;
    if (initial && (!initial.videoDetails?.videoId || initial.videoDetails.videoId === videoId)) {
      return initial;
    }

    return null;
  }

  async function fetchJson3Events(trackUrl) {
    const url = new URL(trackUrl, window.location.origin);
    url.searchParams.set('fmt', 'json3');

    const response = await fetch(url.toString(), {
      credentials: 'include',
    });
    if (!response.ok) {
      throw new Error(`Timedtext HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text || !text.trim()) {
      return [];
    }

    const data = JSON.parse(text);
    return Array.isArray(data?.events) ? data.events : [];
  }

  async function waitForPlayerResponse(videoId, maxWaitMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (getCurrentVideoId() !== videoId) return null;
      const resp = getPlayerResponseForVideo(videoId);
      if (resp) return resp;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return getPlayerResponseForVideo(videoId);
  }

  async function extractAndPublishCaptions({ force = false } = {}) {
    const videoId = getCurrentVideoId();
    if (!videoId) return;

    const token = ++currentExtractionToken;
    const playerResponse = await waitForPlayerResponse(videoId);
    if (token !== currentExtractionToken || getCurrentVideoId() !== videoId) return;

    const cached = cachedJson3ByVideo.get(videoId);
    if (cached && cached.events.length > 0 && !force) {
      const dispatchKey = `${videoId}:cached:${cached.events.length}`;
      if (dispatchKey !== lastDispatchedKey) {
        lastDispatchedKey = dispatchKey;
        postToContent({
          type: 'CV_CAPTIONS_RESULT',
          available: true,
          videoId,
          trackKind: cached.trackKind,
          languageCode: cached.languageCode,
          events: cached.events,
        });
      }
      return;
    }

    const tracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const selectedTrack = selectBestEnglishTrack(tracks);

    if (!selectedTrack || !selectedTrack.baseUrl) {
      const dispatchKey = `${videoId}:none`;
      if (force || dispatchKey !== lastDispatchedKey) {
        lastDispatchedKey = dispatchKey;
        postToContent({
          type: 'CV_CAPTIONS_RESULT',
          available: false,
          videoId,
        });
      }
      return;
    }

    const dispatchKey = `${videoId}:${selectedTrack.languageCode}:${selectedTrack.kind || 'manual'}`;
    if (!force && dispatchKey === lastDispatchedKey) return;

    try {
      let events = await fetchJson3Events(selectedTrack.baseUrl);
      if (events.length === 0 && cachedSignedUrls.has(videoId)) {
        events = await fetchJson3Events(cachedSignedUrls.get(videoId));
      }

      if (token !== currentExtractionToken || getCurrentVideoId() !== videoId) return;

      if (events.length === 0) {
        lastDispatchedKey = `${videoId}:empty`;
        postToContent({
          type: 'CV_CAPTIONS_RESULT',
          available: false,
          videoId,
        });
        return;
      }

      lastDispatchedKey = dispatchKey;
      postToContent({
        type: 'CV_CAPTIONS_RESULT',
        available: true,
        videoId,
        trackKind: selectedTrack.kind === 'asr' ? 'asr' : 'manual',
        languageCode: selectedTrack.languageCode || 'en',
        events,
      });
    } catch (err) {
      if (token !== currentExtractionToken || getCurrentVideoId() !== videoId) return;
      postToContent({
        type: 'CV_CAPTIONS_RESULT',
        available: false,
        videoId,
        error: err?.message || 'Failed to fetch captions',
      });
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== CONTENT_SOURCE) return;

    if (msg.type === 'CV_REQUEST_CAPTIONS') {
      const videoId = getCurrentVideoId();
      if (!msg.force && videoId && lastResultByVideo.has(videoId)) {
        postToContent(lastResultByVideo.get(videoId));
        return;
      }
      extractAndPublishCaptions({ force: Boolean(msg.force) });
    }
  });

  window.addEventListener('yt-navigate-finish', () => {
    lastDispatchedKey = '';
    setTimeout(() => extractAndPublishCaptions({ force: true }), 120);
  });

  window.addEventListener('yt-page-data-updated', () => {
    setTimeout(() => extractAndPublishCaptions({ force: false }), 100);
  });

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => extractAndPublishCaptions({ force: false }),
      { once: true }
    );
  } else {
    extractAndPublishCaptions({ force: false });
  }
})();
