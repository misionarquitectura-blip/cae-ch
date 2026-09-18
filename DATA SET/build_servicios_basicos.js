// Genera las capas de servicios básicos del GeoVisor a partir de los archivos
// crudos de EMAPAR / EP Riobamba, exportados en EPSG:32717:
//
//   DATA SET/AGUA POTABLE EP RIOBAMBA/REDES_GENERAL.shp            ─┐
//   DATA SET/AGUA POTABLE EP RIOBAMBA/REDES_DE_DISTRIBUCION_*.shp  ─┴> agua_potable.geojson
//   DATA SET/Alcantarillado Sanitario.geojson ─┐
//   DATA SET/Alcantarillado Fluvial.geojson    ├─> DATA SET/alcantarillado.geojson
//   DATA SET/Alcantarillado Combinado.geojson ─┘
//
// Dos transformaciones, además de la reproyección a WGS84:
//
//  1. Agua potable: la entrega de septiembre de 2026 llega ya como polígonos
//     con atributos —9 redes de distribución y sus 158 subredes— y sustituye a
//     la reconstrucción por encadenado de polilíneas que hubo que hacer con la
//     entrega anterior. Aquí se unen las dos coberturas en una sola capa y se
//     vuelve a medir cada polígono en el plano UTM, porque el campo AREA del
//     shapefile viene desactualizado en dos subredes (P-08 y Y-03).
//
//  2. Alcantarillado: las tres redes se unifican en una sola capa. El diámetro
//     vive en el nombre de capa CAD ("z san tuberia 200mm"), así que se extrae
//     a atributos reales: tipo, seccion y diametro_mm.

const fs = require('fs');
const path = require('path');

// ── Conversión UTM Zona 17S (EPSG:32717) → WGS84 (idéntica a preprocess.js) ──
const A  = 6378137.0;
const F  = 1 / 298.257223563;
const B  = A * (1 - F);
const E2 = 1 - (B * B) / (A * A);
const E1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
const K0 = 0.9996;
const LON0 = ((17 - 1) * 6 - 180 + 3) * Math.PI / 180; // meridiano central zona 17

// 6 decimales ≈ 11 cm — suficiente para redes de servicio
function utm17sToWgs84(easting, northing) {
    const N = northing - 10000000; // hemisferio sur
    const E_ = easting - 500000;
    const M  = N / K0;
    const mu = M / (A * (1 - E2/4 - 3*E2*E2/64 - 5*E2*E2*E2/256));
    const p1 = mu
        + (3*E1/2 - 27*E1*E1*E1/32) * Math.sin(2*mu)
        + (21*E1*E1/16 - 55*E1*E1*E1*E1/32) * Math.sin(4*mu)
        + (151*E1*E1*E1/96) * Math.sin(6*mu)
        + (1097*E1*E1*E1*E1/512) * Math.sin(8*mu);
    const sp1 = Math.sin(p1), cp1 = Math.cos(p1), tp1 = Math.tan(p1);
    const N1 = A / Math.sqrt(1 - E2*sp1*sp1);
    const T1 = tp1 * tp1;
    const C1 = E2 * cp1*cp1 / (1 - E2);
    const R1 = A * (1 - E2) / Math.pow(1 - E2*sp1*sp1, 1.5);
    const D  = E_ / (N1 * K0);
    const lat = p1 - (N1*tp1/R1) * (
        D*D/2
        - (5 + 3*T1 + 10*C1 - 4*C1*C1 - 9*E2) * D*D*D*D/24
        + (61 + 90*T1 + 298*C1 + 45*T1*T1 - 252*E2 - 3*C1*C1) * D*D*D*D*D*D/720
    );
    const lon = LON0 + (
        D
        - (1 + 2*T1 + C1) * D*D*D/6
        + (5 - 2*C1 + 28*T1 - 3*C1*C1 + 8*E2 + 24*T1*T1) * D*D*D*D*D/120
    ) / cp1;
    return [
        parseFloat((lon * 180/Math.PI).toFixed(6)),
        parseFloat((lat * 180/Math.PI).toFixed(6))
    ];
}

const BASE = __dirname;
const leer = (n) => JSON.parse(fs.readFileSync(path.join(BASE, n), 'utf8'));
const escribir = (n, fc) => {
    const p = path.join(BASE, n);
    fs.writeFileSync(p, JSON.stringify(fc));
    return (fs.statSync(p).size / 1024 / 1024).toFixed(2);
};

// Todas las mediciones se hacen en el plano UTM 17S (metros), nunca en grados.
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ═══════════════════════════════════════════════════════════════════════════
//  0. LECTOR DE SHAPEFILE (SHP + DBF)
// ═══════════════════════════════════════════════════════════════════════════
// EP Riobamba entrega en shapefile, no en GeoJSON. Se lee aquí en lugar de
// añadir una dependencia al repositorio: son dos archivos de polígonos simples
// y la parte del formato que hace falta cabe en sesenta líneas.

function leerDBF(buf) {
    const nRegistros = buf.readUInt32LE(4);
    const largoCabecera = buf.readUInt16LE(8);
    const largoRegistro = buf.readUInt16LE(10);

    const campos = [];
    for (let p = 32; buf[p] !== 0x0d && p < largoCabecera; p += 32) {
        campos.push({
            nombre: buf.toString('latin1', p, p + 11).replace(/\0.*$/, '').trim(),
            tipo: String.fromCharCode(buf[p + 11]),
            largo: buf[p + 16]
        });
    }

    const filas = [];
    for (let i = 0; i < nRegistros; i++) {
        let off = largoCabecera + i * largoRegistro;
        if (buf[off] === 0x2a) { filas.push(null); continue; }   // registro borrado
        off += 1;
        const fila = {};
        for (const c of campos) {
            // El .cpg de ambos archivos declara UTF-8, que es donde vienen las
            // tildes de "Yaruquíes" y "San Martín".
            const crudo = buf.toString('utf8', off, off + c.largo).replace(/\0/g, '').trim();
            off += c.largo;
            fila[c.nombre] = (c.tipo === 'N' || c.tipo === 'F')
                ? (crudo === '' ? null : Number(crudo))
                : crudo;
        }
        filas.push(fila);
    }
    return filas;
}

// Solo los tipos que traen estos archivos: Polygon (5) y sus variantes Z/M.
function leerSHP(buf) {
    const formas = [];
    let p = 100;                                   // cabecera fija de 100 bytes
    while (p < buf.length) {
        const largo = buf.readInt32BE(p + 4) * 2;  // en palabras de 16 bits
        const tipo = buf.readInt32LE(p + 8);
        const d = p + 12;
        if (tipo === 0) {
            formas.push(null);                     // forma nula
        } else if (tipo % 10 === 5) {
            const nPartes = buf.readInt32LE(d + 32);
            const nPuntos = buf.readInt32LE(d + 36);
            const inicios = [];
            for (let i = 0; i < nPartes; i++) inicios.push(buf.readInt32LE(d + 40 + i * 4));
            const base = d + 40 + nPartes * 4;
            const puntos = [];
            for (let i = 0; i < nPuntos; i++) {
                puntos.push([buf.readDoubleLE(base + i * 16), buf.readDoubleLE(base + i * 16 + 8)]);
            }
            const anillos = [];
            for (let i = 0; i < nPartes; i++) {
                anillos.push(puntos.slice(inicios[i], i + 1 < nPartes ? inicios[i + 1] : nPuntos));
            }
            formas.push(anillos);
        } else {
            throw new Error(`shapefile: tipo de geometria ${tipo} no soportado`);
        }
        p += 8 + largo;
    }
    return formas;
}

function leerShapefile(rel) {
    const base = path.join(BASE, rel);
    const formas = leerSHP(fs.readFileSync(base + '.shp'));
    const filas = leerDBF(fs.readFileSync(base + '.dbf'));
    if (formas.length !== filas.length) {
        throw new Error(`${rel}: ${formas.length} geometrias y ${filas.length} registros`);
    }
    return formas.map((anillos, i) => ({ anillos, props: filas[i] }));
}

// ═══════════════════════════════════════════════════════════════════════════
//  1. COBERTURA DE AGUA POTABLE — redes de distribución y subredes
// ═══════════════════════════════════════════════════════════════════════════

const AP_DIR = 'AGUA POTABLE EP RIOBAMBA';
const AP_GENERAL = path.join(AP_DIR, 'REDES_GENERAL');
const AP_SUBREDES = path.join(AP_DIR, 'REDES_DE_DISTRIBUCION_MARZO_2025');
const AP_FUENTE = 'EP Riobamba (ex EMAPAR)';
const AP_ACTUALIZACION = 'marzo 2025';

// Los dos archivos nombran las mismas nueve redes de formas distintas: el
// general va en mayúsculas y sin tildes ("YARUQUIES", "SAN MARTIN DE
// VERANILLO") y el de subredes con tilde y abreviado ("Red Yaruquíes", "Red
// San Martín"). Esta tabla es la única versión buena del nombre; si apareciera
// una red que no está aquí el script para, en vez de publicar una capa con dos
// grafías del mismo sector.
const REDES_AP = [
    { clave: 'TRATAMIENTO',             nombre: 'Tratamiento' },
    { clave: 'TAPI',                    nombre: 'Tapi' },
    { clave: 'EL RECREO',               nombre: 'El Recreo' },
    { clave: 'EL CARMEN',               nombre: 'El Carmen' },
    { clave: 'SABOYA',                  nombre: 'Saboya' },
    { clave: 'MALDONADO',               nombre: 'Maldonado' },
    { clave: 'PISCIN',                  nombre: 'Piscín' },
    { clave: 'SAN MARTIN DE VERANILLO', nombre: 'San Martín de Veranillo', alias: ['SAN MARTIN'] },
    { clave: 'YARUQUIES',               nombre: 'Yaruquíes' }
];

// "Red San Martín" -> "SAN MARTIN": mayúsculas, sin tildes y sin el prefijo.
function normalizarRed(s) {
    return String(s || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toUpperCase().trim()
        .replace(/^RED\s+/, '')
        .replace(/\s+/g, ' ');
}

const indiceRedes = {};
REDES_AP.forEach(r => {
    indiceRedes[r.clave] = r;
    (r.alias || []).forEach(a => { indiceRedes[a] = r; });
});

function redDe(valor, origen) {
    const r = indiceRedes[normalizarRed(valor)];
    if (!r) throw new Error(`${origen}: red de agua potable desconocida "${valor}"`);
    return r;
}

function areaConSigno(anillo) {
    let s = 0;
    for (let k = 0; k < anillo.length - 1; k++) {
        s += anillo[k][0] * anillo[k + 1][1] - anillo[k + 1][0] * anillo[k][1];
    }
    return s / 2;
}

// Área en el plano UTM (m²) por la fórmula del polígono (shoelace).
function areaUTM(anillo) {
    return Math.abs(areaConSigno(anillo));
}

function longitudUTM(linea) {
    let s = 0;
    for (let k = 0; k < linea.length - 1; k++) s += dist(linea[k], linea[k + 1]);
    return s;
}

// Los anillos de un shapefile vienen orientados: el exterior en sentido horario
// (shoelace negativo) y los huecos al revés. Ninguno de los dos archivos trae
// huecos hoy, pero respetar la orientación cuesta una línea y evita publicar un
// hueco como si fuera una isla si una entrega futura los trae.
function anillosAPoligono(anillos) {
    const poligonos = [];
    anillos.forEach(a => {
        const cerrado = a.slice();
        const ini = cerrado[0], fin = cerrado[cerrado.length - 1];
        if (ini[0] !== fin[0] || ini[1] !== fin[1]) cerrado.push(ini);
        if (areaConSigno(cerrado) < 0 || !poligonos.length) poligonos.push([cerrado]);
        else poligonos[poligonos.length - 1].push(cerrado);
    });
    return poligonos;
}

// Medidas de un polígono completo: el área neta descuenta los huecos y el
// perímetro suma solo los contornos exteriores.
function medirPoligono(poligonos) {
    let area = 0, perimetro = 0;
    poligonos.forEach(anillos => {
        anillos.forEach((a, j) => { area += j === 0 ? areaUTM(a) : -areaUTM(a); });
        perimetro += longitudUTM(anillos[0]);
    });
    return { area, perimetro };
}

function geometriaWgs84(poligonos) {
    const conv = poligonos.map(anillos => anillos.map(a => a.map(c => utm17sToWgs84(c[0], c[1]))));
    return conv.length === 1
        ? { type: 'Polygon', coordinates: conv[0] }
        : { type: 'MultiPolygon', coordinates: conv };
}

const r2 = v => Math.round(v * 100) / 100;

function construirAguaPotable() {
    const generales = leerShapefile(AP_GENERAL);
    const subredes = leerShapefile(AP_SUBREDES);
    console.log(`Agua potable: ${generales.length} redes generales, ${subredes.length} subredes`);

    // ── Subredes: son la partición fina del área servida ─────────────────
    // Llevan el caudal de diseño y el sector operativo, que es lo que el DICAT
    // necesita citar. Se ordenan por red y por código para que la capa salga
    // estable entre ejecuciones.
    const porRed = {};
    const featuresSub = [];
    let caudalTotal = 0;

    subredes
        .map(f => ({ f, red: redDe(f.props.RED, 'subredes') }))
        .sort((a, b) => a.red.nombre.localeCompare(b.red.nombre, 'es') ||
                        String(a.f.props.SUB_RED).localeCompare(String(b.f.props.SUB_RED), 'es'))
        .forEach(({ f, red }) => {
            const poligonos = anillosAPoligono(f.anillos);
            const { area, perimetro } = medirPoligono(poligonos);
            const caudal = f.props.CAUDAL_LT_ || 0;
            const codigo = String(f.props.SUB_RED || '').trim() || 'S/C';
            caudalTotal += caudal;

            porRed[red.clave] = porRed[red.clave] || { n: 0, area: 0, caudal: 0 };
            porRed[red.clave].n++;
            porRed[red.clave].area += area;
            porRed[red.clave].caudal += caudal;

            featuresSub.push({
                type: 'Feature',
                properties: {
                    tipo: 'subred',
                    red: red.nombre,
                    subred: codigo,
                    // `zona` es la etiqueta que el visor y el DICAT imprimen
                    // como nombre del área de cobertura.
                    zona: `Red ${red.nombre} · subred ${codigo}`,
                    sector: String(f.props.SECTOR || '').trim() || null,
                    // Código interno de EP Riobamba. NO es el código de parroquia
                    // de la clave catastral: contrastado contra el catastro, su 2
                    // cae en Veloz y su 4 en Maldonado, al revés que el municipal.
                    // Se publica el código crudo y no se traduce a un nombre.
                    parroquia_ep: String(f.props.PARROQUIA || '').trim() || null,
                    caudal_l_s: caudal ? r2(caudal) : null,
                    area_m2: r2(area),
                    area_ha: r2(area / 10000),
                    perimetro_m: r2(perimetro),
                    fuente: AP_FUENTE,
                    actualizacion: AP_ACTUALIZACION
                },
                geometry: geometriaWgs84(poligonos)
            });
        });

    // ── Redes generales: el contorno de las nueve redes ──────────────────
    const featuresRed = [];
    let areaTotal = 0;

    generales
        .map(f => ({ f, red: redDe(f.props.RED, 'redes generales') }))
        .sort((a, b) => a.red.nombre.localeCompare(b.red.nombre, 'es'))
        .forEach(({ f, red }) => {
            const poligonos = anillosAPoligono(f.anillos);
            const { area, perimetro } = medirPoligono(poligonos);
            areaTotal += area;
            const s = porRed[red.clave] || { n: 0, caudal: 0, area: 0 };

            featuresRed.push({
                type: 'Feature',
                properties: {
                    tipo: 'red',
                    red: red.nombre,
                    zona: `Red ${red.nombre}`,
                    subredes: s.n,
                    caudal_l_s: s.caudal ? r2(s.caudal) : null,
                    area_m2: r2(area),
                    area_ha: r2(area / 10000),
                    perimetro_m: r2(perimetro),
                    fuente: AP_FUENTE,
                    actualizacion: AP_ACTUALIZACION
                },
                geometry: geometriaWgs84(poligonos)
            });
        });

    const sinSubredes = featuresRed.filter(f => !f.properties.subredes);
    if (sinSubredes.length) {
        throw new Error('redes sin ninguna subred: ' + sinSubredes.map(f => f.properties.red).join(', '));
    }

    // Las redes van primero para que Leaflet dibuje las subredes encima: el
    // contorno de la red es el marco y la subred el relleno.
    const mb = escribir('agua_potable.geojson', {
        type: 'FeatureCollection',
        name: 'Cobertura Agua Potable',
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
        features: featuresRed.concat(featuresSub)
    });

    featuresRed.forEach(f => {
        const p = f.properties;
        const s = porRed[REDES_AP.find(r => r.nombre === p.red).clave];
        // La suma de las subredes no tiene por qué dar el área de la red: el
        // contorno general y el mosaico de subredes se dibujaron por separado.
        const desvio = Math.abs(s.area - p.area_m2) / p.area_m2;
        console.log(`  ${p.red.padEnd(24)} ${String(p.subredes).padStart(3)} subredes ` +
            `${p.area_ha.toFixed(2).padStart(9)} ha ${String(p.caudal_l_s).padStart(7)} l/s` +
            (desvio > 0.02 ? `   (suma de subredes: ${(s.area / 10000).toFixed(2)} ha)` : ''));
    });
    console.log(`  ${'TOTAL'.padEnd(24)} ${String(featuresSub.length).padStart(3)} subredes ` +
        `${(areaTotal / 10000).toFixed(2).padStart(9)} ha ${caudalTotal.toFixed(2).padStart(7)} l/s`);
    console.log(`  -> agua_potable.geojson (${mb} MB)\n`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  2. ALCANTARILLADO — sanitario + pluvial + combinado en una sola capa
// ═══════════════════════════════════════════════════════════════════════════

const REDES = [
    { archivo: 'Alcantarillado Sanitario.geojson', tipo: 'Sanitario' },
    { archivo: 'Alcantarillado Fluvial.geojson',   tipo: 'Pluvial'   },
    { archivo: 'Alcantarillado Combinado.geojson', tipo: 'Combinado' }
];

// "z san tuberia 200mm" -> { seccion: 'Tubería', diametro_mm: 200 }
// "z pluvial cajon"     -> { seccion: 'Cajón',   diametro_mm: null }
function interpretarCapaCAD(nombre) {
    const n = String(nombre || '').toLowerCase();
    let seccion = 'Otro';
    if (n.includes('tuberia')) seccion = 'Tubería';
    else if (n.includes('cajon')) seccion = 'Cajón';
    else if (n.includes('pozo')) seccion = 'Pozo';
    const m = n.match(/(\d+)\s*mm/); // "400 mm" aparece con espacio en la red pluvial
    return { seccion, diametro_mm: m ? parseInt(m[1], 10) : null };
}

function construirAlcantarillado() {
    const features = [];
    const resumen = {};

    REDES.forEach(({ archivo, tipo }) => {
        const src = leer(archivo);
        let longitud = 0;
        src.features.forEach(f => {
            const g = f.geometry;
            if (!g) return;
            const partes = g.type === 'LineString' ? [g.coordinates]
                         : g.type === 'MultiLineString' ? g.coordinates
                         : [];
            if (!partes.length) return;

            const p = f.properties || {};
            const { seccion, diametro_mm } = interpretarCapaCAD(p.Layer);
            const largo = partes.reduce((s, ls) => s + longitudUTM(ls), 0);
            longitud += largo;

            const coords = partes.map(ls => ls.map(c => utm17sToWgs84(c[0], c[1])));
            features.push({
                type: 'Feature',
                properties: {
                    tipo,
                    seccion,
                    diametro_mm,
                    longitud_m: Math.round(largo * 100) / 100,
                    id: p.OBJECTID !== undefined ? p.OBJECTID : null,
                    fuente: 'EMAPAR – Riobamba EP'
                },
                geometry: coords.length === 1
                    ? { type: 'LineString', coordinates: coords[0] }
                    : { type: 'MultiLineString', coordinates: coords }
            });
        });
        resumen[tipo] = { tramos: src.features.length, km: longitud / 1000 };
    });

    const mb = escribir('alcantarillado.geojson', {
        type: 'FeatureCollection',
        name: 'Alcantarillado',
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
        features
    });

    console.log('Alcantarillado:');
    let tot = 0, km = 0;
    for (const t in resumen) {
        console.log(`  ${t.padEnd(10)} ${String(resumen[t].tramos).padStart(5)} tramos  ${resumen[t].km.toFixed(2)} km`);
        tot += resumen[t].tramos;
        km += resumen[t].km;
    }
    console.log(`  ${'TOTAL'.padEnd(10)} ${String(tot).padStart(5)} tramos  ${km.toFixed(2)} km`);
    console.log(`  -> alcantarillado.geojson (${mb} MB)`);
}

construirAguaPotable();
construirAlcantarillado();
