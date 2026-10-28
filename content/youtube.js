// Content script específico de YouTube.
// Usa las funciones de common.js para hacer clicables los subtítulos.

// Selectores de YouTube. Si YouTube cambia su HTML, normalmente solo hay
// que actualizar estas líneas.
const YT_PLAYER_SELECTOR = '#movie_player';
const YT_CAPTION_CONTAINER_SELECTOR = '.ytp-caption-window-container';
const YT_CAPTION_WINDOW_SELECTOR = '.caption-window';
const YT_CAPTION_SEGMENT_SELECTOR = '.ytp-caption-segment';

// Cada cuánto se comprueba si el reproductor se ha recreado
const YT_CHECK_INTERVAL_MS = 1000;

const youtubeCaptionObserver = createCaptionObserver(YT_CAPTION_SEGMENT_SELECTOR);

// Frase completa: todo el texto de la ventana de subtítulos donde está la
// palabra (puede tener varias líneas), con los espacios normalizados.
function getYoutubeSentence(span) {
  const captionWindow = span.closest(YT_CAPTION_WINDOW_SELECTOR);
  const segments = captionWindow
    ? [...captionWindow.querySelectorAll(YT_CAPTION_SEGMENT_SELECTOR)]
    : [span.closest(YT_CAPTION_SEGMENT_SELECTOR) || span];
  return segments
    .map((segment) => segment.textContent)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// El <video> del mismo reproductor que contiene la palabra
function getYoutubeVideo(span) {
  const player = span?.closest('.html5-video-player') || document.querySelector(YT_PLAYER_SELECTOR);
  return player?.querySelector('video') || null;
}

// Busca el contenedor de subtítulos del reproductor principal y empieza a
// vigilarlo. Si es el mismo de antes, no hace nada.
function attachToYoutubePlayer() {
  const container = document.querySelector(
    `${YT_PLAYER_SELECTOR} ${YT_CAPTION_CONTAINER_SELECTOR}`
  );
  if (container) youtubeCaptionObserver.attach(container);
}

// YouTube es una SPA: al pasar de un video a otro no se recarga la página y
// el reproductor puede recrearse. Se reengancha al terminar cada navegación…
document.addEventListener('yt-navigate-finish', attachToYoutubePlayer);

// …y, por seguridad, cada segundo (por si el reproductor o el contenedor de
// subtítulos aparecen más tarde, p. ej. al entrar desde la portada).
setInterval(attachToYoutubePlayer, YT_CHECK_INTERVAL_MS);

attachToYoutubePlayer();
setupWordClicks({ getVideo: getYoutubeVideo, getSentence: getYoutubeSentence });

console.log('[Lua] youtube.js cargado');
