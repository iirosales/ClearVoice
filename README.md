# ClearVoice for YouTube

A **100% free, zero-API-key, local-first Chrome Extension (Manifest V3)** that improves speech intelligibility on YouTube educational videos by replacing the presenter's audio track with clean, neutral, locally synthesized AI speech synced to the video's timestamps.

## Architecture

- **Zero External APIs / Keys**: Powered locally in the browser by [Kokoro-82M (`kokoro-js`)](https://github.com/hexgrad/kokoro) running via WebGPU or WASM inside a Manifest V3 Offscreen Document, with instant **Web Speech API** fallback while model weights download.
- **YouTube JSON3 Caption Pipeline (`src/yt-bridge.js`, `src/caption-processor.js`)**:
  - Runs in YouTube's `MAIN` world to locate English caption tracks (preferring manual over ASR) and fetch `fmt=json3` transcripts with page credentials.
  - Merges fragmented auto-captions into natural 8–20 word sentences, strips non-speech tags (`[Music]`, `[Applause]`), decodes HTML entities, and normalizes common programming/CS jargon (`Kubernetes`, `SQL`, `JSON`, `GitHub`, `Nginx`, `Node.js`, `TypeScript`, `WebGPU`, etc.).
- **Dynamic Web Audio Scheduler (`src/audio-scheduler.js`)**:
  - Pre-generates a lookahead buffer of the next 4 cues.
  - Time-stretches each synthesized `AudioBuffer` (`[0.85x, 1.45x]`) to fit the presenter's caption window across `1x`–`2x` YouTube playback speeds.
  - Suspends on pause/buffering, prevents overlapping sentences (`50ms` minimum breath gap), and flushes stale audio immediately on seek.
- **Player Control Bar & Popup UI (`src/ui-injector.js`, `src/content.js`, `src/popup.js`)**:
  - Injects a ClearVoice waveform toggle button into `.ytp-right-controls` next to Subtitles/CC (`Disabled`, `Off`, `Loading`, `Active`).
  - Handles YouTube SPA navigation, pauses ClearVoice during ads (`div.ad-showing`), and persists preferences (`enabled`, `voice`) in `chrome.storage.local`.

## Build & Load in Chrome

```bash
npm install
npm run build
```

1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/` directory.
4. Open a YouTube video with English captions and click the ClearVoice waveform button in the player control bar (or use the toolbar popup to pick a voice preset).

## Development & Tests

```bash
# Watch mode for incremental rebuilds into dist/
npm run watch

# Run unit and MV3 build verification tests
npm test
```
