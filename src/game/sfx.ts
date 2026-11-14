// Every sound in the game, made on the spot with the Web Audio API.
// There are no audio files: effects are short tones and filtered noise, and
// the music is a slow random walk up and down a five-note scale.

type ToneOpts = { type?: OscillatorType; vol?: number; to?: number; delay?: number; music?: boolean; attack?: number };
type NoiseOpts = { vol?: number; filter?: BiquadFilterType; freq?: number; to?: number; delay?: number };

const DAY_SCALE = [261.6, 293.7, 329.6, 392.0, 440.0, 523.3, 587.3, 659.3];
const NIGHT_SCALE = [220.0, 261.6, 293.7, 329.6, 392.0, 440.0];

export class Sfx {
  muted = false;
  /** Set by the game so the music can settle down after dark. */
  night = false;

  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private music!: GainNode;
  private noiseBuf!: AudioBuffer;
  private step = 0;
  private note = 3;

  /** Browsers only allow sound after a key press or click, so call this from one. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = (this.ctx = new Ctor());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    this.master.connect(ctx.destination);

    // music runs through a soft echo
    this.music = ctx.createGain();
    this.music.gain.value = 0.55;
    const echo = ctx.createDelay(1);
    echo.delayTime.value = 0.38;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.38;
    this.music.connect(this.master);
    this.music.connect(echo);
    echo.connect(feedback);
    feedback.connect(echo);
    echo.connect(this.master);

    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    window.setInterval(() => this.musicStep(), 520);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.7, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  private tone(freq: number, dur: number, o: ToneOpts = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = o.type ?? 'square';
    osc.frequency.setValueAtTime(freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(o.vol ?? 0.08, t + (o.attack ?? 0.008));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(o.music ? this.music : this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private noise(dur: number, o: NoiseOpts = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = o.filter ?? 'lowpass';
    filter.frequency.setValueAtTime(o.freq ?? 1200, t);
    if (o.to) filter.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(o.vol ?? 0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  // ── Effects ───────────────────────────────────────────────────────────────

  mine() { this.noise(0.07, { vol: 0.16, filter: 'highpass', freq: 1800 }); this.tone(1320, 0.09, { type: 'triangle', vol: 0.07 }); this.tone(170, 0.1, { type: 'sine', vol: 0.12, to: 90 }); }
  chop() { this.noise(0.09, { vol: 0.2, freq: 700 }); this.tone(150, 0.12, { type: 'sine', vol: 0.14, to: 80 }); }
  cut() { this.noise(0.13, { vol: 0.1, filter: 'highpass', freq: 2500, to: 6000 }); }
  splash() { this.noise(0.28, { vol: 0.13, filter: 'bandpass', freq: 900, to: 300 }); this.tone(520, 0.12, { type: 'sine', vol: 0.05, to: 240, delay: 0.03 }); }
  coin() { this.tone(988, 0.07, { vol: 0.05 }); this.tone(1319, 0.22, { vol: 0.05, delay: 0.07 }); }
  buy() { this.tone(659, 0.07, { vol: 0.05 }); this.tone(880, 0.16, { vol: 0.05, delay: 0.06 }); }
  open() { this.tone(523, 0.06, { type: 'triangle', vol: 0.08 }); this.tone(784, 0.1, { type: 'triangle', vol: 0.08, delay: 0.05 }); }
  close() { this.tone(784, 0.05, { type: 'triangle', vol: 0.06 }); this.tone(523, 0.09, { type: 'triangle', vol: 0.06, delay: 0.04 }); }
  nope() { this.tone(196, 0.14, { type: 'sawtooth', vol: 0.05, to: 150 }); }
  eat() { this.noise(0.05, { vol: 0.1, freq: 900 }); this.noise(0.05, { vol: 0.1, freq: 800, delay: 0.12 }); }
  news() { [659, 784, 988].forEach((f, i) => this.tone(f, 0.5, { type: 'triangle', vol: 0.06, delay: i * 0.11 })); }
  goal() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.28, { type: 'triangle', vol: 0.07, delay: i * 0.09 })); }
  /** A townsperson buying something nearby: barely there. */
  till() { this.tone(1568, 0.05, { type: 'triangle', vol: 0.018 }); }

  // ── Music ─────────────────────────────────────────────────────────────────

  private musicStep() {
    if (!this.ctx || this.muted || document.hidden) return;
    this.step += 1;
    const scale = this.night ? NIGHT_SCALE : DAY_SCALE;
    if (this.step % 8 === 0) this.tone(scale[0] / 2, 2.6, { type: 'sine', vol: 0.05, music: true, attack: 0.08 });
    if (Math.random() > (this.night ? 0.38 : 0.6)) return;
    this.note = Math.max(0, Math.min(scale.length - 1, this.note + [-2, -1, -1, 1, 1, 2][Math.floor(Math.random() * 6)]));
    const f = scale[this.note];
    this.tone(f, 1.7, { type: 'triangle', vol: 0.045, music: true, attack: 0.02 });
    this.tone(f * 2, 0.9, { type: 'sine', vol: 0.012, music: true, attack: 0.02 });
  }
}

export const sfx = new Sfx();
