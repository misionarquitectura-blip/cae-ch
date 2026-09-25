// Linea 2, estudio 2: compacidad, proximidad a equipamientos y viajes de abasto.
//
//   node --max-old-space-size=8192 analisis.js
//
// Entradas: catastro sep 2026, construcciones no registradas (Linea 1), red de
// calles de OSM (osm_red.js), parques de OSM y el inventario de la Linea 2,
// predios municipales del 1 sep 2026. Salida: datos.json, que lee la pagina.
const fs = require('fs');
const G = require('./geo.js');
const { clasificar } = require('./clasificar.js');
const MERCADOS = require('./mercados.js');

const RAIZ = '../../';
const LEE = p => JSON.parse(fs.readFileSync(p, 'utf8'));

// --------------------------------------------------------------- Supuestos
const POB = 177213, HOGARES = 57927;            // INEC CPV 2022, area urbana (ver Linea 2)
const CELDA = 200;                              // rejilla de Rueda (BCN Ecologia): 200 x 200 m
const ALTURA_PISO = 3;                          // m por planta, para pasar de m2 construidos a volumen
const RADIO_CENTRO = 1200;                      // m desde el Parque Maldonado
const CENTRO = G.wgs2utm(-78.64830, -1.67275);  // Parque Maldonado
const UMBRAL_PIE = 1000;                        // NAU: radio de influencia del mercado sectorial
const UMBRAL_MOTOR = 1500;                      // mas alla, el viaje de compra con carga deja de hacerse a pie
const VIAJES_SEMANA = 2;                        // viajes de abasto por hogar y semana (supuesto declarado)

// ------------------------------------------------------------ Limite urbano
const limWGS = LEE(RAIZ + 'DATA SET/DATOS GEOVISOR 01 09 2026/capas/Limite_Urbano.geojson').features[0].geometry;
const LIM = G.toUTM(limWGS);
const dentro = p => LIM.some(poly => G.pointInPoly(p, poly));
let bx0 = 1e12, by0 = 1e12, bx1 = -1e12, by1 = -1e12;
for (const [x, y] of LIM[0][0]) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
const areaLimite = G.polysArea(LIM);

// ------------------------------------------------------------------ Rejilla
const gx0 = Math.floor(bx0 / CELDA) * CELDA, gy0 = Math.floor(by0 / CELDA) * CELDA;
const NX = Math.ceil((bx1 - gx0) / CELDA), NY = Math.ceil((by1 - gy0) / CELDA);
const celdas = new Map();
const kCelda = (x, y) => { const i = Math.floor((x - gx0) / CELDA), j = Math.floor((y - gy0) / CELDA); return i < 0 || j < 0 || i >= NX || j >= NY ? null : i + ',' + j; };
for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
  const x0 = gx0 + i * CELDA, y0 = gy0 + j * CELDA;
  let a = 0;
  for (const poly of LIM) poly.forEach((r, k) => { const c = G.clipRect(r, x0, y0, x0 + CELDA, y0 + CELDA); if (c.length > 2) a += (k ? -1 : 1) * G.ringArea(c); });
  if (a < 1) continue;
  celdas.set(i + ',' + j, { i, j, area: a, vol: 0, volIA: 0, supCons: 0, supIA: 0, lotes: 0, estancia: 0, w: 0, pob: 0, hog: 0, pts: [] });
}
console.log('rejilla:', celdas.size, 'celdas de', CELDA, 'm; limite', (areaLimite / 1e4).toFixed(1), 'ha');

// ------------------------------------------ Predios: volumen y peso residencial
// Sin campo de uso en el catastro, el reparto de poblacion usa la superficie
// construida de los predios que NO son de un propietario institucional
// (colegios, ministerios, GAD, iglesias...), mas las huellas de construccion
// no registrada de la Linea 1 (una planta: es la hipotesis prudente).
const puntos = []; // { p:[x,y], w, sc, ia, celda }
const cat = LEE(RAIZ + 'DATA SET/Catastro GADMR.geojson');
let nPred = 0, scTot = 0, scRes = 0;
for (const f of cat.features) {
  const polys = G.toUTM(f.geometry); if (!polys.length) continue;
  const c = G.polysCentroid(polys); if (!c || !dentro(c)) continue;
  const k = kCelda(c[0], c[1]); const cel = k && celdas.get(k); if (!cel) continue;
  const pr = f.properties, sc = +pr.sup_cons_c || 0;
  const inst = clasificar((pr.gis_predio || pr.nombre_c || '').trim());
  nPred++; scTot += sc; cel.supCons += sc; cel.vol += sc * ALTURA_PISO; cel.lotes += G.polysArea(polys);
  if (!inst && sc > 0) { scRes += sc; puntos.push({ p: c, w: sc, k }); }
}
cat.features.length = 0;
const nr = LEE(RAIZ + 'RESEARCH/no_registradas.geojson');
let iaTot = 0;
for (const f of nr.features) {
  const polys = G.toUTM(f.geometry); const c = G.polysCentroid(polys); if (!c || !dentro(c)) continue;
  const k = kCelda(c[0], c[1]); const cel = k && celdas.get(k); if (!cel) continue;
  const a = G.polysArea(polys); iaTot += a;
  cel.supIA += a; cel.volIA += a * ALTURA_PISO; puntos.push({ p: c, w: a, k, ia: true });
}
const wTot = puntos.reduce((s, q) => s + q.w, 0);
for (const q of puntos) { q.pob = POB * q.w / wTot; q.hog = HOGARES * q.w / wTot; const cel = celdas.get(q.k); cel.pob += q.pob; cel.hog += q.hog; cel.w += q.w; }
console.log('predios urbanos', nPred, '| construido', (scTot / 1e4).toFixed(0), 'ha, residencial', (scRes / 1e4).toFixed(0), 'ha, IA no registrada', (iaTot / 1e4).toFixed(1), 'ha');

// ------------------------------------------------------ Espacio de estancia
// Parques, jardines, juegos infantiles y plazas peatonales dibujados como
// poligono en OSM. Se rasteriza a 5 m y se deduplica: un juego infantil dentro
// de un parque no cuenta dos veces. No hay capa de aceras: la compacidad
// corregida sale por eso mas alta de lo que seria con el criterio completo.
const areas = LEE('../equipamiento/osm_areas.json').elements;
const calles = LEE('fuentes/calles.json').elements;
const esEstancia = t => /^(park|garden|playground|recreation_ground)$/.test(t.leisure || '') || /^(village_green|recreation_ground)$/.test(t.landuse || '') || t.place === 'square';
const polEst = [];
for (const e of areas) if (e.type === 'way' && e.geometry && esEstancia(e.tags || {})) polEst.push([e.geometry.map(g => G.wgs2utm(g.lon, g.lat))]);
for (const e of areas) if (e.type === 'relation' && esEstancia(e.tags || {})) for (const m of e.members || []) if (m.role === 'outer' && m.geometry) polEst.push([m.geometry.map(g => G.wgs2utm(g.lon, g.lat))]);
for (const w of calles) { const n = w.nodes; if (w.tags.highway === 'pedestrian' && n[0] === n[n.length - 1] && n.length > 3) polEst.push([w.geometry.map(g => G.wgs2utm(g.lon, g.lat))]); }
const PASO = 5, vistos = new Set();
for (const poly of polEst) {
  let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12;
  for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  for (let x = Math.floor(x0 / PASO) * PASO + PASO / 2; x < x1; x += PASO) for (let y = Math.floor(y0 / PASO) * PASO + PASO / 2; y < y1; y += PASO) {
    const key = x + ':' + y; if (vistos.has(key) || !G.pointInPoly([x, y], poly)) continue;
    vistos.add(key); const k = kCelda(x, y), cel = k && celdas.get(k); if (cel && dentro([x, y])) cel.estancia += PASO * PASO;
  }
}
console.log('espacio de estancia', ([...celdas.values()].reduce((s, c) => s + c.estancia, 0) / 1e4).toFixed(1), 'ha');

// ---------------------------------------------------------------- Red de calles
const nodos = new Map(); // id -> { x, y, adj: [[id, len, eid]] }
const aristas = [];      // { a, b, len, nombre, tipo }
for (const w of calles) {
  const t = w.tags;
  for (let i = 0; i < w.nodes.length; i++) {
    const id = w.nodes[i];
    if (!nodos.has(id)) { const [x, y] = G.wgs2utm(w.geometry[i].lon, w.geometry[i].lat); nodos.set(id, { x, y, lon: w.geometry[i].lon, lat: w.geometry[i].lat, adj: [] }); }
    if (i) {
      const a = nodos.get(w.nodes[i - 1]), b = nodos.get(id), len = Math.hypot(a.x - b.x, a.y - b.y);
      const eid = aristas.length; aristas.push({ a: w.nodes[i - 1], b: id, len, nombre: t.name || '', tipo: t.highway, carga: 0, cargaEsc: 0 });
      a.adj.push([id, len, eid]); b.adj.push([w.nodes[i - 1], len, eid]);
    }
  }
}
// Componente conexa mayor: las islas (un pasaje sin conexion en OSM) atraerian puntos sin salida.
{
  let mejor = null;
  const comp = new Map();
  for (const id of nodos.keys()) {
    if (comp.has(id)) continue;
    const pila = [id], lista = []; comp.set(id, id);
    while (pila.length) { const u = pila.pop(); lista.push(u); for (const [v] of nodos.get(u).adj) if (!comp.has(v)) { comp.set(v, id); pila.push(v); } }
    if (!mejor || lista.length > mejor.length) mejor = lista;
  }
  const ok = new Set(mejor);
  for (const id of [...nodos.keys()]) if (!ok.has(id)) nodos.delete(id);
  console.log('red: ', nodos.size, 'nodos en la componente mayor,', aristas.length, 'tramos');
}
const IDX = new Map(), IDXC = 100;
for (const [id, n] of nodos) { const k = Math.floor(n.x / IDXC) + ',' + Math.floor(n.y / IDXC); if (!IDX.has(k)) IDX.set(k, []); IDX.get(k).push(id); }
function cercano([x, y]) {
  const cx = Math.floor(x / IDXC), cy = Math.floor(y / IDXC);
  for (let r = 0; r < 30; r++) {
    let best = null, bd = Infinity;
    for (let i = cx - r; i <= cx + r; i++) for (let j = cy - r; j <= cy + r; j++) {
      if (r && Math.abs(i - cx) < r && Math.abs(j - cy) < r) continue;
      for (const id of IDX.get(i + ',' + j) || []) { const n = nodos.get(id), d = Math.hypot(n.x - x, n.y - y); if (d < bd) { bd = d; best = id; } }
    }
    if (best !== null && bd <= (r + 1) * IDXC) return [best, bd];
  }
  return [null, Infinity];
}
for (const q of puntos) [q.nodo, q.acceso] = cercano(q.p);

// Dijkstra multiorigen con monticulo binario. Devuelve distancia, origen y arista previa.
function dijkstra(fuentes) {
  const dist = new Map(), src = new Map(), pred = new Map(), heap = [];
  const push = (d, id) => { heap.push([d, id]); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  for (const { nodo, d0, id } of fuentes) if (nodo !== null && (!dist.has(nodo) || d0 < dist.get(nodo))) { dist.set(nodo, d0); src.set(nodo, id); pred.set(nodo, -1); push(d0, nodo); }
  while (heap.length) {
    const [d, u] = pop(); if (d > dist.get(u)) continue;
    for (const [v, len, eid] of nodos.get(u).adj) {
      if (!nodos.has(v)) continue;
      const nd = d + len;
      if (!dist.has(v) || nd < dist.get(v)) { dist.set(v, nd); src.set(v, src.get(u)); pred.set(v, eid); push(nd, v); }
    }
  }
  return { dist, src, pred };
}
const distPunto = (R, q) => q.nodo === null || !R.dist.has(q.nodo) ? Infinity : R.dist.get(q.nodo) + q.acceso;

// ------------------------------------------------------------------ Sectores
const OCT = ['E', 'NE', 'N', 'NO', 'O', 'SO', 'S', 'SE'];
const sectorDe = ([x, y]) => {
  const dx = x - CENTRO[0], dy = y - CENTRO[1];
  if (Math.hypot(dx, dy) <= RADIO_CENTRO) return 'Centro';
  const ang = (Math.atan2(dy, dx) * 180 / Math.PI + 360 + 22.5) % 360;
  return OCT[Math.floor(ang / 45)];
};
for (const q of puntos) q.sector = sectorDe(q.p);

// Base compartida con las otras ramas de la Linea 2 (RESEARCH/educacion):
// poblacion por predio, rejilla, red de calles y sectores. Al cargarse con
// require() el archivo se detiene aqui y no calcula nada de mercados.
if (require.main !== module) {
  module.exports = { G, POB, HOGARES, CELDA, CENTRO, RADIO_CENTRO, celdas, puntos, nodos, aristas, cercano, dijkstra, distPunto, sectorDe, kCelda, gx0, gy0, limWGS, dentro };
  return;
}

// ------------------------------------------------------------- Equipamientos
// Todo lo demas sale del inventario consolidado de la Linea 2, con una
// correccion: en el catastro, EA solo es mercado si el propietario lo dice.
const C = LEE('../equipamiento/consolidado.json');
const SERVICIOS = [
  { id: 'mercado',   nom: 'Mercado de abasto',         radio: 1000 },
  { id: 'inicial',   nom: 'Educación inicial',          radio: 400,  sub: 'Educación inicial' },
  { id: 'basica',    nom: 'Educación básica y bachillerato', radio: 1000, sub: 'Educación básica y bachillerato' },
  { id: 'salud',     nom: 'Centro de salud',            radio: 800,  sub: 'Centro de salud' },
  { id: 'verde',     nom: 'Área verde',                 radio: 400,  sub: 'Áreas verdes y recreación' },
  { id: 'deporte',   nom: 'Equipamiento deportivo',     radio: 1000, sub: 'Equipamiento deportivo' },
  { id: 'cultural',  nom: 'Cultural / casa comunal',    radio: 1000, sub: 'Cultural' },
  { id: 'bienestar', nom: 'Bienestar social',           radio: 800,  sub: 'Bienestar social' },
  { id: 'seguridad', nom: 'UPC / seguridad',            radio: 800,  sub: 'UPC / seguridad barrial' }
];
const MERC_ABASTO = MERCADOS.filter(m => m.abasto);
for (const s of SERVICIOS) {
  let lugares;
  if (s.id === 'mercado') lugares = MERC_ABASTO.map(m => ({ id: m.id, c: m.c }));
  else lugares = [
    ...C.establecimientos.filter(e => e.sub === s.sub).map((e, i) => ({ id: 'c' + i, c: e.c })),
    ...C.osm.filter(o => o.publico && o.sub === s.sub).map((o, i) => ({ id: 'o' + i, c: o.c }))
  ];
  s.n = lugares.length;
  s.fuentes = lugares.map(l => { const p = G.wgs2utm(l.c[0], l.c[1]); const [nodo, d0] = cercano(p); return { nodo, d0, id: l.id }; });
  s.R = dijkstra(s.fuentes);
  for (const q of puntos) q[s.id] = distPunto(s.R, q);
  const cub = puntos.reduce((a, q) => a + (q[s.id] <= s.radio ? q.pob : 0), 0);
  s.cobertura = +(cub / POB * 100).toFixed(1);
  console.log(s.nom.padEnd(34), String(s.n).padStart(4), 'lugares, pob. a <=', s.radio, 'm por calle:', s.cobertura, '%');
}
for (const q of puntos) q.simult = SERVICIOS.reduce((a, s) => a + (q[s.id] <= s.radio ? 1 : 0), 0);

// ------------------------------------------------ Mercados: cuencas y flujos
const RM = SERVICIOS[0].R;
const porMercado = {};
for (const m of MERC_ABASTO) porMercado[m.id] = { pob: 0, hog: 0, dsum: 0 };
for (const q of puntos) { const id = RM.src.get(q.nodo); if (!id) continue; const b = porMercado[id]; b.pob += q.pob; b.hog += q.hog; b.dsum += q.mercado * q.pob; }

// Asignacion de viajes al arbol de caminos minimos: cada hogar va al mercado
// mas cercano por la calle; la carga de un tramo = hogares que pasan por el.
function cargar(R, campo, dcampo) {
  const peso = new Map();
  for (const q of puntos) if (q.nodo !== null && R.dist.has(q.nodo)) peso.set(q.nodo, (peso.get(q.nodo) || 0) + q.hog);
  const orden = [...R.dist.keys()].sort((a, b) => R.dist.get(b) - R.dist.get(a));
  for (const u of orden) {
    const h = peso.get(u); if (!h) continue;
    const eid = R.pred.get(u); if (eid === -1 || eid === undefined) continue;
    const e = aristas[eid]; e[campo] += h;
    const v = e.a === u ? e.b : e.a; peso.set(v, (peso.get(v) || 0) + h);
  }
}
cargar(RM, 'carga');

// ------------------------------------------------ Resumenes por sector y celda
function resumen(filtro) {
  const L = puntos.filter(filtro);
  const pob = L.reduce((a, q) => a + q.pob, 0), hog = L.reduce((a, q) => a + q.hog, 0);
  const pm = (f) => pob ? L.reduce((a, q) => a + f(q) * q.pob, 0) / pob : null;
  return {
    pob: Math.round(pob), hog: Math.round(hog),
    dMercado: Math.round(pm(q => q.mercado)),
    pctPie: +(L.reduce((a, q) => a + (q.mercado <= UMBRAL_PIE ? q.pob : 0), 0) / pob * 100).toFixed(1),
    pctMotor: +(L.reduce((a, q) => a + (q.mercado > UMBRAL_MOTOR ? q.pob : 0), 0) / pob * 100).toFixed(1),
    simult: +pm(q => q.simult).toFixed(2),
    kmSemana: Math.round(L.reduce((a, q) => a + q.hog * 2 * q.mercado / 1000 * VIAJES_SEMANA, 0)),
    kmHogar: +(pm(q => 2 * q.mercado / 1000 * VIAJES_SEMANA)).toFixed(1),
    pctIA: +(L.reduce((a, q) => a + (q.ia ? q.w : 0), 0) / L.reduce((a, q) => a + q.w, 0) * 100).toFixed(1),
    bandas: [500, 1000, 1500, 3000, Infinity].map((t, i, T) => +(L.reduce((a, q) => a + (q.mercado <= t && q.mercado > (i ? T[i - 1] : -1) ? q.pob : 0), 0) / pob * 100).toFixed(1)),
    porServicio: Object.fromEntries(SERVICIOS.map(s => [s.id, +(L.reduce((a, q) => a + (q[s.id] <= s.radio ? q.pob : 0), 0) / pob * 100).toFixed(1)]))
  };
}
const SECT = ['Centro', 'N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const sectores = SECT.map(s => ({ id: s, ...resumen(q => q.sector === s) }));
// Area y compacidad por sector (sobre las celdas, por su centro)
for (const s of sectores) {
  let area = 0, vol = 0, volIA = 0, est = 0;
  for (const c of celdas.values()) {
    if (sectorDe([gx0 + (c.i + .5) * CELDA, gy0 + (c.j + .5) * CELDA]) !== s.id) continue;
    area += c.area; vol += c.vol; volIA += c.volIA; est += c.estancia;
  }
  s.areaHa = +(area / 1e4).toFixed(0); s.densidad = +(s.pob / (area / 1e4)).toFixed(0);
  s.ca = +(vol / area).toFixed(2); s.caIA = +((vol + volIA) / area).toFixed(2);
  s.estanciaM2Hab = +(est / s.pob).toFixed(2);
  s.mercados = MERC_ABASTO.filter(m => sectorDe(G.wgs2utm(m.c[0], m.c[1])) === s.id).length;
}
const ciudad = resumen(() => true);

// Rejilla de salida
const salidaCeldas = [];
for (const c of celdas.values()) {
  const L = puntos.filter(q => q.k === c.i + ',' + c.j);
  const pob = c.pob;
  const x0 = gx0 + c.i * CELDA, y0 = gy0 + c.j * CELDA;
  const esq = [[x0, y0], [x0 + CELDA, y0 + CELDA]].map(([x, y]) => G.utm2wgs(x, y).map(v => +v.toFixed(6)));
  const pm = f => pob ? L.reduce((a, q) => a + f(q) * q.pob, 0) / pob : null;
  const volT = c.vol + c.volIA;
  salidaCeldas.push({
    b: [esq[0][0], esq[0][1], esq[1][0], esq[1][1]],
    s: sectorDe([x0 + CELDA / 2, y0 + CELDA / 2]),
    ha: +(c.area / 1e4).toFixed(2),
    pob: Math.round(pob),
    den: +(pob / (c.area / 1e4)).toFixed(0),
    ca: +(c.vol / c.area).toFixed(2),
    caIA: +(volT / c.area).toFixed(2),
    // Rueda: volumen edificado / espacio de estancia. Sin estancia no hay valor.
    cc: (() => { // ventana 3 x 3 celdas (600 x 600 m): la estancia se usa a pie, no dentro de la celda
      let v = 0, e = 0;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const n = celdas.get((c.i + di) + ',' + (c.j + dj)); if (n) { v += n.vol + n.volIA; e += n.estancia; } }
      return e >= 100 ? +(v / e).toFixed(1) : null; })(),
    est: Math.round(c.estancia),
    ia: c.supCons + c.supIA > 0 ? +(c.supIA / (c.supCons + c.supIA) * 100).toFixed(0) : null,
    dm: pob ? Math.round(pm(q => q.mercado)) : null,
    ps: pob ? +pm(q => q.simult).toFixed(1) : null
  });
}

// Flujos: tramos con carga, agrupados por calle y clase de carga para aligerar.
const flujos = [];
const CLASES = [50, 250, 1000, 2500, 5000];
for (const e of aristas) {
  if (e.carga < CLASES[0] || !nodos.has(e.a) || !nodos.has(e.b)) continue;
  const a = nodos.get(e.a), b = nodos.get(e.b);
  flujos.push([+a.lon.toFixed(5), +a.lat.toFixed(5), +b.lon.toFixed(5), +b.lat.toFixed(5), Math.round(e.carga)]);
}
// Corredores: hogar-km por nombre de calle
const corr = new Map();
for (const e of aristas) if (e.carga > 0 && e.nombre) corr.set(e.nombre, (corr.get(e.nombre) || 0) + e.carga * e.len / 1000);
const corredores = [...corr].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n, v]) => ({ nombre: n, hogarKm: Math.round(v) }));
const totalHogKm = [...corr.values()].reduce((a, b) => a + b, 0) + aristas.filter(e => !e.nombre).reduce((a, e) => a + e.carga * e.len / 1000, 0);

// Hogares cuya compra termina en un mercado del centro
const enCentro = new Set(MERC_ABASTO.filter(m => sectorDe(G.wgs2utm(m.c[0], m.c[1])) === 'Centro').map(m => m.id));
const hogCentro = puntos.reduce((a, q) => a + (enCentro.has(RM.src.get(q.nodo)) && q.sector !== 'Centro' ? q.hog : 0), 0);
const hogFuera = puntos.reduce((a, q) => a + (q.sector !== 'Centro' ? q.hog : 0), 0);

// -------------------------------------------- Escenario: mercados en suelo municipal
// Candidatos: predios del GAD sin construccion, de al menos 3 000 m2, dentro del
// limite urbano. Se elige por codicia el que mas reduce la distancia total
// (hogares x metros) y se repite hasta tres.
const PM = LEE(RAIZ + 'DATA SET/DATOS GEOVISOR 01 09 2026/capas/Predios_Municipales.geojson').features;
const cands = [], descartes = { verde: 0, parqueOSM: 0, ocupado: 0 };
// Fraccion del lote cubierta por espacio de estancia de OSM (muestreo a 5 m)
function enEstancia(polys) {
  let n = 0, si = 0;
  for (const poly of polys) {
    let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12;
    for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    for (let x = Math.floor(x0 / PASO) * PASO + PASO / 2; x < x1; x += PASO) for (let y = Math.floor(y0 / PASO) * PASO + PASO / 2; y < y1; y += PASO)
      if (G.pointInPoly([x, y], poly)) { n++; if (vistos.has(x + ':' + y)) si++; }
  }
  return n ? si / n : 0;
}
// Superficie de construccion no registrada (Linea 1) cuyo centroide cae en el lote
function iaDentro(polys) { return puntos.reduce((a, q) => a + (q.ia && polys.some(p => G.pointInPoly(q.p, p)) ? q.w : 0), 0); }
for (const f of PM) {
  const pr = f.properties; if ((+pr.sup_cons_c || 0) > 0 || (+pr.gis_pred_5 || 0) > 0) continue;
  const polys = G.toUTM(f.geometry); const a = G.polysArea(polys); if (a < 3000) continue;
  const c = G.polysCentroid(polys); if (!dentro(c)) continue;
  // Fuera las areas verdes: con 1,37 m2/hab no se propone cambiar un parque por un mercado.
  if (/AREA.?VERDE|PARQUE|RECREAC/i.test((pr.nombre || '') + ' ' + (pr.observacio || '') + ' ' + (pr.observac_1 || ''))) { descartes.verde++; continue; }
  if (enEstancia(polys) > 0.2) { descartes.parqueOSM++; continue; }
  if (iaDentro(polys) > 0.05 * a) { descartes.ocupado++; continue; }
  const [nodo, d0] = cercano(c); if (nodo === null || d0 > 150) continue;
  const [lon, lat] = G.utm2wgs(c[0], c[1]);
  cands.push({ clave: (pr.claves || '').trim(), nombre: (pr.nombre || '').trim(), obs: (pr.observacio || '').trim(), area: Math.round(a), c: [+lon.toFixed(6), +lat.toFixed(6)], nodo, d0, sector: sectorDe(c) });
}
console.log('candidatos municipales vacantes >= 3000 m2:', cands.length, 'descartados', descartes);
for (const k of cands) { const R = dijkstra([{ nodo: k.nodo, d0: k.d0, id: 'k' }]); k.d = puntos.map(q => distPunto(R, q)); }
let actual = puntos.map(q => q.mercado);
const costo = arr => puntos.reduce((a, q, i) => a + q.hog * arr[i], 0);
const base = { hogM: costo(actual), pie: puntos.reduce((a, q, i) => a + (actual[i] <= UMBRAL_PIE ? q.pob : 0), 0) };
const elegidos = [];
for (let r = 0; r < 3; r++) {
  let best = null, bc = Infinity;
  for (const k of cands) { if (elegidos.includes(k)) continue; const c = puntos.reduce((a, q, i) => a + q.hog * Math.min(actual[i], k.d[i]), 0); if (c < bc) { bc = c; best = k; } }
  if (!best) break;
  actual = actual.map((v, i) => Math.min(v, best.d[i]));
  const pie = puntos.reduce((a, q, i) => a + (actual[i] <= UMBRAL_PIE ? q.pob : 0), 0);
  const nuevaCuenca = puntos.reduce((a, q, i) => a + (best.d[i] <= actual[i] + 1e-6 && best.d[i] <= UMBRAL_PIE ? q.pob : 0), 0);
  elegidos.push(best);
  best.res = {
    orden: r + 1,
    kmSemanaTrasSumar: Math.round(bc * 2 / 1000 * VIAJES_SEMANA),
    reduccionPct: +((1 - bc / base.hogM) * 100).toFixed(1),
    pctPieTrasSumar: +(pie / POB * 100).toFixed(1),
    pobCaminable: Math.round(nuevaCuenca)
  };
  console.log('sitio', r + 1, best.clave, best.sector, best.area, 'm2 ->', best.res);
}
// Carga de la red con el primer sitio: cuanto baja el flujo hacia el centro.
{
  const k = elegidos[0];
  const R2 = dijkstra([...SERVICIOS[0].fuentes, { nodo: k.nodo, d0: k.d0, id: 'nuevo' }]);
  cargar(R2, 'cargaEsc');
  const hogCentro2 = puntos.reduce((a, q) => a + (enCentro.has(R2.src.get(q.nodo)) && q.sector !== 'Centro' ? q.hog : 0), 0);
  k.res.hogHaciaCentro = Math.round(hogCentro2);
  const c2 = new Map();
  for (const e of aristas) if (e.cargaEsc > 0 && e.nombre) c2.set(e.nombre, (c2.get(e.nombre) || 0) + e.cargaEsc * e.len / 1000);
  for (const co of corredores) co.hogarKmEsc = Math.round(c2.get(co.nombre) || 0);
  const tot2 = aristas.reduce((a, e) => a + e.cargaEsc * e.len / 1000, 0);
  k.res.hogarKmRed = Math.round(tot2);
  const nw = puntos.filter(q => q.sector === 'NO');
  const dNO = R2 => nw.reduce((a, q) => a + distPunto(R2, q) * q.pob, 0) / nw.reduce((a, q) => a + q.pob, 0);
  k.res.dMercadoNO = Math.round(dNO(R2));
}

// -------------------------------------------------------------------- Salida
const out = {
  meta: {
    generado: new Date().toISOString().slice(0, 10),
    poblacion: POB, hogares: HOGARES, celda: CELDA, alturaPiso: ALTURA_PISO,
    radioCentro: RADIO_CENTRO, umbralPie: UMBRAL_PIE, umbralMotor: UMBRAL_MOTOR, viajesSemana: VIAJES_SEMANA,
    areaLimiteHa: +(areaLimite / 1e4).toFixed(1), predios: nPred, supConsHa: +(scTot / 1e4).toFixed(1),
    supResidHa: +(scRes / 1e4).toFixed(1), supIAHa: +(iaTot / 1e4).toFixed(1),
    estanciaHa: +([...celdas.values()].reduce((s, c) => s + c.estancia, 0) / 1e4).toFixed(1),
    nodos: nodos.size, tramos: aristas.length,
    hogaresHaciaCentro: Math.round(hogCentro), hogaresFueraCentro: Math.round(hogFuera),
    hogarKmTotal: Math.round(totalHogKm),
    centro: G.utm2wgs(...CENTRO).map(v => +v.toFixed(6))
  },
  ciudad, sectores,
  servicios: SERVICIOS.map(({ id, nom, radio, n, cobertura }) => ({ id, nom, radio, n, cobertura })),
  mercados: MERCADOS.map(m => ({ ...m, ...(porMercado[m.id] ? { pob: Math.round(porMercado[m.id].pob), hog: Math.round(porMercado[m.id].hog), dMedia: Math.round(porMercado[m.id].dsum / porMercado[m.id].pob) } : {}) })),
  dudosos: MERCADOS.dudosos,
  corredores, flujos,
  descartes,
  escenario: elegidos.map(({ d, nodo, d0, ...k }) => k),
  candidatos: cands.map(({ d, nodo, d0, ...k }) => k),
  celdas: salidaCeldas,
  limite: limWGS
};
fs.writeFileSync('datos.json', JSON.stringify(out));
console.log('datos.json', (fs.statSync('datos.json').size / 1024).toFixed(0), 'KB');
console.log(JSON.stringify(ciudad));
console.table(sectores.map(s => ({ s: s.id, pob: s.pob, den: s.densidad, ca: s.ca, caIA: s.caIA, merc: s.mercados, dM: s.dMercado, pie: s.pctPie, motor: s.pctMotor, kmHog: s.kmHogar, simult: s.simult, ia: s.pctIA, est: s.estanciaM2Hab })));
console.log('hogares fuera del centro que compran en el centro:', Math.round(hogCentro), 'de', Math.round(hogFuera));
console.log(corredores);
console.log(out.mercados.map(m => m.id + ' ' + m.pob + ' ' + m.dMedia).join('\n'));
