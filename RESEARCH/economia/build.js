// Inyecta datos.json en la plantilla y escribe RESEARCH/economia.html.
// Mismo patron que equipamiento/build.js: la pagina publicada es
// autocontenida —lleva sus datos dentro— y no pide nada al servidor.
//
// Cadena completa, dos fuentes independientes:
//   fuentes/*.xlsx (BCE)  --(python extraer_bce.py)-->   datos.json
//   fuentes/*.zip  (INEC) --(python extraer_esed.py)-->  datos_esed.json
//   los dos + plantilla.html  --(node build.js)-->       ../economia.html
const fs = require('fs'), path = require('path');

// El BCE manda: la ESED entra colgada de el, como una clave mas, para que
// la pagina lea un solo objeto.
const datos = JSON.parse(fs.readFileSync(path.join(__dirname, 'datos.json'), 'utf8'));
datos.esed = JSON.parse(fs.readFileSync(path.join(__dirname, 'datos_esed.json'), 'utf8'));
const tpl = fs.readFileSync(path.join(__dirname, 'plantilla.html'), 'utf8');

// El JSON va dentro de <script type="application/json">: solo hay que
// evitar que un "</script>" literal cierre la etiqueta antes de tiempo.
const seguro = JSON.stringify(datos).replace(/<\//g, '<\\/');
const out = tpl.replace('__DATOS__', () => seguro);

const dest = path.join(__dirname, '..', 'economia.html');
fs.writeFileSync(dest, out);
console.log('escrito ' + dest + '  (' + (out.length / 1024).toFixed(0) + ' KB)');
