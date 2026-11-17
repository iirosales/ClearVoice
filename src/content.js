import { processCaptionEvents } from './caption-processor.js';
import { AudioScheduler } from './audio-scheduler.js';
import { UIInjector } from './ui-injector.js';

(function initClearVoiceContent() {
  if (window.__clearvoiceContentInstalled) return;
  window.__clearvoiceContentInstalled = true;

  const BRIDGE_SOURCE = 'clearvoice-bridge';
  const CONTENT_SOURCE = 'clearvoice-content';
  const DEFAULT_PREFS = { enabled: false, voice: 'af_heart' };

  let prefs = { ...DEFAULT_PREFS };
  let currentVideoId = getVideoIdFromLocation();
  let transcriptAvailable = false;
  let cues = [];
  let modelState = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
  let mutedByClearVoice = false;
  let adShowing = false;

  let observedPlayer = null;
  let playerObserver = null;
  let lastUrl = window.location.href;
  let captionRetryCount = 0;
  let captionRetryTimer = null;

  function clearCaptionRetries() {
    if (captionRetryTimer !== null) {
      clearTimeout(captionRetryTimer);
      captionRetryTimer = null;
    }
  }

  function scheduleCaptionRetry() {
    clearCaptionRetries();
    if (!currentVideoId || transcriptAvailable || captionRetryCount >= 2) return;
    const delayMs = captionRetryCount === 0 ? 1200 : 2000;
    captionRetryCount += 1;
    captionRetryTimer = setTimeout(() => {
      captionRetryTimer = null;
      if (!transcriptAvailable && getVideoIdFromLocation() === currentVideoId) {
        requestCaptionsFromBridge(true);
      }
    }, delayMs);
  }

  function getVideoIdFromLocation() {
    const url = new URL(window.location.href);
    const v = url.searchParams.get('v');
    if (v) return v;
    const shortsMatch = url.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]+)/);
    if (shortsMatch) return shortsMatch[1];
    const liveMatch = url.pathname.match(/^\/live\/([a-zA-Z0-9_-]+)/);
    if (liveMatch) return liveMatch[1];
    return null;
  }

  function getVideoElement() {
    return document.querySelector('#movie_player video.html5-main-video') || document.querySelector('video');
  }

  function getMoviePlayer() {
    return document.querySelector('#movie_player');
  }

  const ui = new UIInjector({
    onToggle: async () => {
      if (!transcriptAvailable || cues.length === 0) return;
      const nextEnabled = !prefs.enabled;
      prefs.enabled = nextEnabled;
      await chrome.storage.local.set({ enabled: nextEnabled });
      applyPlaybackState();
    },
  });

  const scheduler = new AudioScheduler({
    getVoice: () => prefs.voice || 'af_heart',
    synthesizeCue: async ({ text, voice, epoch, priority }) => {
      try {
        return await chrome.runtime.sendMessage({
          target: 'background',
          type: 'CV_SYNTHESIZE',
          text,
          voice,
          epoch,
          priority,
        });
      } catch (err) {
        return { ok: false, status: 'error', error: err?.message || String(err) };
      }
    },
    cancelEpoch: (epoch) => {
      chrome.runtime
        .sendMessage({
          target: 'background',
          type: 'CV_CANCEL_EPOCH',
          epoch,
        })
        .catch(() => {});
    },
    playOffscreenAudio: ({ wavBase64, playbackRate, epoch }) => {
      chrome.runtime
        .sendMessage({
          target: 'background',
          type: 'CV_PLAY_OFFSCREEN_AUDIO',
          wavBase64,
          playbackRate,
          epoch,
        })
        .catch(() => {});
    },
    stopOffscreenAudio: () => {
      chrome.runtime
        .sendMessage({
          target: 'background',
          type: 'CV_STOP_OFFSCREEN_AUDIO',
        })
        .catch(() => {});
    },
    onModelState: (state) => {
      modelState = state;
      scheduler.setModelState(state);
      updateUiButtonState();
    },
  });

  function updateUiButtonState() {
    ui.inject();
    if (!transcriptAvailable || cues.length === 0) {
      ui.setState('disabled');
      return;
    }
    if (!prefs.enabled) {
      ui.setState('off');
      return;
    }
    if (modelState === 'loading') {
      ui.setState('loading');
      return;
    }
    ui.setState('active');
  }

  function ensureModelWarmup() {
    if (modelState === 'ready' || modelState === 'loading') return;
    modelState = 'loading';
    scheduler.setModelState('loading');
    updateUiButtonState();
    chrome.runtime
      .sendMessage({ target: 'background', type: 'CV_INIT_MODEL' })
      .then((res) => {
        if (res?.modelState) {
          modelState = res.modelState;
          scheduler.setModelState(modelState);
          updateUiButtonState();
        }
      })
      .catch(() => {});
  }

  function applyPlaybackState() {
    const video = getVideoElement();
    if (video && scheduler.video !== video) {
      scheduler.attachVideo(video);
    }

    const player = getMoviePlayer();
    adShowing = Boolean(player && player.classList.contains('ad-showing'));

    if (!transcriptAvailable || cues.length === 0) {
      scheduler.stop();
      if (video && mutedByClearVoice) {
        video.muted = false;
      }
      mutedByClearVoice = false;
      updateUiButtonState();
      return;
    }

    if (!prefs.enabled) {
      scheduler.stop();
      if (video) {
        video.muted = false;
      }
      mutedByClearVoice = false;
      updateUiButtonState();
      return;
    }

    if (adShowing) {
      scheduler.setAdPlaying(true);
      if (video && mutedByClearVoice) {
        video.muted = false;
        mutedByClearVoice = false;
      }
      updateUiButtonState();
      return;
    }

    // Active state: mute native video audio and start scheduler + model warmup
    if (video) {
      video.muted = true;
      mutedByClearVoice = true;
    }
    scheduler.setAdPlaying(false);
    ensureModelWarmup();
    if (!scheduler.enabled) {
      scheduler.start();
    } else {
      scheduler.tick();
    }
    updateUiButtonState();
  }

  function observeMoviePlayer() {
    const player = getMoviePlayer();
    if (!player || player === observedPlayer) return;

    if (playerObserver) {
      playerObserver.disconnect();
    }
    observedPlayer = player;
    adShowing = player.classList.contains('ad-showing');

    playerObserver = new MutationObserver(() => {
      ui.inject();
      const video = getVideoElement();
      if (video && scheduler.video !== video) {
        scheduler.attachVideo(video);
      }

      const nextAdShowing = player.classList.contains('ad-showing');
      if (nextAdShowing !== adShowing) {
        adShowing = nextAdShowing;
        applyPlaybackState();
      }
    });

    playerObserver.observe(player, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: true,
    });
  }

  function requestCaptionsFromBridge(force = false) {
    window.postMessage(
      {
        source: CONTENT_SOURCE,
        type: 'CV_REQUEST_CAPTIONS',
        force,
      },
      '*'
    );
  }

  function handleVideoChange() {
    clearCaptionRetries();
    captionRetryCount = 0;
    const nextVideoId = getVideoIdFromLocation();
    currentVideoId = nextVideoId;
    transcriptAvailable = false;
    cues = [];
    scheduler.setCues([]);

    const video = getVideoElement();
    if (video && mutedByClearVoice) {
      video.muted = false;
    }
    mutedByClearVoice = false;

    updateUiButtonState();
    observeMoviePlayer();
    if (nextVideoId) {
      requestCaptionsFromBridge(true);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== BRIDGE_SOURCE || msg.type !== 'CV_CAPTIONS_RESULT') return;

    const activeId = getVideoIdFromLocation();
    if (activeId && msg.videoId && msg.videoId !== activeId) return;

    currentVideoId = msg.videoId || activeId;

    if (!msg.available || !Array.isArray(msg.events)) {
      transcriptAvailable = false;
      cues = [];
      scheduler.setCues([]);
      applyPlaybackState();
      scheduleCaptionRetry();
      return;
    }

    const processed = processCaptionEvents(msg.events);
    if (processed.length === 0) {
      transcriptAvailable = false;
      cues = [];
      scheduler.setCues([]);
      applyPlaybackState();
      scheduleCaptionRetry();
      return;
    }

    clearCaptionRetries();
    transcriptAvailable = true;
    cues = processed;
    scheduler.setCues(processed);
    applyPlaybackState();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.target !== 'content') return false;
    if (message.type === 'CV_STATUS_CHANGED' && message.modelState) {
      modelState = message.modelState;
      scheduler.setModelState(modelState);
      updateUiButtonState();
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    let shouldApply = false;
    if (changes.enabled) {
      prefs.enabled = Boolean(changes.enabled.newValue);
      shouldApply = true;
    }
    if (changes.voice && changes.voice.newValue !== prefs.voice) {
      prefs.voice = changes.voice.newValue || 'af_heart';
      scheduler.setVoice(prefs.voice);
      shouldApply = true;
    }
    if (shouldApply) {
      applyPlaybackState();
    }
  });

  window.addEventListener('yt-navigate-start', () => {
    scheduler.stop();
    const video = getVideoElement();
    if (video && mutedByClearVoice) {
      video.muted = false;
    }
    mutedByClearVoice = false;
  });

  window.addEventListener('yt-navigate-finish', () => {
    lastUrl = window.location.href;
    handleVideoChange();
  });

  let rootCheckTimer = null;
  // Fallback observer for dynamic YouTube DOM mounting & SPA URL transitions
  const rootObserver = new MutationObserver(() => {
    if (rootCheckTimer !== null) return;
    rootCheckTimer = setTimeout(() => {
      rootCheckTimer = null;
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        if (getVideoIdFromLocation() !== currentVideoId) {
          handleVideoChange();
          return;
        }
      }
      observeMoviePlayer();
      ui.inject();
    }, 150);
  });

  async function bootstrap() {
    try {
      const stored = await chrome.storage.local.get(['enabled', 'voice']);
      prefs = {
        enabled: Boolean(stored.enabled),
        voice: stored.voice || 'af_heart',
      };
    } catch {
      prefs = { ...DEFAULT_PREFS };
    }

    try {
      const status = await chrome.runtime.sendMessage({
        target: 'background',
        type: 'CV_GET_STATUS',
      });
      if (status?.modelState) {
        modelState = status.modelState;
        scheduler.setModelState(modelState);
      }
    } catch {
      // Background worker starts on demand
    }

    window.addEventListener('pointerdown', () => scheduler.unlockAudioContext(), {
      capture: true,
      passive: true,
    });
    window.addEventListener('keydown', () => scheduler.unlockAudioContext(), {
      capture: true,
      passive: true,
    });

    observeMoviePlayer();
    ui.inject();
    updateUiButtonState();
    requestCaptionsFromBridge(false);

    if (document.body) {
      rootObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  bootstrap();
})();
