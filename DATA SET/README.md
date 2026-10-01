# DATA SET

```
DATA SET/
├── capas/      Lo que publica el sitio. Se versiona; geovisor.html, el DICAT,
│               la planimetria y las pruebas leen de aqui.
├── fuentes/    Descargas crudas por institucion. No se versiona (.gitignore).
└── build_*     Convierten fuentes/ en capas/.
```

| Capa publicada (`capas/`)           | Se genera con                         | A partir de (`fuentes/`)                      |
|-------------------------------------|---------------------------------------|-----------------------------------------------|
| `Catastro GADMR.geojson`            | `node "DATA SET/build_catastro.js"`   | `GADMR catastro <fecha>/Predios.geojson`      |
| `agua_potable.geojson`, `alcantarillado.geojson` | `node "DATA SET/build_servicios_basicos.js"` | `EP Riobamba agua y alcantarillado/` |
| `telecom/`                          | `python "DATA SET/build_telecom.py"`  | WMS de CNT EP (no queda copia local)          |
| `planimetria/`                      | `node planimetria/preparar_web.js`    | `CERTIFICACION_EJES_VIALES.gdb`, catastro     |
| `eersa.geojson` (postes, transformadores, red MT/BT) | `python "DATA SET/build_eersa.py"` | servicio ArcGIS de la EERSA (cache en `EERSA <fecha>/`) |
| `LINEAS_FABRICA`, `VIALIDAD_TOTAL`, `PUGS Urbano`, `PUGS Rural` | publicadas tal cual | |

`descarga_arcgis.py` baja la vista de publicacion del geoportal del GADMR.
Cada corte nuevo va a `fuentes/GADMR catastro AAAA-MM-DD/` (solo los GeoJSON:
los SHP/GPKG de la descarga repiten los mismos datos).

Despues de regenerar cualquier capa: `npm test`.
