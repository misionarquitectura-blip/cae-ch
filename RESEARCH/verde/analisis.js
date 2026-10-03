// Linea 2, rama 2.3: areas verdes. Dotacion, distancia por calle, compacidad
// referida al verde y sitios en suelo municipal para parques nuevos.
//
//   node --max-old-space-size=8192 analisis.js && node build.js
//
// Reutiliza la base de la rama 2.1 (poblacion por predio, rejilla, red de
// calles, sectores): RESEARCH/proximidad/analisis.js cargado como modulo.
const fs = require('fs'), path = require('path');
const AQUI = __dirname;
process.chdir(path.join(AQUI, '../proximidad'));
const B = require('../proximidad/analisis.js');
process.chdir(AQUI);
const { G, POB, puntos, nodos, cercano, dijkstra, sectorDe, celdas, CELDA, gx0, gy0, CENTRO, RADIO_CENTRO, dentro, kCelda } = B;
const LEE = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const RAIZ = '../../';
const suma = (L, f) => L.reduce((a, x) => a + f(x), 0);

// --------------------------------------------------------------- Supuestos
// Codigo Urbano de Riobamba (Ord. 016-2023, art. 178, tabla 3): ED1, parques
// infantiles y barriales, radio 400 m, 0,30 m2/hab, lote minimo 300 m2.
const ED1 = { radio: 400, lote: 300, m2hab: 0.30 };
// Proximidad simultanea a espacios verdes (Rueda, BCN Ecologia): cuatro escalas
// de pieza verde, cada una con su distancia. Rueda mide en linea recta; aqui se
// mide por calle, que es mas exigente.
const RUEDA = [
  { id: 'r1', min: 1000,   dist: 200,  nom: 'Más de 1 000 m² a 200 m' },
  { id: 'r2', min: 5000,   dist: 750,  nom: 'Más de 5 000 m² a 750 m' },
  { id: 'r3', min: 10000,  dist: 2000, nom: 'Más de 1 ha a 2 km' },
  { id: 'r4', min: 100000, dist: 4000, nom: 'Más de 10 ha a 4 km' }
];
const OMS = 9;                 // m2/hab, minimo de referencia de la OMS
const R_EFECTIVO = 750;        // m: verde al alcance a pie (unos 10 minutos)
const PASO = 5;                // m: rasterizado de las piezas verdes
const LOTE_MIN_PARQUE = 1000;  // m2: por debajo, el lote da un jardin de bolsillo, no un parque barrial
const LOTE_MIN_ZONAL = 5000;   // m2: escala r2 de Rueda
const MAX_BARRIAL = 12, MAX_ZONAL = 5, GANANCIA_MIN = 500;

// ------------------------------------------------------ Piezas verdes
// Fuentes: poligonos de OSM (parque, jardin, juegos infantiles, cesped, area
// verde comunal) y predios municipales cuyo nombre u observacion los declara
// area verde. Se rasterizan a 5 m dentro del limite urbano: lo que se toca se
// une en una sola pieza (un juego infantil dentro de un parque no cuenta dos
// veces, ni un parque partido en varios poligonos cuenta como varios).
const areas = LEE('fuentes/verde.json').elements;   // osm_verde.js
const privado = t => /^(private|no|customers)$/.test(t.access || '') || /privad/i.test(t.operator || '')
  || /sin edificaci|privad|patio|sembr[ií]o/i.test(t.name || '');
function esVerde(t) {
  if (privado(t)) return false;
  if (/^(park|playground)$/.test(t.leisure || '')) return true;
  // En OSM Riobamba hay muchos jardines de casa y patios dibujados como garden:
  // solo cuentan los declarados de uso publico o comunitario.
  if (t.leisure === 'garden') return /^(yes|public|permissive)$/.test(t.access || '') && !/^(private|residential|lote)$/.test(t['garden:type'] || '')
    || /^(public|community)$/.test(t['garden:type'] || '');
  if (/^(grass|village_green)$/.test(t.landuse || '')) return true;
  // recreation_ground es casi siempre cancha; solo cuenta si se llama parque.
  return t.leisure === 'recreation_ground' && /parque/i.test(t.name || '');
}
const fuentes = []; // { ring:[[x,y]], nombre, origen }
for (const e of areas) {
  const t = e.tags || {};
  if (!esVerde(t)) continue;
  const rings = e.type === 'way' ? [e.geometry] : (e.members || []).filter(m => m.role === 'outer' && m.geometry).map(m => m.geometry);
  for (const g of rings) if (g && g.length > 3) fuentes.push({ ring: g.map(p => G.wgs2utm(p.lon, p.lat)), nombre: t.name || '', tipo: t.leisure || t.landuse, origen: 'osm' });
}
const PM = LEE(RAIZ + 'DATA SET/fuentes/GADMR catastro 2026-10-01/Predios_Municipales.geojson').features;
const RE_VERDE = /AREAS? VERDES?|ÁREAS? VERDES?|AREA COMUNAL|PARQUE(?! INDUSTRIAL)|JARD[IÍ]N|AREA RECREA|AREA DE RECREACION/i;
const muniVerde = [];
for (const f of PM) {
  const p = f.properties;
  const txt = [p.nombre, p.observacio, p.observac_1].join(' | ');
  const dir = (p.gis_pred_8 || '').replace(/entre:.*$/, '').trim();
  if (!RE_VERDE.test(txt) && !/^AREAS? VERDES?\b/i.test(dir)) continue;
  if ((+p.sup_cons_c || 0) > 0) continue;
  const polys = G.toUTM(f.geometry); const c = G.polysCentroid(polys); if (!c || !dentro(c)) continue;
  const clave = (p.claves || '').trim();
  muniVerde.push(clave);
  for (const poly of polys) fuentes.push({ ring: poly[0], nombre: (p.nombre || '').trim() || dir, tipo: 'municipal', origen: 'muni', clave });
}
console.log('fuentes verdes:', fuentes.filter(f => f.origen === 'osm').length, 'poligonos OSM,', muniVerde.length, 'predios municipales rotulados');

const raster = new Map(); // 'i:j' -> { f: indice de fuente }
fuentes.forEach((fu, k) => {
  let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12;
  for (const [x, y] of fu.ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  fu.area = Math.abs(G.ringArea(fu.ring));
  for (let i = Math.floor(x0 / PASO); i * PASO < x1; i++) for (let j = Math.floor(y0 / PASO); j * PASO < y1; j++) {
    const x = (i + .5) * PASO, y = (j + .5) * PASO, key = i + ':' + j;
    if (!G.pointInRing([x, y], fu.ring)) continue;
    const prev = raster.get(key);
    if (prev) { prev.osm = prev.osm || fu.origen === 'osm'; if (fuentes[prev.f].area < fu.area) prev.f = k; continue; }   // el nombre lo pone el poligono mayor
    raster.set(key, { f: k, pieza: -1, dentro: dentro([x, y]), osm: fu.origen === 'osm' });
  }
});

// Espacio deportivo publico (canchas, pistas, complejos, estadios, piscinas): no es
// area verde, pero el estudio general lo suma para la cifra de espacio recreativo,
// homologable con la que publican otros municipios. Se une sin doble conteo.
const DEPORTE = /^(pitch|track|sports_centre|stadium|swimming_pool|recreation_ground)$/;
const rasterDep = new Set(), deportivos = [];
for (const e of areas) {
  const t = e.tags || {};
  if (!DEPORTE.test(t.leisure || '') || privado(t) || esVerde(t)) continue;
  const rings = e.type === 'way' ? [e.geometry] : (e.members || []).filter(m => m.role === 'outer' && m.geometry).map(m => m.geometry);
  for (const g of rings) {
    if (!g || g.length < 4) continue;
    const ring = g.map(p => G.wgs2utm(p.lon, p.lat));
    let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12, n = 0, nNuevo = 0;
    for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    for (let i = Math.floor(x0 / PASO); i * PASO < x1; i++) for (let j = Math.floor(y0 / PASO); j * PASO < y1; j++) {
      const q = [(i + .5) * PASO, (j + .5) * PASO]; if (!G.pointInRing(q, ring) || !dentro(q)) continue;
      n++; if (!rasterDep.has(i + ':' + j)) { nNuevo++; rasterDep.add(i + ':' + j); }
    }
    // Un estadio dibujado como via y como relacion entra una sola vez en la lista.
    if (n && nNuevo > n / 2) deportivos.push({ nombre: t.name || '(sin nombre)', tag: t.leisure, area: n * PASO * PASO });
  }
}

// Componentes conexas (8 vecinos) = piezas verdes
const piezas = [];
for (const [key, cel] of raster) {
  if (cel.pieza >= 0) continue;
  const id = piezas.length, pila = [key], lista = []; cel.pieza = id;
  while (pila.length) {
    const k = pila.pop(); lista.push(k);
    const [i, j] = k.split(':').map(Number);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const n = (i + di) + ':' + (j + dj), c = raster.get(n);
      if (c && c.pieza < 0) { c.pieza = id; pila.push(n); }
    }
  }
  piezas.push({ id, celdas: lista });
}
for (const pz of piezas) {
  const area = new Map(), orig = { osm: 0, muni: 0 };
  let sx = 0, sy = 0, nd = 0;
  for (const k of pz.celdas) {
    const rc = raster.get(k), fu = fuentes[rc.f]; orig[fu.origen]++; if (rc.dentro) nd++;
    if (fu.nombre) area.set(fu.nombre, (area.get(fu.nombre) || 0) + 1);
    const [i, j] = k.split(':').map(Number); sx += (i + .5) * PASO; sy += (j + .5) * PASO;
  }
  pz.area = pz.celdas.length * PASO * PASO;
  pz.areaDentro = nd * PASO * PASO;   // lo que cuenta en la dotacion; el resto es periurbano y solo cuenta para el acceso
  pz.p = [sx / pz.celdas.length, sy / pz.celdas.length];
  pz.nombre = [...area].sort((a, b) => b[1] - a[1]).map(x => x[0]).find(n => !/^(AREA VERDE|S\/N|SIN NOMBRE)/i.test(n)) || '';
  pz.origen = orig.osm && orig.muni ? 'ambas' : orig.osm ? 'osm' : 'muni';
  pz.sector = sectorDe(pz.p);
  // Puntos de acceso: el borde de la pieza, uno por cada bloque de 20 m, enganchado al nodo de calle mas cercano.
  const borde = new Map();
  for (const k of pz.celdas) {
    const [i, j] = k.split(':').map(Number);
    if (raster.has((i + 1) + ':' + j) && raster.has((i - 1) + ':' + j) && raster.has(i + ':' + (j + 1)) && raster.has(i + ':' + (j - 1))) continue;
    const x = (i + .5) * PASO, y = (j + .5) * PASO, b = Math.floor(x / 20) + ',' + Math.floor(y / 20);
    if (!borde.has(b)) borde.set(b, [x, y]);
  }
  const acc = new Map();
  for (const q of borde.values()) { const [nodo, d] = cercano(q); if (nodo !== null && d <= 80 && (!acc.has(nodo) || d < acc.get(nodo))) acc.set(nodo, d); }
  if (!acc.size) { const [nodo, d] = cercano(pz.p); if (nodo !== null && d <= 300) acc.set(nodo, d); }
  pz.acc = [...acc].map(([nodo, d0]) => ({ nodo, d0, id: pz.id }));
}
const verdeTotal = suma(piezas, p => p.areaDentro);
const periurbanas = piezas.filter(p => !p.areaDentro && p.acc.length);
const escala = a => a < 1000 ? 'bolsillo' : a < 5000 ? 'vecinal' : a < 10000 ? 'barrial' : a < 100000 ? 'zonal' : 'ciudad';
console.log('piezas verdes:', piezas.length - periurbanas.length, 'urbanas y', periurbanas.length, 'fuera del limite | superficie', (verdeTotal / 1e4).toFixed(1), 'ha =', (verdeTotal / POB).toFixed(2), 'm2/hab');

// ------------------------------------------------ Distancia por calle
const distPto = (R, q) => q.nodo === null || !R.dist.has(q.nodo) ? Infinity : R.dist.get(q.nodo) + q.acceso;
function multi(min) { const F = piezas.filter(p => p.area >= min).flatMap(p => p.acc); return dijkstra(F); }
const R_ED1 = multi(ED1.lote);
for (const q of puntos) q.dED1 = distPto(R_ED1, q);
for (const r of RUEDA) { r.R = multi(r.min); for (const q of puntos) q[r.id] = distPto(r.R, q); }
for (const q of puntos) q.simult3 = RUEDA.slice(0, 3).reduce((a, r) => a + (q[r.id] <= r.dist ? 1 : 0), 0);
for (const q of puntos) q.simult = RUEDA.reduce((a, r) => a + (q[r.id] <= r.dist ? 1 : 0), 0);

// Dijkstra con corte: solo hace falta lo que queda a menos de R_EFECTIVO.
function alcance(fuentesAcc, corte) {
  const dist = new Map(), heap = [];
  const push = (d, id) => { heap.push([d, id]); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  for (const { nodo, d0 } of fuentesAcc) if (nodo !== null && (!dist.has(nodo) || d0 < dist.get(nodo))) { dist.set(nodo, d0); push(d0, nodo); }
  while (heap.length) {
    const [d, u] = pop(); if (d > dist.get(u)) continue;
    for (const [v, len] of nodos.get(u).adj) {
      if (!nodos.has(v)) continue;
      const nd = d + len; if (nd > corte) continue;
      if (!dist.has(v) || nd < dist.get(v)) { dist.set(v, nd); push(nd, v); }
    }
  }
  // indice de punto -> distancia, solo los que quedan dentro del corte
  const m = new Map();
  puntos.forEach((q, i) => { if (q.nodo === null || !dist.has(q.nodo)) return; const d = dist.get(q.nodo) + q.acceso; if (d <= corte) m.set(i, d); });
  return m;
}

// ------------------------------------------- Verde efectivo (2SFCA)
// Cada pieza reparte su superficie entre quienes la tienen a menos de 750 m por
// calle; cada habitante suma la parte de todas las piezas que alcanza. Es la
// dotacion de verde que de verdad queda a pie, compartida con los vecinos.
for (const q of puntos) q.efectivo = 0;
for (const pz of piezas) {
  if (pz.area < ED1.lote) continue;
  pz.alc = alcance(pz.acc, R_EFECTIVO);
  let pob = 0; for (const i of pz.alc.keys()) pob += puntos[i].pob;
  pz.pobAlcance = pob;
  // Solo la superficie dentro del limite: los parques del borde tambien los usan
  // vecinos rurales que no estan en la base de poblacion, y su parte saldria inflada.
  if (pob) for (const i of pz.alc.keys()) puntos[i].efectivo += pz.areaDentro / pob;
}
const efectivoCiudad = suma(puntos, q => q.efectivo * q.pob) / POB;
console.log('verde efectivo a', R_EFECTIVO, 'm:', efectivoCiudad.toFixed(2), 'm2/hab');

// ---------------------------------------------------------- Resumenes
function resumen(L) {
  const pob = suma(L, q => q.pob);
  const pct = f => pob ? +(suma(L.filter(f), q => q.pob) / pob * 100).toFixed(1) : null;
  const med = f => pob ? suma(L, q => Math.min(f(q), 1e5) * q.pob) / pob : null;
  return {
    pob: Math.round(pob),
    pctED1: pct(q => q.dED1 <= ED1.radio),
    dED1: Math.round(med(q => q.dED1)),
    ...Object.fromEntries(RUEDA.map(r => ['pct_' + r.id, pct(q => q[r.id] <= r.dist)])),
    pctSimult: pct(q => q.simult === 4),
    pctSimult3: pct(q => q.simult3 === 3),
    sinNinguna: pct(q => q.simult === 0),
    efectivo: +med(q => q.efectivo).toFixed(2),
    pctEfectivoBajo: pct(q => q.efectivo < 1)
  };
}
const ciudad = resumen(puntos);
const SECT = ['Centro', 'N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const verdeSector = {}, volSector = {}, areaSector = {};
for (const [key, c] of raster) { if (!c.dentro) continue; const [i, j] = key.split(':').map(Number); const s = sectorDe([(i + .5) * PASO, (j + .5) * PASO]); verdeSector[s] = (verdeSector[s] || 0) + PASO * PASO; }
for (const c of celdas.values()) { const s = sectorDe([gx0 + (c.i + .5) * CELDA, gy0 + (c.j + .5) * CELDA]); volSector[s] = (volSector[s] || 0) + c.vol + c.volIA; areaSector[s] = (areaSector[s] || 0) + c.area; }
const sectores = SECT.map(s => {
  const r = resumen(puntos.filter(q => q.sector === s));
  const v = verdeSector[s] || 0;
  return { id: s, ...r, areaHa: +(areaSector[s] / 1e4).toFixed(0), densidad: Math.round(r.pob / (areaSector[s] / 1e4)),
    verdeHa: +(v / 1e4).toFixed(2), m2hab: +(v / r.pob).toFixed(2), piezas: piezas.filter(p => p.sector === s && p.areaDentro && p.area >= ED1.lote).length,
    ca: +(volSector[s] / areaSector[s]).toFixed(2), ccv: v ? Math.round(volSector[s] / v) : null,
    deficitOMS: Math.max(0, Math.round((OMS * r.pob - v) / 1e4 * 10) / 10) };
});
console.table(sectores.map(s => ({ s: s.id, pob: s.pob, den: s.densidad, ha: s.verdeHa, m2: s.m2hab, ef: s.efectivo, ed1: s.pctED1, r1: s.pct_r1, r2: s.pct_r2, sim: s.pctSimult, ccv: s.ccv })));

// Rejilla: verde por celda y compacidad referida al verde en ventana de 600 m
const verdeCelda = new Map();
for (const [key, rc] of raster) { if (!rc.dentro) continue; const [i, j] = key.split(':').map(Number); const k = kCelda((i + .5) * PASO, (j + .5) * PASO); if (k) verdeCelda.set(k, (verdeCelda.get(k) || 0) + PASO * PASO); }
const porCelda = new Map();
for (const q of puntos) { if (!porCelda.has(q.k)) porCelda.set(q.k, []); porCelda.get(q.k).push(q); }
const salidaCeldas = [];
for (const c of celdas.values()) {
  const L = porCelda.get(c.i + ',' + c.j) || [], pob = suma(L, q => q.pob);
  if (pob < 1) continue;
  const x0 = gx0 + c.i * CELDA, y0 = gy0 + c.j * CELDA;
  const esq = [[x0, y0], [x0 + CELDA, y0 + CELDA]].map(([x, y]) => G.utm2wgs(x, y).map(v => +v.toFixed(6)));
  const pm = f => suma(L, q => Math.min(f(q), 1e5) * q.pob) / pob;
  let v = 0, e = 0;
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const n = celdas.get((c.i + di) + ',' + (c.j + dj)); if (n) { v += n.vol + n.volIA; e += verdeCelda.get(n.i + ',' + n.j) || 0; } }
  salidaCeldas.push({ b: [esq[0][0], esq[0][1], esq[1][0], esq[1][1]], s: sectorDe([x0 + CELDA / 2, y0 + CELDA / 2]),
    pob: Math.round(pob), den: Math.round(pob / (c.area / 1e4)), dV: Math.round(pm(q => q.dED1)), ef: +pm(q => q.efectivo).toFixed(2),
    sim: +pm(q => q.simult3).toFixed(1), ccv: e >= 100 ? Math.round(v / e) : null, v: Math.round(verdeCelda.get(c.i + ',' + c.j) || 0) });
}

// ---------------------------------------- Sitios para parques nuevos
// Candidatos: predios del GAD sin construccion (catastro ni Linea 1), de al
// menos 1 000 m2, dentro del limite, sin edificacion visible en la imagen (IA), que no son ya verde, que no son una
// franja (remanente vial) y que tienen calle a menos de 150 m. Los tres lotes
// que la rama 2.1 propone para mercados quedan reservados para ese uso.
// Suelo que el PUGS ya destina a recreacion y deporte: un lote ahi tiene el destino resuelto.
const PUGS = LEE(RAIZ + 'DATA SET/capas/PUGS Urbano.geojson').features
  .filter(f => /Recreación y Deporte/i.test(f.properties.u_principa || ''))
  .map(f => ({ nom: (f.properties.codigo_pit || '').replace(/^PIP_?\s*/, ''), polys: G.toUTM(f.geometry), geom: f.geometry }));
// Tenencia del suelo de cada zona del PUGS: municipal, de otra entidad publica o
// privada (sin nombres: el propietario privado no se publica), y cuanto ya es verde.
{
  const { clasificar } = require('../proximidad/clasificar.js');
  const cat = LEE(RAIZ + 'DATA SET/capas/Catastro GADMR.geojson').features;
  for (const z of PUGS) {
    z.ten = { municipal: 0, publico: 0, privado: 0 }; z.cons = 0;
    for (const f of cat) {
      const ps = G.toUTM(f.geometry); if (!ps.length) continue;
      const c = G.polysCentroid(ps); if (!c || !z.polys.some(p => G.pointInPoly(c, p))) continue;
      const pr = f.properties, nom = (pr.nombre_c || pr.gis_predio || '').trim(), a = G.polysArea(ps);
      const k = /GAD MUNICIPAL|MUNICIPIO|CONCEJO MUNICIPAL/i.test(nom) ? 'municipal' : clasificar(nom) ? 'publico' : 'privado';
      z.ten[k] += a; z.cons += +pr.sup_cons_c || 0;
    }
    let n = 0, v = 0;
    for (const p of z.polys) {
      let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12;
      for (const [x, y] of p[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      for (let i = Math.floor(x0 / PASO); i * PASO < x1; i++) for (let j = Math.floor(y0 / PASO); j * PASO < y1; j++)
        if (G.pointInPoly([(i + .5) * PASO, (j + .5) * PASO], p)) { n++; if (raster.has(i + ':' + j)) v++; }
    }
    z.pctVerde = n ? +(v / n * 100).toFixed(0) : 0;
    z.sector = sectorDe(G.polysCentroid(z.polys));
  }
  cat.length = 0;
}
const MERCADO = new Set((LEE('../proximidad/datos.json').escenario || []).map(e => e.clave));
// Huellas de edificacion detectadas por IA (todas, registradas o no): un lote
// municipal "sin construccion" en el catastro puede estar edificado o ser un parqueadero cubierto.
const HUELLA = new Map();
for (const f of LEE('../construcciones_ia.geojson').features) {
  const ps = G.toUTM(f.geometry), c = G.polysCentroid(ps); if (!c) continue;
  const k = Math.floor(c[0] / 100) + ',' + Math.floor(c[1] / 100);
  if (!HUELLA.has(k)) HUELLA.set(k, []); HUELLA.get(k).push({ c, a: G.polysArea(ps) });
}
function huellaEn(polys, x0, y0, x1, y1) {
  let a = 0;
  for (let i = Math.floor(x0 / 100); i <= Math.floor(x1 / 100); i++) for (let j = Math.floor(y0 / 100); j <= Math.floor(y1 / 100); j++)
    for (const h of HUELLA.get(i + ',' + j) || []) if (polys.some(p => G.pointInPoly(h.c, p))) a += h.a;
  return a;
}
const cands = [], descartes = { verde: 0, ocupado: 0, franja: 0, mercado: 0, sinCalle: 0 };
for (const f of PM) {
  const pr = f.properties; if ((+pr.sup_cons_c || 0) > 0 || (+pr.gis_pred_5 || 0) > 0) continue;
  const polys = G.toUTM(f.geometry); const a = G.polysArea(polys); if (a < LOTE_MIN_PARQUE) continue;
  const c = G.polysCentroid(polys); if (!c || !dentro(c)) continue;
  const clave = (pr.claves || '').trim();
  if (muniVerde.includes(clave)) { descartes.verde++; continue; }
  if (MERCADO.has(clave)) { descartes.mercado++; continue; }
  // Fraccion ya verde (OSM) y huella de construccion no registrada
  let n = 0, si = 0, x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12, per = 0;
  for (const poly of polys) for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  for (let i = Math.floor(x0 / PASO); i * PASO < x1; i++) for (let j = Math.floor(y0 / PASO); j * PASO < y1; j++)
    if (polys.some(p => G.pointInPoly([(i + .5) * PASO, (j + .5) * PASO], p))) { n++; if (raster.has(i + ':' + j)) si++; }
  if (n && si / n > 0.2) { descartes.verde++; continue; }
  if (huellaEn(polys, x0, y0, x1, y1) > 0.05 * a) { descartes.ocupado++; continue; }
  for (const poly of polys) { const r = poly[0]; for (let k = 1; k < r.length; k++) per += Math.hypot(r[k][0] - r[k - 1][0], r[k][1] - r[k - 1][1]); }
  const forma = 4 * Math.PI * a / (per * per);
  if (forma < 0.2) { descartes.franja++; continue; }
  // Acceso: el borde del lote, como en las piezas verdes
  const acc = new Map();
  for (const poly of polys) { const r = poly[0]; for (let k = 1; k < r.length; k++) { const L = Math.hypot(r[k][0] - r[k - 1][0], r[k][1] - r[k - 1][1]); for (let t = 0; t < L; t += 20) { const q = [r[k - 1][0] + (r[k][0] - r[k - 1][0]) * t / L, r[k - 1][1] + (r[k][1] - r[k - 1][1]) * t / L]; const [nodo, d] = cercano(q); if (nodo !== null && d <= 80 && (!acc.has(nodo) || d < acc.get(nodo))) acc.set(nodo, d); } } }
  if (!acc.size) { const [nodo, d] = cercano(c); if (nodo === null || d > 150) { descartes.sinCalle++; continue; } acc.set(nodo, d); }
  const [lon, lat] = G.utm2wgs(c[0], c[1]);
  const rings = polys.map(p => p[0].map(([x, y]) => G.utm2wgs(x, y).map(v => +v.toFixed(6))));
  cands.push({ clave, dir: (pr.gis_pred_8 || '').replace(/entre:.*$/, '').trim(), obs: (pr.observacio || '').trim(),
    area: Math.round(a), c: [+lon.toFixed(6), +lat.toFixed(6)], sector: sectorDe(c),
    pugs: (PUGS.find(z => z.polys.some(p => G.pointInPoly(c, p))) || {}).nom || null, parroquia: clave.slice(4, 6), forma: +forma.toFixed(2),
    acc: [...acc].map(([nodo, d0]) => ({ nodo, d0 })), rings });
}
console.log('candidatos municipales vacantes >=', LOTE_MIN_PARQUE, 'm2:', cands.length, 'descartados', descartes);
for (const k of cands) k.alc = alcance(k.acc, R_EFECTIVO);

// Seleccion por codicia: en cada ronda, el lote que deja a mas habitantes nuevos
// dentro del radio. Primero la escala barrial (ED1, 400 m); despues la zonal
// (lotes de 5 000 m2 o mas, 750 m), sobre lo que quede sin cubrir.
function escoger(lista, radio, cubierto, maximo, etiqueta) {
  const cub = puntos.map(cubierto), elegidos = [];
  const base = suma(puntos.filter((q, i) => cub[i]), q => q.pob);
  let acum = base;
  for (let r = 0; r < maximo; r++) {
    let best = null, bg = 0;
    for (const k of lista) {
      if (k.elegido) continue;
      let g = 0; for (const [i, d] of k.alc) if (d <= radio && !cub[i]) g += puntos[i].pob;
      if (g > bg) { bg = g; best = k; }
    }
    if (!best || bg < GANANCIA_MIN) break;
    best.elegido = etiqueta;
    for (const [i, d] of best.alc) if (d <= radio) cub[i] = true;
    acum += bg;
    elegidos.push({ ...best, orden: elegidos.length + 1, escala: etiqueta, radio, pobNueva: Math.round(bg), pctTras: +(acum / POB * 100).toFixed(1) });
  }
  return { base: +(base / POB * 100).toFixed(1), elegidos };
}
// Cada escala con su propio conjunto de lotes: hasta 5 000 m2 para el parque de
// barrio, desde 5 000 m2 para el zonal. Asi un lote grande no se gasta en la escala chica.
const barrial = escoger(cands.filter(k => k.area < LOTE_MIN_ZONAL), ED1.radio, q => q.dED1 <= ED1.radio, MAX_BARRIAL, 'barrial');
const zonal = escoger(cands.filter(k => k.area >= LOTE_MIN_ZONAL), 750, q => q.r2 <= 750, MAX_ZONAL, 'zonal');
for (const e of [...barrial.elegidos, ...zonal.elegidos]) console.log(e.escala, e.orden, e.clave, e.sector, e.area, 'm2 +', e.pobNueva, 'hab ->', e.pctTras, '%');
const areaPropuesta = suma([...barrial.elegidos, ...zonal.elegidos], e => e.area);

// -------------------------------------------------------------- Salida
const limpio = ({ acc, alc, elegido, ...k }) => k;
const out = {
  meta: {
    generado: new Date().toISOString().slice(0, 10), poblacion: POB, oms: OMS, ed1: ED1, rueda: RUEDA.map(({ R, ...r }) => r),
    rEfectivo: R_EFECTIVO, loteMinParque: LOTE_MIN_PARQUE, loteMinZonal: LOTE_MIN_ZONAL, gananciaMin: GANANCIA_MIN, maxBarrial: MAX_BARRIAL, maxZonal: MAX_ZONAL,
    radioCentro: RADIO_CENTRO, centro: G.utm2wgs(...CENTRO).map(v => +v.toFixed(6)),
    periurbanas: periurbanas.map(p => ({ nombre: p.nombre, ha: +(p.area / 1e4).toFixed(1) })),
    puntosSinArea: areas.filter(e => e.type === 'node' && (esVerde(e.tags || {}) || (DEPORTE.test((e.tags || {}).leisure || '') && !privado(e.tags || {})))).length,
    poligonosOSM: fuentes.filter(f => f.origen === 'osm').length, prediosMuniVerde: muniVerde.length,
    verdeHa: +(verdeTotal / 1e4).toFixed(1),
    recreativoHa: +([...new Set([...[...raster].filter(([, c]) => c.dentro).map(([k]) => k), ...rasterDep])].length * PASO * PASO / 1e4).toFixed(1),
    verdeOSMHa: +([...raster.values()].filter(c => c.dentro && c.osm).length * PASO * PASO / 1e4).toFixed(1), m2hab: +(verdeTotal / POB).toFixed(2), efectivo: +efectivoCiudad.toFixed(2),
    brechaOMSHa: Math.round((OMS * POB - verdeTotal) / 1e4), reqED1Ha: +(ED1.m2hab * POB / 1e4).toFixed(1),
    candidatos: cands.length, descartes, areaPropuestaHa: +(areaPropuesta / 1e4).toFixed(2)
  },
  ciudad, sectores,
  escalas: ['bolsillo', 'vecinal', 'barrial', 'zonal', 'ciudad'].map(e => { const L = piezas.filter(p => p.areaDentro && escala(p.areaDentro) === e); return { escala: e, n: L.length, ha: +(suma(L, p => p.areaDentro) / 1e4).toFixed(2) }; }),
  // Los mayores espacios verdes y deportivos (para el estudio general)
  mayores: [...piezas.filter(p => p.areaDentro).map(p => ({ nombre: p.nombre || '(sin nombre)', tag: 'área verde', area: p.areaDentro })), ...deportivos]
    .sort((a, b) => b.area - a.area).slice(0, 20),
  piezas: piezas.filter(p => p.area >= 100 && (p.areaDentro || p.pobAlcance)).sort((a, b) => b.area - a.area).map(p => ({ id: p.id, nombre: p.nombre, area: p.area, areaDentro: p.areaDentro, escala: escala(p.area), origen: p.origen, sector: p.sector,
    c: G.utm2wgs(...p.p).map(v => +v.toFixed(6)), pobAlcance: p.pobAlcance ? Math.round(p.pobAlcance) : null })),
  // Poligonos originales para dibujar, con la pieza a la que pertenecen
  poligonos: fuentes.map(fu => ({ o: fu.origen, n: fu.nombre, r: fu.ring.filter((_, i, A) => i % (A.length > 60 ? 2 : 1) === 0 || i === A.length - 1).map(([x, y]) => G.utm2wgs(x, y).map(v => +v.toFixed(6))) })),
  propuesta: { barrial: { base: barrial.base, sitios: barrial.elegidos.map(limpio) }, zonal: { base: zonal.base, sitios: zonal.elegidos.map(limpio) } },
  candidatos: cands.filter(k => !k.elegido).map(({ acc, alc, rings, ...k }) => k),
  pugs: PUGS.map(z => ({ nom: z.nom, geom: z.geom, ha: +(G.polysArea(z.polys) / 1e4).toFixed(1), sector: z.sector, pctVerde: z.pctVerde, consM2: Math.round(z.cons),
    ten: Object.fromEntries(Object.entries(z.ten).map(([k, v]) => [k, +(v / 1e4).toFixed(1)])) })),
  celdas: salidaCeldas, limite: B.limWGS
};
fs.writeFileSync('datos.json', JSON.stringify(out));
console.log('datos.json', (fs.statSync('datos.json').size / 1024).toFixed(0), 'KB');
console.log(JSON.stringify(out.meta));
console.log(JSON.stringify(ciudad));
console.log(out.escalas);
