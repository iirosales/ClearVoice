(function initClearVoiceYtBridge() {
  if (window.__clearvoiceBridgeInstalled) return;
  window.__clearvoiceBridgeInstalled = true;

  const BRIDGE_SOURCE = 'clearvoice-bridge';
  const CONTENT_SOURCE = 'clearvoice-content';
  const STEALTH_STYLE_ID = 'clearvoice-stealth-style';
  const STEALTH_CLASS = 'cv-stealth-captions';

  const cachedSignedUrls = new Map();
  const cachedPotByVideo = new Map();
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

  function ensureStealthStyle() {
    if (document.getElementById(STEALTH_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STEALTH_STYLE_ID;
    style.textContent = `
      html.${STEALTH_CLASS} #movie_player .ytp-caption-window-container {
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
    (document.head || document.documentElement)?.appendChild(style);
  }

  function postToContent(payload) {
    if (
      payload.type === 'CV_CAPTIONS_RESULT' &&
      payload.videoId &&
      payload.available === true &&
      Array.isArray(payload.events) &&
      payload.events.length > 0
    ) {
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

  function buildSignedTrackUrl(trackUrl, videoId) {
    const url = new URL(trackUrl, window.location.origin);
    url.searchParams.set('fmt', 'json3');
    const potMeta = cachedPotByVideo.get(videoId);
    if (potMeta?.pot && !url.searchParams.get('pot')) {
      url.searchParams.set('pot', potMeta.pot);
      if (potMeta.c && !url.searchParams.get('c')) {
        url.searchParams.set('c', potMeta.c);
      }
      if (potMeta.cver && !url.searchParams.get('cver')) {
        url.searchParams.set('cver', potMeta.cver);
      }
    }
    return url.toString();
  }

  function captureTimedtextUrl(rawUrl, jsonPayload) {
    try {
      const parsed = new URL(rawUrl, window.location.origin);
      if (!parsed.pathname.includes('/api/timedtext')) return;
      const v = parsed.searchParams.get('v') || getCurrentVideoId();
      if (!v) return;

      const pot = parsed.searchParams.get('pot');
      if (pot) {
        cachedPotByVideo.set(v, {
          pot,
          c: parsed.searchParams.get('c') || '',
          cver: parsed.searchParams.get('cver') || '',
        });
      }

      const lang = parsed.searchParams.get('lang') || '';
      if (!/^en(?:-|$)/i.test(lang)) return;

      parsed.searchParams.set('fmt', 'json3');
      const signedUrl = parsed.toString();
      cachedSignedUrls.set(v, signedUrl);

      const trackKind = parsed.searchParams.get('kind') === 'asr' ? 'asr' : 'manual';

      if (jsonPayload && Array.isArray(jsonPayload.events) && jsonPayload.events.length > 0) {
        cachedJson3ByVideo.set(v, {
          events: jsonPayload.events,
          languageCode: lang,
          trackKind,
        });

        if (v === getCurrentVideoId() && !lastResultByVideo.has(v)) {
          lastDispatchedKey = `${v}:${lang}:${trackKind}`;
          postToContent({
            type: 'CV_CAPTIONS_RESULT',
            available: true,
            videoId: v,
            trackKind,
            languageCode: lang,
            events: jsonPayload.events,
          });
        }
      } else if (pot && v === getCurrentVideoId() && !lastResultByVideo.has(v)) {
        // Player requested srv3/vtt with pot; fetch json3 using the signed URL immediately
        fetchJson3Events(signedUrl)
          .then((events) => {
            if (events.length > 0 && v === getCurrentVideoId() && !lastResultByVideo.has(v)) {
              cachedJson3ByVideo.set(v, {
                events,
                languageCode: lang,
                trackKind,
              });
              lastDispatchedKey = `${v}:${lang}:${trackKind}`;
              postToContent({
                type: 'CV_CAPTIONS_RESULT',
                available: true,
                videoId: v,
                trackKind,
                languageCode: lang,
                events,
              });
            }
          })
          .catch(() => {});
      }
    } catch {
      // Ignore malformed URLs
    }
  }

  // Intercept fetch & XHR for /api/timedtext to capture signed URLs and pot tokens
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function wrappedFetch(input) {
      const urlStr = typeof input === 'string' ? input : input?.url || '';
      const response = await originalFetch.apply(this, arguments);
      if (urlStr.includes('/api/timedtext')) {
        try {
          const clone = response.clone();
          const text = await clone.text();
          if (text && text.trim().startsWith('{')) {
            captureTimedtextUrl(urlStr, JSON.parse(text));
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
  XMLHttpRequest.prototype.open = function wrappedOpen(_method, url) {
    this.__cvUrl = typeof url === 'string' ? url : '';
    return origXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function wrappedSend() {
    if (this.__cvUrl && this.__cvUrl.includes('/api/timedtext')) {
      this.addEventListener('load', () => {
        try {
          let parsed = null;
          if (this.responseType === 'json' && this.response) {
            parsed = this.response;
          } else if (
            (!this.responseType || this.responseType === 'text') &&
            typeof this.responseText === 'string' &&
            this.responseText.trim().startsWith('{')
          ) {
            parsed = JSON.parse(this.responseText);
          }
          captureTimedtextUrl(this.__cvUrl, parsed);
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

  function hasCaptionTracks(resp) {
    const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return Array.isArray(tracks) && tracks.length > 0;
  }

  function getPlayerResponseForVideo(videoId) {
    let playerResp = null;
    const player = document.querySelector('#movie_player');
    if (player && typeof player.getPlayerResponse === 'function') {
      try {
        const resp = player.getPlayerResponse();
        if (resp && resp.videoDetails?.videoId === videoId) {
          playerResp = resp;
        }
      } catch {
        // Ignore transient player access errors
      }
    }

    const initial = window.ytInitialPlayerResponse;
    const initialMatches =
      initial && initial.videoDetails?.videoId === videoId ? initial : null;

    if (playerResp && hasCaptionTracks(playerResp)) return playerResp;
    if (initialMatches && hasCaptionTracks(initialMatches)) return initialMatches;

    return playerResp || initialMatches || null;
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

  async function waitForPlayerResponse(videoId, maxWaitMs = 6000) {
    const start = Date.now();
    let bestResp = null;
    while (Date.now() - start < maxWaitMs) {
      if (getCurrentVideoId() !== videoId) return null;
      const resp = getPlayerResponseForVideo(videoId);
      if (resp) {
        bestResp = resp;
        if (hasCaptionTracks(resp) || Date.now() - start >= 2500) {
          return resp;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return getPlayerResponseForVideo(videoId) || bestResp;
  }

  async function pollForSignedCaption(videoId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (getCurrentVideoId() !== videoId) return false;
      if (
        cachedSignedUrls.has(videoId) ||
        cachedPotByVideo.has(videoId) ||
        cachedJson3ByVideo.has(videoId)
      ) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return false;
  }

  /**
   * When YouTube enforces POT (exp=xpe) on /api/timedtext, direct fetches return 0 bytes
   * until #movie_player triggers a caption request with its Proof-of-Origin token.
   */
  async function triggerPlayerTimedtextFetch(videoId, selectedTrack) {
    const player = document.querySelector('#movie_player');
    if (!player) return false;

    ensureStealthStyle();
    document.documentElement.classList.add(STEALTH_CLASS);

    try {
      try {
        player.loadModule?.('captions');
        player.setOption?.('captions', 'track', {
          languageCode: selectedTrack.languageCode || 'en',
          kind: selectedTrack.kind || '',
        });
      } catch {
        // Ignore if player captions module API is restricted
      }

      if (await pollForSignedCaption(videoId, 600)) {
        return true;
      }

      const subBtn = player.querySelector('.ytp-subtitles-button');
      if (!subBtn) return false;

      const wasPressed = subBtn.getAttribute('aria-pressed') === 'true';
      if (!wasPressed) {
        subBtn.click();
        const gotToken = await pollForSignedCaption(videoId, 1800);
        if (subBtn.getAttribute('aria-pressed') === 'true') {
          subBtn.click();
        }
        return gotToken;
      }

      subBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      subBtn.click();
      return await pollForSignedCaption(videoId, 1800);
    } finally {
      setTimeout(() => {
        document.documentElement.classList.remove(STEALTH_CLASS);
      }, 150);
    }
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
      postToContent({
        type: 'CV_CAPTIONS_RESULT',
        available: false,
        videoId,
      });
      return;
    }

    const dispatchKey = `${videoId}:${selectedTrack.languageCode}:${selectedTrack.kind || 'manual'}`;
    if (!force && dispatchKey === lastDispatchedKey) return;

    try {
      const initialUrl = buildSignedTrackUrl(selectedTrack.baseUrl, videoId);
      let events = await fetchJson3Events(initialUrl);

      if (events.length === 0 && cachedSignedUrls.has(videoId)) {
        events = await fetchJson3Events(cachedSignedUrls.get(videoId));
      }

      if (events.length === 0) {
        const alreadyPublishedBeforeTrigger = lastResultByVideo.has(videoId);
        await triggerPlayerTimedtextFetch(videoId, selectedTrack);
        if (token !== currentExtractionToken || getCurrentVideoId() !== videoId) return;

        // If captureTimedtextUrl already pushed fresh captions to content.js during trigger, avoid duplicate reset
        if (!alreadyPublishedBeforeTrigger && lastResultByVideo.has(videoId)) {
          return;
        }

        const liveCached = cachedJson3ByVideo.get(videoId);
        if (liveCached && liveCached.events.length > 0) {
          events = liveCached.events;
        } else {
          const signedUrl =
            cachedSignedUrls.get(videoId) || buildSignedTrackUrl(selectedTrack.baseUrl, videoId);
          events = await fetchJson3Events(signedUrl);
        }
      }

      if (token !== currentExtractionToken || getCurrentVideoId() !== videoId) return;

      if (events.length === 0) {
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
