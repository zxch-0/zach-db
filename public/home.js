/*
 * zach-db — moteur visuel de l'accueil.
 *
 * Trois calques dessinés sur canvas, plus deux effets de texte, le tout piloté
 * par UN SEUL requestAnimationFrame :
 *
 *   1. le vide    — grille en perspective qui défile vers l'horizon, poussière
 *                   liée au curseur, halo doux ;
 *   2. le noyau   — sphère filaire en rotation qui se penche vers le pointeur,
 *                   balayée par un anneau de lecture ;
 *   3. le signal  — oscilloscope pleine largeur (bruit lissé, encre qui goutte,
 *                   balayage) ;
 *   4. le décodage — la ligne monospace se décode caractère par caractère ;
 *   5. la télémétrie — heure, images/s, poussière, pointeur, temps écoulé.
 *
 * Tout est facultatif : sans canvas, sans requestAnimationFrame, ou si le
 * système demande moins de mouvement, chaque calque dessine une image fixe et
 * la page reste exactement aussi lisible. Aucune ressource externe, aucun
 * emoji, que du blanc sur noir.
 */
import './chrome.js'; // sélecteur d'outil + décor commun

const reducedMotion =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const hasRaf = typeof requestAnimationFrame === 'function';
const DPR_CAP = 2;

const byId = (id) => (typeof document.getElementById === 'function' ? document.getElementById(id) : null);
const qsa = (selector) =>
  (typeof document.querySelectorAll === 'function' ? [...document.querySelectorAll(selector)] : []);
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/* ==================================================================
 * horloge unique : un seul rAF pour tous les calques
 * ================================================================== */

const layers = [];
let running = false;
let frame = 0;
let previous = 0;
let elapsed = 0; // secondes de mouvement (gelées si mouvement réduit)
let frames = 0;
let fpsWindow = 0;
let fpsValue = 0;

function addLayer(layer) {
  if (layer) layers.push(layer);
}

function drawOnce(time) {
  for (const layer of layers) {
    try {
      layer.draw(time, 0);
    } catch {
      // un calque en panne ne doit pas éteindre les autres
    }
  }
}

function tick() {
  frame = requestAnimationFrame(tick);
  const time = now();
  const dt = Math.min(0.05, Math.max(0, (time - previous) / 1000));
  previous = time;
  elapsed += dt;
  frames++;
  fpsWindow += dt;
  if (fpsWindow >= 0.5) {
    fpsValue = Math.round(frames / fpsWindow);
    frames = 0;
    fpsWindow = 0;
  }
  drawOnce(elapsed);
  if (typeof dt === 'number') smoothPointer(dt);
}

function start() {
  if (running || !hasRaf) return;
  running = true;
  previous = now();
  frame = requestAnimationFrame(tick);
}

function stop() {
  if (!running) return;
  running = false;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
}

/* ==================================================================
 * pointeur partagé (normalisé, lissé)
 * ================================================================== */

const pointer = { x: 0.5, y: 0.5, sx: 0.5, sy: 0.5 };

function smoothPointer(dt) {
  const k = Math.min(1, dt * 4.5);
  pointer.sx += (pointer.x - pointer.sx) * k;
  pointer.sy += (pointer.y - pointer.sy) * k;
}

function watchPointer() {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('pointermove', (event) => {
    const w = typeof innerWidth === 'number' && innerWidth > 0 ? innerWidth : 1;
    const h = typeof innerHeight === 'number' && innerHeight > 0 ? innerHeight : 1;
    pointer.x = Math.min(1, Math.max(0, event.clientX / w));
    pointer.y = Math.min(1, Math.max(0, event.clientY / h));
  }, { passive: true });
}

/* ==================================================================
 * canvas : mise à l'échelle nette, sans jamais exploser la mémoire
 * ================================================================== */

function fit(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  if (typeof canvas.getBoundingClientRect !== 'function') return null;
  const box = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(box.width));
  const h = Math.max(1, Math.round(box.height));
  const dpr = Math.min(
    typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1,
    DPR_CAP
  );
  const px = Math.round(w * dpr);
  const py = Math.round(h * dpr);
  if (canvas.width !== px) canvas.width = px;
  if (canvas.height !== py) canvas.height = py;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const white = (alpha) => 'rgba(255,255,255,' + Math.max(0, Math.min(1, alpha)).toFixed(3) + ')';

/* ==================================================================
 * 1. le vide — grille en perspective, poussière, halo du curseur
 * ================================================================== */

const STEP = 92; // espacement des lignes du sol, en unités monde
const LANES = 15; // demi-nombre de lignes fuyantes
const SPEED = 118; // vitesse de défilement du sol
const ROWS = 22; // lignes transversales suivies

function createVoid(canvas) {
  let surface = fit(canvas);
  if (!surface) return null;
  let dust = [];

  function seed() {
    const next = fit(canvas);
    if (next) surface = next;
    const { w, h } = surface;
    const count = Math.max(26, Math.min(96, Math.round((w * h) / 17000)));
    dust = [];
    for (let i = 0; i < count; i++) {
      dust.push({
        x: Math.random() * w,
        y: Math.random() * h * 0.64,
        vx: (Math.random() - 0.5) * 8,
        vy: -5 - Math.random() * 10,
        r: 0.6 + Math.random() * 1.3,
        a: 0.16 + Math.random() * 0.42,
      });
    }
    return count;
  }

  function draw(t, dt) {
    const { ctx, w, h } = surface;
    ctx.clearRect(0, 0, w, h);
    const horizon = h * 0.63;
    const px = pointer.sx * w;
    const py = pointer.sy * h;

    // halo du curseur
    const glow = ctx.createRadialGradient(px, py, 0, px, py, Math.max(w, h) * 0.38);
    glow.addColorStop(0, white(0.06));
    glow.addColorStop(1, white(0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // lignes transversales : elles naissent à l'horizon et foncent vers nous
    const focal = h * 0.62;
    const camY = h * 0.3;
    const span = STEP * ROWS;
    const shift = reducedMotion ? 0 : (t * SPEED) % span;
    ctx.lineWidth = 1;
    for (let k = 0; k < ROWS; k++) {
      const z = 60 + (((k * STEP - shift) % span) + span) % span;
      const y = horizon + (focal * camY) / z;
      if (!(y > horizon) || y > h + 1) continue;
      const depth = (y - horizon) / Math.max(1, h - horizon);
      ctx.strokeStyle = white(0.02 + 0.14 * Math.pow(depth, 0.7));
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(w, Math.round(y) + 0.5);
      ctx.stroke();
    }

    // lignes fuyantes : toutes convergent vers le point de fuite
    const vx = w * (0.5 + (pointer.sx - 0.5) * 0.05);
    for (let i = -LANES; i <= LANES; i++) {
      const x = vx + (focal * (i * STEP)) / 60;
      ctx.strokeStyle = white(0.11 * (1 - Math.abs(i) / (LANES + 3)));
      ctx.beginPath();
      ctx.moveTo(vx, horizon);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // l'horizon : filet net + souffle lumineux
    const band = ctx.createLinearGradient(0, horizon - h * 0.1, 0, horizon + h * 0.05);
    band.addColorStop(0, white(0));
    band.addColorStop(0.62, white(0.055));
    band.addColorStop(1, white(0));
    ctx.fillStyle = band;
    ctx.fillRect(0, horizon - h * 0.1, w, h * 0.15);
    ctx.strokeStyle = white(0.3);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(horizon) + 0.5);
    ctx.lineTo(w, Math.round(horizon) + 0.5);
    ctx.stroke();

    // poussière au-dessus de l'horizon, et ses liens près du curseur
    const link = 100;
    for (let i = 0; i < dust.length; i++) {
      const a = dust[i];
      if (!reducedMotion && dt) {
        a.x += a.vx * dt;
        a.y += a.vy * dt;
        if (a.y < -8) {
          a.y = horizon * (0.55 + Math.random() * 0.42);
          a.x = Math.random() * w;
        }
        if (a.x < -8) a.x = w + 8;
        else if (a.x > w + 8) a.x = -8;
      }
      ctx.fillStyle = white(a.a);
      ctx.fillRect(a.x, a.y, a.r, a.r);

      const toCursor = Math.hypot(a.x - px, a.y - py);
      if (toCursor < link * 1.5) {
        ctx.strokeStyle = white(0.17 * (1 - toCursor / (link * 1.5)));
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(px, py);
        ctx.stroke();
      }
      for (let j = i + 1; j < dust.length; j++) {
        const b = dust[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d > link) continue;
        ctx.strokeStyle = white(0.085 * (1 - d / link));
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  }

  return { draw, resize: seed, count: seed() };
}

/* ==================================================================
 * 2. le noyau — sphère filaire, anneau de balayage
 * ================================================================== */

const RINGS = 13; // parallèles (les pôles ne sont pas des anneaux)
const POINTS = 36; // points par parallèle
const SCAN_POINTS = 72;

function createCore(canvas) {
  let surface = fit(canvas);
  if (!surface) return null;

  // sommets sur la sphère unité, calculés une fois
  const nodes = [];
  for (let i = 1; i < RINGS; i++) {
    const phi = (i / RINGS) * Math.PI;
    const y = Math.cos(phi);
    const r = Math.sin(phi);
    for (let j = 0; j < POINTS; j++) {
      const theta = (j / POINTS) * Math.PI * 2;
      nodes.push({ x: r * Math.cos(theta), y, z: r * Math.sin(theta), i, j });
    }
  }
  const index = (i, j) => (i - 1) * POINTS + (((j % POINTS) + POINTS) % POINTS);

  function project(x, y, z, spin, tiltX, tiltY, radius, cx, cy) {
    // rotation Y (spin) puis X (inclinaison) puis Z (roulis léger)
    const ca = Math.cos(spin);
    const sa = Math.sin(spin);
    const x1 = x * ca + z * sa;
    const z1 = -x * sa + z * ca;
    const cb = Math.cos(tiltX);
    const sb = Math.sin(tiltX);
    const y2 = y * cb - z1 * sb;
    const z2 = y * sb + z1 * cb;
    const cc = Math.cos(tiltY);
    const sc = Math.sin(tiltY);
    const x3 = x1 * cc - y2 * sc;
    const y3 = x1 * sc + y2 * cc;
    const f = 2.7;
    const scale = f / (f - z2);
    return { x: cx + x3 * radius * scale, y: cy + y3 * radius * scale, depth: (z2 + 1) / 2 };
  }

  function draw(t) {
    const { ctx, w, h } = surface;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) * 0.335;
    const spin = reducedMotion ? 0.5 : t * 0.19;
    const tiltX = -0.34 + (pointer.sy - 0.5) * 0.72;
    const tiltY = (pointer.sx - 0.5) * 0.4;

    // halos derrière la sphère
    const halo = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * 1.85);
    halo.addColorStop(0, white(0.05));
    halo.addColorStop(1, white(0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);

    // parallèles
    ctx.lineWidth = 1;
    for (let i = 1; i < RINGS; i++) {
      ctx.beginPath();
      let depth = 0;
      for (let j = 0; j <= POINTS; j++) {
        const node = nodes[index(i, j)];
        const p = project(node.x, node.y, node.z, spin, tiltX, tiltY, radius, cx, cy);
        depth += p.depth;
        if (j === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = white(0.035 + 0.1 * (depth / (POINTS + 1)));
      ctx.stroke();
    }

    // méridiens
    for (let j = 0; j < POINTS; j += 1) {
      ctx.beginPath();
      let depth = 0;
      for (let i = 1; i < RINGS; i++) {
        const node = nodes[index(i, j)];
        const p = project(node.x, node.y, node.z, spin, tiltX, tiltY, radius, cx, cy);
        depth += p.depth;
        if (i === 1) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = white(0.03 + 0.09 * (depth / (RINGS - 1)));
      ctx.stroke();
    }

    // sommets : plus brillants devant
    for (const node of nodes) {
      const p = project(node.x, node.y, node.z, spin, tiltX, tiltY, radius, cx, cy);
      const size = 0.9 + p.depth * 1.25;
      ctx.fillStyle = white(0.1 + 0.62 * p.depth);
      ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
    }

    // anneau de balayage : une latitude qui descend et remonte
    const sweep = reducedMotion ? 0.5 : (Math.sin(t * 0.42) + 1) / 2;
    const phi = 0.16 * Math.PI + sweep * 0.68 * Math.PI;
    const ry = Math.cos(phi);
    const rr = Math.sin(phi);
    ctx.beginPath();
    let brightest = null;
    for (let j = 0; j <= SCAN_POINTS; j++) {
      const theta = (j / SCAN_POINTS) * Math.PI * 2;
      const p = project(rr * Math.cos(theta), ry, rr * Math.sin(theta), spin, tiltX, tiltY, radius, cx, cy);
      if (j === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
      if (!brightest || p.depth > brightest.depth) brightest = p;
    }
    ctx.strokeStyle = white(0.34);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    if (brightest) {
      ctx.fillStyle = white(0.85);
      ctx.fillRect(brightest.x - 1.6, brightest.y - 1.6, 3.2, 3.2);
    }
    ctx.lineWidth = 1;

    // axe vertical : le fil qui tient le noyau
    ctx.strokeStyle = white(0.14);
    ctx.beginPath();
    ctx.moveTo(cx, cy - radius * 1.22);
    ctx.lineTo(cx, cy + radius * 1.22);
    ctx.stroke();
  }

  function resize() {
    const next = fit(canvas);
    if (next) surface = next;
  }

  return { draw, resize, nodes: nodes.length };
}

/* ==================================================================
 * 3. le signal — oscilloscope pleine largeur
 * ================================================================== */

const SAMPLES = 220;

function createSignal(canvas) {
  let surface = fit(canvas);
  if (!surface) return null;

  const phase = new Float64Array(SAMPLES);
  const rate = new Float64Array(SAMPLES);
  const gain = new Float64Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i++) {
    phase[i] = Math.random() * Math.PI * 2;
    rate[i] = 0.5 + Math.random() * 1.7;
    gain[i] = 0.25 + Math.random() * 0.75;
  }

  function sample(i, t) {
    return (
      (Math.sin(t * rate[i] * 0.85 + phase[i]) * 0.55 +
        Math.sin(t * rate[i] * 0.33 + phase[i] * 2.1) * 0.3 +
        Math.sin(t * 0.19 + i * 0.085) * 0.24) *
      gain[i]
    );
  }

  function draw(t) {
    const { ctx, w, h } = surface;
    ctx.clearRect(0, 0, w, h);
    const mid = h * 0.56;
    const px = pointer.sx * w;

    // graduations
    ctx.lineWidth = 1;
    ctx.strokeStyle = white(0.06);
    for (let g = 1; g < 6; g++) {
      const y = Math.round((h / 6) * g) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.strokeStyle = white(0.11);
    for (let g = 1; g < 40; g++) {
      const x = Math.round((w / 40) * g) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, mid - (g % 5 === 0 ? 5 : 2.5));
      ctx.lineTo(x, mid + (g % 5 === 0 ? 5 : 2.5));
      ctx.stroke();
    }
    ctx.strokeStyle = white(0.2);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid) + 0.5);
    ctx.lineTo(w, Math.round(mid) + 0.5);
    ctx.stroke();

    // la courbe : le curseur la soulève en passant
    const sigma = Math.max(60, w * 0.11);
    ctx.beginPath();
    for (let i = 0; i < SAMPLES; i++) {
      const x = (i / (SAMPLES - 1)) * w;
      const dx = x - px;
      const lift = Math.exp(-(dx * dx) / (2 * sigma * sigma)) * h * 0.17;
      const y = mid - sample(i, t) * h * 0.3 - lift;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = white(0.6);
    ctx.lineWidth = 1.25;
    ctx.stroke();

    // encre sous la courbe
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, mid - h * 0.34, 0, h);
    fill.addColorStop(0, white(0.09));
    fill.addColorStop(1, white(0));
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1;

    // trois gouttes d'encre tombent du haut jusqu'à la courbe
    for (let k = 0; k < 3; k++) {
      const drift = reducedMotion ? 0 : t * (0.035 + k * 0.017);
      const i = Math.floor(((drift + k * 0.37) % 1) * (SAMPLES - 1));
      const x = (i / (SAMPLES - 1)) * w;
      const dx = x - px;
      const lift = Math.exp(-(dx * dx) / (2 * sigma * sigma)) * h * 0.17;
      const y = mid - sample(i, t) * h * 0.3 - lift;
      ctx.strokeStyle = white(0.14);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, y);
      ctx.stroke();
      ctx.fillStyle = white(0.7);
      ctx.fillRect(x - 1.4, y - 1.4, 2.8, 2.8);
    }

    // balayage vertical
    const sweepX = reducedMotion ? w * 0.5 : ((t * 0.085) % 1) * w;
    const sweep = ctx.createLinearGradient(sweepX - 46, 0, sweepX + 46, 0);
    sweep.addColorStop(0, white(0));
    sweep.addColorStop(0.5, white(0.09));
    sweep.addColorStop(1, white(0));
    ctx.fillStyle = sweep;
    ctx.fillRect(sweepX - 46, 0, 92, h);
  }

  function resize() {
    const next = fit(canvas);
    if (next) surface = next;
  }

  return { draw, resize };
}

/* ==================================================================
 * 4. la ligne qui se décode
 * ================================================================== */

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/\\<>-=+*#%$@';

function initDecode() {
  for (const node of qsa('[data-decode]')) {
    const target = node.getAttribute('data-decode') || String(node.textContent || '');
    if (!target) continue;
    if (reducedMotion) {
      node.textContent = target;
      continue;
    }
    const rounds = target.length * 2 + 18;
    let step = 0;
    const run = () => {
      step++;
      const revealed = Math.floor((step / rounds) * target.length * 1.4);
      let out = '';
      for (let i = 0; i < target.length; i++) {
        const char = target[i];
        if (char === ' ' || i < revealed) out += char;
        else out += GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      node.textContent = out;
      if (revealed < target.length) setTimeout(run, 36);
      else node.textContent = target;
    };
    setTimeout(run, 320);
  }
}

/* ==================================================================
 * 5. la télémétrie
 * ================================================================== */

const pad = (value) => String(value).padStart(2, '0');
const fmt = typeof Intl !== 'undefined' ? new Intl.NumberFormat('en-US') : null;
const count = (value) => (fmt ? fmt.format(value) : String(value));

function initTelemetry(dustCount, nodeCount) {
  const clock = byId('telClock');
  const fps = byId('telFps');
  const dust = byId('telDust');
  const ptr = byId('telPointer');
  const uptime = byId('telUptime');
  const nodes = byId('coreNodes');
  if (!clock && !fps && !dust && !ptr && !uptime && !nodes) return; // pas de télémétrie sur cette page

  if (dust) dust.textContent = count(dustCount);
  if (nodes) nodes.textContent = count(nodeCount);

  const startedAt = Date.now();
  const render = () => {
    const date = new Date();
    if (clock) clock.textContent = pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    if (fps) fps.textContent = reducedMotion || !hasRaf ? 'still frame' : count(fpsValue) + ' fps';
    if (ptr) ptr.textContent = pointer.sx.toFixed(2) + ' / ' + pointer.sy.toFixed(2);
    if (uptime) {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      uptime.textContent = pad(Math.floor(seconds / 60)) + ':' + pad(seconds % 60);
    }
  };
  render();
  const timer = setInterval(render, reducedMotion ? 1000 : 240);
  if (timer && typeof timer.unref === 'function') timer.unref(); // ne retient pas Node (tests)
}

/* ==================================================================
 * démarrage
 * ================================================================== */

function boot() {
  watchPointer();

  const voidLayer = createVoid(byId('voidCanvas'));
  const coreLayer = createCore(byId('coreCanvas'));
  const signalLayer = createSignal(byId('signalCanvas'));
  addLayer(voidLayer);
  addLayer(coreLayer);
  addLayer(signalLayer);
  if (!layers.length) return; // aucun canvas : la page reste lisible, sans décor animé

  initDecode();
  initTelemetry(voidLayer ? voidLayer.count : 0, coreLayer ? coreLayer.nodes + SCAN_POINTS : 0);

  let pending = 0;
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', () => {
      clearTimeout(pending);
      pending = setTimeout(() => {
        for (const layer of layers) layer.resize();
        if (!running) drawOnce(elapsed);
      }, 140);
    }, { passive: true });
  }

  if (reducedMotion || !hasRaf) {
    drawOnce(0.6); // une image fixe, composée, plutôt qu'un écran noir
    return;
  }

  start();
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else start();
    });
  }
}

boot();
