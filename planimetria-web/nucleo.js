/* Motor de la planimetria CAE-Ch, empaquetado para el navegador.
   GENERADO por planimetria/construir_web.js — no editar a mano.
   El codigo de lib/ va tal cual: la version de escritorio, esta y las
   pruebas corren exactamente lo mismo. */
(function (global) {
'use strict';

// fs: en el navegador no hay disco. `existsSync` devuelve false, que es la
// respuesta honesta, y leer lanza. capas.js ya lo contempla: sus capas se
// siembran con ingerir(), y nucleo.js recibe el texto con fijarFuente().
const __fs = {
    existsSync: () => false,
    readFileSync: ruta => { throw new Error('Sin sistema de archivos en el navegador: ' + ruta); },
    statSync: ruta => { throw new Error('Sin sistema de archivos en el navegador: ' + ruta); }
};

// path: solo lo que lib/ llama de verdad.
const __path = {
    sep: '/',
    join: (...p) => p.filter(Boolean).join('/').replace(/\/{2,}/g, '/'),
    resolve: (...p) => p.filter(Boolean).join('/').replace(/\/{2,}/g, '/'),
    dirname: p => String(p).replace(/\/[^/]*$/, ''),
    basename: (p, ext) => {
        let b = String(p).split('/').pop();
        if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length);
        return b;
    }
};

// Buffer: pdf.js hace Buffer.from(arrayBuffer) para devolver los bytes del
// PDF. Un Uint8Array sirve igual para armar el Blob de la descarga.
const __Buffer = {
    from: (x) => x instanceof Uint8Array ? x : new Uint8Array(x),
    isBuffer: x => x instanceof Uint8Array
};

function __externo(id) {
    if (id === 'fs') return __fs;
    if (id === 'path') return __path;
    if (id === 'polygon-clipping') {
        if (typeof polygonClipping === 'undefined') throw new Error('Falta polygon-clipping (CDN).');
        return polygonClipping;
    }
    if (id === 'jspdf') {
        if (typeof jspdf === 'undefined') throw new Error('Falta jsPDF (CDN).');
        return jspdf;
    }
    // jspdf-autotable se engancha solo al cargarse por <script>; lib/pdf.js
    // toma la funcion de aqui, y si no esta, del prototipo del documento.
    if (id === 'jspdf-autotable') {
        return { default: (doc, opciones) => doc.autoTable(opciones) };
    }
    throw new Error('Modulo no disponible en el navegador: ' + id);
}

const __defs = {}, __cache = {};

function require(id) {
    if (id.charAt(0) !== '.') return __externo(id);
    const clave = id.replace(/^\.\//, '').replace(/\.js$/, '');
    if (__cache[clave]) return __cache[clave].exports;
    const def = __defs[clave];
    if (!def) throw new Error('Modulo desconocido: ' + id);
    const modulo = __cache[clave] = { exports: {} };
    // Si el modulo revienta a medio cargar hay que sacarlo de la cache. Si se
    // queda, la siguiente llamada devuelve unos exports vacios sin avisar, y el
    // fallo aparece mucho mas lejos disfrazado de "no es una funcion".
    try { def(modulo, modulo.exports, require); }
    catch (e) { delete __cache[clave]; throw e; }
    return modulo.exports;
}

// ── lib/nucleo.js ──────────────────────────────────────────────────────
__defs["nucleo"] = function (module, exports, require) {
const __dirname = "/lib", __filename = "/lib/nucleo.js";
const Buffer = __Buffer;
// ─────────────────────────────────────────────────────────────────────────────
//  Nucleo geometrico compartido con el GeoVisor
//
//  Las funciones de medicion, linderos y afectacion vial NO se copian aqui: se
//  extraen del propio geovisor.html, igual que hace test/lib/harness.js. Asi la
//  planimetria y el DICAT miden con el mismo codigo (UTM 17S plano, linea de
//  fabrica encadenada con nodo de 1,0 m) y cualquier correccion en el visor
//  llega a los dos productos a la vez.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');

const GEOVISOR = path.join(__dirname, '..', '..', 'geovisor.html');

const FUNCIONES = [
    'latLngToUTM', 'utmToLatLng',
    'afUTM', 'afShoelace', 'afBbox', 'afPip', 'afDist2Seg', 'afDistToRing',
    'afSegInt', 'afDedupe', 'afInnerPaths', 'afSplitByPath', 'afMaxSepBorde',
    'afNucleo', 'afRingUTM', 'afExtender', 'afCadenasLF',
    'calcularFranjasAfectacion',
    'lindAnilloValido', 'lindAnillosExteriores', 'lindProyeccion', 'lindLongitudIntervalos',
    'lindLadosPredio', 'lindMarcarVecino'
];
const CONSTANTES = ['AF_MAX_RETIRO', 'AF_NODE_SNAP', 'LIND_TOL_M', 'LIND_MIN_M'];

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

function extraerConstante(src, nombre, valor) {
    const re = new RegExp('const ' + nombre + '\\s*=\\s*[^;]+;');
    const m = src.match(re);
    if (!m) throw new Error(`No se encontro la constante "${nombre}" en geovisor.html`);
    return valor === undefined ? m[0] : `const ${nombre} = ${Number(valor)};`;
}

let _src = null;
const _cache = new Map();

/**
 * Entrega el texto de geovisor.html sin pasar por el disco. Lo usa el
 * navegador, que lo baja por fetch: la extraccion es la misma, solo cambia
 * de donde sale la fuente. En Node no hace falta llamarla.
 */
function fijarFuente(texto) { _src = texto; _cache.clear(); }

/**
 * Devuelve las funciones del visor. `constantes` permite sustituir alguna
 * (p. ej. LIND_TOL_M: el levantamiento de campo no calza al centimetro con el
 * catastro). Cada combinacion se compila una sola vez.
 * La afectacion vial lee geojsonLayers[8]; se pasa por llamada con `conLF`.
 */
function cargarNucleo(constantes) {
    constantes = constantes || {};
    const clave = JSON.stringify(constantes);
    if (_cache.has(clave)) return _cache.get(clave);
    if (!_src) _src = fs.readFileSync(GEOVISOR, 'utf8');
    let codigo = CONSTANTES.map(c => extraerConstante(_src, c, constantes[c])).join('\n') + '\n';
    codigo += FUNCIONES.map(f => extraerFuncion(_src, f)).join('\n') + '\n';
    codigo += 'return {' + FUNCIONES.concat(CONSTANTES).join(',') + ', _capas: geojsonLayers};';
    const geojsonLayers = {};
    const api = new Function('geojsonLayers', 'console', codigo)(geojsonLayers, console);
    // Afectacion con un juego de lineas de fabrica concreto (ya filtrado por zona)
    api.afectacionLF = function (predioGeoJSON, featuresLF) {
        geojsonLayers[8] = { eachLayer: cb => { for (const f of featuresLF) cb({ feature: f }); } };
        try { return api.calcularFranjasAfectacion(predioGeoJSON); }
        finally { delete geojsonLayers[8]; }
    };
    _cache.set(clave, api);
    return api;
}

module.exports = { cargarNucleo, fijarFuente, GEOVISOR };

};

// ── lib/capas.js ───────────────────────────────────────────────────────
__defs["capas"] = function (module, exports, require) {
const __dirname = "/lib", __filename = "/lib/capas.js";
const Buffer = __Buffer;
// ─────────────────────────────────────────────────────────────────────────────
//  Capas de referencia con indice espacial en rejilla
//
//  Catastro, lineas de fabrica, PUGS y parroquias vienen en WGS84 (grados);
//  las capas certificadas de la GDB, en UTM 17S nativo. Cada capa guarda sus
//  coordenadas en Float64Array (un GeoJSON de 70 MB en objetos de JS ocupa
//  varias veces su tamano) y se carga la primera vez que se consulta.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');
const { cargarNucleo } = require('./nucleo');

const nucleo = cargarNucleo();

class Capa {
    /**
     * @param {string} id
     * @param {string[]} archivos  rutas absolutas
     * @param {'utm'|'wgs84'} crs
     * @param {function} [filtro]  (props) => boolean
     */
    constructor(id, archivos, crs, filtro) {
        this.id = id;
        this.archivos = archivos;
        this.crs = crs;
        this.filtro = filtro || null;
        this.celda = crs === 'utm' ? 250 : 0.0025;
        this.features = null;
        this.rejilla = null;
        this.faltantes = [];
    }

    // Ya sembrada -el navegador la trae por fetch- o hay archivo que leer.
    // Consultar `features` no fuerza la carga: en Node sigue siendo perezosa.
    disponible() {
        return this.features ? this.features.length > 0 : this.archivos.some(a => fs.existsSync(a));
    }

    cargar() {
        if (this.features) return;
        const t0 = Date.now();
        for (const archivo of this.archivos) {
            if (!fs.existsSync(archivo)) { this.faltantes.push(archivo); continue; }
            this.ingerir(JSON.parse(fs.readFileSync(archivo, 'utf8')), path.basename(archivo, '.geojson'));
        }
        if (!this.features) { this.features = []; this.rejilla = new Map(); }
        this.msCarga = Date.now() - t0;
    }

    /**
     * Mete una FeatureCollection en la capa y la indexa. Se separo de
     * `cargar()` para que el navegador pueda sembrar lo que baja por fetch
     * sin tocar el sistema de archivos ni volver asincrono a `consultar()`.
     */
    ingerir(fc, origen) {
        if (!this.features) { this.features = []; this.rejilla = new Map(); }
        {
            for (const f of fc.features || []) {
                if (!f || !f.geometry) continue;
                const props = f.properties || {};
                if (this.filtro && !this.filtro(props)) continue;
                const g = f.geometry;
                let tipo, partes;
                if (g.type === 'Polygon') { tipo = 'poligono'; partes = [g.coordinates]; }
                else if (g.type === 'MultiPolygon') { tipo = 'poligono'; partes = g.coordinates; }
                else if (g.type === 'LineString') { tipo = 'linea'; partes = [[g.coordinates]]; }
                else if (g.type === 'MultiLineString') { tipo = 'linea'; partes = g.coordinates.map(l => [l]); }
                else continue;
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                const comp = partes.map(anillos => anillos.filter(r => Array.isArray(r) && r.length >= 2).map(r => {
                    const a = new Float64Array(r.length * 2);
                    for (let i = 0; i < r.length; i++) {
                        const x = +r[i][0], y = +r[i][1];
                        a[2 * i] = x; a[2 * i + 1] = y;
                        if (x < x0) x0 = x; if (x > x1) x1 = x;
                        if (y < y0) y0 = y; if (y > y1) y1 = y;
                    }
                    return a;
                })).filter(p => p.length);
                if (!comp.length || !isFinite(x0)) continue;
                const idx = this.features.length;
                this.features.push({ idx, capa: this.id, origen, tipo, props, partes: comp, bbox: [x0, y0, x1, y1], crsUTM: this.crs === 'utm', _utm: null });
                const c = this.celda;
                for (let gx = Math.floor(x0 / c); gx <= Math.floor(x1 / c); gx++) {
                    for (let gy = Math.floor(y0 / c); gy <= Math.floor(y1 / c); gy++) {
                        const k = gx + ',' + gy;
                        let l = this.rejilla.get(k);
                        if (!l) this.rejilla.set(k, l = []);
                        l.push(idx);
                    }
                }
            }
        }
        return this;
    }

    /** Features cuyo rectangulo toca el rectangulo UTM [x0,y0,x1,y1] ampliado en `margen` m. */
    consultar(bboxUTM, margen) {
        this.cargar();
        margen = margen || 0;
        let b = [bboxUTM[0] - margen, bboxUTM[1] - margen, bboxUTM[2] + margen, bboxUTM[3] + margen];
        if (this.crs === 'wgs84') {
            const esq = [[b[0], b[1]], [b[0], b[3]], [b[2], b[1]], [b[2], b[3]]].map(p => nucleo.utmToLatLng(p[0], p[1], 17, true));
            b = [Math.min(...esq.map(p => p[1])), Math.min(...esq.map(p => p[0])), Math.max(...esq.map(p => p[1])), Math.max(...esq.map(p => p[0]))];
        }
        const c = this.celda, vistos = new Set(), out = [];
        for (let gx = Math.floor(b[0] / c); gx <= Math.floor(b[2] / c); gx++) {
            for (let gy = Math.floor(b[1] / c); gy <= Math.floor(b[3] / c); gy++) {
                for (const i of this.rejilla.get(gx + ',' + gy) || []) {
                    if (vistos.has(i)) continue;
                    vistos.add(i);
                    const f = this.features[i];
                    if (f.bbox[0] > b[2] || f.bbox[2] < b[0] || f.bbox[1] > b[3] || f.bbox[3] < b[1]) continue;
                    out.push(f);
                }
            }
        }
        return out;
    }
}

/** Partes de la feature en UTM: [[anillo o linea como [[x,y],...]], ...] */
function partesUTM(f) {
    if (f._utm) return f._utm;
    f._utm = f.partes.map(anillos => anillos.map(a => {
        const r = new Array(a.length / 2);
        for (let i = 0; i < r.length; i++) {
            if (f.crsUTM) r[i] = [a[2 * i], a[2 * i + 1]];
            else { const u = nucleo.latLngToUTM(a[2 * i + 1], a[2 * i], 17, true); r[i] = [u.easting, u.northing]; }
        }
        return r;
    }));
    return f._utm;
}

/** Geometria GeoJSON en grados, tal como la esperan las funciones del visor. */
function geojsonWGS84(f) {
    const arr = a => { const r = new Array(a.length / 2); for (let i = 0; i < r.length; i++) r[i] = [a[2 * i], a[2 * i + 1]]; return r; };
    if (f.tipo === 'poligono') {
        return f.partes.length === 1
            ? { type: 'Polygon', coordinates: f.partes[0].map(arr) }
            : { type: 'MultiPolygon', coordinates: f.partes.map(p => p.map(arr)) };
    }
    return { type: 'MultiLineString', coordinates: f.partes.map(p => arr(p[0])) };
}

function crearCapas(config, raiz) {
    const r = p => path.resolve(raiz, p);
    const cert = n => path.join(raiz, 'datos', 'certificadas', n + '.geojson');
    const capas = {
        catastro: new Capa('catastro', [r(config.capas.catastro)], 'wgs84'),
        lineas_fabrica: new Capa('lineas_fabrica', [r(config.capas.lineas_fabrica)], 'wgs84'),
        pugs: new Capa('pugs', [r(config.capas.pugs_urbano), r(config.capas.pugs_rural)], 'wgs84'),
        parroquias: new Capa('parroquias', [r(config.capas.parroquias)], 'wgs84'),
        limite_urbano: new Capa('limite_urbano', [r(config.capas.limite_urbano)], 'wgs84')
    };
    for (const e of config.elementos) {
        const filtro = e.filtro
            ? props => Object.keys(e.filtro).every(k => String(props[k]) === String(e.filtro[k]))
            : null;
        const c = new Capa('el:' + e.id, (e.capas_gdb || []).map(cert), 'utm', filtro);
        c.elemento = e;
        capas['el:' + e.id] = c;
    }
    return capas;
}

/**
 * El mismo juego de capas, pero sobre los archivos magros que escribe
 * `preparar_web.js`: uno por capa, ya recortados y sin los atributos que
 * nadie lee. Los elementos vienen fundidos y YA FILTRADOS en un solo
 * archivo (`el_quebrada` son las quebradas, no rio_l entero), de modo que
 * aqui no se vuelve a aplicar el filtro.
 *
 * @param {function(string): string} resolver  id de capa → ruta o URL
 */
function crearCapasWeb(config, resolver) {
    const capas = {
        catastro:       new Capa('catastro',       [resolver('catastro')],       'wgs84'),
        lineas_fabrica: new Capa('lineas_fabrica', [resolver('lineas_fabrica')], 'wgs84'),
        pugs:           new Capa('pugs',           [resolver('pugs')],           'wgs84'),
        parroquias:     new Capa('parroquias',     [resolver('parroquias')],     'wgs84'),
        limite_urbano:  new Capa('limite_urbano',  [resolver('limite_urbano')],  'wgs84')
    };
    for (const e of config.elementos) {
        const c = new Capa('el:' + e.id, [resolver('el_' + e.id)], 'utm');
        c.elemento = e;
        capas['el:' + e.id] = c;
    }
    return capas;
}

module.exports = { Capa, crearCapas, crearCapasWeb, partesUTM, geojsonWGS84 };

};

// ── lib/entrada.js ─────────────────────────────────────────────────────
__defs["entrada"] = function (module, exports, require) {
const __dirname = "/lib", __filename = "/lib/entrada.js";
const Buffer = __Buffer;
// ─────────────────────────────────────────────────────────────────────────────
//  Entrada del levantamiento: CSV de coordenadas o DXF con el poligono trazado
//
//  Todo sale de aqui en UTM WGS84 17S (metros). Si el CSV trae latitud y
//  longitud (GNSS) se proyecta con latLngToUTM del visor, la misma funcion
//  que usa el DICAT.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const { cargarNucleo } = require('./nucleo');

// Envolvente plausible del canton Riobamba en UTM 17S (con holgura)
const RANGO_E = [700000, 820000];
const RANGO_N = [9720000, 9860000];
const enRangoUTM = (x, y) => x >= RANGO_E[0] && x <= RANGO_E[1] && y >= RANGO_N[0] && y <= RANGO_N[1];
const enRangoGeo = (lat, lon) => lat > -3 && lat < -1 && lon > -80 && lon < -78;

// ── CSV ──────────────────────────────────────────────────────────────────────

const ALIAS = {
    id: /^(pto|punto|pt|p|id|n|no|nro|num|numero|nombre|name|vertice|v)$/,
    x: /^(x|este|e|easting|coordx|coord_x|utm_e|utme)$/,
    y: /^(y|norte|n|northing|coordy|coord_y|utm_n|utmn)$/,
    z: /^(z|cota|elev|elevacion|altura|h)$/,
    cod: /^(cod|codigo|code|desc|descripcion|description|detalle|obs|observacion)$/,
    lat: /^(lat|latitud|latitude)$/,
    lon: /^(lon|long|lng|longitud|longitude)$/
};

function normalizarCabecera(s) {
    return String(s || '').trim().toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_]/g, '');
}

function numero(s, decimalComa) {
    if (s === undefined || s === null) return NaN;
    let t = String(s).trim().replace(/^"|"$/g, '');
    if (!t) return NaN;
    if (decimalComa) t = t.replace(/\./g, '').replace(',', '.');
    return /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(t) ? Number(t) : NaN;
}

function detectarSeparador(lineas) {
    const muestra = lineas.slice(0, 20);
    const candidatos = [';', '\t', ',', '|'];
    let mejor = null, mejorPuntos = 0;
    for (const s of candidatos) {
        const cuentas = muestra.map(l => l.split(s).length - 1);
        const modal = cuentas.sort((a, b) => b - a)[Math.floor(cuentas.length / 2)] || 0;
        const constantes = muestra.filter(l => l.split(s).length - 1 === modal).length;
        const puntos = modal > 0 ? constantes * 10 + modal : 0;
        if (puntos > mejorPuntos) { mejor = s; mejorPuntos = puntos; }
    }
    return mejor || /\s+/;
}

/**
 * Lee un CSV/TXT de puntos. Reconoce cabeceras en espanol e ingles
 * (PTO;ESTE;NORTE;COTA;DESCRIPCION...), separador ; , tab |, coma decimal,
 * archivos sin cabecera (P,X,Y[,Z][,COD]) y coordenadas geograficas.
 */
function leerCSV(texto) {
    const avisos = [];
    const lineas = String(texto).replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
    if (!lineas.length) throw new Error('El archivo CSV esta vacio.');
    const sep = detectarSeparador(lineas);
    const filas = lineas.map(l => l.split(sep).map(c => c.trim().replace(/^"|"$/g, '')));
    // Coma decimal: solo si el separador no es la coma y aparecen numeros "123,45"
    const decimalComa = sep !== ',' && filas.slice(0, 20).some(f => f.some(c => /^-?\d+,\d+$/.test(c)));

    let cols = null, inicio = 0;
    const cab = filas[0].map(normalizarCabecera);
    const hayTexto = filas[0].some(c => c && isNaN(numero(c, decimalComa)));
    if (hayTexto) {
        cols = {};
        cab.forEach((h, i) => {
            for (const k of Object.keys(ALIAS)) if (cols[k] === undefined && ALIAS[k].test(h)) { cols[k] = i; break; }
        });
        // "n" es ambiguo (numero de punto o norte): si ya hay id y no hay y, es norte
        inicio = 1;
    }
    const ncol = Math.max(...filas.slice(inicio).map(f => f.length));
    if (!cols || (cols.x === undefined && cols.lat === undefined)) {
        // Sin cabecera reconocible: se buscan las dos columnas numericas grandes
        const datos = filas.slice(inicio);
        const esGrande = (i, lo, hi) => datos.filter(f => { const v = numero(f[i], decimalComa); return v >= lo && v <= hi; }).length > datos.length * 0.8;
        const colE = [...Array(ncol).keys()].find(i => esGrande(i, RANGO_E[0], RANGO_E[1]));
        const colN = [...Array(ncol).keys()].find(i => esGrande(i, RANGO_N[0], RANGO_N[1]));
        const colLat = [...Array(ncol).keys()].find(i => esGrande(i, -3, -1));
        const colLon = [...Array(ncol).keys()].find(i => esGrande(i, -80, -78));
        cols = {};
        if (colE !== undefined && colN !== undefined) { cols.x = colE; cols.y = colN; }
        else if (colLat !== undefined && colLon !== undefined) { cols.lat = colLat; cols.lon = colLon; }
        else throw new Error('No se reconocen columnas de coordenadas UTM 17S (Este 700000-820000, Norte 9720000-9860000) ni geograficas.');
        const usadas = new Set(Object.values(cols));
        const primera = [...Array(ncol).keys()].find(i => !usadas.has(i));
        if (primera !== undefined && primera < Math.min(...usadas)) cols.id = primera;
        const resto = [...Array(ncol).keys()].filter(i => !usadas.has(i) && i !== cols.id);
        for (const i of resto) {
            const nums = datos.filter(f => !isNaN(numero(f[i], decimalComa))).length;
            if (cols.z === undefined && nums > datos.length * 0.8) cols.z = i;
            else if (cols.cod === undefined && nums < datos.length * 0.5) cols.cod = i;
        }
    }

    const nucleo = cargarNucleo();
    const puntos = [];
    let geograficas = false, invertidas = 0;
    filas.slice(inicio).forEach((f, k) => {
        let x, y;
        if (cols.x !== undefined) {
            x = numero(f[cols.x], decimalComa); y = numero(f[cols.y], decimalComa);
            if (!isFinite(x) || !isFinite(y)) return;
            if (!enRangoUTM(x, y) && enRangoUTM(y, x)) { const t = x; x = y; y = t; invertidas++; }
            if (!enRangoUTM(x, y) && enRangoGeo(x, y)) { const u = nucleo.latLngToUTM(x, y, 17, true); x = u.easting; y = u.northing; geograficas = true; }
            else if (!enRangoUTM(x, y) && enRangoGeo(y, x)) { const u = nucleo.latLngToUTM(y, x, 17, true); x = u.easting; y = u.northing; geograficas = true; }
        } else {
            const lat = numero(f[cols.lat], decimalComa), lon = numero(f[cols.lon], decimalComa);
            if (!isFinite(lat) || !isFinite(lon)) return;
            const u = nucleo.latLngToUTM(lat, lon, 17, true);
            x = u.easting; y = u.northing; geograficas = true;
        }
        puntos.push({
            id: cols.id !== undefined && f[cols.id] ? String(f[cols.id]) : String(puntos.length + 1),
            x, y,
            z: cols.z !== undefined ? numero(f[cols.z], decimalComa) : null,
            cod: cols.cod !== undefined ? (f[cols.cod] || '') : '',
            fila: k + inicio + 1
        });
    });
    if (invertidas) avisos.push(`${invertidas} puntos tenian Este y Norte intercambiados; se corrigieron.`);
    if (geograficas) avisos.push('Coordenadas geograficas (WGS84) proyectadas a UTM 17S.');
    const fuera = puntos.filter(p => !enRangoUTM(p.x, p.y));
    if (fuera.length) throw new Error(`${fuera.length} puntos caen fuera del canton Riobamba en UTM 17S (p. ej. fila ${fuera[0].fila}: ${fuera[0].x}, ${fuera[0].y}). Revise el sistema de referencia.`);
    if (puntos.length < 3) throw new Error('El CSV necesita al menos 3 puntos con coordenadas validas.');
    const codigos = [...new Set(puntos.map(p => p.cod).filter(Boolean))];
    return { tipo: 'csv', puntos, codigos, avisos, separador: sep === '\t' ? 'tab' : String(sep), decimalComa };
}

// ── DXF ──────────────────────────────────────────────────────────────────────

function paresDXF(texto) {
    const l = String(texto).split(/\r?\n/);
    const pares = [];
    for (let i = 0; i + 1 < l.length; i += 2) pares.push([parseInt(l[i].trim(), 10), l[i + 1]]);
    return pares;
}

// Arco de una polilinea (bulge) densificado con flecha maxima de 1 cm
function arcoBulge(a, b, bulge) {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d < 1e-9 || Math.abs(bulge) < 1e-9) return [];
    // theta: angulo central con signo (positivo = antihorario)
    const theta = 4 * Math.atan(bulge);
    const r = d * (1 + bulge * bulge) / (4 * Math.abs(bulge));
    const paso = 2 * Math.acos(Math.max(-1, 1 - Math.min(0.01, r) / r));
    const n = Math.max(2, Math.ceil(Math.abs(theta) / paso));
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    // centro: desde el punto medio de la cuerda, por la normal izquierda
    const h = d * (1 - bulge * bulge) / (4 * bulge);
    const ux = -(b[1] - a[1]) / d, uy = (b[0] - a[0]) / d;
    const cx = mx + ux * h, cy = my + uy * h;
    const a0 = Math.atan2(a[1] - cy, a[0] - cx);
    const pts = [];
    for (let k = 1; k < n; k++) {
        const ang = a0 + theta * k / n;
        pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
    }
    return pts;
}

/**
 * Extrae del DXF los contornos cerrados candidatos a predio: LWPOLYLINE y
 * POLYLINE cerradas (o abiertas que vuelven a su origen) y anillos formados
 * por LINE sueltas. Devuelve tambien los POINT/TEXT por si el topografo dejo
 * rotulados los vertices.
 */
function leerDXF(texto) {
    const pares = paresDXF(texto);
    const avisos = [];
    let i = pares.findIndex((p, k) => p[0] === 2 && p[1].trim() === 'ENTITIES' && pares[k - 1] && pares[k - 1][1].trim() === 'SECTION');
    if (i < 0) throw new Error('El DXF no tiene seccion ENTITIES (¿es un DXF binario o esta danado?).');
    const contornos = [], lineas = [], puntos = [], textos = [];
    let curvas = 0;
    const entidades = [];
    let actual = null;
    for (i = i + 1; i < pares.length; i++) {
        const [c, v0] = pares[i];
        const v = v0.trim();
        if (c === 0) {
            if (actual) entidades.push(actual);
            if (v === 'ENDSEC') { actual = null; break; }
            actual = { tipo: v, g: [] };
            continue;
        }
        if (actual) actual.g.push([c, v]);
    }
    if (actual) entidades.push(actual);

    const capaDe = e => (e.g.find(p => p[0] === 8) || [0, '0'])[1];
    for (let k = 0; k < entidades.length; k++) {
        const e = entidades[k];
        if (e.tipo === 'LWPOLYLINE') {
            const flags = Number((e.g.find(p => p[0] === 70) || [0, 0])[1]);
            const vs = [];
            for (const [c, v] of e.g) {
                if (c === 10) vs.push({ x: Number(v), y: NaN, b: 0 });
                else if (c === 20 && vs.length) vs[vs.length - 1].y = Number(v);
                else if (c === 42 && vs.length) vs[vs.length - 1].b = Number(v);
            }
            contornos.push({ capa: capaDe(e), cerrada: (flags & 1) === 1, vs, origen: 'LWPOLYLINE' });
        } else if (e.tipo === 'POLYLINE') {
            const flags = Number((e.g.find(p => p[0] === 70) || [0, 0])[1]);
            const vs = [];
            let j = k + 1;
            for (; j < entidades.length && entidades[j].tipo === 'VERTEX'; j++) {
                const g = entidades[j].g;
                const vf = Number((g.find(p => p[0] === 70) || [0, 0])[1]);
                if (vf & 16) continue;           // marco de control de spline
                vs.push({
                    x: Number((g.find(p => p[0] === 10) || [0, NaN])[1]),
                    y: Number((g.find(p => p[0] === 20) || [0, NaN])[1]),
                    b: Number((g.find(p => p[0] === 42) || [0, 0])[1])
                });
            }
            k = j;                               // salta hasta SEQEND
            if (flags & (16 | 64)) continue;     // mallas y caras poliedricas
            contornos.push({ capa: capaDe(e), cerrada: (flags & 1) === 1, vs, origen: 'POLYLINE' });
        } else if (e.tipo === 'LINE') {
            const n = c => Number((e.g.find(p => p[0] === c) || [0, NaN])[1]);
            lineas.push({ capa: capaDe(e), a: [n(10), n(20)], b: [n(11), n(21)] });
        } else if (e.tipo === 'POINT') {
            const n = c => Number((e.g.find(p => p[0] === c) || [0, NaN])[1]);
            puntos.push({ capa: capaDe(e), x: n(10), y: n(20) });
        } else if (e.tipo === 'TEXT' || e.tipo === 'MTEXT') {
            const n = c => Number((e.g.find(p => p[0] === c) || [0, NaN])[1]);
            // MTEXT reparte el contenido largo en grupos 3 y cierra con el 1
            const crudo = e.g.filter(p => p[0] === 3).map(p => p[1]).join('') + ((e.g.find(p => p[0] === 1) || [0, ''])[1]);
            const t = limpiarTextoCAD(crudo);
            if (t) textos.push({ capa: capaDe(e), x: n(10), y: n(20), t });
        }
    }

    const candidatos = [];
    const agregar = (capa, origen, pts) => {
        let a = pts.filter(p => isFinite(p[0]) && isFinite(p[1]));
        while (a.length > 1 && Math.hypot(a[0][0] - a[a.length - 1][0], a[0][1] - a[a.length - 1][1]) < 1e-4) a.pop();
        if (a.length < 3) return;
        let s = 0;
        for (let q = 0; q < a.length; q++) { const r = (q + 1) % a.length; s += a[q][0] * a[r][1] - a[r][0] * a[q][1]; }
        candidatos.push({ indice: candidatos.length, capa, origen, vertices: a.length, area: Math.abs(s) / 2, puntos: a });
    };
    for (const c of contornos) {
        if (c.vs.length < 3) continue;
        const pts = [];
        const n = c.vs.length;
        for (let q = 0; q < n; q++) {
            const v = c.vs[q];
            pts.push([v.x, v.y]);
            const sig = c.vs[(q + 1) % n];
            if (v.b && (q < n - 1 || c.cerrada)) { pts.push(...arcoBulge([v.x, v.y], [sig.x, sig.y], v.b)); curvas++; }
        }
        const f = pts[0], u = pts[pts.length - 1];
        const vuelve = Math.hypot(f[0] - u[0], f[1] - u[1]) < 0.01;
        if (c.cerrada || vuelve) agregar(c.capa, c.origen, pts);
    }
    // Anillos de LINE: se encadenan por nodos coincidentes al milimetro
    if (lineas.length) {
        const clave = p => Math.round(p[0] * 1000) + ',' + Math.round(p[1] * 1000);
        const adj = new Map();
        lineas.forEach((l, q) => {
            for (const k of [clave(l.a), clave(l.b)]) { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(q); }
        });
        const usada = new Set();
        lineas.forEach((l, q) => {
            if (usada.has(q)) return;
            const anillo = [l.a];
            let actualP = l.b, previa = q;
            usada.add(q);
            for (let paso = 0; paso < lineas.length; paso++) {
                if (clave(actualP) === clave(l.a)) { agregar(l.capa, 'LINE', anillo); return; }
                anillo.push(actualP);
                const sig = (adj.get(clave(actualP)) || []).find(z => z !== previa && !usada.has(z));
                if (sig === undefined) return;
                usada.add(sig);
                const ls = lineas[sig];
                actualP = clave(ls.a) === clave(actualP) ? ls.b : ls.a;
                previa = sig;
            }
        });
    }
    if (curvas) avisos.push(`${curvas} tramos curvos (arcos) se densificaron con flecha maxima de 1 cm.`);
    if (!candidatos.length) throw new Error('El DXF no contiene polilineas cerradas ni anillos de lineas que formen un poligono.');
    const georref = candidatos.filter(c => c.puntos.every(p => enRangoUTM(p[0], p[1])));
    if (!georref.length) {
        const p = candidatos[0].puntos[0];
        throw new Error(`El poligono del DXF no esta en UTM WGS84 17S (primer vertice ${p[0].toFixed(3)}, ${p[1].toFixed(3)}). Georreferencie el dibujo antes de cargarlo.`);
    }
    if (georref.length < candidatos.length) avisos.push(`${candidatos.length - georref.length} contornos fuera del canton se ignoraron.`);

    // El contorno mas grande no siempre es el predio: una planimetria trae el
    // marco, el cajetin o un PDF insertado como polilineas. Se puntua cada
    // contorno por su capa, por coincidir con POINT o rotulos "P1..." y por no
    // ser un rectangulo alineado a los ejes (los marcos lo son).
    const textosGeo = textos.filter(t => enRangoUTM(t.x, t.y));
    for (const c of georref) {
        let s = 0;
        const capa = c.capa.toLowerCase();
        if (/lind|terreno|predio|lote|limite|l[ií]mite|poligono|pol[ií]gono|levant|propiedad/.test(capa)) s += 4;
        if (/pdf_|marco|cajet|rotulo|r[oó]tulo|viewport|tabla|cuadro|acera|calle|via|v[ií]a|bordillo|cerramiento|construc|texto|dim|cota|norte|hatch/.test(capa)) s -= 4;
        const tolP = 0.05;
        const conPunto = c.puntos.filter(p => puntos.some(q => Math.hypot(q.x - p[0], q.y - p[1]) < tolP)).length;
        if (conPunto >= Math.min(3, c.puntos.length)) s += 3 + conPunto / c.puntos.length * 2;
        const rotulos = c.puntos.filter(p => textosGeo.some(t => /^[PV]\d+$/i.test(t.t) && Math.hypot(t.x - p[0], t.y - p[1]) < 3)).length;
        if (rotulos >= Math.min(3, c.puntos.length)) s += 3;
        const alineado = c.puntos.length === 4 && c.puntos.every((p, i) => { const q = c.puntos[(i + 1) % 4]; return Math.abs(p[0] - q[0]) < 1e-3 || Math.abs(p[1] - q[1]) < 1e-3; });
        if (alineado) s -= 3;
        if (c.area < 5) s -= 5;
        c.puntaje = Math.round(s * 10) / 10;
    }
    georref.sort((a, b) => b.puntaje - a.puntaje || b.area - a.area);
    georref.forEach((c, q) => { c.indice = q; });
    if (georref.length > 1 && georref[0].area < Math.max(...georref.map(c => c.area))) {
        avisos.push(`Se propone el contorno de la capa "${georref[0].capa}" (${georref[0].vertices} vertices) por encima de contornos mayores que parecen marco o dibujo auxiliar. Verifique la eleccion.`);
    }
    return { tipo: 'dxf', candidatos: georref, puntosSueltos: puntos.filter(p => enRangoUTM(p.x, p.y)).length, textos: textosGeo.slice(0, 2000), avisos };
}

// Texto de CAD sin codigos de formato de MTEXT: \P salto, {\fArial|b0;...},
// \H2.5x; alturas, \U+00F3 caracteres, %%d grado, %%c diametro
function limpiarTextoCAD(s) {
    return String(s || '')
        .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\M\+\d([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/%%[dD]/g, '°').replace(/%%[cC]/g, 'Ø').replace(/%%[pP]/g, '±').replace(/%%[uUoO]/g, '')
        .replace(/\\[Pp]/g, ' ')
        .replace(/\\[ACcFfHhQqTtWw][^;\\{}]*;/g, '')
        .replace(/\\[LlOoKkNn]/g, '')
        .replace(/\\S([^;]*)[\^#\/]([^;]*);/g, '$1/$2')
        .replace(/[{}]/g, '')
        .replace(/\\\\/g, '\\')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Decodifica el archivo. Los DXF desde AutoCAD 2007 (AC1021) son UTF-8; los
 * anteriores usan la pagina de codigos de $DWGCODEPAGE (en Ecuador,
 * ANSI_1252). Un CSV exportado desde Excel suele venir en Windows-1252.
 */
function decodificar(buffer, nombre) {
    const utf8 = buffer.toString('utf8');
    const esDXF = /\.dxf$/i.test(nombre || '') || /^\s*0\s*[\r\n]+\s*SECTION/.test(utf8.slice(0, 200));
    if (esDXF) {
        const ver = (utf8.slice(0, 4000).match(/\$ACADVER\s*[\r\n]+\s*1\s*[\r\n]+\s*AC(\d{4})/) || [])[1];
        if (ver && Number(ver) < 1021) return { texto: buffer.toString('latin1'), esDXF };
        return { texto: utf8, esDXF };
    }
    return { texto: utf8.includes('�') ? buffer.toString('latin1') : utf8, esDXF };
}

// ── Validacion y normalizacion del poligono ──────────────────────────────────

function segmentosSeCortan(a, b, c, d) {
    const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/**
 * Deja el anillo listo para la planimetria:
 *   · quita el vertice de cierre y los duplicados consecutivos;
 *   · lo orienta en sentido horario (convencion de linderacion);
 *   · numera desde el vertice mas al noroeste, salvo `inicio: 'original'`;
 *   · verifica autointersecciones y lados cortos.
 * Conserva el identificador de campo de cada punto.
 */
function normalizarPoligono(puntos, opciones) {
    opciones = opciones || {};
    const tolDup = opciones.tolDuplicado || 0.005;
    const ladoMin = opciones.ladoMinimo || 0.30;
    const avisos = [], errores = [];
    let v = puntos.map((p, i) => ({
        x: Number(p.x !== undefined ? p.x : p[0]),
        y: Number(p.y !== undefined ? p.y : p[1]),
        idCampo: p.id !== undefined ? String(p.id) : String(i + 1),
        cod: p.cod || ''
    })).filter(p => isFinite(p.x) && isFinite(p.y));

    const antes = v.length;
    const limpio = [];
    for (const p of v) {
        const q = limpio[limpio.length - 1];
        if (q && Math.hypot(q.x - p.x, q.y - p.y) < tolDup) continue;
        limpio.push(p);
    }
    while (limpio.length > 2 && Math.hypot(limpio[0].x - limpio[limpio.length - 1].x, limpio[0].y - limpio[limpio.length - 1].y) < tolDup) limpio.pop();
    v = limpio;
    if (antes - v.length > 0) avisos.push(`Se descartaron ${antes - v.length} vertices repetidos (cierre o duplicados a menos de ${(tolDup * 1000).toFixed(0)} mm).`);
    if (v.length < 3) { errores.push('El poligono necesita al menos 3 vertices distintos.'); return { vertices: v, avisos, errores }; }

    let s = 0;
    for (let i = 0; i < v.length; i++) { const j = (i + 1) % v.length; s += v[i].x * v[j].y - v[j].x * v[i].y; }
    if (Math.abs(s) / 2 < 1) errores.push('El area del poligono es practicamente nula: los puntos no encierran superficie.');
    if (s > 0) { v.reverse(); avisos.push('El poligono venia en sentido antihorario; se invirtio a horario.'); }

    if (opciones.inicio !== 'original') {
        // Vertice mas al noroeste: maximo de (Norte - Este)
        let k = 0;
        for (let i = 1; i < v.length; i++) if (v[i].y - v[i].x > v[k].y - v[k].x) k = i;
        if (k) v = v.slice(k).concat(v.slice(0, k));
    }

    const n = v.length;
    for (let i = 0; i < n; i++) {
        const a = [v[i].x, v[i].y], b = [v[(i + 1) % n].x, v[(i + 1) % n].y];
        for (let j = i + 2; j < n; j++) {
            if (i === 0 && j === n - 1) continue;
            const c = [v[j].x, v[j].y], d = [v[(j + 1) % n].x, v[(j + 1) % n].y];
            if (segmentosSeCortan(a, b, c, d)) errores.push(`El lado P${i + 1}-P${(i + 1) % n + 1} se cruza con el lado P${j + 1}-P${(j + 1) % n + 1}: revise el orden de los puntos.`);
        }
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < ladoMin) avisos.push(`El lado P${i + 1}-P${(i + 1) % n + 1} mide ${L.toFixed(3)} m (menor a ${ladoMin} m).`);
    }
    v.forEach((p, i) => { p.id = 'P' + (i + 1); });
    return { vertices: v, avisos, errores: errores.slice(0, 10) };
}

module.exports = { leerCSV, leerDXF, normalizarPoligono, enRangoUTM, decodificar, limpiarTextoCAD };

};

// ── lib/analisis.js ────────────────────────────────────────────────────
__defs["analisis"] = function (module, exports, require) {
const __dirname = "/lib", __filename = "/lib/analisis.js";
const Buffer = __Buffer;
// ─────────────────────────────────────────────────────────────────────────────
//  Analisis de la planimetria de un predio no catastrado
//
//  Entra el anillo levantado en UTM 17S (ya normalizado: horario, P1 al
//  noroeste) y sale todo lo que necesitan el DXF y el informe:
//    1. cuadro de coordenadas, lados, rumbos y superficie (UTM plano);
//    2. diagnostico frente al catastro: solapes, predio madre y desvio de
//       vertices respecto de los vertices catastrales vecinos;
//    3. linderos por tramo (desde Pi hasta Pj) con el colindante catastral,
//       la via o un hueco que el profesional debe completar;
//    4. afectacion por linea de fabrica (algoritmo del DICAT) y margenes de
//       proteccion de elementos certificados (rios, quebradas, vias);
//    5. ubicacion y normativa: parroquia, zona urbana/rural y PUGS.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const pc = require('polygon-clipping');
const { cargarNucleo } = require('./nucleo');
const { partesUTM, geojsonWGS84 } = require('./capas');

const DIRS = ['Norte', 'Este', 'Sur', 'Oeste'];
const r2 = v => Math.round(v * 100) / 100;
const sinTildes = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const es = v => Number(v).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });

// ── Geometria plana auxiliar ─────────────────────────────────────────────────

function shoelace(r) {
    let s = 0;
    for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; s += r[i][0] * r[j][1] - r[j][0] * r[i][1]; }
    return s / 2;
}

function puntoEnAnillo(p, r) {
    let dentro = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
        if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) dentro = !dentro;
    }
    return dentro;
}

function distPuntoSegmento(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    let t = L2 < 1e-18 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function segmentosSeCortan(a, b, c, d) {
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function distSegmentos(a, b, c, d) {
    if (segmentosSeCortan(a, b, c, d)) return 0;
    return Math.min(distPuntoSegmento(a, c, d), distPuntoSegmento(b, c, d), distPuntoSegmento(c, a, b), distPuntoSegmento(d, a, b));
}

// Distancia minima entre el anillo del predio y una polilinea (0 si cruza o
// si algun vertice de la polilinea cae dentro del predio)
function distAnilloLinea(anillo, linea) {
    let m = Infinity;
    for (let j = 0; j < linea.length; j++) {
        if (puntoEnAnillo(linea[j], anillo)) return 0;
        if (j === 0) continue;
        for (let i = 0; i < anillo.length; i++) {
            const d = distSegmentos(anillo[i], anillo[(i + 1) % anillo.length], linea[j - 1], linea[j]);
            if (d < m) m = d;
            if (m === 0) return 0;
        }
    }
    return m;
}

// Simplificacion Douglas-Peucker: el mapa de ubicacion se dibuja a 1:2000 y
// no necesita el detalle centimetrico de cada lindero del barrio.
function simplificar(pts, tol) {
    if (!pts || pts.length < 3) return pts || [];
    const dist = (p, a, b) => distPuntoSegmento(p, a, b);
    const rec = (ini, fin) => {
        let peor = 0, idx = -1;
        for (let i = ini + 1; i < fin; i++) {
            const d = dist(pts[i], pts[ini], pts[fin]);
            if (d > peor) { peor = d; idx = i; }
        }
        if (peor <= tol || idx < 0) return [pts[ini]];
        return rec(ini, idx).concat(rec(idx, fin));
    };
    return rec(0, pts.length - 1).concat([pts[pts.length - 1]]);
}

// Recorte de un segmento a un rectangulo (Liang-Barsky)
function recortarSegmento(a, b, bb) {
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const p = [-dx, dx, -dy, dy], q = [a[0] - bb[0], bb[2] - a[0], a[1] - bb[1], bb[3] - a[1]];
    for (let i = 0; i < 4; i++) {
        if (Math.abs(p[i]) < 1e-12) { if (q[i] < 0) return null; }
        else {
            const t = q[i] / p[i];
            if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
            else { if (t < t0) return null; if (t < t1) t1 = t; }
        }
    }
    return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
}

function recortarLinea(linea, bb) {
    const out = [];
    let actual = null;
    for (let i = 1; i < linea.length; i++) {
        const s = recortarSegmento(linea[i - 1], linea[i], bb);
        if (!s) { if (actual) { out.push(actual); actual = null; } continue; }
        if (actual && Math.hypot(actual[actual.length - 1][0] - s[0][0], actual[actual.length - 1][1] - s[0][1]) < 1e-6) actual.push(s[1]);
        else { if (actual) out.push(actual); actual = [s[0], s[1]]; }
    }
    if (actual) out.push(actual);
    return out.filter(l => l.length >= 2);
}

// Area de un MultiPolygon de polygon-clipping (anillo exterior menos huecos)
function areaMulti(mp) {
    let s = 0;
    for (const pol of mp || []) pol.forEach((r, k) => { s += (k === 0 ? 1 : -1) * Math.abs(shoelace(r)); });
    return s;
}

// Capsula (buffer redondo) de un segmento, en coordenadas locales
function capsula(a, b, w) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const N = 16;                   // vertices por semicirculo
    const ang = L < 1e-9 ? 0 : Math.atan2(b[1] - a[1], b[0] - a[0]);
    const pts = [];
    for (let k = 0; k <= N; k++) { const t = ang - Math.PI / 2 - Math.PI * k / N; pts.push([a[0] + w * Math.cos(t), a[1] + w * Math.sin(t)]); }
    for (let k = 0; k <= N; k++) { const t = ang + Math.PI / 2 - Math.PI * k / N; pts.push([b[0] + w * Math.cos(t), b[1] + w * Math.sin(t)]); }
    pts.push(pts[0]);
    return [pts];
}

// Poligonos de polygon-clipping a partir de las partes UTM de una feature
// catastral. El catastro guarda algunos predios multiparte como Polygon con
// varios anillos: el anillo contenido en el exterior es hueco, el que queda
// fuera es otra parte (mismo criterio que medirGeometria en el visor).
function poligonosCatastro(partes, o) {
    const loc = r => r.map(p => [p[0] - o[0], p[1] - o[1]]);
    const out = [];
    for (const anillos of partes) {
        const ext = anillos[0];
        if (!ext || ext.length < 4) continue;
        const pol = [loc(ext)];
        for (const r of anillos.slice(1)) {
            if (r.length < 4) continue;
            if (puntoEnAnillo(r[0], ext)) pol.push(loc(r));
            else out.push([loc(r)]);
        }
        out.push(pol);
    }
    return out;
}

const cerrar = r => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) ? r.concat([r[0]]) : r;

function rumbo(az) {
    const dms = g => {
        let d = Math.floor(g), mf = (g - d) * 60, m = Math.floor(mf), s = Math.round((mf - m) * 60);
        if (s === 60) { s = 0; m++; }
        if (m === 60) { m = 0; d++; }
        return `${d}°${String(m).padStart(2, '0')}'${String(s).padStart(2, '0')}"`;
    };
    let ns, ew, ang;
    if (az <= 90) { ns = 'N'; ew = 'E'; ang = az; }
    else if (az <= 180) { ns = 'S'; ew = 'E'; ang = 180 - az; }
    else if (az <= 270) { ns = 'S'; ew = 'O'; ang = az - 180; }
    else { ns = 'N'; ew = 'O'; ang = 360 - az; }
    return { rumbo: `${ns} ${dms(ang)} ${ew}`, azimutDMS: dms(az) };
}

function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let t = String(v === undefined || v === null ? '' : v).trim();
    const m = t.match(/-?\d[\d.,]*/);          // "≥30", "2.500", "230,5 m2"
    if (!m) return null;
    t = m[0];
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');          // miles con punto
    else if (/^\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, '');       // miles con coma
    else t = t.replace(',', '.');
    const n = parseFloat(t);
    return isFinite(n) ? n : null;
}

// ── Nombre de calle referencial (OpenStreetMap) ──────────────────────────────

const _osmCache = new Map();
let _osmUltima = 0;
async function calleOSM(lat, lon) {
    const k = lat.toFixed(4) + ',' + lon.toFixed(4);
    if (_osmCache.has(k)) return _osmCache.get(k);
    const espera = 1100 - (Date.now() - _osmUltima);
    if (espera > 0) await new Promise(r => setTimeout(r, espera));
    _osmUltima = Date.now();
    let nombre = null;
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=17&addressdetails=1`, {
            headers: { 'User-Agent': 'CAE-CH Planimetria local (cae-ch.org)', 'Accept-Language': 'es' }, signal: ctrl.signal
        });
        clearTimeout(t);
        if (r.ok) {
            const a = (await r.json()).address || {};
            nombre = a.road || a.pedestrian || a.footway || a.residential || a.path || null;
        }
    } catch (e) { nombre = null; }
    _osmCache.set(k, nombre);
    return nombre;
}

// ── Entorno para el mapa de ubicacion ───────────────────────────────────────
// Predios, vias y cursos de agua alrededor del predio, simplificados: el
// recuadro se dibuja a 1:5000 o menos y no necesita detalle centimetrico.
// Va aparte para poder rehacerlo al exportar un proyecto analizado con una
// version anterior, que no lo traia.
function entornoUbicacion(centro, capas, config) {
    const radio = ((config.tolerancias || {}).radio_ubicacion_m) || 250;
    const bb = [centro[0] - radio, centro[1] - radio, centro[0] + radio, centro[1] + radio];
    const vias = [], agua = [], predios = [];
    for (const f of capas.lineas_fabrica.consultar(bb, 0).slice(0, 2500)) {
        for (const p of partesUTM(f)) vias.push(simplificar(p[0], 1.5));
    }
    for (const k of Object.keys(capas).filter(k => k.startsWith('el:'))) {
        const capa = capas[k];
        if (!capa.disponible()) continue;
        const destino = capa.elemento.grupo === 'hidrografia' ? agua : capa.elemento.grupo === 'vialidad' ? vias : null;
        if (!destino) continue;
        for (const f of capa.consultar(bb, 0).slice(0, 400)) {
            for (const p of partesUTM(f)) destino.push(simplificar(p[0], 1.5));
        }
    }
    for (const f of capas.catastro.consultar(bb, 0).slice(0, 900)) {
        for (const anillos of partesUTM(f)) predios.push(simplificar(anillos[0], 1.5));
    }
    return { centro, radio, predios, vias, agua };
}

// ── Analisis ─────────────────────────────────────────────────────────────────

/**
 * @param {Array<{x,y,id,idCampo}>} vertices  anillo normalizado (horario)
 * @param {object} opciones  { tolLindero, margenes: {id: m}, osm: bool }
 * @param {object} capas     de crearCapas()
 * @param {object} config
 */
async function analizar(vertices, opciones, capas, config) {
    opciones = opciones || {};
    const tol = config.tolerancias || {};
    const tolLindero = num(opciones.tolLindero) || tol.lindero_m || 1.0;
    const nucleo = cargarNucleo({ LIND_TOL_M: tolLindero });
    const avisos = [];

    const P = vertices.map(v => [v.x, v.y]);
    const n = P.length;
    const areaFirmada = shoelace(P);
    const area = Math.abs(areaFirmada);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    P.forEach(p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
    const bbox = [x0, y0, x1, y1];
    const O = [Math.floor(x0) - 100, Math.floor(y0) - 100];     // origen local para el recorte
    const loc = r => r.map(p => [p[0] - O[0], p[1] - O[1]]);
    const glob = r => r.map(p => [p[0] + O[0], p[1] + O[1]]);
    const predioLoc = [[cerrar(loc(P))]];

    // Geometria en grados para las funciones del visor
    const ll = P.map(p => { const g = nucleo.utmToLatLng(p[0], p[1], 17, true); return [g[1], g[0]]; });
    const predioGeoJSON = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ll.concat([ll[0]])] } };

    // 1 ── Cuadro de coordenadas y lados ─────────────────────────────────────
    let perimetro = 0;
    const lados = P.map((a, i) => {
        const b = P[(i + 1) % n];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        perimetro += L;
        let az = Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI;
        if (az < 0) az += 360;
        return Object.assign({ i, desde: vertices[i].id, hasta: vertices[(i + 1) % n].id, L, azimut: az }, rumbo(az));
    });
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, f = P[i][0] * P[j][1] - P[j][0] * P[i][1];
        cx += (P[i][0] + P[j][0]) * f; cy += (P[i][1] + P[j][1]) * f;
    }
    const centroide = [cx / (6 * areaFirmada), cy / (6 * areaFirmada)];
    const centroLL = nucleo.utmToLatLng(centroide[0], centroide[1], 17, true);

    // 2 ── Catastro: vecinos, solapes y vertices ─────────────────────────────
    const vecinos = capas.catastro.consultar(bbox, Math.max(tolLindero, tol.vertice_catastral_m || 2) + 25);
    const solapes = [];
    const infoVecino = new Map();
    const vertCat = vertices.map(() => null);
    const radioVert = tol.vertice_catastral_m || 2;
    for (const f of vecinos) {
        const pu = partesUTM(f);
        const pr = f.props;
        const info = {
            clave: String(pr.claves || '').trim(),
            nombre: String(pr.gis_predio || pr.nombre_c || '').trim() || 'Sin identificar',
            areaCatastro: num(pr.Shape__Area)
        };
        infoVecino.set('cat:' + f.idx, info);
        try {
            const inter = pc.intersection(predioLoc, poligonosCatastro(pu, O));
            const a = areaMulti(inter);
            if (a >= 0.01) {
                const areaCat = Math.abs(areaMulti(pc.union(poligonosCatastro(pu, O)))) || info.areaCatastro || 0;
                solapes.push(Object.assign({ idx: f.idx }, info, {
                    area: r2(a), pctPredio: r2(100 * a / area), pctCatastral: areaCat ? r2(100 * a / areaCat) : null,
                    poligonos: inter.map(pol => pol.map(glob))
                }));
            }
        } catch (e) { avisos.push(`No se pudo recortar el predio catastral ${info.clave}: ${e.message}`); }
        for (const anillos of pu) for (const r of anillos) for (const q of r) {
            vertices.forEach((v, k) => {
                const d = Math.hypot(q[0] - v.x, q[1] - v.y);
                if (d <= radioVert && (!vertCat[k] || d < vertCat[k].dist)) vertCat[k] = { dist: Math.round(d * 1000) / 1000, clave: info.clave };
            });
        }
    }
    solapes.sort((a, b) => b.area - a.area);
    let diagnostico;
    const madre = solapes.find(s => s.pctPredio >= 90);
    if (madre) diagnostico = { tipo: 'contenido', texto: `El levantamiento cae dentro del predio catastral ${madre.clave} (${madre.nombre}) en un ${es(madre.pctPredio)} %: corresponde a un fraccionamiento o a una parte del predio madre, no a un predio sin catastrar.` };
    else if (solapes.some(s => s.area >= 1)) diagnostico = { tipo: 'solape', texto: `El levantamiento se superpone con ${solapes.filter(s => s.area >= 1).length} predio(s) catastral(es) en ${es(solapes.reduce((s, x) => s + x.area, 0))} m². Revise los linderos en campo antes de firmar.` };
    else if (solapes.length) diagnostico = { tipo: 'roce', texto: 'Solo hay solapes menores a 1 m² con el catastro, compatibles con la diferencia entre levantamiento y cartografía.' };
    else diagnostico = { tipo: 'libre', texto: 'El levantamiento no se superpone con ningún predio del catastro vigente.' };

    // 3 ── Linderos por tramo ────────────────────────────────────────────────
    const ladosV = nucleo.lindLadosPredio(predioGeoJSON);
    // Cada lado del visor se asocia al indice del lado levantado
    ladosV.forEach(lv => {
        let mejor = -1, md = Infinity;
        P.forEach((p, i) => { const d = Math.hypot(p[0] - lv.a[0], p[1] - lv.a[1]); if (d < md) { md = d; mejor = i; } });
        lv.i = mejor;
    });
    // El predio madre (o el propio predio, si se re-levanta uno catastrado) no
    // es colindante de si mismo: se excluye, igual que las claves que indique
    // el profesional.
    const excluir = new Set((opciones.excluirClaves || []).map(String));
    const excluidos = vecinos.filter(f => {
        const info = infoVecino.get('cat:' + f.idx);
        return excluir.has(info.clave) || solapes.some(s => s.idx === f.idx && s.pctPredio >= 90);
    });
    // lindMarcarVecino exige que los dos extremos de cada tramo del vecino
    // caigan sobre el lado. En campo el lindero lleva puntos intermedios (un
    // poste, un cambio de cerramiento) y el lado del vecino abarca varios lados
    // del levantamiento: se parte el contorno del vecino en la proyeccion de
    // cada vertice levantado que le queda cerca.
    const vecinoDensificado = f => {
        const partes = partesUTM(f).map(anillos => anillos.map(r => {
            const out = [];
            for (let i = 0; i < r.length; i++) {
                out.push(r[i]);
                if (i === r.length - 1) break;
                const a = r[i], b = r[i + 1];
                const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
                if (L2 < 1e-6) continue;
                const ts = [];
                for (const p of P) {
                    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
                    if (t * Math.sqrt(L2) < 0.001 || (1 - t) * Math.sqrt(L2) < 0.001) continue;
                    if (distPuntoSegmento(p, a, b) <= tolLindero) ts.push(t);
                }
                ts.sort((u, v) => u - v).forEach(t => out.push([a[0] + dx * t, a[1] + dy * t]));
            }
            return out.map(q => { const g = nucleo.utmToLatLng(q[0], q[1], 17, true); return [g[1], g[0]]; });
        }));
        return f.tipo === 'poligono' && partes.length === 1 ? { type: 'Polygon', coordinates: partes[0] } : { type: 'MultiPolygon', coordinates: partes };
    };
    for (const f of vecinos) if (!excluidos.includes(f)) nucleo.lindMarcarVecino(ladosV, vecinoDensificado(f), 'cat:' + f.idx);
    if (excluidos.length) avisos.push(`Se excluyó de los colindantes: ${excluidos.map(f => infoVecino.get('cat:' + f.idx).clave).join(', ')} (predio que contiene al levantamiento o indicado a mano).`);

    // Ejes y lineas de fabrica para reconocer el lado a calle
    const ventana = [x0 - 60, y0 - 60, x1 + 60, y1 + 60];
    const lfFeatures = capas.lineas_fabrica.consultar(bbox, 60);
    const ejesCert = Object.keys(capas).filter(k => k.startsWith('el:') && capas[k].elemento.grupo === 'vialidad')
        .flatMap(k => capas[k].disponible() ? capas[k].consultar(bbox, 60).map(f => ({ f, e: capas[k].elemento })) : []);
    const nombreDe = (props, campo) => {
        for (const c of [].concat(campo || [])) { const v = String(props[c] || '').trim(); if (v && v !== '0') return v; }
        return '';
    };
    const buscarVia = (pt, nx, ny) => {
        const alcance = tol.busqueda_via_m || 15;
        const fuera = [pt[0] + nx * alcance, pt[1] + ny * alcance];
        let mejor = null;
        const probar = (lineas, etiqueta) => {
            for (const l of lineas) for (let j = 1; j < l.length; j++) {
                // la via tiene que estar del lado exterior del lindero
                const d = distSegmentos(pt, fuera, l[j - 1], l[j]);
                if (d > 1.0) continue;
                const dm = distPuntoSegmento(pt, l[j - 1], l[j]);
                if (!mejor || dm < mejor.d) mejor = Object.assign({ d: dm }, etiqueta);
            }
        };
        for (const { f, e } of ejesCert) probar(partesUTM(f).map(p => p[0]), { nombre: nombreDe(f.props, e.nombre_campo), fuente: e.nombre });
        for (const f of lfFeatures) probar(partesUTM(f).map(p => p[0]), { nombre: '', fuente: f.props.Layer === 'A. EJES DE VIA' ? 'Eje de vía GADMR' : 'Línea de fábrica GADMR' });
        return mejor;
    };

    const piezas = [];
    for (const lv of ladosV) {
        const cortes = new Set([0, 1]);
        // Extremos a menos de 1 mm de un vertice se pegan al vertice
        const pegar = t => (t * lv.L < 0.001 ? 0 : (1 - t) * lv.L < 0.001 ? 1 : t);
        const cobertura = lv.vecinos.map(v => {
            const iv = v.tramos.map(x => [pegar(x[0]), pegar(x[1])]).sort((a, b) => a[0] - b[0]);
            const m = [];
            for (const x of iv) { const u = m[m.length - 1]; if (u && x[0] <= u[1] + 1e-9) u[1] = Math.max(u[1], x[1]); else m.push([x[0], x[1]]); }
            m.forEach(x => { cortes.add(x[0]); cortes.add(x[1]); });
            return { clave: v.nombre, iv: m, total: m.reduce((s, x) => s + x[1] - x[0], 0) };
        });
        const ts = [...cortes].sort((a, b) => a - b);
        const trozos = [];
        for (let k = 0; k + 1 < ts.length; k++) {
            const t0 = ts[k], t1 = ts[k + 1];
            if ((t1 - t0) * lv.L < 1e-4) continue;
            const tm = (t0 + t1) / 2;
            const cubren = cobertura.filter(c => c.iv.some(x => x[0] <= tm && tm <= x[1])).sort((a, b) => b.total - a.total);
            const et = cubren.length ? cubren[0].clave : null;
            const u = trozos[trozos.length - 1];
            if (u && u.et === et) u.t1 = t1; else trozos.push({ t0, t1, et, otros: cubren.slice(1).map(c => c.clave) });
        }
        // Trozos menores al lado minimo se absorben en el vecino mas largo
        const min = nucleo.LIND_MIN_M;
        for (let k = 0; k < trozos.length && trozos.length > 1; k++) {
            if ((trozos[k].t1 - trozos[k].t0) * lv.L >= min) continue;
            const ant = trozos[k - 1], sig = trozos[k + 1];
            const dest = !ant ? sig : !sig ? ant : ((ant.t1 - ant.t0) >= (sig.t1 - sig.t0) ? ant : sig);
            dest.t0 = Math.min(dest.t0, trozos[k].t0); dest.t1 = Math.max(dest.t1, trozos[k].t1);
            trozos.splice(k, 1); k = -1;
            for (let q = 1; q < trozos.length; q++) if (trozos[q].et === trozos[q - 1].et) { trozos[q - 1].t1 = trozos[q].t1; trozos.splice(q, 1); q--; }
        }
        for (const tr of trozos) {
            const pieza = { lado: lv.i, t0: tr.t0, t1: tr.t1, L: (tr.t1 - tr.t0) * lv.L, dir: lv.dir, nx: lv.nx, ny: lv.ny };
            if (tr.et) {
                const info = infoVecino.get(tr.et);
                Object.assign(pieza, { colindante: info.nombre, clave: info.clave, fuente: 'catastro', otros: tr.otros.map(o => infoVecino.get(o).clave) });
            } else {
                const tm = (tr.t0 + tr.t1) / 2;
                const pt = [lv.a[0] + (lv.b[0] - lv.a[0]) * tm, lv.a[1] + (lv.b[1] - lv.a[1]) * tm];
                const via = buscarVia(pt, lv.nx, lv.ny);
                pieza.puntoMedio = pt;
                if (via) Object.assign(pieza, { colindante: via.nombre ? 'Vía ' + via.nombre : 'Vía pública', clave: '', fuente: 'via', referencia: via.fuente, distanciaVia: r2(via.d), sinNombre: !via.nombre });
                else Object.assign(pieza, { colindante: '', clave: '', fuente: 'manual', pendiente: true });
            }
            piezas.push(pieza);
        }
    }
    // Lados cortos que el visor omite (< LIND_MIN_M): se pegan al tramo anterior
    const ladosCubiertos = new Set(piezas.map(p => p.lado));
    for (let i = 0; i < n; i++) if (!ladosCubiertos.has(i)) {
        const k = piezas.findIndex(p => p.lado === (i + n - 1) % n);
        if (k >= 0) piezas.splice(k + 1, 0, Object.assign({}, piezas[k], { lado: i, t0: 0, t1: 1, L: lados[i].L, corto: true }));
    }
    piezas.sort((a, b) => a.lado - b.lado || a.t0 - b.t0);

    if (opciones.osm) {
        const hechos = new Map();
        for (const p of piezas.filter(q => q.fuente === 'via' && q.sinNombre)) {
            const k = p.lado;
            if (!hechos.has(k)) {
                const pt = [p.puntoMedio[0] + p.nx * 8, p.puntoMedio[1] + p.ny * 8];
                const g = nucleo.utmToLatLng(pt[0], pt[1], 17, true);
                hechos.set(k, await calleOSM(g[0], g[1]));
            }
            const calle = hechos.get(k);
            if (calle) Object.assign(p, { colindante: 'Vía ' + calle, sinNombre: false, referencia: p.referencia + ' / nombre OSM (referencial)' });
        }
    }

    // Cortes que marca el profesional: vertices donde un lindero cambia de
    // colindante aunque el catastro no lo sepa (herederos, compradores nuevos).
    const cortes = new Set();
    for (const c of opciones.cortes || []) {
        const x = Number(c[0] !== undefined ? c[0] : c.x), y = Number(c[1] !== undefined ? c[1] : c.y);
        P.forEach((p, i) => { if (Math.hypot(p[0] - x, p[1] - y) < 0.005) cortes.add(i); });
    }

    // Tramos consecutivos con el mismo colindante y orientacion → un lindero
    const mismo = (a, b) => a.fuente === b.fuente && a.colindante === b.colindante && a.clave === b.clave && a.dir === b.dir
        && !(b.t0 < 1e-6 && cortes.has(b.lado));
    const grupos = [];
    for (const p of piezas) {
        const u = grupos[grupos.length - 1];
        if (u && mismo(u.piezas[u.piezas.length - 1], p)) u.piezas.push(p); else grupos.push({ piezas: [p] });
    }
    if (grupos.length > 1 && mismo(grupos[grupos.length - 1].piezas[0], grupos[0].piezas[0])) {
        const ult = grupos.pop();
        grupos[0].piezas = ult.piezas.concat(grupos[0].piezas);
    }
    const extremo = (lado, t) => {
        if (t < 1e-6) return { vertice: vertices[lado].id, texto: vertices[lado].id };
        if (t > 1 - 1e-6) { const v = vertices[(lado + 1) % n].id; return { vertice: v, texto: v }; }
        const m = t * lados[lado].L;
        return { vertice: null, texto: `punto a ${m.toFixed(2)} m de ${vertices[lado].id} hacia ${vertices[(lado + 1) % n].id}` };
    };
    const punto = (lado, t) => {
        const p = P[lado], q = P[(lado + 1) % n];
        return [Math.round((p[0] + (q[0] - p[0]) * t) * 1e4) / 1e4, Math.round((p[1] + (q[1] - p[1]) * t) * 1e4) / 1e4];
    };
    const linderos = grupos.map((g, k) => {
        const a = g.piezas[0], b = g.piezas[g.piezas.length - 1];
        const longitud = g.piezas.reduce((s, p) => s + p.L, 0);
        return {
            n: k + 1, dir: a.dir, colindante: a.colindante, clave: a.clave, fuente: a.fuente,
            referencia: a.referencia || (a.fuente === 'catastro' ? 'Catastro GADMR' : ''),
            pendiente: !!a.pendiente || !!a.sinNombre,
            desde: extremo(a.lado, a.t0).texto, hasta: extremo(b.lado, b.t1).texto,
            desdeXY: punto(a.lado, a.t0), hastaXY: punto(b.lado, b.t1),
            longitud: Math.round(longitud * 1000) / 1000,
            lados: [...new Set(g.piezas.map(p => p.lado))],
            // vertices interiores del lindero: donde el profesional puede cortarlo
            interiores: g.piezas.slice(1).filter(p => p.t0 < 1e-6).map(p => ({ id: vertices[p.lado].id, xy: P[p.lado] })),
            otros: [...new Set(g.piezas.flatMap(p => p.otros || []))]
        };
    });

    // Textos del DXF del profesional junto a cada lindero (nombres de
    // colindantes que ya dibujo): cada texto va al lindero mas cercano.
    const textos = (opciones.textos || []).filter(t => {
        const s = String(t.t || '').trim();
        return s.length >= 4 && /[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(s) && !/^(P|V)\d+$/i.test(s) && !/^[\d.,\s:m²2-]+$/.test(s)
            && !/^(norte|sur|este|oeste|ubicaci|planimetr|escala|[áa]rea|cuadro|lindero|pto|firma|fecha|clave|observaci|sistema|parroquia|reg\.|arq\.|ing\.)/i.test(sinTildes(s))
            && isFinite(t.x) && isFinite(t.y) && !puntoEnAnillo([t.x, t.y], P);
    });
    for (const t of textos) {
        let mejor = null;
        for (const li of linderos) {
            const d = Math.min(...li.lados.map(i => distPuntoSegmento([t.x, t.y], P[i], P[(i + 1) % n])));
            const alcance = Math.max(8, Math.min(40, 0.3 * li.longitud));
            if (d <= alcance && (!mejor || d < mejor.d)) mejor = { li, d };
        }
        if (mejor && (!mejor.li.sugerenciaDXF || mejor.d < mejor.li.sugerenciaDXF.d)) mejor.li.sugerenciaDXF = { texto: String(t.t).trim(), d: r2(mejor.d) };
    }
    for (const li of linderos) {
        if (li.sugerenciaDXF && li.fuente === 'manual' && !li.colindante) {
            Object.assign(li, { colindante: li.sugerenciaDXF.texto, fuente: 'dxf', referencia: 'Texto del DXF del levantamiento', pendiente: false });
        }
    }
    const pendientes = linderos.filter(l => l.fuente === 'manual').length;
    if (pendientes) avisos.push(`${pendientes} lindero(s) sin colindante catastral ni vía: complete el colindante a mano.`);

    // 4 ── Afectaciones ──────────────────────────────────────────────────────
    const piezasAfectadas = [];
    let lineaFabrica = null;
    try {
        const lfGeo = lfFeatures.map(f => ({ type: 'Feature', properties: f.props, geometry: geojsonWGS84(f) }));
        const r = nucleo.afectacionLF(predioGeoJSON, lfGeo);
        if (r) {
            lineaFabrica = {
                total: r.total, prolongada: r.lfProlongada,
                franjas: r.contornos.map(c => ({ area: c.area, anillo: c.utm }))
            };
            r.contornos.forEach(c => piezasAfectadas.push([cerrar(loc(c.utm))]));
            if (r.lfProlongada) avisos.push('La línea de fábrica municipal termina dentro del predio y se prolongó para cerrar la franja: verifique en campo.');
        }
    } catch (e) { avisos.push('No se pudo calcular la afectación por línea de fábrica: ' + e.message); }

    const elementos = [];
    for (const k of Object.keys(capas).filter(k => k.startsWith('el:'))) {
        const capa = capas[k], e = capa.elemento;
        if (!capa.disponible()) continue;
        const sobre = opciones.margenes && opciones.margenes[e.id] !== undefined && opciones.margenes[e.id] !== '' ? num(opciones.margenes[e.id]) : null;
        const margen = sobre !== null ? sobre : num(e.margen_m);
        const radio = Math.max(margen || 0, 50);
        const cercanos = [];
        const capsulas = [];
        const dibujo = [];
        for (const f of capa.consultar(bbox, radio)) {
            const pu = partesUTM(f);
            const lineasF = e.geometria === 'poligono' ? pu.flatMap(anillos => anillos) : pu.map(p => p[0]);
            let d = Infinity;
            for (const l of lineasF) d = Math.min(d, distAnilloLinea(P, l));
            if (e.geometria === 'poligono' && pu.some(anillos => P.some(p => puntoEnAnillo(p, anillos[0])))) d = 0;
            if (d > radio) continue;
            cercanos.push({ nombre: nombreDe(f.props, e.nombre_campo || 'nam') || '', distancia: r2(d), capa: f.origen });
            lineasF.forEach(l => recortarLinea(l, ventana).forEach(s => dibujo.push(s)));
            if (margen > 0 && d <= margen) {
                const alcance = [x0 - margen - 1, y0 - margen - 1, x1 + margen + 1, y1 + margen + 1];
                for (const l of lineasF) for (const s of recortarLinea(l, alcance)) {
                    for (let j = 1; j < s.length; j++) capsulas.push(capsula(loc([s[j - 1]])[0], loc([s[j]])[0], margen));
                }
                if (e.geometria === 'poligono') for (const anillos of pu) capsulas.push(anillos.map(r => cerrar(loc(r))));
            }
        }
        if (!cercanos.length) continue;
        let areaAf = 0, poligonos = [];
        if (capsulas.length) {
            try {
                // union por bloques: polygon-clipping acepta muchos operandos pero es mas estable asi
                let acum = null;
                for (let q = 0; q < capsulas.length; q += 200) {
                    const bloque = pc.union(...capsulas.slice(q, q + 200));
                    acum = acum ? pc.union(acum, bloque) : bloque;
                }
                const inter = pc.intersection(predioLoc, acum);
                areaAf = areaMulti(inter);
                poligonos = inter.map(pol => pol.map(glob));
                inter.forEach(pol => piezasAfectadas.push(pol));
            } catch (err) { avisos.push(`No se pudo calcular el margen de ${e.nombre}: ${err.message}`); }
        }
        cercanos.sort((a, b) => a.distancia - b.distancia);
        elementos.push({
            id: e.id, nombre: e.nombre, grupo: e.grupo, capaDXF: e.capa_dxf, colorDXF: e.color_dxf,
            margen, margenEditado: sobre !== null, verificado: !!e.verificado && sobre === null,
            baseLegal: sobre !== null ? 'Valor ingresado por el profesional responsable' : e.base_legal,
            distancia: cercanos[0].distancia, cercanos: cercanos.slice(0, 5),
            afecta: areaAf >= 0.01, area: r2(areaAf), poligonos, dibujo
        });
        if (margen === null && cercanos[0].distancia <= 50) avisos.push(`${e.nombre} a ${cercanos[0].distancia} m del predio sin margen definido: ingrese el ancho para calcular la afectación.`);
        if (e.grupo === 'hidrografia' && !e.verificado && sobre === null && areaAf > 0) avisos.push(`El margen de ${e.nombre} (${margen} m) es un valor por verificar en la ordenanza.`);
    }
    elementos.sort((a, b) => a.distancia - b.distancia);

    let areaAfectada = 0;
    if (piezasAfectadas.length) {
        try { areaAfectada = areaMulti(pc.intersection(predioLoc, pc.union(...piezasAfectadas))); }
        catch (e) { areaAfectada = (lineaFabrica ? lineaFabrica.total : 0) + elementos.reduce((s, x) => s + x.area, 0); avisos.push('Unión de afectaciones aproximada por suma (posible doble conteo).'); }
    }

    // 5 ── Ubicacion y normativa ─────────────────────────────────────────────
    const contiene = (capa) => capa.disponible()
        ? capa.consultar([centroide[0], centroide[1], centroide[0], centroide[1]], 1).find(f => partesUTM(f).some(anillos => puntoEnAnillo(centroide, anillos[0]) && !anillos.slice(1).some(h => puntoEnAnillo(centroide, h))))
        : null;
    const par = contiene(capas.parroquias);
    const urbano = contiene(capas.limite_urbano);
    const pugsF = contiene(capas.pugs);
    let pugs = null;
    if (pugsF) {
        const p = pugsF.props;
        pugs = {
            clasificacion: p.clas_suelo, subclasificacion: p.subc_suelo, codigo: p.codigo_pit, tratamiento: p.tratamient,
            loteMinimo: p.lote_min, frenteMinimo: p.f_min, retiros: { frontal: p.r_frontal, lateral: p.r_lateral, posterior: p.r_posterio },
            cos: p.cos_pb, cut: p.cos_total, pisos: p.edif_bas, implantacion: p.implantac, usoPrincipal: p.u_principa
        };
        const frente = Math.max(0, ...linderos.filter(l => l.fuente === 'via').map(l => l.longitud));
        const lm = num(p.lote_min), fm = num(p.f_min);
        pugs.verificacion = [
            lm !== null ? { item: 'Lote minimo', norma: `${lm.toLocaleString('es-EC', { useGrouping: false })} m²`, predio: `${es(area)} m²`, cumple: area >= lm } : null,
            fm !== null ? { item: 'Frente minimo', norma: `${fm} m`, predio: frente ? `${es(frente)} m` : 'sin frente a vía', cumple: frente >= fm } : null
        ].filter(Boolean);
        if (/PROTECCI/i.test(p.subc_suelo || '')) avisos.push(`El predio está en suelo de protección (${p.subc_suelo}).`);
    }

    // Contexto para dibujar (mapa y DXF)
    const contexto = {
        ubicacion: entornoUbicacion(centroide, capas, config),
        predios: vecinos.map(f => {
            const info = infoVecino.get('cat:' + f.idx);
            return { clave: info.clave, nombre: info.nombre, anillos: partesUTM(f).flatMap(a => a) };
        }).filter(v => v.anillos.some(r => r.some(p => p[0] >= ventana[0] && p[0] <= ventana[2] && p[1] >= ventana[1] && p[1] <= ventana[3]))),
        lineasFabrica: lfFeatures.flatMap(f => partesUTM(f).flatMap(p => recortarLinea(p[0], ventana))),
        ventana
    };

    return {
        generado: new Date().toISOString(),
        tolLindero,
        vertices: vertices.map((v, k) => {
            const g = nucleo.utmToLatLng(v.x, v.y, 17, true);
            return { id: v.id, idCampo: v.idCampo, cod: v.cod, x: v.x, y: v.y, lat: g[0], lon: g[1], catastral: vertCat[k] };
        }),
        lados: lados.map(l => Object.assign(l, { L: Math.round(l.L * 1000) / 1000, azimut: Math.round(l.azimut * 1e4) / 1e4 })),
        area: r2(area), perimetro: r2(perimetro), centroide, centro: { lat: centroLL[0], lon: centroLL[1] },
        catastro: { diagnostico, solapes },
        linderos,
        resumenLinderos: DIRS.map(d => ({ dir: d, longitud: r2(linderos.filter(l => l.dir === d).reduce((s, l) => s + l.longitud, 0)) })),
        afectaciones: {
            lineaFabrica, elementos,
            areaAfectada: r2(areaAfectada), areaUtil: r2(area - areaAfectada)
        },
        ubicacion: {
            parroquia: par ? par.props.DPA_DESPAR : null, codigoParroquia: par ? par.props.DPA_PARROQ : null,
            zona: urbano ? 'Urbana' : (par ? 'Rural' : null), pugs
        },
        contexto,
        avisos
    };
}

module.exports = { analizar, entornoUbicacion, rumbo, shoelace, capsula, areaMulti, recortarLinea, distAnilloLinea, num };

};

// ── lib/conciliacion.js ────────────────────────────────────────────────
__defs["conciliacion"] = function (module, exports, require) {
const __dirname = "/lib", __filename = "/lib/conciliacion.js";
const Buffer = __Buffer;
// ─────────────────────────────────────────────────────────────────────────────
//  Conciliacion: titulo registral (antes) frente al levantamiento (hoy)
//
//  Las escrituras antiguas describen el predio con orientaciones relativas
//  (frente, fondo, derecho, izquierdo) o cardinales, medidas redondeadas y los
//  colindantes de su epoca. El levantamiento mide lo que existe hoy. Aqui se
//  emparejan lado a lado y se declaran las diferencias sin corregir ninguna de
//  las dos fuentes:
//    · a que lado del levantamiento corresponde cada lindero del titulo;
//    · diferencia de longitud (m y %) y de colindante (mismo, cambio, dividido);
//    · evolucion historica del lindero entre los actos inscritos;
//    · diferencia de superficie frente al error tecnico aceptable (ETAM) y su
//      encuadre como excedente o diferencia (COOTAD art. 481.1).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const { sinAcentos } = require('./registral');

const VEC = { Norte: [0, 1], Este: [1, 0], Sur: [0, -1], Oeste: [-1, 0] };
const DIRS = Object.keys(VEC);
const INTER = { Noreste: ['Norte', 'Este'], Noroeste: ['Norte', 'Oeste'], Sureste: ['Sur', 'Este'], Suroeste: ['Sur', 'Oeste'] };
const r2 = v => Math.round(v * 100) / 100;
const dirDe = v => DIRS.reduce((m, d) => (VEC[d][0] * v[0] + VEC[d][1] * v[1] > VEC[m][0] * v[0] + VEC[m][1] * v[1] ? d : m), 'Norte');

const VACIAS = new Set(['PROPIEDAD', 'PROPIEDADES', 'DE', 'DEL', 'LA', 'LAS', 'LOS', 'EL', 'FAMILIA', 'FLIA', 'SR', 'SRA', 'SENOR', 'SENORA', 'HEREDEROS', 'HRDS', 'SUCESORES', 'SUCESION',
    'TERRENO', 'TERRENOS', 'LOTE', 'Y', 'EN', 'CON', 'SIN', 'NOMBRE', 'PREDIO', 'BIEN', 'INMUEBLE', 'DON', 'DONA', 'LOS', 'PARTE']);
const RE_VIA = /\b(calle|via|camino|carretera|pasaje|avenida|av\.|sendero|chaquinan|callejon|vereda|acceso|transversal|pasaje peatonal)\b/i;
const RE_AGUA = /\b(quebrada|rio|acequia|canal|zanja|vertiente|estero|laguna)\b/i;

function tokens(s) {
    return sinAcentos(s).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length >= 3 && !VACIAS.has(t));
}
function similitud(a, b) {
    const ta = new Set(tokens(a)), tb = new Set(tokens(b));
    if (!ta.size || !tb.size) return 0;
    let c = 0; for (const t of ta) if (tb.has(t)) c++;
    return c / Math.min(ta.size, tb.size);
}
// "propiedad de la familia Quinzo Calderon" → "familia Quinzo Calderon" (para rotular)
const nombreCorto = s => String(s || '').replace(/^\s*(?:con\s+)?(?:(?:la\s+)?propiedad(?:es)?|terrenos?|lotes?|predios?)\s+(?:de\s+)?(?:(?:el|la|los|las)\s+)?(?:(?:se[nñ]or|se[nñ]ora|sr\.?|sra\.?)\s+)?/i, '').trim();
const tipoColindante = s => RE_VIA.test(sinAcentos(s)) ? 'via' : RE_AGUA.test(sinAcentos(s)) ? 'agua' : 'persona';

function aM2(area, config) {
    if (!area || area.valor === null || area.valor === undefined) return null;
    const f = area.unidad === 'ha' ? 10000 : area.unidad === 'cuadra' ? ((config.conciliacion || {}).cuadra_m2 || 7056) : 1;
    return area.valor * f;
}

/**
 * Asigna cada lindero del titulo a una orientacion del levantamiento.
 * `frente` (Norte/Sur/Este/Oeste) resuelve las orientaciones relativas.
 */
function asignarOrientaciones(linderosReg, hoyPorDir, frente) {
    const asignados = [], sinAsignar = [];
    const laterales = frente ? (() => {
        const v = VEC[frente], dentro = [-v[0], -v[1]];
        return { fondo: dirDe(dentro), derecho: dirDe([dentro[1], -dentro[0]]), izquierdo: dirDe([-dentro[1], dentro[0]]) };
    })() : null;
    const ambiguos = [];
    for (const l of linderosReg) {
        const o = l.orientacion;
        let dir = null;
        if (VEC[o]) dir = o;
        else if (INTER[o]) {
            const [a, b] = INTER[o];
            const la = hoyPorDir[a] || 0, lb = hoyPorDir[b] || 0;
            dir = l.longitud ? (Math.abs(la - l.longitud) <= Math.abs(lb - l.longitud) ? a : b) : (la >= lb ? a : b);
        } else if (o === 'frente') dir = frente;
        else if (laterales && laterales[o]) dir = laterales[o];
        else if (o === 'un lado' || o === 'otro lado') { ambiguos.push(l); continue; }
        if (dir) asignados.push({ l, dir }); else sinAsignar.push(l);
    }
    // "un lado" / "otro lado" sin derecho ni izquierdo: los dos laterales libres, por longitud
    if (ambiguos.length && laterales) {
        const libres = [laterales.derecho, laterales.izquierdo].filter(d => !asignados.some(x => x.dir === d));
        for (const l of ambiguos) {
            if (!libres.length) { sinAsignar.push(l); continue; }
            libres.sort((a, b) => Math.abs((hoyPorDir[a] || 0) - (l.longitud || 0)) - Math.abs((hoyPorDir[b] || 0) - (l.longitud || 0)));
            asignados.push({ l, dir: libres.shift(), porLongitud: true });
        }
    } else sinAsignar.push(...ambiguos);
    return { asignados, sinAsignar };
}

/**
 * @param {object} analisis  resultado de analizar() (con las ediciones del profesional)
 * @param {object} registral linderos, area, historia (de leerCertificado o a mano)
 * @param {object} opciones  { frente, zona }
 * @param {object} config
 */
function conciliar(analisis, registral, opciones, config) {
    opciones = opciones || {};
    const conf = config.conciliacion || {};
    const avisos = [];
    const linderosHoy = analisis.linderos || [];
    const hoyPorDir = {};
    for (const l of linderosHoy) hoyPorDir[l.dir] = (hoyPorDir[l.dir] || 0) + l.longitud;

    // Frente: el que indique el profesional; si no, la via mas larga del
    // levantamiento, siempre que el titulo describa un frente a via.
    let frente = VEC[opciones.frente] ? opciones.frente : null, origenFrente = frente ? 'profesional' : null;
    const reg = (registral && registral.linderos) || [];
    const usaRelativas = reg.some(l => ['frente', 'fondo', 'derecho', 'izquierdo', 'un lado', 'otro lado'].includes(l.orientacion));
    if (!frente && usaRelativas) {
        const vias = linderosHoy.filter(l => (l.tipo || l.fuente) === 'via' || RE_VIA.test(sinAcentos(l.colindante)));
        if (vias.length) {
            const porDir = {};
            vias.forEach(v => { porDir[v.dir] = (porDir[v.dir] || 0) + v.longitud; });
            frente = Object.keys(porDir).sort((a, b) => porDir[b] - porDir[a])[0];
            origenFrente = 'via del levantamiento';
        } else {
            const rf = reg.find(l => l.orientacion === 'frente');
            if (rf && rf.longitud) {
                frente = DIRS.filter(d => hoyPorDir[d]).sort((a, b) => Math.abs(hoyPorDir[a] - rf.longitud) - Math.abs(hoyPorDir[b] - rf.longitud))[0] || null;
                if (frente) { origenFrente = 'longitud mas parecida'; avisos.push(`El frente del titulo se ubico al ${frente} solo por longitud: confirmelo.`); }
            }
        }
        if (!frente) avisos.push('El titulo usa frente/fondo/derecho/izquierdo y no se pudo ubicar el frente: indiquelo.');
    }

    const { asignados, sinAsignar } = asignarOrientaciones(reg, hoyPorDir, frente);
    if (sinAsignar.length) avisos.push(`${sinAsignar.length} lindero(s) del titulo sin orientacion asignable.`);

    // Historia: la misma asignacion para cada acto con linderos
    const historia = ((registral && registral.historia) || []).map(h => ({
        fecha: h.fecha, acto: h.acto, n: h.n,
        asignados: asignarOrientaciones(h.linderos || [], hoyPorDir, frente).asignados,
        area: h.area ? aM2(h.area, config) : null
    }));

    const tolAbs = conf.tolerancia_longitud_m !== undefined ? conf.tolerancia_longitud_m : 0.10;
    const tolPct = conf.tolerancia_longitud_pct !== undefined ? conf.tolerancia_longitud_pct : 1;
    const lados = DIRS.filter(d => hoyPorDir[d] || asignados.some(a => a.dir === d)).map(dir => {
        const regs = asignados.filter(a => a.dir === dir);
        const hoy = linderosHoy.filter(l => l.dir === dir);
        const regLong = regs.some(a => a.l.longitud !== null && a.l.longitud !== undefined) ? regs.reduce((s, a) => s + (a.l.longitud || 0), 0) : null;
        const hoyLong = hoy.reduce((s, l) => s + l.longitud, 0);
        const dif = regLong !== null ? hoyLong - regLong : null;
        const pct = regLong ? dif / regLong * 100 : null;
        const estadoLongitud = dif === null ? 'sin_dato' : Math.abs(dif) <= Math.max(tolAbs, regLong * tolPct / 100) ? 'coincide' : 'difiere';

        const regNombre = regs.map(a => nombreCorto(a.l.colindante)).filter(Boolean).join(' / ');
        const vivos = hoy.filter(l => String(l.colindante || '').trim());
        let estadoColindante = 'sin_dato', sim = 0;
        if (regNombre && vivos.length) {
            const tipoReg = tipoColindante(regNombre);
            sim = Math.max(...vivos.map(l => {
                if (tipoReg === 'via' && ((l.tipo || l.fuente) === 'via' || tipoColindante(l.colindante) === 'via')) return 1;
                if (tipoReg === 'agua' && tipoColindante(l.colindante) === 'agua') return 1;
                return similitud(regNombre, l.colindante);
            }));
            // El profesional anoto quien era el colindante en el titulo: el cambio esta explicado
            const documentado = vivos.every(l => l.antecesor && similitud(regNombre, l.antecesor) >= 0.5);
            const personas = new Set(vivos.map(l => sinAcentos(l.colindante).toUpperCase().trim()));
            if (sim >= 0.5 && personas.size === 1) estadoColindante = 'mismo';
            else if (personas.size > 1 && regs.length <= 1) estadoColindante = documentado ? 'dividido_documentado' : 'dividido';
            else estadoColindante = documentado ? 'cambio_documentado' : 'cambio';
        }
        const hist = historia.map(h => {
            const a = h.asignados.filter(x => x.dir === dir);
            if (!a.length) return null;
            return { fecha: h.fecha, acto: h.acto, colindante: a.map(x => x.l.colindante).join(' / '), longitud: a.some(x => x.l.longitud) ? r2(a.reduce((s, x) => s + (x.l.longitud || 0), 0)) : null };
        }).filter(Boolean);
        return {
            dir,
            relativo: regs.map(a => a.l.orientacion).filter(o => !VEC[o]).join(' / ') || null,
            registral: regs.length ? { colindante: regNombre, longitud: regLong !== null ? r2(regLong) : null, textos: regs.map(a => a.l.texto).filter(Boolean), porLongitud: regs.some(a => a.porLongitud) } : null,
            hoy: { longitud: Math.round(hoyLong * 1000) / 1000, linderos: hoy.map(l => ({ n: l.n, desde: l.desde, hasta: l.hasta, colindante: l.colindante, fuente: l.fuente, tipo: l.tipo, longitud: l.longitud, clave: l.clave })) },
            dif: dif !== null ? r2(dif) : null, pct: pct !== null ? r2(pct) : null, estadoLongitud,
            estadoColindante, similitud: r2(sim),
            historia: hist
        };
    });

    // Superficie frente al ETAM
    const areaReg = aM2(registral && registral.area, config);
    let area = null;
    if (areaReg) {
        const zona = opciones.zona || (analisis.ubicacion && analisis.ubicacion.zona) || 'Rural';
        const etam = zona === 'Urbana' ? conf.etam_urbano_pct : conf.etam_rural_pct;
        const dif = analisis.area - areaReg, pct = dif / areaReg * 100;
        let estado = 'sin_etam';
        if (etam !== null && etam !== undefined) estado = Math.abs(pct) <= etam ? 'dentro' : pct > 0 ? 'excedente' : 'diferencia';
        const unidad = registral.area.unidad;
        const textoEtam = etam === null || etam === undefined ? 'sin ETAM configurado'
            : estado === 'dentro' ? `dentro del error técnico aceptable de medición (${etam} % en zona ${zona.toLowerCase()})`
                : `fuera del error técnico aceptable de medición (${etam} % en zona ${zona.toLowerCase()}): ${estado === 'excedente' ? 'excedente' : 'diferencia'} de superficie que se regulariza según el art. 481.1 del COOTAD y la ordenanza municipal`;
        area = {
            registral: r2(areaReg), registralOriginal: unidad !== 'm2' ? `${registral.area.valor} ${unidad === 'ha' ? 'ha' : 'cuadras'}` : null,
            medida: analisis.area, dif: r2(dif), pct: r2(pct), zona, etamPct: etam, etamVerificado: !!conf.etam_verificado, estado,
            texto: `La superficie medida (${fmtEs(analisis.area)} m²) ${dif >= 0 ? 'supera' : 'es menor que'} la registral (${fmtEs(areaReg)} m²) en ${fmtEs(Math.abs(dif))} m² (${fmtEs(Math.abs(pct))} %), ${textoEtam}.`
        };
        if (unidad === 'cuadra') avisos.push(`El titulo expresa la superficie en cuadras; se uso 1 cuadra = ${(conf.cuadra_m2 || 7056)} m² (verifique la equivalencia local).`);
        if (estado === 'excedente' || estado === 'diferencia') avisos.push(area.texto);
    }

    const cambios = lados.filter(l => l.estadoColindante === 'cambio' || l.estadoColindante === 'dividido');
    if (cambios.length) avisos.push(`Colindantes distintos a los del título sin relación anotada en: ${cambios.map(l => l.dir).join(', ')}. Anote en cada lindero quién consta en el título y la relación (heredero, comprador, posesionario).`);

    // ¿El catastro ya tiene este predio? Si la clave del titulo es la del
    // predio catastral que contiene al levantamiento, no es un fraccionamiento.
    let predioCatastral = null;
    const solape = analisis.catastro && analisis.catastro.solapes && analisis.catastro.solapes[0];
    if (solape && registral && registral.claveCatastral) {
        const k = s => String(s || '').replace(/\D/g, '').slice(0, 18);
        predioCatastral = { clave: solape.clave, pct: solape.pctPredio, coincide: k(solape.clave) === k(registral.claveCatastral) && solape.pctPredio >= 90 };
    }

    return { frente, origenFrente, usaRelativas, lados, sinAsignar, area, predioCatastral, avisos };
}

function fmtEs(v) { return Number(v).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }); }

module.exports = { conciliar, similitud, asignarOrientaciones, aM2 };

};

// ── lib/registral.js ───────────────────────────────────────────────────
__defs["registral"] = function (module, exports, require) {
const __dirname = "/lib", __filename = "/lib/registral.js";
const Buffer = __Buffer;
// ─────────────────────────────────────────────────────────────────────────────
//  Informacion registral: certificado de gravamenes del Registro de la
//  Propiedad del canton Riobamba
//
//  Lee el PDF (el Registro lo emite con texto, no escaneado), reconstruye las
//  lineas por coordenada y extrae lo que la planimetria necesita: ficha,
//  propietarios, clave, linderos y area registrales, movimientos y gravamenes.
//  Los linderos tambien se buscan dentro de las observaciones de cada
//  movimiento: ahi esta la historia del titulo (la sentencia de 2009 y la
//  rectificacion posterior pueden dar medidas distintas).
//
//  Todo lo extraido es una propuesta: el profesional lo revisa y corrige en
//  pantalla. Un certificado escaneado no trae texto y se llena a mano.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const path = require('path');

let _pdfjs = null, _fuentes = null;

/**
 * En el navegador pdf.js llega por <script> y las fuentes estandar por CDN;
 * aqui se le entregan en vez de buscarlas en node_modules.
 */
function fijarPDFJS(lib, urlFuentes) { _pdfjs = lib; _fuentes = urlFuentes || null; }

async function pdfjs() {
    if (!_pdfjs) {
        const ruta = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs');
        _pdfjs = await import('file:///' + ruta.replace(/\\/g, '/').replace(/ /g, '%20'));
    }
    return _pdfjs;
}

/** Carpeta de las fuentes estandar de pdf.js. */
function fuentesPDF() {
    if (_fuentes) return _fuentes;
    return (path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep)
        .replace(/\\/g, '/');
}

/** Texto del PDF en lineas, respetando el orden visual de cada pagina. */
async function textoPDF(buffer) {
    const lib = await pdfjs();
    const doc = await lib.getDocument({
        data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0,
        standardFontDataUrl: fuentesPDF()
    }).promise;
    const paginas = [];
    for (let p = 1; p <= doc.numPages; p++) {
        const tc = await (await doc.getPage(p)).getTextContent();
        const filas = [];
        for (const it of tc.items) {
            if (!it.str || !it.str.trim()) continue;
            const y = it.transform[5], x = it.transform[4];
            let f = filas.find(q => Math.abs(q.y - y) <= 2.5);
            if (!f) filas.push(f = { y, items: [] });
            f.items.push({ x, s: it.str });
        }
        filas.sort((a, b) => b.y - a.y);
        paginas.push(filas.map(f => f.items.sort((a, b) => a.x - b.x).map(i => i.s).join(' ').replace(/\s+/g, ' ').trim()));
    }
    await doc.destroy();
    return paginas;
}

// ── Utilidades de texto ──────────────────────────────────────────────────────

const sinAcentos = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const numero = s => {
    let t = String(s).trim();
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
    else t = t.replace(',', '.');
    const n = parseFloat(t);
    return isFinite(n) ? n : null;
};
const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
function fechaTexto(s) {
    const m = sinAcentos(s).toLowerCase().match(/(\d{1,2})\s+(?:de\s+)?([a-z]+)\s+(?:del?\s+)?(\d{4})/);
    if (m && MESES[m[2]]) return `${m[3]}-${String(MESES[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const iso = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
    return iso ? iso[0] : null;
}

// ── Linderos en texto libre ──────────────────────────────────────────────────

// Orientaciones que usan escrituras y sentencias. Las relativas (frente,
// fondo, derecho, izquierdo) se resuelven despues contra el levantamiento.
const ORIENT = [
    [/\bnor\s*-?\s*(?:oriente|este)\b/, 'Noreste'], [/\bnor\s*-?\s*(?:occidente|oeste)\b/, 'Noroeste'],
    [/\bsur\s*-?\s*(?:oriente|este)\b/, 'Sureste'], [/\bsur\s*-?\s*(?:occidente|oeste)\b/, 'Suroeste'],
    [/\bnorte\b/, 'Norte'], [/\bsur\b/, 'Sur'], [/\b(?:este|oriente)\b/, 'Este'], [/\b(?:oeste|occidente|poniente)\b/, 'Oeste'],
    [/\bfrente\b/, 'frente'], [/\bfondo\b|\bparte posterior\b|\bposterior\b|\batras\b/, 'fondo'],
    [/\b(?:lado )?derecho\b/, 'derecho'], [/\b(?:lado )?izquierdo\b/, 'izquierdo'],
    [/\bun lado\b/, 'un lado'], [/\botro lado\b/, 'otro lado']
];
const RE_INICIO = /(?:^|[;:.\n]|\by,?\s|(?=\bpor el\s))\s*(?:por el\s+|al\s+|hacia el\s+|lindero\s+)?(?:lado\s+)?(frente|fondo|parte posterior|derecho|izquierdo|un lado|otro lado|nor\s*-?\s*(?:oriente|occidente|este|oeste)|sur\s*-?\s*(?:oriente|occidente|este|oeste)|norte|sur|este|oeste|oriente|occidente|poniente)\b\s*[:,.-]?/gi;

function orientacionDe(t) {
    const s = sinAcentos(t).toLowerCase();
    for (const [re, o] of ORIENT) if (re.test(s)) return o;
    return null;
}

function limpiarColindante(t) {
    return String(t)
        .replace(/[`´'"]+/g, '')
        .replace(/\b(?:con|en|de|mide|mediante|y)\s*$/i, '')
        .replace(/^\s*(?:con|y)\s+/i, '')
        .replace(/\s*[,;:.-]+\s*$/, '')
        .replace(/^\s*[,;:.-]+\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Linderos de un texto de escritura o certificado:
 *   "Por el frente: calle publica sin nombre, con 13,44 m"
 *   "NORTE: propiedad de X en 120,50 metros; SUR: quebrada ..."
 *   "Por el lado derecho propiedad de Y ... con 17.24 mts"
 */
function parsearLinderos(texto) {
    const t = String(texto || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ');
    const marcas = [];
    let m;
    RE_INICIO.lastIndex = 0;
    while ((m = RE_INICIO.exec(t))) {
        const ini = m.index + m[0].search(/[A-Za-zÁÉÍÓÚáéíóú]/);
        marcas.push({ ini, fin: RE_INICIO.lastIndex, palabra: m[1] });
    }
    const out = [];
    for (let k = 0; k < marcas.length; k++) {
        let trozo = t.slice(marcas[k].fin, k + 1 < marcas.length ? marcas[k + 1].ini : t.length).replace(/\s+/g, ' ');
        // Despues de la primera medida el lindero termina en el siguiente ";" o
        // punto seguido: lo que viene ya es otra frase (area, gravamenes...).
        // "en dos tramos de 40 m y 25 m" sigue siendo el mismo lindero.
        const med = trozo.match(/\d+(?:[.,]\d+)?\s*(?:m\b|mts?\b|metros?\b|ml\b|m\.)/i);
        if (med) {
            const desde = med.index + med[0].length;
            const corte = trozo.slice(desde).search(/;|\.\s+(?=[A-ZÁÉÍÓÚ])|\.-|\s-\s|`/);
            if (corte >= 0) trozo = trozo.slice(0, desde + corte);
        }
        let orient = orientacionDe(marcas[k].palabra);
        let resto = trozo;
        // "Por el un lado: derecho, propiedad de ..." → la orientacion real va dentro
        if (orient === 'un lado' || orient === 'otro lado') {
            const dentro = resto.match(/^\s*[:,]?\s*(?:lado\s+)?(derecho|izquierdo)\b[\s,:]*/i);
            if (dentro) { orient = dentro[1].toLowerCase(); resto = resto.slice(dentro[0].length); }
        }
        const medidas = [...resto.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:m\b|mts?\b|metros?\b|ml\b|m\.)/gi)].map(x => numero(x[1])).filter(v => v !== null && v > 0);
        if (!medidas.length && marcas[k].palabra.length < 4) continue;   // "este" suelto sin medida: no es un lindero
        const colindante = limpiarColindante(resto
            .replace(/,?\s*(?:separad[oa]s?|dividid[oa])\b.*?(?=\bcon\s+\d|\ben\s+\d|$)/i, '')
            .replace(/(?:,?\s*(?:con|en|de|y)\s+)?(?:una (?:extension|longitud|distancia) de\s+)?\d+(?:[.,]\d+)?\s*(?:m\b|mts?\b|metros?\b|ml\b|m\.)(?:\s*(?:lineales|aproximadamente))?/gi, ' '));
        if (!colindante && !medidas.length) continue;
        out.push({
            orientacion: orient,
            colindante,
            longitud: medidas.length ? Math.round(medidas.reduce((s, v) => s + v, 0) * 100) / 100 : null,
            tramos: medidas.length > 1 ? medidas : undefined,
            texto: (marcas[k].palabra + ' ' + trozo).trim().replace(/[;.,\s]+$/, '')
        });
    }
    return out;
}

const RE_UNIDAD = '(m2|m²|m 2|metros cuadrados|mts2|mts\\.? ?2|hectareas?|has?\\b|cuadras?\\b)';
// ¿Son la misma persona dos nombres escritos de forma distinta?
// Vale el mismo juego de apellidos y nombres, o que uno sea el otro sin el
// ultimo nombre ("GUAMINGA INGUILLAY FANNY" y "... FANNY YOLANDA"). No vale
// el parecido suelto: "QUINZO CALDERON MARIA INES" y "QUINZO CALDERON MARIA
// LUCRECIA" son dos hermanas, no una persona.
function mismaPersona(a, b) {
    const t = x => new Set(sinAcentos(x).toUpperCase().replace(/[^A-Z ]/g, " ").split(" ").filter(w => w.length >= 3));
    const ta = t(a), tb = t(b);
    if (ta.size < 2 || tb.size < 2) return false;
    const [corto, largo] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
    let c = 0; for (const w of corto) if (largo.has(w)) c++;
    if (c === corto.size && c === largo.size) return true;              // mismo juego
    return c === corto.size && corto.size >= 3;                          // uno es el otro sin el ultimo nombre
}

function parsearArea(texto) {
    const t = sinAcentos(texto).replace(/\s+/g, ' ');
    let m = t.match(new RegExp('(?:area total|superficie(?: total)?|area|cabida|extension)\\s*(?:de|:|es de|aproximada de)?\\s*(\\d[\\d.,]*)\\s*' + RE_UNIDAD, 'i'));
    // "... corresponde a DOSCIENTOS ... (231,77 m²)": la cifra entre parentesis
    if (!m) m = t.match(new RegExp('(?:superficie|area|cabida)[^.;]{0,200}?\\(\\s*(\\d[\\d.,]*)\\s*' + RE_UNIDAD + '\\s*\\)', 'i'));
    if (!m) return null;
    const valor = numero(m[1]);
    const u = m[2].toLowerCase();
    const unidad = /metro|m2|m²|m 2|mts/.test(u) ? 'm2' : /hect|^ha/.test(u) ? 'ha' : 'cuadra';
    return { valor, unidad, texto: m[0].trim() };
}

// Fila de la tabla "a. Apellidos, Nombres y Domicilio de las Partes":
//   [calidad] [cedula/RUC] NOMBRE   Estado civil   Representante
// La calidad va en lista cerrada: con la bandera /i un comodin como
// [A-Z][a-z]+ se traga el primer apellido y lo declara "calidad".
const CALIDADES = 'Beneficiari[oa]|Demandad[oa]|Demandante|Actor[a]?|Aclarante|Otorgante-?[ ]*(?:Propietari[oa])?|Propietari[oa]|Comprador[a]?|Vendedor[a]?|Autoridad(?:[ ]+Competente)?|Hereder[oa]|Causante|Donante|Donatari[oa]|Adjudicatari[oa]|Acreedor[a]?|Deudor[a]?|Apoderad[oa]|Representante(?:[ ]+Legal)?|Arrendatari[oa]|Arrendador[a]?|Poseedor[a]?|C[oó]nyuge|Usufructuari[oa]|Nud[oa][ ]+Propietari[oa]|Socio|Accionista';
const ESTADOS = 'Desconocido|Ninguno|Casad[oa]|Solter[oa]|Divorciad[oa]|Viud[oa]|Uni[oó]n de hecho';
const RE_PARTE = new RegExp('^(?:(' + CALIDADES + ')[ ]+)?(?:([0-9]{10}(?:[0-9]{3})?)[ ]+)?(.+?)[ ]+(' + ESTADOS + ')(?:/a)?(?![A-Za-z])');

// ── Certificado de gravamenes (Registro de la Propiedad de Riobamba) ─────────

const normalizarCalidad = c => String(c || '').replace(/[- ]+$/, '').replace(/^Otorgante$/i, 'Otorgante propietario').trim();

function parsearCertificado(paginas) {
    const lineas = paginas.flat();
    const todo = lineas.join('\n');
    const avisos = [];
    const buscar = (re, g = 1) => { const m = todo.match(re); return m ? m[g].trim() : null; };

    const r = {
        tipo: 'certificado_gravamenes',
        ficha: buscar(/Ficha Registral(?: Nro)?\s*:?\s*(\d+)/i) || buscar(/\*(\d{3,})\*/),
        certificado: (buscar(/certificado Nro\s*:?\s*([\d.,]+)/i) || '').replace(/[.,]+$/, '') || null,
        emitido: fechaTexto(buscar(/Emitido a las:[^\n]*?del\s+([^\n]+)/i) || '') || fechaTexto(buscar(/FECHA IMPRESION:\s*([^\n]+)/i) || ''),
        revisadoHasta: fechaTexto(buscar(/REVISI[OÓ]N SE REALIZA HASTA EL\s*([^\n.]+)/i) || '') || null,
        parroquia: buscar(/PARROQUIA:\s*([^\n]+)/i),
        claveCatastral: null,
        ubicacion: null,
        propietarios: [],
        linderos: [],
        area: null,
        movimientos: [],
        detalle: [],
        gravamenes: null,
        avisos
    };
    // Mayusculas del Registro con numeros pegados a letras (ej. "17,24m")
    if (r.parroquia) r.parroquia = r.parroquia.replace(/\s{2,}.*/, '');

    const clave = buscar(/COD\. CATASTRAL[^:]*:\s*([\d-]+)/i);
    if (clave) r.claveCatastral = clave.replace(/-/g, '');

    // Propietarios: bloque entre "Propietario(s):" y "SITUACION ACTUAL"
    const iProp = lineas.findIndex(l => /^Propietario\(s\):/i.test(l));
    const iSit = lineas.findIndex(l => /^SITUACION ACTUAL/i.test(l));
    if (iProp >= 0 && iSit > iProp) {
        for (const l of lineas.slice(iProp + 1, iSit)) {
            const m = l.match(/^(.+?)\s+No\. Inscripcion:\s*(\d+)\s+Ano:\s*(\d{4})\s+Libro:\s*(\S+)\s+Fecha:\s*([\d-]+)/i);
            if (m) r.propietarios.push({ nombre: m[1].trim(), inscripcion: m[2], anio: m[3], libro: m[4], fecha: m[5] });
        }
    }

    // Linderos y area registrales: entre "LINDEROS REGISTRALES:" y "RESUMEN DE MOVIMIENTOS"
    const iLind = lineas.findIndex(l => /^LINDEROS REGISTRALES/i.test(l));
    const iRes = lineas.findIndex(l => /^RESUMEN DE MOVIMIENTOS/i.test(l));
    if (iLind >= 0) {
        const bloque = lineas.slice(iLind + 1, iRes > iLind ? iRes : iLind + 30);
        const conArea = bloque.findIndex(l => /area total|superficie/i.test(sinAcentos(l)));
        const lind = bloque.slice(0, conArea >= 0 ? conArea : bloque.length);
        const primera = lind[0] && !orientacionDe(lind[0].split(':')[0]) ? lind.shift() : null;
        if (primera) r.ubicacion = primera;
        r.linderos = parsearLinderos(lind.join('\n'));
        r.area = parsearArea(bloque.join(' '));
    }
    if (!r.linderos.length) avisos.push('No se reconocieron linderos registrales: ingreselos a mano.');
    if (!r.area) avisos.push('No se reconocio el area registral: ingresela a mano.');

    // Resumen de movimientos (tabla)
    if (iRes >= 0) {
        for (const l of lineas.slice(iRes + 1, iRes + 60)) {
            if (/^MOVIMIENTOS REGISTRALES/i.test(l)) break;
            const m = l.match(/^(Propiedades|Prohibiciones|Hipotecas|Gravamenes|Embargos|Demandas|Varios|[A-Z][a-z]+)\s+(.+?)\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d+)\s+(\S+)$/);
            if (m) r.movimientos.push({ libro: m[1], acto: m[2], numero: m[3], fecha: m[4], folio: m[5], gravamen: m[6] });
        }
    }

    // Detalle de cada movimiento: acto, fechas, partes y observaciones
    const iniDet = [];
    lineas.forEach((l, i) => { if (/^\d{1,2}\s+[A-Z][A-Z .\/]+$/.test(l) && /Inscrito el:/i.test(lineas[i + 1] || '')) iniDet.push(i); });
    iniDet.forEach((i, k) => {
        const fin = k + 1 < iniDet.length ? iniDet[k + 1] : lineas.length;
        const bl = lineas.slice(i, fin);
        const txt = bl.join('\n');
        const obsIni = bl.findIndex(l => /^b\. Observaciones/i.test(l));
        const obsFin = bl.findIndex(l => /^c\.\s*Observaciones/i.test(l));
        const obs = obsIni >= 0 ? bl.slice(obsIni + 1, obsFin > obsIni ? obsFin : bl.length)
            .filter(l => !/^(Registro de la Propiedad del Cant|FECHA IMPRESION|P[aá]gina \d|f\.\w+)/i.test(l)).join(' ') : '';
        const partes = [];
        const pIni = bl.findIndex(l => /^Calidad\s+Cedula/i.test(l));
        if (pIni >= 0) {
            for (const l of bl.slice(pIni + 1, obsIni > pIni ? obsIni : pIni + 20)) {
                const m = l.match(RE_PARTE);
                if (m) partes.push({ calidad: normalizarCalidad(m[1]), cedula: m[2] || '', nombre: m[3].trim(), estadoCivil: (m[4] || '').split('/')[0] });
            }
        }
        const linderosObs = parsearLinderos(obs);
        const areaObs = parsearArea(obs);
        r.detalle.push({
            n: Number(bl[0].match(/^\d+/)[0]),
            acto: bl[0].replace(/^\d+\s+/, ''),
            inscrito: fechaTexto((txt.match(/Inscrito el:\s*([^\n]+?)\s+Libro de:/i) || [])[1] || ''),
            otorgamiento: fechaTexto((txt.match(/Fecha de Otorgamiento \/ Providencia\s*([^\n]+)/i) || [])[1] || ''),
            oficina: ((txt.match(/Oficina donde se guarda el original:\s*([^\n]+)/i) || [])[1] || '').trim(),
            partes,
            observaciones: obs.trim(),
            linderos: linderosObs.filter(l => l.longitud !== null).length >= 2 ? linderosObs : [],
            area: areaObs
        });
    });

    // Propietarios: el encabezado da el nombre y su inscripcion; la cedula, el
    // estado civil y la calidad (comprador, beneficiario, donatario, heredero)
    // solo aparecen en las partes de cada movimiento. Se cruzan por nombre.
    const actos = r.detalle.slice().sort((a, b) => String(a.inscrito || '').localeCompare(String(b.inscrito || '')));
    for (const p of r.propietarios) {
        for (const d of actos) {
            const parte = (d.partes || []).find(q => mismaPersona(q.nombre, p.nombre));
            if (!parte) continue;
            if (parte.cedula) p.documento = parte.cedula;
            if (parte.estadoCivil && !/desconocido|ninguno/i.test(parte.estadoCivil)) p.estadoCivil = parte.estadoCivil;
            if (parte.calidad && /beneficiario|comprador|donatario|heredero|adjudicatario|aclarante|otorgante/i.test(parte.calidad)) p.calidad = parte.calidad;
            p.ultimoActo = { acto: d.acto, fecha: d.inscrito };
        }
    }
    // Personas nombradas en los libros de propiedad: posibles conyuges,
    // herederos o donatarios que el profesional puede anadir al informe.
    r.personas = [];
    for (const d of r.detalle) {
        for (const parte of d.partes || []) {
            if (!parte.nombre || parte.nombre.length < 6) continue;
            if (/^(canton|unidad|juzgado|notaria|registro|gobierno)/i.test(parte.nombre)) continue;
            if (/autoridad|competente/i.test(parte.calidad)) continue;
            if (r.propietarios.some(p => mismaPersona(p.nombre, parte.nombre))) continue;
            // La misma persona aparece en varios actos, a veces con el nombre
            // incompleto: se completa la ficha con lo que aporte cada acto.
            const ya = r.personas.find(p => mismaPersona(p.nombre, parte.nombre));
            const ficha = ya || { nombre: parte.nombre, documento: '', calidad: '', estadoCivil: '', actos: [] };
            if (parte.cedula) ficha.documento = parte.cedula;
            if (parte.estadoCivil && !/desconocido|ninguno/i.test(parte.estadoCivil)) ficha.estadoCivil = parte.estadoCivil;
            if (parte.calidad && (!ficha.calidad || /donatari|hereder|comprador|conyuge|c[oó]nyuge|otorgante|beneficiari/i.test(parte.calidad))) ficha.calidad = parte.calidad;
            if (parte.nombre.length > ficha.nombre.length) ficha.nombre = parte.nombre;
            ficha.actos.push({ acto: d.acto, fecha: d.inscrito });
            if (!ya) r.personas.push(ficha);
        }
    }
    r.personas.forEach(p => { p.acto = p.actos[p.actos.length - 1].acto; p.fecha = p.actos[p.actos.length - 1].fecha; });
    // Porcentajes de participacion: el certificado los menciona en texto
    if (r.detalle.some(d => /(d{1,3}s*%|por ciento)/i.test(d.observaciones || ''))) {
        avisos.push('El titulo menciona porcentajes o cuotas de participacion: revise la calidad y el porcentaje de cada propietario.');
    }

    // Gravamenes: texto de cierre y prohibiciones o hipotecas vigentes
    const iGrav = lineas.findIndex(l => /^GRAV[AÁ]MENES/i.test(l));
    if (iGrav >= 0) {
        const bloque = [];
        for (const l of lineas.slice(iGrav + 1, iGrav + 10)) {
            if (/^(TOTAL DE MOVIMIENTOS|LA REVISI|c\.\s*Obs)/i.test(l)) break;
            if (!/^EL INMUEBLE DESCRITO/i.test(l)) bloque.push(l);
        }
        const texto = bloque.join(' ').trim();
        const libre = /NO SE ENCUENTRA HIPOTECADO/i.test(texto) && /NI SE HALLA PROHIBIDO/i.test(texto);
        r.gravamenes = { texto, libre };
    }
    const vigentes = r.movimientos.filter(mv => !/^(ninguno|cancelad[oa])$/i.test(mv.gravamen));
    if (!r.gravamenes) r.gravamenes = { texto: '', libre: vigentes.length === 0 };
    r.gravamenes.vigentes = vigentes;
    if (vigentes.length) avisos.push(`Movimientos con gravamen vigente: ${vigentes.map(v => v.acto).join(', ')}.`);

    // Historia de linderos y areas (para el "antes")
    r.historia = r.detalle.filter(d => d.linderos.length || d.area).map(d => ({
        n: d.n, acto: d.acto, fecha: d.otorgamiento || d.inscrito, linderos: d.linderos, area: d.area
    }));
    return r;
}

async function leerCertificado(buffer) {
    const paginas = await textoPDF(buffer);
    const caracteres = paginas.flat().join('').length;
    if (caracteres < 200) {
        return { tipo: 'sin_texto', avisos: ['El PDF no tiene texto (parece escaneado). Ingrese la informacion registral a mano.'], linderos: [], propietarios: [], personas: [], movimientos: [], detalle: [], historia: [] };
    }
    const r = parsearCertificado(paginas);
    if (!/REGISTRO DE LA PROPIEDAD/i.test(paginas.flat().join(' '))) r.avisos.unshift('El documento no parece un certificado del Registro de la Propiedad: revise los datos extraidos.');
    return r;
}

module.exports = { leerCertificado, textoPDF, parsearCertificado, parsearLinderos, parsearArea, orientacionDe, sinAcentos, mismaPersona, fijarPDFJS };

};

// ── lib/lamina.js ──────────────────────────────────────────────────────
__defs["lamina"] = function (module, exports, require) {
const __dirname = "/lib", __filename = "/lib/lamina.js";
const Buffer = __Buffer;
// ─────────────────────────────────────────────────────────────────────────────
//  Lamina planimetrica: maquetacion unica para el DXF y el PDF
//
//  Produce una lista de primitivas (polilineas, textos, circulos) en dos
//  espacios:
//    · 'm' (mundo): coordenadas UTM 17S reales. El DXF las escribe tal cual,
//      asi el predio queda georreferenciado al decimo de milimetro; el PDF las
//      pasa a papel con la escala de la lamina.
//    · 'p' (papel): milimetros sobre la hoja, origen abajo a la izquierda. El
//      PDF las dibuja tal cual; el DXF las lleva al espacio modelo con la misma
//      transformacion, de modo que marco, cuadros y cajetin quedan a escala
//      alrededor del predio y el dibujo se imprime sin retoques.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const pc = require('polygon-clipping');
const { recortarLinea } = require('./analisis');

const FORMATOS = { A4: [297, 210], A3: [420, 297] };
const ESCALAS = [50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 750, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000, 20000];

// Estilo de cada capa: color DXF (ACI), color PDF, grosor (mm), trazo y relleno
const CAPAS = {
    MARCO: { aci: 7, rgb: [46, 50, 56], lw: 0.5 },
    CAJETIN: { aci: 7, rgb: [46, 50, 56], lw: 0.25 },
    CAJETIN_TXT: { aci: 7, rgb: [46, 50, 56] },
    CUADROS: { aci: 8, rgb: [86, 91, 99], lw: 0.18 },
    CUADROS_TXT: { aci: 7, rgb: [46, 50, 56] },
    MALLA: { aci: 9, rgb: [160, 164, 170], lw: 0.1 },
    MALLA_TXT: { aci: 9, rgb: [120, 124, 130] },
    COLINDANTES: { aci: 8, rgb: [150, 150, 150], lw: 0.18 },
    COLINDANTES_TXT: { aci: 8, rgb: [110, 110, 110] },
    LINEA_FABRICA: { aci: 30, rgb: [230, 126, 34], lw: 0.25, trazo: 'DASHED' },
    AFECTACION_LF: { aci: 5, rgb: [37, 99, 168], lw: 0.2, relleno: [205, 222, 242] },
    MARGEN_HIDRO: { aci: 4, rgb: [14, 116, 144], lw: 0.2, relleno: [207, 234, 240] },
    ELEMENTOS_HIDRO: { aci: 4, rgb: [14, 116, 144], lw: 0.35 },
    ELEMENTOS_HIDRO_TXT: { aci: 4, rgb: [14, 116, 144] },
    MARGEN_VIA: { aci: 6, rgb: [122, 62, 157], lw: 0.2, relleno: [233, 222, 240] },
    ELEMENTOS_VIA: { aci: 6, rgb: [122, 62, 157], lw: 0.35 },
    ELEMENTOS_VIA_TXT: { aci: 6, rgb: [122, 62, 157] },
    PREDIO: { aci: 1, rgb: [227, 30, 36], lw: 0.6 },
    VERTICES: { aci: 3, rgb: [227, 30, 36], lw: 0.2 },
    VERTICES_TXT: { aci: 7, rgb: [46, 50, 56] },
    COTAS: { aci: 2, rgb: [46, 50, 56] },
    LINDEROS_TXT: { aci: 6, rgb: [86, 91, 99] },
    LINDEROS_REGISTRAL_TXT: { aci: 8, rgb: [139, 144, 152] },
    UBICACION: { aci: 8, rgb: [150, 150, 150], lw: 0.1 },
    UBICACION_VIA: { aci: 30, rgb: [230, 126, 34], lw: 0.15 },
    UBICACION_AGUA: { aci: 4, rgb: [14, 116, 144], lw: 0.15 },
    UBICACION_PREDIO: { aci: 1, rgb: [227, 30, 36], lw: 0.5, relleno: [250, 205, 206] },
    UBICACION_MARCO: { aci: 7, rgb: [46, 50, 56], lw: 0.25 },
    UBICACION_FOTO: { aci: 8, rgb: [46, 50, 56] },
    UBICACION_TXT: { aci: 7, rgb: [46, 50, 56] },
    NORTE: { aci: 7, rgb: [46, 50, 56], lw: 0.25 },
    ESCALA: { aci: 7, rgb: [46, 50, 56], lw: 0.25 }
};

// Numeros del plano: coma decimal y NADA de separador de miles. En un cuadro
// de coordenadas el punto de los miles se confunde con el de los decimales.
const fmt = (v, d) => Number(v).toLocaleString('es-EC', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false });

// Ancho aproximado de un texto de altura de mayuscula h (Helvetica: el cuerpo
// es h/0.72 y el caracter medio ~0,5 cuerpos; las mayusculas son mas anchas)
function anchoTexto(t, h) {
    t = String(t);
    // Helvetica/Arial: las mayusculas son anchas, las cifras algo mas
    // estrechas y los separadores de miles casi no ocupan. Distinguirlos
    // importa: un cuadro de coordenadas es casi todo cifras.
    let w = 0;
    for (const c of t) {
        if (/[A-ZÁÉÍÓÚÑÜ]/.test(c)) w += 0.92;
        else if (/[0-9]/.test(c)) w += 0.78;
        else if (/[.,;:'`|]/.test(c)) w += 0.32;
        else if (/[ ]/.test(c)) w += 0.36;
        else if (/[ilj]/.test(c)) w += 0.34;
        else w += 0.7;
    }
    return w * h;
}
// En el DXF no se abrevia: un lindero recortado con puntos suspensivos no
// sirve como documento. Si un texto no entra se encoge; si aun asi no entra,
// se parte en dos lineas por el espacio mas cercano a la mitad.
function ajustarCelda(texto, ancho, h, minimo) {
    const t = String(texto == null ? '' : texto).trim();
    if (!t) return { lineas: [''], h };
    if (anchoTexto(t, h) <= ancho) return { lineas: [t], h };
    const piso = minimo || h * 0.6;
    const encogida = Math.max(piso, h * ancho / anchoTexto(t, h));
    if (anchoTexto(t, encogida) <= ancho) return { lineas: [t], h: encogida };
    const espacios = [];
    for (let i = 0; i < t.length; i++) if (t[i] === ' ') espacios.push(i);
    if (espacios.length) {
        const mitad = t.length / 2;
        const k = espacios.reduce((a, b) => Math.abs(b - mitad) < Math.abs(a - mitad) ? b : a);
        const l1 = t.slice(0, k), l2 = t.slice(k + 1);
        const ancha = Math.max(anchoTexto(l1, 1), anchoTexto(l2, 1));
        return { lineas: [l1, l2], h: Math.max(piso * 0.85, Math.min(h * 0.85, ancho / ancha)) };
    }
    return { lineas: [t], h: encogida };   // una sola palabra: se encoge lo que se pueda
}
// Altura que hace entrar el texto en el ancho, sin bajar de `min`
function ajustarAltura(t, h, ancho, min) {
    const w = anchoTexto(t, h);
    return w <= ancho ? h : Math.max(min, h * ancho / w);
}

/**
 * @param {object} proyecto  { analisis, datos }
 * @returns {{ W, H, escala, primitivas, mundoAPapel, papelAMundo, formato }}
 */
// Como se encabeza el recuadro de firma segun la calidad del titular.
// Se usa el masculino generico, que es como lo piden las municipalidades:
// "FIRMA DEL PROPIETARIO", no "FIRMA DE PROPIETARIO/A".
function rotuloFirma(calidad) {
    const c = String(calidad || 'Propietario').split('/a').join('').split('/A').join('').trim();
    if (c.toLowerCase().indexOf('sucesi') >= 0) return 'FIRMA POR LA SUCESIÓN INDIVISA';
    return "FIRMA DEL " + c.toUpperCase();
}

function construirLamina(proyecto) {
    const a = proyecto.analisis;
    const d = proyecto.datos || {};
    const conc = proyecto.conciliacion || null;
    const formato = FORMATOS[d.formato] ? d.formato : 'A4';
    const [W, H] = FORMATOS[formato];
    const k = formato === 'A3' ? 1.3 : 1;          // factor tipografico
    const hTxt = 1.9 * k, hTit = 2.6 * k, hPeq = 1.6 * k;
    const prim = [];
    const pl = (capa, pts, esp, cerrada, extra) => prim.push(Object.assign({ t: 'pl', capa, pts, esp, cerrada: !!cerrada }, extra || {}));
    const tx = (capa, x, y, h, txt, esp, extra) => prim.push(Object.assign({ t: 'tx', capa, x, y, h, txt: String(txt), esp, rot: 0, al: 'i', va: 'b' }, extra || {}));

    const M = 8;                                   // margen de hoja
    const colDer = formato === 'A3' ? 128 : 96;    // columna de cuadros
    const vp = { x0: M + 2, y0: M + 2, x1: W - M - colDer - 2, y1: H - M - 2 };
    const vpW = vp.x1 - vp.x0, vpH = vp.y1 - vp.y0;

    // ── Escala: la menor normalizada en que entra el predio con holgura ──────
    const xs = a.vertices.map(v => v.x), ys = a.vertices.map(v => v.y);
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    const cX = (bx0 + bx1) / 2, cY = (by0 + by1) / 2;
    const necesita = Math.max((bx1 - bx0) * 1000 / (vpW - 36 * k), (by1 - by0) * 1000 / (vpH - 36 * k));
    let escala = Number(d.escala) > 0 ? Number(d.escala) : (ESCALAS.find(s => s >= necesita) || Math.ceil(necesita / 1000) * 1000);
    const f = 1000 / escala;                       // mm de papel por metro
    const mx = vp.x0 + vpW / 2, my = vp.y0 + vpH / 2;
    const mundoAPapel = p => [mx + (p[0] - cX) * f, my + (p[1] - cY) * f];
    const papelAMundo = p => [cX + (p[0] - mx) / f, cY + (p[1] - my) / f];
    const ventana = [cX - vpW / 2 / f, cY - vpH / 2 / f, cX + vpW / 2 / f, cY + vpH / 2 / f];
    const rectVentana = [[[ventana[0], ventana[1]], [ventana[2], ventana[1]], [ventana[2], ventana[3]], [ventana[0], ventana[3]], [ventana[0], ventana[1]]]];
    const recortarPoligono = anillo => {
        try { return pc.intersection([[anillo.concat([anillo[0]])]], [rectVentana]); } catch (e) { return []; }
    };

    // ── Marco ────────────────────────────────────────────────────────────────
    pl('MARCO', [[M, M], [W - M, M], [W - M, H - M], [M, H - M]], 'p', true);
    pl('MARCO', [[vp.x1 + 2, M], [vp.x1 + 2, H - M]], 'p');

    // ── Contexto: predios vecinos, lineas de fabrica, elementos ──────────────
    for (const v of (a.contexto && a.contexto.predios) || []) {
        for (const r of v.anillos) {
            for (const pol of recortarPoligono(r)) for (const anillo of pol) pl('COLINDANTES', anillo, 'm', false);
        }
        // Rotulo del vecino en el punto interior del anillo recortado mayor
        const partes = v.anillos.flatMap(r => recortarPoligono(r));
        let mejor = null, am = 0;
        for (const pol of partes) {
            const r = pol[0];
            let s = 0; for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
            if (Math.abs(s) / 2 > am) { am = Math.abs(s) / 2; mejor = r; }
        }
        if (mejor && am * f * f > 180 * k * k) {
            const c = mejor.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map(q => q / mejor.length);
            const dentroPredio = a.vertices.length && puntoEnAnillo(c, a.vertices.map(q => [q.x, q.y]));
            if (!dentroPredio) tx('COLINDANTES_TXT', c[0], c[1], hPeq, v.clave || '', 'm', { al: 'c', va: 'm', prioridad: 6, empuje: [0, 1] });
        }
    }
    for (const l of (a.contexto && a.contexto.lineasFabrica) || []) {
        for (const s of recortarLinea(l, ventana)) pl('LINEA_FABRICA', s, 'm');
    }
    const lf = a.afectaciones && a.afectaciones.lineaFabrica;
    if (lf) for (const fr of lf.franjas) pl('AFECTACION_LF', fr.anillo, 'm', true, { relleno: true });
    for (const e of (a.afectaciones && a.afectaciones.elementos) || []) {
        const g = e.grupo === 'hidrografia' ? 'HIDRO' : 'VIA';
        for (const pol of e.poligonos || []) for (const r of pol) pl('MARGEN_' + g, r, 'm', true, { relleno: true, dxfCapa: (e.capaDXF || 'ELEMENTO') + '_MARGEN' });
        // El nombre se ofrece en varios puntos del trazado: si en el primero no
        // cabe (el rotulo se omitia y la via quedaba sin nombre), se prueba en
        // los siguientes tramos visibles, de mayor a menor longitud.
        const tramos = [];
        for (const l of e.dibujo || []) for (const s of recortarLinea(l, ventana)) {
            pl('ELEMENTOS_' + g, s, 'm', false, { dxfCapa: e.capaDXF || 'ELEMENTO' });
            for (let i = 1; i < s.length; i++) tramos.push([s[i - 1], s[i]]);
        }
        if (tramos.length) {
            const largo = t => Math.hypot(t[1][0] - t[0][0], t[1][1] - t[0][1]);
            const anclas = tramos.sort((u, v) => largo(v) - largo(u)).slice(0, 10).map(([p0, p1]) => {
                let ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) * 180 / Math.PI;
                if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
                return { x: (p0[0] + p1[0]) / 2, y: (p0[1] + p1[1]) / 2, rot: ang, empuje: [-(p1[1] - p0[1]), p1[0] - p0[0]] };
            });
            const nom = (e.cercanos[0] && e.cercanos[0].nombre) || e.nombre;
            tx('ELEMENTOS_' + g + '_TXT', anclas[0].x, anclas[0].y, hPeq, nom, 'm',
                { rot: anclas[0].rot, al: 'c', va: 'b', dxfCapa: (e.capaDXF || 'ELEMENTO') + '_TXT', prioridad: 5, empuje: anclas[0].empuje, alternativas: anclas.slice(1) });
        }
    }

    // ── Predio, vertices, cotas y linderos ───────────────────────────────────
    const P = a.vertices.map(v => [v.x, v.y]);
    const n = P.length;
    pl('PREDIO', P, 'm', true);
    const rV = 0.6 * k;
    const dens = n > 40 ? 3 : n > 20 ? 2 : 1;      // con muchos vertices se rotula 1 de cada `dens`
    P.forEach((p, i) => {
        prim.push({ t: 'ci', capa: 'VERTICES', x: p[0], y: p[1], r: rV, esp: 'm' });
        prim.push({ t: 'pt', capa: 'VERTICES', x: p[0], y: p[1], esp: 'm' });
        if (i % dens) return;
        const ant = P[(i + n - 1) % n], sig = P[(i + 1) % n];
        // bisectriz exterior (anillo horario: exterior a la izquierda del avance)
        const u1 = norm([p[0] - ant[0], p[1] - ant[1]]), u2 = norm([sig[0] - p[0], sig[1] - p[1]]);
        let bx = (-u1[1] + -u2[1]), by = (u1[0] + u2[0]);
        const lb = Math.hypot(bx, by) || 1; bx /= lb; by /= lb;
        const off = 2.6 * k / f;
        tx('VERTICES_TXT', p[0] + bx * off, p[1] + by * off, hTxt, a.vertices[i].id, 'm', { al: 'c', va: 'm', prioridad: 1, empuje: [bx, by] });
    });
    a.lados.forEach((l, i) => {
        const p = P[i], q = P[(i + 1) % n];
        const Lp = l.L * f;
        const txt = fmt(l.L, 2);
        if (Lp < anchoTexto(txt, hPeq) + 2) return;          // no cabe: queda en el cuadro
        let ang = Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI;
        const nx = -(q[1] - p[1]) / l.L, ny = (q[0] - p[0]) / l.L;   // izquierda = exterior
        if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
        const off = 1.8 * k / f;
        tx('COTAS', (p[0] + q[0]) / 2 + nx * off, (p[1] + q[1]) / 2 + ny * off, hPeq, txt, 'm', { rot: ang, al: 'c', va: 'm', prioridad: 2, empuje: [nx, ny] });
    });
    // Rotulo de lindero: orientacion y colindante, en el tramo mas largo del grupo
    for (const li of a.linderos) {
        const largo = li.lados.map(i => ({ i, L: a.lados[i].L })).sort((u, v) => v.L - u.L)[0];
        if (!largo) continue;
        const p = P[largo.i], q = P[(largo.i + 1) % n];
        const Lp = largo.L * f;
        const t = `${(li.dir || '').toUpperCase()}: ${li.colindante || 'COLINDANTE POR COMPLETAR'}`;
        let ang = Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI;
        const nx = -(q[1] - p[1]) / largo.L, ny = (q[0] - p[0]) / largo.L;
        if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
        const off = 5.0 * k / f;
        tx('LINDEROS_TXT', (p[0] + q[0]) / 2 + nx * off, (p[1] + q[1]) / 2 + ny * off, hPeq, t, 'm', { rot: ang, al: 'c', va: 'm', prioridad: 3, empuje: [nx, ny] });
        // Segunda linea: lo que dice el titulo para esa orientacion (el "antes"),
        // una sola vez por orientacion, en el lindero mas largo de ella
        const lado = conc && conc.lados.find(x => x.dir === li.dir && x.registral);
        const masLargo = a.linderos.filter(x => x.dir === li.dir).sort((u, v) => v.longitud - u.longitud)[0];
        if (lado && masLargo === li) {
            const antes = `Escritura: ${lado.registral.colindante || '-'}${lado.registral.longitud !== null ? ' · ' + fmt(lado.registral.longitud, 2) + ' m' : ''}`;
            const off2 = off + 2.9 * k / f;
            tx('LINDEROS_REGISTRAL_TXT', (p[0] + q[0]) / 2 + nx * off2, (p[1] + q[1]) / 2 + ny * off2, hPeq * 0.85,
                antes, 'm', { rot: ang, al: 'c', va: 'm', prioridad: 4, empuje: [nx, ny] });
        }
    }

    // ── Malla de coordenadas ─────────────────────────────────────────────────
    const pasoM = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find(s => vpW / (s * f) <= 6) || 5000;
    for (let X = Math.ceil(ventana[0] / pasoM) * pasoM; X <= ventana[2]; X += pasoM) {
        const px = mundoAPapel([X, 0])[0];
        if (px < vp.x0 + 8 || px > vp.x1 - 8) continue;
        pl('MALLA', [[px, vp.y0], [px, vp.y0 + 2.5]], 'p');
        pl('MALLA', [[px, vp.y1], [px, vp.y1 - 2.5]], 'p');
        tx('MALLA_TXT', px, vp.y0 + 3.2, hPeq, 'E ' + fmt(X, 0), 'p', { al: 'c', va: 'b' });
        for (let Y = Math.ceil(ventana[1] / pasoM) * pasoM; Y <= ventana[3]; Y += pasoM) {
            const py = mundoAPapel([0, Y])[1];
            if (py < vp.y0 + 8 || py > vp.y1 - 8) continue;
            pl('MALLA', [[px - 1.5, py], [px + 1.5, py]], 'p');
            pl('MALLA', [[px, py - 1.5], [px, py + 1.5]], 'p');
        }
    }
    for (let Y = Math.ceil(ventana[1] / pasoM) * pasoM; Y <= ventana[3]; Y += pasoM) {
        const py = mundoAPapel([0, Y])[1];
        if (py < vp.y0 + 8 || py > vp.y1 - 8) continue;
        pl('MALLA', [[vp.x0, py], [vp.x0 + 2.5, py]], 'p');
        pl('MALLA', [[vp.x1, py], [vp.x1 - 2.5, py]], 'p');
        tx('MALLA_TXT', vp.x0 + 3.2, py, hPeq, 'N ' + fmt(Y, 0), 'p', { rot: 90, al: 'c', va: 't' });
    }

    // ── Norte y escala grafica ───────────────────────────────────────────────
    const nx0 = vp.x1 - 12 * k, ny0 = vp.y1 - 22 * k;
    pl('NORTE', [[nx0, ny0 + 14 * k], [nx0 - 3.5 * k, ny0], [nx0, ny0 + 3.5 * k], [nx0 + 3.5 * k, ny0]], 'p', true, { relleno: true });
    tx('NORTE', nx0, ny0 + 15.5 * k, hTit, 'N', 'p', { al: 'c', va: 'b' });
    const barraM = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000].find(s => s * f >= 10 * k) || 1000;
    const ex0 = vp.x0 + 10, ey0 = vp.y0 + 9 * k;
    for (let q = 0; q < 4; q++) {
        const xa = ex0 + q * barraM * f, xb = xa + barraM * f;
        pl('ESCALA', [[xa, ey0], [xb, ey0], [xb, ey0 + 1.4 * k], [xa, ey0 + 1.4 * k]], 'p', true, { relleno: q % 2 === 0 });
        tx('ESCALA', xa, ey0 + 2.2 * k, hPeq, fmt(q * barraM, 0), 'p', { al: 'c' });
    }
    tx('ESCALA', ex0 + 4 * barraM * f, ey0 + 2.2 * k, hPeq, fmt(4 * barraM, 0) + ' m', 'p', { al: 'c' });
    tx('ESCALA', ex0, ey0 - 3.2 * k, hTxt, `ESCALA 1:${escala}   ·   UTM WGS84 17S`, 'p');

    // ── Columna derecha: cuadros y cajetin ───────────────────────────────────
    const cx0 = vp.x1 + 4, cx1 = W - M - 2, cw = cx1 - cx0;
    // Las filas crecen si una celda necesita dos lineas: nada se abrevia.
    const prepararTabla = (anchos, cab, filas, opt) => {
        const cx0 = opt.x0 !== undefined ? opt.x0 : vp.x1 + 4;
        const cx1 = opt.x1 !== undefined ? opt.x1 : W - M - 2;
        const cw = cx1 - cx0;
        const hb = opt.h || hPeq;
        const tot = anchos.reduce((s, v) => s + v, 0);
        const cols = anchos.map(v => v / tot * cw);
        const filasPrep = [cab].concat(filas).map(fila => fila.map((c, j) => ajustarCelda(c, cols[j] - 1.6, hb)));
        const alturas = filasPrep.map(f => (f.some(c => c.lineas.length > 1) ? hb * 2.7 : hb * 1.75));
        const alto = alturas.reduce((s, v) => s + v, 0) + hTit * 1.6 + 3;
        return { cx0, cx1, cols, hb, filasPrep, alturas, alto };
    };
    const tabla = (yTop, titulo, anchos, cab, filas, opt) => {
        opt = opt || {};
        const nPrim = prim.length;
        const { cx0, cx1, cols, hb, filasPrep, alturas } = prepararTabla(anchos, cab, filas, opt);
        let y = yTop;
        tx('CUADROS_TXT', cx0, y - hTit, hTit * 0.9, titulo, 'p', { negrita: true });
        y -= hTit * 1.6;
        const altoTotal = alturas.reduce((s, v) => s + v, 0);
        pl('CUADROS', [[cx0, y], [cx1, y], [cx1, y - altoTotal], [cx0, y - altoTotal]], 'p', true);
        let yFila = y;
        filasPrep.forEach((fila, r) => {
            const fh = alturas[r];
            const yb = yFila - fh;
            if (r < filasPrep.length - 1) pl('CUADROS', [[cx0, yb], [cx1, yb]], 'p');
            let xc = cx0;
            fila.forEach((celda, j) => {
                const dcha = opt.num && opt.num[j];
                const n = celda.lineas.length;
                celda.lineas.forEach((texto, i) => {
                    const yt = yb + fh * (n === 1 ? 0.3 : (i === 0 ? 0.56 : 0.2));
                    tx('CUADROS_TXT', dcha ? xc + cols[j] - 0.8 : xc + 0.8, yt, celda.h, texto, 'p',
                        { al: dcha ? 'd' : 'i', negrita: r === 0 });
                });
                xc += cols[j];
                if (r === 0 && j < fila.length - 1) pl('CUADROS', [[xc, y], [xc, y - altoTotal]], 'p');
            });
            yFila = yb;
        });
        if (opt.soloDXF) for (let q = nPrim; q < prim.length; q++) prim[q].soloDXF = true;
        return yFila - 3;
    };

    // ── Cajetin ──────────────────────────────────────────────────────────────
    // Su alto se calcula: crece con los campos y con el numero de firmantes.
    // Cada titular tiene su recuadro para firmar, con nombre y cedula debajo,
    // porque la planimetria se firma en papel junto al profesional.
    const titulares = (Array.isArray(d.propietarios) && d.propietarios.length
        ? d.propietarios.filter(p => String(p.nombre || '').trim())
        : d.propietario ? [{ nombre: d.propietario, documento: d.documento || '', calidad: '', participacion: '' }] : []);
    const conCuota = p => p.nombre + (p.participacion ? ' (' + p.participacion + ')' : '');
    const camposCaj = titulares.length > 1
        ? [['PROPIETARIOS', conCuota(titulares[0])], ['', titulares.slice(1).map(conCuota).join('  ·  ')]]
        : [['PROPIETARIO', titulares.length ? conCuota(titulares[0]) : 'POR COMPLETAR']];
    camposCaj.push(
        ['UBICACIÓN', [d.direccion, d.sector, a.ubicacion.parroquia ? 'Parroquia ' + a.ubicacion.parroquia : ''].filter(Boolean).join(' - ') || 'POR COMPLETAR'],
        ['CLAVE CATASTRAL', d.claveCatastral || 'Predio no catastrado'],
        ['SUPERFICIE', `${fmt(a.area, 2)} m²   ·   Perímetro ${fmt(a.perimetro, 2)} m`],
        ['PROFESIONAL', [d.profesional, d.registro ? 'Reg. ' + d.registro : ''].filter(Boolean).join('  ·  ') || 'POR COMPLETAR'],
        ['LEVANTAMIENTO', [d.fechaLevantamiento, d.equipo].filter(Boolean).join('  ·  ') || '-']
    );

    const firmantes = [{
        rotulo: 'FIRMA DEL PROFESIONAL RESPONSABLE',
        nombre: d.profesional || '',
        detalle: d.registro ? 'Reg. ' + d.registro : 'Registro profesional'
    }].concat(titulares.length
        ? titulares.map(p => ({
            rotulo: rotuloFirma(p.calidad),
            nombre: p.nombre,
            detalle: [p.documento ? 'C.I./RUC ' + p.documento : 'C.I./RUC', p.participacion].filter(Boolean).join('   ·   ')
        }))
        : [{ rotulo: 'FIRMA DEL PROPIETARIO', nombre: '', detalle: 'C.I./RUC' }]);

    const colFirmas = firmantes.length > 1 ? 2 : 1;
    const filasFirmas = Math.ceil(firmantes.length / colFirmas);
    // Espacio para firmar + linea + nombre + documento. Si hay muchos
    // titulares se aprieta, pero el cajetin nunca pasa del 55 % de la columna:
    // los cuadros necesitan su sitio.
    const hCabCajPrev = hTit * 1.3 * 2 + hTxt * 1.1;
    const hPiePrev = 15 * k;
    const disponible = (H - 2 * M) * 0.55 - hCabCajPrev - camposCaj.length * hTxt * 1.75 - hPiePrev;
    const hFirma = Math.max(12 * k, Math.min(20 * k, disponible / Math.max(1, Math.ceil(firmantes.length / (firmantes.length > 1 ? 2 : 1)))));
    const hCabCaj = hTit * 1.3 * 2 + hTxt * 1.1;
    const hPie = 15 * k;
    const cajH = hCabCaj + camposCaj.length * hTxt * 1.75 + 2 + filasFirmas * hFirma + hPie;
    const cy0 = M + 2, cy1 = cy0 + cajH;
    pl('CAJETIN', [[cx0, cy0], [cx1, cy0], [cx1, cy1], [cx0, cy1]], 'p', true);

    const inst = d.institucion || 'Colegio de Arquitectos del Ecuador - Nucleo de Chimborazo';
    const instT = inst.toUpperCase();
    let yc = cy1 - hTit * 1.3;
    tx('CAJETIN_TXT', cx0 + cw / 2, yc, ajustarAltura(instT, hTxt, cw - 4, hPeq * 0.6), instT, 'p', { al: 'c', negrita: true });
    yc -= hTit * 1.3;
    tx('CAJETIN_TXT', cx0 + cw / 2, yc, ajustarAltura('LEVANTAMIENTO PLANIMÉTRICO', hTit, cw - 4, hTxt), 'LEVANTAMIENTO PLANIMÉTRICO', 'p', { al: 'c', negrita: true });
    yc -= hTxt * 1.1;
    pl('CAJETIN', [[cx0, yc], [cx1, yc]], 'p');
    for (const [et, val] of camposCaj) {
        yc -= hTxt * 1.75;
        tx('CAJETIN_TXT', cx0 + 1.5, yc, hPeq, et, 'p', { negrita: true });
        const celda = ajustarCelda(val, cw - 30 * k, hPeq, hPeq * 0.62);
        celda.lineas.forEach((linea, i) => tx('CAJETIN_TXT', cx0 + 28 * k, yc + (celda.lineas.length > 1 ? (i === 0 ? hPeq * 0.75 : -hPeq * 0.35) : 0), celda.h, linea, 'p'));
    }

    // ── Firmas ───────────────────────────────────────────────────────────────
    const yPie = cy0 + hPie;
    const yFirmas = yPie + filasFirmas * hFirma;
    pl('CAJETIN', [[cx0, yFirmas], [cx1, yFirmas]], 'p');
    const anchoF = cw / colFirmas;
    firmantes.forEach((f, i) => {
        const col = i % colFirmas, fila = Math.floor(i / colFirmas);
        const xb = cx0 + anchoF * col, yb = yFirmas - hFirma * (fila + 1);
        if (col) pl('CAJETIN', [[xb, yb], [xb, yb + hFirma]], 'p');
        if (fila) pl('CAJETIN', [[cx0, yb + hFirma], [cx1, yb + hFirma]], 'p');
        const centro = xb + anchoF / 2, ancho = anchoF - 6 * k;
        tx('CAJETIN_TXT', centro, yb + hFirma - hPeq * 1.6, ajustarAltura(f.rotulo, hPeq, ancho, hPeq * 0.6), f.rotulo, 'p', { al: 'c', negrita: true });
        pl('CAJETIN', [[xb + 3 * k, yb + hPeq * 4.2], [xb + anchoF - 3 * k, yb + hPeq * 4.2]], 'p');   // linea de firma
        const nom = ajustarCelda(f.nombre || 'POR COMPLETAR', ancho, hPeq, hPeq * 0.6);
        tx('CAJETIN_TXT', centro, yb + hPeq * 2.4, nom.h, nom.lineas[0], 'p', { al: 'c', negrita: true });
        if (nom.lineas[1]) tx('CAJETIN_TXT', centro, yb + hPeq * 1.2, nom.h, nom.lineas[1], 'p', { al: 'c', negrita: true });
        const det = ajustarCelda(f.detalle, ancho, hPeq * 0.9, hPeq * 0.55);
        tx('CAJETIN_TXT', centro, yb + (nom.lineas[1] ? hPeq * 0.1 : hPeq * 0.9), det.h, det.lineas[0], 'p', { al: 'c' });
    });

    // ── Escala, fecha y lamina ───────────────────────────────────────────────
    const c3 = cw / 3;
    [['ESCALA', '1:' + escala], ['FECHA', d.fecha || new Date().toISOString().slice(0, 10)], ['LÁMINA', '1 / 1']].forEach(([e, v], j) => {
        if (j) pl('CAJETIN', [[cx0 + c3 * j, cy0], [cx0 + c3 * j, yPie]], 'p');
        tx('CAJETIN_TXT', cx0 + c3 * j + c3 / 2, cy0 + hPie - hPeq * 2.2, hPeq, e, 'p', { al: 'c', negrita: true });
        tx('CAJETIN_TXT', cx0 + c3 * j + c3 / 2, cy0 + hPie * 0.25, hTxt, v, 'p', { al: 'c' });
    });

    // ── Mapa de ubicación ────────────────────────────────────────────────────
    // Un DXF R12 no admite imágenes (IMAGE es de R13 y exige el esqueleto
    // completo que aquí se evita a propósito), así que el recuadro se dibuja
    // en vectores: predios del sector, vías, cursos de agua y el lote resaltado.
    let y = H - M - 3;
    const ub = a.contexto && a.contexto.ubicacion;
    if (ub && d.ubicacion !== false && (ub.predios.length || ub.vias.length)) {
        const foto = d.satelital && d.satelital.png ? d.satelital : null;
        const anchoUb = cx1 - cx0;
        const altoUb = anchoUb / 2;                       // el recuadro es 2:1, como la foto
        const yCaja = y - hTit * 1.6;
        const yBotUb = yCaja - altoUb - 4;
        tx('UBICACION_TXT', cx0, y - hTit, hTit * 0.9, 'UBICACIÓN', 'p', { negrita: true });
        pl('UBICACION_MARCO', [[cx0, yCaja], [cx1, yCaja], [cx1, yCaja - altoUb], [cx0, yCaja - altoUb]], 'p', true);
        // Ventana del recuadro en coordenadas reales
        const anchoM = foto ? foto.ancho : 2 * ub.radio;
        const centroUb = foto && foto.centro ? foto.centro : ub.centro;
        const fUb = anchoUb / anchoM;                     // mm por metro
        const escalaUb = Math.round(1000 / fUb / 100) * 100;   // escala redondeada a la centena
        const cxUb = (cx0 + cx1) / 2, cyUb = yCaja - altoUb / 2;
        const aPapel = p => [cxUb + (p[0] - centroUb[0]) * fUb, cyUb + (p[1] - centroUb[1]) * fUb];
        const ventanaUb = [
            centroUb[0] - anchoM / 2, centroUb[1] - altoUb / fUb / 2,
            centroUb[0] + anchoM / 2, centroUb[1] + altoUb / fUb / 2
        ];
        if (foto) {
            // La foto solo puede ir en el PDF: el DXF R12 no admite imagenes
            prim.push({ t: 'img', capa: 'UBICACION_FOTO', esp: 'p', png: foto.png, formato: foto.formato || 'JPEG',
                x: cx0, y: yCaja - altoUb, w: anchoUb, h: altoUb, soloPDF: true });
        }
        const dibujarUb = (lineas, capa, cerrar) => {
            for (const linea of lineas) {
                const l2 = cerrar && linea.length > 2 ? linea.concat([linea[0]]) : linea;
                for (const tramo of recortarLinea(l2, ventanaUb)) pl(capa, tramo.map(aPapel), 'p', false, foto ? { soloDXF: true } : {});
            }
        };
        dibujarUb(ub.predios, 'UBICACION', true);
        dibujarUb(ub.vias, 'UBICACION_VIA', false);
        dibujarUb(ub.agua || [], 'UBICACION_AGUA', false);
        // El predio va encima de las dos versiones, foto o esquema
        pl('UBICACION_PREDIO', P.map(aPapel), 'p', true, foto ? {} : { relleno: true });
        const ladoPapel = Math.max(bx1 - bx0, by1 - by0) * fUb;
        if (ladoPapel < 4) {
            const c = aPapel([(bx0 + bx1) / 2, (by0 + by1) / 2]);
            prim.push({ t: 'ci', capa: 'UBICACION_PREDIO', x: c[0], y: c[1], r: 3, esp: 'p' });
        }
        const nx0 = cx1 - 5, ny0 = yCaja - altoUb + 4;
        pl('UBICACION_MARCO', [[nx0, ny0 + 6], [nx0 - 1.6, ny0], [nx0, ny0 + 1.6], [nx0 + 1.6, ny0]], 'p', true, { relleno: true });
        tx('UBICACION_TXT', nx0, ny0 + 7, hPeq, 'N', 'p', { al: 'c' });
        tx('UBICACION_TXT', cx0 + 1.5, yCaja - altoUb - 3, hPeq * 0.9,
            `Entorno de ${fmt(anchoM / 2, 0)} m  ·  escala 1:${escalaUb}` + (foto ? '  ·  imagen satelital Esri / Maxar' : ''), 'p');
        y = yBotUb - 2;
    }

    // Cuadros (arriba hacia abajo)
    const af = a.afectaciones || {};
    const filasAreas = [['Superficie levantada', fmt(a.area, 2)]];
    if (lf && lf.total > 0) filasAreas.push(['Afectación línea de fábrica', fmt(lf.total, 2)]);
    for (const e of af.elementos || []) if (e.afecta) filasAreas.push([`Margen ${e.nombre} (${fmt(e.margen, 1)} m)`, fmt(e.area, 2)]);
    if (af.areaAfectada > 0) filasAreas.push(['Superficie afectada (unión)', fmt(af.areaAfectada, 2)]);
    filasAreas.push(['Superficie útil', fmt(af.areaUtil != null ? af.areaUtil : a.area, 2)]);
    const escr = Number(String(d.areaEscritura || '').replace(',', '.'));
    if (escr > 0 && !(conc && conc.area)) filasAreas.push([`Según escritura (dif. ${fmt((a.area - escr) / escr * 100, 2)} %)`, fmt(escr, 2)]);
    y = tabla(y, 'CUADRO DE ÁREAS', [3, 1], ['Concepto', 'm²'], filasAreas, { num: [false, true] });

    const filasLind = a.linderos.map(l => [l.dir, `${l.desde}-${l.hasta}`, l.colindante || 'POR COMPLETAR', fmt(l.longitud, 2)]);
    const altoTabla = filas => (filas + 1) * hPeq * 1.75 + hTit * 1.6 + 3;
    // Antes (titulo) y hoy (levantamiento), una fila por orientacion y la superficie
    const filasConc = conc ? conc.lados.map(l => [
        l.dir + (l.relativo ? ` (${l.relativo})` : ''),
        l.registral ? (l.registral.colindante || '-') : 'sin dato en el título',
        l.registral && l.registral.longitud !== null ? fmt(l.registral.longitud, 2) : '-',
        l.hoy.linderos.map(x => x.colindante || '¿?').join(' / '),
        fmt(l.hoy.longitud, 2),
        l.dif !== null ? (l.dif > 0 ? '+' : '') + fmt(l.dif, 2) : '-'
    ]) : [];
    if (conc && conc.area) filasConc.push(['Superficie (m²)', conc.area.registralOriginal || 'según título', fmt(conc.area.registral, 2), 'medida', fmt(conc.area.medida, 2), (conc.area.dif > 0 ? '+' : '') + fmt(conc.area.dif, 2)]);
    const espacioCoord = y - altoTabla(filasLind.length) - (filasConc.length ? altoTabla(filasConc.length) : 0) - (cy1 + 3);
    y = tabla(y, 'CUADRO DE LINDEROS', [1.1, 1.6, 4.2, 1.2], ['Orientación', 'Tramo', 'Colindante', 'Longitud (m)'], filasLind.length ? filasLind : [['-', '-', '-', '-']], { num: [false, false, false, true] });
    if (filasConc.length) {
        y = tabla(y, 'ESCRITURA (ANTES) / LEVANTAMIENTO (HOY)', [1.55, 2.55, 1.1, 2.55, 1.1, 1.0],
            ['Lindero', 'Según el título', 'Metros', 'Según el levantamiento', 'Metros', 'Diferencia'], filasConc, { h: hPeq * 0.9, num: [false, false, true, false, true, true] });
    }

    const filasCoord = a.lados.map((l, i) => [a.vertices[i].id, fmt(a.vertices[i].x, 4), fmt(a.vertices[i].y, 4), `${l.desde}-${l.hasta}`, fmt(l.L, 2), l.rumbo]);
    const cabe = h => Math.floor((espacioCoord - hTit * 1.6 - 3) / (h * 1.75)) - 1;
    if (filasCoord.length <= cabe(hPeq * 0.9)) {
        tabla(y, 'CUADRO DE COORDENADAS (UTM WGS84 17S)', [0.75, 2.2, 2.5, 1.2, 1.1, 2.1], ['Vértice', 'Este (X)', 'Norte (Y)', 'Lado', 'Distancia (m)', 'Rumbo'], filasCoord, { h: hPeq * 0.9, num: [false, true, true, false, true, false] });
    } else if (Math.ceil(filasCoord.length / 2) <= cabe(hPeq * 0.85)) {
        // Dos medias tablas lado a lado, sin rumbo (el rumbo va en el informe)
        const mitad = Math.ceil(filasCoord.length / 2);
        const corta = filasCoord.map(fl => [fl[0], fl[1], fl[2], fl[4]]);
        const xm = (cx0 + cx1) / 2;
        const op = { h: hPeq * 0.85, num: [false, true, true, true] };
        const cab = ['Vértice', 'Este (X)', 'Norte (Y)', 'Lado (m)'];
        tabla(y, 'CUADRO DE COORDENADAS (UTM WGS84 17S)', [1, 2.5, 2.7, 1.2], cab, corta.slice(0, mitad), Object.assign({ x0: cx0, x1: xm - 1 }, op));
        tabla(y, ' ', [1, 2.5, 2.7, 1.2], cab, corta.slice(mitad), Object.assign({ x0: xm + 1, x1: cx1 }, op));
    } else {
        tx('CUADROS_TXT', cx0, y - hTit, hTxt, `CUADRO DE COORDENADAS: ${n} vértices,`, 'p', { negrita: true });
        tx('CUADROS_TXT', cx0, y - hTit - hTxt * 1.6, hTxt, 'ver informe de linderación (hojas siguientes).', 'p');
        // En el DXF el cuadro completo va fuera de la hoja, a la derecha del marco
        tabla(H - M - 3, 'CUADRO DE COORDENADAS (UTM WGS84 17S)', [0.8, 2, 2.3, 1.3, 1.2, 2.2],
            ['Vértice', 'Este (X)', 'Norte (Y)', 'Lado', 'Distancia (m)', 'Rumbo'], filasCoord,
            { h: hPeq, num: [false, true, true, false, true, false], x0: W + 10, x1: W + 10 + colDer * 1.4, soloDXF: true });
    }

    const primitivas = repartirTextos(prim, mundoAPapel, papelAMundo, vp);
    return { W, H, formato, escala, primitivas, mundoAPapel, papelAMundo, estilos: CAPAS, viewport: vp };
}

// ── Reparto de rotulos ───────────────────────────────────────────────────────
// En un plano apretado las cotas, los nombres de colindante y los numeros de
// vertice caen unos sobre otros y el DXF queda ilegible. Cada rotulo declara
// su prioridad y la direccion en que puede apartarse (hacia fuera del predio,
// no hacia dentro); aqui se recorren de mayor a menor importancia y cada uno
// se corre lo justo para no pisar a los ya colocados. Los secundarios
// (nombre del vecino, del rio) se omiten si no encuentran hueco.

// Rectangulo que ocupa un texto en el papel, contando su giro
function cajaTexto(pr, px, py) {
    const w = anchoTexto(pr.txt, pr.h), h = pr.h;
    const da = { i: 0, c: 0.5, d: 1 }[pr.al] || 0;
    const dv = { b: 0, m: 0.5, t: 1 }[pr.va] || 0;
    const ang = (pr.rot || 0) * Math.PI / 180;
    const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
    const ox = px - ux * w * da - vx * h * dv, oy = py - uy * w * da - vy * h * dv;
    const esq = [[0, 0], [w, 0], [w, h], [0, h]].map(([q, r]) => [ox + ux * q + vx * r, oy + uy * q + vy * r]);
    const xs = esq.map(p => p[0]), ys = esq.map(p => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
const solapan = (a, b, m) => !(a[2] + m < b[0] || b[2] + m < a[0] || a[3] + m < b[1] || b[3] + m < a[1]);

function repartirTextos(prim, mundoAPapel, papelAMundo, vp) {
    const holgura = 0.35;                       // mm de aire entre rotulos
    const fijos = [], movibles = [];
    for (const pr of prim) {
        if (pr.t !== 'tx' || !String(pr.txt).trim()) continue;
        if (pr.esp === 'm') movibles.push(pr);
        else fijos.push(cajaTexto(pr, pr.x, pr.y));   // cuadros y cajetin no se mueven
    }
    movibles.sort((a, b) => (a.prioridad || 9) - (b.prioridad || 9));
    const puestos = fijos;
    const quitar = new Set();
    for (const pr of movibles) {
        // Cada rotulo tiene su sitio y, si lo trae, otros donde vale igual
        // (el nombre de una via sirve en cualquier tramo de su trazado).
        const anclas = [{ x: pr.x, y: pr.y, rot: pr.rot, empuje: pr.empuje }].concat(pr.alternativas || []);
        const paso = pr.h * 1.3;
        // Primero se aparta hacia fuera del predio; si no cabe, tambien corre a
        // lo largo del lado, que es donde suele quedar sitio.
        const probar = (anc) => {
            const base = mundoAPapel([anc.x, anc.y]);
            const e = anc.empuje && Math.hypot(anc.empuje[0], anc.empuje[1]) > 1e-9 ? norm(anc.empuje) : [0, 1];
            const ang = (anc.rot || 0) * Math.PI / 180;
            const eje = [Math.cos(ang), Math.sin(ang)];   // a lo largo del propio texto
            const w = anchoTexto(pr.txt, pr.h);
            const saltos = [[0, 0]];
            for (let k = 1; k <= 6; k++) { saltos.push([0, k * paso]); saltos.push([0, -k * paso]); }
            if (pr.rot !== undefined) {
                for (const j of [0.65, -0.65, 1.3, -1.3]) {
                    for (let k = 0; k <= 3; k++) {
                        saltos.push([j * w, k * paso]);
                        if (k) saltos.push([j * w, -k * paso]);
                    }
                }
            }
            for (const [a, b] of saltos) {
                const px = base[0] + eje[0] * a + e[0] * b;
                const py = base[1] + eje[1] * a + e[1] * b;
                const caja = cajaTexto(Object.assign({}, pr, { rot: anc.rot }), px, py);
                if (caja[0] < vp.x0 || caja[2] > vp.x1 || caja[1] < vp.y0 || caja[3] > vp.y1) continue;
                if (puestos.some(c => solapan(caja, c, holgura))) continue;
                return { px, py, caja, anc };
            }
            return null;
        };
        const buscar = () => { for (const anc of anclas) { const r = probar(anc); if (r) return r; } return null; };
        let puesto = buscar();
        // Nada de abreviar: si no cabe, el rotulo se achica hasta un 70 %
        for (let intento = 0; !puesto && intento < 3 && (pr.prioridad || 9) >= 3; intento++) {
            pr.h *= 0.9;
            puesto = buscar();
        }
        if (!puesto) {
            // Vertices y cotas se quedan donde estan aunque rocen: sin ellos el
            // plano no se puede leer. Lo demas ya consta en los cuadros.
            if ((pr.prioridad || 9) >= 3) { quitar.add(pr); continue; }
            const base = mundoAPapel([pr.x, pr.y]);
            puesto = { px: base[0], py: base[1], caja: cajaTexto(pr, base[0], base[1]), anc: anclas[0] };
        }
        puestos.push(puesto.caja);
        pr.rot = puesto.anc.rot;
        const m = papelAMundo([puesto.px, puesto.py]);
        pr.x = m[0]; pr.y = m[1];
        delete pr.alternativas;
    }
    return quitar.size ? prim.filter(p => !quitar.has(p)) : prim;
}
function norm(v) { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }
function puntoEnAnillo(p, r) {
    let dentro = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
        if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) dentro = !dentro;
    }
    return dentro;
}

module.exports = { construirLamina, CAPAS, FORMATOS, ESCALAS, anchoTexto, cajaTexto, solapan };

};

// ── lib/dxf.js ─────────────────────────────────────────────────────────
__defs["dxf"] = function (module, exports, require) {
const __dirname = "/lib", __filename = "/lib/dxf.js";
const Buffer = __Buffer;
// ─────────────────────────────────────────────────────────────────────────────
//  DXF R12 (AC1009) georreferenciado de la planimetria
//
//  Mismas reglas que construirDXF del visor (ver memoria del proyecto): R12
//  es el unico dialecto que AutoCAD, BricsCAD, ZWCAD y QGIS abren con un
//  esqueleto minimo; nada de LWPOLYLINE ni variables de cabecera posteriores;
//  capa 0 y estilo STANDARD declarados; contenido en ASCII.
//
//  Las entidades del predio y del contexto van en coordenadas UTM reales. El
//  marco, los cuadros y el cajetin van a escala en el espacio modelo, en capas
//  propias, para que el profesional los edite o los apague.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const { construirLamina, CAPAS } = require('./lamina');

function ascii(t) {
    return String(t == null ? '' : t)
        .replace(/°/g, '%%d').replace(/²/g, '2').replace(/[·•]/g, '-').replace(/[ñ]/g, 'n').replace(/[Ñ]/g, 'N')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^\x20-\x7E]/g, '').trim();
}

function construirDXFPlanimetria(proyecto) {
    const lam = construirLamina(proyecto);
    const f = 1000 / lam.escala;
    const L = [];
    const g = (c, v) => { L.push(String(c)); L.push(String(v)); };
    const num = v => {
        const n = Number(v);
        if (!isFinite(n)) throw new Error('Coordenada no numerica en el DXF: ' + v);
        return n.toFixed(4);
    };
    const aMundo = (p, esp) => esp === 'm' ? p : lam.papelAMundo(p);

    // Capas usadas y su color
    const capas = new Map([['0', 7]]);
    const nombreCapa = pr => ascii(pr.dxfCapa || pr.capa).toUpperCase().replace(/[^A-Z0-9_\-]/g, '_');
    for (const pr of lam.primitivas) {
        if (pr.soloPDF) continue;
        const nom = nombreCapa(pr);
        if (!capas.has(nom)) {
            const base = CAPAS[pr.capa] || {};
            capas.set(nom, base.aci || 7);
        }
    }
    // Color propio de cada elemento certificado (config.color_dxf)
    for (const e of (proyecto.analisis.afectaciones && proyecto.analisis.afectaciones.elementos) || []) {
        const c = ascii(e.capaDXF || 'ELEMENTO').toUpperCase();
        for (const suf of ['', '_MARGEN', '_TXT']) if (capas.has(c + suf) && e.colorDXF) capas.set(c + suf, e.colorDXF);
    }

    // Extension del dibujo
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const ext = p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); };
    for (const pr of lam.primitivas) {
        if (pr.soloPDF) continue;
        if (pr.t === 'pl') pr.pts.forEach(p => ext(aMundo(p, pr.esp)));
        else ext(aMundo([pr.x, pr.y], pr.esp));
    }

    // ── HEADER ───────────────────────────────────────────────────────────────
    g(0, 'SECTION'); g(2, 'HEADER');
    g(9, '$ACADVER'); g(1, 'AC1009');
    g(9, '$INSBASE'); g(10, '0.0'); g(20, '0.0'); g(30, '0.0');
    g(9, '$EXTMIN'); g(10, num(x0)); g(20, num(y0)); g(30, '0.0');
    g(9, '$EXTMAX'); g(10, num(x1)); g(20, num(y1)); g(30, '0.0');
    g(9, '$LIMMIN'); g(10, num(x0)); g(20, num(y0));
    g(9, '$LIMMAX'); g(10, num(x1)); g(20, num(y1));
    g(9, '$LTSCALE'); g(40, (1 / f).toFixed(4));
    g(0, 'ENDSEC');

    // ── TABLES ───────────────────────────────────────────────────────────────
    g(0, 'SECTION'); g(2, 'TABLES');
    g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 2);
    g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, '0.0');
    g(0, 'LTYPE'); g(2, 'DASHED'); g(70, 0); g(3, '__ __ __'); g(72, 65); g(73, 2); g(40, '4.0'); g(49, '3.0'); g(49, '-1.0');
    g(0, 'ENDTAB');

    g(0, 'TABLE'); g(2, 'LAYER'); g(70, capas.size);
    for (const [nom, color] of capas) {
        const est = Object.entries(CAPAS).find(([k]) => k === nom);
        const trazo = est && est[1].trazo === 'DASHED' ? 'DASHED' : 'CONTINUOUS';
        g(0, 'LAYER'); g(2, nom); g(70, 0); g(62, color); g(6, trazo);
    }
    g(0, 'ENDTAB');

    // Dos estilos: ARIAL es el que usan los rotulos (codigo 3 = archivo de
    // fuente; AutoCAD, BricsCAD y QGIS resuelven arial.ttf del sistema) y
    // STANDARD queda declarado porque todo DXF lo espera, como la capa 0.
    g(0, 'TABLE'); g(2, 'STYLE'); g(70, 2);
    g(0, 'STYLE'); g(2, 'STANDARD'); g(70, 0); g(40, '0.0'); g(41, '1.0');
    g(50, '0.0'); g(71, 0); g(42, '2.5'); g(3, 'txt'); g(4, '');
    g(0, 'STYLE'); g(2, 'ARIAL'); g(70, 0); g(40, '0.0'); g(41, '1.0');
    g(50, '0.0'); g(71, 0); g(42, '2.5'); g(3, 'arial.ttf'); g(4, '');
    g(0, 'ENDTAB');
    g(0, 'ENDSEC');

    g(0, 'SECTION'); g(2, 'BLOCKS'); g(0, 'ENDSEC');

    // ── ENTITIES ─────────────────────────────────────────────────────────────
    g(0, 'SECTION'); g(2, 'ENTITIES');
    for (const pr of lam.primitivas) {
        if (pr.soloPDF) continue;          // la foto de ubicacion solo va en el PDF
        const capa = nombreCapa(pr);
        if (pr.t === 'pl') {
            let pts = pr.pts.map(p => aMundo(p, pr.esp)).filter(p => isFinite(p[0]) && isFinite(p[1]));
            let cerrada = pr.cerrada;
            // anillos que ya traen el vertice de cierre repetido
            if (pts.length > 2 && Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-6 && Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-6) { pts = pts.slice(0, -1); cerrada = true; }
            if (pts.length < 2) continue;
            g(0, 'POLYLINE'); g(8, capa); g(66, 1); g(70, cerrada ? 1 : 0);
            g(10, '0.0'); g(20, '0.0'); g(30, '0.0');
            for (const p of pts) { g(0, 'VERTEX'); g(8, capa); g(10, num(p[0])); g(20, num(p[1])); g(30, '0.0'); g(70, 0); }
            g(0, 'SEQEND'); g(8, capa);
        } else if (pr.t === 'tx') {
            const txt = ascii(pr.txt);
            if (!txt) continue;
            const p = aMundo([pr.x, pr.y], pr.esp);
            const h = pr.h / f;
            const al = { i: 0, c: 1, d: 2 }[pr.al] || 0;
            const va = { b: 0, m: 2, t: 3 }[pr.va] || 0;
            g(0, 'TEXT'); g(8, capa);
            g(10, num(p[0])); g(20, num(p[1])); g(30, '0.0');
            g(40, h.toFixed(4)); g(1, txt);
            if (pr.rot) g(50, Number(pr.rot).toFixed(4));
            g(7, 'ARIAL');
            if (al || va) { g(72, al); g(11, num(p[0])); g(21, num(p[1])); g(31, '0.0'); g(73, va); }
        } else if (pr.t === 'ci') {
            const p = aMundo([pr.x, pr.y], pr.esp);
            g(0, 'CIRCLE'); g(8, capa); g(10, num(p[0])); g(20, num(p[1])); g(30, '0.0'); g(40, (pr.r / f).toFixed(4));
        } else if (pr.t === 'pt') {
            const p = aMundo([pr.x, pr.y], pr.esp);
            g(0, 'POINT'); g(8, capa); g(10, num(p[0])); g(20, num(p[1])); g(30, '0.0');
        }
    }
    g(0, 'ENDSEC'); g(0, 'EOF');
    return L.join('\r\n') + '\r\n';
}

module.exports = { construirDXFPlanimetria, ascii };

};

// ── lib/pdf.js ─────────────────────────────────────────────────────────
__defs["pdf"] = function (module, exports, require) {
const __dirname = "/lib", __filename = "/lib/pdf.js";
const Buffer = __Buffer;
// ─────────────────────────────────────────────────────────────────────────────
//  PDF de la planimetria: lamina a escala + informe de linderacion
//
//  Hoja 1 (horizontal): la misma lamina que el DXF, dibujada en vectorial.
//  Hojas siguientes (vertical, mismo formato A4 o A3): informe de linderacion
//  con datos generales, diagnostico catastral, linderos redactados, cuadro de
//  coordenadas, superficies y afectaciones, normativa y firmas.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');
const { jsPDF } = require('jspdf');
const autoTableMod = require('jspdf-autotable');
const autoTable = autoTableMod.default || autoTableMod;
const { construirLamina, FORMATOS } = require('./lamina');

const ROJO = [227, 30, 36], GRAFITO = [46, 50, 56], MEDIO = [86, 91, 99], HUESO = [247, 247, 248];
const fmt = (v, d) => (v === null || v === undefined || v === '' || !isFinite(Number(v))) ? '-' :
    Number(v).toLocaleString('es-EC', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false });

let _logo = null;
function logo() {
    if (_logo !== null) return _logo;
    try { _logo = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '..', '..', 'LOGO', 'logo-caech.png')).toString('base64'); }
    catch (e) { _logo = ''; }
    return _logo;
}

/**
 * El navegador no tiene sistema de archivos: alli el logo se baja por fetch y
 * se entrega aqui ya en data URL. En Node no hace falta llamarla.
 */
function fijarLogo(dataURL) { _logo = dataURL || ''; }

function dibujarLamina(doc, lam) {
    const H = lam.H;
    const aPapel = (p, esp) => { const q = esp === 'm' ? lam.mundoAPapel(p) : p; return [q[0], H - q[1]]; };
    for (const pr of lam.primitivas) {
        if (pr.soloDXF) continue;
        const est = lam.estilos[pr.capa] || { rgb: GRAFITO, lw: 0.2 };
        if (pr.t === 'pl') {
            const pts = pr.pts.map(p => aPapel(p, pr.esp));
            if (pts.length < 2) continue;
            doc.setDrawColor(...est.rgb);
            doc.setLineWidth(est.lw || 0.2);
            doc.setLineDashPattern(est.trazo === 'DASHED' ? [1.6, 0.9] : [], 0);
            const deltas = [];
            for (let i = 1; i < pts.length; i++) deltas.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
            let estilo = 'S';
            if (pr.relleno) { doc.setFillColor(...(est.relleno || est.rgb)); estilo = est.relleno ? 'FD' : 'F'; }
            doc.lines(deltas, pts[0][0], pts[0][1], [1, 1], estilo, pr.cerrada || pr.relleno);
            doc.setLineDashPattern([], 0);
        } else if (pr.t === 'tx') {
            const [x, y] = aPapel([pr.x, pr.y], pr.esp);
            doc.setFont('helvetica', pr.negrita ? 'bold' : 'normal');
            doc.setFontSize(pr.h / 0.72 / 0.3528);
            doc.setTextColor(...est.rgb);
            const w = doc.getTextWidth(pr.txt);
            const ang = (pr.rot || 0) * Math.PI / 180;
            const ux = Math.cos(ang), uy = Math.sin(ang);          // eje del texto (y hacia arriba)
            const vx = -uy, vy = ux;                                // perpendicular hacia arriba
            const da = { i: 0, c: 0.5, d: 1 }[pr.al] || 0;
            const dv = { b: 0, m: 0.5, t: 1 }[pr.va] || 0;
            const ox = -ux * w * da - vx * pr.h * dv, oy = -uy * w * da - vy * pr.h * dv;
            doc.text(pr.txt, x + ox, y - oy, { angle: pr.rot || 0 });
        } else if (pr.t === 'ci') {
            const [x, y] = aPapel([pr.x, pr.y], pr.esp);
            doc.setDrawColor(...est.rgb); doc.setLineWidth(est.lw || 0.2);
            doc.circle(x, y, pr.r, 'S');
        } else if (pr.t === 'img' && pr.png) {
            // Imagen del mapa de ubicacion: el PDF si la admite, el DXF no
            const [x, y] = aPapel([pr.x, pr.y + pr.h], pr.esp);
            try { doc.addImage(pr.png, pr.formato || 'JPEG', x, y, pr.w, pr.h); } catch (e) { }
        }
    }
    doc.setTextColor(0, 0, 0);
}

// Titulares del predio. Puede haber varios (conyuges, herederos, donatarios,
// socios); los proyectos antiguos traen un solo nombre en `propietario`.
function propietariosDe(d) {
    if (Array.isArray(d.propietarios) && d.propietarios.length) return d.propietarios.filter(p => String(p.nombre || '').trim());
    return d.propietario ? [{ nombre: d.propietario, documento: d.documento || '', calidad: '', participacion: '', observacion: '' }] : [];
}

function construirPDF(proyecto) {
    const a = proyecto.analisis, d = proyecto.datos || {};
    const titulares = propietariosDe(d);
    const lam = construirLamina(proyecto);
    const [LW, LH] = FORMATOS[lam.formato];
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: lam.formato.toLowerCase(), compress: true });
    // Las fuentes estandar de PDF solo cubren Latin-1: fuera de ese juego jsPDF
    // escribe basura ("≥30" salia como '"e30'). Se traduce lo habitual y se
    // descarta el resto, tambien en lo que dibuja autoTable.
    const latin1 = t => String(t)
        .replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/[–—]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
        .replace(/…/g, '...').replace(/→/g, '»').replace(/•/g, '·').replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/g, '');
    const limpiar = t => Array.isArray(t) ? t.map(limpiar) : (typeof t === 'string' ? latin1(t) : t);
    for (const m of ['text', 'getTextWidth', 'splitTextToSize']) {
        const orig = doc[m].bind(doc);
        doc[m] = (t, ...resto) => orig(limpiar(t), ...resto);
    }
    doc.setProperties({ title: 'Planimetria - ' + (d.propietario || 'predio'), creator: 'Planimetria CAE-CH', subject: 'Informe de linderacion' });
    dibujarLamina(doc, lam);

    // ── Informe de linderacion ───────────────────────────────────────────────
    doc.addPage(lam.formato.toLowerCase(), 'portrait');
    const PW = LH, PH = LW;                       // vertical
    const k = lam.formato === 'A3' ? 1.25 : 1;
    const mg = 16 * k;
    const cuerpo = 9 * k, peq = 7.5 * k;
    let y = mg;

    const codigo = d.codigo || ('PLN-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ''));
    const conCabecera = new Set();
    const cabecera = () => {
        const pag = doc.internal.getCurrentPageInfo().pageNumber;
        if (conCabecera.has(pag)) return;
        conCabecera.add(pag);
        const img = logo();
        if (img) { try { doc.addImage(img, 'PNG', mg, 8 * k, 36 * k, 13 * k); } catch (e) { } }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(peq); doc.setTextColor(...MEDIO);
        doc.text(codigo, PW - mg, 12 * k, { align: 'right' });
        doc.text('UTM WGS84 Zona 17 Sur (EPSG:32717)', PW - mg, 16 * k, { align: 'right' });
        doc.setDrawColor(...ROJO); doc.setLineWidth(0.5);
        doc.line(mg, 23 * k, PW - mg, 23 * k);
    };
    cabecera();
    y = 32 * k;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15 * k); doc.setTextColor(...GRAFITO);
    doc.text('INFORME DE LINDERACIÓN Y PLANIMETRÍA', PW / 2, y, { align: 'center' });
    y += 6 * k;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(cuerpo); doc.setTextColor(...MEDIO);
    const conClave = proyecto.conciliacion && proyecto.conciliacion.predioCatastral && proyecto.conciliacion.predioCatastral.coincide;
    doc.text((conClave || d.claveCatastral ? 'Predio con clave catastral' : 'Predio sin registro catastral') + ' · levantamiento topográfico georreferenciado', PW / 2, y, { align: 'center' });
    y += 8 * k;

    let nSeccion = 0;
    const seccion = titulo => {
        if (y > PH - 40 * k) { doc.addPage(lam.formato.toLowerCase(), 'portrait'); cabecera(); y = 32 * k; }
        else if (nSeccion) y += 2 * k;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5 * k); doc.setTextColor(...ROJO);
        doc.text(`${++nSeccion}. ${titulo.replace(/^\d+\.\s*/, '')}`.toUpperCase(), mg, y);
        y += 2 * k;
        doc.setDrawColor(...ROJO); doc.setLineWidth(0.3); doc.line(mg, y, mg + 18 * k, y);
        y += 4 * k;
        doc.setTextColor(...GRAFITO);
    };
    const parrafo = (texto, opt) => {
        opt = opt || {};
        doc.setFont('helvetica', opt.negrita ? 'bold' : 'normal'); doc.setFontSize(opt.size || cuerpo);
        doc.setTextColor(...(opt.color || GRAFITO));
        const lineas = doc.splitTextToSize(texto, PW - 2 * mg - (opt.sangria || 0));
        for (const l of lineas) {
            if (y > PH - 22 * k) { doc.addPage(lam.formato.toLowerCase(), 'portrait'); cabecera(); y = 32 * k; }
            doc.text(l, mg + (opt.sangria || 0), y);
            y += (opt.size || cuerpo) * 0.3528 * 1.45;
        }
        y += 1.5 * k;
    };
    const tabla = (head, body, opt) => {
        autoTable(doc, Object.assign({
            startY: y, head: head ? [head] : undefined, body,
            margin: { left: mg, right: mg, top: 30 * k, bottom: 18 * k },
            styles: { font: 'helvetica', fontSize: peq, cellPadding: 1.3 * k, textColor: GRAFITO, lineColor: [210, 212, 216], lineWidth: 0.15 },
            headStyles: { fillColor: GRAFITO, textColor: 255, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: HUESO },
            didDrawPage: () => cabecera()
        }, opt || {}));
        y = doc.lastAutoTable.finalY + 6 * k;
    };

    // 1. Datos generales
    seccion('Datos generales');
    const u = a.ubicacion || {};
    tabla(null, [
        [titulares.length > 1 ? 'Propietarios / posesionarios' : 'Propietario / posesionario',
            titulares.length ? titulares.map(p => [p.nombre,
                p.documento ? 'C.I./RUC ' + p.documento : '',
                p.calidad || '',
                p.participacion ? 'cuota ' + p.participacion : '',
                p.observacion || ''].filter(Boolean).join(' · ')).join('\n') : 'POR COMPLETAR'],
        ['Dirección / sector', [d.direccion, d.sector].filter(Boolean).join(' - ') || 'POR COMPLETAR'],
        ['Parroquia / zona', [u.parroquia, u.zona].filter(Boolean).join(' - ') || '-'],
        ['Clave catastral', d.claveCatastral || 'Predio no catastrado'],
        ['Superficie según escritura', d.areaEscritura ? fmt(String(d.areaEscritura).replace(',', '.'), 2) + ' m²'
            : proyecto.conciliacion && proyecto.conciliacion.area ? fmt(proyecto.conciliacion.area.registral, 2) + ' m²' : '-'],
        ['Profesional responsable', [d.profesional, d.registro ? 'Registro ' + d.registro : ''].filter(Boolean).join(' - ') || 'POR COMPLETAR'],
        ['Fecha y método de levantamiento', [d.fechaLevantamiento, d.equipo, d.precision ? 'precisión ' + d.precision : ''].filter(Boolean).join(' - ') || '-'],
        ['Centro del predio', `${fmt(a.centroide[0], 4)} E, ${fmt(a.centroide[1], 4)} N  (${a.centro.lat.toFixed(6)}, ${a.centro.lon.toFixed(6)})`]
    ], { columnStyles: { 0: { fontStyle: 'bold', cellWidth: 58 * k } }, alternateRowStyles: {} });

    // 2. Superficie y diagnostico catastral
    seccion('Superficie y situación catastral');
    parrafo(`El predio levantado tiene una superficie de ${fmt(a.area, 2)} m² y un perímetro de ${fmt(a.perimetro, 2)} m, ` +
        `definidos por ${a.vertices.length} vértices. Las medidas se calculan en el plano UTM WGS84 17S, el mismo en que el GAD Municipal de Riobamba produce su catastro.`);
    const diag = a.catastro.diagnostico;
    const pc = proyecto.conciliacion && proyecto.conciliacion.predioCatastral;
    if (pc && pc.coincide) {
        parrafo(`El levantamiento corresponde al predio catastral ${pc.clave}, que es la clave que declara el título (superposición del ${fmt(pc.pct, 2)} %).`);
    } else parrafo(diag.texto, { negrita: diag.tipo !== 'libre' && diag.tipo !== 'roce', color: diag.tipo === 'libre' || diag.tipo === 'roce' ? GRAFITO : ROJO });
    if (a.catastro.solapes.length) {
        tabla(['Clave catastral', 'Titular catastral', 'Solape m²', '% del levantamiento'],
            a.catastro.solapes.slice(0, 12).map(s => [s.clave, s.nombre, fmt(s.area, 2), fmt(s.pctPredio, 2) + ' %']),
            { columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' } } });
    }

    // Informacion registral (certificado de gravamenes)
    const R = proyecto.registral, C = proyecto.conciliacion;
    if (R && (R.ficha || (R.linderos || []).length || R.area)) {
        seccion('Información registral');
        const filasR = [
            ['Ficha registral / certificado', [R.ficha ? 'Ficha ' + R.ficha : '', R.certificado ? 'certificado ' + R.certificado : '', R.emitido ? 'emitido ' + R.emitido : ''].filter(Boolean).join(' · ') || '-'],
            ['Propietario(s) inscrito(s)', (R.propietarios || []).map(p => `${p.nombre}${p.inscripcion ? ` (inscripción ${p.inscripcion}, ${p.fecha || p.anio || ''})` : ''}`).join('; ') || '-'],
            ['Ubicación según título', [R.ubicacion, R.parroquia ? 'parroquia ' + R.parroquia : ''].filter(Boolean).join(' · ') || '-'],
            ['Clave catastral en el título', R.claveCatastral || '-'],
            ['Superficie según título', R.area && R.area.valor ? `${fmt(R.area.valor, 2)} ${R.area.unidad === 'ha' ? 'ha' : R.area.unidad === 'cuadra' ? 'cuadras' : 'm²'}` : '-'],
            ['Gravámenes', R.gravamenes ? (R.gravamenes.vigentes && R.gravamenes.vigentes.length ? 'CON MOVIMIENTOS VIGENTES: ' + R.gravamenes.vigentes.map(v => v.acto).join(', ') : (R.gravamenes.libre ? 'Libre de gravámenes. ' : '') + (R.gravamenes.texto || '')) : '-']
        ];
        tabla(null, filasR, { columnStyles: { 0: { fontStyle: 'bold', cellWidth: 58 * k } }, alternateRowStyles: {} });
        if ((R.linderos || []).length) {
            tabla(['Orientación (título)', 'Colindante según título', 'Longitud'],
                R.linderos.map(l => [l.orientacion || '-', l.colindante || '-', l.longitud !== null && l.longitud !== undefined ? fmt(l.longitud, 2) + ' m' : '-']),
                { columnStyles: { 2: { halign: 'right' } } });
        }
        if ((R.movimientos || []).length) {
            tabla(['Libro', 'Acto', 'Inscripción', 'Fecha', 'Gravamen'], R.movimientos.map(m => [m.libro, m.acto, m.numero, m.fecha, m.gravamen]));
        }
    }

    // Antes y hoy
    if (C && (C.lados.some(l => l.registral) || C.area)) {
        seccion('Título (antes) y levantamiento (hoy)');
        if (C.usaRelativas) parrafo(`El título describe el predio por frente, fondo y lados. El frente se ubicó al ${C.frente || '[SIN DEFINIR]'}${C.origenFrente ? ' (' + C.origenFrente + ')' : ''}; por tanto el fondo, el lado derecho y el lado izquierdo se leen mirando el predio desde ese frente.`, { size: peq, color: MEDIO });
        tabla(['Lindero', 'Según título (antes)', 'Según levantamiento (hoy)', 'Dif.', 'Colindante'],
            C.lados.map(l => [
                l.dir + (l.relativo ? `\n(${l.relativo})` : ''),
                l.registral ? `${l.registral.colindante || '-'}${l.registral.longitud !== null ? '\n' + fmt(l.registral.longitud, 2) + ' m' : ''}` : 'Sin dato en el título',
                `${l.hoy.linderos.map(x => x.colindante || '[por completar]').join(' / ')}\n${fmt(l.hoy.longitud, 2)} m`,
                l.dif !== null ? `${l.dif > 0 ? '+' : ''}${fmt(l.dif, 2)} m\n(${l.pct > 0 ? '+' : ''}${fmt(l.pct, 2)} %)` : '-',
                { mismo: 'Mismo colindante', cambio: 'Cambió (sin relación anotada)', cambio_documentado: 'Cambió · relación anotada', dividido: 'Hoy son varios (sin relación)', dividido_documentado: 'Hoy son varios · relación anotada', sin_dato: '-' }[l.estadoColindante]
            ]),
            {
                columnStyles: { 3: { halign: 'right', cellWidth: 24 * k }, 0: { cellWidth: 24 * k } },
                didParseCell: c => { if (c.section === 'body' && c.column.index === 4 && /sin relaci/.test(c.cell.raw)) c.cell.styles.textColor = ROJO; }
            });
        for (const l of C.lados.filter(x => x.historia && x.historia.length > 1)) {
            const serie = l.historia.map(h => `${h.fecha ? h.fecha.slice(0, 4) : '?'}: ${h.longitud !== null ? fmt(h.longitud, 2) + ' m' : '-'}`).join(' → ');
            const cambia = new Set(l.historia.map(h => h.longitud)).size > 1;
            if (cambia) parrafo(`Evolución del lindero ${l.dir}${l.relativo ? ' (' + l.relativo + ')' : ''} en los actos inscritos: ${serie} → hoy ${fmt(l.hoy.longitud, 2)} m.`, { size: peq });
        }
        if (C.area) parrafo(C.area.texto + (C.area.etamVerificado ? '' : ' El porcentaje de ETAM aplicado es un parámetro por verificar en la ordenanza vigente.'), { negrita: C.area.estado === 'excedente' || C.area.estado === 'diferencia' });
        const cambios = C.lados.filter(l => /cambio|dividido/.test(l.estadoColindante));
        if (cambios.length) parrafo(`Los colindantes actuales difieren de los del título en: ${cambios.map(l => l.dir).join(', ')}. Los linderos del apartado siguiente declaran el colindante de hoy y, cuando se conoce, su relación con el que consta en el título.`, { size: peq, color: MEDIO });
    }

    // Linderos
    seccion('Linderos y dimensiones');
    const tipoTexto = l => ({ catastro: 'Catastro GADMR', escritura: 'Según título', campo: 'Declarado en campo', via: l.referencia || 'Vía', agua: 'Cuerpo de agua', dxf: 'Plano del profesional', manual: 'Declarado en campo', otro: 'Otro' }[l.tipo || l.fuente] || 'Declarado en campo');
    for (const dir of ['Norte', 'Sur', 'Este', 'Oeste']) {
        const ls = a.linderos.filter(l => l.dir === dir);
        if (!ls.length) continue;
        const partes = ls.map(l => {
            const esVia = (l.tipo || l.fuente) === 'via';
            let quien = esVia ? `con ${l.colindante || 'vía pública'}`
                : `con ${l.colindante ? ((l.tipo || l.fuente) === 'agua' ? l.colindante : 'propiedad de ' + l.colindante) : '[COLINDANTE POR COMPLETAR]'}`;
            if (l.clave && (l.tipo || l.fuente) === 'catastro') quien += ` (clave ${l.clave})`;
            if (['campo', 'manual'].includes(l.tipo || l.fuente) && l.colindante) quien += ', según lo declarado en campo';
            if (l.antecesor) quien += `, que en el título consta como ${l.antecesor}`;
            if (l.observacion) quien += ` (${l.observacion})`;
            return `en ${fmt(l.longitud, 2)} m, desde ${l.desde} hasta ${l.hasta}, ${quien}`;
        });
        const total = ls.reduce((s, l) => s + l.longitud, 0);
        parrafo(`${dir.toUpperCase()}: ${partes.join('; ')}.` + (ls.length > 1 ? ` Longitud total ${fmt(total, 2)} m.` : ''));
    }
    tabla(['N.', 'Orient.', 'Desde', 'Hasta', 'Colindante', 'Fuente', 'Long. m'],
        a.linderos.map(l => [l.n, l.dir, l.desde, l.hasta, (l.colindante || 'POR COMPLETAR') + (l.antecesor ? `\n(título: ${l.antecesor})` : ''),
        tipoTexto(l), fmt(l.longitud, 2)]),
        { columnStyles: { 6: { halign: 'right' } } });

    // 4. Coordenadas
    seccion('Cuadro de coordenadas, distancias y rumbos');
    tabla(['Vértice', 'Pto. campo', 'Este X (m)', 'Norte Y (m)', 'Lado', 'Distancia (m)', 'Rumbo', 'Azimut'],
        a.lados.map((l, i) => [a.vertices[i].id, a.vertices[i].idCampo || '', fmt(a.vertices[i].x, 4), fmt(a.vertices[i].y, 4),
        `${l.desde}-${l.hasta}`, fmt(l.L, 3), l.rumbo, l.azimutDMS]),
        { columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 5: { halign: 'right' } } });

    // 5. Afectaciones
    seccion('Afectaciones y márgenes de protección');
    const af = a.afectaciones || {};
    const filas = [['Superficie levantada', '', fmt(a.area, 2)]];
    if (af.lineaFabrica && af.lineaFabrica.total > 0) {
        filas.push(['Afectación por línea de fábrica', `${af.lineaFabrica.franjas.length} franja(s) · Líneas de fábrica GADMR`, fmt(af.lineaFabrica.total, 2)]);
    }
    for (const e of af.elementos || []) {
        filas.push([e.nombre + (e.cercanos[0] && e.cercanos[0].nombre ? ' - ' + e.cercanos[0].nombre : ''),
        `a ${fmt(e.distancia, 2)} m · margen ${e.margen === null ? 'sin definir' : fmt(e.margen, 2) + ' m'}${e.margenEditado ? ' (ingresado por el profesional)' : e.verificado ? '' : ' (por verificar)'}`,
        e.afecta ? fmt(e.area, 2) : '0,00']);
    }
    filas.push(['Superficie afectada total (sin doble conteo)', '', fmt(af.areaAfectada || 0, 2)]);
    filas.push(['SUPERFICIE ÚTIL', '', fmt(af.areaUtil != null ? af.areaUtil : a.area, 2)]);
    tabla(['Concepto', 'Detalle', 'm²'], filas, {
        columnStyles: { 2: { halign: 'right', cellWidth: 26 * k } },
        didParseCell: c => { if (c.section === 'body' && c.row.index === filas.length - 1) c.cell.styles.fontStyle = 'bold'; }
    });
    const bases = (af.elementos || []).filter(e => e.margen !== null).map(e => `${e.nombre}: ${e.baseLegal || '-'}`);
    if (bases.length) parrafo('Base de los márgenes aplicados: ' + bases.join(' | '), { size: peq, color: MEDIO });
    if (!(af.elementos || []).length) parrafo('No se identificaron ríos, quebradas, vías certificadas ni líneas férreas a menos de 50 m del predio en las capas certificadas cargadas.', { size: peq, color: MEDIO });

    // 6. Normativa
    if (u.pugs) {
        seccion('Normativa urbanística (PUGS)');
        const p = u.pugs;
        tabla(null, [
            ['Clasificación / subclasificación', [p.clasificacion, p.subclasificacion].filter(Boolean).join(' - ')],
            ['Polígono de intervención / tratamiento', [p.codigo, p.tratamiento].filter(Boolean).join(' - ')],
            ['Lote mínimo / frente mínimo', `${p.loteMinimo || '-'} m² / ${p.frenteMinimo || '-'} m`],
            ['Retiros frontal / lateral / posterior', `${p.retiros.frontal || '-'} / ${p.retiros.lateral || '-'} / ${p.retiros.posterior || '-'} m`],
            ['COS PB / COS total / pisos', [p.cos, p.cut].map(v => !v ? '-' : /%/.test(v) || !/\d/.test(v) ? v : v + ' %').join(' / ') + ` / ${p.pisos || '-'}`],
            ['Implantación / uso principal', [p.implantacion, p.usoPrincipal].filter(Boolean).join(' - ')]
        ], { columnStyles: { 0: { fontStyle: 'bold', cellWidth: 62 * k } }, alternateRowStyles: {} });
        if (p.verificacion && p.verificacion.length) {
            tabla(['Parámetro', 'Norma', 'Predio', 'Resultado'], p.verificacion.map(v => [v.item, v.norma, v.predio, v.cumple ? 'Cumple' : 'No cumple']),
                { didParseCell: c => { if (c.section === 'body' && c.column.index === 3) c.cell.styles.textColor = c.cell.raw === 'Cumple' ? [30, 132, 73] : ROJO; } });
        }
    }

    // 7. Control de calidad
    seccion('Control de calidad frente al catastro');
    const conV = a.vertices.filter(v => v.catastral);
    if (conV.length) {
        const max = Math.max(...conV.map(v => v.catastral.dist));
        const med = conV.reduce((s, v) => s + v.catastral.dist, 0) / conV.length;
        parrafo(`${conV.length} de ${a.vertices.length} vértices levantados tienen un vértice catastral a menos de 2 m. Desvío medio ${fmt(med, 3)} m, máximo ${fmt(max, 3)} m. ` +
            `Tolerancia usada para reconocer linderos comunes: ${fmt(a.tolLindero, 2)} m.`);
    } else parrafo('Ningún vértice levantado coincide con vértices del catastro a menos de 2 m.');

    // 8. Observaciones
    const avisos = (a.avisos || []).concat(C ? C.avisos.filter(t => !C.area || t !== C.area.texto) : []);
    if (d.observaciones || avisos.length) {
        seccion('Observaciones');
        if (d.observaciones) parrafo(d.observaciones);
        avisos.forEach(t => parrafo('· ' + t, { size: peq, color: MEDIO, sangria: 2 }));
    }

    // Firmas: el profesional y una por cada titular, de dos en dos
    const firmas = [[d.profesional || 'Profesional responsable', d.registro ? 'Registro ' + d.registro : 'Registro profesional']]
        .concat(titulares.length
            ? titulares.map(p => [p.nombre, [p.documento ? 'C.I./RUC ' + p.documento : 'C.I.', p.calidad, p.participacion].filter(Boolean).join(' · ')])
            : [['Propietario / posesionario', 'C.I.']]);
    const filasFirmas = Math.ceil(firmas.length / 2);
    const altoFirmas = filasFirmas * 20 * k;
    if (y + altoFirmas > PH - 24 * k) { doc.addPage(lam.formato.toLowerCase(), 'portrait'); cabecera(); y = 40 * k; }
    else y = Math.max(y + 18 * k, PH - 20 * k - altoFirmas);
    const cw = (PW - 2 * mg) / 2;
    firmas.forEach(([n1, n2], j) => {
        const x = mg + cw * (j % 2) + cw / 2;
        const yf = y + Math.floor(j / 2) * 20 * k;
        doc.setDrawColor(...GRAFITO); doc.setLineWidth(0.3); doc.line(x - 32 * k, yf, x + 32 * k, yf);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(cuerpo); doc.setTextColor(...GRAFITO);
        doc.text(doc.splitTextToSize(n1, cw - 6 * k)[0], x, yf + 5 * k, { align: 'center' });
        doc.setFont('helvetica', 'normal'); doc.setFontSize(peq); doc.setTextColor(...MEDIO);
        doc.text(doc.splitTextToSize(n2, cw - 6 * k)[0], x, yf + 9 * k, { align: 'center' });
    });

    // Pie en las hojas del informe
    const total = doc.internal.getNumberOfPages();
    for (let p = 2; p <= total; p++) {
        doc.setPage(p);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5 * k); doc.setTextColor(...MEDIO);
        doc.text('Documento técnico generado con Planimetría CAE-CH. No sustituye la aprobación ni el registro catastral del GAD Municipal de Riobamba.', mg, PH - 9 * k);
        doc.text(`Hoja ${p} de ${total}`, PW - mg, PH - 9 * k, { align: 'right' });
    }
    return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { construirPDF, propietariosDe, fijarLogo };

};

global.Planimetria = {};
Object.defineProperty(global.Planimetria, "nucleo", { get: () => require("./nucleo"), enumerable: true });
Object.defineProperty(global.Planimetria, "capas", { get: () => require("./capas"), enumerable: true });
Object.defineProperty(global.Planimetria, "entrada", { get: () => require("./entrada"), enumerable: true });
Object.defineProperty(global.Planimetria, "analisis", { get: () => require("./analisis"), enumerable: true });
Object.defineProperty(global.Planimetria, "conciliacion", { get: () => require("./conciliacion"), enumerable: true });
Object.defineProperty(global.Planimetria, "registral", { get: () => require("./registral"), enumerable: true });
Object.defineProperty(global.Planimetria, "lamina", { get: () => require("./lamina"), enumerable: true });
Object.defineProperty(global.Planimetria, "dxf", { get: () => require("./dxf"), enumerable: true });
Object.defineProperty(global.Planimetria, "pdf", { get: () => require("./pdf"), enumerable: true });
}(typeof window !== "undefined" ? window : this));