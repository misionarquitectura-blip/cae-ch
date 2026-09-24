# Línea 2 · Estudio 2 — Compacidad, proximidad y movilidad de abasto

Página: `RESEARCH/proximidad.html` (se genera; no se edita a mano).

```
node osm_red.js                              # red de calles, mercados y buses de OSM -> fuentes/ (no se versiona)
node --max-old-space-size=8192 analisis.js   # -> datos.json
node build.js                                # datos.json + plantilla.html -> ../proximidad.html
```

## Entradas
- `DATA SET/Catastro GADMR.geojson` (corte 1 sep 2026) y `RESEARCH/no_registradas.geojson` (Línea 1).
- `DATA SET/DATOS GEOVISOR 01 09 2026/capas/`: `Limite_Urbano` y `Predios_Municipales`.
- `RESEARCH/equipamiento/consolidado.json` y `osm_areas.json`: el inventario del estudio 1.
  **Esa carpeta no se versiona**: hay que tenerla en local para regenerar.
- `mercados.js`: la red municipal de mercados, depurada a mano (fuentes en el propio archivo).
  El estudio 1 (`equipamiento/paso5.js`) también la lee para el conteo de mercados.

## Supuestos (todos en la cabecera de `analisis.js`)
Rejilla de 200 m (Rueda); 3 m por planta; centro = 1,2 km desde el Parque Maldonado;
1 km a pie (NAU EA1) y 1,5 km como umbral de viaje motorizado; 2 compras por hogar y semana.
Población y hogares del área urbana (INEC 2022) repartidos por superficie construida
residencial + construcción no registrada a una planta.

`clasificar.js` es copia del de `equipamiento/`: si se cambia una regla allí, copiarla aquí.
