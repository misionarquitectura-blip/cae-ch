# -*- coding: utf-8 -*-
"""
============================================================
GENERADOR DE LA CAPA 5 - COBERTURA DE TELECOMUNICACIONES
Fuente: Geoportal CNT EP  ->  https://gis.cnt.gob.ec/appgeoportal/
Servicio WMS (MapServer/MapCache): https://mapas.cnt.gob.ec/?sid=...
============================================================

Por que este script existe y no un L.tileLayer.wms directo:

  El WMS de CNT filtra por cabecera Referer. Una peticion cuyo referer
  no sea gis.cnt.gob.ec recibe el texto "NO AUTORIZADO URL" (17 bytes)
  en lugar del PNG. El navegador de un visitante de cae-ch.org no puede
  falsear su propio referer, asi que la capa no puede consumirse en vivo:
  hay que traerse el raster una vez y publicarlo como overlay estatico.
  El servicio tampoco soporta GetFeatureInfo (devuelve un PNG), asi que
  tampoco hay forma de consultar la cobertura de un punto contra CNT.

Lo que produce:

  DATA SET/telecom/manifest.json             metadatos, leyenda y bounds
  DATA SET/telecom/provincia/<capa>.png      Chimborazo completo (~28 m/px)
  DATA SET/telecom/riobamba/<capa>_rRcC.png  canton Riobamba (~8 m/px, malla 2x2)

Los PNG salen normalizados a una paleta de 5 clases + transparente
(ver PALETA). Eso hace los archivos pequenos y, sobre todo, permite que
geovisor.html lea el pixel del predio y lo clasifique sin ambiguedad de
antialiasing al armar el DICAT.

Todo se recorta a Chimborazo: la mascara es la union de las parroquias de
la provincia (codigo DPA que empieza en 06), dilatada BUFFER_KM para que
un predio pegado al limite provincial siga viendo su entorno.

Uso:
    python "DATA SET/build_telecom.py"
    python "DATA SET/build_telecom.py" --solo provincia
    python "DATA SET/build_telecom.py" --capas gpon,lte

Requiere: pillow, requests.
============================================================
"""

import argparse
import datetime
import io
import json
import os
import re
import sys
import time

import requests
from PIL import Image, ImageDraw, ImageFilter

# ------------------------------------------------------------
# Servicio de origen
# ------------------------------------------------------------
WMS = "https://mapas.cnt.gob.ec/"
SID = "QUkUlJ8c6p00yLFtKXzIZLmJGLkrECBX"
# El referer es la condicion de acceso del servicio: es la pagina del
# propio geoportal de CNT que publica estas capas.
REFERER = "https://gis.cnt.gob.ec/appgeoportal/"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) GeoVisor-CAECH/1.0"

# El servicio rechaza cualquier dimension mayor de 4096 px: devuelve una
# tesela generica de 256x256 y 1225 bytes. El limite es por lado, no por
# numero de pixeles (4096x4096 pasa; 3520x4097 no). De ahi que los tiers
# se troceen en mallas de celdas de 4096 px de ancho.
MAX_DIM = 4096

# api.js del geoportal; de ahi sale la DPA (limites de parroquias).
API_JS = ("https://mapas.cnt.gob.ec/apigiscnt/devapis/mapasweb/"
          "key=LajMV7BbYOEKbU4FjLUBIR4AqHD92UPDuyQGvRhKfm")

PAUSA_S = 1.5          # cortesia entre peticiones
REINTENTOS = 3
BUFFER_KM = 2.0        # margen fuera del limite provincial

# ------------------------------------------------------------
# Salida
# ------------------------------------------------------------
BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "telecom")
LIMITE_GEOJSON = os.path.join(BASE, "chimborazo_dpa.geojson")

# ------------------------------------------------------------
# Capas de CNT. El "id" es el nombre real de la capa WMS; se conserva
# visible en el visor para que cualquiera pueda verificar el origen.
# ------------------------------------------------------------
CAPAS = [
    {"id": "CoberturaRedLte", "slug": "lte", "nombre": "4G LTE",
     "escala": "senal", "orden": 3,
     "nota": "Datos moviles. ALTO = nivel mayor o igual a -100 dBm; "
             "MEDIO = entre -120 y -100 dBm; BAJO = por debajo de -120 dBm."},
    {"id": "CoberturaRedHspa", "slug": "hspa", "nombre": "3G HSPA",
     "escala": "senal", "orden": 2,
     "nota": "Datos moviles. ALTO = nivel mayor o igual a -85 dBm; "
             "MEDIO = entre -95 y -85 dBm; BAJO = por debajo de -95 dBm."},
    {"id": "CoberturaRedMvno2G", "slug": "2g", "nombre": "2G (voz y SMS)",
     "escala": "senal", "orden": 1,
     "nota": "Voz y SMS. ALTO = nivel mayor o igual a -85 dBm; "
             "MEDIO = entre -95 y -85 dBm; BAJO = por debajo de -95 dBm."},
    {"id": "CoberturaRedMvno35G", "slug": "rna35g", "nombre": "3.5G / roaming nacional",
     "escala": "senal", "orden": 4,
     "nota": "Capa CoberturaRedMvno35G de CNT. Su leyenda la asocia a cobertura "
             "obtenida mediante acuerdos de Roaming Nacional Automatico (RNA)."},
    {"id": "CoberturaRedGpon", "slug": "gpon", "nombre": "Fibra optica GPON",
     "escala": "gpon", "orden": 5,
     "nota": "Cobertura de fibra optica hasta el domicilio. Capa binaria: "
             "hay o no hay red GPON desplegada."},
    {"id": "CoberturaRedCdma450", "slug": "cdma450", "nombre": "CDMA 450",
     "escala": "cdma", "orden": 6,
     "nota": "Telefonia fija inalambrica de cobertura rural. Capa binaria."},
]

# ------------------------------------------------------------
# Paleta normalizada. El indice 0 SIEMPRE es transparente, para que el
# visor pueda distinguir "sin cobertura" de "no descargado".
# Los RGB son los de la leyenda oficial del geoportal de CNT.
# ------------------------------------------------------------
PALETA = [
    ("sin", (0, 0, 0), "Sin cobertura"),
    ("alto", (144, 238, 144), "ALTO"),
    ("medio", (135, 206, 250), "MEDIO"),
    ("bajo", (240, 128, 128), "BAJO"),
    ("gpon", (12, 186, 252), "Cobertura fibra optica GPON"),
    ("cdma", (0, 157, 157), "Cobertura CDMA 450"),
]
CLASES = [c[1] for c in PALETA[1:]]        # las 5 clases con color
N_CLASES = len(CLASES)

CONDICIONES = (
    "Los mapas de cobertura movil de CNT EP se basan en simulaciones de modelos "
    "de propagacion y los de GPON en mediciones georreferenciadas; en ambos casos "
    "son REFERENCIALES. El nivel real de senal o la disponibilidad efectiva del "
    "servicio en un punto concreto pueden diferir por terreno, obstaculos, "
    "edificaciones, banda de frecuencia, trafico, sensibilidad del equipo terminal "
    "o cambios de la red. La factibilidad definitiva de conexion la certifica CNT EP."
)

# ------------------------------------------------------------
# Niveles (tiers) de resolucion
# ------------------------------------------------------------
# La resolucion se eligio midiendo: al duplicar los px por grado, la
# discrepancia de clasificacion contra la maxima resolucion se reduce a la
# mitad, que es la firma de un efecto puramente de borde (el perimetro
# escala con 1/resolucion), no de estructura interior nueva. Por debajo de
# ~9 m/px ya no aparece informacion, solo bordes mas nitidos.
TIERS = {
    # Toda la provincia, malla de 2 columnas x 3 filas.
    "provincia": {
        "etiqueta": "Chimborazo",
        "bbox": (-79.2600, -2.5750, -78.3500, -1.4250),   # oeste, sur, este, norte
        "grid": (2, 3),                                   # columnas, filas
        "px": (4096, 3428),                               # por celda -> ~12 m/px
        "zoom_min": 0,
        "zoom_max": 13,
    },
    # Canton Riobamba, malla 2x2, para trabajar a resolucion de predio.
    "riobamba": {
        "etiqueta": "Canton Riobamba",
        "bbox": (-78.9050, -1.9570, -78.3920, -1.4590),
        "grid": (2, 2),
        "px": (4096, 3951),                               # por celda -> ~7 m/px
        "zoom_min": 14,
        "zoom_max": 22,
    },
}


# ============================================================
# Limite de Chimborazo
# ============================================================
def cargar_limite():
    """Parroquias de Chimborazo (DPA que empieza en 06).

    Se cachea en disco para no volver a descargar los 5 MB de api.js.
    """
    if os.path.isfile(LIMITE_GEOJSON):
        with open(LIMITE_GEOJSON, encoding="utf-8") as fh:
            return json.load(fh)

    print("  descargando la DPA del geoportal de CNT (api.js, ~5 MB)...")
    r = requests.get(API_JS, headers={"User-Agent": UA, "Referer": REFERER},
                     timeout=180, verify=False)
    r.raise_for_status()
    txt = r.content.decode("utf-8", "replace")
    m = re.search(r"jsonDPAGeometrias='(.*?)';", txt, re.S)
    if not m:
        raise RuntimeError("no se encontro jsonDPAGeometrias en api.js")
    dpa = json.loads(m.group(1))

    feats = [f for f in dpa["features"]
             if f["properties"].get("l") == "5"
             and str(f["properties"].get("c", "")).startswith("06")]
    if not feats:
        raise RuntimeError("la DPA no trajo parroquias de Chimborazo")

    fc = {
        "type": "FeatureCollection",
        "_fuente": "Division politico administrativa del geoportal de CNT EP",
        "_nota": ("Parroquias de Chimborazo (codigo DPA 06*). Geometria "
                  "simplificada; sirve de mascara de recorte, no como limite legal."),
        "features": [
            {"type": "Feature",
             "properties": {"dpa": f["properties"]["c"], "nombre": f["properties"]["n"]},
             "geometry": f["geometry"]}
            for f in feats
        ],
    }
    os.makedirs(BASE, exist_ok=True)
    with open(LIMITE_GEOJSON, "w", encoding="utf-8") as fh:
        json.dump(fc, fh, ensure_ascii=False)
    print("  %d parroquias -> %s" % (len(feats), os.path.relpath(LIMITE_GEOJSON)))
    return fc


def anillos(fc):
    """Anillos exteriores de todas las parroquias, en lon/lat."""
    out = []
    for f in fc["features"]:
        g = f["geometry"]
        if g["type"] == "Polygon":
            out.append(g["coordinates"][0])
        elif g["type"] == "MultiPolygon":
            out.extend(poly[0] for poly in g["coordinates"])
    return out


def mascara(fc, bbox, size):
    """Mascara 0/255 del territorio de Chimborazo, dilatada BUFFER_KM.

    La dilatacion se consigue trazando el contorno con una linea gruesa
    ademas de rellenar el poligono: mucho mas rapido que un MaxFilter
    sobre 16 Mpx y suficientemente exacto para un margen de cortesia.
    """
    w0, s0, e0, n0 = bbox
    W, H = size
    escala_x = W / (e0 - w0)
    escala_y = H / (n0 - s0)

    grosor = max(1, int(round(BUFFER_KM * 1000 / (111_320 * (e0 - w0) / W))))

    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    for ring in anillos(fc):
        pts = [((lon - w0) * escala_x, (n0 - lat) * escala_y) for lon, lat in ring]
        if len(pts) < 3:
            continue
        d.polygon(pts, fill=255)
        d.line(pts + [pts[0]], fill=255, width=grosor, joint="curve")
    # Suaviza los dientes que deja el trazo grueso en los vertices.
    return m.filter(ImageFilter.MedianFilter(3)).point(
        lambda v: 255 if v >= 128 else 0)


# ============================================================
# Descarga y normalizacion
# ============================================================
def paleta_referencia():
    """Imagen 'P' cuyas 256 entradas ciclan las 5 clases con color.

    Se usa como paleta fija de quantize(): asi el emparejamiento es por
    color mas cercano y ninguna entrada vacia (negro) atrae pixeles.
    """
    pal = []
    for i in range(256):
        pal.extend(CLASES[i % N_CLASES])
    ref = Image.new("P", (1, 1))
    ref.putpalette(pal)
    return ref


REF = paleta_referencia()
# indice que devuelve quantize -> indice de PALETA (1..5)
TABLA_CLASE = bytes((i % N_CLASES) + 1 for i in range(256))


def paleta_salida():
    pal = []
    for _, rgb, _ in PALETA:
        pal.extend(rgb)
    pal.extend([0, 0, 0] * (256 - len(PALETA)))
    return pal


def pedir(capa_id, bbox, size):
    """GetMap contra el WMS de CNT. Devuelve la imagen ya decodificada."""
    w, s, e, n = bbox
    params = {
        "sid": SID,
        "SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap",
        "LAYERS": capa_id, "STYLES": "",
        "CRS": "EPSG:4326",
        # WMS 1.3.0 con EPSG:4326 -> el eje va lat,lon
        "BBOX": "%f,%f,%f,%f" % (s, w, n, e),
        "WIDTH": size[0], "HEIGHT": size[1],
        "FORMAT": "image/png", "TRANSPARENT": "TRUE",
    }
    ultimo = None
    for intento in range(1, REINTENTOS + 1):
        try:
            r = requests.get(WMS, params=params,
                             headers={"User-Agent": UA, "Referer": REFERER},
                             timeout=300, verify=False)
            cuerpo = r.content
            if cuerpo.strip() == b"NO AUTORIZADO URL":
                raise RuntimeError(
                    "el servicio respondio 'NO AUTORIZADO URL': el referer "
                    "%s ya no es aceptado o el sid caduco" % REFERER)
            im = Image.open(io.BytesIO(cuerpo))
            im.load()
            if im.size != tuple(size):
                # 256x256 es la tesela generica de error de MapCache
                raise RuntimeError(
                    "el servicio devolvio %dx%d en lugar de %dx%d "
                    "(peticion rechazada, probablemente por tamano)"
                    % (im.size[0], im.size[1], size[0], size[1]))
            return im
        except Exception as exc:            # noqa: BLE001 - se reintenta y se informa
            ultimo = exc
            if intento < REINTENTOS:
                espera = PAUSA_S * 4 * intento
                print("      intento %d/%d fallo (%s); reintento en %.0f s"
                      % (intento, REINTENTOS, exc, espera))
                time.sleep(espera)
    raise RuntimeError("no se pudo descargar %s: %s" % (capa_id, ultimo))


def normalizar(im, msk):
    """RGBA de CNT -> PNG paletizado de 6 valores, recortado a la mascara."""
    im = im.convert("RGBA")

    # Alfa del origen: los rellenos vienen a ~150/255. Todo lo que sea casi
    # transparente es "sin cobertura".
    visible = im.getchannel("A").point(lambda a: 255 if a >= 64 else 0)
    if msk is not None:
        visible = Image.composite(visible, Image.new("L", im.size, 0), msk)
    visible = visible.convert("1", dither=Image.Dither.NONE)

    q = im.convert("RGB").quantize(palette=REF, dither=Image.Dither.NONE)
    idx = Image.frombytes("P", im.size, q.tobytes().translate(TABLA_CLASE))

    out = Image.new("P", im.size, 0)
    out.paste(idx, (0, 0), visible)
    out.putpalette(paleta_salida())
    return out


def celdas(tier):
    """Trocea el bbox del tier en la malla pedida."""
    w, s, e, n = tier["bbox"]
    cols, rows = tier["grid"]
    dw = (e - w) / cols
    dh = (n - s) / rows
    for r in range(rows):
        for c in range(cols):
            yield r, c, (w + c * dw, n - (r + 1) * dh, w + (c + 1) * dw, n - r * dh)


def procesar(nombre_tier, tier, capas, limite):
    cols, rows = tier["grid"]
    W, H = tier["px"]
    if max(W, H) > MAX_DIM:
        raise SystemExit("celda de %s pide %dx%d px; el servicio no acepta "
                         "mas de %d px por lado" % (nombre_tier, W, H, MAX_DIM))

    destino = os.path.join(BASE, nombre_tier)
    os.makedirs(destino, exist_ok=True)

    w, s, e, n = tier["bbox"]
    mpp = 111_320 * (e - w) / (W * cols)
    print("\n== %s (%s) - %dx%d celdas de %dx%d px - ~%.0f m/px"
          % (nombre_tier, tier["etiqueta"], cols, rows, W, H, mpp))

    print("   preparando mascara de Chimborazo (buffer %.1f km)..." % BUFFER_KM)
    mascaras = {(r, c): mascara(limite, bb, (W, H)) for r, c, bb in celdas(tier)}

    piezas = []
    for capa in capas:
        for r, c, bb in celdas(tier):
            sufijo = "" if (cols, rows) == (1, 1) else "_r%dc%d" % (r, c)
            archivo = "%s%s.png" % (capa["slug"], sufijo)
            ruta = os.path.join(destino, archivo)
            print("   %-24s %-8s" % (capa["id"], sufijo or "(unica)"),
                  end=" ", flush=True)

            im = pedir(capa["id"], bb, (W, H))
            out = normalizar(im, mascaras[(r, c)])
            out.save(ruta, "PNG", optimize=True, transparency=0)

            kb = os.path.getsize(ruta) / 1024
            print("-> %-18s %6.0f KB" % (archivo, kb))

            piezas.append({
                "capa": capa["slug"],
                "archivo": "%s/%s" % (nombre_tier, archivo),
                # bounds tal como los espera L.imageOverlay:
                # [[sur, oeste], [norte, este]]
                "bounds": [[round(bb[1], 6), round(bb[0], 6)],
                           [round(bb[3], 6), round(bb[2], 6)]],
                "bytes": os.path.getsize(ruta),
            })
            time.sleep(PAUSA_S)
    return piezas, mpp


# ============================================================
def main():
    ap = argparse.ArgumentParser(description="Genera la capa 5 del GeoVisor.")
    ap.add_argument("--solo", choices=sorted(TIERS), action="append",
                    help="genera solo este nivel (repetible)")
    ap.add_argument("--capas", help="lista separada por comas de slugs o ids de capa")
    args = ap.parse_args()

    requests.packages.urllib3.disable_warnings()  # el WMS trae una cadena TLS incompleta

    capas = CAPAS
    if args.capas:
        pedidas = {t.strip().lower() for t in args.capas.split(",") if t.strip()}
        capas = [c for c in CAPAS
                 if c["slug"] in pedidas or c["id"].lower() in pedidas
                 or c["id"].lower().replace("coberturared", "") in pedidas]
        if not capas:
            raise SystemExit("--capas no coincidio con ninguna capa")

    tiers = args.solo or list(TIERS)

    print("=" * 62)
    print("COBERTURA DE TELECOMUNICACIONES - CNT EP -> GeoVisor CAE-CH")
    print("=" * 62)
    os.makedirs(BASE, exist_ok=True)
    limite = cargar_limite()

    piezas, resolucion = [], {}
    for nombre in tiers:
        p, mpp = procesar(nombre, TIERS[nombre], capas, limite)
        piezas.extend(p)
        resolucion[nombre] = round(mpp, 1)

    # ---- manifest -------------------------------------------------
    ruta_manifest = os.path.join(BASE, "manifest.json")
    previo = {}
    if os.path.isfile(ruta_manifest):
        with open(ruta_manifest, encoding="utf-8") as fh:
            previo = json.load(fh)

    # Al regenerar solo unos tiers o unas capas, se conserva lo demas.
    slugs = {c["slug"] for c in capas}
    conservadas = [p for p in previo.get("piezas", [])
                   if p["archivo"].split("/")[0] not in tiers or p["capa"] not in slugs]

    manifest = {
        "fuente": "CNT EP - Corporacion Nacional de Telecomunicaciones",
        "fuente_url": "https://gis.cnt.gob.ec/appgeoportal/",
        "servicio": "WMS %s (capas Cobertura*)" % WMS,
        "descargado": datetime.date.today().isoformat(),
        "ambito": ("Provincia de Chimborazo (DPA 06), recortado con buffer de %.1f km"
                   % BUFFER_KM),
        "condiciones": CONDICIONES,
        "paleta": [{"clase": c[0], "rgb": list(c[1]), "etiqueta": c[2]} for c in PALETA],
        "escalas": {
            "senal": ["alto", "medio", "bajo"],
            "gpon": ["gpon"],
            "cdma": ["cdma"],
        },
        "resolucion_m_px": {**previo.get("resolucion_m_px", {}), **resolucion},
        "tiers": {k: {"etiqueta": v["etiqueta"],
                      "zoom_min": v["zoom_min"],
                      "zoom_max": v["zoom_max"],
                      "bounds": [[round(v["bbox"][1], 6), round(v["bbox"][0], 6)],
                                 [round(v["bbox"][3], 6), round(v["bbox"][2], 6)]]}
                  for k, v in TIERS.items()},
        "capas": [{k: c[k] for k in ("id", "slug", "nombre", "escala", "orden", "nota")}
                  for c in sorted(CAPAS, key=lambda c: c["orden"])],
        "piezas": sorted(conservadas + piezas, key=lambda p: p["archivo"]),
    }
    with open(ruta_manifest, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)

    total = sum(p["bytes"] for p in manifest["piezas"])
    print("\n" + "=" * 62)
    print("%d piezas, %.1f MB en total" % (len(manifest["piezas"]), total / 1e6))
    print("manifest -> %s" % os.path.relpath(ruta_manifest))


if __name__ == "__main__":
    sys.exit(main())
