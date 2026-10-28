// Service worker de la extensión (se ejecuta en segundo plano).
// Recibe mensajes { type: "LOOKUP", word, sentence } de los content scripts,
// consulta el diccionario y el traductor, y devuelve un resultado unificado.

const DICTIONARY_URL = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const TRANSLATION_URL = 'https://api.mymemory.translated.net/get';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_DEFINITIONS_PER_POS = 3;
const MAX_CACHE_ENTRIES = 200;
const MAX_WORD_LENGTH = 50;
const DICTIONARY_RETRY_DELAY_MS = 600;

// Caché SOLO en memoria. Se borra sola cuando Chrome apaga el service worker
// (tras unos segundos sin uso) o al cerrar el navegador. Nada se guarda en disco.
const cache = new Map();

// Contracciones irregulares que no se resuelven quitando el final.
const IRREGULAR_CONTRACTIONS = {
  "won't": 'will',
  "can't": 'can',
  "shan't": 'shall',
  "ain't": 'be'
};

// Terminaciones de contracciones y posesivos ("don't" → "do", "John's" → "john").
const CONTRACTION_SUFFIXES = ["n't", "'re", "'ve", "'ll", "'d", "'m", "'s"];

// Traducciones fijas de palabras muy comunes. MyMemory traduce mal las
// palabras sueltas cortas ("it" → "it", "made" → "."), así que estas se
// resuelven aquí sin llamar a la API (y de paso se ahorra cuota).
const COMMON_WORD_TRANSLATIONS = {
  i: 'yo',
  you: 'tú / usted / ustedes',
  he: 'él',
  she: 'ella',
  it: 'eso / lo / la (pronombre)',
  we: 'nosotros / nosotras',
  they: 'ellos / ellas',
  me: 'me / mí',
  him: 'lo / le / él',
  her: 'la / le / ella / su (de ella)',
  us: 'nos / nosotros',
  them: 'los / las / les / ellos',
  my: 'mi / mis',
  your: 'tu / su (de usted)',
  his: 'su (de él)',
  its: 'su (de eso)',
  our: 'nuestro / nuestra',
  their: 'su (de ellos)',
  a: 'un / una',
  an: 'un / una',
  the: 'el / la / los / las',
  and: 'y',
  or: 'o',
  but: 'pero',
  to: 'a / para / hacia',
  of: 'de',
  in: 'en / dentro de',
  on: 'en / sobre',
  at: 'en / a',
  for: 'para / por',
  with: 'con',
  from: 'de / desde',
  by: 'por / junto a',
  is: 'es / está',
  are: 'son / están / eres / estás',
  was: 'era / estaba / fue',
  were: 'eran / estaban / fueron',
  be: 'ser / estar',
  am: 'soy / estoy',
  been: 'sido / estado',
  do: 'hacer (también auxiliar)',
  does: 'hace (también auxiliar)',
  did: 'hizo / hice (también auxiliar)',
  have: 'tener / haber',
  has: 'tiene / ha',
  had: 'tenía / había / tuvo',
  will: 'auxiliar de futuro / voluntad',
  would: 'auxiliar de condicional (-ría)',
  can: 'poder / lata',
  could: 'podría / pudo',
  should: 'debería',
  must: 'deber / tener que',
  not: 'no',
  this: 'este / esta / esto',
  that: 'ese / esa / eso / que',
  these: 'estos / estas',
  those: 'esos / esas',
  here: 'aquí',
  there: 'allí / ahí',
  so: 'así / entonces / tan',
  if: 'si',
  yes: 'sí',
  no: 'no'
};

// Error con un código, para distinguir "no encontrado" de otros fallos.
class LookupError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Peticiones HTTP
// ---------------------------------------------------------------------------

// Hace un GET y devuelve { status, data }. Si tarda más de 8 s, se cancela.
// El timeout cubre también la lectura del cuerpo de la respuesta.
async function fetchJson(url) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const data = response.ok ? await response.json() : null;
    return { status: response.status, data };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new LookupError('El servidor tardó demasiado en responder.', 'TIMEOUT');
    }
    throw new LookupError('No se pudo conectar. Revisa tu conexión a internet.', 'NETWORK');
  } finally {
    clearTimeout(timerId);
  }
}

// ---------------------------------------------------------------------------
// Normalización de palabras
// ---------------------------------------------------------------------------

// Deja la palabra lista para buscar: minúsculas, sin puntuación ni comillas
// alrededor, sin posesivos y con las contracciones reducidas a su palabra base.
function normalizeWord(raw) {
  let word = String(raw).toLowerCase().trim();

  // Unificar apóstrofos tipográficos (’ ‘ ` ´) en el apóstrofo normal
  word = word.replace(/[‘’ʼ`´]/g, "'");

  // Quitar todo lo que no sea letra o número al principio y al final
  // (comillas, puntos, comas, signos de interrogación, etc.)
  word = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

  if (IRREGULAR_CONTRACTIONS[word]) return IRREGULAR_CONTRACTIONS[word];

  for (const suffix of CONTRACTION_SUFFIXES) {
    if (word.endsWith(suffix) && word.length > suffix.length) {
      word = word.slice(0, -suffix.length);
      break;
    }
  }

  // Quitar cualquier símbolo restante, conservando guiones internos
  return word.replace(/[^\p{L}\p{N}-]/gu, '');
}

// ¿Termina en consonante doble? ("stopp" de "stopped", "runn" de "running")
function hasDoubledConsonant(stem) {
  return stem.length >= 3 && /([b-df-hj-np-tv-z])\1$/.test(stem);
}

// Lista de posibles formas base para probar cuando el diccionario no
// encuentra la palabra. Son reglas simples, no un analizador gramatical.
function getBaseFormCandidates(word) {
  const candidates = [];
  const add = (candidate) => {
    if (candidate.length >= 2 && candidate !== word && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  if (word.endsWith('ies')) add(word.slice(0, -3) + 'y');            // studies → study
  if (word.endsWith('s') && !word.endsWith('ss')) add(word.slice(0, -1)); // cats → cat
  if (word.endsWith('es')) add(word.slice(0, -2));                   // watches → watch

  if (word.endsWith('ied')) add(word.slice(0, -3) + 'y');            // studied → study
  if (word.endsWith('ed')) {
    const stem = word.slice(0, -2);
    add(stem);                                                       // walked → walk
    add(word.slice(0, -1));                                          // loved → love
    if (hasDoubledConsonant(stem)) add(stem.slice(0, -1));           // stopped → stop
  }

  if (word.endsWith('ing')) {
    const stem = word.slice(0, -3);
    add(stem);                                                       // playing → play
    add(stem + 'e');                                                 // making → make
    if (hasDoubledConsonant(stem)) add(stem.slice(0, -1));           // running → run
  }

  if (word.endsWith('ily')) add(word.slice(0, -3) + 'y');            // happily → happy
  if (word.endsWith('ly')) add(word.slice(0, -2));                   // quickly → quick

  return candidates;
}

// ---------------------------------------------------------------------------
// Diccionario (Free Dictionary API)
// ---------------------------------------------------------------------------

// Busca la palabra y, si da 404, prueba sus formas base una por una.
async function fetchDefinition(word) {
  const attempts = [word, ...getBaseFormCandidates(word)];

  for (const candidate of attempts) {
    const url = DICTIONARY_URL + encodeURIComponent(candidate);
    let { status, data } = await fetchJson(url);

    // Los errores 5xx de esta API suelen ser pasajeros: se reintenta una vez
    if (status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, DICTIONARY_RETRY_DELAY_MS));
      ({ status, data } = await fetchJson(url));
    }

    if (status === 404) continue;
    if (status !== 200 || !Array.isArray(data)) {
      throw new LookupError(`El diccionario no está disponible ahora (error ${status}).`, 'HTTP');
    }
    return parseDictionaryEntries(candidate, data);
  }

  throw new LookupError(`No se encontró la definición de "${word}".`, 'NOT_FOUND');
}

// Convierte la respuesta del diccionario a nuestro formato. La API puede
// devolver varias entradas; se juntan por categoría gramatical.
function parseDictionaryEntries(baseWord, entries) {
  const allPhonetics = entries.flatMap((entry) => entry.phonetics || []);
  const phonetic =
    entries.find((entry) => entry.phonetic)?.phonetic ||
    allPhonetics.find((item) => item.text)?.text ||
    null;
  const audioUrl = allPhonetics.find((item) => item.audio)?.audio || null;

  const definitionsByPos = new Map();
  for (const entry of entries) {
    for (const meaning of entry.meanings || []) {
      const partOfSpeech = meaning.partOfSpeech || 'other';
      if (!definitionsByPos.has(partOfSpeech)) definitionsByPos.set(partOfSpeech, []);
      const definitions = definitionsByPos.get(partOfSpeech);

      for (const item of meaning.definitions || []) {
        // Máximo 3 definiciones por categoría gramatical
        if (definitions.length >= MAX_DEFINITIONS_PER_POS) break;
        if (item.definition) {
          definitions.push({ definition: item.definition, example: item.example || null });
        }
      }
    }
  }

  const meanings = [...definitionsByPos].map(([partOfSpeech, definitions]) => ({
    partOfSpeech,
    definitions
  }));

  return { baseWord, phonetic, audioUrl, meanings };
}

// ---------------------------------------------------------------------------
// Traducción (MyMemory)
// ---------------------------------------------------------------------------

// Limpia una traducción: quita espacios y puntuación final ("agradecida." → "agradecida").
// Devuelve '' si no tiene ni una letra (p. ej. ".").
function cleanTranslation(text) {
  const clean = String(text || '').trim().replace(/[.!?。]+$/u, '').trim();
  return /\p{L}/u.test(clean) ? clean : '';
}

// MyMemory devuelve una traducción principal y una lista "matches" con
// alternativas. Se elige, por orden de preferencia:
//   1. la primera traducción útil que sea DISTINTA de la palabra en inglés,
//   2. si no hay, una igual (palabras que se escriben igual: "hotel", "radio").
function pickBestTranslation(data, word) {
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const candidates = [data.responseData?.translatedText, ...matches.map((m) => m.translation)]
    .map(cleanTranslation)
    .filter((text) => text && !/MYMEMORY WARNING/i.test(text));

  const different = candidates.find((text) => text.toLowerCase() !== word.toLowerCase());
  return different || candidates[0] || null;
}

async function fetchTranslation(word) {
  if (COMMON_WORD_TRANSLATIONS[word]) return COMMON_WORD_TRANSLATIONS[word];

  const params = new URLSearchParams({ q: word, langpair: 'en|es' });
  const { status, data } = await fetchJson(`${TRANSLATION_URL}?${params}`);

  const quotaMessage =
    'Se agotó el límite diario gratuito de traducciones de MyMemory. Inténtalo de nuevo mañana.';
  if (status === 429) throw new LookupError(quotaMessage, 'QUOTA');
  if (status !== 200 || !data) {
    throw new LookupError(`El traductor no está disponible ahora (error ${status}).`, 'HTTP');
  }

  const translatedText = data.responseData?.translatedText || '';

  // Cuando se acaba la cuota, MyMemory a veces responde 200 pero mete el
  // aviso "MYMEMORY WARNING" dentro del texto "traducido".
  const quotaExceeded =
    data.quotaFinished === true ||
    Number(data.responseStatus) === 429 ||
    /MYMEMORY WARNING/i.test(translatedText) ||
    /MYMEMORY WARNING/i.test(String(data.responseDetails || ''));
  if (quotaExceeded) throw new LookupError(quotaMessage, 'QUOTA');

  if (Number(data.responseStatus) !== 200) {
    throw new LookupError('No se pudo obtener la traducción.', 'HTTP');
  }

  const translation = pickBestTranslation(data, word);
  if (!translation) {
    throw new LookupError('No hay una traducción disponible para esta palabra.', 'NO_TRANSLATION');
  }
  return translation;
}

// ---------------------------------------------------------------------------
// Caché en memoria (máximo 200 entradas)
// ---------------------------------------------------------------------------

// Un Map recuerda el orden de inserción: la primera clave es la más antigua.
// Al leer una entrada, se mueve al final para que sea la última en borrarse.
function getFromCache(key) {
  if (!cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function saveToCache(key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

// ---------------------------------------------------------------------------
// Búsqueda principal
// ---------------------------------------------------------------------------

function buildEmptyResult(word) {
  return {
    word,
    baseWord: null,
    phonetic: null,
    audioUrl: null,
    translation: null,
    meanings: [],
    // Mensaje legible y código de cada error (NOT_FOUND, NETWORK, TIMEOUT,
    // QUOTA, HTTP, NO_TRANSLATION, INVALID, UNEXPECTED) para que el modal
    // pueda elegir qué mostrar.
    errors: { dictionary: null, translation: null },
    errorCodes: { dictionary: null, translation: null }
  };
}

// Devuelve un resultado vacío con el mismo error en ambas partes
function buildFailedResult(message, code) {
  const result = buildEmptyResult(null);
  result.errors.dictionary = result.errors.translation = message;
  result.errorCodes.dictionary = result.errorCodes.translation = code;
  return result;
}

// Busca una palabra en ambas APIs a la vez. Nunca lanza errores: si algo
// falla, lo indica en result.errors y devuelve lo que sí se haya obtenido.
async function lookupWord(rawWord) {
  if (typeof rawWord !== 'string' || rawWord.length > MAX_WORD_LENGTH) {
    return buildFailedResult('Palabra no válida.', 'INVALID');
  }

  const word = normalizeWord(rawWord);
  if (!word) return buildFailedResult('Palabra no válida.', 'INVALID');

  const cached = getFromCache(word);
  if (cached) return cached;

  // En paralelo: si una API falla, la otra igual devuelve su parte
  const [dictionaryOutcome, translationOutcome] = await Promise.allSettled([
    fetchDefinition(word),
    fetchTranslation(word)
  ]);

  const result = buildEmptyResult(word);

  if (dictionaryOutcome.status === 'fulfilled') {
    Object.assign(result, dictionaryOutcome.value);
  } else {
    result.errors.dictionary = dictionaryOutcome.reason.message;
    result.errorCodes.dictionary = dictionaryOutcome.reason.code || 'UNEXPECTED';
  }

  if (translationOutcome.status === 'fulfilled') {
    result.translation = translationOutcome.value;
  } else {
    result.errors.translation = translationOutcome.reason.message;
    result.errorCodes.translation = translationOutcome.reason.code || 'UNEXPECTED';
  }

  // Solo se guarda en caché si no hubo fallos temporales (red, timeout,
  // cuota), para poder reintentar más tarde. "No encontrada" sí se guarda.
  const dictionaryIsFinal =
    dictionaryOutcome.status === 'fulfilled' || dictionaryOutcome.reason.code === 'NOT_FOUND';
  if (dictionaryIsFinal && translationOutcome.status === 'fulfilled') {
    saveToCache(word, result);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Mensajes desde los content scripts
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'LOOKUP') return false;

  // message.sentence se recibe pero aún no se usa (queda para dar contexto más adelante)
  lookupWord(message.word)
    .then(sendResponse)
    .catch((error) => {
      sendResponse(buildFailedResult(`Error inesperado: ${error.message}`, 'UNEXPECTED'));
    });

  // true = "responderé más tarde". Sin esto, Chrome cierra el canal antes
  // de que lleguen las respuestas de las APIs.
  return true;
});

console.log('[Lua] Service worker cargado');
