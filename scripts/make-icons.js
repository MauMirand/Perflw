// Builds the Perflw app icons from the supplied logo artwork.
// Source: assets/brand/perflw-logo-source.png (transparent background).
// Outputs: assets/brand/perflw-mark.png (cropped mark, transparent),
// assets/brand/perflw-icon.png (256 tile used in the UI), assets/icon.png (512)
// and assets/icon.ico (16-256 PNG entries). Run: npm run icons
'use strict';

const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const root = path.join(__dirname, '..');
const brand = path.join(root, 'assets', 'brand');
const SOURCE = path.join(brand, 'perflw-logo-source.png');

// Transparent background: the logo stands on its own, no tile behind it.
const TILE = null; // set a colour such as '#F4F2FA' to put the mark on a rounded tile
const RADIUS = 0.22; // corner radius as a share of the tile side
const MARK = 0.96;   // widest side of the mark as a share of the tile side

// Bounding box of visible pixels.
function bounds(img) {
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (data[(y * img.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Downscale in halving steps so small sizes stay smooth instead of aliased.
function drawScaled(ctx, img, box, dx, dy, dw, dh) {
  let src = createCanvas(box.w, box.h);
  src.getContext('2d').drawImage(img, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  while (src.width / 2 > dw) {
    const half = createCanvas(Math.round(src.width / 2), Math.round(src.height / 2));
    const hctx = half.getContext('2d');
    hctx.imageSmoothingQuality = 'high';
    hctx.drawImage(src, 0, 0, half.width, half.height);
    src = half;
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, dx, dy, dw, dh);
}

function tile(img, box, size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const r = size * RADIUS;
  if (TILE) {
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, r);
    ctx.fillStyle = TILE;
    ctx.fill();
  }
  const scale = (size * MARK) / Math.max(box.w, box.h);
  const w = box.w * scale, h = box.h * scale;
  drawScaled(ctx, img, box, (size - w) / 2, (size - h) / 2, w, h);
  return canvas.toBuffer('image/png');
}

// ICO container with PNG-compressed entries (supported since Windows Vista).
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

async function main() {
  const img = await loadImage(fs.readFileSync(SOURCE));
  const box = bounds(img);

  const mark = createCanvas(512, Math.round(512 * box.h / box.w));
  drawScaled(mark.getContext('2d'), img, box, 0, 0, mark.width, mark.height);
  fs.writeFileSync(path.join(brand, 'perflw-mark.png'), mark.toBuffer('image/png'));

  fs.writeFileSync(path.join(brand, 'perflw-icon.png'), tile(img, box, 256));
  fs.writeFileSync(path.join(root, 'assets', 'icon.png'), tile(img, box, 512));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), buildIco(sizes.map((size) => ({ size, png: tile(img, box, size) }))));
  console.log(`icons written from ${box.w}x${box.h} mark: perflw-mark.png, perflw-icon.png 256, icon.png 512, icon.ico ${sizes.join('/')}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
