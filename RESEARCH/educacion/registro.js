// Extrae del Registro Administrativo Historico del MINEDUC (datos abiertos,
// 2009-2024 "Inicio") las instituciones del canton Riobamba y las clasifica
// segun el Codigo Urbano de Riobamba (Ord. 016-2023, art. 178, tabla 3):
//   EE1 barrial: escolar (nivel basico) y preescolar ........ 400 m
//   EE2 zonal:   colegios, unidades educativas (basico + bachillerato),
//                educacion especial, nivelacion academica .... 2 000 m
// El registro no trae coordenadas ni nivel: el nivel se deduce del nombre
// oficial, que el MINEDUC normaliza ("CENTRO DE EDUCACION INICIAL",
// "ESCUELA DE EDUCACION BASICA", "UNIDAD EDUCATIVA", "COLEGIO DE BACHILLERATO").
//
//   node registro.js   -> registro_riobamba.json
const fs = require('fs');
const L = fs.readFileSync(__dirname + '/fuentes/registro_inicio.csv', 'utf8').split(/\r?\n/);
const H = L[0].replace(/^\uFEFF/, '').split(';');
const I = Object.fromEntries(H.map((k, i) => [k, i]));
const filas = L.slice(1).map(l => l.split(';')).filter(r => r[I.Cod_Canton] === '0601');
const ANIO = '2024-2025 Inicio';

function clase(nombre, tipo) {
  const n = nombre.replace(/\s+/g, ' ');
  if (tipo === 'Educación Especial' || /ESPECIALIZADA/.test(n)) return 'especial';
  if (tipo === 'Popular Permanente' || /\bPCEI\b/.test(n)) return 'pcei';
  if (/^CENTRO DE EDUCACION INICIAL/.test(n)) return 'inicial';
  if (/^ESCUELA DE EDUCACION BASICA/.test(n)) return 'basica';
  if (/^COLEGIO DE BACHILLERATO/.test(n)) return 'bachillerato';
  if (/^UNIDAD EDUCATIVA/.test(n)) return 'unidad';
  return 'sin_dato';
}
const NORMA = { inicial: 'EE1', basica: 'EE1', sin_dato: 'EE1', unidad: 'EE2', bachillerato: 'EE2', pcei: 'EE2', especial: 'EE2' };

const actuales = filas.filter(r => r[I.Anio_lectivo] === ANIO).map(r => {
  const nombre = r[I.Nombre_Institucion].replace(/\s+/g, ' ').trim();
  const cl = clase(nombre, r[I.Tipo_Educacion]);
  return {
    amie: r[I.AMIE], nombre, parroquia: r[I.Parroquia], codParroquia: r[I.Cod_Parroquia],
    area: r[I.Area], tipo: r[I.Tipo_Educacion], sostenimiento: r[I.Sostenimiento],
    clase: cl, norma: NORMA[cl],
    estudiantes: +r[I.Total_Estudiantes] || 0, docentes: +r[I.Total_Docentes] || 0
  };
});

// Serie historica de matricula (urbana y rural) para ver la tendencia
const serie = {};
for (const r of filas) {
  const a = r[I.Anio_lectivo].replace(' Inicio', ''), z = r[I.Area] === 'Urbana' ? 'urbana' : 'rural';
  serie[a] = serie[a] || { urbana: 0, rural: 0, instUrbanas: 0, instRurales: 0 };
  serie[a][z] += +r[I.Total_Estudiantes] || 0;
  serie[a][z === 'urbana' ? 'instUrbanas' : 'instRurales']++;
}
const out = {
  fuente: 'MINEDUC, Registro Administrativo Histórico 2009-2024 (Inicio), datosabiertos.gob.ec',
  anio: ANIO, instituciones: actuales, serie
};
fs.writeFileSync(__dirname + '/registro_riobamba.json', JSON.stringify(out, null, 1));
const urb = actuales.filter(x => x.area === 'Urbana');
const suma = (L, f) => L.reduce((a, x) => a + f(x), 0);
console.log('canton', actuales.length, 'instituciones; urbanas', urb.length, 'con', suma(urb, x => x.estudiantes), 'estudiantes');
const t = {}; for (const x of urb) { const k = x.norma + ' ' + x.clase; t[k] = t[k] || [0, 0]; t[k][0]++; t[k][1] += x.estudiantes; }
console.table(t);
console.log(Object.entries(serie).map(([a, s]) => a + ' urb ' + s.urbana + ' rur ' + s.rural).join('\n'));
