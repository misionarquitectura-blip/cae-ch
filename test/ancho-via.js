// ─────────────────────────────────────────────────────────────────────────────
//  Ancho de via por frente del predio (seccion 4C del DICAT).
//
//  El ancho se mide entre la linea de fabrica del frente y la de la acera de
//  enfrente, en UTM. Antes salia de un transecto que tomaba la direccion de la
//  LF de su primer a su ultimo vertice: en las manzanas digitalizadas como
//  contorno cerrado esos vertices coinciden, no habia direccion y el DICAT
//  decia "No disponible" en plena zona urbana.
//
//  Caso de referencia: 060103002005067008, frente Sur a una calle de 16,26 m
//  entre LF.
//
//  Ejecutar:  node test/ancho-via.js [paso]
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const H = require('./lib/harness');

const PASO = parseInt(process.argv[2] || '150', 10);
console.log('ANCHO DE VIA POR FRENTE\n');

const capas = H.stubLineasFabrica();
capas[6] = H.stubCapa('DATA SET/capas/Catastro GADMR.geojson');
const api = H.cargarGeovisor(capas);
const catastro = H.leerGeoJSON('DATA SET/capas/Catastro GADMR.geojson');
const feat = f => ({ type: 'Feature', properties: f.properties, geometry: f.geometry });
const anchos = clave => api.calcularAnchosVia(feat(H.buscarPredio(catastro, clave)));
const de = (r, dir) => r.find(f => f.dir === dir) || {};

// ── Caso reportado: manzanas digitalizadas como contorno cerrado ────────────
const r = anchos('060103002005067008');
H.chequear('un solo frente, al Sur', r.length === 1 && r[0].dir === 'Sur', JSON.stringify(r.map(f => f.dir)));
H.chequear('medido entre lineas de fabrica', r[0].fuente === 'lf', r[0].fuente);
H.casiIgual('ancho de la calle', r[0].ancho, 16.26, 0.05, 'm');

// ── Predio de estacion total: tres calles de 12 m ───────────────────────────
const t = anchos('060104007003003002');
for (const dir of ['Norte', 'Sur', 'Este']) {
    H.casiIgual(`frente ${dir} entre LF`, de(t, dir).ancho, 12, 0.05, 'm');
}

// ── Sin LF en la acera de enfrente: hasta los lotes de la otra acera ────────
const c = anchos('060101004001007014');
H.chequear('frente Oeste medido hasta los lotes de enfrente', de(c, 'Oeste').fuente === 'catastro', JSON.stringify(de(c, 'Oeste')));
H.casiIgual('ancho referencial', de(c, 'Oeste').ancho, 15.2, 0.5, 'm');

// ── Rayos que se escapan: plaza, esquina, manzana sin LF ────────────────────
// Antes: 57,06 m cruzando una plaza, 56,05 m en diagonal por un cruce y
// 56,03 m atravesando una manzana sin linea de fabrica.
H.chequear('plaza: frente sin ancho medible', de(anchos('060101004003014012'), 'Oeste').ancho == null);
H.casiIgual('esquina: la calle, no la diagonal del cruce', de(anchos('060104003002047002'), 'Este').ancho, 17.85, 0.05, 'm');
H.chequear('no atraviesa la manzana sin LF', de(anchos('060101004014005009'), 'Norte').ancho == null);

// ── Barrido: cobertura e invariantes ────────────────────────────────────────
let n = 0, conFrente = 0, conAncho = 0, errores = 0;
const malos = [];
for (let i = 0; i < catastro.features.length; i += PASO) {
    const f = catastro.features[i];
    if (!f.geometry) continue;
    const fe = feat(f), P = api.afRingUTM(fe);
    if (!P || P.length < 3 || !api.afHayLF(fe, P)) continue;
    n++;
    let a;
    try { a = api.calcularAnchosVia(fe); } catch (e) { errores++; malos.push(`${f.properties.claves} ${e.message}`); continue; }
    if (a.length) conFrente++;
    if (a.some(x => x.ancho != null)) conAncho++;
    for (const x of a) {
        if (x.ancho != null && !(x.ancho >= 3 && x.ancho <= 40)) malos.push(`${f.properties.claves} ${x.dir} ${x.ancho}`);
    }
}
console.log(`Predios en zona con LF: ${n} | con frente a via: ${conFrente} | con ancho: ${conAncho}\n`);
H.chequear('sin excepciones', errores === 0, malos.slice(0, 3).join(' | '));
H.chequear('anchos entre 3 y 40 m', malos.length === 0, malos.slice(0, 5).join(' | '));
H.chequear('al menos 90 % de los predios con LF tienen ancho', conAncho >= 0.9 * n, `${conAncho}/${n}`);

H.resumen('ANCHO DE VIA');
