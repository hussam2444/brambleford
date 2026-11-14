import Phaser from 'phaser';
import { GOODS, type GoodId } from '../economy/goods';
import { quoteBuy, quoteSell } from '../economy/pricing';
import { LocalWorld, TOWN, canInvest, isTradingHour, shareOf, type GameWorld, type MerchantId } from '../economy/world';
import { Hud, type LapsePoint } from '../ui/hud';
import * as Art from './art';
import { TILE as T, type Dir } from './art';
import { paintGround, type Ground } from './ground';
import {
  BENCHES, BOAT, BUSHES, FENCE, LAMPS, MAP_H, MAP_W, MINE, PROPS, SHOPS, TREES, WELL,
  buildGround, buildNodes, doorTile, planterTile, riverStart, stallTile, yardTile,
} from './map';
import { sfx } from './sfx';

const WALK_SPEED = 104;
const VILLAGER_SPEED = 38;
/** How far to the side, in pixels, the player will slip to get round an obstacle. */
const SLIP_REACH = 7;
const GATHER_COOLDOWN = 420;
const RESPAWN_MS = 45000;

const VERB: Record<string, string> = { ore: 'Mine ore', wood: 'Chop wood', wheat: 'Cut wheat', fish: 'Fish here' };
const CHARGES: Record<string, number> = { ore: 4, wood: 4, wheat: 2, fish: 5 };
const REACH: Record<string, number> = { ore: 22, wood: 22, wheat: 13, fish: 25 };
/** How close, in pixels, the player must stand to read the notice board. */
const BOARD_REACH = 22;
const CHIPS: Record<string, [number, number]> = {
  ore: [0xc8c8d4, 0xf0a23a], wood: [0x8a5a30, 0x58b85a], wheat: [0xe9c84e, 0xfbe58a], fish: [0xbfe6f7, 0xffffff],
};
const SMALL_TALK = ['Lovely day for it.', 'The well water is sweet this year.', 'Mind the mine. It is dark in there.', 'Have you tried the bread?', 'Good fishing off the dock, I hear.'];

/** The time-lapse: a week of game hours, shown in about a minute. */
const LAPSE = { hours: 7 * 24, msPerHour: 340, crowdSpeed: 7 };

const DEPTH = { critters: 199000, clouds: 199500, sky: 200000, glow: 200001, fx: 200002, pointer: 200003 };

interface GatherNode {
  good: GoodId;
  /** Texture to go back to when it regrows. */
  fresh: string;
  x: number;
  y: number;
  sprite: Phaser.GameObjects.Image;
  charges: number;
  respawnAt: number;
}

interface Walker {
  sprite: Phaser.GameObjects.Sprite;
  key: string;
  path: { x: number; y: number }[];
  wait: number;
  /** out: about town. leaving: walking home for the night. home: indoors, not drawn. */
  state: 'out' | 'leaving' | 'home';
  say?: Phaser.GameObjects.Text;
}

interface Keeper {
  id: MerchantId;
  sprite: Phaser.GameObjects.Sprite;
  bubble: Phaser.GameObjects.Image;
  trend: Phaser.GameObjects.Image;
  x: number;
  y: number;
}

interface ShopArt {
  building: Phaser.GameObjects.Image;
  board: Phaser.GameObjects.Image;
  stall: Phaser.GameObjects.Image;
  /** Lit windows, and the light they throw on the ground, shown after dark. */
  glows: Phaser.GameObjects.Image[];
  chimney: { x: number; y: number };
}

interface Goal {
  text: string;
  done: (w: GameWorld) => boolean;
  /** Where to bounce the "go here" arrow, if anywhere. */
  at?: () => { x: number; y: number } | null;
}

function canvasOf(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  draw(el.getContext('2d')!);
  return el;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Colour laid over the town at each hour: [hour, r, g, b, strength, how-night-it-is]. */
const SKY: [number, number, number, number, number, number][] = [
  [0, 52, 66, 150, 0.8, 1],
  [5, 52, 66, 150, 0.8, 1],
  [6.5, 255, 176, 140, 0.4, 0.35],
  [8.5, 255, 255, 255, 0, 0],
  [16.5, 255, 255, 255, 0, 0],
  [18.5, 255, 150, 96, 0.45, 0.45],
  [20.5, 52, 66, 150, 0.8, 1],
  [24, 52, 66, 150, 0.8, 1],
];

export class TownScene extends Phaser.Scene {
  world!: GameWorld;
  hud!: Hud;

  private started = false;
  /** While the time-lapse runs: the real town it will hand back to, and what has happened so far. */
  private lapse: { live: GameWorld; history: LapsePoint[]; done: boolean } | null = null;
  private ground: Ground[][] = [];
  private blocked: boolean[][] = [];
  private treeTops: { x: number; y: number }[] = [];
  private motes: { img: Phaser.GameObjects.Image; phase: number }[] = [];
  private player!: Phaser.GameObjects.Sprite;
  private facing: Dir = 'down';
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  /** Key taps are latched by event, so a tap shorter than one frame still counts. */
  private tapped = { act: false, esc: false };
  private nodes: GatherNode[] = [];
  private keepers: Keeper[] = [];
  private shopArt = new Map<MerchantId, ShopArt>();
  private walkers: Walker[] = [];
  private sky!: Phaser.GameObjects.Rectangle;
  private night = 0;
  private lampGlows: Phaser.GameObjects.Image[] = [];
  private clouds: Phaser.GameObjects.Image[] = [];
  private critters: { img: Phaser.GameObjects.Image; x: number; y: number; phase: number; firefly: boolean }[] = [];
  private chips!: Phaser.GameObjects.Particles.ParticleEmitter;
  private pointer!: Phaser.GameObjects.Image;
  private pointerAt: Goal['at'];
  private goals: Goal[] = [];
  private goalIndex = 0;
  private goalPause = 0;
  /** True once the first-minute goals and their send-off are done. From then on the strip shows wanted orders. */
  private goalsOver = false;
  /** Which order, at what progress, the strip last showed, so it is only redrawn when that changes. */
  private wantedShown: string | null = null;
  /** The middle of the notice board's tile, if the map has a notice board. */
  private board: { x: number; y: number } | null = null;
  private lastGather = 0;
  private zoom = 3;

  constructor() {
    super('town');
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  create() {
    this.world = this.registry.get('world') as GameWorld;
    this.registry.set('town-ready', true);
    this.hud = new Hud(this.world);
    this.hud.onChange = () => this.syncShops();
    this.world.onUpdate = () => {
      if (this.lapse) return; // the real town carries on behind the time-lapse
      this.hud.refresh();
      this.syncShops();
    };
    this.hud.onLapse = (start) => (start ? this.startLapse() : this.stopLapse());
    this.makeTextures();

    this.add.image(0, 0, 'ground').setOrigin(0).setDepth(-10);
    this.blocked = this.ground.map((row) => row.map((g) => g === 'water'));

    this.placeScenery();
    this.placeDecor();
    this.placeShops();
    this.placeNodes();
    this.placePlayer();
    this.placeWalkers();
    this.scatter();
    this.placeAmbience();
    this.placeLighting();
    this.makeGoals();
    this.syncShops();

    const cam = this.cameras.main;
    cam.setBounds(0, 0, MAP_W * T, MAP_H * T);
    cam.startFollow(this.player, true, 0.14, 0.14);
    cam.setRoundPixels(true);
    this.fitCamera();
    this.scale.on('resize', () => this.fitCamera());

    const kb = this.input.keyboard!;
    this.keys = kb.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,E,SPACE') as Record<string, Phaser.Input.Keyboard.Key>;
    // A press counts once. Holding the key down is handled in update(), and only for gathering.
    const act = (ev: KeyboardEvent) => {
      if (!ev.repeat) this.tapped.act = true;
    };
    kb.on('keydown-E', act);
    kb.on('keydown-SPACE', act);
    kb.on('keydown-ESC', () => (this.tapped.esc = true));
    kb.on('keydown-M', () => this.hud.setMuted(sfx.toggleMute()));
    kb.on('keydown-T', () => (this.lapse ? this.stopLapse() : this.startLapse()));

    const begin = () => {
      if (this.started) return;
      this.started = true;
      sfx.unlock();
      this.hud.hideTitle();
      this.showGoal();
      this.time.delayedCall(50, () => (this.tapped = { act: false, esc: false }));
      this.time.delayedCall(1500, () => this.hud.toast('Move with WASD or the arrow keys. Press E to gather and to talk.'));
      // The town is shared, so a newcomer can arrive at any hour.
      if (!isTradingHour(this.world)) {
        this.time.delayedCall(5000, () => {
          if (!isTradingHour(this.world)) this.hud.toast('It is night in Brambleford. The shops open at 6. You can still gather.');
        });
      }
    };
    window.addEventListener('keydown', begin, { once: true });
    window.addEventListener('pointerdown', begin, { once: true });

    this.time.addEvent({ delay: 700, loop: true, callback: () => this.twinkle() });
    this.time.addEvent({ delay: 1000, loop: true, callback: () => this.smoke() });
    this.time.addEvent({ delay: 5200, loop: true, callback: () => this.chatter() });
    this.time.addEvent({ delay: 1300, loop: true, callback: () => this.dropLeaf() });

    if (import.meta.env.DEV) (window as unknown as { town: TownScene }).town = this;
  }

  private fitCamera() {
    this.zoom = Phaser.Math.Clamp(Math.round(this.scale.height / 250), 2, 6);
    while (this.zoom < 6 && (MAP_W * T * this.zoom < this.scale.width || MAP_H * T * this.zoom < this.scale.height)) this.zoom += 1;
    this.cameras.main.setZoom(this.zoom);
  }

  private makeTextures() {
    this.ground = buildGround();
    if (!this.textures.exists('ground')) this.textures.addCanvas('ground', paintGround(this.ground));
    for (const [key, canvas] of Object.entries(Art.buildTextures())) {
      if (!this.textures.exists(key)) this.textures.addCanvas(key, canvas);
    }
    for (const [key, look] of Object.entries(Art.LOOKS)) {
      const name = `char-${key}`;
      if (this.textures.exists(name)) continue;
      this.textures.addSpriteSheet(name, Art.charSheet(look) as unknown as HTMLImageElement, { frameWidth: Art.CHAR_W, frameHeight: Art.CHAR_H });
      Art.DIRS.forEach((dir, d) => {
        this.anims.create({
          key: `${key}-${dir}`,
          frames: [1, 0, 2, 0].map((f) => ({ key: name, frame: d * 3 + f })),
          frameRate: key === 'player' ? 11 : 8,
          repeat: -1,
        });
      });
    }
  }

  private block(tx: number, ty: number) {
    if (this.blocked[ty]?.[tx] !== undefined) this.blocked[ty][tx] = true;
  }

  /** Stand something on a tile, drawn from its feet, and make the tile solid. */
  private stand(key: string, tx: number, ty: number, dx = 0, dy = 0, solid = true) {
    const y = (ty + 1) * T + dy;
    if (solid) this.block(tx, ty);
    return this.add.image((tx + 0.5) * T + dx, y, key).setOrigin(0.5, 1).setDepth(y);
  }

  private placeScenery() {
    for (const [x, y, kind] of TREES) {
      const tree = this.stand(`tree-${kind}`, x, y, 0, 1);
      this.treeTops.push({ x: tree.x, y: tree.y - 30 });
    }
    this.add.image(WELL.x * T, (WELL.y + 1) * T, 'well').setOrigin(0.5, 1).setDepth((WELL.y + 1) * T);
    this.block(WELL.x - 1, WELL.y);
    this.block(WELL.x, WELL.y);
    for (const l of LAMPS) {
      const lamp = this.stand('lamp', l.x, l.y);
      this.lampGlows.push(this.add.image(lamp.x, lamp.y - 24, 'glow').setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.glow).setAlpha(0));
    }
  }

  private placeDecor() {
    this.stand('mine', MINE.x + 1, MINE.y, 0, 0, false);
    for (let ty = MINE.y - 1; ty <= MINE.y; ty++) for (let tx = MINE.x; tx < MINE.x + 3; tx++) this.block(tx, ty);
    for (const f of FENCE) this.stand('fence', f.x, f.y, 0, -1);
    for (const b of BENCHES) this.stand('bench', b.x, b.y, 0, -2);
    BUSHES.forEach((b, i) => this.stand(`bush-${i % 4}`, b.x, b.y, 0, -2));
    for (const [key, x, y] of PROPS) this.stand(key, x, y, 0, -1);
    const notices = PROPS.find(([key]) => key === 'noticeboard');
    if (notices) this.board = { x: (notices[1] + 0.5) * T, y: (notices[2] + 0.5) * T };
    SHOPS.forEach((s, i) => {
      const yard = yardTile(s);
      const flip = yard.x === s.left ? -1 : 1;
      this.stand(`prop-${s.id}`, yard.x, yard.y, 2 * flip, -3);
      this.stand('barrel', yard.x + flip, yard.y, -2 * flip, -1);
      const planter = planterTile(s);
      this.stand(`planter-${i % 4}`, planter.x, planter.y, 0, -3);
    });
    // mooring posts along the dock
    for (const x of [39, 41, 43]) for (const y of [19, 21]) {
      const py = y * T + (y === 19 ? 1 : 3);
      this.add.image(x * T, py, 'dockpost').setOrigin(0.5, 1).setDepth(y === 19 ? -3 : py);
    }
    const boat = this.add.image((BOAT.x + 0.5) * T, (BOAT.y + 0.5) * T, 'boat').setDepth(-4);
    this.tweens.add({ targets: boat, y: boat.y + 1.5, duration: 1600, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
  }

  private placeShops() {
    for (const s of SHOPS) {
      const x0 = s.left * T;
      const yBottom = (s.bottom + 1) * T;
      const building = this.add.image(x0 + 40, yBottom, `shop-${s.id}`).setOrigin(0.5, 1).setDepth(yBottom - 1);
      for (let ty = s.bottom - 3; ty <= s.bottom; ty++) for (let tx = s.left; tx < s.left + 5; tx++) this.block(tx, ty);

      const top = yBottom - Art.SHOP.h - 1;
      const board = this.add.image(x0 + 40, yBottom - 14, 'closed').setDepth(yBottom).setVisible(false);
      const glows: Phaser.GameObjects.Image[] = [];
      for (const [wx, wy] of Art.SHOP.windows) {
        glows.push(this.add.image(x0 + wx, top + wy, 'window-glow').setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.glow).setAlpha(0));
        glows.push(this.add.image(x0 + wx, yBottom + 7, 'light-pool').setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.glow).setAlpha(0));
      }
      const st = stallTile(s);
      const stall = this.stand(`stall-${s.id}-3`, st.x, st.y, 1, -1);
      this.shopArt.set(s.id, { building, board, stall, glows, chimney: { x: x0 + Art.SHOP.chimney[0], y: top + Art.SHOP.chimney[1] } });

      const door = doorTile(s);
      const mx = (door.x + 0.5) * T;
      const my = (door.y + 1) * T - 3;
      const sprite = this.add.sprite(mx, my, `char-${s.id}`, 0).setOrigin(0.5, 1).setDepth(my);
      const bubble = this.add.image(mx, my - 31, 'bubble').setOrigin(0.5, 1).setDepth(DEPTH.critters);
      const trend = this.add.image(mx + 9, my - 41, 'trend-up').setDepth(DEPTH.critters).setVisible(false);
      this.tweens.add({ targets: bubble, y: my - 33, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
      this.tweens.add({ targets: trend, y: my - 43, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
      this.block(door.x, door.y);
      this.keepers.push({ id: s.id, sprite, bubble, trend, x: mx, y: my });
    }
  }

  private placeNodes() {
    for (const n of buildNodes()) {
      const cx = (n.x + 0.5) * T;
      let sprite: Phaser.GameObjects.Image;
      let y = (n.y + 0.5) * T;
      let fresh = n.good === 'ore' ? 'rock' : n.good === 'wheat' ? 'wheat' : 'ripple';
      if (n.good === 'wood') {
        fresh = `tree-${n.kind ?? 0}`;
        sprite = this.stand(fresh, n.x, n.y, 0, 1);
        this.treeTops.push({ x: sprite.x, y: sprite.y - 30 });
        y = sprite.y - 4;
      } else if (n.good === 'ore') {
        sprite = this.stand('rock', n.x, n.y);
      } else if (n.good === 'wheat') {
        sprite = this.stand('wheat', n.x, n.y, 0, 0, false);
      } else {
        sprite = this.add.image(cx, y, 'ripple').setDepth(-5);
        this.tweens.add({ targets: sprite, scale: 1.35, alpha: 0.35, duration: 1100, yoyo: true, repeat: -1, delay: Math.random() * 900 });
      }
      this.nodes.push({ good: n.good, fresh, x: cx, y, sprite, charges: CHARGES[n.good], respawnAt: 0 });
    }
  }

  private placePlayer() {
    this.player = this.add.sprite(21.5 * T, 13.5 * T, 'char-player', 0).setOrigin(0.5, 1);
    this.player.setDepth(this.player.y);
    this.chips = this.add
      .particles(0, 0, 'px', { lifespan: 420, speed: { min: 25, max: 75 }, angle: { min: 205, max: 335 }, gravityY: 240, scale: { start: 1, end: 0.4 }, emitting: false })
      .setDepth(DEPTH.fx);
    this.pointer = this.add.image(0, 0, 'pointer').setOrigin(0.5, 1).setDepth(DEPTH.pointer).setVisible(false);
  }

  private placeWalkers() {
    ['villager1', 'villager2', 'villager3', 'villager4', 'villager5'].forEach((key, i) => {
      // start in columns clear of the well, so the first walk to the street does not cross it
      const sprite = this.add.sprite([18.5, 19.5, 20.5, 23.5, 24.5][i] * T, (16.5 + (i % 2)) * T, `char-${key}`, 0).setOrigin(0.5, 1);
      this.walkers.push({ sprite, key, path: [], wait: 500 + i * 900, state: 'out' });
    });
  }

  /** Things that only exist to make the place feel alive. */
  private placeAmbience() {
    // glints on the river
    for (let i = 0; i < 36; i++) {
      const g = this.add.image(0, 0, 'glint').setDepth(-6).setAlpha(0);
      const move = () => {
        const ty = Phaser.Math.Between(0, MAP_H - 1);
        g.setPosition(Phaser.Math.Between((riverStart(ty) + 1) * T, MAP_W * T - 6), ty * T + Phaser.Math.Between(2, 13));
      };
      move();
      this.tweens.add({ targets: g, alpha: 0.75, duration: Phaser.Math.Between(700, 1500), yoyo: true, repeat: -1, delay: Math.random() * 2500, repeatDelay: Math.random() * 1500, onRepeat: move });
    }
    // cloud shadows drifting east
    for (let i = 0; i < 3; i++) {
      this.clouds.push(this.add.image(i * 300 - 100, 90 + i * 140, 'cloud').setDepth(DEPTH.clouds).setAlpha(0.16).setScale(1 + i * 0.25));
    }
    // butterflies by day
    for (let i = 0; i < 5; i++) {
      const b = BUSHES[(i * 5 + 1) % BUSHES.length];
      const img = this.add.image(0, 0, `bfly-${i % 4}`).setDepth(DEPTH.critters);
      this.critters.push({ img, x: (b.x + 0.5) * T, y: b.y * T, phase: i * 1.7, firefly: false });
    }
    // fireflies by night
    for (let i = 0; i < 16; i++) {
      const img = this.add.image(0, 0, 'firefly').setDepth(DEPTH.glow).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0);
      this.critters.push({ img, x: Phaser.Math.Between(4, 38) * T, y: Phaser.Math.Between(13, 28) * T, phase: i * 2.3, firefly: true });
    }
  }

  /** Sprinkle small scenery over the open grass and along the river, the same way every time. */
  private scatter() {
    let seed = 4242;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return (seed >>> 0) / 4294967296;
    };
    const open = (tx: number, ty: number) => this.ground[ty]?.[tx] === 'grass' && !this.blocked[ty][tx];
    for (let i = 0; i < 420; i++) {
      const tx = Math.floor(rand() * MAP_W), ty = Math.floor(rand() * MAP_H);
      const x = tx * T + 2 + rand() * 12, y = ty * T + 5 + rand() * 11, r = rand();
      if (!open(tx, ty)) continue;
      const key = r < 0.52 ? 'tallgrass' : r < 0.84 ? `flowers-${Math.floor(rand() * 4)}` : r < 0.93 ? 'pebbles' : 'mushroom';
      this.add.image(x, y, key).setOrigin(0.5, 1).setDepth(y);
    }
    for (let i = 0, placed = 0; i < 60 && placed < 7; i++) {
      const tx = Math.floor(rand() * MAP_W), ty = Math.floor(rand() * MAP_H);
      if (!open(tx, ty) || ty < 5) continue;
      this.stand('boulder', tx, ty, 0, -1);
      placed += 1;
    }
    const fishTiles = new Set(this.nodes.filter((n) => n.good === 'fish').map((n) => `${Math.floor(n.x / T)},${Math.floor(n.y / T)}`));
    for (let ty = 0; ty < MAP_H; ty++) {
      const tx = riverStart(ty);
      if (this.ground[ty][tx] !== 'water' || fishTiles.has(`${tx},${ty}`) || rand() < 0.4) continue;
      const y = ty * T + 8 + rand() * 8;
      this.add.image(tx * T + 7 + rand() * 4, y, 'reeds').setOrigin(0.5, 1).setDepth(y);
    }
    for (let i = 0; i < 16; i++) {
      const ty = Math.floor(rand() * MAP_H), tx = riverStart(ty) + 1 + Math.floor(rand() * 4);
      if (this.ground[ty]?.[tx] !== 'water' || fishTiles.has(`${tx},${ty}`)) continue;
      const pad = this.add.image(tx * T + 8, ty * T + 8, rand() < 0.35 ? 'lily-bloom' : 'lily').setDepth(-5);
      this.tweens.add({ targets: pad, y: pad.y + 1, duration: 1800 + rand() * 900, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
    }
    // motes drifting in the daylight
    for (let i = 0; i < 70; i++) {
      const img = this.add.image(rand() * MAP_W * T, rand() * MAP_H * T, 'mote').setDepth(DEPTH.critters).setBlendMode(Phaser.BlendModes.ADD);
      this.motes.push({ img, phase: rand() * 10 });
    }
  }

  private dropLeaf() {
    if (this.night > 0.5 || !this.treeTops.length) return;
    const t = Phaser.Utils.Array.GetRandom(this.treeTops);
    const leaf = this.add.image(t.x + Phaser.Math.Between(-10, 10), t.y + Phaser.Math.Between(-6, 8), 'leaf').setDepth(DEPTH.critters);
    this.tweens.add({ targets: leaf, y: leaf.y + 34, alpha: 0, duration: 2600, ease: 'Sine.in', onComplete: () => leaf.destroy() });
    this.tweens.add({ targets: leaf, x: leaf.x + Phaser.Math.Between(6, 12), duration: 650, yoyo: true, repeat: 1, ease: 'Sine.inOut' });
  }

  private placeLighting() {
    this.sky = this.add
      .rectangle(0, 0, MAP_W * T, MAP_H * T, 0xffffff, 0)
      .setOrigin(0)
      .setDepth(DEPTH.sky)
      .setBlendMode(Phaser.BlendModes.MULTIPLY);
  }

  // ── First-minute goals ────────────────────────────────────────────────────

  private makeGoals() {
    const keeper = (id: MerchantId) => () => {
      const k = this.keepers.find((m) => m.id === id)!;
      return { x: k.x, y: k.y - 50 };
    };
    this.goals = [
      {
        text: 'Mine some ore. The grey yard is west along the street.',
        done: (w) => w.player.stats.gathered > 0,
        at: () => {
          const rock = this.nodes.find((n) => n.good === 'ore' && n.charges > 0);
          return rock ? { x: rock.x, y: rock.sprite.y - 18 } : null;
        },
      },
      { text: 'Sell it to Bruna, the red-haired blacksmith.', done: (w) => w.player.stats.sold > 0, at: keeper('blacksmith') },
      {
        text: 'Hungry work. Buy bread from Odo the baker or smoked fish from Maren, then click it in your bag to eat.',
        done: (w) => w.player.stats.eaten > 0,
        at: () => (this.world.town.merchants.baker.open ? keeper('baker')() : keeper('fishmonger')()),
      },
      { text: 'Save 100 coins and buy into a shop. Its profits pay you every evening.', done: (w) => Object.values(w.town.merchants).some((m) => shareOf(w, m) > 0) },
    ];
  }

  private showGoal() {
    const g = this.goals[this.goalIndex];
    if (!g) {
      this.pointerAt = undefined;
      this.hud.setGoal('That is the basics. Watch the town news: shortages are when prices jump. The notice board in the square says what the shopkeepers want each day.');
      this.time.delayedCall(12000, () => (this.goalsOver = true));
      return;
    }
    this.hud.setGoal(g.text);
    this.pointerAt = g.at;
  }

  /** After the first-minute goals: keep today's first open order on the strip, or put the strip away. */
  private showWanted() {
    const open = isTradingHour(this.world) ? this.world.orders().find((o) => o.wonBy === undefined) : undefined;
    const showing = open ? `${open.id}:${open.progress[this.world.me] ?? 0}` : '';
    if (showing === this.wantedShown) return;
    this.wantedShown = showing;
    this.hud.setWanted(open ?? null);
  }

  private updateGoal(time: number, delta: number) {
    const at = this.goalPause > 0 ? null : this.pointerAt?.();
    this.pointer.setVisible(!!at && !this.hud.shopOpen && !this.hud.boardOpen);
    if (at) this.pointer.setPosition(at.x, at.y + Math.sin(time / 170) * 2.5);

    if (this.goalIndex >= this.goals.length) {
      if (this.goalsOver) this.showWanted();
      return;
    }
    if (this.goalPause > 0) {
      this.goalPause -= delta;
      if (this.goalPause <= 0) {
        this.goalIndex += 1;
        this.showGoal();
      }
      return;
    }
    const g = this.goals[this.goalIndex];
    if (g.done(this.world)) {
      sfx.goal();
      this.hud.setGoal(g.text, true);
      this.goalPause = 2000;
    }
  }

  // ── The time-lapse ────────────────────────────────────────────────────────

  /** Swap in a copy of the town and run a week of it in a minute, with nobody playing. */
  private startLapse() {
    if (this.lapse || !this.started) return;
    this.hud.closeShop();
    this.hud.closeMenu();
    this.hud.closeBoard();
    this.lapse = { live: this.world, history: [], done: false };
    this.world = LocalWorld.forecast(this.world, LAPSE.msPerHour);
    this.hud.setWorld(this.world);
    this.hud.showLapse(true);
    this.hud.setPrompt(null);
    this.pointer.setVisible(false);
    this.player.anims.stop();
    this.cameras.main.zoomTo(Math.max(2, this.zoom - 1), 600);
    this.recordLapse();
    this.syncShops();
  }

  private stopLapse() {
    if (!this.lapse) return;
    this.world = this.lapse.live;
    this.lapse = null;
    this.hud.setWorld(this.world);
    this.hud.showLapse(false);
    this.cameras.main.zoomTo(this.zoom, 400);
    this.syncShops();
  }

  private recordLapse() {
    const lapse = this.lapse!;
    const price = {} as LapsePoint['price'];
    for (const m of Object.values(this.world.town.merchants)) {
      price[m.id] = m.open ? quoteSell(m, m.recipe.output).price / GOODS[m.recipe.output].base : null;
    }
    lapse.history.push({ price });
    lapse.done = lapse.history.length >= LAPSE.hours;
    this.hud.drawLapse(lapse.history, LAPSE.hours, lapse.done);
  }

  private updateLapse(delta: number) {
    const lapse = this.lapse!;
    if (lapse.done) return;
    const newHour = this.world.advance(delta);
    for (const text of this.world.drainNews()) this.hud.lapseNews(text);
    if (!newHour) return;
    this.hud.refresh();
    this.syncShops();
    this.recordLapse();
  }

  // ── Every frame ───────────────────────────────────────────────────────────

  update(time: number, delta: number) {
    this.updateLighting();
    this.updateAmbience(time, delta);
    this.updateWalkers(delta * (this.lapse && !this.lapse.done ? LAPSE.crowdSpeed : 1));
    if (!this.started) return;
    if (this.lapse) {
      this.updateLapse(delta);
      this.tapped = { act: false, esc: false };
      return;
    }

    this.runClock(delta);
    this.respawnNodes(time);
    this.updateGoal(time, delta);

    const { act, esc } = this.tapped;
    this.tapped = { act: false, esc: false };
    const k = this.keys;
    // true on the frame a movement key goes down (asked every frame, so an old press is never left waiting)
    const stepped = [k.W, k.A, k.S, k.D, k.UP, k.DOWN, k.LEFT, k.RIGHT].map((key) => Phaser.Input.Keyboard.JustDown(key)).some(Boolean);

    if (this.hud.menuOpen) {
      this.player.anims.stop();
      if (esc) this.hud.closeMenu();
      return;
    }
    if (this.hud.shopOpen) {
      this.player.anims.stop();
      // Leave a shop the natural way too: just start walking.
      if (esc || act || stepped) this.hud.closeShop();
      return;
    }
    if (this.hud.boardOpen) {
      this.player.anims.stop();
      if (esc || act) {
        this.hud.closeBoard();
        this.lastGather = time; // the same press of E must not also swing at whatever is beside the player
      }
      return;
    }
    if (esc) {
      this.hud.openMenu();
      return;
    }

    this.movePlayer(delta);
    const target = this.nearest();
    if (!target) this.hud.setPrompt(null);
    else if (target.kind === 'keeper') this.hud.setPrompt(`<kbd>E</kbd> Talk to ${this.world.town.merchants[target.id].name}`);
    else if (target.kind === 'board') this.hud.setPrompt('<kbd>E</kbd> Read the notice board');
    else this.hud.setPrompt(`<kbd>E</kbd> ${VERB[target.node.good]}`);
    if (!target) return;

    if (target.kind === 'keeper') {
      if (act) this.hud.openShop(target.id);
      return;
    }
    if (target.kind === 'board') {
      if (act) this.hud.openBoard();
      return;
    }
    // Hold the key to keep gathering, for as long as there is energy to do it.
    const holding = (k.E.isDown || k.SPACE.isDown) && this.world.player.energy >= TOWN.gatherEnergy;
    if (act || holding) this.gather(target.node, time);
  }

  private runClock(delta: number) {
    const newHour = this.world.advance(delta);
    this.hud.setWhere(this.world.status());
    for (const text of this.world.drainNews()) {
      this.hud.news(text);
      sfx.news();
    }
    if (!newHour) return;
    sfx.night = !isTradingHour(this.world);
    this.hud.refresh();
    this.syncShops();

    // show the town's own shopping: coins popping up at each shop that sold something
    let nearSale = false;
    for (const k of this.keepers) {
      const income = this.world.town.merchants[k.id].townIncome;
      if (income <= 0) continue;
      this.float(k.x - 12, k.y - 30, `+${income}`, '#ffd95a');
      if (Phaser.Math.Distance.Between(this.player.x, this.player.y, k.x, k.y) < 130) nearSale = true;
    }
    if (nearSale) sfx.till();
  }

  /** Make each shop look the way its books say: open, asleep, boarded up, well or badly stocked. */
  private syncShops() {
    const awake = isTradingHour(this.world);
    for (const k of this.keepers) {
      const m = this.world.town.merchants[k.id];
      const art = this.shopArt.get(k.id)!;
      const serving = m.open && awake;
      art.board.setVisible(!m.open);
      art.building.setTint(m.open ? 0xffffff : 0x9a9aa6);
      k.sprite.setVisible(serving);
      k.bubble.setVisible(serving);

      const out = m.recipe.output;
      const stock = m.stock[out] ?? 0;
      const want = m.target[out] ?? 1;
      const level = !m.open || stock === 0 ? 0 : stock < want * 0.5 ? 1 : stock < want ? 2 : 3;
      art.stall.setTexture(`stall-${k.id}-${level}`);

      // an arrow by the shopkeeper's head when they are paying well over, or well under, the usual
      let best = 0;
      for (const id of Object.keys(m.usualSupply) as GoodId[]) {
        const q = quoteBuy(m, id);
        if (q.available) best = Math.max(best, q.price / GOODS[id].base);
      }
      const mood = best >= 1.3 ? 'trend-up' : best > 0 && best <= 0.7 ? 'trend-down' : null;
      k.trend.setVisible(serving && !!mood);
      if (mood) k.trend.setTexture(mood);
    }
  }

  private updateLighting() {
    const hour = this.world.town.hour + this.world.hourProgress();
    let i = 0;
    while (i < SKY.length - 2 && SKY[i + 1][0] <= hour) i++;
    const a = SKY[i];
    const b = SKY[i + 1];
    const t = Phaser.Math.Clamp((hour - a[0]) / (b[0] - a[0]), 0, 1);
    const color = Phaser.Display.Color.GetColor(lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t));
    this.night = lerp(a[5], b[5], t);
    this.sky.setFillStyle(color, lerp(a[4], b[4], t));
    for (const g of this.lampGlows) g.setAlpha(this.night * 0.9);
    for (const [id, art] of this.shopArt) for (const g of art.glows) g.setAlpha(this.world.town.merchants[id].open ? this.night : 0);
  }

  private updateAmbience(time: number, delta: number) {
    for (const c of this.clouds) {
      c.x += (delta / 1000) * 5;
      if (c.x > MAP_W * T + 160) c.x = -160;
      c.setAlpha(0.16 * (1 - this.night));
    }
    for (const m of this.motes) {
      m.img.x += (delta / 1000) * 3;
      m.img.y -= (delta / 1000) * (1.2 + Math.sin(time * 0.001 + m.phase));
      if (m.img.x > MAP_W * T) m.img.x = 0;
      if (m.img.y < 0) m.img.y = MAP_H * T;
      m.img.setAlpha((1 - this.night) * 0.75 * Math.abs(Math.sin(time * 0.0013 + m.phase)));
    }
    for (const c of this.critters) {
      if (c.firefly) {
        c.img.setPosition(c.x + Math.sin(time * 0.0006 + c.phase) * 14, c.y + Math.cos(time * 0.0008 + c.phase * 2) * 9);
        c.img.setAlpha(Math.max(0, this.night - 0.4) * 1.6 * (0.3 + 0.7 * Math.abs(Math.sin(time * 0.002 + c.phase))));
      } else {
        c.img.setVisible(this.night < 0.3);
        c.img.setPosition(
          c.x + Math.sin(time * 0.0009 + c.phase) * 20 + Math.sin(time * 0.0031 + c.phase) * 5,
          c.y + Math.cos(time * 0.0012 + c.phase) * 10 + Math.sin(time * 0.004 + c.phase) * 2,
        );
        c.img.scaleX = 0.3 + 0.7 * Math.abs(Math.sin(time * 0.018 + c.phase));
      }
    }
  }

  private smoke() {
    if (!isTradingHour(this.world)) return;
    for (const [id, art] of this.shopArt) {
      if (!this.world.town.merchants[id].open) continue;
      const p = this.add.image(art.chimney.x + Phaser.Math.Between(-1, 1), art.chimney.y, 'puff').setDepth(art.building.depth + 1).setAlpha(0.7).setScale(0.6);
      this.tweens.add({ targets: p, y: p.y - 24, x: p.x + Phaser.Math.Between(5, 11), scale: 1.7, alpha: 0, duration: 2800, onComplete: () => p.destroy() });
    }
  }

  // ── The player ────────────────────────────────────────────────────────────

  private walkable(x: number, y: number): boolean {
    for (const [dx, dy] of [[-4, -5], [4, -5], [-4, -1], [4, -1]]) {
      const tx = Math.floor((x + dx) / T);
      const ty = Math.floor((y + dy) / T);
      if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H || this.blocked[ty][tx]) return false;
    }
    return true;
  }

  private movePlayer(delta: number) {
    const k = this.keys;
    let dx = (k.D.isDown || k.RIGHT.isDown ? 1 : 0) - (k.A.isDown || k.LEFT.isDown ? 1 : 0);
    let dy = (k.S.isDown || k.DOWN.isDown ? 1 : 0) - (k.W.isDown || k.UP.isDown ? 1 : 0);
    if (!dx && !dy) {
      this.player.anims.stop();
      this.player.setFrame(Art.DIRS.indexOf(this.facing) * 3);
      return;
    }
    this.facing = dy > 0 ? 'down' : dy < 0 ? 'up' : dx < 0 ? 'left' : 'right';
    if (dx && dy) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }
    const step = (WALK_SPEED * Math.min(delta, 50)) / 1000;
    const p = this.player;
    const movedX = dx !== 0 && this.walkable(p.x + dx * step, p.y);
    if (movedX) p.x += dx * step;
    const movedY = dy !== 0 && this.walkable(p.x, p.y + dy * step);
    if (movedY) p.y += dy * step;
    // Walking straight into the edge of a rock, a lamp or a corner: slip round it instead of stopping dead.
    if (!movedX && !movedY && (dx === 0 || dy === 0)) {
      const side = this.wayRound(p.x, p.y, dx * step, dy * step);
      if (dx === 0) p.x += side * step;
      else p.y += side * step;
    }
    p.setDepth(p.y);
    p.anims.play(`player-${this.facing}`, true);
  }

  /**
   * Blocked while walking along one axis: which way (-1, 0 or 1) along the other
   * axis is the nearer gap, if there is one within a few pixels? Head-on, the player still stops.
   */
  private wayRound(x: number, y: number, stepX: number, stepY: number): number {
    for (let off = 1; off <= SLIP_REACH; off++) {
      for (const side of [-1, 1]) {
        const sx = stepX === 0 ? side * off : 0;
        const sy = stepX === 0 ? 0 : side * off;
        // the gap must be open, and so must every step of the way to it
        if (this.walkable(x + sx + stepX, y + sy + stepY) && this.walkable(x + sx, y + sy) && this.walkable(x + Math.sign(sx), y + Math.sign(sy))) return side;
      }
    }
    return 0;
  }

  private nearest():
    | { kind: 'keeper'; id: MerchantId }
    | { kind: 'node'; node: GatherNode }
    | { kind: 'board' }
    | null {
    const px = this.player.x;
    const py = this.player.y - 3;
    let best: ReturnType<TownScene['nearest']> = null;
    let bestDist = Infinity;
    for (const k of this.keepers) {
      const d = Phaser.Math.Distance.Between(px, py, k.x, k.y);
      if (d < 26 && d < bestDist) { best = { kind: 'keeper', id: k.id }; bestDist = d; }
    }
    for (const node of this.nodes) {
      if (node.charges <= 0) continue;
      const d = Phaser.Math.Distance.Between(px, py, node.x, node.y);
      if (d < REACH[node.good] && d < bestDist) { best = { kind: 'node', node }; bestDist = d; }
    }
    if (this.board) {
      const d = Phaser.Math.Distance.Between(px, py, this.board.x, this.board.y);
      if (d < BOARD_REACH && d < bestDist) best = { kind: 'board' };
    }
    return best;
  }

  private gather(node: GatherNode, time: number) {
    if (time - this.lastGather < GATHER_COOLDOWN) return;
    this.lastGather = time;
    const r = this.world.gather(node.good);
    if (!r.ok) {
      this.hud.toast(r.message);
      sfx.nope();
      return;
    }
    if (node.good === 'ore') sfx.mine();
    else if (node.good === 'wood') sfx.chop();
    else if (node.good === 'wheat') sfx.cut();
    else sfx.splash();

    const top = node.sprite.y - (node.good === 'wood' ? 30 : node.good === 'fish' ? 2 : 10);
    this.float(node.x, top - 2, r.message, '#fff6c8');
    const [c1, c2] = CHIPS[node.good];
    this.chips.setParticleTint(c1);
    this.chips.explode(5, node.x, top + 6);
    this.chips.setParticleTint(c2);
    this.chips.explode(3, node.x, top + 6);

    this.tweens.add({ targets: this.player, scaleY: 0.86, duration: 70, yoyo: true });
    if (node.good !== 'fish') this.tweens.add({ targets: node.sprite, x: node.sprite.x + 1.5, duration: 50, yoyo: true, repeat: 2 });
    node.charges -= 1;
    if (node.charges <= 0) {
      node.respawnAt = time + RESPAWN_MS;
      if (node.good === 'wood') node.sprite.setTexture('stump');
      else if (node.good === 'ore') node.sprite.setTexture('rock-spent');
      else if (node.good === 'wheat') node.sprite.setTexture('wheat-spent');
      else node.sprite.setVisible(false);
    }
    this.hud.refresh();
    if (this.world.player.energy < TOWN.gatherEnergy) this.hud.toast("You're worn out. Eat something, or rest until morning.");
  }

  private respawnNodes(time: number) {
    for (const node of this.nodes) {
      if (node.charges > 0 || time < node.respawnAt) continue;
      node.charges = CHARGES[node.good];
      if (node.good === 'fish') node.sprite.setVisible(true);
      else node.sprite.setTexture(node.fresh);
    }
  }

  private label(x: number, y: number, text: string, color: string) {
    return this.add
      .text(x, y, text, { fontFamily: '"Jersey 15", "Pixelify Sans", monospace', fontSize: '8px', color, stroke: '#2b2233', strokeThickness: 2, resolution: this.zoom })
      .setOrigin(0.5, 1)
      .setDepth(DEPTH.fx);
  }

  private float(x: number, y: number, text: string, color: string) {
    const t = this.label(x, y, text, color);
    this.tweens.add({ targets: t, y: y - 16, alpha: 0, duration: 1100, ease: 'Sine.out', onComplete: () => t.destroy() });
  }

  private twinkle() {
    const ready = this.nodes.filter((n) => n.charges > 0 && n.good !== 'fish');
    if (!ready.length) return;
    const n = Phaser.Utils.Array.GetRandom(ready);
    const top = n.good === 'wood' ? 30 : 10;
    const s = this.add
      .image(n.x + Phaser.Math.Between(-5, 5), n.sprite.y - top + Phaser.Math.Between(-3, 3), 'sparkle')
      .setDepth(DEPTH.fx)
      .setScale(0.2)
      .setAlpha(0.9);
    this.tweens.add({ targets: s, scale: 1, alpha: 0, angle: 90, duration: 650, onComplete: () => s.destroy() });
  }

  // ── Townsfolk ─────────────────────────────────────────────────────────────

  /** Something a villager might say, drawn from what is actually happening in the shops. */
  private gossip(): string {
    const w = this.world.town;
    const lines: string[] = [];
    if (w.season) lines.push(w.season.headline.split('. ')[0].replace(/\.$/, '') + '.');
    for (const m of Object.values(w.merchants)) {
      const out = GOODS[m.recipe.output];
      if (!m.open) { lines.push(`Poor ${m.name}. The shop is shut.`); continue; }
      const ratio = quoteSell(m, m.recipe.output).price / out.base;
      if ((m.stock[m.recipe.output] ?? 0) === 0) lines.push(`${m.name} is sold out of ${out.plural}!`);
      else if (ratio >= 1.25) lines.push(`${out.name} is dear today.`);
      else if (ratio <= 0.85) lines.push(`${out.name} is cheap today!`);
      if (m.coins < 70) lines.push(`${m.name} looks worried about money.`);
    }
    return lines.length && Math.random() < 0.7 ? Phaser.Utils.Array.GetRandom(lines) : Phaser.Utils.Array.GetRandom(SMALL_TALK);
  }

  private chatter() {
    const free = this.walkers.filter((w) => w.state === 'out' && !w.say && w.sprite.visible);
    if (!free.length || !isTradingHour(this.world)) return;
    const w = Phaser.Utils.Array.GetRandom(free);
    const say = this.add
      .text(w.sprite.x, w.sprite.y - 29, this.gossip(), {
        fontFamily: '"Jersey 15", "Pixelify Sans", monospace', fontSize: '7px', color: '#3b2416', backgroundColor: '#fffaf0',
        padding: { x: 3, y: 2 }, resolution: this.zoom, align: 'center', wordWrap: { width: 96 },
      })
      .setOrigin(0.5, 1)
      .setDepth(DEPTH.fx);
    w.say = say;
    this.time.delayedCall(3200, () => {
      say.destroy();
      w.say = undefined;
    });
  }

  /** Villagers keep to the street: along it, then straight to where they are going. */
  private route(w: Walker, goal: { x: number; y: number }): { x: number; y: number }[] {
    const street = 12.6 * T;
    return [{ x: w.sprite.x, y: street }, { x: goal.x, y: street }, goal];
  }

  private pickPath(w: Walker): { x: number; y: number }[] {
    const openShops = SHOPS.filter((s) => this.world.town.merchants[s.id].open);
    if (openShops.length && Math.random() < 0.65) {
      const door = doorTile(Phaser.Utils.Array.GetRandom(openShops));
      return this.route(w, { x: (door.x + 0.5 + (Math.random() < 0.5 ? -0.9 : 0.9)) * T, y: 11.75 * T });
    }
    const col = Phaser.Utils.Array.GetRandom([18.5, 19.5, 20.5, 23.5, 24.5, 25.5]);
    return this.route(w, { x: col * T, y: Phaser.Math.Between(14, 17) * T + 8 });
  }

  private updateWalkers(delta: number) {
    const awake = isTradingHour(this.world);
    for (const w of this.walkers) {
      if (w.state === 'home') {
        if (!awake) continue;
        w.state = 'out'; // morning: step back out where they went in
        w.sprite.setVisible(true);
        w.wait = Math.random() * 3000;
      } else if (!awake && w.state === 'out') {
        // Night has fallen: drop everything and walk home, off the nearer end of the street.
        w.state = 'leaving';
        w.path = this.route(w, { x: (w.sprite.x < 21 * T ? 3.5 : 38.5) * T, y: 12.6 * T });
      } else if (awake && w.state === 'leaving') {
        w.state = 'out'; // dawn came before they got home
        w.path = [];
        w.wait = 0;
      }

      if (!w.path.length && w.state === 'out') {
        w.wait -= delta;
        if (w.wait <= 0) w.path = this.pickPath(w);
      }
      const next = w.path[0];
      if (next) {
        const dx = next.x - w.sprite.x;
        const dy = next.y - w.sprite.y;
        const dist = Math.hypot(dx, dy);
        const step = (VILLAGER_SPEED * Math.min(delta, 50 * LAPSE.crowdSpeed)) / 1000;
        if (dist <= step) {
          w.sprite.setPosition(next.x, next.y);
          w.path.shift();
          if (!w.path.length) {
            w.sprite.anims.stop();
            if (w.state === 'leaving') {
              w.state = 'home';
              w.sprite.setVisible(false);
              w.say?.setVisible(false); // do not leave their words hanging over an empty street
            } else {
              w.sprite.setFrame(next.y < 12 * T ? 3 : 0); // face the shop, or face us
              w.wait = 2500 + Math.random() * 5000;
            }
          }
        } else {
          w.sprite.x += (dx / dist) * step;
          w.sprite.y += (dy / dist) * step;
          const dir: Dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
          w.sprite.anims.play(`${w.key}-${dir}`, true);
        }
      } else if (w.sprite.anims.isPlaying) {
        w.sprite.anims.stop(); // nowhere to go: never walk on the spot
      }
      w.sprite.setDepth(w.sprite.y);
      w.say?.setPosition(w.sprite.x, w.sprite.y - 29);
    }
  }
}
