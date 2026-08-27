// Genera las capas de servicios básicos del GeoVisor a partir de los archivos
// crudos de EMAPAR (Riobamba EP), exportados desde CAD en EPSG:32717:
//
//   DATA SET/Cobertura Agua Potable.geojson   -> DATA SET/agua_potable.geojson
//   DATA SET/Alcantarillado Sanitario.geojson ─┐
//   DATA SET/Alcantarillado Fluvial.geojson    ├─> DATA SET/alcantarillado.geojson
//   DATA SET/Alcantarillado Combinado.geojson ─┘
//
// Dos transformaciones, además de la reproyección a WGS84:
//
//  1. Agua potable: el archivo trae 17 polilíneas abiertas y sin atributos. No
//     son tramos sueltos: encadenadas por sus extremos cierran los anillos de
//     las zonas de cobertura. Aquí se reconstruyen esos anillos y se emiten
//     como polígonos, que es lo que permite responder "¿el predio está dentro
//     de la cobertura?" en el DICAT. Las polilíneas que no cierran (divisorias
//     internas que arrancan en medio de otra línea) se conservan como líneas.
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
//  1. COBERTURA DE AGUA POTABLE — polilíneas -> anillos -> polígonos
// ═══════════════════════════════════════════════════════════════════════════

// Tolerancia de nodo: los extremos que coinciden lo hacen exactamente (0,0 m);
// 5 m absorbe el redondeo del export CAD sin unir líneas que no se tocan.
const TOL_NODO = 5;
// Un anillo al que le falta menos que esto se cierra con una recta. El caso
// real es un vano de 97 m donde dos zonas se apoyan en un tercer lindero.
const TOL_CIERRE = 150;

function encadenarAnillos(lineas) {
    const usada = new Array(lineas.length).fill(false);
    const cadenas = [];

    for (let i = 0; i < lineas.length; i++) {
        if (usada[i]) continue;
        usada[i] = true;
        let cadena = lineas[i].slice();
        let crecio = true;

        while (crecio) {
            crecio = false;
            for (let j = 0; j < lineas.length; j++) {
                if (usada[j]) continue;
                const s = lineas[j];
                const fin = cadena[cadena.length - 1];
                const ini = cadena[0];
                if (dist(fin, s[0]) <= TOL_NODO) {
                    cadena = cadena.concat(s.slice(1));
                } else if (dist(fin, s[s.length - 1]) <= TOL_NODO) {
                    cadena = cadena.concat(s.slice().reverse().slice(1));
                } else if (dist(ini, s[s.length - 1]) <= TOL_NODO) {
                    cadena = s.slice(0, -1).concat(cadena);
                } else if (dist(ini, s[0]) <= TOL_NODO) {
                    cadena = s.slice().reverse().slice(0, -1).concat(cadena);
                } else {
                    continue;
                }
                usada[j] = true;
                crecio = true;
                break;
            }
        }
        cadenas.push(cadena);
    }
    return cadenas;
}

// Área en el plano UTM (m²) por la fórmula del polígono (shoelace).
function areaUTM(anillo) {
    let s = 0;
    for (let k = 0; k < anillo.length - 1; k++) {
        s += anillo[k][0] * anillo[k + 1][1] - anillo[k + 1][0] * anillo[k][1];
    }
    return Math.abs(s / 2);
}

function longitudUTM(linea) {
    let s = 0;
    for (let k = 0; k < linea.length - 1; k++) s += dist(linea[k], linea[k + 1]);
    return s;
}

function construirAguaPotable() {
    const src = leer('Cobertura Agua Potable.geojson');
    const lineas = [];
    src.features.forEach(f => {
        const g = f.geometry;
        if (!g) return;
        if (g.type === 'LineString') lineas.push(g.coordinates);
        else if (g.type === 'MultiLineString') g.coordinates.forEach(ls => lineas.push(ls));
    });
    console.log(`Agua potable: ${lineas.length} polilíneas de origen`);

    const cadenas = encadenarAnillos(lineas);
    const features = [];
    let zonas = 0, sueltas = 0, areaTotal = 0;

    cadenas.forEach(cadena => {
        const vano = dist(cadena[0], cadena[cadena.length - 1]);

        if (vano > TOL_CIERRE) {
            // Divisoria interna: nace en medio de otra línea, no delimita zona.
            sueltas++;
            features.push({
                type: 'Feature',
                properties: {
                    tipo: 'divisoria',
                    zona: 'Lindero interno de cobertura',
                    longitud_m: Math.round(longitudUTM(cadena) * 100) / 100,
                    fuente: 'EMAPAR – Riobamba EP'
                },
                geometry: { type: 'LineString', coordinates: cadena.map(c => utm17sToWgs84(c[0], c[1])) }
            });
            return;
        }

        const anillo = cadena.slice();
        if (vano > 0) anillo.push(anillo[0]); // cerrar el vano residual
        const area = areaUTM(anillo);
        zonas++;
        areaTotal += area;
        features.push({
            type: 'Feature',
            properties: {
                tipo: 'cobertura',
                zona: `Zona de cobertura ${zonas}`,
                area_m2: Math.round(area * 100) / 100,
                area_ha: Math.round(area / 10000 * 100) / 100,
                perimetro_m: Math.round(longitudUTM(anillo) * 100) / 100,
                vano_cierre_m: Math.round(vano * 100) / 100,
                fuente: 'EMAPAR – Riobamba EP'
            },
            geometry: { type: 'Polygon', coordinates: [anillo.map(c => utm17sToWgs84(c[0], c[1]))] }
        });
    });

    // Las zonas grandes primero, para que las pequeñas queden dibujadas encima.
    features.sort((a, b) => (b.properties.area_m2 || 0) - (a.properties.area_m2 || 0));

    const mb = escribir('agua_potable.geojson', {
        type: 'FeatureCollection',
        name: 'Cobertura Agua Potable',
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
        features
    });
    console.log(`  ${zonas} zonas de cobertura (${(areaTotal / 10000).toFixed(1)} ha) + ${sueltas} divisoria(s)`);
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
