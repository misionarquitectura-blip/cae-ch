// Inventario de la red municipal de mercados y plazas de Riobamba.
//
// Por que no se toma del inventario de la Linea 2: alli el subtipo
// "Mercado barrial/zonal" absorbia toda la categoria EA del PUGS, que tambien
// agrupa a los gremios y colegios profesionales, y contaba 34 "mercados"
// (entre ellos el Colegio de Arquitectos). Aqui se parte de cero:
//   - posicion: OpenStreetMap (amenity=marketplace), bajado con osm_red.js;
//   - existencia, nombre oficial, direccion y giro: prensa local y la ficha de
//     turismo del GADM (La Prensa, 26-01-2026; GoRaymi / Dir. de Turismo GADMR).
// abasto: true si vende alimentos al hogar (sirve al modelo de viajes de abasto).
module.exports = [
  { id: 'merced',     nombre: 'Mercado La Merced (Mariano Borja)',       dir: 'Guayaquil y Cristóbal Colón',           c: [-78.650164, -1.6738438], abasto: true,  osm: 'way/128685451' },
  { id: 'condamine',  nombre: 'C. C. Popular La Condamine',              dir: 'Carabobo y Esmeraldas',                 c: [-78.6563981, -1.6731132], abasto: true, osm: 'way/128525201' },
  { id: 'sanalfonso', nombre: 'Mercado Simón Bolívar (San Alfonso)',     dir: 'Argentinos y 5 de Junio',               c: [-78.6463095, -1.6715082], abasto: true, osm: 'way/252233224', feria: 'lunes, miércoles y sábado' },
  { id: 'sanfco',     nombre: 'Mercado Pedro de Lizarzaburu (San Francisco)', dir: 'Juan de Velasco, entre 10 de Agosto y Primera Constituyente', c: [-78.6470824, -1.6747904], abasto: true, osm: 'way/255867414' },
  { id: 'santarosa',  nombre: 'Mercado Santa Rosa',                      dir: 'Rocafuerte, entre Esmeraldas y Chile',  c: [-78.654105, -1.6726025], abasto: true,  osm: 'node/7498185010' },
  { id: 'davalos',    nombre: 'Mercado General Dávalos',                 dir: 'Nueva York y Vicente Rocafuerte',       c: [-78.648293, -1.6657014], abasto: true,  osm: 'node/13652792901' },
  { id: 'oriental',   nombre: 'Mercado Oriental',                        dir: 'Av. Antonio José de Sucre',             c: [-78.6441176, -1.6661931], abasto: true, osm: 'way/82697413' },
  { id: 'concepcion', nombre: 'Plaza de la Concepción (Plaza Roja)',     dir: 'José de Orozco, entre Juan Larrea y Cristóbal Colón', c: [-78.6480, -1.6712], abasto: true, osm: null, nota: 'posición aproximada (±50 m): no está dibujada en OSM' },
  { id: 'hierbas',    nombre: 'Plaza de las Hierbas',                    dir: 'Otto Arosemena Gómez, junto a la UNACH', c: [-78.6404224, -1.6578631], abasto: true, osm: 'way/851948372' },
  { id: 'mayorista',  nombre: 'Mercado Mayorista San Pedro de Riobamba', dir: 'Av. Leopoldo Freire y Av. Circunvalación', c: [-78.6327137, -1.6859988], abasto: true, osm: 'way/110154625', escala: 'ciudad', nota: 'mayorista: abastece a los demás mercados y también vende al detal' },
  { id: 'esperanza1', nombre: 'Mercado La Esperanza 1',                  dir: 'Av. Antonio José de Sucre y La Esperanza', c: [-78.6415292, -1.661833], abasto: false, osm: 'way/926888804', nota: 'giro no alimentario: segunda mano, ropa, ferretería' },
  { id: 'esperanza2', nombre: 'Mercado La Esperanza 2',                  dir: 'Av. Antonio José de Sucre y La Esperanza', c: [-78.6404455, -1.6607968], abasto: false, osm: 'way/852240553', nota: 'giro no alimentario: segunda mano, ropa, ferretería' }
];
// Un punto que OSM marca como mercado (way/1313964147, sin nombre ni horario) en
// el norte, y "El Prado", que la prensa nombra sin direccion, no se incluyen:
// no hay forma de confirmar que funcionen como mercado de abasto.
module.exports.dudosos = [
  { id: 'norte_osm', nombre: 'Punto «marketplace» sin nombre (OSM)', c: [-78.6628589, -1.6404694], osm: 'way/1313964147' }
];
