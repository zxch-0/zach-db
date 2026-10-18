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
import { findToolByPath, normalizePath } from './lib/tools.js';

const el = (id) => (typeof document.getElementById === 'function' ? document.getElementById(id) : null);

const qsa = (selector, root = document) =>
  (typeof root.querySelectorAll === 'function' ? [...root.querySelectorAll(selector)] : []);

const currentPath = () =>
  (typeof location !== 'undefined' && location.pathname ? location.pathname : '/');

/* ==================================================================
 * Sélecteur d'outil
 * ==================================================================
 *
 * C'est la seule porte vers les outils depuis l'accueil : un <details> dont le
 * menu est écrit dans le HTML (donc ouvert même sans JavaScript), recopié du
 * registre public/lib/tools.js — test/tools.test.js vérifie que les deux
 * disent la même chose. Le code ici n'ajoute que le confort : l'outil courant
 * est nommé et marqué, Échap et le clic extérieur referment, les flèches
 * parcourent le menu.
 */

/** Ferme le menu au clic extérieur et au clavier, et marque l'outil courant. */
function initToolSwitcher() {
  const box = el('toolSwitcher');
  const trigger = el('toolSwitcherBtn');
  const menu = el('toolMenu');
  if (!box || !trigger || !menu) return;

  const active = findToolByPath(normalizePath(currentPath()));
  const label = el('toolSwitcherName');
  if (label) label.textContent = active ? active.short : 'All tools';
  if (box.classList && box.classList.toggle) box.classList.toggle('has-current', Boolean(active));

  const items = qsa('.tool-item', menu);
  for (const item of items) {
    const href = (typeof item.getAttribute === 'function' && item.getAttribute('href')) || '';
    const isActive = active ? normalizePath(href) === normalizePath(active.path) : href === '/';
    if (isActive) item.setAttribute('aria-current', 'page');
    else if (typeof item.removeAttribute === 'function') item.removeAttribute('aria-current');
  }

  const isOpen = () => Boolean(box.open);
  const close = () => {
    box.open = false;
  };

  if (typeof box.addEventListener === 'function') {
    box.addEventListener('toggle', () => {
      trigger.setAttribute('aria-expanded', isOpen() ? 'true' : 'false');
    });
  }

  trigger.addEventListener('keydown', (event) => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length) {
      event.preventDefault();
      box.open = true;
      items[event.key === 'ArrowDown' ? 0 : items.length - 1].focus();
    }
  });

  menu.addEventListener('keydown', (event) => {
    const index = typeof document.activeElement !== 'undefined' ? items.indexOf(document.activeElement) : -1;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      trigger.focus();
      return;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = (index + step + items.length) % items.length;
      items[next].focus();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1].focus();
    }
  });

  if (typeof document.addEventListener === 'function') {
    document.addEventListener('click', (event) => {
      if (!isOpen()) return;
      const target = event.target;
      if (typeof box.contains === 'function' && box.contains(target)) return;
      close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen()) close();
    });
  }
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
