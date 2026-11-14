import Phaser from 'phaser';
import { LocalWorld, type GameWorld } from './economy/world';
import { TownScene } from './game/TownScene';
import { connectToChain } from './near/chain';

/** Use the town on NEAR when one is configured and reachable; otherwise run a private town in this tab. */
async function makeWorld(): Promise<GameWorld> {
  try {
    const chain = await connectToChain();
    if (chain) return chain;
  } catch (err) {
    console.warn('Could not reach the town on NEAR, so this tab is running its own practice town.', err);
  }
  return new LocalWorld(Math.floor(Math.random() * 1e6));
}

async function start() {
  // Wait for the pixel font so in-world text does not flash in a fallback face.
  const font = Promise.race([document.fonts.load('8px "Pixelify Sans"'), new Promise((r) => setTimeout(r, 1500))]).catch(() => {});
  const [world] = await Promise.all([makeWorld(), font]);

  const boot = (type: number) =>
    new Phaser.Game({
      type,
      parent: 'game',
      backgroundColor: '#1f2a1c',
      pixelArt: true,
      // Start from real numbers: a zero-sized canvas (a hidden tab) breaks WebGL setup.
      scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth || 960, height: window.innerHeight || 600 },
      callbacks: { preBoot: (g) => g.registry.set('world', world) },
      scene: [TownScene],
    });

  // Add ?renderer=canvas to the address to skip WebGL altogether.
  const forceCanvas = new URLSearchParams(location.search).get('renderer') === 'canvas';
  let game = boot(forceCanvas ? Phaser.CANVAS : Phaser.AUTO);
  const expose = () => {
    if (import.meta.env.DEV) (window as unknown as { game: Phaser.Game }).game = game;
  };
  expose();

  // Some browsers (headless ones, hidden tabs, machines without a working GPU)
  // offer WebGL and then fail while setting it up. If the town has not appeared,
  // start again with the plain 2D canvas renderer, which works everywhere.
  let retried = false;
  const useCanvas = () => {
    if (retried || game.registry.get('town-ready')) return;
    retried = true;
    try { game.destroy(true); } catch { /* it never finished starting */ }
    document.getElementById('game')!.replaceChildren();
    game = boot(Phaser.CANVAS);
    expose();
  };
  window.addEventListener('error', (ev) => {
    if (/framebuffer|webgl/i.test(ev.message ?? '')) useCanvas();
  });
  window.setTimeout(useCanvas, 8000);
}

start();
