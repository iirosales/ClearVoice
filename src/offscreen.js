import { KokoroTTS, env } from 'kokoro-js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const BUNDLED_VOICES = new Set([
  'af_heart.bin',
  'af_bella.bin',
  'am_adam.bin',
  'am_michael.bin',
  'bf_emma.bin',
  'bm_george.bin',
]);

// Serve bundled voice embeddings locally before hitting Hugging Face Hub
const rawFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const match = url.match(/\/voices\/([a-z0-9_]+\.bin)(?:\?.*)?$/i);
  if (match && BUNDLED_VOICES.has(match[1])) {
    try {
      const localRes = await rawFetch(chrome.runtime.getURL(`voices/${match[1]}`));
      if (localRes.ok) return localRes;
    } catch {
      // Fall back to network fetch if local asset lookup fails
    }
  }
  return rawFetch(input, init);
};

// Ensure ONNX Runtime Web loads WASM and worker modules from extension bundle (MV3 CSP compliant)
env.wasmPaths = chrome.runtime.getURL('wasm/');

let ttsInstance = null;
let initPromise = null;
let modelState = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
let activeDevice = null; // 'webgpu' | 'wasm' | null
let lastError = null;
let loadProgress = 0;

let cancelledEpoch = 0;
let queueChain = Promise.resolve();

function broadcastStatus() {
  chrome.runtime
    .sendMessage({
      target: 'background',
      type: 'CV_MODEL_STATUS_UPDATE',
      modelState,
      activeDevice,
      loadProgress,
      lastError,
    })
    .catch(() => {
      // Background worker may be waking up or idle; ignore transient delivery failure
    });
}

function encodeWavBase64(float32Samples, sampleRate) {
  const numSamples = float32Samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeAscii = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // AudioFormat: PCM
  view.setUint16(22, 1, true); // NumChannels: Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  writeAscii(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, float32Samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function detectWebGpuAvailable() {
  if (!navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

async function loadModelWithDevice(device) {
  const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: 'q8',
    device,
    progress_callback: (info) => {
      if (info && typeof info.progress === 'number') {
        loadProgress = Math.round(info.progress);
        broadcastStatus();
      }
    },
  });

  // Smoke-test actual inference before reporting Ready (catches WebGPU q8 kernel failures)
  const testAudio = await tts.generate('Hi', { voice: 'af_heart' });
  if (!testAudio?.audio?.length || Number.isNaN(testAudio.audio[0])) {
    throw new Error(`Invalid audio output from ${device} backend`);
  }
  return tts;
}

async function ensureKokoroReady() {
  if (ttsInstance && modelState === 'ready') return ttsInstance;
  if (initPromise) return initPromise;

  modelState = 'loading';
  lastError = null;
  loadProgress = 0;
  broadcastStatus();

  initPromise = (async () => {
    try {
      const hasWebGpu = await detectWebGpuAvailable();
      if (hasWebGpu) {
        try {
          ttsInstance = await loadModelWithDevice('webgpu');
          activeDevice = 'webgpu';
        } catch (gpuErr) {
          console.warn('[ClearVoice] WebGPU load failed, falling back to WASM:', gpuErr);
          ttsInstance = await loadModelWithDevice('wasm');
          activeDevice = 'wasm';
        }
      } else {
        ttsInstance = await loadModelWithDevice('wasm');
        activeDevice = 'wasm';
      }

      modelState = 'ready';
      loadProgress = 100;
      broadcastStatus();
      return ttsInstance;
    } catch (err) {
      modelState = 'error';
      lastError = err?.message || String(err);
      ttsInstance = null;
      initPromise = null;
      broadcastStatus();
      throw err;
    }
  })();

  return initPromise;
}

function enqueueSynthesis({ text, voice, epoch }) {
  if (modelState !== 'ready' || !ttsInstance) {
    // Start loading in background while returning loading status immediately for Web Speech fallback
    ensureKokoroReady().catch(() => {});
    return Promise.resolve({
      ok: false,
      status: modelState === 'error' ? 'error' : 'loading',
      modelState,
      activeDevice,
      error: lastError,
    });
  }

  if (typeof epoch === 'number' && epoch < cancelledEpoch) {
    return Promise.resolve({ ok: false, status: 'cancelled' });
  }

  const task = queueChain.then(async () => {
    if (typeof epoch === 'number' && epoch < cancelledEpoch) {
      return { ok: false, status: 'cancelled' };
    }

    const cleanText = String(text || '').trim();
    if (!cleanText) {
      return { ok: false, status: 'empty' };
    }

    const selectedVoice = voice || 'af_heart';
    let rawAudio;
    try {
      rawAudio = await ttsInstance.generate(cleanText, { voice: selectedVoice });
    } catch (err) {
      if (activeDevice === 'webgpu') {
        console.warn('[ClearVoice] WebGPU inference failed, switching to WASM:', err);
        ttsInstance = await loadModelWithDevice('wasm');
        activeDevice = 'wasm';
        broadcastStatus();
        rawAudio = await ttsInstance.generate(cleanText, { voice: selectedVoice });
      } else {
        throw err;
      }
    }

    if (typeof epoch === 'number' && epoch < cancelledEpoch) {
      return { ok: false, status: 'cancelled' };
    }

    const samples = rawAudio?.audio;
    const sampleRate = rawAudio?.sampling_rate || 24000;
    if (!samples || samples.length === 0) {
      return { ok: false, status: 'empty' };
    }

    const wavBase64 = encodeWavBase64(samples, sampleRate);
    const durationSec = samples.length / sampleRate;

    return {
      ok: true,
      status: 'ready',
      wavBase64,
      sampleRate,
      durationSec,
      activeDevice,
    };
  });

  // Prevent failed synthesis from poisoning the queue
  queueChain = task.catch(() => {});
  return task;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;

  if (message.type === 'CV_OFFSCREEN_INIT') {
    ensureKokoroReady()
      .then(() => {
        sendResponse({
          ok: true,
          modelState,
          activeDevice,
          loadProgress,
        });
      })
      .catch((err) => {
        sendResponse({
          ok: false,
          modelState,
          activeDevice,
          error: err?.message || String(err),
        });
      });
    return true;
  }

  if (message.type === 'CV_OFFSCREEN_SYNTHESIZE') {
    enqueueSynthesis(message)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({
          ok: false,
          status: 'error',
          error: err?.message || String(err),
        });
      });
    return true;
  }

  if (message.type === 'CV_OFFSCREEN_CANCEL_EPOCH') {
    if (typeof message.epoch === 'number' && message.epoch > cancelledEpoch) {
      cancelledEpoch = message.epoch;
    }
    sendResponse({ ok: true, cancelledEpoch });
    return false;
  }

  if (message.type === 'CV_OFFSCREEN_STATUS') {
    sendResponse({
      ok: true,
      modelState,
      activeDevice,
      loadProgress,
      lastError,
    });
    return false;
  }

  return false;
});
