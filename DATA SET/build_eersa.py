# -*- coding: utf-8 -*-
"""
============================================================
GENERADOR DE LA CAPA 3 - INFRAESTRUCTURA ELECTRICA (EERSA)
Fuente: Geoportal EERSA (redenergia.gob.ec)
  https://geoservicios.redenergia.gob.ec/portal/apps/webappviewer/index.html?id=19461bd0003c49f0b8069eed044dc4d2
Servicios ArcGIS Server (MapServer, consulta por OBJECTID):
  eersa/ArcGisOnline_ObjetosEERSA/MapServer   5 Puesto TransfDistribucion, 6 Poste
  eersa/ArcGisOnline_TramosEERSA/MapServer    3 BT aereo, 4 BT subterraneo,
                                              5 MT aereo, 6 MT subterraneo
============================================================

Lo que el DICAT necesita saber de la red electrica frente a un predio:

  - el poste mas cercano que lleva red de baja tension, con su codigo
    unico de la EERSA (CODIGOELEMENTO) y la distancia al lindero;
  - el tipo de red que pasa por el frente: baja tension aerea o
    subterranea, mono/bi/trifasica, y la media tension mas cercana;
  - el transformador mas cercano: potencia (kVA), fases y cargabilidad,
    de donde sale la potencia remanente estimada.

Todo lo demas se descarta a proposito:

  - Clientes (SIGELEC): son abonados con consumo; datos personales (LOPDP).
  - Acometidas y bajantes: un tramo por abonado, 2/3 de la capa BT.
  - Luminarias, tensores, seccionadores, semaforos, reguladores...: no
    responden a ninguna de las tres preguntas y pesan.
  - Auditoria de edicion (usuario, fechas, orden de trabajo, GUID).

Notas del servicio:

  - Esta detras de un WAF: sin User-Agent de navegador y Referer del
    geoportal devuelve una pagina "Web Application Firewall".
  - No soporta paginacion (resultOffset -> "Pagination is not supported"):
    se piden los OBJECTID y luego bloques de LOTE ids por POST.
  - CANTON va codificado (Riobamba = '0601'). Los tramos no tienen canton:
    se piden por el rectangulo del canton y se recortan con las parroquias.
  - CODIGOESTRUCTURA del poste NO es un identificador: es el tipo
    constructivo (POO1004 lo comparten miles de postes). El ID unico es
    CODIGOELEMENTO.

Lo que produce:

  DATA SET/fuentes/EERSA <fecha>/*.json   respuestas crudas (cache)
  DATA SET/capas/eersa.geojson            capa 3 del visor, propiedades cortas:

    t:'p' poste   c codigo, u uso (TIPOUSOPOSTE), m material (SUBTIPO)
    t:'t' trafo   c codigo puesto, kva, f fases (1-3), car cargabilidad %,
                  vs voltaje secundario, tr tipo de red BT
    t:'b' red BT  s 'A'/'S' (aerea/subterranea), f fases, v voltaje (V)
    t:'m' red MT  s 'A'/'S', f fases, kv tension (kV)

Uso:
    python "DATA SET/build_eersa.py"            descarga (si no hay cache) y construye
    python "DATA SET/build_eersa.py" --refrescar  vuelve a descargar todo

Requiere: requests.
============================================================
"""

import argparse
import datetime
import json
import os
import sys
import time

import requests

BASE_URL = "https://geoservicios.redenergia.gob.ec/server/rest/services/eersa"
REFERER = ("https://geoservicios.redenergia.gob.ec/portal/apps/webappviewer/"
           "index.html?id=19461bd0003c49f0b8069eed044dc4d2")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")

LOTE = 500
PAUSA_S = 0.4
REINTENTOS = 4
CANTON = "0601"   # Riobamba

AQUI = os.path.dirname(os.path.abspath(__file__))
FECHA = datetime.date.today().isoformat()
CACHE = os.path.join(AQUI, "fuentes", "EERSA " + FECHA)
PARROQUIAS = None  # se resuelve en main(): el corte mas reciente del GADMR
SALIDA = os.path.join(AQUI, "capas", "eersa.geojson")

# Postes que importan: los que llevan alguna red. Fuera tensores (6),
# acometidas privadas (5), semaforos (8), vigilancia (9) y sin red (10).
USOS_POSTE = (1, 2, 3, 4, 7)

FUENTES = {
    "postes": {
        "url": BASE_URL + "/ArcGisOnline_ObjetosEERSA/MapServer/6",
        "where": "CANTON='%s' AND TIPOUSOPOSTE IN (%s)" % (CANTON, ",".join(map(str, USOS_POSTE))),
        "campos": "OBJECTID,CODIGOELEMENTO,TIPOUSOPOSTE,SUBTIPO",
    },
    "trafos": {
        "url": BASE_URL + "/ArcGisOnline_ObjetosEERSA/MapServer/5",
        "where": "CANTON='%s'" % CANTON,
        "campos": "OBJECTID,CODIGOPUESTO,POTENCIAKVA,FASECONEXION,CARGABILIDAD,VOLTAJESECUNDARIO,TIPORED,SUBTIPO",
    },
    # Tramos: SUBTIPO 1-3 = tramo mono/bi/trifasico (4-9 bajantes y acometidas)
    "bt_aerea": {"url": BASE_URL + "/ArcGisOnline_TramosEERSA/MapServer/3",
                 "where": "SUBTIPO IN (1,2,3)", "campos": "OBJECTID,SUBTIPO,VOLTAJE", "bbox": True},
    "bt_subt":  {"url": BASE_URL + "/ArcGisOnline_TramosEERSA/MapServer/4",
                 "where": "SUBTIPO IN (1,2,3)", "campos": "OBJECTID,SUBTIPO,VOLTAJE", "bbox": True},
    "mt_aerea": {"url": BASE_URL + "/ArcGisOnline_TramosEERSA/MapServer/5",
                 "where": "SUBTIPO IN (1,2,3)", "campos": "OBJECTID,SUBTIPO,VOLTAJE", "bbox": True},
    "mt_subt":  {"url": BASE_URL + "/ArcGisOnline_TramosEERSA/MapServer/6",
                 "where": "SUBTIPO IN (1,2,3)", "campos": "OBJECTID,SUBTIPO,VOLTAJE", "bbox": True},
}

sesion = requests.Session()
sesion.headers.update({"User-Agent": UA, "Referer": REFERER})


def pedir(url, datos):
    for intento in range(REINTENTOS):
        try:
            r = sesion.post(url, data=datos, timeout=180)
            r.raise_for_status()
            if r.text.lstrip().startswith("<"):
                raise RuntimeError("el WAF devolvio HTML en lugar de JSON")
            j = r.json()
            if "error" in j:
                raise RuntimeError(j["error"].get("message"))
            return j
        except Exception as e:  # noqa: BLE001 - se reintenta cualquier fallo de red
            if intento == REINTENTOS - 1:
                raise
            print("    reintento %d: %s" % (intento + 1, e))
            time.sleep(3 * (intento + 1))


def descargar(nombre, spec, bbox):
    ruta = os.path.join(CACHE, nombre + ".json")
    if os.path.isfile(ruta):
        with open(ruta, encoding="utf-8") as fh:
            return json.load(fh)
    filtro = {"where": spec["where"], "f": "json"}
    if spec.get("bbox"):
        filtro.update({"geometry": ",".join(map(str, bbox)), "geometryType": "esriGeometryEnvelope",
                       "inSR": "4326", "spatialRel": "esriSpatialRelIntersects"})
    ids = sorted(pedir(spec["url"] + "/query", dict(filtro, returnIdsOnly="true"))["objectIds"] or [])
    print("  %-9s %6d elementos" % (nombre, len(ids)))
    feats = []
    for i in range(0, len(ids), LOTE):
        j = pedir(spec["url"] + "/query", {
            "objectIds": ",".join(map(str, ids[i:i + LOTE])), "outFields": spec["campos"],
            "returnGeometry": "true", "outSR": "4326", "f": "json"})
        feats.extend(j.get("features", []))
        sys.stdout.write("\r    %d/%d" % (len(feats), len(ids)))
        sys.stdout.flush()
        time.sleep(PAUSA_S)
    print()
    os.makedirs(CACHE, exist_ok=True)
    with open(ruta, "w", encoding="utf-8") as fh:
        json.dump(feats, fh)
    return feats


# ------------------------------------------------------------
# Recorte al canton: union de las parroquias del GADMR
# ------------------------------------------------------------
def anillos_canton(ruta):
    with open(ruta, encoding="utf-8") as fh:
        fc = json.load(fh)
    anillos = []
    for f in fc["features"]:
        g = f["geometry"]
        polis = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        for p in polis:
            ext = p[0]
            xs = [c[0] for c in ext]
            ys = [c[1] for c in ext]
            anillos.append((min(xs), min(ys), max(xs), max(ys), ext))
    return anillos


def dentro(x, y, anillos):
    for x0, y0, x1, y1, r in anillos:
        if x < x0 or x > x1 or y < y0 or y > y1:
            continue
        ins = False
        j = len(r) - 1
        for i in range(len(r)):
            xi, yi = r[i][0], r[i][1]
            xj, yj = r[j][0], r[j][1]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                ins = not ins
            j = i
        if ins:
            return True
    return False


def fases(cod):
    """FASECONEXION es una mascara A=4, B=2, C=1: el numero de fases son sus bits."""
    return bin(int(cod or 0)).count("1") or None


def r7(v):
    return round(v, 7)


def r6(v):
    return round(v, 6)


def main():
    global PARROQUIAS
    ap = argparse.ArgumentParser()
    ap.add_argument("--refrescar", action="store_true")
    args = ap.parse_args()

    cortes = sorted(d for d in os.listdir(os.path.join(AQUI, "fuentes")) if d.startswith("GADMR catastro "))
    PARROQUIAS = os.path.join(AQUI, "fuentes", cortes[-1], "Parroquias.geojson")
    anillos = anillos_canton(PARROQUIAS)
    bbox = [min(a[0] for a in anillos), min(a[1] for a in anillos),
            max(a[2] for a in anillos), max(a[3] for a in anillos)]

    if args.refrescar and os.path.isdir(CACHE):
        for n in os.listdir(CACHE):
            os.remove(os.path.join(CACHE, n))

    print("EERSA — descarga (canton %s, cache %s)" % (CANTON, os.path.relpath(CACHE, AQUI)))
    crudo = {n: descargar(n, s, bbox) for n, s in FUENTES.items()}

    salida = []
    cuenta = {}

    for f in crudo["postes"]:
        a, g = f["attributes"], f.get("geometry")
        if not g or not a.get("CODIGOELEMENTO"):
            continue
        salida.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [r7(g["x"]), r7(g["y"])]},
                       "properties": {"t": "p", "c": str(a["CODIGOELEMENTO"]).strip(),
                                      "u": a.get("TIPOUSOPOSTE"), "m": a.get("SUBTIPO")}})
        cuenta["postes"] = cuenta.get("postes", 0) + 1

    for f in crudo["trafos"]:
        a, g = f["attributes"], f.get("geometry")
        if not g:
            continue
        p = {"t": "t", "c": str(a.get("CODIGOPUESTO") or "").strip(), "kva": a.get("POTENCIAKVA"),
             "f": fases(a.get("FASECONEXION")), "car": a.get("CARGABILIDAD"),
             "vs": a.get("VOLTAJESECUNDARIO"), "tr": (a.get("TIPORED") or "").strip() or None}
        salida.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [r7(g["x"]), r7(g["y"])]},
                       "properties": {k: v for k, v in p.items() if v is not None}})
        cuenta["trafos"] = cuenta.get("trafos", 0) + 1

    for nombre, t, s in (("bt_aerea", "b", "A"), ("bt_subt", "b", "S"), ("mt_aerea", "m", "A"), ("mt_subt", "m", "S")):
        n = 0
        for f in crudo[nombre]:
            a, g = f["attributes"], f.get("geometry")
            if not g or not g.get("paths"):
                continue
            paths = [[[r6(c[0]), r6(c[1])] for c in pth] for pth in g["paths"] if len(pth) >= 2]
            if not paths or not any(dentro(c[0], c[1], anillos) for pth in paths for c in pth):
                continue
            p = {"t": t, "s": s, "f": a.get("SUBTIPO")}  # SUBTIPO 1-3 = numero de fases
            v = a.get("VOLTAJE")
            if t == "b":
                p["v"] = v
            elif v:
                p["kv"] = round(v / 1000.0, 2)
            geom = ({"type": "LineString", "coordinates": paths[0]} if len(paths) == 1
                    else {"type": "MultiLineString", "coordinates": paths})
            salida.append({"type": "Feature", "geometry": geom, "properties": p})
            n += 1
        cuenta[nombre] = n

    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "fuente": "EERSA - Geoportal redenergia.gob.ec",
            "corte": FECHA,
            "canton": "Riobamba",
            "conteo": cuenta,
            "generado_por": "DATA SET/build_eersa.py",
        },
        "features": salida,
    }
    with open(SALIDA, "w", encoding="utf-8") as fh:
        json.dump(fc, fh, ensure_ascii=False, separators=(",", ":"))
    print("\n  " + "  ".join("%s %d" % kv for kv in cuenta.items()))
    print("  %s — %.1f MB" % (os.path.relpath(SALIDA, AQUI), os.path.getsize(SALIDA) / 1048576.0))


if __name__ == "__main__":
    main()
