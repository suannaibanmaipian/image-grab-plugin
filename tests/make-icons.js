'use strict';
/*
 * 生成「图提取 ImageGrab」的扩展工具栏图标（16/32/48/128）。
 * 用 zlib 手写 PNG，不依赖任何三方图形库。
 * 用法：node make-icons.js <输出目录>
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ==================== PNG 编码 ==================== */

// CRC32 查表
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 把 RGBA 像素缓冲区编码成 PNG Buffer */
function encodePng(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter type: None
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ==================== 图形绘制（在 32×32 坐标系里定义，按尺寸缩放） ==================== */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 点到线段的距离 */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = clamp01(t);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// 品牌渐变色：与官网 style.css 的 --primary / --primary-2 保持一致
const C1 = [79, 110, 247]; // #4f6ef7
const C2 = [123, 92, 240]; // #7b5cf0

/**
 * 渲染一张图标
 * @param {number} size
 * @returns {Buffer} PNG
 */
function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const unit = 32 / size; // 一个像素在 32 坐标系里的长度

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) * unit;
      const v = (y + 0.5) * unit;

      // 1) 圆角方块（x/y 从 1 到 31，圆角半径 9）
      const dx = Math.max(Math.abs(u - 16) - (15 - 9), 0);
      const dy = Math.max(Math.abs(v - 16) - (15 - 9), 0);
      const dist = Math.hypot(dx, dy);
      const boxAlpha = clamp01((9 - dist) / unit + 0.5);

      // 2) 渐变填充
      const t = clamp01(((u - 1) / 30 + (v - 1) / 30) / 2);
      let r = C1[0] + (C2[0] - C1[0]) * t;
      let g = C1[1] + (C2[1] - C1[1]) * t;
      let b = C1[2] + (C2[2] - C1[2]) * t;

      // 3) 白色下载箭头（竖线 + 箭头折线 + 底部横线，圆头描边）
      const half = 2.2 / 2;
      const strokes = [
        distToSegment(u, v, 16, 8, 16, 18),
        distToSegment(u, v, 11.5, 14, 16, 18.5),
        distToSegment(u, v, 16, 18.5, 20.5, 14),
        distToSegment(u, v, 9.5, 22.5, 22.5, 22.5)
      ];
      const strokeDist = Math.min.apply(null, strokes);
      const white = clamp01((half - strokeDist) / unit + 0.5);

      r = r + (255 - r) * white;
      g = g + (255 - g) * white;
      b = b + (255 - b) * white;

      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(boxAlpha * 255);
    }
  }

  return encodePng(size, size, rgba);
}

/* ==================== 主流程 ==================== */

const outDir = process.argv[2];
if (!outDir) {
  console.error('用法：node make-icons.js <输出目录>');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

[16, 32, 48, 128].forEach((size) => {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, renderIcon(size));
  console.log(`已生成 ${file}`);
});
