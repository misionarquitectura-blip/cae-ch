// ─────────────────────────────────────────────────────────────────────────────
//  Exactitud geometrica contra el levantamiento con estacion total.
//
//  Es la prueba que protege el requisito no negociable: las coordenadas y el
//  area del predio en consulta deben coincidir con el levantamiento topografico.
//
//  Ejecutar:  node test/exactitud-predio.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const path = require('path');
const H = require('./lib/harness');
const patron = require('./fixtures/predio-060104007003003002.json');

console.log('EXACTITUD GEOMETRICA — patron: estacion total, predio ' + patron.clave + '\n');

const api = H.cargarGeovisor(H.stubLineasFabrica());
const catastro = H.leerGeoJSON('DATA SET/Catastro GADMR.geojson');
const feat = H.buscarPredio(catastro, patron.clave);
if (!feat) { console.error('No se encontro el predio en el catastro.'); process.exit(1); }

const ring = H.anillo(feat);
const puntos = ring.map(c => ({ lat: c[1], lng: c[0] }));
const area = parseFloat(api.calculatePolygonArea(puntos));
const perim = parseFloat(api.calculatePolygonPerimeter(puntos));

console.log('Superficie y perimetro');
H.chequear(`numero de vertices = ${patron.numeroVertices}`, ring.length === patron.numeroVertices, `obtenido ${ring.length}`);
// 0.01 m2 sobre 35 972 m2 = 3 partes por millon
H.casiIgual('superficie medida', area, patron.superficieMedidaM2, 0.01, 'm2');
H.casiIgual('perimetro medido', perim, patron.perimetroM, 0.01, 'm');

// Guardia anti-regresion: los valores del metodo equirectangular no deben volver
H.chequear('superficie NO es la del metodo antiguo (36184.00)',
    Math.abs(area - patron.regresionConocida.superficieM2) > 1);
H.chequear('perimetro NO es el del metodo antiguo (809.52)',
    Math.abs(perim - patron.regresionConocida.perimetroM) > 1);

console.log('\nCoordenadas UTM de los vertices');
const P = api.afRingUTM({ type: 'Feature', geometry: feat.geometry });
let peor = 0, peorIdx = -1;
patron.primerosVerticesUTM.forEach((v, i) => {
    const d = Math.hypot(P[i][0] - v[0], P[i][1] - v[1]);
    if (d > peor) { peor = d; peorIdx = i; }
});
// 1 mm: por encima de eso reaparecio algun redondeo (p.ej. toGeoJSON a 6 decimales)
H.chequear(`desviacion maxima ${(peor * 1000).toFixed(2)} mm <= 1 mm (peor: V${peorIdx + 1})`, peor <= 0.001);

console.log('\nAfectacion vial');
const r = api.calcularFranjasAfectacion({ type: 'Feature', properties: feat.properties, geometry: feat.geometry });
H.chequear('devuelve resultado', !!r);
if (r) {
    // 2% frente al dibujo CAD: el trazado municipal muere dentro del predio y su
    // cierre es interpretado, asi que no cabe exigir coincidencia exacta.
    const tol = patron.afectacionVialM2 * 0.02;
    H.casiIgual('area de afectacion', r.total, patron.afectacionVialM2, tol, 'm2');
    H.chequear(`detecta ${patron.franjasAfectacionM2.length} franjas o mas (obtenido ${r.franjas.length})`,
        r.franjas.length >= patron.franjasAfectacionM2.length);
    H.chequear('area de afectacion NO es la del metodo antiguo (28084.01)',
        Math.abs(r.total - patron.regresionConocida.afectacionVialM2) > 100);
    H.chequear('afectacion + area util = superficie del predio',
        Math.abs((r.total + r.edificable) - area) < 0.5,
        `${r.total} + ${r.edificable} vs ${area}`);
    H.chequear('contornos exportables presentes',
        Array.isArray(r.contornos) && r.contornos.length === r.franjas.length);
    H.chequear('contornos con coordenadas lat/lng y UTM',
        r.contornos.every(c => Array.isArray(c.latlng) && c.latlng.length >= 3 && Array.isArray(c.utm)));
}

H.resumen('EXACTITUD');
