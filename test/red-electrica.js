// ─────────────────────────────────────────────────────────────────────────────
//  Red electrica EERSA (capa 3)
//
//  Verifica:
//    1. La capa que publica DATA SET/build_eersa.py: volumenes, rango, peso y
//       que no traiga mas atributos que los previstos. Lo ultimo es una guarda:
//       el servicio de la EERSA publica tambien abonados (SIGELEC) y la
//       auditoria de edicion, y nada de eso debe colarse en el repositorio.
//    2. analizarRedElectrica() de geovisor.html —el codigo REAL— frente a un
//       calculo independiente por fuerza bruta sobre predios del catastro:
//       mismo poste, misma red y mismo transformador, a la misma distancia.
//    3. La potencia disponible estimada y los textos del DICAT.
//
//  Ejecutar:  node test/red-electrica.js [paso]
//     paso = 1 de cada N predios para el contraste (por defecto 1500)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const PASO = parseInt(process.argv[2] || '1500', 10);
const RUTA = 'DATA SET/capas/eersa.geojson';
console.log('RED ELECTRICA — EERSA (capa 3)\n');

const capa = H.leerGeoJSON(RUTA);
const feats = capa.features;

// ═════════════════════════════════════════════════════════════════════════════
console.log('1. Capa publicada');
const por = t => feats.filter(f => f.properties.t === t);
const postes = por('p'), trafos = por('t'), bt = por('b'), mt = por('m');
H.chequear(`${postes.length} postes con red`, postes.length > 40000);
H.chequear(`${trafos.length} transformadores`, trafos.length > 5000);
H.chequear(`${bt.length} tramos de baja tension`, bt.length > 30000);
H.chequear(`${mt.length} tramos de media tension`, mt.length > 10000);
H.chequear('no hay elementos de otro tipo', postes.length + trafos.length + bt.length + mt.length === feats.length);

const PERMITIDOS = { p: ['t', 'c', 'u', 'm'], t: ['t', 'c', 'kva', 'f', 'car', 'vs', 'tr'], b: ['t', 's', 'f', 'v'], m: ['t', 's', 'f', 'kv'] };
const extra = feats.filter(f => Object.keys(f.properties).some(k => !PERMITIDOS[f.properties.t].includes(k)));
H.chequear('solo los atributos previstos (sin abonados ni auditoria)', extra.length === 0,
    extra.slice(0, 2).map(f => JSON.stringify(f.properties)).join(' | '));

H.chequear('todo poste trae codigo EERSA', postes.every(f => f.properties.c));
H.chequear('postes solo de los usos con red (1,2,3,4,7)', postes.every(f => [1, 2, 3, 4, 7].includes(f.properties.u)));
const sinKva = trafos.filter(f => !(f.properties.kva > 0)).length;
H.chequear(`transformadores con potencia nominal (${sinKva} sin dato)`, sinKva / trafos.length < 0.02);
H.chequear('fases de los tramos entre 1 y 3', bt.concat(mt).every(f => [1, 2, 3].includes(f.properties.f)));

let fuera = 0;
const w = c => { if (typeof c[0] === 'number') { if (!(c[0] > -79.0 && c[0] < -78.3 && c[1] > -2.05 && c[1] < -1.4)) fuera++; } else c.forEach(w); };
feats.forEach(f => w(f.geometry.coordinates));
H.chequear('toda coordenada cae en el canton Riobamba', fuera === 0, `${fuera} fuera`);

const mb = fs.statSync(path.join(H.RAIZ, RUTA)).size / 1048576;
H.chequear(`peso de la capa ${mb.toFixed(1)} MB (< 25 MB)`, mb < 25);

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n2. analizarRedElectrica() frente a fuerza bruta');

const turf = {
    bbox(f) {
        let b = [180, 90, -180, -90];
        const r = c => { if (typeof c[0] === 'number') { b = [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])]; } else c.forEach(r); };
        r(f.geometry.coordinates);
        return b;
    }
};
const api = H.cargarRedElectrica({ 3: H.stubCapa(RUTA) }, turf);
// Proyeccion independiente: la del arnes geometrico, no la de servicios
const G = H.cargarGeovisor({});
const utm = c => { const u = G.latLngToUTM(c[1], c[0], 17, true); return [u.easting, u.northing]; };

function dSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function pip(p, r) {
    let d = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++)
        if (((r[i][1] > p[1]) !== (r[j][1] > p[1])) && (p[0] < (r[j][0] - r[i][0]) * (p[1] - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0])) d = !d;
    return d;
}
function cruza(a, b, c, d) {
    const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
// Pre-proyeccion de toda la capa una sola vez
const P = postes.filter(f => f.properties.u === 2 || f.properties.u === 4).map(f => ({ c: f.properties.c, u: utm(f.geometry.coordinates) }));
const T = trafos.map(f => ({ c: f.properties.c, u: utm(f.geometry.coordinates) }));
const lineas = arr => arr.map(f => (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates).map(pt => pt.map(utm)));
const LB = lineas(bt), LM = lineas(mt);

function brutoPunto(lista, anillo) {
    let m = null;
    for (const e of lista) {
        if (Math.abs(e.u[0] - anillo[0][0]) > 900 || Math.abs(e.u[1] - anillo[0][1]) > 900) continue;
        let d = pip(e.u, anillo) ? 0 : Infinity;
        for (let j = 0; j < anillo.length - 1 && d > 0; j++) d = Math.min(d, dSeg(e.u, anillo[j], anillo[j + 1]));
        if (!m || d < m.d) m = { c: e.c, d };
    }
    return m;
}
function brutoLinea(lista, anillo) {
    let m = Infinity;
    for (const partes of lista) for (const L of partes) {
        if (Math.abs(L[0][0] - anillo[0][0]) > 1500 || Math.abs(L[0][1] - anillo[0][1]) > 1500) continue;
        if (L.some(p => pip(p, anillo))) { m = 0; continue; }
        for (let i = 0; i < L.length - 1; i++) for (let j = 0; j < anillo.length - 1; j++) {
            const d = cruza(L[i], L[i + 1], anillo[j], anillo[j + 1]) ? 0
                : Math.min(dSeg(L[i], anillo[j], anillo[j + 1]), dSeg(L[i + 1], anillo[j], anillo[j + 1]),
                           dSeg(anillo[j], L[i], L[i + 1]), dSeg(anillo[j + 1], L[i], L[i + 1]));
            if (d < m) m = d;
        }
    }
    return m;
}

const catastro = H.leerGeoJSON('DATA SET/capas/Catastro GADMR.geojson');
let n = 0, conPoste = 0, a100 = 0, dispo = 0;
const malos = [];
const t0 = Date.now();
for (let i = 0; i < catastro.features.length; i += PASO) {
    const f = catastro.features[i];
    if (!f.geometry || !f.geometry.coordinates.length) continue;
    const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
    if (!ring || ring.length < 4) continue;
    const r = api.analizarRedElectrica({ type: 'Feature', properties: {}, geometry: f.geometry });
    const anillo = ring.map(utm);
    const clave = (f.properties.claves || '').trim() || '#' + i;
    n++;
    const bp = brutoPunto(P, anillo);
    // Solo se contrasta dentro del radio de busqueda del visor (~600 m)
    if (bp && bp.d < 550) {
        if (!r.poste) malos.push(`${clave}: sin poste (bruto ${bp.c} a ${bp.d.toFixed(2)})`);
        else if (Math.abs(r.poste.distancia - bp.d) > 0.02) malos.push(`${clave}: poste ${r.poste.distancia} vs ${bp.d.toFixed(2)}`);
    }
    const bt0 = brutoLinea(LB, anillo);
    if (bt0 < 550 && (!r.redBT || Math.abs(r.redBT.distancia - bt0) > 0.02)) malos.push(`${clave}: BT ${r.redBT && r.redBT.distancia} vs ${bt0.toFixed(2)}`);
    const bTr = brutoPunto(T, anillo);
    if (bTr && bTr.d < 550 && (!r.trafo || Math.abs(r.trafo.distancia - bTr.d) > 0.02)) malos.push(`${clave}: trafo ${r.trafo && r.trafo.distancia} vs ${bTr.d.toFixed(2)}`);
    if (r.trafo && r.trafo.disponibleKVA != null && r.trafo.disponibleKVA > r.trafo.kva) malos.push(`${clave}: disponible > nominal`);
    if (r.poste) conPoste++;
    if ((r.redBT && r.redBT.distancia <= 100) || (r.poste && r.poste.distancia <= 100)) a100++;
    if (r.trafo && r.trafo.disponibleKVA > 0) dispo++;
}
const ms = (Date.now() - t0) / Math.max(n, 1);
console.log(`  predios evaluados: ${n} | con poste BT en 600 m: ${conPoste} | con red a <= 100 m: ${a100} | trafo con margen: ${dispo}`);
H.chequear('mismo poste, red BT y transformador que la fuerza bruta (±2 cm)', malos.length === 0, malos.slice(0, 4).join(' | '));
H.chequear('la mayoria de predios tiene red BT a 100 m o menos', a100 / n > 0.6, `${a100}/${n}`);

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n3. Potencia disponible y textos');
H.casiIgual('50 kVA al 40 % -> 30 kVA', api.eersaPotenciaDisponible(50, 40), 30, 1e-9, 'kVA');
H.chequear('sobrecargado (174 %) -> 0 kVA, nunca negativo', api.eersaPotenciaDisponible(50, 174.48) === 0);
H.chequear('sin cargabilidad -> sin dato', api.eersaPotenciaDisponible(50, null) === null);
H.chequear('texto de transformador saturado pide evaluar refuerzo',
    /refuerzo/.test(api.textoDisponible({ kva: 50, cargabilidad: 174.48, disponibleKVA: 0 })));
H.chequear('red que pasa por el predio se dice asi',
    /pasa por el predio/.test(api.textoRedElectrica({ tipo: 'Aerea', fases: 'trifasica', distancia: 0, voltaje: 220 })));

H.resumen('RED ELECTRICA');
