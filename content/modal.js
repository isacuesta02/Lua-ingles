// Mini modal con la información de una palabra.
// Vive dentro de un Shadow DOM para que los estilos de YouTube/Netflix no lo
// afecten (y para que los nuestros no afecten a la página).
// Todo el texto se inserta con textContent (nunca innerHTML), así el texto que
// llega de las APIs no puede inyectar código en la página.

const MODAL_HOST_TAG = 'lua-word-modal';
const MODAL_MARGIN = 8;          // distancia mínima a los bordes de la pantalla
const MODAL_GAP = 10;            // separación entre la palabra y el modal
const MODAL_MIN_HEIGHT = 160;    // altura mínima aunque haya poco espacio
const COPY_FEEDBACK_MS = 1500;
const OUTSIDE_CLICK_MEMORY_MS = 600;
const AUDIO_TIMEOUT_MS = 2500;   // si la grabación no empieza en este tiempo, se usa la voz de Chrome

// Eventos que no deben salir del modal hacia el reproductor (por ejemplo, la
// barra espaciadora en un botón pausaría el video en YouTube).
const MODAL_CONTAINED_EVENTS = [
  'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
  'keydown', 'keyup', 'keypress', 'wheel', 'contextmenu', 'touchstart', 'touchend'
];

const PART_OF_SPEECH_LABELS = {
  noun: 'sustantivo',
  verb: 'verbo',
  adjective: 'adjetivo',
  adverb: 'adverbio',
  pronoun: 'pronombre',
  preposition: 'preposición',
  conjunction: 'conjunción',
  interjection: 'interjección',
  determiner: 'determinante',
  article: 'artículo',
  numeral: 'numeral'
};

// Mensajes de error amigables cuando no llega nada que mostrar
const MODAL_ERRORS = {
  notFound: {
    title: 'Palabra no encontrada',
    text: 'No encontramos esta palabra en el diccionario. Puede ser un nombre propio o una palabra muy coloquial.'
  },
  offline: {
    title: 'Sin conexión',
    text: 'No pudimos contactar con el diccionario ni con el traductor. Revisa tu conexión a internet e inténtalo de nuevo.'
  },
  quota: {
    title: 'Límite de traducciones alcanzado',
    text: 'Se agotó el límite diario gratuito de traducciones. Inténtalo de nuevo mañana.'
  },
  extension: {
    title: 'La extensión se actualizó',
    text: 'Recarga la página (F5) para seguir usándola.'
  },
  generic: {
    title: 'Algo salió mal',
    text: 'No pudimos obtener la información de esta palabra. Inténtalo de nuevo en un momento.'
  }
};

// Estado del modal (solo en memoria)
const modalState = {
  host: null,
  shadow: null,
  dialog: null,
  isOpen: false,
  listenersReady: false,
  word: '',
  sentence: '',
  anchorSpan: null,
  anchorRect: null,
  video: null,
  pausedByUs: false,
  previousFocus: null,
  outsideClickUntil: 0,
  // Si el servidor de audios del diccionario falla una vez, no se vuelve a
  // intentar en esta pestaña (solo en memoria) y se usa directamente la voz
  audioServerFailed: false
};

const MODAL_CSS = `
  * { box-sizing: border-box; }

  .dialog {
    --accent: #a594ff;
    --text: #f2f2f4;
    --muted: #b4b4c0;
    position: absolute;
    top: 0;
    left: 0;
    width: min(360px, calc(100% - 16px));
    max-height: calc(100% - 16px);
    display: flex;
    flex-direction: column;
    pointer-events: auto;
    background: rgba(22, 22, 26, 0.97);
    color: var(--text);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    text-align: left;
    overflow: hidden;
    outline: none;
    -webkit-font-smoothing: antialiased;
  }
  .dialog:focus-visible { box-shadow: 0 0 0 2px var(--accent), 0 12px 32px rgba(0, 0, 0, 0.55); }

  .header { display: flex; align-items: flex-start; gap: 10px; padding: 14px 16px 8px; }
  .title-wrap { flex: 1; min-width: 0; }
  .word { margin: 0; font-size: 20px; font-weight: 700; line-height: 1.2; overflow-wrap: anywhere; }
  .phonetic { margin-top: 2px; color: var(--muted); font-size: 13px; }
  .base-form { margin-top: 2px; color: var(--muted); font-size: 12px; }

  .translation {
    margin: 0 16px 10px;
    padding: 8px 12px;
    background: rgba(165, 148, 255, 0.16);
    border-left: 3px solid var(--accent);
    border-radius: 8px;
  }
  .translation-label {
    font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; color: #cfc6ff;
  }
  .translation-text { font-size: 18px; font-weight: 600; color: #fff; overflow-wrap: anywhere; }

  .notice {
    margin: 0 16px 10px; padding: 8px 10px; border-radius: 6px;
    background: rgba(255, 190, 70, 0.12); color: #ffd27a; font-size: 12.5px;
  }

  .body {
    flex: 1 1 auto; min-height: 0; overflow-y: auto;
    padding: 0 16px 10px; overscroll-behavior: contain;
  }
  .meaning + .meaning { margin-top: 12px; }
  .pos {
    font-size: 11px; font-weight: 600; letter-spacing: 0.05em;
    text-transform: uppercase; color: var(--accent);
  }
  .definitions { margin: 4px 0 0; padding-left: 20px; }
  .definitions li { margin: 4px 0; }
  .example { display: block; margin-top: 2px; font-style: italic; color: var(--muted); }

  .error { margin: 2px 16px 14px; }
  .error-title { font-size: 15px; font-weight: 600; }
  .error-text { margin-top: 4px; color: #c8c8d0; }

  .footer {
    display: flex; align-items: center; justify-content: flex-end; gap: 8px;
    padding: 10px 16px 14px; border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  .status { flex: 1; font-size: 12px; color: var(--muted); }

  button { font: inherit; color: inherit; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button:disabled { opacity: 0.45; cursor: default; }
  .button {
    padding: 6px 14px; border-radius: 8px; font-size: 13px; font-weight: 600;
    border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.08);
  }
  .button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.16); }
  .button.primary { background: var(--accent); border-color: transparent; color: #16161a; }
  .button.primary:hover:not(:disabled) { background: #b9abff; }
  .icon-button {
    flex-shrink: 0; display: grid; place-items: center; width: 34px; height: 34px;
    border: none; border-radius: 50%; background: rgba(255, 255, 255, 0.08);
  }
  .icon-button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.18); }

  .skeleton {
    height: 12px; border-radius: 6px;
    background: linear-gradient(90deg, rgba(255,255,255,0.07) 25%, rgba(255,255,255,0.16) 50%, rgba(255,255,255,0.07) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.2s linear infinite;
  }
  .skeleton + .skeleton { margin-top: 8px; }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { .skeleton { animation: none; } }

  .visually-hidden {
    position: absolute; width: 1px; height: 1px; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap;
  }
`;

// ---------------------------------------------------------------------------
// Utilidades para crear elementos
// ---------------------------------------------------------------------------

// createEl('p', { class: 'x', text: 'hola', onclick: fn }, [hijos])
function createEl(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'text') el.textContent = value;
    else if (key === 'style') el.style.cssText = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.filter(Boolean));
  return el;
}

// Icono de altavoz (SVG) para el botón de audio
function createSpeakerIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor',
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
  })) svg.setAttribute(key, value);
  for (const d of ['M11 5 6 9H2v6h4l5 4V5z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M19 5a10 10 0 0 1 0 14']) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

// ---------------------------------------------------------------------------
// Host del Shadow DOM y pantalla completa
// ---------------------------------------------------------------------------

function ensureModalHost() {
  if (modalState.host) return;

  // Un elemento propio (<lua-word-modal>) para que el CSS de la página no lo
  // seleccione por accidente. Ocupa toda la pantalla pero deja pasar los
  // clics (pointer-events: none); solo el cuadro del modal los recibe.
  const host = document.createElement(MODAL_HOST_TAG);
  host.style.cssText =
    'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';

  // "closed": los scripts de la página no pueden leer el contenido del modal
  const shadow = host.attachShadow({ mode: 'closed' });
  const dialog = createEl('div', {
    class: 'dialog',
    role: 'dialog',
    tabindex: '-1',
    'aria-labelledby': 'swt-title'
  });
  // Hoja de estilos "construida" en vez de <style>: no la bloquean las
  // políticas de seguridad (CSP) estrictas de algunas páginas.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(MODAL_CSS);
  shadow.adoptedStyleSheets = [sheet];
  shadow.append(dialog);

  // Lo que pasa dentro del modal se queda en el modal
  for (const type of MODAL_CONTAINED_EVENTS) {
    host.addEventListener(type, (event) => event.stopPropagation(), { passive: true });
  }

  Object.assign(modalState, { host, shadow, dialog });
}

// En pantalla completa solo se ve lo que está DENTRO del elemento en pantalla
// completa, así que el modal tiene que ir ahí. Si no, va en <body>.
function getModalContainer() {
  const fullscreenElement = document.fullscreenElement;
  if (fullscreenElement && !(fullscreenElement instanceof HTMLVideoElement)) {
    return fullscreenElement;
  }
  return document.body || document.documentElement;
}

function mountModalHost() {
  const container = getModalContainer();
  if (modalState.host.parentNode !== container) container.append(modalState.host);
}

// ¿El evento ocurrió dentro del modal? (lo usa common.js para ignorarlo)
function isEventFromWordModal(event) {
  return Boolean(modalState.host && event.composedPath().includes(modalState.host));
}

// ---------------------------------------------------------------------------
// Posición: cerca de la palabra y sin salirse de la pantalla
// ---------------------------------------------------------------------------

function getAnchorRect() {
  const { anchorSpan, anchorRect } = modalState;
  if (anchorSpan?.isConnected) {
    const rect = anchorSpan.getBoundingClientRect();
    if (rect.width || rect.height) return rect;
  }
  return anchorRect;
}

function positionModal() {
  if (!modalState.isOpen) return;
  const { host, dialog } = modalState;

  // Se mide respecto al host (que ocupa toda la pantalla): así funciona igual
  // dentro y fuera de pantalla completa.
  const area = host.getBoundingClientRect();
  const anchor = getAnchorRect() || {
    top: area.top + area.height / 2, bottom: area.top + area.height / 2,
    left: area.left + area.width / 2, width: 0
  };
  const anchorTop = anchor.top - area.top;
  const anchorBottom = anchor.bottom - area.top;
  const anchorCenter = anchor.left - area.left + anchor.width / 2;

  const spaceAbove = anchorTop - MODAL_GAP - MODAL_MARGIN;
  const spaceBelow = area.height - anchorBottom - MODAL_GAP - MODAL_MARGIN;
  const maxScreenHeight = area.height - 2 * MODAL_MARGIN;

  // Altura "natural" del contenido, y luego se decide si va arriba o abajo
  // (los subtítulos suelen estar abajo, así que normalmente irá arriba).
  dialog.style.maxHeight = `${maxScreenHeight}px`;
  const naturalHeight = dialog.offsetHeight;
  const placeAbove = spaceAbove >= naturalHeight || spaceAbove >= spaceBelow;
  const available = Math.max(placeAbove ? spaceAbove : spaceBelow, MODAL_MIN_HEIGHT);
  dialog.style.maxHeight = `${Math.min(available, maxScreenHeight)}px`;

  const width = dialog.offsetWidth;
  const height = dialog.offsetHeight;
  const left = clamp(anchorCenter - width / 2, MODAL_MARGIN, area.width - width - MODAL_MARGIN);
  const top = clamp(
    placeAbove ? anchorTop - MODAL_GAP - height : anchorBottom + MODAL_GAP,
    MODAL_MARGIN,
    area.height - height - MODAL_MARGIN
  );
  dialog.style.left = `${left}px`;
  dialog.style.top = `${top}px`;
}

// ---------------------------------------------------------------------------
// Listeners globales (se registran la primera vez que se abre el modal, para
// que vayan DESPUÉS de los de common.js y vean si el clic fue en una palabra)
// ---------------------------------------------------------------------------

function ensureModalListeners() {
  if (modalState.listenersReady) return;
  modalState.listenersReady = true;

  window.addEventListener('keydown', (event) => {
    if (!modalState.isOpen || event.key !== 'Escape') return;
    event.stopPropagation();
    event.preventDefault();
    closeWordModal();
  }, true);

  window.addEventListener('pointerdown', handleOutsidePointerDown, true);

  // Si el clic de fuera cayó sobre el video, se "consume" entero para que el
  // reproductor no lo interprete como pausar/reanudar.
  for (const type of ['mousedown', 'pointerup', 'mouseup', 'click', 'dblclick']) {
    window.addEventListener(type, (event) => {
      if (Date.now() < modalState.outsideClickUntil && !isEventFromWordModal(event)) {
        event.stopPropagation();
        event.preventDefault();
      }
    }, true);
  }

  document.addEventListener('fullscreenchange', handleFullscreenChange);
  window.addEventListener('resize', positionModal);
}

function handleOutsidePointerDown(event) {
  // defaultPrevented = common.js ya lo trató como clic en otra palabra: el
  // modal se queda abierto y mostrará la nueva palabra.
  if (!modalState.isOpen || isEventFromWordModal(event) || event.defaultPrevented) return;

  const video = modalState.video;
  closeWordModal();

  const rect = video?.getBoundingClientRect();
  const insideVideo = rect &&
    event.clientX >= rect.left && event.clientX <= rect.right &&
    event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (insideVideo) {
    event.stopPropagation();
    event.preventDefault();
    modalState.outsideClickUntil = Date.now() + OUTSIDE_CLICK_MEMORY_MS;
  }
}

// Al entrar o salir de pantalla completa, el modal se mueve al contenedor
// correcto (aunque la consulta todavía esté cargando).
function handleFullscreenChange() {
  if (!modalState.isOpen) return;
  mountModalHost();
  // Mover un elemento le quita el foco: se devuelve. Se espera un fotograma
  // para que el navegador termine de recolocar la página antes de medir.
  requestAnimationFrame(() => {
    positionModal();
    modalState.dialog.focus({ preventScroll: true });
  });
}

// ---------------------------------------------------------------------------
// Abrir / cerrar
// ---------------------------------------------------------------------------

// Abre el modal en estado "cargando".
//   pausedNow: true si el video estaba reproduciéndose y lo acabamos de pausar
function openWordModal({ word, sentence, video, pausedNow, anchorSpan, anchorRect }) {
  ensureModalHost();
  ensureModalListeners();

  if (modalState.isOpen) {
    // Clic en otra palabra con el modal abierto: si el primer clic pausó el
    // video, se sigue recordando para reanudarlo al cerrar.
    modalState.pausedByUs = modalState.pausedByUs || pausedNow;
  } else {
    modalState.pausedByUs = pausedNow;
    modalState.previousFocus = document.activeElement;
  }

  Object.assign(modalState, { isOpen: true, word, sentence, video, anchorSpan, anchorRect });
  mountModalHost();
  renderLoading();
  modalState.dialog.focus({ preventScroll: true });
}

function closeWordModal() {
  if (!modalState.isOpen) return;
  modalState.isOpen = false;
  modalState.host.remove();

  // Reanudar SOLO si nosotros pausamos el video (y sigue pausado). Solo se
  // usa play(): nunca se toca currentTime.
  const { video, pausedByUs, previousFocus } = modalState;
  if (pausedByUs && video?.isConnected && video.paused) {
    video.play().catch(() => {});
  }

  if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') {
    previousFocus.focus({ preventScroll: true });
  }
  Object.assign(modalState, {
    video: null, pausedByUs: false, previousFocus: null, anchorSpan: null, anchorRect: null
  });
}

// Muestra la respuesta del service worker (resultado completo, parcial o error)
function showWordModalResult(result) {
  if (!modalState.isOpen) return;
  const hasContent = Boolean(result?.translation || result?.meanings?.length);
  if (hasContent) renderResult(result);
  else renderError(getErrorKind(result));
}

// Muestra un error sin resultado (p. ej. 'extension' si no responde el service worker)
function showWordModalError(kind) {
  if (!modalState.isOpen) return;
  renderError(kind);
}

function getErrorKind(result) {
  const codes = Object.values(result?.errorCodes || {});
  if (codes.includes('NETWORK') || codes.includes('TIMEOUT')) return 'offline';
  if (result?.errorCodes?.dictionary === 'NOT_FOUND' || codes.includes('INVALID')) return 'notFound';
  if (codes.includes('QUOTA')) return 'quota';
  return 'generic';
}

// ---------------------------------------------------------------------------
// Contenido de cada estado
// ---------------------------------------------------------------------------

function renderDialog(children, { busy = false } = {}) {
  const { dialog } = modalState;
  dialog.setAttribute('aria-busy', String(busy));
  dialog.replaceChildren(...children.filter(Boolean));
  positionModal();
}

function createHeader(title, details = [], extra = null) {
  return createEl('div', { class: 'header' }, [
    createEl('div', { class: 'title-wrap' }, [
      createEl('h2', { class: 'word', id: 'swt-title', text: title }),
      ...details
    ]),
    extra
  ]);
}

function createFooter(buttons) {
  const status = createEl('span', { class: 'status', role: 'status', 'aria-live': 'polite' });
  return { footer: createEl('div', { class: 'footer' }, [status, ...buttons]), status };
}

function createCloseButton() {
  return createEl('button', {
    class: 'button', type: 'button', text: 'Cerrar',
    'aria-label': 'Cerrar y reanudar el video', onclick: closeWordModal
  });
}

function renderLoading() {
  const { footer } = createFooter([createCloseButton()]);
  renderDialog([
    createHeader(modalState.word, [
      createEl('div', { class: 'skeleton', style: 'width: 90px; margin-top: 8px;' })
    ]),
    createEl('div', { class: 'translation' }, [
      createEl('div', { class: 'skeleton', style: 'width: 60%; height: 16px;' })
    ]),
    createEl('div', { class: 'body' }, [
      createEl('span', { class: 'visually-hidden', role: 'status', text: 'Cargando…' }),
      createEl('div', { class: 'skeleton', style: 'width: 35%;' }),
      createEl('div', { class: 'skeleton', style: 'width: 100%;' }),
      createEl('div', { class: 'skeleton', style: 'width: 85%;' })
    ]),
    footer
  ], { busy: true });
}

function renderError(kind) {
  const message = MODAL_ERRORS[kind] || MODAL_ERRORS.generic;
  const { footer } = createFooter([createCloseButton()]);
  renderDialog([
    createHeader(modalState.word),
    createEl('div', { class: 'error', role: 'alert' }, [
      createEl('div', { class: 'error-title', text: message.title }),
      createEl('div', { class: 'error-text', text: message.text })
    ]),
    footer
  ]);
}

function renderResult(result) {
  const title = result.word || modalState.word;
  const details = [
    result.phonetic && createEl('div', { class: 'phonetic', text: result.phonetic }),
    result.baseWord && result.baseWord !== result.word &&
      createEl('div', { class: 'base-form', text: `Forma base: ${result.baseWord}` })
  ].filter(Boolean);

  // El botón aparece siempre: si no hay grabación, se usa la voz de Chrome
  const audioButton = createEl('button', {
    class: 'icon-button', type: 'button',
    'aria-label': `Escuchar la pronunciación de ${title}`,
    title: 'Escuchar pronunciación',
    onclick: (event) => playPronunciation(result.audioUrl, title, event.currentTarget)
  }, [createSpeakerIcon()]);

  // Traducción destacada, o aviso si esa parte falló
  const translationBlock = result.translation
    ? createEl('div', { class: 'translation' }, [
      createEl('div', { class: 'translation-label', text: 'Español' }),
      createEl('div', { class: 'translation-text', text: result.translation })
    ])
    : createEl('div', { class: 'notice', text: result.errors?.translation || 'Traducción no disponible.' });

  const dictionaryNotice = !result.meanings?.length &&
    createEl('div', { class: 'notice', text: result.errors?.dictionary || 'Definición no disponible.' });

  const meaningBlocks = (result.meanings || []).map((meaning) => {
    const label = PART_OF_SPEECH_LABELS[meaning.partOfSpeech];
    return createEl('section', { class: 'meaning' }, [
      createEl('div', {
        class: 'pos',
        text: label ? `${meaning.partOfSpeech} · ${label}` : meaning.partOfSpeech
      }),
      createEl('ol', { class: 'definitions' }, meaning.definitions.map((item) =>
        createEl('li', {}, [
          createEl('span', { text: item.definition }),
          item.example && createEl('span', { class: 'example', text: `“${item.example}”` })
        ])
      ))
    ]);
  });

  const copyButton = createEl('button', {
    class: 'button primary', type: 'button', text: 'Copiar',
    'aria-label': 'Copiar un resumen de la palabra al portapapeles'
  });
  const { footer, status } = createFooter([copyButton, createCloseButton()]);
  copyButton.addEventListener('click', () => handleCopy(result, copyButton, status));

  renderDialog([
    createHeader(title, details, audioButton),
    translationBlock,
    dictionaryNotice,
    meaningBlocks.length > 0 && createEl('div', { class: 'body' }, meaningBlocks),
    footer
  ]);
}

// ---------------------------------------------------------------------------
// Audio y copiar
// ---------------------------------------------------------------------------

// Intenta reproducir la grabación del diccionario. Si falla (o tarda
// demasiado), pronuncia la palabra con la voz integrada de Chrome.
async function playPronunciation(audioUrl, word, button) {
  if (audioUrl && !modalState.audioServerFailed) {
    const played = await playRecording(audioUrl);
    if (played) return;
    modalState.audioServerFailed = true;
  }
  if (!speakWord(word)) {
    button.disabled = true;
    button.title = 'Audio no disponible en este navegador';
    button.setAttribute('aria-label', 'Audio no disponible');
  }
}

// Devuelve true si la grabación empezó a sonar
async function playRecording(audioUrl) {
  const audio = new Audio(audioUrl.startsWith('//') ? `https:${audioUrl}` : audioUrl);
  let timerId;
  const timeout = new Promise((resolve) => {
    timerId = setTimeout(() => resolve(false), AUDIO_TIMEOUT_MS);
  });
  const played = await Promise.race([audio.play().then(() => true, () => false), timeout]);
  clearTimeout(timerId);
  if (!played) {
    // Cancelar la descarga para que no suene más tarde por sorpresa
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  return played;
}

// Pronuncia la palabra con la síntesis de voz de Chrome (no usa internet)
function speakWord(word) {
  if (!('speechSynthesis' in window) || !word) return false;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = 'en-US';
  utterance.rate = 0.9;
  const voices = speechSynthesis.getVoices();
  const voice = voices.find((v) => v.lang === 'en-US') || voices.find((v) => v.lang.startsWith('en'));
  if (voice) utterance.voice = voice;
  speechSynthesis.speak(utterance);
  return true;
}

// Texto que se copia al portapapeles
function buildSummary(result, sentence) {
  const title = result.word || modalState.word;
  const lines = [result.phonetic ? `${title}  ${result.phonetic}` : title];
  if (result.translation) lines.push(`Traducción: ${result.translation}`);

  for (const meaning of result.meanings || []) {
    const label = PART_OF_SPEECH_LABELS[meaning.partOfSpeech];
    lines.push('', label ? `${meaning.partOfSpeech} (${label})` : meaning.partOfSpeech);
    meaning.definitions.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.definition}`);
      if (item.example) lines.push(`   Ej.: "${item.example}"`);
    });
  }

  if (sentence) lines.push('', `Frase: "${sentence}"`);
  return lines.join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Plan B para páginas que bloquean la API del portapapeles
    const textarea = createEl('textarea', { style: 'position: fixed; opacity: 0;' });
    textarea.value = text;
    modalState.shadow.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
}

async function handleCopy(result, button, status) {
  const copied = await copyText(buildSummary(result, modalState.sentence));
  button.textContent = copied ? '¡Copiado!' : 'Error';
  status.textContent = copied ? 'Resumen copiado al portapapeles' : 'No se pudo copiar';
  setTimeout(() => {
    button.textContent = 'Copiar';
    status.textContent = '';
  }, COPY_FEEDBACK_MS);
}

console.log('[Lua] modal.js cargado');
