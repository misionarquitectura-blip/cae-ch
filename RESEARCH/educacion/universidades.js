// Educacion superior en el area urbana de Riobamba: campus y matricula.
//
// La base oficial de matricula de universidades de la SENESCYT ("Base estadistica
// de matricula de UEP 2015-2023", datosabiertos.gob.ec) apunta a un servidor
// (cloud-pro.senescyt.gob.ec) que ya no existe. Las cifras salen de lo que cada
// universidad publica, con la fuente al lado. Los PDF quedan en fuentes/universidades/.
//
// estudiantes: matricula de grado del campus. Los institutos tecnologicos no se
// incluyen: no publican matricula por sede y su peso es menor.
module.exports = [
  { id: 'espoch', nombre: 'ESPOCH — Escuela Superior Politécnica de Chimborazo', campus: 'Matriz (Panamericana Sur km 1½)',
    c: [-78.6802081, -1.6544054], estudiantes: 12145, anio: 2025,
    fuente: 'ESPOCH, Informe preliminar de rendición de cuentas 2025, tabla 7 «Estudiantes regulares matriculados 2025» (campus Matriz)',
    nota: 'La misma tabla da 753 en la sede Orellana y 683 en Morona Santiago, fuera de Riobamba. En 2024 el campus Matriz tenía 14 402.' },
  { id: 'unach_norte', nombre: 'UNACH — Universidad Nacional de Chimborazo', campus: 'Campus Norte «Edison Riera R.» (Av. Antonio José de Sucre km 1½)',
    c: [-78.6425529, -1.6526212], estudiantes: Math.round(10061 * 3 / 4), anio: 2024,
    fuente: 'UNACH en cifras: 10 061 estudiantes matriculados en 2024',
    supuesto: 'La UNACH no publica la matrícula por campus. Se reparte por facultades: tres de cuatro (Ingeniería, Ciencias de la Salud, Ciencias Políticas y Administrativas) funcionan en el Campus Norte.' },
  { id: 'unach_dolorosa', nombre: 'UNACH — Universidad Nacional de Chimborazo', campus: 'Campus La Dolorosa (Av. Eloy Alfaro y 10 de Agosto)',
    c: [-78.6408265, -1.6809887], estudiantes: Math.round(10061 / 4), anio: 2024,
    fuente: 'UNACH en cifras: 10 061 estudiantes matriculados en 2024',
    supuesto: 'Una de cuatro facultades (Ciencias de la Educación, Humanas y Tecnologías).' },
  { id: 'uniandes', nombre: 'UNIANDES — Universidad Regional Autónoma de los Andes', campus: 'Sede Riobamba (Av. José Lizarzaburu 885 y Joaquín Pinto)',
    c: [-78.6695576, -1.6495022], estudiantes: 482, anio: 2025,
    fuente: 'UNIANDES, Rendición de cuentas 2025: estudiantes de grado de la sede Riobamba, octubre 2025 – marzo 2026 (493 en mayo – septiembre 2025)',
    nota: 'El predio de UNIANDES en el norte que registra el catastro (3,3 ha) no es la sede en funcionamiento.' }
];
