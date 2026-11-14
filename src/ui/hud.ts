// Everything drawn over the game: status, bag, prompts and the shop panel.
// Plain DOM on top of the canvas, so text stays sharp at any zoom.

import { GOODS, GOOD_IDS, type GoodId } from '../economy/goods';
import { quoteBuy, quoteSell, type Quote } from '../economy/pricing';
import { TOWN, canInvest, isTradingHour, shareOf, type GameWorld, type Merchant, type MerchantId } from '../economy/world';
import { coinUrl, iconUrl, portraitUrl } from '../game/art';
import { sfx } from '../game/sfx';

/** One hour of the time-lapse: each shop's selling price as a share of normal, or null while it is shut. */
export interface LapsePoint {
  price: Record<MerchantId, number | null>;
}

const LAPSE_LINES: { id: MerchantId; color: string }[] = [
  { id: 'blacksmith', color: '#59607a' },
  { id: 'baker', color: '#c9553e' },
  { id: 'fishmonger', color: '#3d7fb0' },
  { id: 'carpenter', color: '#3f8a5a' },
];

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const SMALL_TALK: Record<MerchantId, string> = {
  blacksmith: 'Bring me ore and wood and I\'ll turn it into something useful.',
  baker: 'Morning! Wheat in, bread out. That\'s the whole secret.',
  fishmonger: 'Fresh from the river or not at all. What have you caught?',
  carpenter: 'Good timber is hard to find. I\'ll take all the wood you can carry.',
};

const PERKS: Partial<Record<GoodId, string>> = {
  bread: 'Eat for +12 energy',
  smoked_fish: 'Eat for +10 energy',
  tools: 'Gather +1 more per swing (up to +2)',
  furniture: 'A fine thing to own',
};

export class Hud {
  shopOpen: MerchantId | null = null;
  private root: HTMLElement;
  private el: Record<string, HTMLElement> = {};
  private flash: { text: string; kind: 'good' | 'bad' | '' } = { text: '', kind: '' };
  private toastTimer = 0;
  private newsTimer = 0;
  /** Called after anything the player does in a panel, so the town can redraw. */
  onChange: () => void = () => {};
  /** Called when the player asks to start or stop the time-lapse. */
  onLapse: (start: boolean) => void = () => {};

  constructor(private world: GameWorld) {
    this.root = document.getElementById('hud')!;
    this.root.innerHTML = `
      <div class="vignette"></div>
      <div class="status panel">
        <div class="row when"><span data-id="day"></span><span class="clock" data-id="clock"></span></div>
        <div class="row coins"><img src="${coinUrl()}" alt="" /><span data-id="coins"></span></div>
        <div class="row"><span class="label">Energy</span><div class="energy" data-id="energyBar"><i></i></div></div>
      </div>
      <div class="goal panel" data-id="goal"></div>
      <div class="news panel" data-id="news"></div>
      <div class="corner" data-id="corner"><button class="mute" data-act="mute" data-id="mute">♪ Sound on</button><button class="mute" data-act="lapse-start">▶▶ Watch a week go by</button><span>WASD move · E use · M sound</span><span class="where" data-id="where"></span></div>
      <div class="lapse panel" data-id="lapse">
        <header><b>A week in a minute</b><span data-id="lapseWhen"></span><button class="act" data-act="lapse-stop" data-id="lapseStop">Stop</button></header>
        <p class="lapse-note">A copy of the town, run forward with nobody playing. Lines show each shop's price as a share of its usual price.</p>
        <canvas data-id="lapseChart" width="520" height="170"></canvas>
        <div class="lapse-legend" data-id="lapseLegend"></div>
        <div class="lapse-log" data-id="lapseLog"></div>
      </div>
      <div class="title" data-id="title">
        <div class="title-card">
          <h1>Brambleford</h1>
          <p>A small town where every price has a reason.</p>
          <span class="begin">Press any key to begin</span>
        </div>
      </div>
      <div class="toast panel" data-id="toast"></div>
      <div class="prompt panel" data-id="prompt"></div>
      <div class="bag panel" data-id="bag"></div>
      <div class="shop-wrap" data-id="shopWrap"><div class="shop panel" data-id="shop"></div></div>`;
    this.root.querySelectorAll<HTMLElement>('[data-id]').forEach((e) => (this.el[e.dataset.id!] = e));
    this.root.addEventListener('click', (ev) => this.onClick(ev));
    this.refresh();
  }

  // ── Small pieces ──────────────────────────────────────────────────────────

  refresh() {
    const w = this.world;
    const hour = w.town.hour;
    const h = hour % 12 === 0 ? 12 : hour % 12;
    const night = !isTradingHour(w);
    this.el.day.textContent = `Day ${w.town.day}`;
    this.el.clock.textContent = `${night ? '☾' : '☀'} ${h}:00 ${hour < 12 ? 'am' : 'pm'}`;
    this.el.where.textContent = w.status();
    this.el.coins.textContent = String(w.player.coins);
    const pct = (w.player.energy / w.player.maxEnergy) * 100;
    this.el.energyBar.classList.toggle('low', pct < 20);
    (this.el.energyBar.firstElementChild as HTMLElement).style.width = `${pct}%`;

    this.el.bag.innerHTML = GOOD_IDS.map((id) => {
      const n = w.player.inventory[id] ?? 0;
      const food = GOODS[id].energy ? ' food' : '';
      const tip = GOODS[id].energy && n > 0 ? `${GOODS[id].name}: click to eat (+${GOODS[id].energy} energy)` : GOODS[id].name;
      return `<div class="slot${n ? '' : ' empty'}${food}" data-act="eat" data-good="${id}">
        <img src="${iconUrl(id)}" alt="${GOODS[id].name}" />${n ? `<span class="n">${n}</span>` : ''}
        <span class="tip panel">${tip}</span></div>`;
    }).join('');

    if (this.shopOpen) this.renderShop();
  }

  setPrompt(html: string | null) {
    this.el.prompt.classList.toggle('show', !!html && !this.shopOpen);
    if (html) this.el.prompt.innerHTML = html;
  }

  toast(text: string) {
    this.el.toast.textContent = text;
    this.el.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.el.toast.classList.remove('show'), 2200);
  }

  /** The current first-minute goal, or null to put the strip away. */
  setGoal(text: string | null, justDone = false) {
    this.el.goal.classList.toggle('show', !!text);
    this.el.goal.classList.toggle('done', justDone);
    if (text) this.el.goal.innerHTML = `<b>${justDone ? '✓ Done' : 'Next'}</b>${text}`;
  }

  /** Point every panel at a different town (the time-lapse swaps in a copy). */
  setWorld(world: GameWorld) {
    this.world = world;
    this.refresh();
  }

  showLapse(on: boolean) {
    this.root.classList.toggle('lapsing', on);
    this.el.lapseLog.innerHTML = '';
    this.el.lapseStop.textContent = 'Stop';
  }

  /** Redraw the time-lapse chart. `history` has one entry per hour so far, `total` is how many there will be. */
  drawLapse(history: LapsePoint[], total: number, done: boolean) {
    const w = this.world.town;
    const hour = w.hour % 12 === 0 ? 12 : w.hour % 12;
    this.el.lapseWhen.textContent = done ? 'The week is over' : `Day ${w.day}, ${hour} ${w.hour < 12 ? 'am' : 'pm'}`;
    if (done) this.el.lapseStop.textContent = 'Back to town';

    const canvas = this.el.lapseChart as HTMLCanvasElement;
    const c = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height, left = 34, bottom = 16;
    const lo = 0.25, hi = 2.75;
    const X = (i: number) => left + (i / Math.max(1, total - 1)) * (W - left - 6);
    const Y = (v: number) => (H - bottom) - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (H - bottom - 6);
    c.clearRect(0, 0, W, H);
    c.font = '11px "Pixelify Sans", monospace';
    c.fillStyle = '#7a5a3e';
    c.strokeStyle = '#d9c391';
    c.lineWidth = 1;
    for (const v of [0.5, 1, 1.5, 2, 2.5]) {
      c.beginPath(); c.moveTo(left, Y(v) + 0.5); c.lineTo(W - 6, Y(v) + 0.5); c.stroke();
      c.fillText(`${v * 100}%`, 0, Y(v) + 4);
    }
    for (let d = 0; d * 24 < total; d++) c.fillText(`day ${d + 1}`, X(d * 24) + 2, H - 3);
    c.strokeStyle = '#8a5a30';
    c.beginPath(); c.moveTo(left, Y(1) + 0.5); c.lineTo(W - 6, Y(1) + 0.5); c.stroke();

    LAPSE_LINES.forEach((line) => {
      c.strokeStyle = line.color;
      c.lineWidth = 2;
      c.beginPath();
      let pen = false;
      history.forEach((p, i) => {
        const v = p.price[line.id];
        if (v == null) { pen = false; return; } // the shop was shut
        pen ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v));
        pen = true;
      });
      c.stroke();
    });

    const now = history[history.length - 1];
    this.el.lapseLegend.innerHTML = LAPSE_LINES.map((line) => {
      const m = w.merchants[line.id];
      const price = now?.price[line.id];
      return `<span><i style="background:${line.color}"></i>${GOODS[m.recipe.output].name}: ${price == null ? 'shop shut' : `${Math.round(price * GOODS[m.recipe.output].base)} coins`} · ${m.name} has ${m.coins}</span>`;
    }).join('');
  }

  lapseNews(text: string) {
    const w = this.world.town;
    this.el.lapseLog.insertAdjacentHTML('afterbegin', `<div><b>Day ${w.day}</b> ${text}</div>`);
  }

  setWhere(text: string) {
    if (this.el.where.textContent !== text) this.el.where.textContent = text;
  }

  hideTitle() {
    this.el.title.classList.add('gone');
  }

  setMuted(muted: boolean) {
    this.el.mute.textContent = muted ? '♪ Sound off' : '♪ Sound on';
  }

  news(text: string) {
    this.el.news.innerHTML = `<b>Town news</b>${text}`;
    this.el.news.classList.add('show');
    clearTimeout(this.newsTimer);
    this.newsTimer = window.setTimeout(() => this.el.news.classList.remove('show'), 9000);
  }

  // ── The shop panel ────────────────────────────────────────────────────────

  openShop(id: MerchantId) {
    this.shopOpen = id;
    this.flash = { text: '', kind: '' };
    this.el.shopWrap.classList.add('show');
    this.setPrompt(null);
    sfx.open();
    this.renderShop();
  }

  closeShop() {
    if (this.shopOpen) sfx.close();
    this.shopOpen = null;
    this.el.shopWrap.classList.remove('show');
  }

  private says(m: Merchant): string {
    const season = this.world.town.season;
    if (season && season.good in m.usualSupply) return season.headline;
    if (m.coins < 60) return 'Coin is tight this week. I can\'t pay what I\'d like to.';
    return SMALL_TALK[m.id];
  }

  private priceCell(q: Quote, base: number, playerIsSelling: boolean): string {
    const pct = Math.round((q.price / base - 1) * 100);
    const goodForPlayer = playerIsSelling ? pct > 0 : pct < 0;
    const trend = Math.abs(pct) < 5 ? '' : `<span class="trend ${goodForPlayer ? 'up' : 'down'}">${pct > 0 ? '▲' : '▼'}${Math.abs(pct)}%</span>`;
    return `<div class="price"><img src="${coinUrl()}" alt="" />${q.price}${trend}
      <div class="why panel"><b>Why this price</b>${q.reasons.join(' ')}</div></div>`;
  }

  private renderShop() {
    const w = this.world;
    const m = w.town.merchants[this.shopOpen!];
    const head = `
      <header>
        <img class="face" src="${portraitUrl(m.id)}" alt="" />
        <div><h2>${m.name}<small>${m.title}</small></h2><p class="says">${m.open && isTradingHour(w) ? `"${this.says(m)}"` : ''}</p></div>
        <button class="close" data-act="close"><kbd>Esc</kbd> Leave</button>
      </header>`;

    let body: string;
    if (!m.open) {
      body = `<p class="shut">The shutters are down. ${m.name} couldn't pay the rent.<br />Put up ${TOWN.investCost} coins and the shop reopens, with ${TOWN.investPct}% of its profits yours. If nobody does, the townsfolk will club together in a few days.</p>`;
    } else if (!isTradingHour(w)) {
      body = `<p class="shut">${m.name} has gone to bed.<br />Shops open at ${TOWN.openHour} in the morning.</p>`;
    } else {
      const buys = (Object.keys(m.usualSupply) as GoodId[]).map((id) => {
        const q = quoteBuy(m, id);
        const have = w.player.inventory[id] ?? 0;
        const off = have < 1 || !q.available ? 'disabled' : '';
        return `<div class="line">
          <img class="item" src="${iconUrl(id)}" alt="" />
          <div class="name">${GOODS[id].name}<small>You have ${have}</small></div>
          ${this.priceCell(q, GOODS[id].base, true)}
          <div class="btns"><button class="act" data-act="sell" data-good="${id}" ${off}>Sell 1</button>
          <button class="act" data-act="sellall" data-good="${id}" ${off}>Sell all</button></div></div>`;
      }).join('');
      const out = m.recipe.output;
      const q = quoteSell(m, out);
      const off = !q.available || w.player.coins < q.price ? 'disabled' : '';
      const sells = `<div class="line">
          <img class="item" src="${iconUrl(out)}" alt="" />
          <div class="name">${GOODS[out].name}<small>${m.stock[out] ?? 0} on the shelf · ${PERKS[out] ?? ''}</small></div>
          ${this.priceCell(q, GOODS[out].base, false)}
          <div class="btns"><button class="act" data-act="buy" data-good="${out}" ${off}>Buy 1</button></div></div>`;
      body = `<h3>${m.name} buys</h3>${buys}<h3>${m.name} sells</h3>${sells}`;
    }

    const share = Math.round(shareOf(w, m) * 100);
    const mayInvest = canInvest(w, m);
    const foot = `
      ${m.plan ? `<p class="plan"><b>${m.name}'s plan</b>${escapeHtml(m.plan)}</p>` : ''}
      <div class="flash ${this.flash.kind}">${this.flash.text}</div>
      <footer>
        <span>${m.name} has ${m.coins} coins in the till.<br />
        ${share ? `You own ${share}% of this shop and get that share of each day's profit.` : 'You own none of this shop yet.'}</span>
        <button class="act gold" data-act="invest" ${mayInvest ? '' : 'disabled'}>Buy in · ${TOWN.investCost}</button>
      </footer>`;
    this.el.shop.innerHTML = head + body + foot;
  }

  private onClick(ev: MouseEvent) {
    const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!target) {
      if (ev.target === this.el.shopWrap) this.closeShop();
      return;
    }
    target.blur(); // otherwise Space, which is also "gather", would press this button again
    const w = this.world;
    const good = target.dataset.good as GoodId | undefined;
    const id = this.shopOpen;

    switch (target.dataset.act) {
      case 'close':
        this.closeShop();
        return;
      case 'mute':
        this.setMuted(sfx.toggleMute());
        return;
      case 'lapse-start':
        this.onLapse(true);
        return;
      case 'lapse-stop':
        this.onLapse(false);
        return;
      case 'eat': {
        if (!good || !GOODS[good].energy || !(w.player.inventory[good] ?? 0)) return;
        const r = w.eat(good);
        this.toast(r.ok ? `You eat the ${GOODS[good].name.toLowerCase()}. ${r.message}` : r.message);
        if (r.ok) sfx.eat();
        break;
      }
      case 'sell': {
        const r = w.sell(id!, good!);
        this.flash = { text: r.ok ? `Sold 1 ${GOODS[good!].name.toLowerCase()} for ${r.price} coins.` : r.message, kind: r.ok ? 'good' : 'bad' };
        r.ok ? sfx.coin() : sfx.nope();
        break;
      }
      case 'sellall': {
        const r = w.sell(id!, good!, 999);
        this.flash = r.ok
          ? { text: `Sold ${r.count} ${GOODS[good!].plural} for ${r.price} coins.${(r.count ?? 0) > 1 ? ' The price fell as you sold.' : ''}`, kind: 'good' }
          : { text: r.message, kind: 'bad' };
        r.ok ? sfx.coin() : sfx.nope();
        break;
      }
      case 'buy': {
        const r = w.buy(id!, good!);
        this.flash = { text: r.ok ? `Bought 1 ${GOODS[good!].name.toLowerCase()} for ${r.price} coins.` : r.message, kind: r.ok ? 'good' : 'bad' };
        r.ok ? sfx.buy() : sfx.nope();
        break;
      }
      case 'invest': {
        const r = w.invest(id!);
        this.flash = { text: r.message, kind: r.ok ? 'good' : 'bad' };
        r.ok ? sfx.goal() : sfx.nope();
        break;
      }
    }
    this.refresh();
    this.onChange();
  }
}
