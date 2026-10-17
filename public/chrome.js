/*
 * zach-db — habillage partagé de toutes les pages.
 *
 * Deux rôles :
 *   1. le sélecteur d'outil de l'en-tête, construit à partir du registre
 *      (public/lib/tools.js) : sans JavaScript, le bouton reste un simple lien
 *      vers l'accueil, qui liste déjà tous les outils ;
 *   2. le décor commun (fil de lecture, apparitions au défilement, halo des
 *      cartes, compteurs, boutons « copier »).
 *
 * Tout est facultatif : sans IntersectionObserver ni requestAnimationFrame, la
 * page s'affiche à l'identique, sans animation. Les tests chargent ce module
 * dans un DOM simulé, donc chaque fonction commence par vérifier ce qu'elle
 * trouve avant d'agir.
 */
import { TOOLS, findToolByPath, normalizePath } from './lib/tools.js';

const el = (id) => (typeof document.getElementById === 'function' ? document.getElementById(id) : null);

const qsa = (selector, root = document) =>
  (typeof root.querySelectorAll === 'function' ? [...root.querySelectorAll(selector)] : []);

const currentPath = () =>
  (typeof location !== 'undefined' && location.pathname ? location.pathname : '/');

/* ==================================================================
 * Sélecteur d'outil
 * ================================================================== */

/** Une entrée du menu : accueil + chaque outil du registre. */
function menuEntries() {
  const active = findToolByPath(normalizePath(currentPath()));
  const entries = [{
    id: 'home',
    name: 'All tools',
    hint: 'the whole collection',
    path: '/',
    status: 'available',
    current: !active,
  }];
  for (const tool of TOOLS) {
    entries.push({
      id: tool.id,
      name: tool.name,
      hint: tool.tagline,
      path: tool.path,
      status: tool.status,
      current: tool === active,
    });
  }
  return entries;
}

function buildMenu(menu, entries) {
  const fragment = document.createDocumentFragment();

  // rappel du nombre d'outils en ligne, en tête de menu
  const online = entries.filter((entry) => entry.id !== 'home' && entry.status === 'available').length;
  const title = document.createElement('p');
  title.className = 'toolswitch-title';
  const word = document.createElement('span');
  word.textContent = online === 1 ? 'Tool' : 'Tools';
  const count = document.createElement('b');
  count.textContent = online + ' online';
  title.append(word, count);
  fragment.append(title);

  for (const entry of entries) {
    const soon = entry.status !== 'available';
    const item = document.createElement(soon ? 'span' : 'a');
    item.className = 'tool-item' + (soon ? ' tool-item--soon' : '');
    item.setAttribute('role', 'menuitem');
    if (soon) item.setAttribute('aria-disabled', 'true');
    else item.href = entry.path;
    if (entry.current) item.setAttribute('aria-current', 'page');

    const text = document.createElement('span');
    text.className = 'tool-item-text';
    const name = document.createElement('strong');
    name.textContent = entry.name;
    const hint = document.createElement('em');
    hint.textContent = soon ? 'coming soon' : entry.hint;
    text.append(name, hint);

    const mark = document.createElement('span');
    mark.className = 'tool-item-mark';
    mark.textContent = soon ? 'soon' : entry.current ? 'open' : 'go';
    mark.setAttribute('aria-hidden', 'true');

    item.append(text, mark);
    fragment.append(item);
  }
  menu.replaceChildren(fragment);
  return [...menu.querySelectorAll('.tool-item')];
}

/** Ouvre/ferme le menu, clavier et clic extérieur compris. */
function initToolSwitcher() {
  const box = el('toolSwitcher');
  const trigger = el('toolSwitcherBtn');
  const menu = el('toolMenu');
  if (!box || !trigger || !menu) return;

  const entries = menuEntries();
  const current = entries.find((entry) => entry.current && entry.id !== 'home');
  const label = el('toolSwitcherName');
  if (label) label.textContent = current ? current.name : 'All tools';
  if (box.classList && box.classList.toggle) box.classList.toggle('has-current', Boolean(current));

  const items = buildMenu(menu, entries);

  const setOpen = (open) => {
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (box.classList) box.classList.toggle('is-open', open);
    if (open && items.length) items[0].focus();
  };
  const isOpen = () => trigger.getAttribute('aria-expanded') === 'true';

  // sans JavaScript, le déclencheur mène à l'accueil ; avec, il ouvre le menu
  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    setOpen(!isOpen());
  });

  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  });

  menu.addEventListener('keydown', (event) => {
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      trigger.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!items.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = (index + step + items.length) % items.length;
      items[next < 0 ? 0 : next].focus();
    }
    if (event.key === 'Tab') setOpen(false);
  });

  document.addEventListener('click', (event) => {
    if (!isOpen()) return;
    const target = event.target;
    if (box.contains && typeof box.contains === 'function' && box.contains(target)) return;
    setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) setOpen(false);
  });
}

/* ==================================================================
 * Décor commun
 * ================================================================== */

/** Fil de lecture en haut de page + ombre de l'en-tête collant. */
function initScrollLine() {
  const fill = qsa('.scroll-line-fill')[0];
  const root = document.documentElement;
  if (!fill || !root) return;
  const onScroll = () => {
    const max = root.scrollHeight - root.clientHeight;
    const top = root.scrollTop || 0;
    const ratio = max > 0 ? Math.min(1, Math.max(0, top / max)) : 0;
    fill.style.transform = 'scaleX(' + ratio.toFixed(4) + ')';
    document.body.classList.toggle('is-scrolled', top > 8);
  };
  document.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/** Apparition des sections au défilement, légèrement décalée. */
function initReveal() {
  const items = qsa('.reveal');
  if (!items.length) return;
  items.forEach((item, index) => {
    if (item.style && item.style.setProperty) item.style.setProperty('--i', String(Math.min(index, 6)));
  });
  if (typeof IntersectionObserver !== 'function') {
    items.forEach((item) => item.classList.add('in'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.05 });
  items.forEach((item) => observer.observe(item));
  // filet de sécurité : jamais de contenu resté invisible
  setTimeout(() => items.forEach((item) => item.classList.add('in')), 2500);
}

/** Halo qui suit le curseur sur les cartes (une seule frame en attente). */
function initSpotlight() {
  const cards = qsa('.card');
  if (!cards.length) return;
  if (typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches === false) return;
  let frame = 0;
  let pending = null;
  const flush = () => {
    frame = 0;
    if (!pending) return;
    const { card, x, y } = pending;
    pending = null;
    card.style.setProperty('--mx', x + 'px');
    card.style.setProperty('--my', y + 'px');
  };
  const onMove = (event) => {
    const card = event.currentTarget;
    const box = card.getBoundingClientRect();
    pending = { card, x: event.clientX - box.left, y: event.clientY - box.top };
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const onLeave = (event) => {
    event.currentTarget.style.setProperty('--mx', '50%');
    event.currentTarget.style.setProperty('--my', '0%');
  };
  for (const card of cards) {
    card.addEventListener('pointermove', onMove);
    card.addEventListener('pointerleave', onLeave);
  }
}

const fmt = new Intl.NumberFormat('en-US');
const n = (value) => fmt.format(value);

/** Compteurs qui montent jusqu'à leur valeur (accueil et page outil). */
function initCounters() {
  const items = qsa('[data-count]');
  if (!items.length || typeof IntersectionObserver !== 'function') return;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      countUp(entry.target, reduced);
    }
  }, { threshold: 0.4 });
  items.forEach((item) => observer.observe(item));
}

function countUp(node, instant) {
  const target = Number(node.getAttribute('data-count')) || 0;
  if (instant || typeof requestAnimationFrame !== 'function') {
    node.textContent = n(target);
    return;
  }
  const duration = 900;
  const start = performance.now();
  const step = (now) => {
    const ratio = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - ratio, 3);
    node.textContent = n(Math.round(target * eased));
    if (ratio < 1) requestAnimationFrame(step);
    else node.textContent = n(target);
  };
  node.textContent = '0';
  requestAnimationFrame(step);
}

/** Les blocs marqués data-typing s'écrivent caractère par caractère. */
function initTyping() {
  const blocks = qsa('[data-typing]');
  if (!blocks.length || typeof requestAnimationFrame !== 'function') return;
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  blocks.forEach((pre, index) => {
    const full = String(pre.textContent || '');
    if (!full.trim()) return;
    let written = 0;
    pre.textContent = '';
    pre.classList.add('typing');
    const tick = () => {
      written = Math.min(full.length, written + 2);
      pre.textContent = full.slice(0, written);
      if (written < full.length) setTimeout(tick, 24);
      else pre.classList.remove('typing');
    };
    setTimeout(tick, 420 + index * 140);
  });
}

/** Boutons « copier » des blocs de commandes. */
function initCopy() {
  for (const button of qsa('button[data-copy]')) {
    button.addEventListener('click', async () => {
      const card = button.closest ? button.closest('.code-card') : null;
      const code = card ? card.querySelector('pre') : null;
      const ok = await copyText(code ? code.textContent : '');
      button.textContent = ok ? 'Copied' : 'Copy failed';
      button.classList.toggle('is-ok', ok);
      setTimeout(() => {
        button.textContent = 'Copy';
        button.classList.remove('is-ok');
      }, 1600);
    });
  }
}

export async function copyText(text) {
  if (!text) return false;
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // permission refusée ou contexte non sécurisé : on passe au repli
    }
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Habillage complet d'une page (appelé au chargement du module). */
export function initChrome() {
  if (typeof document.querySelectorAll !== 'function') return; // DOM simulé : rien à décorer
  initToolSwitcher();
  initScrollLine();
  initReveal();
  initSpotlight();
  initCounters();
  initTyping();
  initCopy();
}

initChrome();
