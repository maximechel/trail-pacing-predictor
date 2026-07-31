/*
 * gpx-parser.js — Extrait un profil altimétrique (distance cumulée / altitude) depuis un fichier GPX
 * (ex. le tracé officiel d'une course, souvent plus fiable que l'altitude d'une montre GPS sur une
 * reconnaissance de plusieurs jours). Analyse le texte du fichier par expressions régulières plutôt
 * que via DOMParser : plus tolérant aux variations d'export (ordre des attributs lat/lon, espaces,
 * espaces de noms XML), et testable directement en Node sans dépendance au DOM.
 *
 * Cherche les points dans l'ordre de priorité : trace (trkpt) → route (rtept) → points isolés (wpt).
 * Ne dépend que de haversineMeters (défini dans fit-to-csv.js, chargé avant ce fichier).
 */

function extractGpxPoints(gpxText, tagName) {
  const openTagRe = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const points = [];
  let m;
  while ((m = openTagRe.exec(gpxText)) !== null) {
    const attrs = m[1];
    const inner = m[2];
    const latMatch = attrs.match(/\blat="(-?[0-9.]+)"/i);
    const lonMatch = attrs.match(/\blon="(-?[0-9.]+)"/i);
    if (!latMatch || !lonMatch) continue;
    const lat = parseFloat(latMatch[1]);
    const lon = parseFloat(lonMatch[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const eleMatch = inner.match(/<ele>\s*(-?[0-9.]+)\s*<\/ele>/i);
    const ele = eleMatch ? parseFloat(eleMatch[1]) : null;
    points.push({ lat, lon, ele });
  }
  return points;
}

/**
 * Parse un fichier GPX texte et renvoie des lignes { distance_cum_m, altitude_m } — même forme que les
 * colonnes IMPORT_CSV utilisées ailleurs, pour pouvoir réutiliser directement downsampleElevationProfile().
 * Lève une erreur explicite si le fichier n'est pas exploitable (pas de trace, pas d'altitude).
 */
function parseGpxElevationRows(gpxText) {
  if (!gpxText || !/<gpx[\s>]/i.test(gpxText)) {
    throw new Error("Ce fichier ne semble pas être un GPX valide.");
  }

  let points = extractGpxPoints(gpxText, 'trkpt');
  if (points.length === 0) points = extractGpxPoints(gpxText, 'rtept');
  if (points.length === 0) points = extractGpxPoints(gpxText, 'wpt');

  if (points.length < 2) {
    throw new Error("Aucune trace exploitable trouvée dans ce fichier GPX (balises trkpt/rtept/wpt introuvables ou insuffisantes).");
  }
  if (points.every((p) => p.ele === null)) {
    throw new Error("Ce fichier GPX ne contient pas d'altitude (balise <ele> absente) — impossible d'en extraire un profil altimétrique.");
  }

  const rows = [];
  let cum = 0;
  let lastEle = null;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) cum += haversineMeters(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    // Comble les rares trous d'altitude ponctuels par la dernière valeur connue, plutôt que de casser
    // le profil (un point isolé sans <ele> au milieu d'une trace par ailleurs complète).
    const ele = points[i].ele !== null ? points[i].ele : lastEle;
    if (ele !== null) lastEle = ele;
    rows.push({ distance_cum_m: cum, altitude_m: ele });
  }
  return rows.filter((r) => typeof r.altitude_m === 'number');
}

if (typeof module !== 'undefined') {
  module.exports = { extractGpxPoints, parseGpxElevationRows };
}
