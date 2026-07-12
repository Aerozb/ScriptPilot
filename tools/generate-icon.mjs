import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'build');
const iconPath = path.join(buildDir, 'icon.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];

await fs.mkdir(buildDir, { recursive: true });
await fs.writeFile(iconPath, createIco(sizes));
console.log(`Generated ${path.relative(root, iconPath)} (${sizes.join(', ')}px)`);

function createIco(iconSizes) {
  const images = iconSizes.map((size) => createIconDib(size));
  const headerSize = 6;
  const directorySize = images.length * 16;
  let offset = headerSize + directorySize;
  const directory = Buffer.alloc(directorySize);

  images.forEach((image, index) => {
    const entryOffset = index * 16;
    directory[entryOffset] = image.size === 256 ? 0 : image.size;
    directory[entryOffset + 1] = image.size === 256 ? 0 : image.size;
    directory[entryOffset + 2] = 0;
    directory[entryOffset + 3] = 0;
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(image.data.length, entryOffset + 8);
    directory.writeUInt32LE(offset, entryOffset + 12);
    offset += image.data.length;
  });

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

function createIconDib(size) {
  const rgba = renderIcon(size);
  const xorStride = size * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  const dib = Buffer.alloc(40 + xorStride * size + maskStride * size);

  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(0, 16);
  dib.writeUInt32LE(xorStride * size, 20);
  dib.writeInt32LE(0, 24);
  dib.writeInt32LE(0, 28);
  dib.writeUInt32LE(0, 32);
  dib.writeUInt32LE(0, 36);

  let cursor = 40;
  for (let y = size - 1; y >= 0; y -= 1) {
    for (let x = 0; x < size; x += 1) {
      const pixel = (y * size + x) * 4;
      dib[cursor++] = rgba[pixel + 2];
      dib[cursor++] = rgba[pixel + 1];
      dib[cursor++] = rgba[pixel];
      dib[cursor++] = rgba[pixel + 3];
    }
  }

  for (let y = size - 1; y >= 0; y -= 1) {
    const rowStart = cursor;
    for (let x = 0; x < size; x += 1) {
      const alpha = rgba[(y * size + x) * 4 + 3];
      if (alpha < 128) {
        dib[rowStart + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    cursor += maskStride;
  }

  return { size, data: dib };
}

function renderIcon(size) {
  const scale = size <= 32 ? 6 : 4;
  const width = size * scale;
  const image = new Uint8ClampedArray(width * width * 4);
  const unit = width / 256;

  drawShadow(image, width, 23 * unit, 25 * unit, 210 * unit, 210 * unit, 52 * unit);
  fillRoundedRectGradient(image, width, 20 * unit, 20 * unit, 216 * unit, 216 * unit, 52 * unit);
  fillRoundedRect(image, width, 50 * unit, 34 * unit, 154 * unit, 86 * unit, 38 * unit, [255, 255, 255, 28]);

  const white = [255, 255, 255, 242];
  drawS(image, width, 54 * unit, 62 * unit, 71 * unit, 125 * unit, 22 * unit, white);
  drawP(image, width, 143 * unit, 62 * unit, 84 * unit, 125 * unit, 22 * unit, white);

  return downsample(image, width, size, scale);
}

function drawShadow(image, width, x, y, w, h, r) {
  for (let i = 5; i >= 1; i -= 1) {
    fillRoundedRect(image, width, x - i, y + i * 1.8, w + i * 2, h + i * 2, r + i, [6, 53, 42, 7]);
  }
}

function fillRoundedRectGradient(image, width, x, y, w, h, r) {
  const start = [31, 200, 140];
  const mid = [19, 160, 111];
  const end = [13, 111, 85];
  forEachRoundedRectPixel(x, y, w, h, r, (px, py) => {
    const t = clamp((px + py - x - y) / (w + h), 0, 1);
    const color = t < 0.55
      ? mix(start, mid, t / 0.55)
      : mix(mid, end, (t - 0.55) / 0.45);
    blendPixel(image, width, px, py, [...color, 255]);
  });
}

function drawS(image, width, x, y, w, h, t, color) {
  const midY = y + h / 2 - t / 2;
  fillRoundedRect(image, width, x, y, w, t, t / 2, color);
  fillRoundedRect(image, width, x, y, t, h / 2 + t / 2, t / 2, color);
  fillRoundedRect(image, width, x, midY, w, t, t / 2, color);
  fillRoundedRect(image, width, x + w - t, y + h / 2 - t / 2, t, h / 2 + t / 2, t / 2, color);
  fillRoundedRect(image, width, x, y + h - t, w, t, t / 2, color);
}

function drawP(image, width, x, y, w, h, t, color) {
  fillRoundedRect(image, width, x, y, t, h, t / 2, color);
  fillRoundedRect(image, width, x, y, w * 0.82, t, t / 2, color);
  fillRoundedRect(image, width, x, y + h / 2 - t / 2, w * 0.82, t, t / 2, color);
  fillRoundedRect(image, width, x + w * 0.82 - t, y, t, h / 2 + t / 2, t / 2, color);
}

function fillRoundedRect(image, width, x, y, w, h, r, color) {
  forEachRoundedRectPixel(x, y, w, h, r, (px, py) => {
    blendPixel(image, width, px, py, color);
  });
}

function forEachRoundedRectPixel(x, y, w, h, r, callback) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.ceil(x + w);
  const y1 = Math.ceil(y + h);
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      const dx = cx < x + r ? x + r - cx : cx > x + w - r ? cx - (x + w - r) : 0;
      const dy = cy < y + r ? y + r - cy : cy > y + h - r ? cy - (y + h - r) : 0;
      if (dx * dx + dy * dy <= r * r) callback(px, py);
    }
  }
}

function blendPixel(image, width, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= width) return;
  const index = (y * width + x) * 4;
  const srcA = color[3] / 255;
  const dstA = image[index + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  image[index] = Math.round((color[0] * srcA + image[index] * dstA * (1 - srcA)) / outA);
  image[index + 1] = Math.round((color[1] * srcA + image[index + 1] * dstA * (1 - srcA)) / outA);
  image[index + 2] = Math.round((color[2] * srcA + image[index + 2] * dstA * (1 - srcA)) / outA);
  image[index + 3] = Math.round(outA * 255);
}

function downsample(source, sourceWidth, targetSize, scale) {
  const target = new Uint8ClampedArray(targetSize * targetSize * 4);
  const sampleCount = scale * scale;
  for (let y = 0; y < targetSize; y += 1) {
    for (let x = 0; x < targetSize; x += 1) {
      const totals = [0, 0, 0, 0];
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const index = ((y * scale + sy) * sourceWidth + (x * scale + sx)) * 4;
          totals[0] += source[index];
          totals[1] += source[index + 1];
          totals[2] += source[index + 2];
          totals[3] += source[index + 3];
        }
      }
      const out = (y * targetSize + x) * 4;
      target[out] = Math.round(totals[0] / sampleCount);
      target[out + 1] = Math.round(totals[1] / sampleCount);
      target[out + 2] = Math.round(totals[2] / sampleCount);
      target[out + 3] = Math.round(totals[3] / sampleCount);
    }
  }
  return target;
}

function mix(a, b, t) {
  return a.map((value, index) => Math.round(value + (b[index] - value) * t));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
