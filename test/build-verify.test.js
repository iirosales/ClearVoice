import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');

test('Manifest V3 build output contains all required local bundles and assets', () => {
  execFileSync('node', ['build.js'], { cwd: rootDir, stdio: 'pipe' });

  const requiredFiles = [
    'manifest.json',
    'yt-bridge.js',
    'content.js',
    'background.js',
    'offscreen.js',
    'offscreen.html',
    'popup.js',
    'popup.html',
    'popup.css',
    'icons/icon16.png',
    'icons/icon48.png',
    'icons/icon128.png',
    'wasm/ort-wasm-simd-threaded.jsep.mjs',
    'wasm/ort-wasm-simd-threaded.jsep.wasm',
  ];

  for (const rel of requiredFiles) {
    const full = path.join(distDir, rel);
    assert.ok(fs.existsSync(full), `Missing built file: dist/${rel}`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['offscreen', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['*://*.youtube.com/*']);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.equal(manifest.content_scripts[1].world, 'ISOLATED');
  assert.equal(manifest.content_scripts[1].run_at, 'document_idle');
  assert.ok(manifest.content_security_policy.extension_pages.includes("'wasm-unsafe-eval'"));

  const offscreenBundle = fs.readFileSync(path.join(distDir, 'offscreen.js'), 'utf8');
  assert.ok(offscreenBundle.includes('Kokoro-82M-v1.0-ONNX'));
});
