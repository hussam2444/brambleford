// All of the pixel art, drawn in code so the game ships with no image files.
//
// Every sprite is drawn with flat shapes and then given a dark outline taken
// from its own colours (see `outline`), which is what ties the look together.
// A bought or commissioned art pack can replace any of these one for one.

import type { GoodId } from '../economy/goods';
import { TILE } from './ground';

export { TILE };
type Ctx = CanvasRenderingContext2D;

// ── Drawing helpers ─────────────────────────────────────────────────────────

const R = (c: Ctx, color: string, x: number, y: number, w = 1, h = 1) => {
  c.fillStyle = color;
  c.fillRect(Math.round(x), Math.round(y), w, h);
};

/** Filled pixel ellipse. */
function ell(c: Ctx, color: string, cx: number, cy: number, rx: number, ry: number) {
  c.fillStyle = color;
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) c.fillRect(x, y, 1, 1);
    }
  }
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shade = (hex: string, by = 0.8) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * by)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
};

/** Give everything solid on the canvas a one-pixel outline, coloured as a dark version of what it borders. */
function outline(c: Ctx, w: number, h: number, darkness = 0.4) {
  const src = c.getImageData(0, 0, w, h);
  const d = src.data;
  const out = new Uint8ClampedArray(d);
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 170;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (solid(x, y)) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!solid(x + dx, y + dy)) continue;
        const j = ((y + dy) * w + x + dx) * 4;
        r += d[j]; g += d[j + 1]; b += d[j + 2]; n++;
      }
      if (!n) continue;
      const i = (y * w + x) * 4;
      out[i] = (r / n) * darkness; out[i + 1] = (g / n) * darkness; out[i + 2] = (b / n) * darkness * 1.15; out[i + 3] = 255;
    }
  }
  c.putImageData(new ImageData(out, w, h), 0, 0);
}

/** Make a sprite canvas with a pixel of padding all round, then outline it. */
function sprite(w: number, h: number, draw: (c: Ctx) => void, line = true): HTMLCanvasElement {
  const el = document.createElement('canvas');
  el.width = w + 2;
  el.height = h + 2;
  const c = el.getContext('2d', { willReadFrequently: true })!;
  c.translate(1, 1);
  draw(c);
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (line) outline(c, el.width, el.height);
  return el;
}

const SHADOW = 'rgba(20,24,40,0.22)';

// ── Item icons (16 x 16) ────────────────────────────────────────────────────

export function drawIcon(c: Ctx, good: GoodId) {
  switch (good) {
    case 'ore':
      ell(c, '#5f5f6b', 8, 9.5, 6.5, 5); ell(c, '#80808d', 7.5, 8.5, 5.5, 4); ell(c, '#a8a8b6', 6, 7, 2.5, 1.5);
      for (const [x, y] of [[9, 8], [5, 10], [11, 11]]) { R(c, '#f0a23a', x, y, 2, 2); R(c, '#ffd27a', x, y, 1, 1); }
      break;
    case 'wood':
      R(c, '#6f4424', 1, 6, 12, 7); R(c, '#8a5a30', 1, 7, 12, 2); R(c, '#5a361c', 3, 10, 4, 1); R(c, '#5a361c', 8, 8, 3, 1);
      ell(c, '#b98654', 13, 9.5, 2.5, 3.5); ell(c, '#e2bf8c', 13, 9.5, 1.5, 2.5); R(c, '#b98654', 13, 9, 1, 1);
      break;
    case 'wheat':
      for (const [x, top] of [[4, 4], [8, 2], [12, 4]] as const) {
        R(c, '#b98e2c', x, top + 4, 1, 14 - top - 4);
        R(c, '#e9c84e', x - 1, top, 3, 5); R(c, '#fbe58a', x, top, 1, 3);
      }
      R(c, '#c45a3e', 3, 11, 10, 2);
      break;
    case 'fish':
    case 'smoked_fish': {
      const [body, belly, fin] = good === 'fish' ? ['#4a93d0', '#a8d6f2', '#2f6ea6'] : ['#a8672e', '#d9a066', '#7a4517'];
      ell(c, body, 7, 8.5, 5.5, 3.5); ell(c, belly, 6.5, 9.8, 4, 1.6);
      R(c, fin, 12, 6, 1, 5); R(c, fin, 13, 5, 1, 7); R(c, fin, 14, 4, 1, 9);
      R(c, fin, 6, 4, 3, 1);
      R(c, '#ffffff', 3, 7, 2, 2); R(c, '#1c1c28', 3, 8, 1, 1);
      break;
    }
    case 'tools':
      for (let i = 0; i < 9; i++) R(c, i % 3 ? '#8a5a30' : '#6f4424', 3 + i, 13 - i, 2, 2);
      R(c, '#8d8d9a', 6, 2, 8, 2); R(c, '#c2c2cf', 7, 2, 6, 1);
      R(c, '#8d8d9a', 4, 3, 2, 2); R(c, '#8d8d9a', 13, 4, 2, 3); R(c, '#6b6b78', 14, 6, 1, 2);
      break;
    case 'bread':
      ell(c, '#b5722e', 8, 9.5, 6.5, 4); ell(c, '#de9f52', 8, 8.8, 6, 3.4); ell(c, '#f3c886', 7, 7.6, 4, 1.4);
      for (const x of [5, 8, 11]) { R(c, '#b5722e', x, 8, 1, 2); R(c, '#b5722e', x - 1, 10, 1, 1); }
      break;
    case 'furniture':
      R(c, '#6f4424', 4, 1, 2, 14); R(c, '#6f4424', 10, 1, 2, 9);
      R(c, '#8a5a30', 4, 2, 8, 2); R(c, '#8a5a30', 4, 5, 8, 1);
      R(c, '#b98654', 4, 8, 9, 2); R(c, '#d2a271', 5, 8, 7, 1);
      R(c, '#6f4424', 11, 10, 2, 5);
      break;
  }
}

function drawCoin(c: Ctx) {
  ell(c, '#b97a10', 8, 8.5, 6, 6); ell(c, '#e9a91f', 8, 8, 6, 6); ell(c, '#ffd95a', 7.5, 7.5, 4.5, 4.5);
  R(c, '#e9a91f', 7, 5, 2, 6); R(c, '#fff3b8', 5, 5, 1, 2);
}

function iconCanvas(good: GoodId): HTMLCanvasElement {
  const el = document.createElement('canvas');
  el.width = el.height = 16;
  drawIcon(el.getContext('2d')!, good);
  return el;
}

// ── Trees and plants ────────────────────────────────────────────────────────

type Lobe = [x: number, y: number, r: number];
type LeafPal = [dark: string, mid: string, light: string, shine: string];

const LEAF: Record<string, LeafPal> = {
  oak: ['#2c6b3a', '#3d8c45', '#57ab50', '#84cd62'],
  lime: ['#4a8a34', '#62a63c', '#82c24a', '#b0dc6a'],
  pine: ['#225a4c', '#2d7560', '#429579', '#63b592'],
};

function canopy(c: Ctx, lobes: Lobe[], p: LeafPal, rand: () => number) {
  for (const [x, y, r] of lobes) ell(c, p[0], x + 1, y + 2, r, r * 0.92);
  for (const [x, y, r] of lobes) ell(c, p[1], x, y, r, r * 0.9);
  for (const [x, y, r] of lobes) ell(c, p[2], x - r * 0.22, y - r * 0.3, r * 0.68, r * 0.58);
  for (const [x, y, r] of lobes) ell(c, p[3], x - r * 0.4, y - r * 0.48, r * 0.3, r * 0.22);
  for (const [x, y, r] of lobes) {
    for (let i = 0; i < r * 1.8; i++) {
      const a = rand() * Math.PI * 2, d = rand() * r * 0.78;
      const lx = x + Math.cos(a) * d, ly = y + Math.sin(a) * d * 0.88;
      if (ly > y + r * 0.2) R(c, p[0], lx, ly, 2, 1);
      else { R(c, p[3], lx, ly, 2, 1); R(c, p[1], lx + 1, ly + 1, 1, 1); }
    }
  }
}

function trunk(c: Ctx, x: number, top: number, w: number, bottom: number) {
  R(c, '#6b4226', x, top, w, bottom - top);
  R(c, '#8a5a34', x, top, Math.ceil(w / 3), bottom - top);
  R(c, '#523019', x + w - 2, top, 2, bottom - top);
  R(c, '#6b4226', x - 2, bottom - 2, w + 4, 2);
  R(c, '#523019', x - 2, bottom - 1, w + 4, 1);
  for (let y = top + 3; y < bottom - 3; y += 5) R(c, '#523019', x + 1 + (y % 3), y, 2, 1);
}

function drawOak(c: Ctx, big: boolean, pal: LeafPal, apples: boolean) {
  const rand = rng(big ? 5 : apples ? 11 : 3);
  if (big) {
    ell(c, SHADOW, 23, 57, 17, 3.5);
    trunk(c, 20, 38, 7, 58);
    canopy(c, [[23, 21, 15], [11, 27, 10], [35, 27, 10], [15, 13, 9], [31, 13, 9], [23, 33, 11], [23, 9, 8]], pal, rand);
  } else {
    ell(c, SHADOW, 20, 49, 14, 3);
    trunk(c, 17, 32, 6, 50);
    canopy(c, [[20, 18, 13], [11, 23, 9], [29, 23, 9], [14, 12, 8], [26, 12, 8], [20, 28, 10]], pal, rand);
  }
  if (apples) for (const [x, y] of [[12, 20], [26, 16], [19, 27], [29, 26], [15, 11], [22, 9]]) { R(c, '#d8402f', x, y, 3, 3); R(c, '#ff8f7a', x, y, 1, 1); }
}

function drawPine(c: Ctx) {
  const p = LEAF.pine;
  ell(c, SHADOW, 15, 56, 11, 3);
  trunk(c, 13, 44, 4, 57);
  const tiers: [top: number, base: number, half: number][] = [[30, 50, 14], [20, 40, 12], [10, 30, 10], [1, 19, 7]];
  for (const [top, base, half] of tiers) {
    for (let y = top; y <= base; y++) {
      const w = Math.max(1, Math.round(((y - top) / (base - top)) * half));
      const jag = y === base ? 0 : (y % 3 === 0 ? 1 : 0);
      R(c, p[0], 15 - w - jag, y, (w + jag) * 2, 1);
      R(c, p[1], 15 - w - jag, y, Math.max(1, Math.round((w + jag) * 1.25)), 1);
      R(c, p[2], 15 - Math.round(w * 0.6), y, Math.max(1, Math.round(w * 0.5)), 1);
    }
    R(c, p[3], 14, top, 1, 3);
  }
}

function drawStump(c: Ctx) {
  ell(c, SHADOW, 11, 13, 10, 2.5);
  R(c, '#6b4226', 6, 6, 10, 8); R(c, '#8a5a34', 6, 6, 3, 8); R(c, '#523019', 14, 6, 2, 8);
  R(c, '#6b4226', 4, 12, 14, 2);
  ell(c, '#c99a62', 11, 6, 5, 2.4); ell(c, '#e2bf8c', 11, 6, 3.6, 1.6); ell(c, '#c99a62', 11, 6, 1.6, 0.7);
}

function drawRock(c: Ctx, ore: boolean) {
  ell(c, SHADOW, 9, 14, 8, 2);
  ell(c, '#585864', 9, 9, 8, 5.5); ell(c, '#747482', 8.5, 8, 7, 4.5); ell(c, '#9a9aaa', 6.5, 6, 3.5, 2);
  R(c, '#585864', 9, 5, 1, 6); R(c, '#585864', 10, 10, 4, 1); R(c, '#b9b9c8', 4, 6, 2, 1);
  if (ore) for (const [x, y] of [[11, 6], [5, 10], [13, 10], [8, 11]]) { R(c, '#e88a2a', x, y, 2, 3); R(c, '#ffc46a', x, y, 1, 2); R(c, '#fff0c0', x, y, 1, 1); }
}

function drawRubble(c: Ctx) {
  ell(c, SHADOW, 9, 14, 7, 1.5);
  ell(c, '#747482', 5, 12, 3, 2); ell(c, '#8a8a98', 12, 13, 2.5, 1.5); ell(c, '#747482', 9, 10, 2, 1.5);
}

function drawWheat(c: Ctx, cut: boolean) {
  if (cut) { for (const x of [3, 7, 11]) R(c, '#b3923c', x, 12, 1, 3); return; }
  for (const [x, top] of [[3, 4], [6, 2], [9, 3], [12, 5]] as const) {
    R(c, '#b98e2c', x, top + 4, 1, 15 - top - 4);
    R(c, '#e9c84e', x - 1, top, 3, 5); R(c, '#fbe58a', x, top, 1, 3); R(c, '#c99a2e', x - 1, top + 4, 1, 1);
  }
}

function drawBush(c: Ctx, flower: string) {
  ell(c, SHADOW, 8, 11, 7, 1.5);
  ell(c, '#2c6b3a', 8, 7, 7.5, 5); ell(c, '#3d8c45', 7.5, 6.2, 6.5, 4); ell(c, '#57ab50', 6, 5, 3.5, 2.2); ell(c, '#84cd62', 5, 4, 1.5, 1);
  for (const [x, y] of [[3, 6], [8, 3], [11, 7], [7, 8], [12, 4]]) { R(c, flower, x, y, 2, 2); R(c, '#fffbe0', x, y, 1, 1); }
}

function drawTallGrass(c: Ctx) {
  for (const [x, h, col] of [[1, 5, '#3d8c45'], [3, 7, '#57ab50'], [5, 6, '#3d8c45'], [7, 8, '#6cbf58'], [9, 5, '#3d8c45']] as const) {
    R(c, col, x, 9 - h, 1, h);
    R(c, col, x + (x % 4 === 1 ? -1 : 1), 9 - h, 1, 2);
  }
}

function drawFlowers(c: Ctx, petal: string) {
  for (const [x, y] of [[1, 3], [5, 1], [8, 4]]) {
    R(c, '#3d8c45', x + 1, y + 2, 1, 4);
    R(c, petal, x, y + 1, 3, 1); R(c, petal, x + 1, y, 1, 3); R(c, '#f2b632', x + 1, y + 1, 1, 1);
  }
}

function drawMushroom(c: Ctx) {
  R(c, '#f3ead8', 3, 4, 2, 3); ell(c, '#d8402f', 4, 3, 3.5, 2.2); R(c, '#ffffff', 2, 2, 1, 1); R(c, '#ffffff', 5, 3, 1, 1);
}

function drawPebbles(c: Ctx) {
  ell(c, '#8a8a98', 2.5, 3, 2, 1.5); ell(c, '#a8a8b6', 6, 2.5, 1.5, 1.2); R(c, '#c8c8d4', 2, 2, 1, 1);
}

function drawReeds(c: Ctx) {
  for (const [x, top] of [[1, 3], [4, 0], [7, 4]]) {
    R(c, '#4f8f3a', x, top + 3, 1, 12 - top); R(c, '#6cbf58', x, top + 5, 1, 3);
    R(c, '#7a4a26', x - 1 < 0 ? 0 : x, top, 2, 4); R(c, '#a8733e', x, top, 1, 2);
  }
}

function drawLilyPad(c: Ctx, bloom: boolean) {
  ell(c, '#2f7a4a', 4, 3, 4, 2.6); ell(c, '#4fa85e', 3.6, 2.6, 3, 1.8); R(c, '#2f7a4a', 4, 3, 3, 1);
  if (bloom) { R(c, '#ffd9ec', 2, 1, 3, 2); R(c, '#fff6b8', 3, 1, 1, 1); }
}

// ── Buildings and props ─────────────────────────────────────────────────────

export interface ShopLook {
  wall: 'stone' | 'timber' | 'plank';
  wallColor: string;
  roof: string;
  accent: string;
  sign: GoodId;
}

export const SHOP_LOOKS: Record<string, ShopLook> = {
  blacksmith: { wall: 'stone', wallColor: '#a7a39a', roof: '#59607a', accent: '#c2582f', sign: 'tools' },
  carpenter:  { wall: 'timber', wallColor: '#ecd9b0', roof: '#3f8a5a', accent: '#3f8a5a', sign: 'furniture' },
  baker:      { wall: 'timber', wallColor: '#f8ebd2', roof: '#c9553e', accent: '#d9534a', sign: 'bread' },
  fishmonger: { wall: 'plank', wallColor: '#dfecf0', roof: '#3d7fb0', accent: '#3d7fb0', sign: 'smoked_fish' },
};

/** Where things sit on the shop drawing, measured from its top-left corner. */
export const SHOP = { w: 80, h: 96, windows: [[19, 63], [61, 63]] as const, chimney: [60, 1] as const, door: [40, 90] as const };

function drawShop(c: Ctx, look: ShopLook) {
  const rand = rng(look.sign.length * 97 + 5);
  const roofDark = shade(look.roof, 0.72), roofLight = shade(look.roof, 1.18);
  ell(c, SHADOW, 40, 94, 39, 3);

  // chimney
  R(c, '#9a6a58', 56, 2, 9, 18);
  for (let y = 4; y < 20; y += 3) { R(c, '#7b5143', 56, y, 9, 1); R(c, '#7b5143', 58 + ((y / 3) % 2) * 3, y - 2, 1, 2); }
  R(c, '#b4857a', 56, 2, 2, 18); R(c, '#6b6b78', 55, 0, 11, 3); R(c, '#8d8d9a', 55, 0, 11, 1);

  // wall
  if (look.wall === 'stone') {
    for (let y = 44; y < 90; y++) {
      const row = Math.floor((y - 44) / 5), sy = (y - 44) % 5;
      for (let x = 5; x < 75; x++) {
        const sh = x - 5 + (row % 2) * 4, sx = sh % 8, col = Math.floor(sh / 8);
        const tone = [1, 0.93, 1.06, 0.88][(col * 7 + row * 3) % 4];
        R(c, sx === 0 || sy === 0 ? shade(look.wallColor, 0.68) : sy === 1 ? shade(look.wallColor, tone * 1.07) : shade(look.wallColor, tone), x, y);
      }
    }
  } else if (look.wall === 'plank') {
    for (let y = 44; y < 90; y += 4) { R(c, look.wallColor, 5, y, 70, 3); R(c, shade(look.wallColor, 0.8), 5, y + 3, 70, 1); R(c, shade(look.wallColor, 0.8), 8 + Math.floor(rand() * 60), y, 1, 3); }
    R(c, '#ffffff', 5, 44, 3, 46); R(c, '#ffffff', 72, 44, 3, 46);
  } else {
    R(c, look.wallColor, 5, 44, 70, 46);
    for (let i = 0; i < 46; i++) R(c, shade(look.wallColor, 0.9), 9 + rand() * 62, 49 + rand() * 38, 2, 1);
    const beam = '#6b4426', beamLight = '#8a5a34';
    for (const x of [5, 72]) { R(c, beam, x, 44, 3, 46); R(c, beamLight, x, 44, 1, 46); }
    for (const x of [29, 49]) { R(c, beam, x, 47, 2, 43); }
    R(c, beam, 5, 44, 70, 4); R(c, beamLight, 5, 44, 70, 1);
    for (let i = 0; i < 9; i++) { R(c, beam, 8 + i, 58 - i, 2, 1); R(c, beam, 70 - i, 58 - i, 2, 1); }
  }
  R(c, 'rgba(20,20,40,0.28)', 5, 44, 70, 3);

  // foundation
  R(c, '#85858f', 4, 88, 72, 6); R(c, '#a8a8b4', 4, 88, 72, 1); R(c, '#63636e', 4, 93, 72, 1);
  for (let x = 9; x < 74; x += 9) R(c, '#63636e', x, 89, 1, 4);

  // roof: rows of shingles, lighter at the ridge and darker toward the right
  for (let y = 6; y < 40; y++) {
    const inset = Math.round((12 * (40 - y)) / 34);
    const row = Math.floor((y - 6) / 5), sy = (y - 6) % 5;
    R(c, sy === 4 ? roofDark : sy === 0 ? roofLight : look.roof, inset, y, 80 - inset * 2, 1);
    if (sy > 0 && sy < 4) for (let x = inset + 2 + (row % 2) * 4; x < 79 - inset; x += 8) R(c, roofDark, x, y);
    R(c, 'rgba(10,10,40,0.12)', 52, y, 80 - inset - 52, 1);
  }
  R(c, roofLight, 11, 4, 58, 2); R(c, roofDark, 12, 6, 56, 1);
  R(c, roofDark, 0, 40, 80, 4); R(c, look.roof, 0, 40, 80, 1); R(c, shade(look.roof, 0.55), 0, 43, 80, 1);

  // hanging sign
  R(c, '#3b3b46', 31, 19, 1, 4); R(c, '#3b3b46', 48, 19, 1, 4);
  R(c, '#5a361c', 28, 22, 24, 24); R(c, '#8a5a34', 28, 22, 24, 1);
  R(c, '#f6e7c1', 30, 24, 20, 20); R(c, '#e3cf9d', 30, 42, 20, 2);
  c.drawImage(iconCanvas(look.sign), 32, 26);

  // door, with a stone step and a lantern
  ell(c, '#4a2c16', 40, 63, 8, 4); R(c, '#4a2c16', 32, 63, 16, 27);
  ell(c, '#8a5630', 40, 64.5, 6, 3); R(c, '#8a5630', 34, 65, 12, 25);
  R(c, '#a66c3e', 34, 65, 2, 25); R(c, '#6b4226', 38, 62, 1, 28); R(c, '#6b4226', 42, 62, 1, 28);
  R(c, '#3b3b46', 34, 69, 4, 1); R(c, '#3b3b46', 34, 83, 4, 1); R(c, '#f2c84b', 44, 77, 1, 2);
  R(c, '#9a9aa6', 30, 90, 20, 3); R(c, '#bcbcc8', 30, 90, 20, 1);
  R(c, '#3b3b46', 51, 62, 3, 1); R(c, '#3b3b46', 52, 63, 1, 2); R(c, '#3b3b46', 51, 65, 3, 5); R(c, '#ffe9a6', 52, 66, 1, 3);

  // windows with shutters and flower boxes
  for (const wx of [12, 54]) {
    for (const sx of [wx - 3, wx + 14]) {
      R(c, look.accent, sx, 55, 3, 16);
      for (let y = 57; y < 71; y += 3) R(c, shade(look.accent, 0.7), sx, y, 3, 1);
    }
    R(c, '#5a361c', wx, 55, 14, 16);
    R(c, '#8fcbea', wx + 1, 56, 12, 14);
    for (let i = 0; i < 6; i++) R(c, '#d8f1ff', wx + 2 + i, 62 - i, 2, 1);
    R(c, '#5a361c', wx + 6, 56, 2, 14); R(c, '#5a361c', wx + 1, 62, 12, 1);
    R(c, '#8a5a34', wx - 1, 71, 16, 2);
    R(c, '#6b4226', wx, 73, 14, 3);
    for (let i = 0; i < 5; i++) {
      R(c, '#3d8c45', wx + i * 3, 71, 2, 2);
      R(c, ['#ff7a9a', '#ffd95a', '#ffffff'][(i + wx) % 3], wx + i * 3 + (i % 2), 70, 1, 1);
    }
  }
  // a little ivy on the timbered shops
  if (look.wall === 'timber') for (let i = 0; i < 16; i++) { const y = 50 + i * 2.4; R(c, i % 3 ? '#3d8c45' : '#57ab50', 70 + Math.sin(i) * 2.5, y, 3, 2); }
}

function drawClosedBoard(c: Ctx) {
  R(c, '#5a361c', 0, 0, 30, 12); R(c, '#8a5a30', 1, 1, 28, 10); R(c, '#a8733e', 1, 1, 28, 1);
  const glyphs: Record<string, string[]> = {
    C: ['111', '100', '100', '100', '111'], L: ['100', '100', '100', '100', '111'], O: ['111', '101', '101', '101', '111'],
    S: ['111', '100', '111', '001', '111'], E: ['111', '100', '111', '100', '111'], D: ['110', '101', '101', '101', '110'],
  };
  'CLOSED'.split('').forEach((ch, i) => glyphs[ch].forEach((row, y) => row.split('').forEach((bit, x) => { if (bit === '1') R(c, '#2b1a0e', 3 + i * 4 + x, 3 + y, 1, 1); })));
}

/** A market stall with a striped awning. `level` (0 to 3) is how much is laid out on the table. */
function drawStall(c: Ctx, look: ShopLook, level: number) {
  ell(c, SHADOW, 13, 29, 12, 2);
  R(c, '#6b4226', 1, 6, 2, 23); R(c, '#6b4226', 23, 6, 2, 23); R(c, '#8a5a34', 1, 6, 1, 23); R(c, '#8a5a34', 23, 6, 1, 23);
  R(c, '#6b4226', 4, 22, 2, 7); R(c, '#6b4226', 20, 22, 2, 7);
  R(c, '#c99a62', 2, 17, 22, 3); R(c, '#e6c48e', 2, 17, 22, 1); R(c, '#8a5a34', 2, 20, 22, 2);
  c.imageSmoothingEnabled = false;
  const icon = iconCanvas(look.sign);
  for (let i = 0; i < level; i++) c.drawImage(icon, 3 + i * 7, 9, 9, 9);
  R(c, 'rgba(20,20,40,0.16)', 2, 8, 22, 2);
  for (let x = 0; x < 26; x++) {
    const stripe = Math.floor(x / 4) % 2 === 0;
    const tip = x % 4 === 1 || x % 4 === 2 ? 9 : 8;
    R(c, stripe ? look.accent : '#fff6e6', x, 1, 1, tip - 1);
    R(c, stripe ? shade(look.accent, 0.75) : '#e2d6c0', x, tip - 1, 1, 1);
  }
  R(c, shade(look.accent, 1.2), 0, 0, 26, 1);
}

function drawWell(c: Ctx) {
  ell(c, SHADOW, 13, 32, 12, 3);
  R(c, '#6b4226', 3, 8, 2, 18); R(c, '#6b4226', 21, 8, 2, 18); R(c, '#8a5a34', 3, 8, 1, 18); R(c, '#8a5a34', 21, 8, 1, 18);
  for (let y = 0; y < 8; y++) { const inset = Math.max(0, 3 - y); R(c, y % 3 === 2 ? '#8a3423' : '#b5462f', inset, y + 1, 26 - inset * 2, 1); }
  R(c, '#d06a4c', 3, 1, 20, 1); R(c, '#7a2c1e', 0, 8, 26, 1);
  R(c, '#4a3320', 12, 9, 1, 9); R(c, '#8a5a34', 10, 17, 5, 4); R(c, '#6b4226', 10, 20, 5, 1); R(c, '#a8733e', 10, 17, 1, 3);
  R(c, '#7f7f8b', 3, 20, 20, 11); R(c, '#a2a2b0', 3, 20, 20, 2); R(c, '#2e5d8c', 5, 21, 16, 2); R(c, '#5c9bd0', 6, 21, 5, 1);
  for (let row = 0; row < 3; row++) for (let x = 3 + (row % 2) * 3; x < 23; x += 6) { R(c, '#62626e', x, 23 + row * 3, 1, 3); }
  for (let row = 0; row < 3; row++) R(c, '#62626e', 3, 25 + row * 3, 20, 1);
}

function drawLamp(c: Ctx) {
  R(c, '#33333e', 4, 9, 2, 20); R(c, '#55556a', 4, 9, 1, 20);
  R(c, '#26262f', 2, 28, 6, 2); R(c, '#33333e', 3, 26, 4, 2);
  R(c, '#33333e', 1, 2, 8, 8); R(c, '#ffe9a6', 2, 3, 6, 6); R(c, '#fff8dc', 3, 4, 3, 4); R(c, '#33333e', 5, 3, 1, 6);
  R(c, '#26262f', 0, 1, 10, 1); R(c, '#33333e', 3, 0, 4, 1); R(c, '#26262f', 1, 9, 8, 1);
}

function drawFence(c: Ctx) {
  R(c, SHADOW, 0, 11, 16, 1);
  R(c, '#c99a62', 0, 3, 16, 2); R(c, '#8a5a34', 0, 5, 16, 1);
  R(c, '#c99a62', 0, 7, 16, 2); R(c, '#8a5a34', 0, 9, 16, 1);
  for (const x of [2, 10]) { R(c, '#8a5a34', x, 0, 3, 12); R(c, '#e2bf8c', x, 0, 1, 11); R(c, '#6b4226', x + 2, 1, 1, 11); }
}

function drawBarrel(c: Ctx) {
  ell(c, SHADOW, 5, 12, 5, 1.5);
  R(c, '#8a5a34', 1, 1, 8, 11); R(c, '#6b4226', 0, 3, 10, 7); R(c, '#8a5a34', 1, 3, 8, 7);
  R(c, '#b07a48', 2, 1, 2, 11); R(c, '#6b4226', 7, 1, 1, 11);
  R(c, '#4a4a58', 0, 3, 10, 1); R(c, '#4a4a58', 0, 9, 10, 1); R(c, '#8d8d9a', 1, 3, 2, 1); R(c, '#8d8d9a', 1, 9, 2, 1);
  ell(c, '#6b4226', 5, 1.5, 4, 1.2); ell(c, '#c99a62', 5, 1.3, 3, 0.8);
}

function drawCrate(c: Ctx) {
  R(c, SHADOW, 0, 11, 12, 1);
  R(c, '#6b4226', 0, 0, 12, 11); R(c, '#c99a62', 1, 1, 10, 9);
  for (let i = 0; i < 8; i++) { R(c, '#8a5a34', 2 + i, 2 + i, 1, 1); R(c, '#8a5a34', 9 - i, 2 + i, 1, 1); }
  R(c, '#e6c48e', 1, 1, 10, 1); R(c, '#8a5a34', 1, 9, 10, 1);
}

function drawBench(c: Ctx) {
  R(c, SHADOW, 1, 12, 20, 1);
  R(c, '#6b4226', 1, 0, 2, 12); R(c, '#6b4226', 19, 0, 2, 12);
  R(c, '#c99a62', 0, 1, 22, 3); R(c, '#e6c48e', 0, 1, 22, 1); R(c, '#8a5a34', 0, 3, 22, 1);
  R(c, '#c99a62', 0, 6, 22, 3); R(c, '#e6c48e', 0, 6, 22, 1); R(c, '#8a5a34', 0, 9, 22, 1);
}

function drawMine(c: Ctx) {
  ell(c, SHADOW, 24, 45, 23, 3);
  ell(c, '#585864', 24, 27, 23.5, 20); ell(c, '#747486', 22, 23, 20, 16); ell(c, '#9797a8', 17, 15, 10, 6); ell(c, '#b4b4c4', 14, 12, 4, 2);
  for (const [x, y] of [[8, 26], [36, 20], [40, 30], [30, 10], [12, 36]]) { R(c, '#4a4a56', x, y, 4, 1); R(c, '#4a4a56', x + 1, y + 1, 3, 1); }
  for (const [x, y] of [[34, 26], [10, 20], [38, 36]]) { R(c, '#e88a2a', x, y, 2, 3); R(c, '#ffc46a', x, y, 1, 2); }
  ell(c, '#15151f', 24, 34, 8.5, 9); R(c, '#15151f', 16, 34, 17, 12); R(c, '#2a2a38', 18, 40, 13, 6);
  R(c, '#6b4226', 13, 28, 3, 18); R(c, '#8a5a34', 13, 28, 1, 18);
  R(c, '#6b4226', 32, 28, 3, 18); R(c, '#8a5a34', 32, 28, 1, 18);
  R(c, '#8a5a34', 12, 25, 24, 4); R(c, '#b07a48', 12, 25, 24, 1); R(c, '#523019', 12, 28, 24, 1);
  R(c, '#33333e', 23, 29, 2, 2); R(c, '#ffe9a6', 22, 31, 4, 4); R(c, '#fff8dc', 23, 32, 2, 2);
  R(c, '#6b6b78', 20, 43, 1, 4); R(c, '#6b6b78', 27, 43, 1, 4);
  for (const y of [44, 46]) R(c, '#523019', 19, y, 10, 1);
}

function drawMineCart(c: Ctx) {
  ell(c, SHADOW, 9, 12, 8, 1.5);
  R(c, '#4a4a58', 2, 4, 14, 6); R(c, '#6b6b7a', 2, 4, 14, 1); R(c, '#33333e', 3, 9, 12, 1);
  ell(c, '#747482', 6, 3.5, 3, 2); ell(c, '#585864', 11, 3.5, 3.5, 2.2); R(c, '#e88a2a', 9, 2, 2, 2); R(c, '#e88a2a', 5, 3, 1, 1);
  ell(c, '#26262f', 5, 11, 2, 2); ell(c, '#26262f', 13, 11, 2, 2); R(c, '#8d8d9a', 5, 11, 1, 1); R(c, '#8d8d9a', 13, 11, 1, 1);
}

function drawBoat(c: Ctx) {
  ell(c, 'rgba(20,60,110,0.35)', 15, 11, 14, 3);
  ell(c, '#6b4226', 15, 8, 14, 5); ell(c, '#8a5a34', 15, 7, 13, 4); ell(c, '#c99a62', 15, 6.5, 11, 2.8);
  R(c, '#6b4226', 9, 5, 2, 4); R(c, '#6b4226', 19, 5, 2, 4);
  R(c, '#8a5a34', 4, 3, 12, 1); R(c, '#e2bf8c', 2, 2, 3, 2);
}

function drawDockPost(c: Ctx) {
  R(c, '#6b4226', 0, 1, 4, 11); R(c, '#8a5a34', 0, 1, 1, 11); R(c, '#c99a62', 0, 0, 4, 2); R(c, '#e6d6b8', 0, 5, 4, 1);
}

function drawAnvil(c: Ctx) {
  ell(c, SHADOW, 9, 15, 8, 1.5);
  R(c, '#6b4226', 5, 10, 8, 5); R(c, '#8a5a34', 5, 10, 2, 5); ell(c, '#c99a62', 9, 10, 4, 1.4);
  R(c, '#3a3a46', 3, 3, 12, 3); R(c, '#5c5c6c', 3, 3, 12, 1); R(c, '#3a3a46', 0, 4, 4, 2); R(c, '#3a3a46', 6, 6, 6, 2); R(c, '#3a3a46', 5, 8, 8, 2);
  R(c, '#8a5a34', 12, 0, 1, 4); R(c, '#6b6b7a', 10, 0, 4, 2);
}

function drawLogPile(c: Ctx) {
  ell(c, SHADOW, 10, 12, 10, 1.5);
  for (const [x, y] of [[0, 6], [7, 6], [14, 6], [3, 1], [10, 1]]) {
    R(c, '#6b4226', x, y, 6, 6); R(c, '#8a5a34', x, y, 6, 2);
    ell(c, '#c99a62', x + 3, y + 3, 2.5, 2.5); ell(c, '#e6c48e', x + 3, y + 3, 1.3, 1.3);
  }
}

function drawFishRack(c: Ctx) {
  ell(c, SHADOW, 9, 17, 9, 1.5);
  R(c, '#6b4226', 1, 1, 2, 16); R(c, '#6b4226', 15, 1, 2, 16); R(c, '#8a5a34', 0, 2, 18, 2); R(c, '#b07a48', 0, 2, 18, 1);
  for (const x of [4, 8, 12]) { R(c, '#a8672e', x, 4, 2, 7); R(c, '#d9a066', x, 5, 1, 5); R(c, '#7a4517', x - 1, 10, 4, 2); }
}

function drawBreadBasket(c: Ctx) {
  ell(c, SHADOW, 7, 11, 7, 1.5);
  R(c, '#b07a48', 1, 5, 12, 6); R(c, '#8a5a34', 1, 10, 12, 1);
  for (let x = 2; x < 13; x += 3) R(c, '#8a5a34', x, 5, 1, 6);
  R(c, '#d0a068', 0, 4, 14, 2);
  ell(c, '#de9f52', 4, 3, 3, 2); ell(c, '#de9f52', 9, 2.5, 3.5, 2.2); R(c, '#f3c886', 8, 1, 3, 1); R(c, '#b5722e', 4, 3, 1, 1);
}

function drawHay(c: Ctx) {
  ell(c, SHADOW, 8, 12, 8, 1.5);
  R(c, '#d9b23c', 1, 2, 14, 10); R(c, '#f0d060', 1, 2, 14, 2); R(c, '#b98e2c', 1, 10, 14, 2);
  for (const x of [5, 10]) R(c, '#8a5a34', x, 2, 1, 10);
  for (const [x, y] of [[3, 5], [7, 7], [12, 5], [8, 4]]) R(c, '#b98e2c', x, y, 2, 1);
}

function drawScarecrow(c: Ctx) {
  ell(c, SHADOW, 9, 27, 6, 1.5);
  R(c, '#8a5a34', 8, 8, 2, 20); R(c, '#8a5a34', 1, 11, 16, 2);
  R(c, '#c2582f', 4, 10, 10, 9); R(c, '#9a3f20', 4, 17, 10, 2); R(c, '#e9c84e', 0, 11, 2, 3); R(c, '#e9c84e', 16, 11, 2, 3);
  for (const x of [5, 8, 11]) R(c, '#e9c84e', x, 19, 2, 3);
  ell(c, '#e6c48e', 9, 6, 3.5, 3.5); R(c, '#2b2233', 7, 5, 1, 2); R(c, '#2b2233', 10, 5, 1, 2); R(c, '#9a3f20', 8, 8, 2, 1);
  R(c, '#b98e2c', 3, 2, 12, 2); R(c, '#d9b23c', 6, 0, 6, 3); R(c, '#c2582f', 6, 2, 6, 1);
}

function drawSignpost(c: Ctx) {
  ell(c, SHADOW, 8, 23, 5, 1.5);
  R(c, '#6b4226', 7, 2, 2, 22); R(c, '#8a5a34', 7, 2, 1, 22);
  R(c, '#c99a62', 0, 3, 13, 5); R(c, '#e6c48e', 0, 3, 13, 1); R(c, '#8a5a34', 2, 5, 8, 1); R(c, '#c99a62', 13, 4, 1, 3); R(c, '#c99a62', 14, 5, 1, 1);
  R(c, '#c99a62', 3, 10, 13, 5); R(c, '#e6c48e', 3, 10, 13, 1); R(c, '#8a5a34', 6, 12, 8, 1); R(c, '#c99a62', 2, 11, 1, 3); R(c, '#c99a62', 1, 12, 1, 1);
}

function drawNoticeBoard(c: Ctx) {
  ell(c, SHADOW, 11, 21, 10, 1.5);
  R(c, '#6b4226', 2, 4, 2, 18); R(c, '#6b4226', 18, 4, 2, 18);
  R(c, '#b5462f', 0, 0, 22, 4); R(c, '#d06a4c', 0, 0, 22, 1); R(c, '#7a2c1e', 0, 3, 22, 1);
  R(c, '#8a5a34', 1, 4, 20, 12); R(c, '#c99a62', 2, 5, 18, 10);
  R(c, '#fffaf0', 3, 6, 6, 7); R(c, '#fffaf0', 11, 7, 7, 5); R(c, '#f6e7c1', 10, 13, 5, 2);
  for (const [x, y] of [[4, 8], [4, 10], [12, 9]]) R(c, '#8a7a66', x, y, 4, 1);
  R(c, '#d8402f', 5, 6, 1, 1); R(c, '#3d7fb0', 14, 7, 1, 1);
}

function drawPlanter(c: Ctx, flower: string) {
  ell(c, SHADOW, 7, 11, 7, 1.5);
  R(c, '#8a5a34', 1, 6, 12, 6); R(c, '#b07a48', 1, 6, 12, 1); R(c, '#6b4226', 1, 11, 12, 1); R(c, '#6b4226', 0, 5, 14, 2);
  ell(c, '#3d8c45', 7, 4, 6, 2.5);
  for (const [x, y] of [[2, 2], [6, 1], [10, 2], [4, 4], [9, 4]]) { R(c, flower, x, y, 2, 2); R(c, '#fffbe0', x, y, 1, 1); }
}

// ── Small effects (no outline) ──────────────────────────────────────────────

function glow(size: number, color: string): HTMLCanvasElement {
  const el = document.createElement('canvas');
  el.width = el.height = size;
  const c = el.getContext('2d')!;
  const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, `rgba(${color},0.75)`);
  g.addColorStop(0.4, `rgba(${color},0.28)`);
  g.addColorStop(1, `rgba(${color},0)`);
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  return el;
}

/** A soft squashed blob, used for cloud shadows and for light spilling onto the ground. */
function softEllipse(w: number, h: number, color: string, strength: number): HTMLCanvasElement {
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  const c = el.getContext('2d')!;
  c.scale(1, h / w);
  const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
  g.addColorStop(0, `rgba(${color},${strength})`);
  g.addColorStop(0.6, `rgba(${color},${strength * 0.6})`);
  g.addColorStop(1, `rgba(${color},0)`);
  c.fillStyle = g;
  c.fillRect(0, 0, w, w);
  return el;
}

function plain(w: number, h: number, draw: (c: Ctx) => void): HTMLCanvasElement {
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  draw(el.getContext('2d')!);
  return el;
}

function drawBubble(c: Ctx) {
  R(c, '#2b2233', 1, 0, 10, 11); R(c, '#2b2233', 0, 1, 12, 9);
  R(c, '#fffaf0', 1, 1, 10, 9);
  R(c, '#2b2233', 4, 11, 4, 1); R(c, '#2b2233', 5, 12, 2, 1); R(c, '#fffaf0', 5, 10, 2, 2);
  ell(c, '#e9a91f', 6, 5.5, 3, 3); ell(c, '#ffd95a', 5.5, 5, 2, 2); R(c, '#b97a10', 6, 4, 1, 3);
}

function drawTrend(c: Ctx, up: boolean) {
  const rows = up ? [1, 3, 5, 7, 3, 3, 3] : [3, 3, 3, 7, 5, 3, 1];
  rows.forEach((w, y) => R(c, '#2b2233', (7 - w) / 2, y, w, 1));
  rows.forEach((w, y) => { if (w > 2) R(c, up ? '#4fbf4a' : '#e0553a', (7 - w) / 2 + 1, y, w - 2, 1); });
}

function drawPointer(c: Ctx) {
  const ink = '#2b2233';
  R(c, ink, 3, 0, 5, 7); R(c, ink, 0, 6, 11, 1);
  for (let i = 0; i < 5; i++) R(c, ink, 1 + i, 7 + i, 9 - i * 2, 1);
  R(c, '#ffd95a', 4, 1, 3, 6);
  for (let i = 0; i < 4; i++) R(c, '#ffd95a', 2 + i, 7 + i, 7 - i * 2, 1);
  R(c, '#fff3b8', 4, 1, 1, 5);
}

// ── People ──────────────────────────────────────────────────────────────────

export interface Look {
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
  apron?: string;
  hat?: { kind: 'toque' | 'straw' | 'cap'; color: string; band?: string };
  bun?: boolean;
  long?: boolean;
  beard?: boolean;
}

export const LOOKS: Record<string, Look> = {
  player:     { skin: '#f6cba2', hair: '#7a4a24', shirt: '#3f7fd9', pants: '#4a4d74', hat: { kind: 'straw', color: '#e9c96a', band: '#c2582f' } },
  blacksmith: { skin: '#e8b98c', hair: '#c1492c', shirt: '#73738a', pants: '#3d3d4a', apron: '#4f382a', bun: true },
  baker:      { skin: '#f6cba2', hair: '#9a9a9a', shirt: '#f3efe6', pants: '#7d6a58', apron: '#e8dcc6', hat: { kind: 'toque', color: '#ffffff' }, beard: true },
  fishmonger: { skin: '#d9a777', hair: '#2a3f6b', shirt: '#3aa79c', pants: '#2f5d6b', apron: '#f2e9c9', hat: { kind: 'cap', color: '#2f6ea6' }, long: true },
  carpenter:  { skin: '#f0c296', hair: '#c9963c', shirt: '#9a5f2e', pants: '#4f6b3a', beard: true },
  villager1:  { skin: '#f6cba2', hair: '#3a2a22', shirt: '#d96a8a', pants: '#5a4a6e', long: true },
  villager2:  { skin: '#c9925e', hair: '#1c1c28', shirt: '#e2b23c', pants: '#3d5a4a' },
  villager3:  { skin: '#f0c296', hair: '#e6dccb', shirt: '#7a5ac9', pants: '#4a4a55', bun: true },
  villager4:  { skin: '#e8b98c', hair: '#a85a2a', shirt: '#59a84a', pants: '#6b4a3a', hat: { kind: 'cap', color: '#8a5a34' } },
  villager5:  { skin: '#d9a777', hair: '#5a2a4a', shirt: '#e07a3c', pants: '#3a4a6b', long: true },
};

export type Dir = 'down' | 'up' | 'left' | 'right';
export const DIRS: Dir[] = ['down', 'up', 'left', 'right'];
/** Size of one character frame, including the outline's padding. */
export const CHAR_W = 18;
export const CHAR_H = 28;

/** One 16x26 character. frame 0 stands; 1 and 2 are the two halves of a step. */
function drawChar(c: Ctx, dir: Dir, frame: number, p: Look) {
  const ink = '#2b2233';
  const side = dir === 'left' || dir === 'right';
  const flip = dir === 'right';
  /** Mirror an x position for the right-facing view. */
  const X = (x: number, w: number) => (flip ? 16 - x - w : x);
  const b = frame === 0 ? 0 : -1; // the upper body lifts a pixel mid-step
  const top = 4 + b;

  ell(c, SHADOW, 8, 25, 5, 1.5);

  // legs and shoes
  const legX = side ? [6, 8] : [5, 9];
  const lift = [frame === 1 ? 1 : 0, frame === 2 ? 1 : 0];
  legX.forEach((lx, i) => {
    R(c, p.pants, lx, 20, 2, 3 - lift[i]);
    R(c, shade(p.pants, 0.8), lx + 1, 20, 1, 3 - lift[i]);
    R(c, '#3a2a22', lx, 23 - lift[i], 2, 2);
  });

  // body
  R(c, p.shirt, 4, top + 9, 8, 8);
  R(c, shade(p.shirt, 0.82), 4, top + 15, 8, 2);
  R(c, shade(p.shirt, 0.82), 10, top + 9, 2, 8);
  if (!side && dir === 'down') R(c, shade(p.shirt, 0.75), 7, top + 9, 2, 1);
  if (p.apron && dir !== 'up') {
    R(c, p.apron, side ? X(4, 5) : 5, top + 11, side ? 5 : 6, 6);
    R(c, shade(p.apron, 0.85), side ? X(4, 5) : 5, top + 16, side ? 5 : 6, 1);
    if (!side) { R(c, p.apron, 5, top + 9, 1, 2); R(c, p.apron, 10, top + 9, 1, 2); }
  }
  if (side) {
    const swing = frame === 1 ? -1 : frame === 2 ? 1 : 0;
    R(c, shade(p.shirt, 0.9), X(7 + swing, 2), top + 10, 2, 5);
    R(c, p.skin, X(7 + swing, 2), top + 15, 2, 1);
  } else {
    const a = frame === 1 ? 1 : 0, d = frame === 2 ? 1 : 0;
    R(c, shade(p.shirt, 0.9), 3, top + 10, 1, 5 - a); R(c, p.skin, 3, top + 15 - a, 1, 1);
    R(c, shade(p.shirt, 0.9), 12, top + 10, 1, 5 - d); R(c, p.skin, 12, top + 15 - d, 1, 1);
  }

  // head
  R(c, p.skin, 3, top, 10, 9);
  R(c, shade(p.skin, 0.9), 3, top + 8, 10, 1);
  if (dir === 'down') {
    R(c, p.hair, 3, top - 1, 10, 3); R(c, p.hair, 2, top, 1, p.long ? 10 : 5); R(c, p.hair, 13, top, 1, p.long ? 10 : 5);
    R(c, p.hair, 3, top + 2, 2, 1); R(c, p.hair, 11, top + 2, 2, 1);
    if (p.long) { R(c, p.hair, 3, top + 6, 1, 4); R(c, p.hair, 12, top + 6, 1, 4); }
    R(c, ink, 5, top + 4, 1, 2); R(c, ink, 10, top + 4, 1, 2);
    R(c, '#f09a8a', 4, top + 6, 1, 1); R(c, '#f09a8a', 11, top + 6, 1, 1);
    if (p.beard) { R(c, p.hair, 4, top + 6, 8, 3); R(c, p.skin, 7, top + 6, 2, 1); R(c, shade(p.hair, 0.8), 7, top + 7, 2, 1); }
    else R(c, shade(p.skin, 0.78), 7, top + 7, 2, 1);
  } else if (dir === 'up') {
    R(c, p.hair, 2, top - 1, 12, p.long ? 12 : 9); R(c, shade(p.hair, 0.82), 3, top + 5, 10, 2);
    if (!p.long) R(c, p.skin, 6, top + 8, 4, 1);
  } else {
    R(c, p.hair, 3, top - 1, 10, 3);
    R(c, p.hair, X(8, 6), top, 6, p.long ? 11 : 7);
    R(c, shade(p.hair, 0.82), X(11, 3), top + 3, 3, 3);
    R(c, ink, X(4, 1), top + 4, 1, 2);
    R(c, p.skin, X(2, 1), top + 5, 1, 2);
    R(c, '#f09a8a', X(5, 1), top + 6, 1, 1);
    if (p.beard) R(c, p.hair, X(3, 5), top + 6, 5, 3);
  }
  if (p.bun) { R(c, p.hair, 6, top - 3, 4, 3); R(c, shade(p.hair, 1.15), 6, top - 3, 2, 1); }

  // hats
  const hat = p.hat;
  if (hat?.kind === 'toque') {
    R(c, hat.color, 3, top - 2, 10, 3); R(c, hat.color, 2, top - 4, 12, 3); R(c, '#e2e2ea', 3, top, 10, 1); R(c, '#e2e2ea', 10, top - 4, 3, 3);
  } else if (hat?.kind === 'straw') {
    R(c, hat.color, 4, top - 3, 8, 3); R(c, shade(hat.color, 1.12), 4, top - 3, 8, 1);
    R(c, hat.band ?? hat.color, 4, top - 1, 8, 1);
    R(c, hat.color, 1, top, 14, 2); R(c, shade(hat.color, 0.82), 1, top + 1, 14, 1);
  } else if (hat?.kind === 'cap') {
    R(c, hat.color, 2, top - 2, 12, 4); R(c, shade(hat.color, 1.2), 3, top - 2, 9, 1); R(c, shade(hat.color, 0.78), 2, top + 1, 12, 1);
    if (dir === 'down') R(c, shade(hat.color, 0.78), 4, top + 2, 8, 1);
  }
}

/** A sheet of 12 frames in a row: 4 directions x 3 frames. */
export function charSheet(look: Look): HTMLCanvasElement {
  const el = document.createElement('canvas');
  el.width = CHAR_W * 12;
  el.height = CHAR_H;
  const c = el.getContext('2d')!;
  DIRS.forEach((dir, d) => {
    for (let f = 0; f < 3; f++) c.drawImage(sprite(16, 26, (s) => drawChar(s, dir, f, look)), (d * 3 + f) * CHAR_W, 0);
  });
  return el;
}

// ── Everything the town scene needs, by name ────────────────────────────────

export function buildTextures(): Record<string, HTMLCanvasElement> {
  const t: Record<string, HTMLCanvasElement> = {
    'tree-0': sprite(40, 52, (c) => drawOak(c, false, LEAF.oak, false)),
    'tree-1': sprite(46, 60, (c) => drawOak(c, true, LEAF.oak, false)),
    'tree-2': sprite(30, 58, drawPine),
    'tree-3': sprite(40, 52, (c) => drawOak(c, false, LEAF.lime, false)),
    'tree-4': sprite(40, 52, (c) => drawOak(c, false, LEAF.oak, true)),
    stump: sprite(22, 15, drawStump),
    rock: sprite(18, 16, (c) => drawRock(c, true)),
    boulder: sprite(18, 16, (c) => drawRock(c, false)),
    'rock-spent': sprite(18, 16, drawRubble),
    wheat: sprite(16, 16, (c) => drawWheat(c, false)),
    'wheat-spent': sprite(16, 16, (c) => drawWheat(c, true), false),
    tallgrass: sprite(11, 9, drawTallGrass, false),
    mushroom: sprite(8, 8, drawMushroom),
    pebbles: sprite(8, 5, drawPebbles),
    reeds: sprite(9, 16, drawReeds),
    lily: sprite(8, 6, (c) => drawLilyPad(c, false)),
    'lily-bloom': sprite(8, 6, (c) => drawLilyPad(c, true)),
    well: sprite(26, 34, drawWell),
    lamp: sprite(10, 30, drawLamp),
    fence: sprite(16, 12, drawFence),
    barrel: sprite(10, 13, drawBarrel),
    crate: sprite(12, 12, drawCrate),
    bench: sprite(22, 13, drawBench),
    mine: sprite(48, 48, drawMine),
    minecart: sprite(18, 14, drawMineCart),
    boat: sprite(30, 14, drawBoat),
    dockpost: sprite(4, 12, drawDockPost),
    hay: sprite(16, 13, drawHay),
    scarecrow: sprite(18, 28, drawScarecrow),
    signpost: sprite(16, 24, drawSignpost),
    noticeboard: sprite(22, 22, drawNoticeBoard),
    closed: sprite(30, 12, drawClosedBoard),
    'prop-blacksmith': sprite(18, 16, drawAnvil),
    'prop-carpenter': sprite(20, 13, drawLogPile),
    'prop-baker': sprite(14, 12, drawBreadBasket),
    'prop-fishmonger': sprite(18, 18, drawFishRack),

    bubble: plain(12, 14, drawBubble),
    'trend-up': plain(7, 7, (c) => drawTrend(c, true)),
    'trend-down': plain(7, 7, (c) => drawTrend(c, false)),
    pointer: plain(11, 12, drawPointer),
    ripple: plain(16, 16, (c) => {
      const w = 'rgba(255,255,255,0.9)';
      R(c, w, 4, 6, 8, 1); R(c, w, 3, 7, 1, 2); R(c, w, 12, 7, 1, 2); R(c, w, 4, 9, 8, 1); R(c, 'rgba(255,255,255,0.6)', 7, 7, 2, 1);
    }),
    sparkle: plain(7, 7, (c) => { R(c, '#ffffff', 3, 0, 1, 7); R(c, '#ffffff', 0, 3, 7, 1); R(c, '#fff6b8', 2, 2, 3, 3); }),
    puff: plain(8, 8, (c) => { ell(c, 'rgba(255,255,255,0.75)', 4, 4, 3.5, 3.5); ell(c, 'rgba(255,255,255,0.9)', 3.5, 3.5, 2, 2); }),
    px: plain(2, 2, (c) => R(c, '#ffffff', 0, 0, 2, 2)),
    glint: plain(5, 1, (c) => R(c, '#ffffff', 0, 0, 5, 1)),
    mote: plain(1, 1, (c) => R(c, '#fff6c8', 0, 0, 1, 1)),
    leaf: plain(3, 2, (c) => { R(c, '#84cd62', 0, 0, 2, 1); R(c, '#57ab50', 1, 1, 2, 1); }),
    glow: glow(96, '255,214,130'),
    'window-glow': glow(30, '255,196,96'),
    firefly: glow(9, '220,255,130'),
    cloud: softEllipse(220, 120, '20,30,60', 0.55),
    'light-pool': softEllipse(44, 26, '255,200,110', 0.5),
  };

  ['#ff8fb0', '#ffd95a', '#ffffff', '#c9a8ff'].forEach((col, i) => {
    t[`bush-${i}`] = sprite(16, 12, (c) => drawBush(c, col));
    t[`flowers-${i}`] = sprite(10, 8, (c) => drawFlowers(c, col));
    t[`planter-${i}`] = sprite(14, 12, (c) => drawPlanter(c, col));
    t[`bfly-${i}`] = plain(5, 4, (c) => { R(c, col, 0, 0, 2, 3); R(c, col, 3, 0, 2, 3); R(c, '#ffffff', 0, 0, 1, 1); R(c, '#ffffff', 4, 0, 1, 1); R(c, '#3b2416', 2, 0, 1, 4); });
  });
  for (const [id, look] of Object.entries(SHOP_LOOKS)) {
    t[`shop-${id}`] = sprite(SHOP.w, SHOP.h, (c) => drawShop(c, look));
    for (let n = 0; n <= 3; n++) t[`stall-${id}-${n}`] = sprite(26, 30, (c) => drawStall(c, look, n));
  }
  return t;
}

export const TREE_KINDS = 5;

// ── Images for the on-screen panels ─────────────────────────────────────────

const cache = new Map<string, string>();
const memo = (key: string, make: () => string) => cache.get(key) ?? (cache.set(key, make()), cache.get(key)!);

export const iconUrl = (good: GoodId) => memo(`icon:${good}`, () => sprite(16, 16, (c) => drawIcon(c, good)).toDataURL());
export const coinUrl = () => memo('coin', () => sprite(16, 16, drawCoin).toDataURL());
/** A head-and-shoulders crop of a character, facing us. */
export const portraitUrl = (who: string) =>
  memo(`face:${who}`, () => {
    const full = sprite(16, 26, (c) => drawChar(c, 'down', 0, LOOKS[who]));
    return plain(18, 17, (c) => c.drawImage(full, 0, 0)).toDataURL();
  });
