// ─────────────────────────────────────────────────────────────────────────────
//  Afectacion vial fuera de la zona con lineas de fabrica.
//
//  Donde no hay LF, el DICAT lee la capa de Vialidad: las lineas paralelas al
//  eje forman un corredor y la afectacion es la parte del predio entre sus
//  bordes externos. Si solo existe el eje, la afectacion se declara con ancho
//  desconocido.
//
//  Caso de referencia: 060161006003006013 (rural, 15 007,93 m2) atravesado por
//  el "TRAMO FALTANTE PARROQUIAL N26": eje + calzada a ±6 m + borde externo a
//  ±8 m → corredor de 16 m. Contraste Monte Carlo (3 M puntos): 3 869,9 m2.
//
//  Ejecutar:  node test/afectacion-rural.js [paso]
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const H = require('./lib/harness');

const PASO = parseInt(process.argv[2] || '120', 10);
console.log('AFECTACION VIAL EN ZONA SIN LINEAS DE FABRICA\n');

const capas = H.stubLineasFabrica();
capas[7] = H.stubVialidad();
const api = H.cargarGeovisor(capas);
const catastro = H.leerGeoJSON('DATA SET/Catastro GADMR.geojson');
const feat = f => ({ type: 'Feature', properties: f.properties, geometry: f.geometry });

// ── Caso de referencia rural ────────────────────────────────────────────────
const rural = api.calcularAfectacionPredio(feat(H.buscarPredio(catastro, '060161006003006013')));
H.chequear('predio rural resuelto por la capa de Vialidad', rural.metodo === 'vialidad', rural.metodo);
H.chequear('un solo corredor, sin ejes de ancho desconocido',
    rural.corredores.length === 1 && rural.ejesSinAncho.length === 0, JSON.stringify(rural.corredores));
H.casiIgual('ancho entre bordes externos', rural.corredores[0].ancho, 16, 0.05, 'm');
H.casiIgual('area afectada vs Monte Carlo', rural.total, 3869.9, 3869.9 * 0.005, 'm2');
H.casiIgual('area util + afectada = predio', rural.total + rural.edificable, 15007.93, 0.05, 'm2');

// ── El caso urbano de referencia sigue por linea de fabrica ─────────────────
const urbano = api.calcularAfectacionPredio(feat(H.buscarPredio(catastro, '060104007003003002')));
H.chequear('predio urbano resuelto por linea de fabrica', urbano.metodo === 'lf', urbano.metodo);
H.chequear('la vialidad no suma nada en zona con LF', urbano.totalVialidad === 0, String(urbano.totalVialidad));
H.casiIgual('afectacion urbana sin cambios', urbano.total, 1426.27, 0.01, 'm2');

// ── Barrido: invariantes en toda la muestra ─────────────────────────────────
let n = 0, conCorredor = 0, sinAncho = 0, errores = 0;
const malos = [];
for (let i = 0; i < catastro.features.length; i += PASO) {
    const f = catastro.features[i];
    if (!f.geometry || f.geometry.type !== 'Polygon') continue;
    let r;
    try { r = api.calcularAfectacionPredio(feat(f)); } catch (e) { errores++; malos.push(`${f.properties.claves} ${e.message}`); continue; }
    if (!r) continue;
    n++;
    const clave = f.properties.claves;
    const area = api.afShoelace(api.afRingUTM(feat(f)));
    if (r.corredores.length) conCorredor++;
    if (r.ejesSinAncho.length) sinAncho++;
    if (r.metodo === 'lf' && (r.totalVialidad > 0 || r.ejesSinAncho.length)) malos.push(`${clave} mezcla LF y vialidad`);
    if (r.total > area + 0.05) malos.push(`${clave} afectacion ${r.total} > predio ${area.toFixed(2)}`);
    if (Math.abs(r.total + r.edificable - area) > 0.1) malos.push(`${clave} descuadre ${r.total}+${r.edificable}`);
    r.corredores.forEach(c => { if (!(c.ancho > 0 && c.ancho <= 40)) malos.push(`${clave} ancho ${c.ancho}`); });
}
console.log(`Predios evaluados: ${n} | con corredor: ${conCorredor} | ancho desconocido: ${sinAncho}\n`);
H.chequear('sin excepciones', errores === 0, malos.slice(0, 3).join(' | '));
H.chequear('invariantes de area, ancho y metodo', malos.length === 0, malos.slice(0, 5).join(' | '));

H.resumen('AFECTACION RURAL');
