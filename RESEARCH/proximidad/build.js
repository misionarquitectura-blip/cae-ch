// Inyecta datos.json en la plantilla y escribe RESEARCH/proximidad.html.
// Mismo patron que economia/build.js: la pagina es autocontenida.
//
// Cadena completa:
//   node osm_red.js                                   -> fuentes/*.json (OSM; no se versiona)
//   node --max-old-space-size=8192 analisis.js        -> datos.json
//   node build.js                                     -> ../proximidad.html
const fs = require('fs'), path = require('path');
// La cobertura del parque barrial es la de la rama 2.3 (RESEARCH/verde), medida
// desde el borde de cada pieza verde y no desde un punto del inventario.
const D = JSON.parse(fs.readFileSync(path.join(__dirname, 'datos.json'), 'utf8'));
const V = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'verde', 'datos.json'), 'utf8'));
const sv = D.servicios.find(s => s.id === 'verde');
sv.cobertura = V.ciudad.pctED1; sv.n = V.piezas.filter(p => p.areaDentro && p.area >= V.meta.ed1.lote).length;
D.ciudad.porServicio.verde = V.ciudad.pctED1;
for (const s of D.sectores) s.porServicio.verde = V.sectores.find(x => x.id === s.id).pctED1;
const datos = JSON.stringify(D);
const tpl = fs.readFileSync(path.join(__dirname, 'plantilla.html'), 'utf8');
const seguro = datos.replace(/<\//g, '<\\/');
const out = tpl.replace('__DATOS__', () => seguro);
const dest = path.join(__dirname, '..', 'proximidad.html');
fs.writeFileSync(dest, out);
console.log('escrito ' + dest + '  (' + (out.length / 1024).toFixed(0) + ' KB)');
