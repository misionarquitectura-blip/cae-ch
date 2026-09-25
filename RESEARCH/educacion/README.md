# Línea 2 · Rama 2.2 — Instituciones educativas y movilidad

Página: `RESEARCH/educacion.html` (se genera; no se edita a mano).

```
# fuentes/registro_inicio.csv: MINEDUC, Registro Administrativo Histórico 2009-2024 (Inicio)
# https://www.datosabiertos.gob.ec/dataset/registro-de-matricula-mineduc
node registro.js                              # -> registro_riobamba.json (lo lee también equipamiento/paso5.js)
node geolocalizar.js                          # -> instituciones.json, sin_ubicar.json
node --max-old-space-size=8192 analisis.js    # -> datos.json (usa la base de ../proximidad/analisis.js)
node build.js                                 # -> ../educacion.html
```

- El registro no trae coordenadas: se ubican por nombre contra OSM y Nominatim. Las que falten
  se anotan a mano en `ubicaciones_manual.json` como `{ "AMIE": [lon, lat] }`.
- EE1/EE2 según el Código Urbano de Riobamba (Ord. 016-2023, art. 178, tabla 3), deducidos del
  nombre oficial de la institución.
- Modelo de elección: gravitacional con restricción en el origen, L = 2 000 m (sensibilidad 1 000 y 4 000).
- El año lectivo 2022-2023 de la fuente viene corrupto (decimales, un tercio de la matrícula): no se usa.
