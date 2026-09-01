// ─────────────────────────────────────────────────────────────────────────────
//  Coherencia interna del DICAT: linderos (seccion 3) y cotas (seccion 8)
//  contra la tabla de vertices UTM (seccion 6) y el CSV/DXF.
//
//  Es la prueba de que el reporte no se contradice a si mismo: todo lo que el
//  DICAT declara en metros tiene que salir del mismo plano UTM WGS84 17S.
//  Primero contra un predio de referencia, despues sobre una muestra amplia
//  del catastro: la logica debe cumplirse en TODOS los predios consultados.
//
//  Ejecutar:  node test/linderos-dicat.js [paso]
//     paso = 1 de cada N predios en el barrido (por defecto 350)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');
const patron = require('./fixtures/linderos-060101004001061001.json');

console.log('LINDEROS Y COTAS DEL DICAT — patron: predio ' + patron.clave + '\n');

const api = H.cargarGeovisor({});
const catastro = H.leerGeoJSON('DATA SET/Catastro GADMR.geojson');
const feats = catastro.features;

// Reproduce el volcado de calcularColindantes: acumula por (orientacion,
// colindante) para que un predio de cientos de lados no genere cientos de filas.
function armarLinderos(lados) {
    const acum = {};
    const anotar = (dir, nombre, m) => {
        const k = dir + '|' + nombre;
        if (!acum[k]) acum[k] = { dir, nombre, m: 0 };
        acum[k].m += m;
    };
    for (const l of lados) {
        l.vecinos.forEach(v => {
            const len = api.lindLongitudIntervalos(v.tramos, l.L);
            if (len >= 0.3) anotar(l.dir, v.nombre, len);
        });
        const libre = l.L - api.lindLongitudIntervalos(l.cubierto, l.L);
        if (libre >= 1) anotar(l.dir, '(lado libre / via)', libre);
    }
    return Object.values(acum);
}

// ── Predio de referencia ─────────────────────────────────────────────────────
const feat = H.buscarPredio(catastro, patron.clave);
if (!feat) { console.error('No se encontro el predio en el catastro.'); process.exit(1); }
const predio = { type: 'Feature', properties: feat.properties, geometry: feat.geometry };

console.log('Lados del predio (seccion 3) frente a la tabla de vertices (seccion 6)');
const lados = api.lindLadosPredio(predio);
H.chequear(`numero de lados = ${patron.lados.length}`, lados.length === patron.lados.length,
    `obtenido ${lados.length}`);

patron.lados.forEach((esp, i) => {
    const l = lados[i];
    if (!l) return;
    // 1 mm: por encima de eso volvio a colarse una longitud geodesica o un redondeo
    H.casiIgual(`lado ${i + 1} (${esp.orientacion})`, l.L, esp.longitudM, 0.001, 'm');
    H.chequear(`lado ${i + 1} orienta al ${esp.orientacion}`, l.dir === esp.orientacion,
        `obtenido ${l.dir}`);
});

H.casiIgual('suma de los lados = perimetro medido',
    lados.reduce((s, l) => s + l.L, 0), patron.perimetroM, 0.01, 'm');

console.log('\nTramos compartidos con los predios vecinos');
for (const g of feats) {
    const p = g.properties || {};
    if (String(p.claves || '').startsWith(patron.clave)) continue;
    const nombre = (p.gis_predio || '').trim() || (p.nombre_c || '').trim() || 'Sin identificar';
    try { api.lindMarcarVecino(lados, g.geometry, nombre); } catch (e) { }
}

const filas = armarLinderos(lados);
for (const esp of patron.linderos) {
    const fila = filas.find(x => x.dir === esp.orientacion && x.nombre === esp.nombre);
    H.chequear(`${esp.orientacion}: ${esp.nombre}`, !!fila, 'no aparece en esa orientacion');
    if (fila) H.casiIgual(`${esp.orientacion}: dimension`, fila.m, esp.dimensionM, 0.01, 'm');
}

// El bug que motivo esta prueba: el ancho del bounding box se declaraba como
// dimension del lindero a via (15.95 / 19.71 m en un predio cuyos lados miden
// 12.87 y 13.56 m), y el lindero compartido salia de una resta de perimetros
// que se descuadraba (10.84 m en un lado de 17.66 m).
console.log('\nGuardias anti-regresion');
patron.regresionConocida.dimensionesErroneasM.forEach(mal => {
    H.chequear(`ninguna dimension vale ${mal} m (metodo antiguo)`,
        filas.every(f => Math.abs(f.m - mal) > 0.05));
});
H.chequear('toda dimension declarada corresponde a un lado real del predio',
    filas.every(f => lados.some(l => f.m <= l.L + 0.01)));

// ── Cotas del plano (seccion 8) ──────────────────────────────────────────────
// crearPlanoVectorialPredio necesita canvas, asi que aqui se vigila la fuente:
// las cotas deben salir del plano UTM y no de turf.distance (esfera de 6371 km,
// hasta 5 mm/m de desviacion frente a la proyeccion oficial).
console.log('\nCotas del plano vectorial (seccion 8)');
const src = fs.readFileSync(path.join(H.RAIZ, 'geovisor.html'), 'utf8');
const ini = src.indexOf('function crearPlanoVectorialPredio(');
const fin = src.indexOf('async function createShapesVisualizationForPDF', ini);
const plano = src.slice(ini, fin > ini ? fin : ini + 20000);
H.chequear('las cotas se miden sobre el anillo en UTM', /ringUTM\s*=\s*ring\.map\(afUTM\)/.test(plano));
H.chequear('las cotas NO invocan turf.distance', !/turf\.distance\s*\(/.test(plano));

// ── Barrido: la misma logica en todos los predios ────────────────────────────
const PASO = parseInt(process.argv[2] || '350', 10);
console.log(`\nBarrido del catastro — 1 de cada ${PASO} predios`);

// bbox lat/lng de cada feature, una sola vez: es el prefiltro que en el visor
// hace lyr.getBounds() antes de medir contra los lados del predio.
const bbox = new Array(feats.length);
for (let i = 0; i < feats.length; i++) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
    for (const r of api.lindAnillosExteriores(feats[i].geometry))
        for (const c of r) { n++; if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; }
    bbox[i] = n ? [x0, y0, x1, y1] : null;
}
const HOL = 0.0006; // ~66 m, la misma holgura que usa calcularColindantes

let n = 0, errores = 0, sinLados = 0, sumMs = 0, maxMs = 0, maxFilas = 0, maxLados = 0;
const malDim = [], malDir = [], malPerim = [], lentos = [];

for (let i = 0; i < feats.length; i += PASO) {
    if (!bbox[i]) continue;
    const f = feats[i], p = f.properties || {};
    const clave = String(p.claves || '').trim();
    const t0 = Date.now();
    let ls;
    try {
        ls = api.lindLadosPredio({ type: 'Feature', properties: p, geometry: f.geometry });
        if (!ls.length) { sinLados++; continue; }
        const bb = bbox[i];
        for (let j = 0; j < feats.length; j++) {
            const b = bbox[j];
            if (!b || j === i) continue;
            if (b[0] > bb[2] + HOL || b[2] < bb[0] - HOL || b[1] > bb[3] + HOL || b[3] < bb[1] - HOL) continue;
            const p2 = feats[j].properties || {};
            if (clave && String(p2.claves || '').trim() === clave) continue;
            api.lindMarcarVecino(ls, feats[j].geometry, (p2.gis_predio || p2.nombre_c || 'Sin identificar').trim());
        }
    } catch (e) {
        errores++;
        console.log(`  ✗ EXCEPCION en ${clave}: ${e.message}`);
        continue;
    }
    const ms = Date.now() - t0;
    sumMs += ms; if (ms > maxMs) maxMs = ms; n++;
    if (ms > 400) lentos.push(`${clave} ${ms}ms`);
    if (ls.length > maxLados) maxLados = ls.length;

    const fs2 = armarLinderos(ls);
    if (fs2.length > maxFilas) maxFilas = fs2.length;

    // Toda dimension declarada tiene que caber en algun lado real del predio.
    const mayor = ls.reduce((m, l) => Math.max(m, l.L), 0);
    for (const fila of fs2) {
        if (!isFinite(fila.m) || fila.m <= 0) malDim.push(`${clave}: ${fila.m}`);
        if (!['Norte', 'Sur', 'Este', 'Oeste'].includes(fila.dir)) malDir.push(`${clave}: ${fila.dir}`);
    }
    // Un lindero acumulado no puede superar el perimetro del propio predio.
    const per = ls.reduce((s, l) => s + l.L, 0);
    for (const fila of fs2) if (fila.m > per + 0.05) malDim.push(`${clave}: lindero ${fila.m.toFixed(2)} > perimetro ${per.toFixed(2)}`);
    if (mayor > per + 0.01) malPerim.push(`${clave}: lado ${mayor.toFixed(2)} > perimetro ${per.toFixed(2)}`);
    const medida = api.medirGeometria(f.geometry);
    const perOficial = medida ? parseFloat(medida.perimetro) : null;
    if (perOficial && per > perOficial + 0.05) malPerim.push(`${clave}: lados ${per.toFixed(2)} > medirGeometria ${perOficial}`);
}

console.log(`  predios evaluados: ${n} (sin lados utilizables: ${sinLados})`);
console.log(`  maximo de lados: ${maxLados} | maximo de filas en la seccion 3: ${maxFilas}`);
console.log(`  tiempo medio ${(sumMs / Math.max(n, 1)).toFixed(1)} ms | maximo ${maxMs} ms\n`);

H.chequear('sin excepciones en el barrido', errores === 0, `${errores} predios fallaron`);
H.chequear('toda dimension es finita, positiva y cabe en el perimetro',
    malDim.length === 0, malDim.slice(0, 5).join(' | '));
H.chequear('toda orientacion es Norte/Sur/Este/Oeste', malDir.length === 0, malDir.slice(0, 5).join(' | '));
H.chequear('el perimetro de los lados nunca supera al de medirGeometria',
    malPerim.length === 0, malPerim.slice(0, 5).join(' | '));
// Sin agrupar por (orientacion, colindante) un predio rural de 357 lados
// generaria 357 renglones y varias paginas de tabla.
H.chequear(`la seccion 3 se mantiene acotada (max ${maxFilas} filas <= 60)`, maxFilas <= 60);
H.chequear('rendimiento aceptable (medio < 150 ms)', (sumMs / Math.max(n, 1)) < 150, `${(sumMs / Math.max(n, 1)).toFixed(1)} ms`);
H.chequear('ningun predio excede 400 ms', lentos.length === 0, lentos.slice(0, 5).join(' | '));

H.resumen('LINDEROS Y COTAS');
