import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');
const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');
const publicDir = path.join(rootDir, 'public');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function copyOnnxWasmAssets() {
  const wasmDestDir = path.join(distDir, 'wasm');
  fs.mkdirSync(wasmDestDir, { recursive: true });

  const candidateDirs = [
    path.join(rootDir, 'node_modules/@huggingface/transformers/dist'),
    path.join(rootDir, 'node_modules/onnxruntime-web/dist'),
  ];

  const requiredFiles = [
    'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
  ];

  for (const fileName of requiredFiles) {
    let copied = false;
    for (const dir of candidateDirs) {
      const srcPath = path.join(dir, fileName);
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, path.join(wasmDestDir, fileName));
        copied = true;
        break;
      }
    }
    if (!copied) {
      console.warn(`[build] Optional ORT asset not found: ${fileName}`);
    }
  }
}

function copyKokoroVoices() {
  const voicesDestDir = path.join(distDir, 'voices');
  fs.mkdirSync(voicesDestDir, { recursive: true });
  const voicesSrcDir = path.join(rootDir, 'node_modules/kokoro-js/voices');
  const presets = [
    'af_heart.bin',
    'af_bella.bin',
    'am_adam.bin',
    'am_michael.bin',
    'bf_emma.bin',
    'bm_george.bin',
  ];

  for (const fileName of presets) {
    const srcPath = path.join(voicesSrcDir, fileName);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(voicesDestDir, fileName));
    } else {
      console.warn(`[build] Missing Kokoro voice asset: ${fileName}`);
    }
  }
}

function copyStaticAssets() {
  fs.mkdirSync(distDir, { recursive: true });
  copyDirRecursive(publicDir, distDir);
  copyOnnxWasmAssets();
  copyKokoroVoices();
}

const kokoroWebPlugin = {
  name: 'kokoro-web-browser',
  setup(build) {
    const kokoroWebPath = path.join(rootDir, 'node_modules/kokoro-js/dist/kokoro.web.js');
    build.onResolve({ filter: /^kokoro-js$/ }, () => ({
      path: kokoroWebPath,
    }));
  },
};

const commonOptions = {
  bundle: true,
  sourcemap: false,
  minify: true,
  platform: 'browser',
  target: ['chrome116'],
  logLevel: 'info',
};

const buildConfigs = [
  {
    ...commonOptions,
    entryPoints: [path.join(rootDir, 'src/yt-bridge.js')],
    outfile: path.join(distDir, 'yt-bridge.js'),
    format: 'iife',
  },
  {
    ...commonOptions,
    entryPoints: [path.join(rootDir, 'src/content.js')],
    outfile: path.join(distDir, 'content.js'),
    format: 'iife',
  },
  {
    ...commonOptions,
    entryPoints: [path.join(rootDir, 'src/background.js')],
    outfile: path.join(distDir, 'background.js'),
    format: 'esm',
  },
  {
    ...commonOptions,
    entryPoints: [path.join(rootDir, 'src/offscreen.js')],
    outfile: path.join(distDir, 'offscreen.js'),
    format: 'esm',
    plugins: [kokoroWebPlugin],
  },
  {
    ...commonOptions,
    entryPoints: [path.join(rootDir, 'src/popup.js')],
    outfile: path.join(distDir, 'popup.js'),
    format: 'iife',
  },
];

async function runBuild() {
  fs.rmSync(distDir, { recursive: true, force: true });
  copyStaticAssets();

  if (isWatch) {
    const contexts = await Promise.all(buildConfigs.map((cfg) => esbuild.context(cfg)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('[build] Watching for changes...');
  } else {
    await Promise.all(buildConfigs.map((cfg) => esbuild.build(cfg)));
    console.log('[build] Extension built into dist/');
  }
}

runBuild().catch((err) => {
  console.error(err);
  process.exit(1);
});
