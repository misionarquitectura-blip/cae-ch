// Descarga de OpenStreetMap (Overpass) de los espacios verdes, deportivos y plazas, con la
// misma holgura sobre el limite urbano que la red de calles de la rama 2.1: los
// parques del borde (Parque Lineal Chibunga, Ricpamba) quedan fuera del limite
// pero sirven a quien vive dentro. Salida en fuentes/ (no se versiona).
const fs = require('fs');
const BBOX = '-1.7200,-78.7200,-1.6000,-78.6000'; // sur,oeste,norte,este (= proximidad/osm_red.js)
const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  // Overpass rechaza con 406 las peticiones sin User-Agent identificable.
  'User-Agent': 'CAE-CH-areas-verdes/1.0 (analisis de equipamiento, Riobamba)',
  'Accept': 'application/json'
};
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const Q = `[out:json][timeout:180];(
  nwr[leisure~"^(park|garden|playground|recreation_ground|nature_reserve|pitch|track|sports_centre|stadium|swimming_pool)$"](${BBOX});
  nwr[landuse~"^(grass|village_green|recreation_ground|forest)$"](${BBOX});
  nwr[place=square](${BBOX});
);out body geom;`;
(async () => {
  fs.mkdirSync('fuentes', { recursive: true });
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: HEADERS, body: 'data=' + encodeURIComponent(Q) });
      if (!r.ok) { console.log(url, r.status); continue; }
      const j = await r.json();
      fs.writeFileSync('fuentes/verde.json', JSON.stringify(j));
      console.log(j.elements.length, 'elementos desde', url, '·', j.osm3s && j.osm3s.timestamp_osm_base);
      return;
    } catch (e) { console.log(url, e.message); }
  }
  throw new Error('Overpass no respondio');
})();
