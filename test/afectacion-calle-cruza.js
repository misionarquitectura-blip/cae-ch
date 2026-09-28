// ─────────────────────────────────────────────────────────────────────────────
//  Calles que atraviesan el predio.
//
//  Hay lotes que el catastro dibuja de un solo cuerpo aunque una calle los
//  parta: las dos lineas de fabrica de esa calle cruzan el lote de lado a lado,
//  con los dos extremos fuera. Antes esos tramos se descartaban (solo se leian
//  los que tenian un extremo dentro o a <= 2 m del borde) y el DICAT decia
//  "sin afectacion" aunque el mapa mostrara el trazado sobre el lote.
//
//  Caso de referencia: 060101004007064003 (14 127,72 m2), cruzado de norte a
//  sur por una calle de ~10 m. Contraste por malla de 0,1 m: 706,07 m2.
//
//  Ejecutar:  node test/afectacion-calle-cruza.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const H = require('./lib/harness');

console.log('CALLES QUE ATRAVIESAN EL PREDIO\n');

const capas = H.stubLineasFabrica();
capas[7] = H.stubVialidad();
const api = H.cargarGeovisor(capas);
const catastro = H.leerGeoJSON('DATA SET/Catastro GADMR.geojson');
const feat = f => ({ type: 'Feature', properties: f.properties, geometry: f.geometry });

// ── Caso reportado ──────────────────────────────────────────────────────────
const r = api.calcularAfectacionPredio(feat(H.buscarPredio(catastro, '060101004007064003')));
H.chequear('resuelto por linea de fabrica', r.metodo === 'lf', r.metodo);
H.chequear('detecta una calle que cruza', r.callesQueCruzan.length === 1, JSON.stringify(r.callesQueCruzan));
H.casiIgual('ancho entre las dos LF', r.callesQueCruzan[0], 10.1, 0.3, 'm');
H.casiIgual('area de la calle vs malla 0,1 m', r.total, 706.07, 0.5, 'm2');
H.casiIgual('area util + afectada = predio', r.total + r.edificable, 14127.72, 0.05, 'm2');

// ── El lote al otro lado de la calle sigue siendo predio ────────────────────
// Antes se descartaba como "franja" todo lo que quedaba mas alla de la
// primera LF: 551,69 m2 en un lote donde la calle ocupa ~317 m2.
const o = api.calcularAfectacionPredio(feat(H.buscarPredio(catastro, '060157001001003001')));
H.chequear('la parte al otro lado de la calle no se cuenta', o.callesQueCruzan.length === 1 && o.total < 400, String(o.total));

// ── Lote angosto con retiros en frente y fondo: NO es una calle ─────────────
const u = api.calcularAfectacionPredio(feat(H.buscarPredio(catastro, '060104007003003002')));
H.chequear('el caso de estacion total no ve calles que cruzan', u.callesQueCruzan.length === 0, JSON.stringify(u.callesQueCruzan));
H.casiIgual('afectacion del caso de estacion total sin cambios', u.total, 1426.27, 0.01, 'm2');

H.resumen('CALLES QUE CRUZAN');
