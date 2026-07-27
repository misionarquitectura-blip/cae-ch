// ─────────────────────────────────────────────────────────────────────────────
//  Regresion sobre una muestra amplia del catastro.
//
//  Verifica que el calculo de superficie reproduce la geometria GIS del GADMR
//  (Shape__Area) y que la afectacion vial se mantiene estable y acotada en
//  predios de toda la ciudad, no solo en el caso de referencia.
//
//  Ejecutar:  node test/regresion-catastro.js [paso]
//     paso = 1 de cada N predios (por defecto 350 → ~210 predios, ~1 min)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const H = require('./lib/harness');

const PASO = parseInt(process.argv[2] || '350', 10);
console.log(`REGRESION CATASTRAL — 1 de cada ${PASO} predios\n`);

const api = H.cargarGeovisor(H.stubLineasFabrica());
const catastro = H.leerGeoJSON('DATA SET/Catastro GADMR.geojson');

let n = 0, errores = 0, conAfect = 0, sumMs = 0, maxMs = 0;
let areaExacta = 0, areaDesviada = 0;
const desviados = [], excedidos = [], lentos = [];

for (let i = 0; i < catastro.features.length; i += PASO) {
    const f = catastro.features[i];
    if (!f.geometry || f.geometry.type !== 'Polygon') continue;
    const ring = H.anillo(f);
    if (ring.length < 3) continue;

    // Medicion sobre la geometria completa: el catastro trae predios multiparte
    // codificados como Polygon con varios anillos.
    const medida = api.medirGeometria(f.geometry);
    const area = parseFloat(medida.area);

    // Contraste con la superficie GIS oficial (NO con sup_pred_c, que es la
    // superficie declarada en escritura y difiere legitimamente).
    const shape = parseFloat(f.properties.Shape__Area || 0);
    if (shape > 1) {
        const dif = Math.abs(area - shape);
        const errPct = dif / shape * 100;
        // Tolerancia relativa (0.01 %) o absoluta (0.05 m2): en predios muy
        // pequenos el redondeo a 2 decimales domina el error relativo.
        if (errPct < 0.01 || dif <= 0.05) areaExacta++;
        else { areaDesviada++; desviados.push(`${f.properties.claves} ${area.toFixed(2)} vs ${shape.toFixed(2)} (${errPct.toFixed(3)}%)`); }
    }

    const t0 = Date.now();
    let r;
    try {
        r = api.calcularFranjasAfectacion({ type: 'Feature', properties: f.properties, geometry: f.geometry });
    } catch (e) {
        errores++;
        console.log(`  ✗ EXCEPCION en ${f.properties.claves}: ${e.message}`);
        continue;
    }
    const ms = Date.now() - t0;
    sumMs += ms; maxMs = Math.max(maxMs, ms); n++;
    if (ms > 400) lentos.push(`${f.properties.claves} ${ms}ms`);

    if (r && r.total > 0.1) {
        conAfect++;
        // La afectacion se calcula sobre el poligono principal, asi que la
        // coherencia se comprueba contra el area de ese anillo, no contra la
        // superficie total de un predio multiparte.
        const areaExterior = parseFloat(api.calculatePolygonArea(ring.map(c => ({ lat: c[1], lng: c[0] }))));
        // Ninguna franja de retiro deberia comerse el predio entero.
        if (r.total >= areaExterior) excedidos.push(`${f.properties.claves} afect ${r.total} >= area ${areaExterior.toFixed(2)}`);
        // Coherencia interna
        if (Math.abs((r.total + r.edificable) - areaExterior) > 1) {
            excedidos.push(`${f.properties.claves} descuadre: ${r.total}+${r.edificable} != ${areaExterior.toFixed(2)}`);
        }
    }
}

console.log(`Predios evaluados: ${n}`);
console.log(`Con afectacion detectada: ${conAfect} (${(100 * conAfect / n).toFixed(1)}%)`);
console.log(`Tiempo medio: ${(sumMs / n).toFixed(1)} ms | maximo: ${maxMs} ms\n`);

H.chequear('sin excepciones', errores === 0, `${errores} predios fallaron`);
H.chequear(`superficie coincide con Shape__Area en todos (exactos ${areaExacta}, desviados ${areaDesviada})`,
    areaDesviada === 0, desviados.slice(0, 5).join(' | '));
H.chequear('ninguna afectacion iguala o supera el area del predio',
    excedidos.length === 0, excedidos.slice(0, 5).join(' | '));
H.chequear('rendimiento aceptable (medio < 150 ms)', (sumMs / n) < 150, `${(sumMs / n).toFixed(1)} ms`);
H.chequear('ningun predio excede 400 ms', lentos.length === 0, lentos.slice(0, 5).join(' | '));

H.resumen('REGRESION');
