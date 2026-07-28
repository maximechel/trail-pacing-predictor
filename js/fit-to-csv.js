/*
 * fit-to-csv.js — Construit les 16 colonnes IMPORT_CSV à partir d'une liste de points GPS bruts
 * { timestamp (s, epoch Unix), lat, lon, altitude }, comme le ferait le script de prétraitement GPX
 * habituellement utilisé en amont de l'outil Excel d'origine.
 *
 * Toutes les formules ci-dessous ont été validées en reproduisant, à partir des coordonnées lat/lon/
 * altitude/temps réelles d'une reconnaissance GPS, les colonnes déjà calculées du fichier IMPORT_CSV
 * d'origine (distance_step_m, slope_percent_raw, segment_type_raw, slope_percent_smooth_5pts,
 * speed_km_h_smooth_5pts, segment_type_smooth) : correspondance exacte obtenue avec les formules
 * implémentées ici (distance = haversine 2D, lissage = moyenne centrée sur 5 points bruts, seuils de
 * classification plat/montée/descente à ±3 %).
 */

const EARTH_RADIUS_M = 6371000;

function toRad(deg) { return (deg * Math.PI) / 180; }

/** Distance "grand cercle" (2D, sans tenir compte de l'altitude) entre deux points lat/lon, en mètres. */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function classifySlope(slopePct) {
  if (slopePct === null || slopePct === undefined) return null;
  if (slopePct > 3) return 'montee';
  if (slopePct < -3) return 'descente';
  return 'plat';
}

/** Moyenne centrée sur une fenêtre de 5 points (i-2..i+2, bornée aux extrémités), en ignorant les valeurs manquantes. */
function centeredMean5(arr, i) {
  const lo = Math.max(0, i - 2);
  const hi = Math.min(arr.length - 1, i + 2);
  const vals = [];
  for (let j = lo; j <= hi; j++) {
    if (arr[j] !== null && arr[j] !== undefined) vals.push(arr[j]);
  }
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * @param {Array<{timestamp:number, lat:number, lon:number, altitude:number|null}>} points
 *   timestamp en secondes (epoch Unix). Triés par ordre croissant (la fonction trie de toute façon).
 * @returns {Array<object>} lignes au format IMPORT_CSV_COLUMNS (mêmes clés que parseImportCSV())
 */
function buildImportRowsFromPoints(points) {
  const pts = points
    .filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number' && typeof p.timestamp === 'number')
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);

  if (pts.length < 2) {
    throw new Error('Pas assez de points GPS valides dans ce fichier pour construire une trace exploitable.');
  }

  const n = pts.length;
  const distanceStep = new Array(n).fill(null);
  const distanceCum = new Array(n).fill(0);
  const timeStep = new Array(n).fill(null);
  const speedMs = new Array(n).fill(null);
  const speedKmh = new Array(n).fill(null);
  const eleDelta = new Array(n).fill(null);
  const slopeRaw = new Array(n).fill(null);
  const typeRaw = new Array(n).fill(null);

  let cum = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      distanceStep[i] = 0;
      distanceCum[i] = 0;
      continue;
    }
    const d = haversineMeters(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    distanceStep[i] = d;
    cum += d;
    distanceCum[i] = cum;

    const dt = pts[i].timestamp - pts[i - 1].timestamp;
    timeStep[i] = dt > 0 ? dt : null;
    if (timeStep[i]) {
      speedMs[i] = d / timeStep[i];
      speedKmh[i] = speedMs[i] * 3.6;
    }

    const alt1 = pts[i - 1].altitude;
    const alt2 = pts[i].altitude;
    if (typeof alt1 === 'number' && typeof alt2 === 'number') {
      eleDelta[i] = alt2 - alt1;
      if (d > 0) {
        slopeRaw[i] = (eleDelta[i] / d) * 100;
        typeRaw[i] = classifySlope(slopeRaw[i]);
      }
    }
  }

  const slopeSmooth = new Array(n).fill(0);
  const speedSmooth = new Array(n).fill(0);
  const typeSmooth = new Array(n).fill('plat');
  for (let i = 0; i < n; i++) {
    slopeSmooth[i] = centeredMean5(slopeRaw, i);
    speedSmooth[i] = centeredMean5(speedKmh, i);
    typeSmooth[i] = classifySlope(slopeSmooth[i]) || 'plat';
  }

  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      point_index: i + 1,
      time: new Date(pts[i].timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
      latitude: pts[i].lat,
      longitude: pts[i].lon,
      altitude_m: typeof pts[i].altitude === 'number' ? pts[i].altitude : '',
      distance_step_m: distanceStep[i],
      distance_cum_m: distanceCum[i],
      time_step_s: timeStep[i],
      speed_m_s: speedMs[i],
      speed_km_h: speedKmh[i],
      elevation_delta_m: eleDelta[i],
      slope_percent_raw: slopeRaw[i],
      segment_type_raw: typeRaw[i],
      slope_percent_smooth_5pts: slopeSmooth[i],
      speed_km_h_smooth_5pts: speedSmooth[i],
      segment_type_smooth: typeSmooth[i],
    });
  }
  return rows;
}

function importRowsToCSVText(rows) {
  const cols = [
    'point_index', 'time', 'latitude', 'longitude', 'altitude_m', 'distance_step_m', 'distance_cum_m',
    'time_step_s', 'speed_m_s', 'speed_km_h', 'elevation_delta_m', 'slope_percent_raw', 'segment_type_raw',
    'slope_percent_smooth_5pts', 'speed_km_h_smooth_5pts', 'segment_type_smooth',
  ];
  const round = (v, d) => (typeof v === 'number' ? Number(v.toFixed(d)) : v);
  const roundedCols = {
    latitude: 8, longitude: 8, altitude_m: 1, distance_step_m: 4, distance_cum_m: 4,
    speed_m_s: 4, speed_km_h: 4, elevation_delta_m: 3, slope_percent_raw: 3,
    slope_percent_smooth_5pts: 3, speed_km_h_smooth_5pts: 3,
  };
  const lines = [cols.join(';')];
  rows.forEach((row) => {
    const line = cols.map((c) => {
      let v = row[c];
      if (v === null || v === undefined) return '';
      if (roundedCols[c] !== undefined) v = round(v, roundedCols[c]);
      return String(v);
    });
    lines.push(line.join(';'));
  });
  return lines.join('\n');
}

if (typeof module !== 'undefined') {
  module.exports = { haversineMeters, classifySlope, centeredMean5, buildImportRowsFromPoints, importRowsToCSVText };
}
