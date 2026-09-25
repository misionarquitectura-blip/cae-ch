// Inyecta datos.json en la plantilla y escribe RESEARCH/educacion.html.
// Mismo patron que proximidad/build.js: la pagina es autocontenida.
//
// Cadena completa:
//   node registro.js                             -> registro_riobamba.json (MINEDUC)
//   node geolocalizar.js  ->  instituciones.json ; node --max-old-space-size=8192 analisis.js -> datos.json
//   node build.js                                     -> ../educacion.html
const fs = require('fs'), path = require('path');
const datos = fs.readFileSync(path.join(__dirname, 'datos.json'), 'utf8');
const tpl = fs.readFileSync(path.join(__dirname, 'plantilla.html'), 'utf8');
const seguro = datos.replace(/<\//g, '<\\/');
const out = tpl.replace('__DATOS__', () => seguro);
const dest = path.join(__dirname, '..', 'educacion.html');
fs.writeFileSync(dest, out);
console.log('escrito ' + dest + '  (' + (out.length / 1024).toFixed(0) + ' KB)');
