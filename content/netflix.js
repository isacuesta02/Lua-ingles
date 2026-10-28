// Content script específico de Netflix.
// Usa las funciones de common.js para hacer clicables los subtítulos.

// Selectores de Netflix. Si Netflix cambia su HTML, normalmente solo hay que
// actualizar estas líneas.
const NF_CAPTION_SELECTOR = '.player-timedtext';
const NF_WATCH_PATH_PREFIX = '/watch';

// Cada cuánto se comprueba si cambió la URL (Netflix no recarga la página)
const NF_CHECK_INTERVAL_MS = 1000;

// Netflix borra y vuelve a crear .player-timedtext muy a menudo. En vez de
// perseguir ese contenedor, se vigila todo document.body y, en cada cambio,
// se envuelven las palabras de cualquier .player-timedtext que exista.
const netflixCaptionObserver = createCaptionObserver(NF_CAPTION_SELECTOR);

function isNetflixWatchPage() {
  return location.pathname.startsWith(NF_WATCH_PATH_PREFIX);
}

// Frase completa del subtítulo. innerText convierte los <br> entre líneas en
// saltos de línea (textContent pegaría las líneas sin espacio).
function getNetflixSentence(span) {
  const container = span.closest(NF_CAPTION_SELECTOR) || span.parentElement;
  return container.innerText.replace(/\s+/g, ' ').trim();
}

// En /watch solo hay un <video>. Solo se usará pause() y play(): nunca
// currentTime, porque Netflix lo detecta y muestra un error.
function getNetflixVideo() {
  return document.querySelector('video');
}

// Netflix pone capas invisibles encima del video que se quedan con los clics.
// Por eso se busca la palabra "debajo" del puntero, pero solo en /watch.
function findNetflixWordAt(x, y) {
  return isNetflixWatchPage() ? findWordSpanAtPoint(x, y) : null;
}

// Activa la extensión en /watch/... y la desactiva en el resto (/browse, etc.)
function updateNetflixState() {
  if (isNetflixWatchPage()) {
    netflixCaptionObserver.attach(document.body);
  } else {
    netflixCaptionObserver.detach();
  }
}

// Netflix es una SPA: la URL cambia sin recargar la página. Se comprueba al
// usar Atrás/Adelante (popstate) y, por seguridad, cada segundo.
window.addEventListener('popstate', updateNetflixState);
setInterval(updateNetflixState, NF_CHECK_INTERVAL_MS);

updateNetflixState();
setupWordClicks({
  getVideo: getNetflixVideo,
  getSentence: getNetflixSentence,
  findWordAt: findNetflixWordAt
});

console.log('[Lua] netflix.js cargado');
