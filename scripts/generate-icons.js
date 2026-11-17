import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function signedDistRoundedRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

function blendPixel(buf, idx, r, g, b, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  const inv = 1 - a;
  buf[idx] = Math.round(buf[idx] * inv + r * a);
  buf[idx + 1] = Math.round(buf[idx + 1] * inv + g * a);
  buf[idx + 2] = Math.round(buf[idx + 2] * inv + b * a);
  buf[idx + 3] = Math.round(Math.min(255, buf[idx + 3] + 255 * a * (1 - buf[idx + 3] / 255)));
}

function renderIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const half = size * 0.45;
  const radius = size * 0.22;

  // Waveform bar geometry in normalized [0, 1] coordinates
  const bars = [
    { x: 0.27, hh: 0.14 },
    { x: 0.42, hh: 0.28 },
    { x: 0.58, hh: 0.21 },
    { x: 0.73, hh: 0.12 },
  ];
  const barWidth = Math.max(1.2, size * 0.085);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dist = signedDistRoundedRect(x, y, center, center, half, half, radius);
      const bgAlpha = Math.max(0, Math.min(1, 0.8 - dist));

      if (bgAlpha > 0) {
        // Subtle dark slate vertical gradient
        const t = y / Math.max(1, size - 1);
        const bgR = Math.round(18 + t * 8);
        const bgG = Math.round(22 + t * 8);
        const bgB = Math.round(32 + t * 12);
        buf[idx] = bgR;
        buf[idx + 1] = bgG;
        buf[idx + 2] = bgB;
        buf[idx + 3] = Math.round(255 * bgAlpha);

        // Subtle inner rim highlight
        if (dist > -Math.max(1.2, size * 0.04) && dist < 0.2) {
          blendPixel(buf, idx, 62, 166, 255, 0.25 * bgAlpha);
        }
      }

      // Draw waveform capsule bars in #3ea6ff -> #7cc4ff gradient
      const nx = (x + 0.5) / size;
      const ny = (y + 0.5) / size;
      for (const bar of bars) {
        const barDist = signedDistRoundedRect(
          x + 0.5,
          y + 0.5,
          bar.x * size,
          0.5 * size,
          barWidth / 2,
          bar.hh * size,
          barWidth / 2
        );
        const barAlpha = Math.max(0, Math.min(1, 0.75 - barDist));
        if (barAlpha > 0) {
          const highlight = 1 - Math.abs(ny - 0.5) * 1.4;
          const r = Math.round(62 + 45 * Math.max(0, highlight));
          const g = Math.round(166 + 48 * Math.max(0, highlight));
          const b = 255;
          blendPixel(buf, idx, r, g, b, barAlpha);
        }
      }
    }
  }

  return encodePng(size, size, buf);
}

const outDir = path.resolve('public/icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const outPath = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(outPath, renderIcon(size));
  console.log(`Generated ${outPath}`);
}
