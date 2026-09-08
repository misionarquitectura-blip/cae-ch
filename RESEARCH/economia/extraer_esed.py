# -*- coding: utf-8 -*-
# Lee los microdatos de Estadisticas de Edificaciones (ESED) del INEC que
# estan en fuentes/ y escribe datos_esed.json, que build.js incrusta en la
# pagina junto a datos.json.
#
# Por que hace falta: la serie del BCE mide VALOR PRODUCIDO y llega hasta
# 2024. La ESED mide OBRA AUTORIZADA —permisos aprobados por el municipio—
# y llega hasta 2025. Son dos fuentes independientes que se pueden
# contrastar, y ninguna de las dos depende de la otra.
#
# Lo importante del archivo: el zip anual de datos abiertos de 2025 trae
# DENTRO los de 2022 y 2023, asi que de una sola descarga salen tres anios
# a nivel de CANTON. 2024 no viene: su microdato solo esta en el catalogo
# ANDA, que no expone una ruta publica estable. La pagina lo dice.
import json, os, io, csv, zipfile, collections

AQUI = os.path.dirname(os.path.abspath(__file__))
ZIP = os.path.join(AQUI, 'fuentes', 'esed_2025_datos_abiertos.zip')

RIOBAMBA, CHIMBORAZO = '0601', '06'
ANIOS = [2022, 2023, 2025]
FALTA = 2024

# Unico dato que no sale del microdato: los permisos de Chimborazo en 2024,
# leidos del visualizador ESED del INEC. Se guarda aparte y rotulado, para
# que nunca se confunda con lo calculado.
CHIMBORAZO_2024_VISUALIZADOR = 498


def leer_bdd(anio):
    """Saca el CSV de un anio del zip anidado de datos abiertos."""
    z = zipfile.ZipFile(ZIP)
    nombres = [n for n in z.namelist() if str(anio) in n]
    if not nombres:
        raise SystemExit('No hay microdato de %s en %s' % (anio, ZIP))
    interno = zipfile.ZipFile(io.BytesIO(z.read(nombres[0])))
    csvs = [n for n in interno.namelist() if n.lower().endswith('.csv')]
    texto = interno.read(csvs[0]).decode('utf-8-sig')
    return list(csv.DictReader(io.StringIO(texto), delimiter=';'))


def num(v):
    try:
        return float(str(v).replace(',', '.'))
    except (TypeError, ValueError):
        return 0.0


def resumir(filas):
    """Una fila = un permiso de construccion aprobado. Las magnitudes
       fisicas (edificaciones, viviendas, m2) se suman; el valor se deja
       NOMINAL a proposito: el deflactor del PIB que usa el resto de la
       pagina llega hasta 2024 y no cubre 2025."""
    return {
        'permisos':      len(filas),
        'edificaciones': round(sum(num(f['CPERM']) for f in filas)),
        'viviendas':     round(sum(num(f['CNUVICAL']) for f in filas)),
        'area':          round(sum(num(f['CARCO']) for f in filas)),
        'areaRes':       round(sum(num(f['CARES']) for f in filas)),
        'areaNoRes':     round(sum(num(f['CARNRES']) for f in filas)),
        'valor':         round(sum(num(f['CVAE']) for f in filas)),
    }


riobamba, chimborazo, nacional, cantones2025 = [], [], [], []
for anio in ANIOS:
    filas = leer_bdd(anio)
    if not filas:
        raise SystemExit('El microdato de %s vino vacio' % anio)
    ch = [f for f in filas if f['codprovf'].strip() == CHIMBORAZO]
    rb = [f for f in ch if f['codcantf'].strip() == RIOBAMBA]
    if not rb:
        raise SystemExit('No se encontro el canton %s en %s' % (RIOBAMBA, anio))
    riobamba.append(resumir(rb))
    chimborazo.append(resumir(ch))
    nacional.append(resumir(filas))
    if anio == ANIOS[-1]:
        # Los diez cantones de Chimborazo en el ultimo anio, para mostrar
        # cuanto de la provincia es la cabecera.
        por_canton = collections.defaultdict(list)
        for f in ch:
            por_canton[f['codcantf'].strip()].append(f)
        cantones2025 = sorted(
            ({'codigo': c, 'permisos': len(fs),
              'viviendas': round(sum(num(f['CNUVICAL']) for f in fs))}
             for c, fs in por_canton.items()),
            key=lambda x: -x['permisos'])

salida = {
    'meta': {
        'fuente': 'Instituto Nacional de Estadística y Censos, Estadísticas de Edificaciones (ESED)',
        'archivo': 'datos_abiertos.zip (anual 2025, que contiene los microdatos de 2022, 2023 y 2025)',
        'url': 'https://www.ecuadorencifras.gob.ec/edificaciones/',
        'licencia': 'CC-BY-4.0',
        'descargado': '2026-09-08',
        'anios': ANIOS,
        'anioFaltante': FALTA,
        'unidad': 'Una fila del microdato = un permiso de construcción aprobado por el GAD municipal.',
        'chimborazo2024Visualizador': CHIMBORAZO_2024_VISUALIZADOR,
    },
    'riobamba': riobamba,
    'chimborazo': chimborazo,
    'nacional': nacional,
    'cantonesChimborazo': cantones2025,
}

destino = os.path.join(AQUI, 'datos_esed.json')
with open(destino, 'w', encoding='utf-8') as fh:
    json.dump(salida, fh, ensure_ascii=False)

print('escrito %s (%.0f KB)' % (destino, os.path.getsize(destino) / 1024))
for i, a in enumerate(ANIOS):
    r, c = riobamba[i], chimborazo[i]
    print('  %d  Riobamba: %4d permisos, %5d viviendas, %8d m2  (%.1f %% de Chimborazo)'
          % (a, r['permisos'], r['viviendas'], r['area'],
             r['permisos'] / c['permisos'] * 100))
