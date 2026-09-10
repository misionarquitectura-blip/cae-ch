// ─────────────────────────────────────────────────────────────────────────────
//  Cobertura de telecomunicaciones (capa 5) — CNT EP
//
//  La capa 5 no es un GeoJSON: son PNG paletizados que "DATA SET/build_telecom.py"
//  baja del WMS de CNT y recorta a Chimborazo. Un error de bbox, de malla o de
//  paleta no rompe nada de forma visible —el mapa sigue dibujando algo— pero
//  desplaza la lectura que el DICAT imprime como cobertura de un predio. De ahi
//  que esto se compruebe.
//
//  Verifica cuatro cosas distintas:
//    1. El manifest y los PNG concuerdan: cada pieza existe, tiene el tamano
//       declarado, y su paleta es un subconjunto de la del manifest.
//    2. La malla de cada tier embaldosa su bbox sin huecos ni solapes.
//    3. piezaFinaTelecom() de geovisor.html — el codigo REAL, extraido del
//       HTML — elige el tier fino dentro de Riobamba y cae al provincial fuera.
//    4. El raster dice lo que debe en coordenadas conocidas, y los dos tiers
//       coinciden entre si donde se solapan.
//
//  Ejecutar:  node test/telecom.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const H = require('./lib/harness');

const BASE = path.join(H.RAIZ, 'DATA SET', 'telecom');
console.log('TELECOMUNICACIONES — cobertura CNT EP (capa 5)\n');

if (!fs.existsSync(path.join(BASE, 'manifest.json'))) {
    console.log('  ! No existe DATA SET/telecom/manifest.json.');
    console.log('    Se genera con: python "DATA SET/build_telecom.py"');
    process.exitCode = 1;
    return;
}
const man = JSON.parse(fs.readFileSync(path.join(BASE, 'manifest.json'), 'utf8'));

// ── Lector de PNG paletizado ─────────────────────────────────────────────────
// Solo el caso que escribe build_telecom.py: 8 bits, colorType 3 (paleta),
// no entrelazado. Se implementa aqui para no meter una dependencia de imagen
// en el repositorio por una sola prueba.
function leerPNG(rel) {
    const b = fs.readFileSync(path.join(BASE, rel));
    let o = 8, ihdr = null, plte = null, trns = null;
    const idat = [];
    while (o < b.length) {
        const len = b.readUInt32BE(o);
        const tipo = b.toString('ascii', o + 4, o + 8);
        const dato = b.slice(o + 8, o + 8 + len);
        if (tipo === 'IHDR') {
            ihdr = {
                w: dato.readUInt32BE(0), h: dato.readUInt32BE(4),
                bits: dato[8], color: dato[9], entrelazado: dato[12]
            };
        } else if (tipo === 'PLTE') plte = dato;
        else if (tipo === 'tRNS') trns = dato;
        else if (tipo === 'IDAT') idat.push(dato);
        o += 12 + len;
    }
    if (!ihdr || ihdr.bits !== 8 || ihdr.color !== 3 || ihdr.entrelazado !== 0) {
        throw new Error(`${rel}: se esperaba PNG de paleta 8 bits sin entrelazar`);
    }

    // Desfiltrado de scanlines. Con 1 byte por pixel, bpp = 1.
    const crudo = zlib.inflateSync(Buffer.concat(idat));
    const { w, h } = ihdr;
    const px = Buffer.alloc(w * h);
    let s = 0;
    for (let y = 0; y < h; y++) {
        const filtro = crudo[s++];
        const linea = crudo.slice(s, s + w); s += w;
        const dest = px.slice(y * w, (y + 1) * w);
        const arriba = y > 0 ? px.slice((y - 1) * w, y * w) : null;
        for (let x = 0; x < w; x++) {
            const a = x > 0 ? dest[x - 1] : 0;
            const bb = arriba ? arriba[x] : 0;
            const c = (arriba && x > 0) ? arriba[x - 1] : 0;
            let v = linea[x];
            if (filtro === 1) v += a;
            else if (filtro === 2) v += bb;
            else if (filtro === 3) v += (a + bb) >> 1;
            else if (filtro === 4) {
                const p = a + bb - c;
                const pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
                v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c);
            } else if (filtro !== 0) throw new Error(`${rel}: filtro PNG ${filtro} no soportado`);
            dest[x] = v & 0xff;
        }
    }

    const paleta = [];
    for (let i = 0; i * 3 + 2 < (plte ? plte.length : 0); i++) {
        paleta.push([plte[i * 3], plte[i * 3 + 1], plte[i * 3 + 2]]);
    }
    return { w, h, px, paleta, transparentes: trns ? trns.length : 0 };
}

// ── 1. Manifest y PNG concuerdan ─────────────────────────────────────────────
console.log('Manifest y archivos publicados');

const clases = man.paleta.map(p => p.clase);
const rgbPaleta = new Set(man.paleta.map(p => p.rgb.join(',')));
const slugs = man.capas.map(c => c.slug);
const tiers = Object.keys(man.tiers);

H.chequear('el manifest declara la paleta con "sin" en el indice 0',
    man.paleta.length > 1 && man.paleta[0].clase === 'sin');
H.chequear(`las ${slugs.length} capas de CNT estan declaradas`,
    slugs.length === 6 && slugs.includes('gpon') && slugs.includes('lte'));
H.chequear('cada capa declara escala conocida',
    man.capas.every(c => Array.isArray(man.escalas[c.escala]) &&
                         man.escalas[c.escala].every(cl => clases.includes(cl))));
H.chequear('cada capa conserva el nombre real de la capa WMS de CNT',
    man.capas.every(c => /^CoberturaRed/.test(c.id)));

const faltan = man.piezas.filter(p => !fs.existsSync(path.join(BASE, p.archivo)));
H.chequear(`las ${man.piezas.length} piezas del manifest existen en disco`,
    faltan.length === 0, faltan.map(p => p.archivo).join(', '));

// Cada tier debe tener todas sus celdas para todas las capas: si falta una,
// el visor deja un hueco silencioso en el mapa.
for (const t of tiers) {
    const delTier = man.piezas.filter(p => p.archivo.split('/')[0] === t);
    const porCapa = slugs.map(s => delTier.filter(p => p.capa === s).length);
    H.chequear(`${t}: las 6 capas traen el mismo numero de celdas (${porCapa[0]})`,
        porCapa.every(n => n === porCapa[0] && n > 0), porCapa.join('/'));
}

// Tamano y paleta reales de cada PNG. Se revisa uno por capa y tier: leer los
// 60 completos son ~1 GB de pixeles desfiltrados y la prueba no lo necesita.
const muestra = [];
for (const t of tiers) {
    for (const s of slugs) {
        const p = man.piezas.find(q => q.capa === s && q.archivo.split('/')[0] === t);
        if (p) muestra.push(p);
    }
}
let dimsOk = true, paletaOk = true, transOk = true, tamanoRef = {};
for (const p of muestra) {
    const t = p.archivo.split('/')[0];
    const img = leerPNG(p.archivo);
    if (!tamanoRef[t]) tamanoRef[t] = [img.w, img.h];
    if (img.w !== tamanoRef[t][0] || img.h !== tamanoRef[t][1]) dimsOk = false;
    // La paleta escrita puede traer entradas de relleno a negro; lo que importa
    // es que ningun color USADO caiga fuera de la paleta del manifest.
    const usados = new Set(img.px);
    for (const i of usados) {
        if (i === 0) continue;                       // indice transparente
        if (i >= man.paleta.length) { paletaOk = false; continue; }
        if (!rgbPaleta.has(img.paleta[i].join(','))) paletaOk = false;
    }
    if (img.transparentes < 1) transOk = false;
}
H.chequear('todas las celdas de un tier tienen el mismo tamano en pixeles', dimsOk,
    JSON.stringify(tamanoRef));
H.chequear('ningun pixel usa un color ajeno a la paleta del manifest', paletaOk);
H.chequear('cada PNG declara su indice 0 como transparente (tRNS)', transOk);

// ── 2. La malla embaldosa el bbox del tier ───────────────────────────────────
console.log('\nMalla de cada tier');

const TOL = 1e-6;   // los bounds del manifest van redondeados a 6 decimales
for (const t of tiers) {
    const ext = man.tiers[t].bounds;                                  // [[s,w],[n,e]]
    const cel = man.piezas.filter(p => p.archivo.split('/')[0] === t && p.capa === slugs[0]);

    const sur = Math.min(...cel.map(p => p.bounds[0][0]));
    const oeste = Math.min(...cel.map(p => p.bounds[0][1]));
    const norte = Math.max(...cel.map(p => p.bounds[1][0]));
    const este = Math.max(...cel.map(p => p.bounds[1][1]));
    H.chequear(`${t}: la union de las celdas es el bbox declarado del tier`,
        Math.abs(sur - ext[0][0]) < TOL && Math.abs(oeste - ext[0][1]) < TOL &&
        Math.abs(norte - ext[1][0]) < TOL && Math.abs(este - ext[1][1]) < TOL,
        `union [${sur},${oeste},${norte},${este}] vs [${ext[0]},${ext[1]}]`);

    // Sin huecos ni solapes: la suma de areas de las celdas debe dar el area
    // del bbox. Si dos celdas se pisan, la suma sale de mas; si falta una
    // franja, de menos.
    const suma = cel.reduce((a, p) =>
        a + (p.bounds[1][0] - p.bounds[0][0]) * (p.bounds[1][1] - p.bounds[0][1]), 0);
    const areaExt = (ext[1][0] - ext[0][0]) * (ext[1][1] - ext[0][1]);
    H.chequear(`${t}: las ${cel.length} celdas cubren el bbox sin huecos ni solapes`,
        Math.abs(suma - areaExt) < 1e-9, `suma ${suma} vs bbox ${areaExt}`);

    // Todas las celdas del mismo tamano en grados: si una difiere de verdad,
    // la escala de metros por pixel deja de ser uniforme dentro del tier.
    // La comparacion va con tolerancia porque los bounds del manifest estan
    // redondeados a 6 decimales y el reparto no siempre cae exacto ahi: la
    // provincia mide 1,15 grados de alto en 3 filas, o sea 0,383333... por
    // fila. El desajuste llega a 2e-6 grados (unos 22 cm) frente a un pixel
    // de 12 m, y las celdas siguen tocandose en el mismo valor, asi que no
    // deja hueco. Lo que no se tolera es una celda de otro tamano.
    const rango = (f) => {
        const v = cel.map(f);
        return Math.max(...v) - Math.min(...v);
    };
    const desW = rango(p => p.bounds[1][1] - p.bounds[0][1]);
    const desH = rango(p => p.bounds[1][0] - p.bounds[0][0]);
    H.chequear(`${t}: todas las celdas miden lo mismo en grados (±${(2e-6).toExponential(0)})`,
        desW <= 2e-6 && desH <= 2e-6,
        `dispersion ancho ${desW.toExponential(2)}, alto ${desH.toExponential(2)}`);
}

H.chequear('el tier de Riobamba es mas fino que el provincial',
    man.resolucion_m_px.riobamba < man.resolucion_m_px.provincia,
    `${man.resolucion_m_px.riobamba} vs ${man.resolucion_m_px.provincia} m/px`);

// ── 3. Seleccion de pieza — codigo real de geovisor.html ─────────────────────
console.log('\nSeleccion de tier (piezaFinaTelecom de geovisor.html)');

// L minimo: solo latLngBounds con los metodos que usa el visor.
function latLngBounds(a, b) {
    const s = Math.min(a[0], b[0]), n = Math.max(a[0], b[0]);
    const w = Math.min(a[1], b[1]), e = Math.max(a[1], b[1]);
    return {
        getSouth: () => s, getNorth: () => n, getWest: () => w, getEast: () => e,
        getCenter: () => [(s + n) / 2, (w + e) / 2],
        contains(o) {
            if (Array.isArray(o)) return o[0] >= s && o[0] <= n && o[1] >= w && o[1] <= e;
            return o.getSouth() >= s && o.getNorth() <= n &&
                   o.getWest() >= w && o.getEast() <= e;
        },
        intersects: (o) => o.getSouth() <= n && o.getNorth() >= s &&
                           o.getWest() <= e && o.getEast() >= w
    };
}
const L = { latLngBounds };
const estado = { manifest: man, red: 'gpon', rgbAClase: null };
const T = H.cargarTelecom(L, estado);

// Un predio en pleno Riobamba y otro en Alausi, ambos con una huella de ~40 m.
const huella = (lat, lon) => latLngBounds([lat - 0.0002, lon - 0.0002], [lat + 0.0002, lon + 0.0002]);
const enRiobamba = T.piezaFinaTelecom('gpon', huella(-1.6710, -78.6480));
const enAlausi = T.piezaFinaTelecom('gpon', huella(-2.2010, -78.8450));
const fueraProvincia = T.piezaFinaTelecom('gpon', huella(-0.2200, -78.5100));   // Quito

H.chequear('dentro de Riobamba se elige el tier fino',
    enRiobamba && enRiobamba.archivo.startsWith('riobamba/'),
    enRiobamba && enRiobamba.archivo);
H.chequear('fuera del canton Riobamba se cae al tier provincial',
    enAlausi && enAlausi.archivo.startsWith('provincia/'),
    enAlausi && enAlausi.archivo);
H.chequear('fuera de Chimborazo no hay pieza (no es lo mismo que no haber cobertura)',
    fueraProvincia === null);

// ── textoCoberturaTelecom: la redaccion que acaba impresa en el DICAT ────────
console.log('\nRedaccion de la lectura (textoCoberturaTelecom)');

const casos = [
    [{ sinDato: true }, /^SIN DATO/, 'sin dato'],
    [{ clase: 'sin' }, /^SIN COBERTURA/, 'sin cobertura'],
    [{ clase: 'alto', etiqueta: 'ALTO', escala: 'senal', porcentaje: 100 }, /^Nivel ALTO en todo el predio$/, 'senal completa'],
    [{ clase: 'medio', etiqueta: 'MEDIO', escala: 'senal', porcentaje: 63 }, /^Nivel MEDIO, predominante en el 63 % del predio$/, 'senal parcial'],
    [{ clase: 'gpon', etiqueta: 'Cobertura fibra optica GPON', escala: 'gpon', porcentaje: 100 }, /^DISPONIBLE en todo el predio$/, 'binaria completa'],
    [{ clase: 'gpon', etiqueta: 'Cobertura fibra optica GPON', escala: 'gpon', porcentaje: 56 }, /^DISPONIBLE, sobre el 56 % del predio$/, 'binaria parcial'],
];
for (const [r, esperado, nombre] of casos) {
    const txt = T.textoCoberturaTelecom(r);
    H.chequear(`${nombre}: "${txt}"`, esperado.test(txt));
}

// El "sin dato" y el "sin cobertura" NUNCA pueden confundirse: uno dice que el
// predio esta fuera de lo descargado y el otro que CNT no da servicio ahi.
H.chequear('"sin dato" y "sin cobertura" se redactan distinto',
    T.textoCoberturaTelecom({ sinDato: true }) !==
    T.textoCoberturaTelecom({ clase: 'sin' }));

// ── 4. El raster dice lo que debe en coordenadas conocidas ───────────────────
console.log('\nLectura del raster en coordenadas conocidas');

// Misma aritmetica que muestrearTelecom(): lon/lat -> pixel dentro de la pieza.
const cache = {};
function claseEn(slug, tier, lat, lon) {
    const p = man.piezas.find(q => q.capa === slug &&
        q.archivo.split('/')[0] === tier &&
        lon >= q.bounds[0][1] && lon <= q.bounds[1][1] &&
        lat >= q.bounds[0][0] && lat <= q.bounds[1][0]);
    if (!p) return null;
    const img = cache[p.archivo] || (cache[p.archivo] = leerPNG(p.archivo));
    const [[sur, oeste], [norte, este]] = p.bounds;
    const x = Math.min(img.w - 1, Math.floor((lon - oeste) / (este - oeste) * img.w));
    const y = Math.min(img.h - 1, Math.floor((norte - lat) / (norte - sur) * img.h));
    return clases[img.px[y * img.w + x]];
}

// Verdades comprobadas contra el geoportal de CNT el 2026-09-10.
const puntos = [
    ['Centro de Riobamba', -1.6710, -78.6480, { gpon: 'gpon', lte: 'alto', '2g': 'alto' }],
    ['Aeropuerto', -1.6530, -78.6620, { gpon: 'gpon', lte: 'alto', '2g': 'alto' }],
    ['Lican', -1.6600, -78.7050, { gpon: 'sin', lte: 'medio' }],
    ['Paramo del Sangay', -1.7500, -78.4600, { gpon: 'sin', lte: 'sin', '2g': 'sin' }],
];
for (const [nombre, lat, lon, esperado] of puntos) {
    for (const [slug, clase] of Object.entries(esperado)) {
        const prov = claseEn(slug, 'provincia', lat, lon);
        H.chequear(`${nombre} · ${slug} = ${clase} (provincial)`, prov === clase,
            prov === null ? 'sin pieza' : `dice ${prov}`);
    }
}

// Alausi solo existe en el tier provincial: comprobar que ahi tambien hay dato
// evita publicar una provincia con un solo canton util.
H.chequear('Alausi tiene cobertura GPON en el tier provincial',
    claseEn('gpon', 'provincia', -2.2010, -78.8450) === 'gpon');

// Los dos tiers describen el mismo territorio: donde se solapan tienen que
// coincidir salvo en los bordes entre clases. Se mide sobre una rejilla.
let comparados = 0, iguales = 0;
for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 12; j++) {
        const lat = -1.94 + (0.47 * i) / 11;
        const lon = -78.90 + (0.50 * j) / 11;
        const a = claseEn('gpon', 'riobamba', lat, lon);
        const b = claseEn('gpon', 'provincia', lat, lon);
        if (a === null || b === null) continue;
        comparados++;
        if (a === b) iguales++;
    }
}
const acuerdo = comparados ? iguales / comparados : 0;
H.chequear(`los dos tiers coinciden donde se solapan (${iguales}/${comparados}, ${(acuerdo * 100).toFixed(0)} %)`,
    comparados > 50 && acuerdo >= 0.9,
    `solo ${(acuerdo * 100).toFixed(0)} % de acuerdo: revisar el bbox de los tiers`);

H.resumen('TELECOMUNICACIONES');
