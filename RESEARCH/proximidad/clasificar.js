// Clasificacion de predios catastrales en categorias de equipamiento segun la
// tipologia del PUGS de Riobamba (EE, ES, EB, EC, ED, ER, EG, EA, EF, ET, EI).
// Se aplica sobre el campo nombre_c (propietario) del Catastro GADMR.

const CATS = {
  EE: { nom: 'Educación',              color: '#2563eb' },
  ES: { nom: 'Salud',                  color: '#dc2626' },
  EB: { nom: 'Bienestar social',       color: '#db2777' },
  EC: { nom: 'Cultural',               color: '#7c3aed' },
  ED: { nom: 'Recreación y deporte',   color: '#16a34a' },
  ER: { nom: 'Religioso / culto',      color: '#a16207' },
  EG: { nom: 'Seguridad y admin. pública', color: '#0f766e' },
  EA: { nom: 'Aprovisionamiento y gremios', color: '#ea580c' },
  EF: { nom: 'Servicios funerarios',   color: '#57534e' },
  ET: { nom: 'Transporte',             color: '#0891b2' },
  EI: { nom: 'Infraestructura y servicios', color: '#65a30d' },
  SM: { nom: 'Suelo municipal (GAD)',   color: '#94a3b8' }
};

// Se descartan explicitamente: comercio privado, vivienda, fideicomisos, hoteles.
const EXCLUIR = [
  /SUPERMERCADO|COMISARIATO/,
  /FIDEICOMISO/,
  /ALBERGUE TURISTICO|HOSTERIA|HOTEL\b/,
  /COOPERATIVA DE VIVIENDA|PROGRAMA DE VIVIENDA|URBANIZACION/,
  /COOP\.? DE TAXIS|COOPERATIVA DE TRANSPORTE|COOP\.? DE TRANSPORTE/,
  /SINDICATO|ASOC\.?(IACION)? DE EMPLEADOS|ASOC\.?PROV|ASO\.? MILITARES|MILITARES, POLICIAS RETIRADOS/,
  /FONDO DE CESANTIA|BANCO\b|COMPA[ÑN]IA|CIA\.? LTDA|SOCIEDAD ANONIMA|S\.?A\.?$/
];

// Reglas ordenadas: la primera que coincide define la categoria.
// El orden importa (p.ej. "COLEGIO DE ARQUITECTOS" es gremio, no educacion).
const REGLAS = [
  // --- Gremios y federaciones profesionales (EA1 del PUGS) ---
  [/COLEGIO DE (ARQUITECTOS|INGENIER|MEDICOS?|ABOGADOS|ENFERMERAS|OBTETRICES|OBSTETRICES|CONTADORES|ODONTOLOG|PERIODISTAS|ECONOMISTAS|VETERINARIOS|QUIMICOS|PSICOLOG)/, 'EA'],
  [/\bCOLEGIO MEDICO\b|COLEGIO ODONTOLOGICO/, 'EA'],
  [/GREMIO DE|FEDERACION (PROVINCIAL|NACIONAL) DE TRABAJADORES|CONFEDERACION DEL MOVIMIENTO|FEDERACION NACIONAL DE CIEGOS/, 'EA'],
  [/MERCADO|CAMAL|FERIA\b|PLAZA DE (GANADO|PRODUCTORES)/, 'EA'],

  // --- Educacion ---
  [/DIRECCION DISTRITAL.*EDUCACION|EDUCACI[ÓO]N.*MINISTERIO DE EDUCACION|MINISTERIO DE EDUCACION/, 'EE'],
  [/UNIVERSIDAD|POLITECNICA|POLIT[ÉE]CNICA|\bESPOCH\b|\bUNACH\b|UNIANDES|SENESCYT/, 'EE'],
  [/UNIDAD EDUCATIVA|\bESCUELA\b|\bCOLEGIO\b|\bLICEO\b|JARD[ÍI]N DE INFANTES|CENTRO EDUCATIV|INSTITUTO (TECNOL[ÓO]GICO|SUPERIOR)|INSTITUTO T[ÉE]CNICO/, 'EE'],
  [/ESCUELAS RADIOFONICAS/, 'EE'],

  // --- Salud ---
  [/HOSPITAL|CENTRO DE SALUD|SUBCENTRO DE SALUD|C\.?\s?SALUD|DISPENSARIO|CL[ÍI]NICA|\bSOLCA\b|CRUZ ROJA|RIOHOSPITAL|METRISA/, 'ES'],
  [/DIRECCION DISTRITAL.*SALUD|COORDINACION ZONAL.*SALUD|MINISTERIO DE SALUD/, 'ES'],
  [/INSTITUTO ECUATORIANO DE SEGURIDAD SOCIAL|\bIESS\b/, 'ES'],

  // --- Bienestar social ---
  [/MINISTERIO DE INCLUSION|MINISTERIO DE DESARROLO HUMANO|MINISTERIO DE DESARROLLO HUMANO|\bMIES\b|\bINFA\b/, 'EB'],
  [/GUARDER[ÍI]A|CENTRO INFANTIL|ORFANATO|ASILO|CASA DE ACOGIDA|ALBERGUE\b|PATRONATO/, 'EB'],
  [/FUNDACION|MISION\b/, 'EB'],

  // --- Cultural ---
  [/CASA DE LA CULTURA|MUSEO|BIBLIOTECA|TEATRO|CENTRO CULTURAL/, 'EC'],

  // --- Recreacion y deporte ---
  [/FEDERACION DEPORTIVA|COMPLEJO DEPORTIVO|ESTADIO|COLISEO|PISCINA|CANCHAS? (DEPORIVAS?|DEPORTIVAS?|DE )|\bCLUB\b|\bPARQUE\b/, 'ED'],

  // --- Religioso ---
  [/\bIGLESIA\b|DIOCESIS|DI[ÓO]CESIS|CURIA|MONASTERIO|CONVENTO|CONGREGACION|SANTUARIO|CAPILLA|MINISTERIO DE AVIVAMIENTO|MINISTERIO DE LA IGLESIA|ASOCIACION INDIGENA DE LA IGLESIA/, 'ER'],

  // --- Seguridad y administracion publica ---
  [/POLIC[ÍI]A|BOMBER|\bUPC\b|ECU\s?911|BRIGADA|MILITAR|EJERCITO|EJ[ÉE]RCITO|FUERZA (AEREA|TERRESTRE|A[ÉE]REA)|MINISTERIO DE DEFENSA|MINISTERIO DEL INTERIOR/, 'EG'],
  [/FISCALIA|FISCAL[ÍI]A|JUDICATURA|CORTE (PROVINCIAL|SUPERIOR)|REGISTRO CIVIL|NOTARIA|\bSRI\b|CENTRO DE DETENCION/, 'EG'],
  // El suelo del GAD Municipal se separa: no es equipamiento en si mismo, es
  // patrimonio de suelo (areas verdes de urbanizacion, reservas, lotes vacantes).
  // Se desagrega mas abajo segun tenga o no construccion y segun los comodatos.
  [/GAD MUNICIPAL DE RIOBAMBA|^MUNICIPIO|I\.? MUNICIPIO/, 'SM'],
  [/GOBIERNO AUTONOMO|GOBIERNO AUT[ÓO]NOMO|PREFECTURA|CONSEJO PROVINCIAL|MINISTERI|DIRECCION DISTRITAL|COORDINACION ZONAL|DIRECCI[ÓO]N GENERAL/, 'EG'],

  // --- Funerario ---
  [/CEMENTERIO|CAMPO SANTO|CAMPOSANTO|FUNERARI|CRIPTA/, 'EF'],

  // --- Transporte ---
  [/TERMINAL|FERROCARRIL|AEROPUERTO|AVIACION CIVIL|AVIACI[ÓO]N CIVIL/, 'ET'],

  // --- Infraestructura y servicios ---
  [/COOPERATIVA DE AHORRO/, null],
  [/EMAPAR|EERSA|CELEC|EMPRESA ELECTRICA|CORPORACION EL[ÉE]CTRICA|\bCNT\b|TELECOMUNICACIONES|ANDINATEL|CORREOS|EMPRESA PUBLICA|\bTANQUES?\b|PLANTA DE TRATAMIENTO|RELLENO SANITARIO/, 'EI']
];

// Cementerio y funerario deben ganar a "IGLESIA" cuando aparecen juntos:
const PRIORIDAD = [
  [/CEMENTERIO|CAMPO SANTO|CRIPTA/, 'EF'],
  [/CENTRO DE SALUD|SUBCENTRO DE SALUD|HOSPITAL/, 'ES'],
  [/\bUPC\b|CUARTEL/, 'EG']
];

function clasificar(nombre) {
  if (!nombre) return null;
  const n = nombre.toUpperCase();
  for (const re of EXCLUIR) if (re.test(n)) return null;
  for (const [re, cat] of PRIORIDAD) if (re.test(n)) return cat;
  for (const [re, cat] of REGLAS) if (re.test(n)) return cat;
  return null;
}

module.exports = { clasificar, CATS };
