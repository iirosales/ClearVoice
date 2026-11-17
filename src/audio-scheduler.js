const MIN_TTS_RATE = 0.85;
const MAX_TTS_RATE = 1.45;
const MAX_CATCHUP_MULTIPLIER = 1.22;
const LOOKAHEAD_CUES = 4;
const OVERLAP_GAP_SEC = 0.05;
const MAX_WAIT_FOR_ACTIVE_SEC = 0.75;
const TICK_INTERVAL_MS = 100;

/**
 * Compute natural TTS playbackRate: plays at the video's playback speed when audio
 * fits the cue window, and applies only a gentle speedup when a cue runs long.
 */
export function calculateTtsPlaybackRate(audioDurationSec, cueDurationSec, videoPlaybackRate = 1) {
  const safeVideoRate =
    Number.isFinite(videoPlaybackRate) && videoPlaybackRate > 0 ? videoPlaybackRate : 1;
  const baseRate = Math.min(MAX_TTS_RATE, Math.max(MIN_TTS_RATE, safeVideoRate));

  if (!Number.isFinite(audioDurationSec) || audioDurationSec <= 0) return baseRate;
  if (!Number.isFinite(cueDurationSec) || cueDurationSec <= 0) return baseRate;

  const effectiveWindow = cueDurationSec / safeVideoRate;
  if (effectiveWindow <= 0) return baseRate;

  const neededRate = audioDurationSec / effectiveWindow;
  if (neededRate <= baseRate) {
    return baseRate;
  }

  const maxAllowedRate = Math.min(MAX_TTS_RATE, baseRate * MAX_CATCHUP_MULTIPLIER);
  return Math.min(maxAllowedRate, neededRate);
}

export function base64ToArrayBuffer(base64) {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
  return Uint8Array.from(Buffer.from(base64, 'base64')).buffer;
}

export class AudioScheduler {
  constructor(options = {}) {
    this.video = options.video || null;
    this.synthesizeCue = options.synthesizeCue;
    this.cancelEpoch = options.cancelEpoch || (() => {});
    this.playOffscreenAudio = options.playOffscreenAudio || null;
    this.stopOffscreenAudio = options.stopOffscreenAudio || (() => {});
    this.getVoice = options.getVoice || (() => 'af_heart');
    this.onModelState = options.onModelState || (() => {});
    this.createAudioContext =
      options.createAudioContext ||
      (() => {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        return new Ctx();
      });
    this.speechSynthesis =
      options.speechSynthesis !== undefined
        ? options.speechSynthesis
        : typeof window !== 'undefined'
          ? window.speechSynthesis
          : null;
    this.createUtterance =
      options.createUtterance ||
      ((text) =>
        typeof SpeechSynthesisUtterance !== 'undefined'
          ? new SpeechSynthesisUtterance(text)
          : { text, rate: 1 });

    this.audioCtx = null;
    this.cues = [];
    this.cueCache = new Map();
    this.playedCueIds = new Set();
    this.activePlayback = null;
    this.scheduledFallbackId = null;
    this.nextAllowedAudioTime = 0;

    this.epoch = 0;
    this.enabled = false;
    this.adPaused = false;
    this.bufferingPause = false;
    this._internalPauseAction = false;
    this._bufferingCueId = null;
    this.modelState = options.initialModelState || 'idle';
    this.tickTimer = null;

    this._boundHandlers = null;
    if (this.video) {
      this.attachVideo(this.video);
    }
  }

  attachVideo(video) {
    if (this.video && this._boundHandlers) {
      this._detachVideoListeners(this.video);
    }
    this.video = video;
    if (!video) return;

    this._boundHandlers = {
      play: () => this._handlePlay(),
      playing: () => this._handlePlay(),
      pause: () => this._handlePause(),
      waiting: () => this._handlePause(),
      seeking: () => this.handleSeek(),
      seeked: () => this.tick(),
      ratechange: () => this._handleRateChange(),
      timeupdate: () => this.tick(),
    };

    for (const [event, fn] of Object.entries(this._boundHandlers)) {
      video.addEventListener(event, fn);
    }
  }

  _detachVideoListeners(video) {
    if (!video || !this._boundHandlers) return;
    for (const [event, fn] of Object.entries(this._boundHandlers)) {
      video.removeEventListener(event, fn);
    }
    this._boundHandlers = null;
  }

  unlockAudioContext() {
    if (!this.audioCtx) return;
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
  }

  _ensureAudioContext() {
    if (!this.audioCtx) {
      this.audioCtx = this.createAudioContext();
    }
    if (this.audioCtx.state === 'suspended' && this.enabled && !this.adPaused && !this.video?.paused) {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  setCues(cues) {
    this.bufferingPause = false;
    this._bufferingCueId = null;
    this._internalPauseAction = false;
    this.stopActiveAudio();
    this.epoch += 1;
    this.cancelEpoch(this.epoch);
    this.cues = Array.isArray(cues) ? cues : [];
    this.cueCache.clear();
    this.playedCueIds.clear();
    this.nextAllowedAudioTime = 0;
    if (this.enabled && !this.adPaused) {
      this.tick();
    }
  }

  start() {
    this.enabled = true;
    this._ensureAudioContext();
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    }
    if (!this.adPaused) {
      if (this.video && !this.video.paused) {
        this.audioCtx?.resume?.().catch(() => {});
      }
      this.tick();
    }
  }

  stop() {
    this.enabled = false;
    this.bufferingPause = false;
    this._bufferingCueId = null;
    this._internalPauseAction = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.epoch += 1;
    this.cancelEpoch(this.epoch);
    this.stopActiveAudio();
    this.playedCueIds.clear();
    this.nextAllowedAudioTime = 0;
    if (this.audioCtx && this.audioCtx.state === 'running') {
      this.audioCtx.suspend().catch(() => {});
    }
  }

  setAdPlaying(isAd) {
    const next = Boolean(isAd);
    if (this.adPaused === next) return;
    this.adPaused = next;

    if (next) {
      this.bufferingPause = false;
      this._bufferingCueId = null;
      this._internalPauseAction = false;
      this.stopActiveAudio();
      if (this.audioCtx && this.audioCtx.state === 'running') {
        this.audioCtx.suspend().catch(() => {});
      }
    } else if (this.enabled) {
      if (this.video && !this.video.paused) {
        this.audioCtx?.resume?.().catch(() => {});
      }
      this.playedCueIds.clear();
      this.tick();
    }
  }

  setModelState(state) {
    this.modelState = state;
    if (
      state === 'ready' &&
      this.speechSynthesis &&
      typeof this.speechSynthesis.cancel === 'function'
    ) {
      this.speechSynthesis.cancel();
      this.scheduledFallbackId = null;
    }
    if (state === 'ready' && this.enabled && !this.adPaused) {
      this.tick();
    }
  }

  setVoice(_voice) {
    this.epoch += 1;
    this.stopActiveAudio();
    const activeTime = this.video?.currentTime || 0;
    const activeIdx = this.findCueIndexAtTime(activeTime);
    if (activeIdx !== -1) {
      this.playedCueIds.delete(this.cues[activeIdx].id);
    }
    this.cueCache.clear();
    this.cancelEpoch(this.epoch);
    if (this.enabled && !this.adPaused) {
      this.tick();
    }
  }

  invalidateVoiceCache() {
    this.setVoice();
  }

  destroy() {
    this.stop();
    if (this.video) {
      this._detachVideoListeners(this.video);
      this.video = null;
    }
    if (this.audioCtx && typeof this.audioCtx.close === 'function') {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  stopActiveAudio() {
    if (this.activePlayback) {
      const { sourceNode } = this.activePlayback;
      this.activePlayback = null;
      try {
        sourceNode.onended = null;
        sourceNode.stop();
        sourceNode.disconnect();
      } catch {
        // Node may have already stopped
      }
    }

    if (this.scheduledFallbackId !== null) {
      this.scheduledFallbackId = null;
    }
    if (this.speechSynthesis && typeof this.speechSynthesis.cancel === 'function') {
      this.speechSynthesis.cancel();
    }
    this.stopOffscreenAudio();
  }

  handleSeek() {
    this.bufferingPause = false;
    this._bufferingCueId = null;
    this._internalPauseAction = false;
    this.epoch += 1;
    this.stopActiveAudio();
    this.playedCueIds.clear();
    this.nextAllowedAudioTime = 0;

    // Remove pending synthesis tasks while keeping already-decoded AudioBuffers
    for (const [cueId, entry] of this.cueCache.entries()) {
      if (entry.status === 'pending' || entry.status === 'failed') {
        this.cueCache.delete(cueId);
      }
    }

    this.cancelEpoch(this.epoch);
    if (this.enabled && !this.adPaused) {
      this.tick();
    }
  }

  _handlePlay() {
    if (!this.enabled || this.adPaused) return;
    this._internalPauseAction = false;
    const ctx = this._ensureAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    if (this.speechSynthesis && typeof this.speechSynthesis.resume === 'function') {
      this.speechSynthesis.resume();
    }
    this.tick();
  }

  _handlePause() {
    if (this._internalPauseAction) {
      this._internalPauseAction = false;
      return;
    }
    this.bufferingPause = false;
    this._bufferingCueId = null;
    this.stopOffscreenAudio();
    if (this.audioCtx && this.audioCtx.state === 'running') {
      this.audioCtx.suspend().catch(() => {});
    }
    if (this.speechSynthesis && typeof this.speechSynthesis.pause === 'function') {
      this.speechSynthesis.pause();
    }
  }

  _handleRateChange() {
    if (!this.activePlayback || !this.video) return;
    const { sourceNode, audioDurationSec, cueDurationSec } = this.activePlayback;
    const newRate = calculateTtsPlaybackRate(
      audioDurationSec,
      cueDurationSec,
      this.video.playbackRate || 1
    );
    if (sourceNode?.playbackRate) {
      sourceNode.playbackRate.value = newRate;
    }
  }

  findCueIndexAtTime(currentTimeSec) {
    if (this.cues.length === 0) return -1;
    // Binary search for latest cue with startSec <= currentTimeSec
    let low = 0;
    let high = this.cues.length - 1;
    let candidate = -1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.cues[mid].startSec <= currentTimeSec) {
        candidate = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (candidate !== -1) {
      const cue = this.cues[candidate];
      if (currentTimeSec < cue.endSec) {
        return candidate;
      }
      // Allow playing an unplayed cue if the playhead is within 0.6s after its window
      if (!this.playedCueIds.has(cue.id) && currentTimeSec - cue.endSec <= 0.6) {
        return candidate;
      }
    }
    return -1;
  }

  findNextCueIndex(currentTimeSec) {
    let low = 0;
    let high = this.cues.length - 1;
    let result = this.cues.length;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.cues[mid].startSec >= currentTimeSec) {
        result = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return result;
  }

  prebufferLookahead(currentTimeSec) {
    if (!this.enabled || this.adPaused || this.cues.length === 0) return;

    const activeIdx = this.findCueIndexAtTime(currentTimeSec);
    const startIdx = activeIdx !== -1 ? activeIdx : this.findNextCueIndex(currentTimeSec);
    const endIdx = Math.min(this.cues.length, startIdx + LOOKAHEAD_CUES);

    for (let i = startIdx; i < endIdx; i++) {
      this._ensureCueSynthesized(this.cues[i], {
        priority: i === startIdx ? 'high' : 'normal',
      });
    }

    // Evict stale buffers far behind playhead to keep memory bounded
    for (const cueId of this.cueCache.keys()) {
      if (cueId < startIdx - 6 || cueId > startIdx + LOOKAHEAD_CUES + 6) {
        this.cueCache.delete(cueId);
      }
    }
  }

  _resumeAfterBuffering() {
    if (!this.bufferingPause) return;
    this.bufferingPause = false;
    this._bufferingCueId = null;
    this._internalPauseAction = false;
    if (this.enabled && !this.adPaused && this.video) {
      try {
        const playRes = this.video.play?.();
        if (playRes && typeof playRes.then === 'function') {
          playRes.then(() => this.tick()).catch(() => {});
        }
      } catch {
        // Ignore play errors in non-DOM mocks
      }
    }
  }

  async _ensureCueSynthesized(cue, { priority = 'normal' } = {}) {
    if (!cue || !this.synthesizeCue) return null;
    const voice = this.getVoice();
    const existing = this.cueCache.get(cue.id);
    if (existing && existing.voice === voice && (existing.status === 'ready' || existing.status === 'pending')) {
      return existing.promise || existing;
    }

    const requestEpoch = this.epoch;
    const ctx = this._ensureAudioContext();

    const promise = (async () => {
      try {
        const res = await this.synthesizeCue({
          text: cue.text,
          voice,
          epoch: requestEpoch,
          priority,
        });

        if (requestEpoch !== this.epoch) {
          this.cueCache.delete(cue.id);
          return null;
        }

        if (!res || !res.ok) {
          if (res?.status === 'loading') {
            this.modelState = 'loading';
            this.onModelState('loading');
            // Do not permanently fail loading cues; allow retry on next lookahead
            this.cueCache.delete(cue.id);
            if (this.bufferingPause) {
              this._resumeAfterBuffering();
            }
            if (this.enabled && !this.adPaused) {
              this.tick();
            }
          } else if (res?.status === 'error') {
            this.modelState = 'error';
            this.onModelState('error');
            this.cueCache.set(cue.id, { status: 'failed', voice });
            if (this.bufferingPause) {
              this._resumeAfterBuffering();
            }
            if (this.enabled && !this.adPaused) {
              this.tick();
            }
          } else {
            this.cueCache.delete(cue.id);
          }
          return null;
        }

        this.modelState = 'ready';
        this.onModelState('ready');
        const arrayBuf = base64ToArrayBuffer(res.wavBase64);
        const audioBuffer = await ctx.decodeAudioData(arrayBuf);

        if (requestEpoch !== this.epoch) {
          this.cueCache.delete(cue.id);
          return null;
        }

        const entry = {
          status: 'ready',
          voice,
          audioBuffer,
          wavBase64: res.wavBase64,
          durationSec: audioBuffer.duration || res.durationSec,
        };
        this.cueCache.set(cue.id, entry);
        if (this.bufferingPause && (this._bufferingCueId === null || this._bufferingCueId === cue.id)) {
          this._resumeAfterBuffering();
        }
        if (this.enabled && !this.adPaused) {
          this.tick();
        }
        return entry;
      } catch {
        if (this.cueCache.get(cue.id)?.voice === voice) {
          this.cueCache.delete(cue.id);
        }
        if (this.bufferingPause) {
          this._resumeAfterBuffering();
        }
        return null;
      }
    })();

    this.cueCache.set(cue.id, { status: 'pending', voice, promise });
    return promise;
  }

  _scheduleAudioBuffer(cue, audioBuffer, cached = null) {
    const ctx = this._ensureAudioContext();
    const scheduleEpoch = this.epoch;

    if (ctx.state === 'suspended') {
      Promise.race([
        ctx.resume().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 150)),
      ]).then(() => {
        if (!this.enabled || this.adPaused || this.epoch !== scheduleEpoch) return;
        if (ctx.state === 'suspended' && this.playOffscreenAudio && cached?.wavBase64) {
          const videoRate = this.video?.playbackRate || 1;
          const currentVideoTime = this.video?.currentTime ?? cue.startSec;
          const remainingCueSec = Math.min(
            cue.durationSec,
            Math.max(0.35, cue.endSec - currentVideoTime)
          );
          const ttsRate = calculateTtsPlaybackRate(audioBuffer.duration, remainingCueSec, videoRate);
          this.playOffscreenAudio({
            wavBase64: cached.wavBase64,
            playbackRate: ttsRate,
            epoch: scheduleEpoch,
          });
          return;
        }
        this._commitAudioBufferStart(cue, audioBuffer, ctx);
      });
      return;
    }

    this._commitAudioBufferStart(cue, audioBuffer, ctx);
  }

  _commitAudioBufferStart(cue, audioBuffer, ctx) {
    const now = ctx.currentTime;
    const videoRate = this.video?.playbackRate || 1;
    const currentVideoTime = this.video?.currentTime ?? cue.startSec;
    const remainingCueSec = Math.min(
      cue.durationSec,
      Math.max(0.35, cue.endSec - currentVideoTime)
    );
    const ttsRate = calculateTtsPlaybackRate(audioBuffer.duration, remainingCueSec, videoRate);
    const playbackDuration = audioBuffer.duration / ttsRate;

    let startAt = Math.max(now, this.nextAllowedAudioTime);

    if (this.activePlayback) {
      const remaining = this.activePlayback.expectedEndAudioSec - now;
      if (remaining > 0 && remaining <= MAX_WAIT_FOR_ACTIVE_SEC) {
        // Delay slightly after previous cue ends rather than speaking simultaneously
        startAt = Math.max(startAt, this.activePlayback.expectedEndAudioSec + OVERLAP_GAP_SEC);
      } else {
        this.stopActiveAudio();
        startAt = Math.max(now + OVERLAP_GAP_SEC, this.nextAllowedAudioTime);
      }
    }

    const sourceNode = ctx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.playbackRate.value = ttsRate;
    sourceNode.connect(ctx.destination);

    const expectedEnd = startAt + playbackDuration;
    this.nextAllowedAudioTime = expectedEnd + OVERLAP_GAP_SEC;

    const playbackRecord = {
      cueId: cue.id,
      sourceNode,
      startedAtAudioSec: startAt,
      expectedEndAudioSec: expectedEnd,
      audioDurationSec: audioBuffer.duration,
      cueDurationSec: cue.durationSec,
    };

    sourceNode.onended = () => {
      if (this.activePlayback === playbackRecord) {
        this.activePlayback = null;
        this.nextAllowedAudioTime = Math.max(
          this.nextAllowedAudioTime,
          ctx.currentTime + OVERLAP_GAP_SEC
        );
      }
    };

    this.activePlayback = playbackRecord;
    sourceNode.start(startAt);
  }

  _speakFallback(cue) {
    if (!this.speechSynthesis || typeof this.speechSynthesis.speak !== 'function') return;
    if (this.scheduledFallbackId === cue.id) return;

    this.speechSynthesis.cancel();
    const utterance = this.createUtterance(cue.text);
    const words = cue.text.split(/\s+/).filter(Boolean).length;
    const estimatedSec = Math.max(0.5, words / 2.6);
    utterance.rate = calculateTtsPlaybackRate(
      estimatedSec,
      cue.durationSec,
      this.video?.playbackRate || 1
    );

    this.scheduledFallbackId = cue.id;
    utterance.onend = () => {
      if (this.scheduledFallbackId === cue.id) {
        this.scheduledFallbackId = null;
      }
    };
    this.speechSynthesis.speak(utterance);
  }

  tick() {
    if (!this.enabled || this.adPaused || !this.video || this.cues.length === 0) return;

    const currentTimeSec = this.video.currentTime || 0;
    this.prebufferLookahead(currentTimeSec);

    if (this.video.paused && !this.bufferingPause) return;

    const cueIdx = this.findCueIndexAtTime(currentTimeSec);
    if (cueIdx === -1) return;

    const cue = this.cues[cueIdx];
    if (this.playedCueIds.has(cue.id)) return;

    const voice = this.getVoice();
    const cached = this.cueCache.get(cue.id);

    if (cached && cached.status === 'ready' && cached.voice === voice && cached.audioBuffer) {
      if (this.bufferingPause) {
        this._resumeAfterBuffering();
      }
      this.playedCueIds.add(cue.id);
      if (this.speechSynthesis && typeof this.speechSynthesis.cancel === 'function') {
        this.speechSynthesis.cancel();
        this.scheduledFallbackId = null;
      }
      this._scheduleAudioBuffer(cue, cached.audioBuffer, cached);
      return;
    }

    // Use Web Speech API fallback only while Kokoro weights are downloading or on backend error
    if (this.modelState === 'loading' || this.modelState === 'error' || cached?.status === 'failed') {
      if (this.bufferingPause) {
        this._resumeAfterBuffering();
      }
      if (!this.video.paused) {
        this.playedCueIds.add(cue.id);
        this._speakFallback(cue);
      }
      return;
    }

    // Kokoro is ready or initializing: pause video briefly so playhead never outruns WASM synthesis
    this._ensureCueSynthesized(cue, { priority: 'high' });
    if (!this.video.paused && !this.bufferingPause) {
      this.bufferingPause = true;
      this._bufferingCueId = cue.id;
      this._internalPauseAction = true;
      try {
        this.video.pause?.();
      } catch {
        // Ignore mock errors
      }
    }
  }
}
