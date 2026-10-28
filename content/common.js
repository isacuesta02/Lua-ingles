// Código compartido por los content scripts de YouTube y Netflix.
// Se carga ANTES que youtube.js / netflix.js (ver manifest.json), así que las
// funciones definidas aquí están disponibles en esos archivos.

const WORD_CLASS = 'swt-word';
const WORD_HOVER_CLASS = 'swt-word-hover';
const POINTER_CURSOR_CLASS = 'swt-pointer-cursor';

// Una "palabra": letras/números, con apóstrofos o guiones internos opcionales
// (don't, John's, well-known). La puntuación de alrededor queda fuera del span.
const WORD_REGEX = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

// Tiempo durante el que un clic "huérfano" se asocia a la última palabra pulsada.
const PRESS_MEMORY_MS = 600;

// Número de la última búsqueda: si llegan respuestas viejas, se ignoran.
let lookupCounter = 0;

// ---------------------------------------------------------------------------
// Envolver palabras en <span class="swt-word">
// ---------------------------------------------------------------------------

// Sustituye un nodo de texto por: texto + <span>palabra</span> + texto...
// Los espacios y saltos de línea quedan como texto normal, sin cambios.
function wrapTextNode(textNode) {
  const text = textNode.nodeValue;
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;

  for (const match of text.matchAll(WORD_REGEX)) {
    if (match.index > lastIndex) fragment.append(text.slice(lastIndex, match.index));
    const span = document.createElement('span');
    span.className = WORD_CLASS;
    span.textContent = match[0];
    fragment.append(span);
    lastIndex = match.index + match[0].length;
  }

  // Sin palabras (solo espacios o puntuación): no se toca nada
  if (lastIndex === 0) return;
  if (lastIndex < text.length) fragment.append(text.slice(lastIndex));
  textNode.replaceWith(fragment);
}

// Envuelve todas las palabras dentro de "root" que aún no estén envueltas.
// Se puede llamar muchas veces sobre lo mismo: nunca duplica spans.
function wrapWordsIn(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('.' + WORD_CLASS)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
  });

  // Primero se recogen los nodos y luego se modifican, para no alterar el
  // recorrido mientras se está haciendo.
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  textNodes.forEach(wrapTextNode);
}

// ---------------------------------------------------------------------------
// Vigilar los subtítulos con MutationObserver
// ---------------------------------------------------------------------------

// Crea un vigilante que, cada vez que cambian los subtítulos, envuelve las
// palabras nuevas. Se usa con attach(contenedor).
function createCaptionObserver(segmentSelector) {
  let observer = null;
  let currentContainer = null;

  const processContainer = (container) => {
    container.querySelectorAll(segmentSelector).forEach(wrapWordsIn);
  };

  return {
    // Empieza a vigilar "container". Si ya era el mismo, no hace nada.
    attach(container) {
      if (container === currentContainer) return;
      observer?.disconnect();
      currentContainer = container;

      // El callback se ejecuta justo después del cambio y ANTES de que el
      // navegador pinte la pantalla, así que nunca se ve el texto sin envolver
      // (sin parpadeos).
      observer = new MutationObserver((records, activeObserver) => {
        processContainer(container);
        // Descartar los cambios que acabamos de hacer nosotros mismos
        activeObserver.takeRecords();
      });

      processContainer(container);
      observer.observe(container, { childList: true, subtree: true, characterData: true });
      console.log('[Lua] Vigilando subtítulos en', container);
    },

    // Deja de vigilar (p. ej. al salir de la página del video)
    detach() {
      if (!observer) return;
      observer.disconnect();
      observer = null;
      currentContainer = null;
      console.log('[Lua] Vigilancia de subtítulos detenida');
    },

    get container() {
      return currentContainer;
    }
  };
}

// ---------------------------------------------------------------------------
// Clics en las palabras
// ---------------------------------------------------------------------------

// Busca una palabra nuestra en un punto de la pantalla, aunque haya capas
// encima (elementsFromPoint devuelve TODOS los elementos en ese punto, no solo
// el de arriba). Sirve en sitios como Netflix, donde una capa invisible tapa
// los subtítulos.
function findWordSpanAtPoint(x, y) {
  return document.elementsFromPoint(x, y).find((el) => el.classList.contains(WORD_CLASS)) || null;
}

// La palabra sobre la que ocurrió el evento: primero se mira el elemento
// pulsado y, si el sitio lo permite (site.findWordAt), lo que hay debajo.
function getWordSpan(event, site) {
  // Los clics dentro del modal nunca son clics en palabras (aunque haya una
  // palabra justo debajo del modal)
  if (isEventFromWordModal(event)) return null;
  const direct = event.target instanceof Element ? event.target.closest('.' + WORD_CLASS) : null;
  if (direct) return direct;
  return site.findWordAt ? site.findWordAt(event.clientX, event.clientY) : null;
}

// Hover "a mano" para cuando una capa tapa los subtítulos y el :hover de CSS
// no llega a las palabras. Se comprueba como mucho una vez por fotograma.
function setupHoverHitTest(site) {
  let hoveredSpan = null;
  let lastEvent = null;
  let frameId = 0;

  window.addEventListener('pointermove', (event) => {
    // composedPath() solo funciona durante el evento: se calcula ya
    lastEvent = { clientX: event.clientX, clientY: event.clientY, insideModal: isEventFromWordModal(event) };
    if (frameId) return;
    frameId = requestAnimationFrame(() => {
      frameId = 0;
      const span = lastEvent.insideModal ? null : site.findWordAt(lastEvent.clientX, lastEvent.clientY);
      if (span === hoveredSpan) return;
      hoveredSpan?.classList.remove(WORD_HOVER_CLASS);
      span?.classList.add(WORD_HOVER_CLASS);
      // Cursor de mano en toda la página mientras se está sobre una palabra
      document.documentElement.classList.toggle(POINTER_CURSOR_CLASS, Boolean(span));
      hoveredSpan = span;
    });
  }, { capture: true, passive: true });
}

// Engancha los clics en las palabras. "site" indica cómo obtener, en cada
// sitio, el video y la frase completa:
//   site.getVideo(span)      → elemento <video> (span puede ser null)
//   site.getSentence(span)   → texto completo del subtítulo
//   site.findWordAt(x, y)    → (opcional) palabra en ese punto aunque esté tapada
function setupWordClicks(site) {
  if (site.findWordAt) setupHoverHitTest(site);

  // Palabra pulsada que todavía espera su "click". Si el subtítulo se
  // redibuja entre pulsar y soltar, el click ya no llega al span; así no se
  // pierde. Se olvida en cuanto se usa o se pulsa en otro sitio.
  let pendingPress = null;
  // Momento de la última pulsación en una palabra (para bloquear su
  // "soltar" y un posible doble clic)
  let lastWordPressTime = 0;

  const isRecent = (time) => Date.now() - time < PRESS_MEMORY_MS;

  // Impide que YouTube/Netflix reciban el evento (pausar, arrastrar el
  // subtítulo, pantalla completa con doble clic, etc.)
  const swallow = (event) => {
    event.stopPropagation();
    event.preventDefault();
  };

  // Se escucha en "window" en fase de captura (true): así nuestro código
  // va antes que cualquier manejador del reproductor.
  for (const type of ['pointerdown', 'mousedown']) {
    window.addEventListener(type, (event) => {
      const span = getWordSpan(event, site);
      if (!span) {
        // Pulsación fuera de las palabras: empieza otro gesto
        if (type === 'pointerdown') pendingPress = null;
        return;
      }
      swallow(event);
      lastWordPressTime = Date.now();
      pendingPress = {
        word: span.textContent,
        sentence: site.getSentence(span),
        rect: span.getBoundingClientRect(),
        time: lastWordPressTime
      };
    }, true);
  }

  for (const type of ['pointerup', 'mouseup', 'dblclick']) {
    window.addEventListener(type, (event) => {
      if (isEventFromWordModal(event)) return;
      if (getWordSpan(event, site) || isRecent(lastWordPressTime)) swallow(event);
    }, true);
  }

  window.addEventListener('click', (event) => {
    if (isEventFromWordModal(event)) return;
    const span = getWordSpan(event, site);
    const press = pendingPress && isRecent(pendingPress.time) ? pendingPress : null;
    pendingPress = null;
    if (!span && !press) return;
    swallow(event);

    handleWordClick({
      word: span ? span.textContent : press.word,
      sentence: span ? site.getSentence(span) : press.sentence,
      video: site.getVideo(span),
      anchorSpan: span,
      anchorRect: span ? span.getBoundingClientRect() : press.rect
    });
  }, true);
}

// Pausa el video, abre el modal en "cargando" y pide la información de la
// palabra al service worker.
async function handleWordClick({ word, sentence, video, anchorSpan, anchorRect }) {
  // Solo se usa pause(): nunca se toca currentTime (Netflix lo detecta)
  const pausedNow = Boolean(video && !video.paused);
  if (video) video.pause();
  openWordModal({ word, sentence, video, pausedNow, anchorSpan, anchorRect });

  // Si se hacen varios clics seguidos, solo cuenta la respuesta del último
  const requestId = ++lookupCounter;

  try {
    const result = await chrome.runtime.sendMessage({ type: 'LOOKUP', word, sentence });
    if (requestId !== lookupCounter) return;
    showWordModalResult(result);
  } catch (error) {
    // Pasa sobre todo si se recargó la extensión sin recargar la página
    if (requestId !== lookupCounter) return;
    console.warn('[Lua] No se pudo contactar con la extensión:', error.message);
    showWordModalError('extension');
  }
}

console.log('[Lua] common.js cargado');
