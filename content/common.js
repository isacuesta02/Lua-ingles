// Código compartido por los content scripts de YouTube y Netflix.
// Se carga ANTES que youtube.js / netflix.js, así que lo que se defina aquí
// estará disponible en ellos. Aquí irán: convertir palabras en elementos
// clicables, el modal (dentro de un Shadow DOM) y pausar/reanudar el video.

console.log('[Lua] common.js cargado');
