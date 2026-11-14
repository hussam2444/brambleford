// Paints the whole map's ground into one image, pixel by pixel.
//
// Working per pixel (not per tile) is what lets grass vary in broad patches,
// paths have rounded, ragged edges, and the river have a sandy shore.

export const TILE = 16;
export type Ground = 'grass' | 'path' | 'cobble' | 'water' | 'soil' | 'stone' | 'planks';

type RGB = [number, number, number];
const rgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const ramp = (...hex: string[]) => hex.map(rgb);
const scale = (c: RGB, by: number): RGB => [c[0] * by, c[1] * by, c[2] * by];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const GRASS = ramp('#4b9541', '#57a547', '#64b44e', '#72c156', '#84ce61');
const DIRT = ramp('#c29a60', '#d0ab72', '#dbba83', '#e6c994');
const COBBLE = ramp('#a69d8d', '#b4ab9b', '#c2b9a9', '#bbae9a');
const MORTAR = rgb('#7c7567');
const SOIL = { dark: rgb('#7b5334'), base: rgb('#9a6c44'), light: rgb('#b88a5c') };
const GRAVEL = ramp('#86867f', '#96968e', '#a5a59d');
const WATER = { deep: rgb('#3b8fd0'), deep2: rgb('#479cd9'), shallow: rgb('#5eb4e6'), foam: rgb('#b4e2f7'), sand: rgb('#e4d09a'), wet: rgb('#cbb47c') };

/** Repeatable pseudo-random number in [0, 1) for a grid point. */
function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth noise: nearby points get similar values. */
function noise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const s = (t: number) => t * t * (3 - 2 * t);
  const xf = s(x - xi), yf = s(y - yi);
  return lerp(
    lerp(hash(xi, yi, seed), hash(xi + 1, yi, seed), xf),
    lerp(hash(xi, yi + 1, seed), hash(xi + 1, yi + 1, seed), xf),
    yf,
  );
}

export function paintGround(grid: Ground[][]): HTMLCanvasElement {
  const TH = grid.length, TW = grid[0].length;
  const W = TW * TILE, H = TH * TILE;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const put = (x: number, y: number, c: RGB) => {
    const i = (y * W + x) * 4;
    img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
  };
  const kind = (tx: number, ty: number): Ground => grid[Math.max(0, Math.min(TH - 1, ty))][Math.max(0, Math.min(TW - 1, tx))];
  const wet = (k: Ground) => k === 'water' || k === 'planks';
  const bare = (k: Ground) => k !== 'grass';

  /** How far a pixel is from the nearest tile that fails `inside`, with outer corners rounded off. */
  const edge = (px: number, py: number, inside: (k: Ground) => boolean): number => {
    const tx = px >> 4, ty = py >> 4;
    const ox = (px & 15) + 0.5, oy = (py & 15) + 0.5;
    const L = !inside(kind(tx - 1, ty)), R = !inside(kind(tx + 1, ty));
    const U = !inside(kind(tx, ty - 1)), D = !inside(kind(tx, ty + 1));
    const dl = L ? ox : 99, dr = R ? 16 - ox : 99, du = U ? oy : 99, dd = D ? 16 - oy : 99;
    let d = Math.min(dl, dr, du, dd);
    const rad = 7;
    const round = (a: number, b: number) => { if (a < rad && b < rad) d = Math.min(d, rad - Math.hypot(rad - a, rad - b)); };
    if (L && U) round(dl, du);
    if (R && U) round(dr, du);
    if (L && D) round(dl, dd);
    if (R && D) round(dr, dd);
    if (!L && !U && !inside(kind(tx - 1, ty - 1))) d = Math.min(d, Math.hypot(ox, oy));
    if (!R && !U && !inside(kind(tx + 1, ty - 1))) d = Math.min(d, Math.hypot(16 - ox, oy));
    if (!L && !D && !inside(kind(tx - 1, ty + 1))) d = Math.min(d, Math.hypot(ox, 16 - oy));
    if (!R && !D && !inside(kind(tx + 1, ty + 1))) d = Math.min(d, Math.hypot(16 - ox, 16 - oy));
    return d;
  };

  const grass = (x: number, y: number): RGB => {
    const v = noise(x / 62, y / 62, 1) * 0.55 + noise(x / 16, y / 16, 2) * 0.3 + hash(x, y, 3) * 0.15;
    return GRASS[Math.max(0, Math.min(4, Math.floor(((v - 0.22) / 0.56) * 5)))];
  };

  const surface = (k: Ground, x: number, y: number): RGB => {
    if (k === 'path') {
      const v = noise(x / 20, y / 20, 11) * 0.6 + hash(x, y, 12) * 0.4;
      return DIRT[Math.min(3, Math.floor(v * 4))];
    }
    if (k === 'cobble') {
      const row = Math.floor(y / 6), sy = y % 6;
      const shifted = x + (row & 1) * 4;
      const col = Math.floor(shifted / 8), sx = shifted % 8;
      const corner = (sx === 1 || sx === 7) && (sy === 1 || sy === 5);
      if (sx === 0 || sy === 0 || corner) return MORTAR;
      const base = COBBLE[Math.floor(hash(col, row, 21) * 4)];
      if (sx === 1 || sy === 1) return scale(base, 1.08);
      if (sx === 7 || sy === 5) return scale(base, 0.88);
      return hash(x, y, 22) < 0.06 ? scale(base, 0.93) : base;
    }
    if (k === 'soil') {
      const sy = y % 5;
      if (sy === 0) return SOIL.dark;
      if (sy === 1) return SOIL.light;
      return hash(x, y, 31) < 0.1 ? SOIL.dark : SOIL.base;
    }
    // the mine yard: gravel
    const v = noise(x / 9, y / 9, 41) * 0.5 + hash(x, y, 42) * 0.5;
    return GRAVEL[Math.min(2, Math.floor(v * 3))];
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = kind(x >> 4, y >> 4);
      if (k === 'grass') {
        put(x, y, grass(x, y));
      } else if (wet(k)) {
        const d = edge(x, y, wet) - (1.2 + noise(x / 6, y / 6, 5) * 2.4);
        if (d < 0) put(x, y, scale(grass(x, y), 0.86));
        else if (d < 1) put(x, y, WATER.wet);
        else if (d < 3) put(x, y, WATER.sand);
        else if (d < 4) put(x, y, hash(x >> 1, y, 6) < 0.6 ? WATER.foam : WATER.shallow);
        else if (d < 9) put(x, y, WATER.shallow);
        else put(x, y, noise(x / 26, y / 12, 7) > 0.55 ? WATER.deep2 : WATER.deep);
      } else {
        const d = edge(x, y, bare) - (1 + noise(x / 5, y / 5, 9) * 2.6);
        if (d < 0) put(x, y, grass(x, y));
        else if (d < 1.4) put(x, y, scale(surface(k, x, y), 0.8));
        else put(x, y, surface(k, x, y));
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  // ── Details drawn over the base ──
  let seed = 9001;
  const rand = () => hash(seed++, 17, 77);
  const px = (color: string, x: number, y: number, w = 1, h = 1) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  };
  const at = (x: number, y: number) => kind(Math.floor(x) >> 4, Math.floor(y) >> 4);

  for (let i = 0; i < (W * H) / 46; i++) {
    const x = rand() * W, y = rand() * H;
    const k = at(x, y);
    if (k === 'grass') {
      // blades of grass, lighter or darker than what is under them
      const light = rand() < 0.5;
      px(light ? 'rgba(170,230,120,0.55)' : 'rgba(40,100,50,0.45)', x, y, 1, 2);
      if (rand() < 0.3) px(light ? 'rgba(170,230,120,0.55)' : 'rgba(40,100,50,0.45)', x + 1, y + 1, 1, 2);
    } else if (k === 'path' && rand() < 0.35) {
      px('rgba(246,228,186,0.9)', x, y, 2, 1);
      px('rgba(150,115,70,0.7)', x, y + 1, 2, 1);
    } else if (k === 'stone' && rand() < 0.5) {
      px('rgba(190,190,182,0.9)', x, y, 2, 1);
      px('rgba(95,95,90,0.8)', x, y + 1, 2, 1);
    } else if (k === 'water' && rand() < 0.16) {
      px('rgba(160,216,246,0.8)', x, y, 3 + Math.floor(rand() * 4), 1);
    }
  }

  // the dock: boards laid across, with a shadow on the water below
  for (let ty = 0; ty < TH; ty++) {
    for (let tx = 0; tx < TW; tx++) {
      if (grid[ty][tx] !== 'planks') continue;
      const x0 = tx * TILE, y0 = ty * TILE;
      for (let b = 0; b < 4; b++) {
        const tone = ['#c08e5c', '#b58250', '#c99a66', '#b98856'][(tx * 4 + b) % 4];
        px(tone, x0 + b * 4, y0, 4, TILE);
        px('#8a5f38', x0 + b * 4 + 3, y0, 1, TILE);
        px('rgba(255,236,200,0.35)', x0 + b * 4, y0, 1, TILE);
      }
      if (kind(tx, ty - 1) !== 'planks') { px('#d6aa74', x0, y0, TILE, 1); px('#6f4a2a', x0, y0 + 1, TILE, 1); }
      if (kind(tx, ty + 1) !== 'planks') { px('#6f4a2a', x0, y0 + TILE - 2, TILE, 2); px('rgba(20,50,90,0.45)', x0, y0 + TILE, TILE, 3); }
      for (const ny of [3, 12]) px('#5a3c22', x0 + 1 + ((tx + ny) % 3) * 4, y0 + ny, 1, 1);
    }
  }
  return canvas;
}
