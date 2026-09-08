# -*- coding: utf-8 -*-
# Lee los dos xlsx de Cuentas Regionales del BCE que estan en fuentes/ y
# escribe datos.json, que build.js incrusta en la pagina.
#
# Por que Python y no Node, como el resto de RESEARCH: los xlsx del BCE hay
# que abrirlos, y el proyecto no tiene ninguna libreria de Excel instalada.
# xlsxlee.py los lee con la stdlib (un xlsx es un ZIP con XML dentro), asi
# que no hace falta instalar nada. Del paso xlsx -> JSON en adelante todo
# sigue siendo Node, igual que en equipamiento/.
import json, os
from xlsxlee import hojas, leer

AQUI = os.path.dirname(os.path.abspath(__file__))
F_PC   = os.path.join(AQUI, 'fuentes', 'vab_percapita_2018_2024.xlsx')
F_CIIU = os.path.join(AQUI, 'fuentes', 'vab_cantonal_ciiu_2024.xlsx')

ANIOS = [2018, 2019, 2020, 2021, 2022, 2023, 2024]

# Deflactor implicito del PIB del Ecuador, base 2018 = 100. El VAB cantonal
# del BCE viene SOLO a precios corrientes: sin deflactar, la serie mezcla
# crecimiento real con inflacion y no se puede responder "crece o decrece".
# Fuente: Banco Mundial NY.GDP.DEFL.ZS (que reproduce las cuentas del BCE).
DEFLACTOR = {2018: 100.0, 2019: 99.943425741609, 2020: 98.1185022310992,
             2021: 100.252328535952, 2022: 102.606321817056,
             2023: 104.802396916748, 2024: 109.54318464835}

# Las nueve capitales de provincia de la Sierra, mas Riobamba. Es el peloton
# real del canton: ciudades intermedias andinas con la misma funcion
# administrativa y universitaria. Quito y Cuenca entran como techo.
CAPITALES = {
    '1701': 'Quito',     '0101': 'Cuenca',    '1801': 'Ambato',
    '1101': 'Loja',      '1001': 'Ibarra',    '0501': 'Latacunga',
    '0601': 'Riobamba',  '0301': 'Azogues',   '0401': 'Tulcán',
    '0201': 'Guaranda',
}
RIOBAMBA = '0601'

# --------------------------------------------------------- 1. VAB per capita
# Layout de la hoja "VAB per cápita cantonal": 4 columnas de identificacion y
# luego cuatro bloques de 7 anios separados por una columna vacia (VAB en
# miles de USD, poblacion, VAB per capita, tasas de variacion).
COL_VAB, COL_POB, COL_PC = 4, 12, 20

def num(v):
    try: return float(v)
    except (TypeError, ValueError): return None

nom, ruta = hojas(F_PC)[3]
cantones = []
for f in leer(F_PC, ruta)[3:]:
    if len(f) < 27 or not f[2] or not f[3]:
        continue
    vab = [num(f[COL_VAB + i]) for i in range(7)]
    pob = [num(f[COL_POB + i]) for i in range(7)]
    if any(v is None for v in vab) or any(p is None for p in pob):
        continue
    cantones.append({
        'codigo': f[2].strip(), 'canton': f[3].strip(),
        'provincia': f[1].strip().title(),
        # El VAB llega en miles de USD; se pasa a USD para poder dividirlo
        # por la poblacion sin arrastrar el factor mil por todo el calculo.
        'vab': [v * 1000 for v in vab], 'pob': pob,
    })

if len(cantones) != 221:
    raise SystemExit('Se esperaban 221 cantones, se leyeron %d' % len(cantones))

def per_capita(c):
    return [c['vab'][i] / c['pob'][i] for i in range(7)]

def real(serie):
    """Pasa una serie corriente a dolares constantes de 2018."""
    return [serie[i] / (DEFLACTOR[ANIOS[i]] / 100.0) for i in range(7)]

for c in cantones:
    c['pc'] = per_capita(c)
    c['pcReal'] = real(c['pc'])

# --------------------------------------------------------- 2. Nacional
# Promedio ponderado (VAB total del pais / poblacion total), no promedio de
# los 221 cantones: ese ultimo daria el mismo peso a Quito que a Oña.
nac_vab = [sum(c['vab'][i] for c in cantones) for i in range(7)]
nac_pob = [sum(c['pob'][i] for c in cantones) for i in range(7)]
nac_pc  = [nac_vab[i] / nac_pob[i] for i in range(7)]

# --------------------------------------------------------- 3. Ranking
# Puesto de cada canton en el pais, anio por anio (1 = el mas alto).
rank = {}
for i in range(7):
    orden = sorted(cantones, key=lambda c: c['pc'][i], reverse=True)
    for pos, c in enumerate(orden, 1):
        rank.setdefault(c['codigo'], []).append(pos)

# --------------------------------------------------------- 4. Sectores CIIU
nom, ruta = hojas(F_CIIU)[3]
filas = leer(F_CIIU, ruta)
# Fila 2 = encabezados; columnas 4..17 son las 14 secciones y 18 el total.
SECCIONES = [filas[2][4 + i] for i in range(14)]
sectores = {}
for f in filas[3:]:
    if len(f) < 19 or not f[2] or not f[3]:
        continue
    vals = [num(f[4 + i]) or 0.0 for i in range(14)]
    sectores[f[2].strip()] = [v * 1000 for v in vals]   # miles -> USD

# --------------------------------------------------------- 5. Salida
def bloque(c):
    return {
        'codigo': c['codigo'], 'canton': c['canton'], 'provincia': c['provincia'],
        'pob': c['pob'],
        'pc': [round(v, 2) for v in c['pc']],
        'pcReal': [round(v, 2) for v in c['pcReal']],
        'vab': [round(v) for v in c['vab']],
        'rank': rank[c['codigo']],
        'sectores': [round(v) for v in sectores.get(c['codigo'], [0] * 14)],
    }

por_codigo = {c['codigo']: c for c in cantones}
salida = {
    'meta': {
        'fuente': 'Banco Central del Ecuador, Cuentas Nacionales Regionales',
        'archivos': ['VAB_PerCapita_CNRC_2018_2024p_publicación_val.xlsx',
                     'corrientes_2024_cant_p.xlsx'],
        'url': 'https://contenido.bce.fin.ec/documentos/informacioneconomica/cuentasnacionales/regionales/',
        'descargado': '2026-09-08',
        'anios': ANIOS,
        'provisional': [2024],
        'deflactor': DEFLACTOR,
        'fuenteDeflactor': 'Deflactor implícito del PIB, base 2018=100 (Banco Mundial NY.GDP.DEFL.ZS, sobre cuentas del BCE)',
        'cantones': len(cantones),
        'secciones': SECCIONES,
    },
    'riobamba': bloque(por_codigo[RIOBAMBA]),
    'capitales': [bloque(por_codigo[k]) for k in CAPITALES
                  if k in por_codigo],
    'nacional': {
        'pc': [round(v, 2) for v in nac_pc],
        'pcReal': [round(v, 2) for v in real(nac_pc)],
        'pob': [round(p) for p in nac_pob],
        'vab': [round(v) for v in nac_vab],
    },
    # Los 221 cantones con lo minimo para dibujar el ranking nacional.
    'todos': [{'codigo': c['codigo'], 'canton': c['canton'],
               'provincia': c['provincia'],
               'pc': round(c['pc'][6], 2), 'pob': c['pob'][6],
               'rank': rank[c['codigo']][6]} for c in cantones],
}

destino = os.path.join(AQUI, 'datos.json')
with open(destino, 'w', encoding='utf-8') as fh:
    json.dump(salida, fh, ensure_ascii=False)
print('escrito %s (%.0f KB)' % (destino, os.path.getsize(destino) / 1024))
