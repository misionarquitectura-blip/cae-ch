// Ubica en el mapa las instituciones del registro del MINEDUC, que no trae
// coordenadas. Tres pasos, en orden de confianza:
//   1. ubicaciones_manual.json  (AMIE -> [lon, lat], verificadas por el CAE-Ch)
//   2. nombre contra las escuelas de OpenStreetMap (amenity=school|kindergarten|college)
//   3. Nominatim (geocodificador de OSM), acotado al area urbana; cache en fuentes/
// Lo que no se ubica queda listado en sin_ubicar.json con su matricula.
//
//   node geolocalizar.js  -> instituciones.json, sin_ubicar.json
const fs = require('fs');
const REG = JSON.parse(fs.readFileSync(__dirname + '/registro_riobamba.json', 'utf8')).instituciones.filter(x => x.area === 'Urbana');
const OSM = JSON.parse(fs.readFileSync(__dirname + '/../equipamiento/osm_raw.json', 'utf8')).elements
  .filter(e => e.tags && e.tags.name && /^(school|kindergarten|college)$/.test(e.tags.amenity || ''))
  .map(e => ({ nombre: e.tags.name, c: e.center ? [e.center.lon, e.center.lat] : [e.lon, e.lat], id: e.type + '/' + e.id }));
const MANUAL = fs.existsSync(__dirname + '/ubicaciones_manual.json') ? JSON.parse(fs.readFileSync(__dirname + '/ubicaciones_manual.json', 'utf8')) : {};
const CACHE_F = __dirname + '/fuentes/nominatim.json';
const CACHE = fs.existsSync(CACHE_F) ? JSON.parse(fs.readFileSync(CACHE_F, 'utf8')) : {};

const GENERICAS = new Set(('UNIDAD EDUCATIVA ESCUELA EDUCACION BASICA CENTRO INICIAL COLEGIO BACHILLERATO FISCAL FISCOMISIONAL ' +
  'PARTICULAR MUNICIPAL INTERCULTURAL BILINGUE PCEI ESPECIALIZADA DE LA EL DEL LOS LAS Y SAN SANTA DR DRA GRAL GENERAL ' +
  'SCHOOL UE U E NACIONAL MIXTA INSTITUTO').split(' '));
const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ');
const toks = s => new Set(norm(s).split(/\s+/).filter(t => t && !GENERICAS.has(t) && (t.length > 2 || /\d/.test(t))));
function parecido(a, b) {
  const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0;
  let n = 0; for (const t of A) if (B.has(t)) n++;
  return n / Math.min(A.size, B.size) * (n / Math.max(A.size, B.size)) ** 0.25;
}
// Coincidencias de nombre revisadas a mano y descartadas (AMIE|objeto OSM)
const RECHAZOS = new Set(REG.filter(x => /JOSE MARIA VELAZ/.test(x.nombre)).map(x => x.amie + '|' +
  (OSM.find(o => /Jos. Mar.a Rom.n/i.test(o.nombre)) || {}).id));
const BBOX = [-78.70, -1.70, -78.62, -1.62];
const dentro = ([x, y]) => x > BBOX[0] && x < BBOX[2] && y > BBOX[1] && y < BBOX[3];

(async () => {
  const salida = [], sin = [];
  for (const x of REG) {
    let u = null;
    if (MANUAL[x.amie]) u = { c: MANUAL[x.amie], fuente: 'manual' };
    if (!u) {
      let best = null, bs = 0;
      for (const o of OSM) { const p = parecido(x.nombre, o.nombre); if (p > bs) { bs = p; best = o; } }
      if (best && bs >= 0.6 && !RECHAZOS.has(x.amie + '|' + best.id)) u = { c: best.c, fuente: 'osm', ref: best.id, nombreOSM: best.nombre, score: +bs.toFixed(2) };
    }
    if (!u) {
      const q = [...toks(x.nombre)].join(' ');
      if (!(x.amie in CACHE) && q) {
        const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=3&bounded=1&viewbox=' + [BBOX[0], BBOX[3], BBOX[2], BBOX[1]].join(',') + '&q=' + encodeURIComponent(x.nombre.replace(/PCEI/g, '') + ' Riobamba');
        try {
          const r = await fetch(url, { headers: { 'User-Agent': 'CAE-CH-educacion/1.0 (investigacion urbana, Riobamba)', 'Accept-Language': 'es' } });
          CACHE[x.amie] = r.ok ? await r.json() : [];
        } catch (e) { CACHE[x.amie] = []; }
        await new Promise(r => setTimeout(r, 1100)); // politica de uso de Nominatim: 1 peticion por segundo
      }
      const hit = (CACHE[x.amie] || []).find(h => dentro([+h.lon, +h.lat]) && parecido(x.nombre, h.display_name.split(',')[0]) >= 0.5);
      if (hit) u = { c: [+(+hit.lon).toFixed(6), +(+hit.lat).toFixed(6)], fuente: 'nominatim', nombreOSM: hit.display_name.split(',')[0] };
    }
    if (u) salida.push({ ...x, ...u }); else sin.push(x);
  }
  fs.writeFileSync(CACHE_F, JSON.stringify(CACHE));
  fs.writeFileSync(__dirname + '/instituciones.json', JSON.stringify(salida, null, 1));
  fs.writeFileSync(__dirname + '/sin_ubicar.json', JSON.stringify(sin.sort((a, b) => b.estudiantes - a.estudiantes).map(({ amie, nombre, parroquia, estudiantes, sostenimiento }) => ({ amie, nombre, parroquia, estudiantes, sostenimiento })), null, 1));
  const est = L => L.reduce((a, x) => a + x.estudiantes, 0);
  console.log('ubicadas', salida.length, 'de', REG.length, '| matricula ubicada', est(salida), 'de', est(REG), '(' + (est(salida) / est(REG) * 100).toFixed(1) + ' %)');
  const f = {}; for (const x of salida) f[x.fuente] = (f[x.fuente] || 0) + 1; console.log(f);
  for (const x of salida.filter(x => x.fuente === 'osm' && x.score < 0.8)) console.log('  revisar:', x.nombre, '<->', x.nombreOSM, x.score);
  console.log('sin ubicar (mayores):'); for (const x of sin.slice().sort((a, b) => b.estudiantes - a.estudiantes).slice(0, 25)) console.log('  ', x.estudiantes, x.nombre);
})();
