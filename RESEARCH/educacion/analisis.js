// Linea 2, rama 2.2: instituciones educativas y los viajes que generan.
//
//   node registro.js && node geolocalizar.js && node --max-old-space-size=8192 analisis.js && node build.js
//
// Reutiliza la base de la rama 2.1 (poblacion por predio, rejilla, red de
// calles, sectores): RESEARCH/proximidad/analisis.js cargado como modulo.
const fs = require('fs'), path = require('path');
const AQUI = __dirname;
process.chdir(path.join(AQUI, '../proximidad'));
const B = require('../proximidad/analisis.js');
process.chdir(AQUI);
const { G, POB, puntos, nodos, aristas, cercano, dijkstra, sectorDe, celdas, CELDA, gx0, gy0, CENTRO, RADIO_CENTRO } = B;
const LEE = p => JSON.parse(fs.readFileSync(p, 'utf8'));

// --------------------------------------------------------------- Supuestos
// Edad escolar 3-17 del area urbana (INEC CPV 2022, ver Linea 2): 0-11 = 29 890
// (se toman 3-11 = 9/12 del grupo), 12-17 = 17 279.
const NINOS_3_11 = Math.round(29890 * 9 / 12), ADOL_12_17 = 17279;
const EDAD_ESCOLAR = NINOS_3_11 + ADOL_12_17;
const L_BASE = 2000;          // m. Distancia caracteristica de la eleccion de escuela (= radio EE2 del Codigo Urbano)
const SENSIB = [1000, 4000];  // se reporta cuanto cambian las cifras con otra L
const UMBRAL_PIE = 1500;      // mas alla, el viaje escolar es motorizado casi siempre
const RADIO_EE1 = 400, RADIO_EE2 = 2000;

const REG = LEE('registro_riobamba.json');
const URB = REG.instituciones.filter(x => x.area === 'Urbana');
const UBI = LEE('instituciones.json');
const SIN = LEE('sin_ubicar.json');
const suma = (L, f) => L.reduce((a, x) => a + f(x), 0);

// Escuelas ubicadas -> nodo de la red
const ESC = UBI.map(x => {
  const p = G.wgs2utm(x.c[0], x.c[1]); const [nodo, d0] = cercano(p);
  return { ...x, p, nodo, d0, sector: sectorDe(p) };
}).filter(x => x.nodo !== null);

// Residentes en edad escolar por punto de poblacion
const PARTE = EDAD_ESCOLAR / POB;
for (const q of puntos) q.ninos = q.pob * PARTE;

// ------------------------------------------- Distancias por calle a cada escuela
console.log('escuelas ubicadas en la red:', ESC.length);
for (const e of ESC) { e.R = dijkstra([{ nodo: e.nodo, d0: e.d0, id: e.amie }]); }
const dq = (e, q) => q.nodo === null || !e.R.dist.has(q.nodo) ? Infinity : e.R.dist.get(q.nodo) + q.acceso;
for (const q of puntos) q.d = ESC.map(e => dq(e, q));

// Proximidad: cualquier escuela a 400 m (EE1) y una EE2 a 2 000 m
const iEE2 = ESC.map((e, i) => e.norma === 'EE2' ? i : -1).filter(i => i >= 0);
for (const q of puntos) {
  q.dMin = Math.min(...q.d);
  q.dEE2 = Math.min(...iEE2.map(i => q.d[i]));
}

// ------------------------------------------------------ Modelo de eleccion
// Cada residente de 3 a 17 anos se reparte entre las escuelas ubicadas con
// probabilidad proporcional a su matricula y a exp(-d/L): las grandes atraen
// mas, las lejanas menos. Es un modelo gravitacional con restriccion en el
// origen: no reproduce la eleccion real de cada familia, pero si el orden de
// magnitud de los recorridos y por donde pasan.
function modelo(L, cargarRed) {
  const S = ESC.map(e => e.estudiantes);
  let km = 0, n = 0, motor = 0;
  const T = ESC.map(() => new Map()); // viajes por escuela y nodo de origen
  const porSector = {};
  for (const q of puntos) {
    if (!q.ninos) continue;
    const w = q.d.map((d, j) => d === Infinity ? 0 : S[j] * Math.exp(-d / L));
    const W = w.reduce((a, b) => a + b, 0); if (!W) continue;
    let dm = 0;
    w.forEach((wj, j) => {
      if (!wj) return; const t = q.ninos * wj / W;
      km += t * q.d[j] / 1000; n += t; dm += wj / W * q.d[j];
      if (q.d[j] > UMBRAL_PIE) motor += t;
      if (cargarRed) T[j].set(q.nodo, (T[j].get(q.nodo) || 0) + t);
      const sd = ESC[j].sector; porSector[q.sector + '>' + sd] = (porSector[q.sector + '>' + sd] || 0) + t;
    });
    if (cargarRed) q.dEsperada = dm;
  }
  if (cargarRed) {
    for (const e of aristas) e.cargaEsc = 0;
    ESC.forEach((e, j) => {
      const peso = new Map(T[j]);
      const orden = [...peso.keys()].length ? [...e.R.dist.keys()].sort((a, b) => e.R.dist.get(b) - e.R.dist.get(a)) : [];
      for (const u of orden) {
        const h = peso.get(u); if (!h) continue;
        const eid = e.R.pred.get(u); if (eid === -1 || eid === undefined) continue;
        const a = aristas[eid]; a.cargaEsc += h;
        const v = a.a === u ? a.b : a.a; peso.set(v, (peso.get(v) || 0) + h);
      }
    });
  }
  return { dMedia: Math.round(km * 1000 / n), pctMotor: +(motor / n * 100).toFixed(1), viajes: Math.round(n), km: Math.round(km), porSector };
}
const base = modelo(L_BASE, true);
const sens = SENSIB.map(L => ({ L, ...modelo(L, false) }));
console.log('modelo L =', L_BASE, base.dMedia, 'm medios,', base.pctMotor, '% motorizado;', sens.map(s => `L ${s.L}: ${s.dMedia} m, ${s.pctMotor} %`).join(' | '));

// ----------------------------------------------------------- Por sector
const SECT = ['Centro', 'N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const sectores = SECT.map(s => {
  const L = puntos.filter(q => q.sector === s);
  const ninos = suma(L, q => q.ninos);
  const E = ESC.filter(e => e.sector === s);
  const matricula = suma(E, e => e.estudiantes);
  const salen = SECT.filter(t => t !== s).reduce((a, t) => a + (base.porSector[s + '>' + t] || 0), 0);
  const entran = SECT.filter(t => t !== s).reduce((a, t) => a + (base.porSector[t + '>' + s] || 0), 0);
  const pm = f => ninos ? suma(L, q => f(q) * q.ninos) / ninos : null;
  return {
    id: s, ninos: Math.round(ninos), escuelas: E.length, ee1: E.filter(e => e.norma === 'EE1').length, ee2: E.filter(e => e.norma === 'EE2').length,
    matricula, plazasPorNino: ninos ? +(matricula / ninos).toFixed(2) : null,
    pct400: +(suma(L.filter(q => q.dMin <= RADIO_EE1), q => q.ninos) / ninos * 100).toFixed(1),
    pctEE2: +(suma(L.filter(q => q.dEE2 <= RADIO_EE2), q => q.ninos) / ninos * 100).toFixed(1),
    dMin: Math.round(pm(q => q.dMin)), dEsperada: Math.round(pm(q => q.dEsperada || 0)),
    salen: Math.round(salen), entran: Math.round(entran)
  };
});
console.table(sectores);

// ----------------------------------------------------------- Rejilla
const salidaCeldas = [];
for (const c of celdas.values()) {
  const L = puntos.filter(q => q.k === c.i + ',' + c.j);
  const n = suma(L, q => q.ninos); if (n < 1) continue;
  const x0 = gx0 + c.i * CELDA, y0 = gy0 + c.j * CELDA;
  const esq = [[x0, y0], [x0 + CELDA, y0 + CELDA]].map(([x, y]) => G.utm2wgs(x, y).map(v => +v.toFixed(6)));
  const pm = f => suma(L, q => f(q) * q.ninos) / n;
  salidaCeldas.push({ b: [esq[0][0], esq[0][1], esq[1][0], esq[1][1]], s: sectorDe([x0 + CELDA / 2, y0 + CELDA / 2]),
    ninos: Math.round(n), dMin: Math.round(pm(q => q.dMin)), dEE2: Math.round(pm(q => q.dEE2)), dEsp: Math.round(pm(q => q.dEsperada || 0)) });
}

// ----------------------------------------------------------- Flujos y corredores
const flujos = [];
for (const e of aristas) {
  if (e.cargaEsc < 40 || !nodos.has(e.a) || !nodos.has(e.b)) continue;
  const a = nodos.get(e.a), b = nodos.get(e.b);
  flujos.push([+a.lon.toFixed(5), +a.lat.toFixed(5), +b.lon.toFixed(5), +b.lat.toFixed(5), Math.round(e.cargaEsc)]);
}
const corr = new Map();
for (const e of aristas) if (e.cargaEsc > 0 && e.nombre) corr.set(e.nombre, (corr.get(e.nombre) || 0) + e.cargaEsc * e.len / 1000);
const MERC = LEE('../proximidad/datos.json').corredores.map(c => c.nombre);
const corredores = [...corr].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([nombre, v]) => ({ nombre, estudianteKm: Math.round(v), tambienAbasto: MERC.includes(nombre) }));

// ----------------------------------------------------------- Salida
const ordinaria = URB.filter(x => x.clase !== 'pcei');
const serie = Object.entries(REG.serie).map(([anio, s]) => ({ anio, urbana: Math.round(s.urbana), rural: Math.round(s.rural), instUrbanas: s.instUrbanas,
  // 2022-2023 viene con decimales y un tercio de la matricula: error de la fuente, no dato.
  anomalo: anio === '2022-2023' }));
const out = {
  meta: {
    generado: new Date().toISOString().slice(0, 10), anioLectivo: REG.anio, fuente: REG.fuente,
    poblacion: POB, ninos311: NINOS_3_11, adol1217: ADOL_12_17, edadEscolar: EDAD_ESCOLAR,
    L: L_BASE, umbralPie: UMBRAL_PIE, radioEE1: RADIO_EE1, radioEE2: RADIO_EE2, radioCentro: RADIO_CENTRO,
    centro: G.utm2wgs(...CENTRO).map(v => +v.toFixed(6)),
    instituciones: URB.length, matricula: suma(URB, x => x.estudiantes), matriculaOrdinaria: suma(ordinaria, x => x.estudiantes),
    docentes: suma(URB, x => x.docentes), ubicadas: ESC.length, matriculaUbicada: suma(ESC, e => e.estudiantes)
  },
  porClase: Object.values(URB.reduce((a, x) => { const k = x.clase; a[k] = a[k] || { clase: k, norma: x.norma, n: 0, estudiantes: 0 }; a[k].n++; a[k].estudiantes += x.estudiantes; return a; }, {})),
  porSostenimiento: Object.values(URB.reduce((a, x) => { const k = x.sostenimiento; a[k] = a[k] || { sost: k, n: 0, estudiantes: 0 }; a[k].n++; a[k].estudiantes += x.estudiantes; return a; }, {})),
  ciudad: {
    pct400: +(suma(puntos.filter(q => q.dMin <= RADIO_EE1), q => q.ninos) / EDAD_ESCOLAR * 100).toFixed(1),
    pctEE2: +(suma(puntos.filter(q => q.dEE2 <= RADIO_EE2), q => q.ninos) / EDAD_ESCOLAR * 100).toFixed(1),
    ...base, porSector: undefined
  },
  sensibilidad: sens.map(({ porSector, ...s }) => s),
  sectores, corredores, flujos, celdas: salidaCeldas,
  escuelas: ESC.map(({ R, p, nodo, d0, ...e }) => e),
  sinUbicar: SIN, serie, limite: B.limWGS
};
fs.writeFileSync('datos.json', JSON.stringify(out));
console.log('datos.json', (fs.statSync('datos.json').size / 1024).toFixed(0), 'KB');
console.log(JSON.stringify(out.meta), JSON.stringify(out.ciudad));
console.log(corredores);
