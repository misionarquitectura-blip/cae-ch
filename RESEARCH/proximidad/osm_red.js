// Descarga de OpenStreetMap (Overpass) de lo que el catastro no trae:
//  1. la red de calles, para medir distancias por calle y no en linea recta;
//  2. los mercados y ferias (amenity=marketplace), para completar el inventario;
//  3. las lineas de bus urbano (relaciones route=bus) y sus paradas.
// Salida cruda en fuentes/ (no se versiona: se vuelve a bajar con este script).
const fs = require('fs');
const BBOX = '-1.7200,-78.7200,-1.6000,-78.6000'; // sur,oeste,norte,este: holgura sobre el limite urbano
const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  // Overpass rechaza con 406 las peticiones sin User-Agent identificable.
  'User-Agent': 'CAE-CH-proximidad/1.0 (analisis de equipamiento y movilidad, Riobamba)',
  'Accept': 'application/json'
};
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const CONSULTAS = {
  calles: `[out:json][timeout:240];way[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|footway|path|steps|track|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${BBOX});out body geom;`,
  mercados: `[out:json][timeout:120];(nwr[amenity=marketplace](${BBOX});nwr[name~"[Mm]ercado|[Ff]eria|[Pp]laza de (ganado|productores|hierba)|[Cc]amal"](${BBOX}););out center tags;`,
  buses: `[out:json][timeout:240];relation[route=bus](${BBOX});out geom tags;`
};
async function bajar(nombre, q) {
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: HEADERS, body: 'data=' + encodeURIComponent(q) });
      if (!r.ok) { console.log(nombre, url, r.status); continue; }
      const j = await r.json();
      fs.writeFileSync(`fuentes/${nombre}.json`, JSON.stringify(j));
      console.log(nombre, j.elements.length, 'elementos desde', url);
      return;
    } catch (e) { console.log(nombre, url, e.message); }
  }
  throw new Error('Overpass no respondio para ' + nombre);
}
(async () => { for (const [n, q] of Object.entries(CONSULTAS)) if (!process.argv[2] || process.argv.includes(n)) await bajar(n, q); })();
