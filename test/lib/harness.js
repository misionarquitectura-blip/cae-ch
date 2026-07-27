// ─────────────────────────────────────────────────────────────────────────────
//  Arnés de pruebas geométricas del GeoVisor CAE-CH
//
//  Extrae las funciones REALES de geovisor.html y las ejecuta en Node contra
//  los datos de produccion. No hay copia del algoritmo aqui: si geovisor.html
//  cambia, estas pruebas miden el codigo nuevo.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');

// Funciones que el arnés necesita del archivo fuente, en orden de dependencia.
const FUNCIONES = [
    'latLngToUTM', 'utmToLatLng', 'pointsToUTM',
    'calculatePolygonArea', 'calculatePolygonPerimeter',
    'anilloEnAnillo', 'medirGeometria',
    'afUTM', 'afShoelace', 'afBbox', 'afPip', 'afDist2Seg', 'afDistToRing',
    'afSegInt', 'afDedupe', 'afInnerPaths', 'afSplitByPath', 'afMaxSepBorde',
    'afNucleo', 'afRingUTM', 'afExtender', 'afCadenasLF',
    'calcularFranjasAfectacion'
];
const CONSTANTES = ['AF_MAX_RETIRO', 'AF_NODE_SNAP'];

function extraerFuncion(src, nombre) {
    const i = src.indexOf('function ' + nombre + '(');
    if (i < 0) throw new Error(`No se encontro la funcion "${nombre}" en geovisor.html`);
    let k = src.indexOf('{', i), prof = 0;
    for (; k < src.length; k++) {
        if (src[k] === '{') prof++;
        else if (src[k] === '}') { prof--; if (prof === 0) { k++; break; } }
    }
    return src.slice(i, k);
}

function extraerConstante(src, nombre) {
    const m = src.match(new RegExp('const ' + nombre + '\\s*=\\s*[^;]+;'));
    if (!m) throw new Error(`No se encontro la constante "${nombre}" en geovisor.html`);
    return m[0];
}

/**
 * Carga las funciones geometricas de geovisor.html.
 * @param {object} geojsonLayers  stub de capas ({8: {eachLayer}} para lineas de fabrica)
 */
function cargarGeovisor(geojsonLayers) {
    const src = fs.readFileSync(path.join(RAIZ, 'geovisor.html'), 'utf8');
    let codigo = CONSTANTES.map(c => extraerConstante(src, c)).join('\n') + '\n';
    codigo += FUNCIONES.map(f => extraerFuncion(src, f)).join('\n') + '\n';
    codigo += 'return {' + FUNCIONES.join(',') + '};';
    return new Function('geojsonLayers', 'console', codigo)(geojsonLayers || {}, console);
}

function leerGeoJSON(rel) {
    return JSON.parse(fs.readFileSync(path.join(RAIZ, rel), 'utf8'));
}

// Capa 8 (lineas de fabrica) simulada sobre el GeoJSON de produccion
function stubLineasFabrica() {
    const lf = leerGeoJSON('DATA SET/LINEAS_FABRICA.geojson');
    return { 8: { eachLayer: cb => { for (const f of lf.features) cb({ feature: f }); } } };
}

function buscarPredio(catastro, clave) {
    return catastro.features.find(f => String((f.properties || {}).claves || '').startsWith(clave));
}

// Anillo exterior sin el vertice de cierre duplicado
function anillo(feature) {
    const g = feature.geometry;
    let r = (g.type === 'MultiPolygon' ? g.coordinates[0][0] : g.coordinates[0]).slice();
    if (r.length > 1) {
        const a = r[0], b = r[r.length - 1];
        if (a[0] === b[0] && a[1] === b[1]) r.pop();
    }
    return r;
}

// ── mini runner ──────────────────────────────────────────────────────────────
let _ok = 0, _fail = 0;
const _fallos = [];

function chequear(nombre, condicion, detalle) {
    if (condicion) { _ok++; console.log(`  ✓ ${nombre}`); }
    else { _fail++; _fallos.push(nombre + (detalle ? ' — ' + detalle : '')); console.log(`  ✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}

function casiIgual(nombre, obtenido, esperado, tol, unidad) {
    const d = Math.abs(obtenido - esperado);
    chequear(
        `${nombre}: ${obtenido} ≈ ${esperado} ${unidad || ''} (Δ ${d.toFixed(4)}, tol ${tol})`,
        d <= tol
    );
}

function resumen(titulo) {
    console.log(`\n${titulo}: ${_ok} correctas, ${_fail} fallidas`);
    if (_fail) { console.log('\nFALLOS:'); _fallos.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
    return _fail === 0;
}

module.exports = {
    cargarGeovisor, leerGeoJSON, stubLineasFabrica, buscarPredio, anillo,
    chequear, casiIgual, resumen, RAIZ
};
