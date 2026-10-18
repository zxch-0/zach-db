/*
 * zach-db — la préférence de mouvement.
 *
 * Par défaut c'est le système qui décide : quand il demande prefers-reduced-motion,
 * le décor se gèle (une image fixe composée, aucune boucle). Ce module ajoute une
 * bascule explicite pour le visiteur, à trois crans :
 *
 *   system  on suit le réglage du système (défaut, rien n'est stocké)
 *   live    on anime, quel que soit le réglage du système
 *   still   on gèle, même si le système autorise le mouvement
 *
 * Le choix est gardé dans localStorage, se règle d'un coup par ?motion=live|still,
 * se pose sur <html> (motion-live / motion-still) pour que le CSS suive, et se
 * publie aux modules qui animent (public/home.js, public/chrome.js) : la bascule
 * prend effet immédiatement, sans recharger la page.
 *
 * Aucune dépendance, aucun réseau. Chaque accès au stockage, à l'URL ou au média
 * est protégé : s'il manque quelque chose, on retombe sur le réglage système.
 */

export const MOTION_KEY = 'zach-db-motion';
export const MOTION_STATES = ['system', 'live', 'still'];

/** Ce que la bascule affiche, en anglais comme le reste de l'interface. */
export const MOTION_LABELS = {
  system: { short: 'system', hint: 'Motion: follow the system setting' },
  live: { short: 'live', hint: 'Motion: forced on' },
  still: { short: 'still', hint: 'Motion: forced off' },
};

const listeners = new Set();
let sessionChoice = null; // repli sans stockage : le cran vaut au moins pour l'onglet

const query = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null);

/** Ce que demande le système, sans tenir compte d'aucun choix. */
export function systemReduced() {
  const media = query();
  return Boolean(media && media.matches);
}

function readStored() {
  try {
    if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') return sessionChoice;
    const value = localStorage.getItem(MOTION_KEY);
    return MOTION_STATES.includes(value) ? value : sessionChoice;
  } catch {
    return sessionChoice; // stockage refusé (navigation privée) : le cran de l'onglet suffit
  }
}

function writeStored(choice) {
  sessionChoice = choice === 'system' ? null : choice;
  try {
    if (typeof localStorage === 'undefined') return;
    if (choice === 'system') localStorage.removeItem(MOTION_KEY);
    else localStorage.setItem(MOTION_KEY, choice);
  } catch {
    // le choix ne survivra pas au rechargement : la page reste utilisable
  }
}

function readUrl() {
  try {
    if (typeof location === 'undefined' || typeof location.search !== 'string' || !location.search) return null;
    const asked = new URLSearchParams(location.search).get('motion');
    return MOTION_STATES.includes(asked) ? asked : null;
  } catch {
    return null;
  }
}

/** Le cran en cours : l'URL gagne sur le stockage, qui gagne sur le système. */
export function readMotion() {
  const asked = readUrl() || readStored();
  return MOTION_STATES.includes(asked) ? asked : 'system';
}

/** Faut-il geler le mouvement, tout bien pesé ? */
export function motionReduced() {
  const choice = readMotion();
  if (choice === 'live') return false;
  if (choice === 'still') return true;
  return systemReduced();
}

/** Pose le cran sur <html> : le CSS gèle ou libère suivant la classe. */
export function applyMotion() {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const root = document.documentElement;
  if (!root.classList || typeof root.classList.toggle !== 'function') return;
  const choice = readMotion();
  root.classList.toggle('motion-live', choice === 'live');
  root.classList.toggle('motion-still', choice === 'still');
}

function notify() {
  const choice = readMotion();
  for (const listener of [...listeners]) {
    try {
      listener(choice);
    } catch {
      // un module en panne ne doit pas empêcher les autres de suivre
    }
  }
}

/** Change de cran : stockage, classes sur <html>, puis tout le monde est prévenu. */
export function setMotion(choice) {
  const value = MOTION_STATES.includes(choice) ? choice : 'system';
  writeStored(value);
  applyMotion();
  notify();
  return value;
}

/** Le cran suivant de la bascule : system → live → still → system. */
export function nextMotion() {
  const index = MOTION_STATES.indexOf(readMotion());
  return MOTION_STATES[(index + 1) % MOTION_STATES.length];
}

/** S'inscrit aux changements de cran, et au changement du réglage système. */
export function onMotionChange(listener) {
  if (typeof listener !== 'function') return () => false;
  listeners.add(listener);
  const media = query();
  if (media && typeof media.addEventListener === 'function') {
    media.addEventListener('change', () => {
      if (readMotion() === 'system') notify(); // le système a tranché autrement
    });
  }
  return () => listeners.delete(listener);
}

/** ?motion=… règle la bascule une bonne fois : on le garde, puis l'URL redevient propre. */
function absorbUrl() {
  const asked = readUrl();
  if (!asked) return;
  writeStored(asked);
  try {
    if (typeof history === 'undefined' || typeof history.replaceState !== 'function') return;
    if (typeof location === 'undefined' || typeof location.pathname !== 'string') return;
    const rest = new URLSearchParams(location.search);
    rest.delete('motion');
    const search = rest.toString();
    const hash = typeof location.hash === 'string' ? location.hash : '';
    history.replaceState(null, '', location.pathname + (search ? '?' + search : '') + hash);
  } catch {
    // l'URL gardera son paramètre : sans conséquence, le choix est déjà stocké
  }
}

/** La bascule d'en-tête : trois crans, un libellé qui dit toujours où on en est. */
export function initMotion() {
  absorbUrl();
  applyMotion();

  const button =
    typeof document !== 'undefined' && typeof document.getElementById === 'function'
      ? document.getElementById('motionSwitch')
      : null;
  if (!button) return; // pas de bascule sur cette page : le choix reste applicable par URL

  const value = typeof button.querySelector === 'function' ? button.querySelector('.motion-val') : null;

  const paint = () => {
    const choice = readMotion();
    const label = MOTION_LABELS[choice] || MOTION_LABELS.system;
    if (typeof button.setAttribute === 'function') {
      button.setAttribute('data-state', choice);
      button.setAttribute('title', label.hint);
      button.setAttribute('aria-label', label.hint);
    }
    if (value) value.textContent = label.short;
  };

  paint();
  if (typeof button.addEventListener === 'function') {
    button.addEventListener('click', () => setMotion(nextMotion()));
  }
  onMotionChange(paint);
}
