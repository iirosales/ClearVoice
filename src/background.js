const OFFSCREEN_URL = 'offscreen.html';

let offscreenCreatingPromise = null;
let cachedStatus = {
  modelState: 'idle',
  activeDevice: null,
  loadProgress: 0,
  lastError: null,
};

async function hasOffscreenDocument() {
  if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return contexts.length > 0;
  }

  const allClients = await self.clients.matchAll();
  const targetUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  return allClients.some((client) => client.url === targetUrl);
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  if (!offscreenCreatingPromise) {
    offscreenCreatingPromise = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['AUDIO_PLAYBACK', 'WORKERS'],
        justification: 'Run local Kokoro-82M neural TTS inference in WebGPU/WASM',
      })
      .finally(() => {
        offscreenCreatingPromise = null;
      });
  }

  await offscreenCreatingPromise;
}

async function sendToOffscreen(payload) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({
    ...payload,
    target: 'offscreen',
  });
}

function broadcastStatusToTabsAndPopups(status) {
  chrome.runtime
    .sendMessage({
      target: 'popup',
      type: 'CV_STATUS_CHANGED',
      ...status,
    })
    .catch(() => {});

  chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
    for (const tab of tabs || []) {
      if (typeof tab.id === 'number') {
        chrome.tabs
          .sendMessage(tab.id, {
            target: 'content',
            type: 'CV_STATUS_CHANGED',
            ...status,
          })
          .catch(() => {});
      }
    }
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;

  if (message.target === 'background' && message.type === 'CV_MODEL_STATUS_UPDATE') {
    cachedStatus = {
      modelState: message.modelState || cachedStatus.modelState,
      activeDevice: message.activeDevice ?? cachedStatus.activeDevice,
      loadProgress: message.loadProgress ?? cachedStatus.loadProgress,
      lastError: message.lastError ?? null,
    };
    broadcastStatusToTabsAndPopups(cachedStatus);
    sendResponse({ ok: true });
    return false;
  }

  if (message.target && message.target !== 'background') {
    return false;
  }

  if (message.type === 'CV_INIT_MODEL') {
    sendToOffscreen({ type: 'CV_OFFSCREEN_INIT' })
      .then((res) => {
        if (res) {
          cachedStatus = {
            modelState: res.modelState || cachedStatus.modelState,
            activeDevice: res.activeDevice ?? cachedStatus.activeDevice,
            loadProgress: res.loadProgress ?? cachedStatus.loadProgress,
            lastError: res.error ?? null,
          };
        }
        sendResponse(res || { ok: false });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }

  if (message.type === 'CV_SYNTHESIZE') {
    sendToOffscreen({
      type: 'CV_OFFSCREEN_SYNTHESIZE',
      text: message.text,
      voice: message.voice,
      epoch: message.epoch,
      priority: message.priority || 'normal',
      waitForReady: Boolean(message.waitForReady),
    })
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ ok: false, status: 'error', error: err?.message || String(err) });
      });
    return true;
  }

  if (message.type === 'CV_PLAY_OFFSCREEN_AUDIO') {
    sendToOffscreen({
      type: 'CV_OFFSCREEN_PLAY_AUDIO',
      wavBase64: message.wavBase64,
      playbackRate: message.playbackRate,
      epoch: message.epoch,
    })
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }

  if (message.type === 'CV_STOP_OFFSCREEN_AUDIO') {
    hasOffscreenDocument()
      .then((exists) => {
        if (!exists) return { ok: true };
        return sendToOffscreen({ type: 'CV_OFFSCREEN_STOP_AUDIO' });
      })
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'CV_CANCEL_EPOCH') {
    hasOffscreenDocument()
      .then((exists) => {
        if (!exists) return { ok: true };
        return sendToOffscreen({
          type: 'CV_OFFSCREEN_CANCEL_EPOCH',
          epoch: message.epoch,
        });
      })
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }

  if (message.type === 'CV_GET_STATUS') {
    hasOffscreenDocument()
      .then(async (exists) => {
        if (!exists) return { ok: true, ...cachedStatus };
        const live = await sendToOffscreen({ type: 'CV_OFFSCREEN_STATUS' });
        if (live?.ok) {
          cachedStatus = {
            modelState: live.modelState,
            activeDevice: live.activeDevice,
            loadProgress: live.loadProgress,
            lastError: live.lastError,
          };
        }
        return { ok: true, ...cachedStatus };
      })
      .then(sendResponse)
      .catch(() => {
        sendResponse({ ok: true, ...cachedStatus });
      });
    return true;
  }

  return false;
});
