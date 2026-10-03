# Línea 2 · Rama 2.3 — Áreas verdes

Página: `RESEARCH/verde.html` (se genera; no se edita a mano).

```
node osm_verde.js                              # parques, jardines y plazas de OSM -> fuentes/verde.json (no se versiona)
node --max-old-space-size=8192 analisis.js     # -> datos.json (usa la base de ../proximidad/analisis.js)
node build.js                                  # datos.json + plantilla.html -> ../verde.html
```

## Entradas
- Base de la rama 2.1 (`../proximidad/analisis.js` como módulo): población por predio, rejilla de 200 m, red de calles, sectores.
- `fuentes/verde.json`: OSM con la misma holgura que la red de calles (los parques del borde, Chibunga y Ricpamba, quedan fuera del límite).
- `DATA SET/fuentes/GADMR catastro 2026-10-01/Predios_Municipales.geojson`: áreas verdes declaradas y lotes candidatos.
- `DATA SET/capas/PUGS Urbano.geojson` (zonas de recreación y deporte) y `Catastro GADMR.geojson` (tenencia de esas zonas; los propietarios privados no se publican).
- `RESEARCH/construcciones_ia.geojson`: todas las huellas detectadas por IA, para descartar lotes edificados.
- `../proximidad/datos.json`: los tres lotes que la rama 2.1 reserva para mercados.

## Supuestos (cabecera de `analisis.js`)
- Área verde = parque, juegos infantiles, césped, área comunal; jardines solo si son de uso público o comunitario
  (OSM Riobamba tiene muchos jardines de casa). Sin canchas, estadios ni plazas duras.
- Polígonos rasterizados a 5 m y unidos en piezas continuas; la dotación cuenta solo lo que está dentro del límite.
- ED1 del Código Urbano (Ord. 016-2023, art. 178): 400 m, lote mínimo 300 m². Escalas de Rueda (1 000 m² a 200 m,
  0,5 ha a 750 m, 1 ha a 2 km, 10 ha a 4 km), medidas por calle desde el borde de la pieza.
- Verde al alcance: 2SFCA a 750 m.
- Sitios: lotes municipales vacantes de 1 000 a 5 000 m² (barrial, 400 m) y de 5 000 m² o más (zonal, 750 m),
  selección voraz por población nueva cubierta. Son suelo apto, no disponible: hay que verificar el destino legal.
