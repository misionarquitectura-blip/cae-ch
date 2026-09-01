# ============================================================
# DESCARGADOR DE CAPAS ARCGIS REST -> GeoJSON / GeoPackage / Shapefile
# Fuente: geoportal del GADM Riobamba (Experience Builder "Consulta predial")
#         https://experience.arcgis.com/experience/3e0af0795b634498a0b6b0b0d007e927
# ============================================================
# Ejecutar en Google Colab o en local (python 3.9+).
#
# Correcciones respecto a la version anterior:
#  1. La capa de predios apuntaba a "Predios_Riobamba/FeatureServer", es decir a
#     la RAIZ del servicio, sin numero de capa. Un POST a .../FeatureServer/query
#     devuelve {"layers":[]}, o sea 0 objectIds, y la capa se saltaba siempre.
#     Ademas ese servicio quedo congelado el 2024-11-21. El geoportal publicado
#     hoy consume "gis_catastro_a_publicacion_vista/FeatureServer/0"
#     (74.432 predios, ano 2026, con propietario, avaluo, area de terreno y de
#     construccion).
#  2. zipfile.Z_DEFLATED no existe -> AttributeError al empaquetar. Es ZIP_DEFLATED.
#  3. outSR='' se enviaba vacio en cada query (parametro inutil). Ahora se controla
#     con OUT_SR: None = CRS nativo (EPSG:3857), 4326 = WGS84 para el GeoVisor.
#  4. Los anillos ESRI se volcaban todos como un unico "Polygon". Un predio
#     multiparte o con hueco quedaba con geometria invalida. Ahora se separa por
#     orientacion de anillo -> Polygon / MultiPolygon, y paths -> MultiLineString.
#  5. Shapefile trunca los nombres de campo a 10 caracteres ("clave_catastral" ->
#     "clave_cata", "valorconstruccion" -> "valorconst"). Se exporta ademas
#     GeoPackage, que conserva los nombres completos.
# ============================================================

# En Colab, descomentar:
# !pip install requests geopandas fiona pyproj shapely -q

import json
import os
import time
import zipfile

import geopandas as gpd
import requests

# ------------------------------------------------------------
# Configuracion
# ------------------------------------------------------------
# None -> CRS nativo del servicio (EPSG:3857 / WKID 102100)
# 4326 -> WGS84, que es lo que consume geovisor.html
OUT_SR = 4326

CARPETA_TRABAJO = "/content/descarga_sig" if os.path.isdir("/content") else "./descarga_sig"

capas = [
    {
        # CORREGIDO: vista de publicacion vigente (la que usa el geoportal).
        "nombre": "Predios",
        "url": "https://services9.arcgis.com/WR0heBS35BiLFAuA/arcgis/rest/services/gis_catastro_a_publicacion_vista/FeatureServer/0",
    },
    {
        # Servicio antiguo, conservado solo como respaldo historico (2024-11-21).
        # Ojo: la unica capa de ese servicio es la 25, no la 0.
        "nombre": "Predios_2024_historico",
        "url": "https://services9.arcgis.com/WR0heBS35BiLFAuA/arcgis/rest/services/Predios_Riobamba/FeatureServer/25",
        "omitir": True,
    },
    {
        "nombre": "Comodatos",
        "url": "https://services9.arcgis.com/WR0heBS35BiLFAuA/arcgis/rest/services/gis_comodatos_a/FeatureServer/0",
    },
    {
        "nombre": "Predios_Municipales",
        "url": "https://services9.arcgis.com/WR0heBS35BiLFAuA/arcgis/rest/services/gis_predios_municipales_a/FeatureServer/0",
    },
    {
        "nombre": "Estructura_Catastral",
        "url": "https://services9.arcgis.com/WR0heBS35BiLFAuA/arcgis/rest/services/estructura_catastral_a_vista/FeatureServer/0",
    },
    {
        "nombre": "Parroquias",
        "url": "https://services9.arcgis.com/WR0heBS35BiLFAuA/arcgis/rest/services/organizacion_territorial/FeatureServer/0",
    },
    {
        "nombre": "Limite_Urbano",
        "url": "https://services9.arcgis.com/WR0heBS35BiLFAuA/arcgis/rest/services/LIMITEURBANO/FeatureServer/0",
    },
]


# ------------------------------------------------------------
# Utilidades
# ------------------------------------------------------------
def _es_horario(anillo):
    """Shoelace: >0 = sentido horario = anillo exterior en la convencion ESRI."""
    s = 0.0
    for (x1, y1), (x2, y2) in zip(anillo, anillo[1:]):
        s += (x2 - x1) * (y2 + y1)
    return s > 0


def _anillos_a_geojson(rings):
    """Separa los anillos ESRI en poligonos (exterior horario + huecos antihorarios)."""
    poligonos = []
    for anillo in rings:
        anillo = [tuple(p[:2]) for p in anillo if len(p) >= 2]
        if len(anillo) < 4:
            continue
        if anillo[0] != anillo[-1]:
            anillo.append(anillo[0])
        if _es_horario(anillo) or not poligonos:
            poligonos.append([anillo])
        else:
            poligonos[-1].append(anillo)

    if not poligonos:
        return None
    if len(poligonos) == 1:
        return {"type": "Polygon", "coordinates": poligonos[0]}
    return {"type": "MultiPolygon", "coordinates": poligonos}


def esri_json_to_geojson(esri_features, spatial_ref):
    """Convierte features en ESRI JSON a un FeatureCollection GeoJSON."""
    geojson_features = []
    sin_geometria = 0

    for feature in esri_features:
        geom_esri = feature.get("geometry") or {}
        attributes = feature.get("attributes", {})

        if not geom_esri:
            sin_geometria += 1
            continue

        if "rings" in geom_esri:
            geojson_geom = _anillos_a_geojson(geom_esri["rings"])
        elif "paths" in geom_esri:
            paths = [[tuple(p[:2]) for p in path] for path in geom_esri["paths"]]
            geojson_geom = (
                {"type": "LineString", "coordinates": paths[0]}
                if len(paths) == 1
                else {"type": "MultiLineString", "coordinates": paths}
            )
        elif "points" in geom_esri:
            geojson_geom = {
                "type": "MultiPoint",
                "coordinates": [tuple(p[:2]) for p in geom_esri["points"]],
            }
        elif "x" in geom_esri and "y" in geom_esri:
            if geom_esri["x"] is None or geom_esri["y"] is None:
                sin_geometria += 1
                continue
            geojson_geom = {"type": "Point", "coordinates": [geom_esri["x"], geom_esri["y"]]}
        else:
            sin_geometria += 1
            continue

        if geojson_geom is None:
            sin_geometria += 1
            continue

        geojson_features.append(
            {"type": "Feature", "geometry": geojson_geom, "properties": attributes}
        )

    if sin_geometria:
        print(f"    ! {sin_geometria} registros sin geometria valida (descartados)")

    geojson = {"type": "FeatureCollection", "features": geojson_features}

    if spatial_ref:
        wkid = spatial_ref.get("latestWkid") or spatial_ref.get("wkid")
        if wkid:
            geojson["crs"] = {
                "type": "name",
                "properties": {"name": f"urn:ogc:def:crs:EPSG::{wkid}"},
            }

    return geojson


def _post(url, data, intentos=3, timeout=120):
    """POST con reintentos que ademas convierte el 'error' de ArcGIS en excepcion."""
    ultimo = None
    for n in range(intentos):
        try:
            r = requests.post(url, data=data, timeout=timeout)
            r.raise_for_status()
            payload = r.json()
            if "error" in payload:
                raise RuntimeError(payload["error"].get("message", payload["error"]))
            return payload
        except Exception as e:  # noqa: BLE001
            ultimo = e
            time.sleep(2 * (n + 1))
    raise RuntimeError(f"fallaron {intentos} intentos: {ultimo}")


def descargar_capa_con_paginacion(url_base, nombre_capa):
    """Descarga todos los features de UNA capa. La URL debe terminar en /<id>."""
    print(f"\n[*] Descargando: {nombre_capa}")
    print(f"    URL: {url_base}")

    url_base = url_base.strip().rstrip("/")

    # La URL debe apuntar a una capa concreta, no a la raiz del FeatureServer.
    if url_base.rsplit("/", 1)[-1].lower() in ("featureserver", "mapserver"):
        print("    X La URL apunta a la raiz del servicio: falta el numero de capa "
              "(p. ej. .../FeatureServer/0)")
        return None

    try:
        info = requests.get(f"{url_base}?f=json", timeout=30).json()
        print(f"    Capa: {info.get('name')} | geometria: {info.get('geometryType')} "
              f"| maxRecordCount: {info.get('maxRecordCount', 1000)}")
    except Exception as e:  # noqa: BLE001
        print(f"    ! No se pudo leer la metadata: {e}")

    query_url = f"{url_base}/query"

    # 1. ObjectIDs
    try:
        ids_data = _post(query_url, {"where": "1=1", "returnIdsOnly": "true", "f": "json"}, timeout=60)
        object_ids = ids_data.get("objectIds") or []
    except Exception as e:  # noqa: BLE001
        print(f"    X Error obteniendo IDs: {e}")
        return None

    if not object_ids:
        print("    X No se encontraron registros")
        return None

    total_features = len(object_ids)
    print(f"    Total de features: {total_features}")

    # 2. Descarga por lotes de objectIds
    all_features = []
    spatial_ref = None
    batch_size = 500
    total_batches = (total_features + batch_size - 1) // batch_size

    for i in range(0, total_features, batch_size):
        batch_num = i // batch_size + 1
        batch_ids = object_ids[i:i + batch_size]

        params = {
            "objectIds": ",".join(map(str, batch_ids)),
            "outFields": "*",
            "returnGeometry": "true",
            "f": "json",
        }
        if OUT_SR:
            params["outSR"] = str(OUT_SR)

        print(f"    Lote {batch_num}/{total_batches} ({len(batch_ids)} registros)...", end="")

        try:
            data = _post(query_url, params)
        except Exception as e:  # noqa: BLE001
            print(f" X {e}")
            continue

        all_features.extend(data.get("features", []))
        if spatial_ref is None and "spatialReference" in data:
            spatial_ref = data["spatialReference"]

        print(f" ok ({len(all_features)}/{total_features})")

    if not all_features:
        print("    X No se pudieron descargar features")
        return None

    print(f"    Descarga completa: {len(all_features)} features")

    return {
        "geojson": esri_json_to_geojson(all_features, spatial_ref),
        "spatial_ref": spatial_ref,
        "count": len(all_features),
        "nombre": nombre_capa,
    }


def _crs_de(datos):
    spatial_ref = datos.get("spatial_ref") or {}
    wkid = spatial_ref.get("latestWkid") or spatial_ref.get("wkid")
    if wkid == 102100:
        wkid = 3857
    return f"EPSG:{wkid}" if wkid else "EPSG:4326"


def escribir_capa(datos, nombre_salida, carpeta_salida):
    """Escribe GeoJSON + GeoPackage + Shapefile. Devuelve un dict de rutas creadas."""
    rutas = {}
    features = datos["geojson"]["features"]

    # GeoJSON (compacto, tal cual lo entrega el servicio)
    ruta_geojson = os.path.join(carpeta_salida, f"{nombre_salida}.geojson")
    with open(ruta_geojson, "w", encoding="utf-8") as f:
        json.dump(datos["geojson"], f, ensure_ascii=False, separators=(",", ":"))
    rutas["geojson"] = ruta_geojson
    print(f"    GeoJSON: {os.path.basename(ruta_geojson)}")

    if not features:
        print("    ! Sin geometrias: no se generan GPKG ni SHP")
        return rutas

    gdf = gpd.GeoDataFrame.from_features(features)
    crs = _crs_de(datos)
    gdf.set_crs(crs, inplace=True, allow_override=True)
    print(f"    CRS: {crs}")

    # GeoPackage: conserva los nombres de campo completos
    try:
        ruta_gpkg = os.path.join(carpeta_salida, f"{nombre_salida}.gpkg")
        gdf.to_file(ruta_gpkg, driver="GPKG", layer=nombre_salida)
        rutas["gpkg"] = ruta_gpkg
        print(f"    GeoPackage: {os.path.basename(ruta_gpkg)}")
    except Exception as e:  # noqa: BLE001
        print(f"    ! GeoPackage no generado: {e}")

    # Shapefile: trunca los campos a 10 caracteres
    try:
        ruta_shp = os.path.join(carpeta_salida, f"{nombre_salida}.shp")
        gdf.to_file(ruta_shp, driver="ESRI Shapefile", encoding="utf-8")
        rutas["shp"] = ruta_shp
        print(f"    Shapefile: {os.path.basename(ruta_shp)}")
    except Exception as e:  # noqa: BLE001
        print(f"    ! Shapefile no generado: {e}")

    return rutas


# ------------------------------------------------------------
# Ejecucion principal
# ------------------------------------------------------------
def main():
    carpeta_datos = os.path.join(CARPETA_TRABAJO, "capas")
    os.makedirs(carpeta_datos, exist_ok=True)

    pendientes = [c for c in capas if not c.get("omitir")]

    print("=" * 60)
    print(f"INICIANDO DESCARGA DE {len(pendientes)} CAPAS")
    print(f"CRS de salida: {'EPSG:' + str(OUT_SR) if OUT_SR else 'nativo del servicio'}")
    print("=" * 60)

    resultados = []

    for idx, capa in enumerate(pendientes, 1):
        print(f"\n{'=' * 60}")
        print(f"[{idx}/{len(pendientes)}] {capa['nombre']}")
        print("=" * 60)

        datos = descargar_capa_con_paginacion(capa["url"], capa["nombre"])
        if datos is None:
            print("    -> Capa omitida por error de descarga")
            resultados.append({"nombre": capa["nombre"], "features": 0, "crs": None, "rutas": {}})
            continue

        print("\n    Generando archivos de salida...")
        rutas = escribir_capa(datos, capa["nombre"], carpeta_datos)

        resultados.append({
            "nombre": capa["nombre"],
            "features": datos["count"],
            "crs": _crs_de(datos),
            "rutas": rutas,
        })

    print(f"\n{'=' * 60}")
    print("RESUMEN")
    print("=" * 60)
    for r in resultados:
        formatos = ", ".join(sorted(r["rutas"])) or "ninguno"
        print(f"- {r['nombre']}: {r['features']} features | CRS: {r['crs'] or 'n/d'} | {formatos}")

    # ZIP  (ZIP_DEFLATED, no Z_DEFLATED)
    print("\nCreando archivo ZIP...")
    ruta_zip = os.path.join(CARPETA_TRABAJO, "capas_sig_completas.zip")
    with zipfile.ZipFile(ruta_zip, "w", zipfile.ZIP_DEFLATED) as zipf:
        for root, _dirs, archivos in os.walk(carpeta_datos):
            for archivo in archivos:
                zipf.write(os.path.join(root, archivo), os.path.join("capas", archivo))

    print(f"ZIP creado: {ruta_zip} ({os.path.getsize(ruta_zip) / (1024 * 1024):.2f} MB)")

    try:
        from google.colab import files as colab_files
        colab_files.download(ruta_zip)
    except ImportError:
        pass

    return ruta_zip, resultados


if __name__ == "__main__":
    main()
