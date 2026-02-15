/**
 * Extract simplified coastline data from world-atlas TopoJSON.
 * Output: frontend/public/world.json - compact coordinate arrays.
 */
import { readFileSync, writeFileSync } from 'fs';
import * as topojson from 'topojson-client';

const topoPath = './node_modules/world-atlas/land-110m.json';
const topo = JSON.parse(readFileSync(topoPath, 'utf8'));

// Convert TopoJSON to GeoJSON
const geo = topojson.feature(topo, topo.objects.land);

// Extract coordinate rings as [lng, lat] arrays
// Only keep polygons (multi-polygon flattened)
const rings = [];
for (const feature of geo.features ?? [geo]) {
  const geom = feature.geometry ?? feature;
  if (geom.type === 'Polygon') {
    for (const ring of geom.coordinates) {
      // Simplify: skip very small rings (islands < 5 points)
      if (ring.length >= 5) {
        rings.push(ring.map(([lng, lat]) => [
          Math.round(lng * 10) / 10,
          Math.round(lat * 10) / 10,
        ]));
      }
    }
  } else if (geom.type === 'MultiPolygon') {
    for (const polygon of geom.coordinates) {
      for (const ring of polygon) {
        if (ring.length >= 5) {
          rings.push(ring.map(([lng, lat]) => [
            Math.round(lng * 10) / 10,
            Math.round(lat * 10) / 10,
          ]));
        }
      }
    }
  }
}

const output = { rings };
const json = JSON.stringify(output);
writeFileSync('./frontend/public/world.json', json);
console.log(`Generated ${rings.length} coastline rings (${(json.length / 1024).toFixed(1)}KB)`);
