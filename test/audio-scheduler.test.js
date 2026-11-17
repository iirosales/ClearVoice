import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioScheduler, calculateTtsPlaybackRate } from '../src/audio-scheduler.js';

function createFakeVideo(initialTime = 0, playbackRate = 1) {
  const listeners = new Map();
  return {
    currentTime: initialTime,
    playbackRate,
    paused: false,
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    removeEventListener(name, fn) {
      const list = listeners.get(name) || [];
      listeners.set(
        name,
        list.filter((f) => f !== fn)
      );
    },
    emit(name) {
      for (const fn of listeners.get(name) || []) fn();
    },
  };
}

function createFakeAudioContext() {
  let time = 10;
  const createdSources = [];
  let suspendedCount = 0;
  let resumedCount = 0;

  return {
    state: 'running',
    destination: {},
    get currentTime() {
      return time;
    },
    set currentTime(val) {
      time = val;
    },
    get suspendedCount() {
      return suspendedCount;
    },
    get resumedCount() {
      return resumedCount;
    },
    createdSources,
    async suspend() {
      this.state = 'suspended';
      suspendedCount += 1;
    },
    async resume() {
      this.state = 'running';
      resumedCount += 1;
    },
    async decodeAudioData() {
      return { duration: 2.0 };
    },
    createBufferSource() {
      const node = {
        buffer: null,
        playbackRate: { value: 1 },
        startedAt: null,
        stopped: false,
        onended: null,
        connect() {},
        disconnect() {},
        start(when = 0) {
          this.startedAt = when;
        },
        stop() {
          this.stopped = true;
        },
      };
      createdSources.push(node);
      return node;
    },
  };
}

test('calculateTtsPlaybackRate keeps natural speed when audio fits window and gently caps speedup', () => {
  assert.equal(calculateTtsPlaybackRate(2.0, 2.0, 1.0), 1.0);
  assert.equal(calculateTtsPlaybackRate(1.0, 2.0, 1.0), 1.0); // does not artificially slow down
  assert.equal(calculateTtsPlaybackRate(2.3, 2.0, 1.0), 1.15); // gentle catch-up
  assert.equal(calculateTtsPlaybackRate(4.0, 2.0, 1.0), 1.22); // capped at 1.22x at 1x speed
  assert.equal(calculateTtsPlaybackRate(2.0, 2.0, 1.25), 1.25);
  assert.equal(calculateTtsPlaybackRate(2.0, 2.0, 1.5), 1.45);
  assert.equal(calculateTtsPlaybackRate(2.0, 2.0, 2.0), 1.45);
});

test('AudioScheduler delays overlapping subsequent cue by 50ms', async () => {
  const video = createFakeVideo(0, 1.0);
  const audioCtx = createFakeAudioContext();
  const dummyBase64 = Buffer.from('RIFFtest').toString('base64');

  const scheduler = new AudioScheduler({
    video,
    initialModelState: 'ready',
    createAudioContext: () => audioCtx,
    speechSynthesis: null,
    synthesizeCue: async () => ({
      ok: true,
      status: 'ready',
      wavBase64: dummyBase64,
      durationSec: 2.0,
    }),
  });

  scheduler.setCues([
    { id: 0, text: 'Cue zero', startSec: 0, endSec: 2.0, durationSec: 2.0 },
    { id: 1, text: 'Cue one', startSec: 1.7, endSec: 3.7, durationSec: 2.0 },
  ]);

  scheduler.start();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(audioCtx.createdSources.length, 1);
  assert.equal(audioCtx.createdSources[0].startedAt, 10);

  // Move video to cue 1 while cue 0 is still finishing (ends at 12.0, current audioTime = 11.7)
  audioCtx.currentTime = 11.7;
  video.currentTime = 1.8;
  scheduler.tick();

  assert.equal(audioCtx.createdSources.length, 2);
  // Must wait until 12.0 + 0.05 = 12.05 instead of overlapping at 11.7
  assert.ok(Math.abs(audioCtx.createdSources[1].startedAt - 12.05) < 1e-6);

  scheduler.destroy();
});

test('AudioScheduler waits for pending Kokoro synthesis instead of using speechSynthesis when model is ready', async () => {
  const video = createFakeVideo(0.1, 1.0);
  const audioCtx = createFakeAudioContext();
  const dummyBase64 = Buffer.from('RIFFtest').toString('base64');
  const spoken = [];

  const scheduler = new AudioScheduler({
    video,
    initialModelState: 'ready',
    createAudioContext: () => audioCtx,
    speechSynthesis: {
      speak(u) {
        spoken.push(u.text);
      },
      cancel() {},
      pause() {},
      resume() {},
    },
    synthesizeCue: async () => {
      await new Promise((r) => setTimeout(r, 15));
      return {
        ok: true,
        status: 'ready',
        wavBase64: dummyBase64,
        durationSec: 2.0,
      };
    },
  });

  scheduler.setCues([{ id: 0, text: 'Kokoro only', startSec: 0, endSec: 3, durationSec: 3 }]);
  scheduler.start();

  // Immediately after start(), synthesis is still pending: speechSynthesis must NOT fire
  assert.deepEqual(spoken, []);

  // Once Kokoro finishes, AudioBuffer plays automatically via tick()
  await new Promise((r) => setTimeout(r, 35));
  assert.deepEqual(spoken, []);
  assert.equal(audioCtx.createdSources.length, 1);

  scheduler.destroy();
});

test('AudioScheduler falls back to speechSynthesis only while Kokoro loads/errors, then cancels on seek', async () => {
  const video = createFakeVideo(0.2, 1.0);
  const audioCtx = createFakeAudioContext();
  const spoken = [];
  let cancelCount = 0;
  let canceledEpochs = [];

  const scheduler = new AudioScheduler({
    video,
    initialModelState: 'loading',
    createAudioContext: () => audioCtx,
    cancelEpoch: (ep) => canceledEpochs.push(ep),
    speechSynthesis: {
      speak(u) {
        spoken.push(u.text);
      },
      cancel() {
        cancelCount += 1;
      },
      pause() {},
      resume() {},
    },
    createUtterance: (text) => ({ text, rate: 1, onend: null }),
    synthesizeCue: async () => ({ ok: false, status: 'loading' }),
  });

  scheduler.setCues([
    { id: 0, text: 'Loading fallback sentence', startSec: 0, endSec: 3, durationSec: 3 },
    { id: 1, text: 'Later sentence', startSec: 10, endSec: 13, durationSec: 3 },
  ]);
  scheduler.start();

  assert.deepEqual(spoken, ['Loading fallback sentence']);

  const t0 = performance.now();
  video.currentTime = 10.5;
  video.emit('seeking');
  const elapsedMs = performance.now() - t0;

  assert.ok(elapsedMs < 150, `Expected seek flush < 150ms, got ${elapsedMs}ms`);
  assert.ok(cancelCount >= 2);
  assert.ok(canceledEpochs.length >= 1);
  assert.deepEqual(spoken, ['Loading fallback sentence', 'Later sentence']);

  scheduler.destroy();
});

test('AudioScheduler switches Kokoro voice immediately via setVoice and updates rate on ratechange', async () => {
  const video = createFakeVideo(0, 1.0);
  const audioCtx = createFakeAudioContext();
  const dummyBase64 = Buffer.from('RIFFtest').toString('base64');
  let activeVoice = 'af_heart';
  const requestedVoices = [];

  const scheduler = new AudioScheduler({
    video,
    initialModelState: 'ready',
    getVoice: () => activeVoice,
    createAudioContext: () => audioCtx,
    speechSynthesis: null,
    synthesizeCue: async ({ voice }) => {
      requestedVoices.push(voice);
      return {
        ok: true,
        status: 'ready',
        wavBase64: dummyBase64,
        durationSec: 2.0,
      };
    },
  });

  scheduler.setCues([{ id: 0, text: 'Rate test', startSec: 0, endSec: 2.0, durationSec: 2.0 }]);
  scheduler.start();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(audioCtx.createdSources.length, 1);
  assert.equal(audioCtx.createdSources[0].playbackRate.value, 1.0);

  video.playbackRate = 1.25;
  video.emit('ratechange');
  assert.equal(audioCtx.createdSources[0].playbackRate.value, 1.25);

  activeVoice = 'bm_george';
  scheduler.setVoice('bm_george');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(audioCtx.createdSources[0].stopped, true);
  assert.equal(audioCtx.createdSources.length, 2);
  assert.ok(requestedVoices.includes('bm_george'));

  video.emit('pause');
  assert.equal(audioCtx.suspendedCount, 1);

  scheduler.destroy();
});
