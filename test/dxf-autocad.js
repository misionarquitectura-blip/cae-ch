// ─────────────────────────────────────────────────────────────────────────────
//  El DXF que descarga el visor tiene que abrirse en AutoCAD
//
//  AutoCAD no avisa de lo que falta: si el esqueleto del DXF esta incompleto
//  descarta el dibujo entero y el archivo parece corrupto. Aqui se comprueba
//  que el archivo es un R12 (AC1009) bien formado: pares codigo/valor,
//  secciones y tablas cerradas, cada capa declarada, cada POLYLINE con su
//  SEQEND, y las coordenadas intactas frente al UTM del predio.
//
//  Ejecutar:  node test/dxf-autocad.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const H = require('./lib/harness');
const patron = require('./fixtures/linderos-060101004001061001.json');

console.log('DXF PARA AUTOCAD — predio ' + patron.clave + '\n');

const api = H.cargarGeovisor({});
const { construirDXF } = H.cargarDXF();
const catastro = H.leerGeoJSON('DATA SET/Catastro GADMR.geojson');

const feat = H.buscarPredio(catastro, patron.clave);
if (!feat) { console.error('No se encontro el predio en el catastro.'); process.exit(1); }

const utm = H.anillo(feat).map(c => {
    const u = api.latLngToUTM(c[1], c[0], 17, true);
    return { easting: u.easting, northing: u.northing, x: u.easting, y: u.northing };
});

// Una franja de afectacion sintetica: rectangulo dentro del bbox del predio,
// con el vertice de cierre repetido a proposito (asi los devuelve el recorte).
const bx0 = Math.min(...utm.map(p => p.x)), bx1 = Math.max(...utm.map(p => p.x));
const by0 = Math.min(...utm.map(p => p.y)), by1 = Math.max(...utm.map(p => p.y));
const franja = [[bx0, by0], [bx0 + (bx1 - bx0) / 4, by0], [bx0 + (bx1 - bx0) / 4, by1], [bx0, by1], [bx0, by0]];

const dxf = construirDXF(utm, [{ area: 12.34, utm: franja }], patron.clave);

// ── Lectura del archivo como pares (codigo, valor) ───────────────────────────
const lineas = dxf.split('\r\n');
H.chequear('el archivo termina en salto de linea', lineas[lineas.length - 1] === '');
lineas.pop();
H.chequear('numero par de lineas (codigo + valor)', lineas.length % 2 === 0,
    `${lineas.length} lineas`);

const pares = [];
for (let i = 0; i < lineas.length; i += 2) pares.push([lineas[i].trim(), lineas[i + 1]]);

H.chequear('todos los codigos de grupo son enteros',
    pares.every(p => /^\d+$/.test(p[0])),
    (pares.find(p => !/^\d+$/.test(p[0])) || []).join(' / '));
H.chequear('ningun valor NaN, Infinity ni undefined',
    !pares.some(p => /NaN|Infinity|undefined|null/.test(p[1])),
    (pares.find(p => /NaN|Infinity|undefined|null/.test(p[1])) || []).join(' / '));
H.chequear('todo el contenido es ASCII (R12 no declara pagina de codigos)',
    !/[^\x09\x0a\x0d\x20-\x7e]/.test(dxf));

const deCero = pares.filter(p => p[0] === '0').map(p => p[1]);
const cuenta = n => deCero.filter(v => v === n).length;

// ── Cabecera y version ───────────────────────────────────────────────────────
const iVer = pares.findIndex(p => p[0] === '9' && p[1] === '$ACADVER');
H.chequear('declara $ACADVER = AC1009 (R12)', iVer >= 0 && pares[iVer + 1][1] === 'AC1009',
    iVer >= 0 ? pares[iVer + 1][1] : 'no declara $ACADVER');
H.chequear('el archivo empieza por 0/SECTION', pares[0][0] === '0' && pares[0][1] === 'SECTION');
H.chequear('el archivo termina en 0/EOF',
    pares[pares.length - 1][0] === '0' && pares[pares.length - 1][1] === 'EOF');
H.chequear('no usa LWPOLYLINE (no existe en R12)', cuenta('LWPOLYLINE') === 0);

// ── Secciones y tablas cerradas ──────────────────────────────────────────────
H.chequear('cada SECTION tiene su ENDSEC',
    cuenta('SECTION') === cuenta('ENDSEC'),
    `${cuenta('SECTION')} SECTION / ${cuenta('ENDSEC')} ENDSEC`);
H.chequear('cada TABLE tiene su ENDTAB',
    cuenta('TABLE') === cuenta('ENDTAB'),
    `${cuenta('TABLE')} TABLE / ${cuenta('ENDTAB')} ENDTAB`);

const secciones = [];
pares.forEach((p, i) => {
    if (p[0] === '0' && p[1] === 'SECTION' && pares[i + 1] && pares[i + 1][0] === '2') secciones.push(pares[i + 1][1]);
});
['HEADER', 'TABLES', 'BLOCKS', 'ENTITIES'].forEach(s =>
    H.chequear(`incluye la seccion ${s}`, secciones.includes(s), secciones.join(', ')));

const tablas = [];
pares.forEach((p, i) => {
    if (p[0] === '0' && p[1] === 'TABLE' && pares[i + 1] && pares[i + 1][0] === '2') tablas.push(pares[i + 1][1]);
});
['LTYPE', 'LAYER', 'STYLE'].forEach(t =>
    H.chequear(`incluye la tabla ${t}`, tablas.includes(t), tablas.join(', ')));

// ── Capas y estilo de texto declarados ───────────────────────────────────────
const declaradas = [], estilos = [];
pares.forEach((p, i) => {
    if (p[0] !== '0' || !pares[i + 1] || pares[i + 1][0] !== '2') return;
    if (p[1] === 'LAYER') declaradas.push(pares[i + 1][1]);
    if (p[1] === 'STYLE') estilos.push(pares[i + 1][1]);
});
H.chequear('la capa 0 esta declarada', declaradas.includes('0'), declaradas.join(', '));
H.chequear('el estilo STANDARD esta declarado', estilos.includes('STANDARD'), estilos.join(', '));
H.chequear('la tabla LTYPE declara CONTINUOUS',
    pares.some((p, i) => p[0] === '0' && p[1] === 'LTYPE' && pares[i + 1] && pares[i + 1][1] === 'CONTINUOUS'));

// Capas realmente usadas por las entidades (codigo 8)
const usadas = [...new Set(pares.filter(p => p[0] === '8').map(p => p[1]))];
usadas.forEach(c =>
    H.chequear(`la capa "${c}" que usan las entidades esta en la tabla LAYER`, declaradas.includes(c)));
['PREDIO', 'AFECTACION_VIAL', 'VERTICES', 'TEXTOS'].forEach(c =>
    H.chequear(`dibuja en la capa ${c}`, usadas.includes(c)));

// Cada LAYER declarado lleva color (62) y tipo de linea (6)
let capasCompletas = true;
pares.forEach((p, i) => {
    if (p[0] !== '0' || p[1] !== 'LAYER') return;
    const cod = pares.slice(i + 1, i + 6).filter(q => q[0] !== '0').map(q => q[0]);
    if (!cod.includes('2') || !cod.includes('70') || !cod.includes('62') || !cod.includes('6')) capasCompletas = false;
});
H.chequear('cada LAYER lleva nombre, banderas, color y tipo de linea', capasCompletas);

// ── Polilineas: 66 = 1, cierre 70 = 1 y SEQEND ───────────────────────────────
H.chequear('hay 2 POLYLINE (predio + franja de afectacion)', cuenta('POLYLINE') === 2,
    `${cuenta('POLYLINE')}`);
H.chequear('cada POLYLINE cierra con su SEQEND', cuenta('POLYLINE') === cuenta('SEQEND'),
    `${cuenta('POLYLINE')} POLYLINE / ${cuenta('SEQEND')} SEQEND`);

const polis = [];
pares.forEach((p, i) => {
    if (p[0] !== '0' || p[1] !== 'POLYLINE') return;
    const poli = { capa: null, sigue: null, cerrada: null, vertices: [], seqend: false };
    for (let k = i + 1; k < pares.length; k++) {
        const c = pares[k][0], v = pares[k][1];
        if (c === '0' && v === 'SEQEND') { poli.seqend = true; break; }
        if (c === '0' && v === 'VERTEX') { poli.vertices.push({}); continue; }
        if (poli.vertices.length) {
            const u = poli.vertices[poli.vertices.length - 1];
            if (c === '10') u.x = Number(v);
            if (c === '20') u.y = Number(v);
        } else {
            if (c === '8') poli.capa = v;
            if (c === '66') poli.sigue = v;
            if (c === '70') poli.cerrada = v;
        }
    }
    polis.push(poli);
});
polis.forEach((p, i) => {
    H.chequear(`POLYLINE ${i + 1} (${p.capa}) anuncia vertices con 66 = 1`, p.sigue === '1', String(p.sigue));
    H.chequear(`POLYLINE ${i + 1} (${p.capa}) es cerrada (70 = 1)`, p.cerrada === '1', String(p.cerrada));
    H.chequear(`POLYLINE ${i + 1} (${p.capa}) termina en SEQEND`, p.seqend);
    H.chequear(`POLYLINE ${i + 1} (${p.capa}) tiene 3 vertices o mas`, p.vertices.length >= 3,
        `${p.vertices.length}`);
    H.chequear(`POLYLINE ${i + 1} (${p.capa}) no repite el vertice de cierre`,
        p.vertices.length > 1 &&
        (Math.abs(p.vertices[0].x - p.vertices[p.vertices.length - 1].x) > 1e-6 ||
            Math.abs(p.vertices[0].y - p.vertices[p.vertices.length - 1].y) > 1e-6));
});

// ── Las coordenadas llegan intactas ──────────────────────────────────────────
const pred = polis.find(p => p.capa === 'PREDIO');
H.chequear(`la POLYLINE del predio tiene los ${utm.length} vertices del anillo`,
    pred && pred.vertices.length === utm.length,
    pred ? `${pred.vertices.length}` : 'no hay POLYLINE en PREDIO');
if (pred && pred.vertices.length === utm.length) {
    let peor = 0;
    utm.forEach((u, i) => {
        peor = Math.max(peor, Math.abs(u.x - pred.vertices[i].x), Math.abs(u.y - pred.vertices[i].y));
    });
    H.chequear(`las coordenadas UTM se escriben con error < 0,1 mm (peor ${peor.toFixed(5)} m)`,
        peor < 0.0001);
}
H.chequear('la franja de afectacion pierde el vertice de cierre repetido',
    polis.some(p => p.capa === 'AFECTACION_VIAL' && p.vertices.length === 4));

// ── Rotulos de vertice y clave ───────────────────────────────────────────────
H.chequear(`hay un POINT por vertice (${utm.length})`, cuenta('POINT') === utm.length,
    `${cuenta('POINT')}`);
H.chequear(`hay un TEXT por vertice mas la clave (${utm.length + 1})`,
    cuenta('TEXT') === utm.length + 1, `${cuenta('TEXT')}`);
const textos = [];
pares.forEach((p, i) => {
    if (p[0] !== '0' || p[1] !== 'TEXT') return;
    const t = { alto: null, txt: null, estilo: null };
    for (let k = i + 1; k < pares.length && pares[k][0] !== '0'; k++) {
        if (pares[k][0] === '40') t.alto = Number(pares[k][1]);
        if (pares[k][0] === '1') t.txt = pares[k][1];
        if (pares[k][0] === '7') t.estilo = pares[k][1];
    }
    textos.push(t);
});
H.chequear('cada TEXT lleva altura, contenido y estilo',
    textos.every(t => t.alto > 0 && t.txt && t.estilo === 'STANDARD'));
H.chequear('los rotulos van de V1 a V' + utm.length,
    textos[0].txt === 'V1' && textos[utm.length - 1].txt === 'V' + utm.length);
H.chequear('el DXF rotula la clave catastral',
    textos[textos.length - 1].txt === patron.clave, textos[textos.length - 1].txt);

// ── Predio degenerado: mejor un error claro que un archivo ilegible ──────────
let lanzo = false;
try { construirDXF([{ x: 1, y: 2 }, { x: 3, y: 4 }], null, 'x'); } catch (e) { lanzo = true; }
H.chequear('rechaza un predio de menos de 3 vertices', lanzo);

const conNaN = [{ x: NaN, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }, { x: 7, y: 8 }];
let salida = null;
try { salida = construirDXF(conNaN, null, 'x'); } catch (e) { salida = null; }
H.chequear('descarta los vertices invalidos en vez de escribir NaN',
    salida !== null && !/NaN/.test(salida));

H.resumen('DXF para AutoCAD');
