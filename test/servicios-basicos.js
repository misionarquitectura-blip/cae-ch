// ─────────────────────────────────────────────────────────────────────────────
//  Servicios basicos — cobertura de agua potable (capa 4) y alcantarillado (11)
//
//  Verifica tres cosas distintas:
//    1. Las capas construidas por DATA SET/build_servicios_basicos.js son sanas
//       (anillos cerrados, atributos completos, sin coordenadas fuera de rango).
//    2. La reproyeccion EPSG:32717 -> WGS84 conserva las longitudes: se vuelve
//       a medir cada tramo desde el archivo publicado y se contrasta con la
//       longitud que se calculo en UTM antes de convertir.
//    3. analizarServiciosBasicos() de geovisor.html — el codigo REAL, extraido
//       del HTML — responde lo mismo que un calculo independiente por fuerza
//       bruta sobre predios reales del catastro.
//
//  Ejecutar:  node test/servicios-basicos.js [paso]
//     paso = 1 de cada N predios para el contraste (por defecto 4000)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const H = require('./lib/harness');

const PASO = parseInt(process.argv[2] || '4000', 10);
console.log('SERVICIOS BASICOS — agua potable y alcantarillado\n');

const agua = H.leerGeoJSON('DATA SET/agua_potable.geojson');
const alc  = H.leerGeoJSON('DATA SET/alcantarillado.geojson');

// ── turf minimo: solo lo que usa analizarServiciosBasicos ────────────────────
// Se implementa aqui para no arrastrar la dependencia al repositorio; son las
// mismas definiciones de turf para poligonos simples.
const anillos = (g) => g.type === 'Polygon' ? g.coordinates
                     : g.type === 'MultiPolygon' ? g.coordinates.flat() : [];

function bboxDe(f) {
    let b = [180, 90, -180, -90];
    const w = c => { if (typeof c[0] === 'number') {
        b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]);
        b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
    } else c.forEach(w); };
    w(f.geometry.coordinates);
    return b;
}

function pip(p, anillo) {
    let dentro = false;
    for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
        const xi = anillo[i][0], yi = anillo[i][1], xj = anillo[j][0], yj = anillo[j][1];
        if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) dentro = !dentro;
    }
    return dentro;
}

function corte(p1, p2, q1, q2) {
    const o = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    return o(p1, p2, q1) !== o(p1, p2, q2) && o(q1, q2, p1) !== o(q1, q2, p2);
}

const turf = {
    bbox: bboxDe,
    centroid(f) {
        // turf.centroid = media de los vertices del poligono
        let sx = 0, sy = 0, n = 0;
        anillos(f.geometry).forEach(r => r.forEach(c => { sx += c[0]; sy += c[1]; n++; }));
        return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [sx / n, sy / n] } };
    },
    booleanPointInPolygon(pt, poly) {
        const c = pt.geometry ? pt.geometry.coordinates : pt;
        const rs = anillos(poly.geometry);
        return rs.length > 0 && pip(c, rs[0]);
    },
    booleanIntersects(a, b) {
        const ra = anillos(a.geometry), rb = anillos(b.geometry);
        if (!ra.length || !rb.length) return false;
        if (ra[0].some(c => pip(c, rb[0]))) return true;
        if (rb[0].some(c => pip(c, ra[0]))) return true;
        for (let i = 0; i < ra[0].length - 1; i++) {
            for (let j = 0; j < rb[0].length - 1; j++) {
                if (corte(ra[0][i], ra[0][i + 1], rb[0][j], rb[0][j + 1])) return true;
            }
        }
        return false;
    }
};

const capas = { 4: H.stubCapa('DATA SET/agua_potable.geojson'), 11: H.stubCapa('DATA SET/alcantarillado.geojson') };
const api = H.cargarServicios(capas, turf);

// ═════════════════════════════════════════════════════════════════════════════
//  1. Sanidad de las capas publicadas
// ═════════════════════════════════════════════════════════════════════════════
console.log('1. Capas publicadas');

// La capa trae dos niveles: el contorno de cada red de distribucion y el
// mosaico de sus subredes. El analisis del DICAT solo consulta las subredes,
// que son la particion fina y las que llevan el caudal.
const redes = agua.features.filter(f => f.properties.tipo === 'red');
const zonas = agua.features.filter(f => f.properties.tipo === 'subred');
H.chequear(`cobertura de agua: ${redes.length} redes de distribucion`, redes.length === 9, `${redes.length}`);
H.chequear(`cobertura de agua: ${zonas.length} subredes poligonales`, zonas.length >= 150, `${zonas.length}`);
H.chequear('la capa no trae features de otro tipo',
    redes.length + zonas.length === agua.features.length,
    `${agua.features.length - redes.length - zonas.length} sobrantes`);

const abiertos = zonas.concat(redes).filter(f => {
    const r = f.geometry.coordinates[0];
    return r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1];
});
H.chequear('todos los anillos de cobertura estan cerrados', abiertos.length === 0, `${abiertos.length} abiertos`);

// Atributos que el DICAT imprime: si falta uno, el informe sale con un hueco.
const sinAtributo = zonas.filter(f => {
    const p = f.properties;
    return !p.red || !p.subred || !p.zona || !(p.area_ha > 0) || !(p.caudal_l_s > 0);
});
H.chequear('toda subred trae red, codigo, superficie y caudal de diseno',
    sinAtributo.length === 0,
    sinAtributo.slice(0, 3).map(f => f.properties.zona).join(', '));

// Cada subred tiene que pertenecer a una de las nueve redes publicadas: si el
// saneo de nombres del build fallara, aqui aparecerian dos grafias del mismo
// sector y el DICAT citaria una red que no esta en el mapa.
const nombresRed = new Set(redes.map(f => f.properties.red));
const huerfanas = zonas.filter(f => !nombresRed.has(f.properties.red));
H.chequear(`las ${zonas.length} subredes pertenecen a alguna de las ${nombresRed.size} redes`,
    huerfanas.length === 0,
    [...new Set(huerfanas.map(f => f.properties.red))].join(', '));

const codigos = zonas.map(f => `${f.properties.red}/${f.properties.subred}`);
H.chequear('no hay dos subredes con el mismo codigo dentro de una red',
    new Set(codigos).size === codigos.length);

const caudalTotal = zonas.reduce((s, f) => s + f.properties.caudal_l_s, 0);
H.chequear(`caudal de diseno total ${caudalTotal.toFixed(1)} l/s (entre 400 y 1 500)`,
    caudalTotal > 400 && caudalTotal < 1500);

const fueraRango = agua.features.concat(alc.features).filter(f => {
    const b = bboxDe(f);
    return !(b[0] > -79.2 && b[2] < -78.2 && b[1] > -2.2 && b[3] < -1.2) || b.some(v => !isFinite(v));
});
H.chequear('todas las geometrias caen en el area de Riobamba', fueraRango.length === 0, `${fueraRango.length} fuera`);

const areaTotalHa = zonas.reduce((s, f) => s + (f.properties.area_ha || 0), 0);
H.chequear(`superficie total de cobertura ${areaTotalHa.toFixed(1)} ha (entre 3 000 y 8 000)`,
    areaTotalHa > 3000 && areaTotalHa < 8000);

// El mosaico de subredes y el contorno de las redes describen el mismo
// territorio: se dibujaron por separado, asi que no coinciden al metro, pero
// una diferencia grande significaria que una de las dos capas llego mal.
const areaRedesHa = redes.reduce((s, f) => s + (f.properties.area_ha || 0), 0);
const desvioAreas = Math.abs(areaTotalHa - areaRedesHa) / areaRedesHa * 100;
H.chequear(`subredes y redes cubren lo mismo: ${areaTotalHa.toFixed(0)} vs ${areaRedesHa.toFixed(0)} ha (${desvioAreas.toFixed(1)} % de diferencia)`,
    desvioAreas < 3);

// Las subredes son una particion del area servida: un predio pertenece a una
// sola. Pero comparten lindero, y dos linderos digitalizados por separado en
// CAD no caen en la misma coordenada al milimetro: quedan astillas de unos
// pocos metros cuadrados a lo largo del borde. Por eso no se pregunta "¿hay
// algun punto comun?" —siempre lo hay— sino CUANTA superficie se repite.
//
// El area se mide por barrido horizontal: para cada linea y=Y se calculan los
// tramos interiores de cada anillo y se suma la longitud comun. Es exacta en x
// y solo discretiza en y, asi que un solape de metros no se le escapa, y es
// dos ordenes de magnitud mas rapida que muestrear el interior en malla.
const DY_SOLAPE = 0.25;                       // paso del barrido, en metros
const TOL_ASTILLA_M2 = 500;                   // un lote pequeño: por encima ya es un solape de verdad
const TOL_SOLAPE_PCT = 0.01;                  // del area total servida

function tramosEn(anilloUTM, Y) {
    const xs = [];
    for (let i = 0, j = anilloUTM.length - 1; i < anilloUTM.length; j = i++) {
        const [xi, yi] = anilloUTM[i], [xj, yj] = anilloUTM[j];
        if ((yi > Y) !== (yj > Y)) xs.push((xj - xi) * (Y - yi) / (yj - yi) + xi);
    }
    xs.sort((a, b) => a - b);
    const t = [];
    for (let k = 0; k + 1 < xs.length; k += 2) t.push([xs[k], xs[k + 1]]);
    return t;
}

const anillosUTM = zonas.map(f => f.geometry.coordinates[0].map(c => api.servUTM(c)));
const cajasUTM = anillosUTM.map(a => a.reduce(
    (b, c) => [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])],
    [Infinity, Infinity, -Infinity, -Infinity]));

let solapeTotal = 0, peorPar = 0;
const paresSolapados = [];
for (let i = 0; i < zonas.length; i++) {
    for (let j = i + 1; j < zonas.length; j++) {
        const y0 = Math.max(cajasUTM[i][1], cajasUTM[j][1]);
        const y1 = Math.min(cajasUTM[i][3], cajasUTM[j][3]);
        if (Math.max(cajasUTM[i][0], cajasUTM[j][0]) >= Math.min(cajasUTM[i][2], cajasUTM[j][2]) || y0 >= y1) continue;
        let area = 0;
        for (let y = y0 + DY_SOLAPE / 2; y < y1; y += DY_SOLAPE) {
            const ti = tramosEn(anillosUTM[i], y), tj = tramosEn(anillosUTM[j], y);
            for (const p of ti) for (const q of tj) area += Math.max(0, Math.min(p[1], q[1]) - Math.max(p[0], q[0])) * DY_SOLAPE;
        }
        if (area <= 0.5) continue;
        solapeTotal += area;
        if (area > peorPar) peorPar = area;
        if (area > TOL_ASTILLA_M2) {
            paresSolapados.push(`${zonas[i].properties.zona} ∩ ${zonas[j].properties.zona}: ${area.toFixed(0)} m²`);
        }
    }
}
const solapePct = solapeTotal / (areaTotalHa * 10000) * 100;
H.chequear(`ningun par de subredes se solapa mas de ${TOL_ASTILLA_M2} m² (peor: ${peorPar.toFixed(0)} m²)`,
    paresSolapados.length === 0, paresSolapados.join(' | '));
H.chequear(`el solape acumulado es despreciable: ${solapeTotal.toFixed(0)} m² (${solapePct.toFixed(4)} % del area servida)`,
    solapePct < TOL_SOLAPE_PCT);

const TIPOS = ['Sanitario', 'Pluvial', 'Combinado'];
const malTipo = alc.features.filter(f => TIPOS.indexOf(f.properties.tipo) < 0);
H.chequear(`alcantarillado: ${alc.features.length} tramos, todos con red valida`, malTipo.length === 0, `${malTipo.length} sin tipo`);

const sinDiametro = alc.features.filter(f => f.properties.diametro_mm === null && f.properties.seccion === 'Tubería');
H.chequear('toda tuberia tiene diametro extraido del nombre CAD', sinDiametro.length === 0, `${sinDiametro.length} sin diametro`);

const porTipo = {};
alc.features.forEach(f => { porTipo[f.properties.tipo] = (porTipo[f.properties.tipo] || 0) + f.properties.longitud_m; });
TIPOS.forEach(t => console.log(`    ${t.padEnd(10)} ${(porTipo[t] / 1000).toFixed(2)} km`));

// ═════════════════════════════════════════════════════════════════════════════
//  2. La reproyeccion conserva las longitudes
//     Se remide cada tramo volviendo de WGS84 al plano UTM y se compara con la
//     longitud calculada sobre las coordenadas UTM originales.
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n2. Reproyeccion EPSG:32717 -> WGS84');

// Las coordenadas se publican con 6 decimales (~11 cm), asi que cada extremo
// puede correrse hasta media unidad en cada eje: el error maximo teorico de un
// tramo es de unos 17 cm. Fuera de ese margen habria un fallo de conversion.
const TOL_TRAMO = 0.20;

let peor = 0, peorTramo = null, desviados = 0, sumaPub = 0, sumaRemedida = 0;
alc.features.forEach(f => {
    const partes = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    let l = 0;
    partes.forEach(ls => {
        const utm = ls.map(c => api.servUTM(c));
        for (let i = 0; i < utm.length - 1; i++) l += Math.hypot(utm[i + 1][0] - utm[i][0], utm[i + 1][1] - utm[i][1]);
    });
    const d = Math.abs(l - f.properties.longitud_m);
    sumaPub += f.properties.longitud_m;
    sumaRemedida += l;
    if (d > peor) { peor = d; peorTramo = f.properties; }
    if (d > TOL_TRAMO) desviados++;
});
const errRed = Math.abs(sumaRemedida - sumaPub) / sumaPub * 100;
H.chequear(`ningun tramo se desvia mas de ${TOL_TRAMO} m (peor: ${peor.toFixed(4)} m)`, desviados === 0,
    `${desviados} tramos, peor el ${peorTramo ? peorTramo.id + ' ' + peorTramo.tipo : '?'}`);
H.chequear(`longitud total de la red estable: ${(sumaPub / 1000).toFixed(2)} km, desvio ${errRed.toFixed(4)} %`,
    errRed < 0.01);

// ═════════════════════════════════════════════════════════════════════════════
//  3. analizarServiciosBasicos() contra un calculo independiente
// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n3. Analisis sobre predios reales (1 de cada ${PASO})`);

const catastro = H.leerGeoJSON('DATA SET/Catastro GADMR.geojson');

// Distancia minima real: sin prefiltro por bbox, recorriendo TODOS los tramos.
// Si el prefiltro de la funcion de produccion perdiera el tramo mas cercano,
// esta comparacion lo delata.
function distanciaMinimaFuerzaBruta(anilloUTM) {
    let min = Infinity;
    for (const f of alc.features) {
        const partes = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const parte of partes) {
            const utm = parte.map(c => api.servUTM(c));
            for (let i = 0; i < utm.length - 1; i++) {
                for (let j = 0; j < anilloUTM.length - 1; j++) {
                    const d = api.servDistSegmentos(utm[i], utm[i + 1], anilloUTM[j], anilloUTM[j + 1]);
                    if (d < min) min = d;
                }
            }
        }
    }
    return min;
}

let n = 0, dentroAgua = 0, conRed = 0, atraviesan = 0, discrepancias = 0;
const detalle = [];

for (let i = 0; i < catastro.features.length && n < 12; i += PASO) {
    const f = catastro.features[i];
    if (!f.geometry || f.geometry.type !== 'Polygon') continue;
    const ring = H.anillo(f);
    if (ring.length < 3) continue;
    n++;

    const predio = { type: 'Feature', properties: f.properties, geometry: f.geometry };
    const r = api.analizarServiciosBasicos(predio);

    if (r.agua.estado === 'DENTRO') dentroAgua++;
    if (r.alcantarillado.tramo) conRed++;
    if (r.alcantarillado.atraviesa) atraviesan++;

    // Contraste independiente del veredicto de agua potable: el centroide
    // (media de vertices, igual que turf) contra las zonas publicadas.
    const c = turf.centroid(predio).geometry.coordinates;
    const zonaReal = zonas.find(z => pip(c, z.geometry.coordinates[0]));
    const esperado = zonaReal ? 'DENTRO' : (r.agua.estado === 'PARCIAL' ? 'PARCIAL' : 'FUERA');
    if (r.agua.estado !== esperado) {
        discrepancias++;
        detalle.push(`agua: ${f.properties.claves} dijo ${r.agua.estado}, esperado ${esperado}`);
    }
    // Y que cite la subred correcta, no solo el veredicto: el DICAT imprime el
    // nombre de la red y el caudal, y equivocarlos es peor que no decirlos.
    if (zonaReal && (r.agua.subred !== zonaReal.properties.subred ||
                     r.agua.red !== zonaReal.properties.red ||
                     r.agua.caudal !== zonaReal.properties.caudal_l_s)) {
        discrepancias++;
        detalle.push(`agua: ${f.properties.claves} cito ${r.agua.red}/${r.agua.subred}, real ` +
            `${zonaReal.properties.red}/${zonaReal.properties.subred}`);
    }

    // Contraste del tramo mas cercano contra la busqueda exhaustiva.
    const anilloUTM = ring.concat([ring[0]]).map(c2 => api.servUTM(c2));
    const dReal = distanciaMinimaFuerzaBruta(anilloUTM);
    const dFn = r.alcantarillado.tramo ? r.alcantarillado.tramo.distancia : Infinity;
    // El prefiltro de produccion solo mira ~600 m alrededor: fuera de ese radio
    // es correcto que no devuelva nada.
    if (dReal < 500) {
        if (Math.abs(dFn - dReal) > 0.02 && !(dFn === 0 && dReal < 1)) {
            discrepancias++;
            detalle.push(`alcantarillado: ${f.properties.claves} dijo ${dFn} m, real ${dReal.toFixed(2)} m`);
        }
    }

    const t = r.alcantarillado.tramo;
    const ap = r.agua.red ? `${r.agua.red}/${r.agua.subred} ${r.agua.caudal} l/s` : '—';
    console.log(`    ${String(f.properties.claves || '').padEnd(28)} agua=${r.agua.estado.padEnd(7)} ${ap.padEnd(34)}` +
        ` alc=${t ? (t.tipo + ' ' + (t.diametro_mm || t.seccion) + ' @ ' + t.distancia + ' m') : 'sin red cercana'}`);
}

H.chequear(`analizados ${n} predios sin discrepancias con el calculo independiente`, discrepancias === 0,
    detalle.join(' | '));
H.chequear('al menos un predio de la muestra cae dentro de la cobertura de agua', dentroAgua > 0);
H.chequear('al menos un predio de la muestra tiene red de alcantarillado cercana', conRed > 0);
console.log(`    (${dentroAgua}/${n} dentro de cobertura, ${conRed}/${n} con red cercana, ${atraviesan} atravesados por la red)`);

// Predio sintetico montado sobre un tramo real: la red debe salir como que
// atraviesa el predio y a 0 m. Es la rama que un muestreo del catastro rara vez
// toca (la red va por la via) y es justo la que dispara la alerta del informe.
{
    const tramo = alc.features.find(f => f.geometry.type === 'LineString' && f.properties.longitud_m > 60);
    const [a, b] = [tramo.geometry.coordinates[0], tramo.geometry.coordinates[1]];
    const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
    const d = 0.00012; // ~13 m de semilado
    const cuadro = {
        type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [[
            [cx - d, cy - d], [cx + d, cy - d], [cx + d, cy + d], [cx - d, cy + d], [cx - d, cy - d]
        ]] }
    };
    const r = api.analizarServiciosBasicos(cuadro);
    H.chequear('un predio montado sobre la red se marca como atravesado',
        r.alcantarillado.atraviesa === true && r.alcantarillado.tramo.distancia === 0,
        JSON.stringify(r.alcantarillado.tramo));
}

// ═════════════════════════════════════════════════════════════════════════════
//  4. Unidades de la geometria de distancias
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n4. Geometria de distancias');

H.casiIgual('segmentos paralelos separados 5 m',
    api.servDistSegmentos([0, 0], [10, 0], [0, 5], [10, 5]), 5, 1e-9, 'm');
H.chequear('segmentos que se cruzan dan 0 m',
    api.servDistSegmentos([0, 0], [10, 10], [0, 10], [10, 0]) === 0);
H.casiIgual('segmentos alineados con hueco de 3 m',
    api.servDistSegmentos([0, 0], [10, 0], [13, 0], [20, 0]), 3, 1e-9, 'm');
H.casiIgual('punto a segmento, proyeccion fuera del tramo',
    api.servDistPuntoSegmento([15, 0], [0, 0], [10, 0]), 5, 1e-9, 'm');
H.chequear('punto dentro de un cuadrado',
    api.servPuntoEnAnillo([5, 5], [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]) === true);
H.chequear('punto fuera de un cuadrado',
    api.servPuntoEnAnillo([15, 5], [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]) === false);

H.resumen('SERVICIOS BASICOS');
