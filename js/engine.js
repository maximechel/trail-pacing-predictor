/*
 * engine.js — Moteur de calcul, port fidèle des formules du classeur Excel "V3 — Prédicteur de temps trail".
 *
 * Pipeline (identique à la logique des onglets Excel) :
 *   IMPORT_CSV  -> parseImportCSV()
 *   TRAITEMENT  -> assignSegmentGroups()   (segmentation GPS automatique, colonne SegGrp)
 *   SEGMENTS    -> buildSegments()          (agrégation par segment)
 *   PROFILS     -> computeProfils()         (profil force-vitesse + profil descente)
 *   PARAMÈTRES  -> computeCourseAutoFields() (distance / D+ / D- auto depuis le CSV)
 *   PACING      -> computePacing()          (moteur de temps prévisionnel V1 / V2)
 */

// ---------- Utilitaires ----------

/** Arrondi façon Excel ROUND() : arrondi "half away from zero", avec correction des imprécisions flottantes. */
function excelRound(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return value;
  const factor = Math.pow(10, digits);
  const corrected = Number((value * factor).toPrecision(15));
  const rounded = Math.sign(corrected) * Math.round(Math.abs(corrected));
  return rounded / factor;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).trim();
  if (s === '') return null;
  // Gère les nombres à décimale virgule (locale FR) si le champ n'est pas déjà au format point.
  if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

function average(arr) {
  const vals = arr.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function sum(arr) {
  return arr.reduce((a, b) => a + (typeof b === 'number' && !Number.isNaN(b) ? b : 0), 0);
}

/** Formatage "Xh YYmin" identique à la formule Excel INT(V/60)&"h "&TEXT(MOD(ROUND(V,0),60),"00")&"min" */
function formatHM(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes) % 60;
  return `${h}h ${String(m).padStart(2, '0')}min`;
}

// ---------- 1. IMPORT_CSV ----------

const CSV_HEADER_ALIASES = {
  point_index: 'point_index',
  time: 'time',
  latitude: 'latitude',
  longitude: 'longitude',
  altitude_m: 'altitude_m',
  distance_step_m: 'distance_step_m',
  distance_cum_m: 'distance_cum_m',
  time_step_s: 'time_step_s',
  speed_m_s: 'speed_m_s',
  speed_km_h: 'speed_km_h',
  elevation_delta_m: 'elevation_delta_m',
  slope_percent_raw: 'slope_percent_raw',
  segment_type_raw: 'segment_type_raw',
  slope_percent_smooth_5pts: 'slope_percent_smooth_5pts',
  speed_km_h_smooth_5pts: 'speed_km_h_smooth_5pts',
  segment_type_smooth: 'segment_type_smooth',
};

const NUMERIC_FIELDS = [
  'point_index', 'latitude', 'longitude', 'altitude_m', 'distance_step_m', 'distance_cum_m',
  'time_step_s', 'speed_m_s', 'speed_km_h', 'elevation_delta_m', 'slope_percent_raw',
  'slope_percent_smooth_5pts', 'speed_km_h_smooth_5pts',
];

function detectDelimiter(headerLine) {
  const candidates = [';', ',', '\t'];
  let best = ';';
  let bestCount = -1;
  for (const c of candidates) {
    const count = headerLine.split(c).length;
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  return best;
}

/**
 * Parse le CSV brut (16 colonnes, cf. bandeau IMPORT_CSV) en tableau d'objets.
 * Accepte un séparateur ";" (recommandé) ou "," et tolère les décimales à virgule.
 */
function parseImportCSV(text) {
  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = clean.split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) {
    throw new Error("Le CSV doit contenir une ligne d'en-tête et au moins une ligne de données.");
  }
  const delimiter = detectDelimiter(lines[0]);
  const header = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ''));

  const missing = Object.keys(CSV_HEADER_ALIASES).filter((k) => !header.includes(k));
  if (missing.length > 0) {
    throw new Error(`Colonnes manquantes dans le CSV : ${missing.join(', ')}`);
  }

  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });

  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const parts = lines[li].split(delimiter);
    if (parts.every((p) => p.trim() === '')) continue;
    const row = {};
    for (const field of Object.keys(CSV_HEADER_ALIASES)) {
      const raw = parts[idx[field]] !== undefined ? parts[idx[field]].trim().replace(/^"|"$/g, '') : '';
      row[field] = NUMERIC_FIELDS.includes(field) ? toNumber(raw) : (raw === '' ? null : raw);
    }
    rows.push(row);
  }
  if (rows.length === 0) throw new Error('Aucune ligne de données trouvée dans le CSV.');
  return rows;
}

// ---------- 2. TRAITEMENT — segmentation GPS (SegGrp) ----------

function assignSegmentGroups(rows) {
  let segGrp = 1;
  return rows.map((row, i) => {
    if (i > 0 && row.segment_type_smooth === rows[i - 1].segment_type_smooth) {
      // même groupe que le point précédent
    } else if (i > 0) {
      segGrp += 1;
    }
    return { ...row, segGrp };
  });
}

// ---------- 3. SEGMENTS — agrégation ----------

function buildSegments(rowsWithGroups) {
  const maxGrp = rowsWithGroups.reduce((m, r) => Math.max(m, r.segGrp), 0);
  const segments = [];
  for (let n = 1; n <= maxGrp; n++) {
    const pts = rowsWithGroups.filter((r) => r.segGrp === n);
    if (pts.length === 0) continue;
    const type = pts[0].segment_type_smooth;
    const distanceKm = excelRound(sum(pts.map((p) => p.distance_step_m)) / 1000, 3);
    const dPlus = excelRound(sum(pts.filter((p) => p.elevation_delta_m > 0).map((p) => p.elevation_delta_m)), 1);
    const dMinus = excelRound(Math.abs(sum(pts.filter((p) => p.elevation_delta_m < 0).map((p) => p.elevation_delta_m))), 1);
    const dureeMin = excelRound(sum(pts.map((p) => p.time_step_s)) / 60, 2);
    const vitesseMoy = excelRound(average(pts.map((p) => p.speed_km_h_smooth_5pts)), 2);
    const penteMoy = excelRound(average(pts.map((p) => p.slope_percent_smooth_5pts)), 1);
    segments.push({
      numero: n,
      type,
      distanceKm,
      dPlus,
      dMinus,
      dureeMin,
      vitesseMoy,
      penteMoy,
      nbPoints: pts.length,
    });
  }
  return segments;
}

// ---------- 4. MODÈLE MINETTI — coût métabolique de la course selon la pente ----------
//
// Référence : Minetti A.E., Moia C., Roi G.S., Susta D., Ferretti G. (2002), "Energy cost of
// walking and running at extreme uphill and downhill slopes", J Appl Physiol 93(3):1039-1046.
// Polynôme de degré 5 ajusté sur des mesures de VO2 en laboratoire, valable de -45 % à +45 % de
// pente. C_r(0) ≈ 3.6 J/kg/m, cohérent avec la littérature sur le coût de la course sur le plat
// (≈ 3.4-3.6 J/kg/m). Remplace, pour la partie "coefficient de profil" (montée/plat/descente),
// les tables de coefficients fixes issues du classeur Excel d'origine : voir README pour la
// justification de cet écart assumé au principe de fidélité au classeur.

const MINETTI_GRADE_MIN = -0.45;
const MINETTI_GRADE_MAX = 0.45;

/**
 * Coût métabolique de la course en fonction de la pente (Minetti et al., 2002). `gradeFraction`
 * est la pente en fraction décimale (0.10 = +10 %), bornée à [-0.45, +0.45]. Résultat en J/kg/m.
 */
function minettiCostOfTransport(gradeFraction) {
  const i = Math.max(MINETTI_GRADE_MIN, Math.min(MINETTI_GRADE_MAX, gradeFraction || 0));
  return 155.4 * Math.pow(i, 5) - 30.4 * Math.pow(i, 4) - 43.3 * Math.pow(i, 3)
    + 46.3 * Math.pow(i, 2) + 19.5 * i + 3.6;
}

/**
 * Multiplicateur de temps par rapport au plat, à puissance métabolique constante :
 * mult(i) = C_r(i) / C_r(0). `gradePercent` est la pente en pourcentage (ex. seg.penteMoy).
 * mult(0) = 1 exactement ; mult < 1 sur les pentes légèrement négatives (course en descente
 * modérée moins coûteuse que le plat) ; mult > 1 en montée et sur les descentes très raides.
 */
function minettiTimeMultiplier(gradePercent) {
  const i = (gradePercent || 0) / 100;
  const c0 = minettiCostOfTransport(0);
  const ci = minettiCostOfTransport(i);
  return ci / c0;
}

/**
 * Calibration personnelle automatique : compare, pour chaque segment de reconnaissance GPS déjà
 * importé, la vitesse réellement mesurée (seg.vitesseMoy) à la vitesse prédite par la courbe de
 * Minetti à partir de la vitesse moyenne sur le plat de l'athlète (référence à pente nulle).
 * Produit deux facteurs multiplicatifs — un pour la montée, un pour la descente — qui corrigent
 * la courbe universelle de Minetti pour refléter l'économie de course propre à l'athlète
 * (grimpeur naturel, descendeur prudent, etc.), remplaçant la classification manuelle
 * Grimpeur/Rouleur/Équilibré + Bon/Moyen/Faible descendeur.
 *
 * Un facteur de 1 signifie "conforme à la prédiction Minetti universelle". Un facteur < 1
 * signifie que l'athlète est plus rapide que prédit dans cette déclivité (meilleure économie
 * relative) ; > 1 qu'il est plus lent (moins bonne économie relative, ou prudence en descente).
 * Les facteurs sont bornés à [0.7, 1.3] pour éviter les dérives extrêmes en cas de reconnaissance
 * courte ou peu représentative.
 */
function computePersonalCalibration(segments, vitessePlatRef) {
  if (!vitessePlatRef || vitessePlatRef <= 0) {
    return { calibMontee: 1, calibDescente: 1, nbEchMontee: 0, nbEchDescente: 0 };
  }

  const echMontee = [];
  const echDescente = [];

  segments.forEach((seg) => {
    if (seg.vitesseMoy === null || seg.vitesseMoy === undefined) return;
    if (seg.penteMoy === null || seg.penteMoy === undefined) return;
    if (!seg.distanceKm || seg.distanceKm <= 0) return;

    const mult = minettiTimeMultiplier(seg.penteMoy);
    if (!mult || mult <= 0) return;

    const vitessePredite = vitessePlatRef / mult;
    if (vitessePredite <= 0) return;

    const ratioVitesse = seg.vitesseMoy / vitessePredite; // > 1 : plus rapide que la prédiction
    const poids = seg.distanceKm; // pondération par distance parcourue dans cette déclivité

    if (seg.type === 'montee') echMontee.push({ ratioVitesse, poids });
    else if (seg.type === 'descente') echDescente.push({ ratioVitesse, poids });
  });

  function weightedAvgRatio(ech) {
    const totalPoids = sum(ech.map((e) => e.poids));
    if (totalPoids <= 0) return null;
    return sum(ech.map((e) => e.ratioVitesse * e.poids)) / totalPoids;
  }

  const clamp = (f) => Math.max(0.7, Math.min(1.3, f));
  // Le facteur appliqué au TEMPS est l'inverse du ratio de VITESSE (plus rapide que prédit
  // => coefficient de temps plus petit).
  const rMontee = weightedAvgRatio(echMontee);
  const rDescente = weightedAvgRatio(echDescente);

  return {
    calibMontee: rMontee ? excelRound(clamp(1 / rMontee), 3) : 1,
    calibDescente: rDescente ? excelRound(clamp(1 / rDescente), 3) : 1,
    nbEchMontee: echMontee.length,
    nbEchDescente: echDescente.length,
  };
}

// ---------- 5. PROFILS ----------

function avgIfType(segments, type, field) {
  const vals = segments.filter((s) => s.type === type).map((s) => s[field]);
  return average(vals);
}

function computeProfils(segments, settings) {
  const vMontee = avgIfType(segments, 'montee', 'vitesseMoy');
  const vPlat = avgIfType(segments, 'plat', 'vitesseMoy');
  const vDescente = avgIfType(segments, 'descente', 'vitesseMoy');

  const vMonteeR = vMontee !== null ? excelRound(vMontee, 2) : null;
  const vPlatR = vPlat !== null ? excelRound(vPlat, 2) : null;
  const vDescenteR = vDescente !== null ? excelRound(vDescente, 2) : null;

  const ratioMonteePlat = (vMonteeR !== null && vPlatR !== null && vPlatR !== 0)
    ? excelRound(vMonteeR / vPlatR, 2) : null;
  const indiceDescente = (vDescenteR !== null && vPlatR !== null && vPlatR !== 0)
    ? excelRound(vDescenteR / vPlatR, 2) : null;

  // Étiquettes purement descriptives (affichage) — ne servent plus à chercher un coefficient
  // dans une table fixe : le coefficient de profil est désormais calculé en continu à partir de
  // la courbe de Minetti + calibration personnelle (voir computePersonalCalibration ci-dessus).
  let profilForceVitesse = 'Données insuffisantes';
  if (vMonteeR !== null && vPlatR !== null && vPlatR !== 0 && ratioMonteePlat !== null) {
    if (ratioMonteePlat > 0.55) profilForceVitesse = 'Grimpeur';
    else if (ratioMonteePlat > 0.38) profilForceVitesse = 'Équilibré';
    else profilForceVitesse = 'Rouleur';
  }

  let profilDescenteLabel = 'Données insuffisantes';
  if (vDescenteR !== null && vPlatR !== null && vPlatR !== 0 && indiceDescente !== null) {
    if (indiceDescente > 1.15) profilDescenteLabel = 'Bon descendeur';
    else if (indiceDescente > 0.85) profilDescenteLabel = 'Descendeur moyen';
    else profilDescenteLabel = 'Descendeur faible';
  }

  const calib = computePersonalCalibration(segments, vPlatR);

  const nbMontee = segments.filter((s) => s.type === 'montee').length;
  const nbPlat = segments.filter((s) => s.type === 'plat').length;
  const nbDescente = segments.filter((s) => s.type === 'descente').length;

  return {
    vitesseMontee: vMonteeR,
    vitessePlat: vPlatR,
    vitesseDescente: vDescenteR,
    ratioMonteePlat,
    indiceDescente,
    profilForceVitesse,
    profilDescente: profilDescenteLabel,
    calibMontee: calib.calibMontee,
    calibDescente: calib.calibDescente,
    nbEchMontee: calib.nbEchMontee,
    nbEchDescente: calib.nbEchDescente,
    profilComplet: (profilForceVitesse === 'Données insuffisantes' || profilDescenteLabel === 'Données insuffisantes')
      ? 'Compléter la reco — données insuffisantes'
      : `${profilForceVitesse} + ${profilDescenteLabel}`,
    nbMontee,
    nbPlat,
    nbDescente,
  };
}

// ---------- 5. PARAMÈTRES — champs auto ----------

function computeCourseAutoFields(csvRows) {
  const maxDistCum = csvRows.reduce((m, r) => Math.max(m, r.distance_cum_m || 0), 0);
  const distanceTotaleKm = excelRound(maxDistCum / 1000, 1);
  const dPlusTotal = excelRound(sum(csvRows.filter((r) => r.elevation_delta_m > 0).map((r) => r.elevation_delta_m)), 0);
  const dMinusTotal = excelRound(Math.abs(sum(csvRows.filter((r) => r.elevation_delta_m < 0).map((r) => r.elevation_delta_m))), 0);
  return { distanceTotaleKm, dPlusTotal, dMinusTotal };
}

// ---------- 6. PACING ----------

function lookupCoef(list, label) {
  const row = list.find((r) => r.label === label);
  return row ? row.coef : null;
}

/**
 * @param segments        résultat de buildSegments()
 * @param settings        objet settings (tables de coefficients, cf. data.js)
 * @param profils          résultat de computeProfils()
 * @param distanceTotaleKm distance totale de la course (PARAMÈTRES!C6)
 * @param categorieCourse  catégorie choisie (PARAMÈTRES!C9)
 * @param globalDefaults   { intensite, technicite, conditions } valeurs par défaut appliquées à tous les segments
 * @param rowOverrides     Map(numero -> { intensite, technicite, conditions, pause }) réglages individuels par segment
 */
function computePacing(segments, settings, profils, distanceTotaleKm, categorieCourse, globalDefaults, rowOverrides = {}) {
  const fatigueRow = settings.fatigue.find((f) => f.categorie === categorieCourse);
  const k = fatigueRow ? fatigueRow.k : 0;

  const rows = [];
  let cumDist = 0;
  let cumV1 = 0;
  let cumV2 = 0;

  for (const seg of segments) {
    const ov = rowOverrides[seg.numero] || {};
    const intensite = ov.intensite || globalDefaults.intensite;
    const technicite = ov.technicite || globalDefaults.technicite;
    const conditions = ov.conditions || globalDefaults.conditions;
    const pause = typeof ov.pause === 'number' ? ov.pause : 0;

    const coefIntensite = lookupCoef(settings.intensite, intensite);
    const coefTech = lookupCoef(settings.technicite, technicite);
    const coefCond = lookupCoef(settings.conditions, conditions);
    const coefTerrain = (coefTech !== null && coefCond !== null) ? excelRound(coefTech * coefCond, 3) : null;

    const distCumDebut = cumDist;
    const pctParcours = distanceTotaleKm > 0 ? distCumDebut / distanceTotaleKm : 0;
    const coefFatigue = excelRound(1 + k * Math.pow(pctParcours, 1.5), 3);

    const dureeGPS = seg.dureeMin !== null ? excelRound(seg.dureeMin, 1) : null;
    const tempsV1 = (dureeGPS !== null && coefIntensite !== null && coefTerrain !== null && coefFatigue !== null)
      ? excelRound(dureeGPS * coefIntensite * coefTerrain * coefFatigue, 1) : null;

    const totalSegV1 = tempsV1 !== null ? tempsV1 + pause : null;
    cumV1 = totalSegV1 !== null ? cumV1 + totalSegV1 : cumV1;

    // Coefficient de profil = courbe physiologique de Minetti (continue, fonction de la pente
    // moyenne réelle du segment) × calibration personnelle montée/descente de l'athlète (voir
    // computePersonalCalibration). Le plat n'a pas de facteur de calibration dédié : sa pente
    // moyenne réelle (proche de 0 mais rarement exactement nulle) est déjà prise en compte par
    // Minetti seul, puisque la vitesse plat de l'athlète sert justement de référence (mult = 1).
    const coefMinetti = excelRound(minettiTimeMultiplier(seg.penteMoy), 3);
    let coefCalibPerso = 1;
    if (seg.type === 'montee') coefCalibPerso = profils.calibMontee ?? 1;
    else if (seg.type === 'descente') coefCalibPerso = profils.calibDescente ?? 1;
    const coefProfil = excelRound(coefMinetti * coefCalibPerso, 3);

    const tempsV2 = tempsV1 !== null ? excelRound(tempsV1 * coefProfil, 1) : null;
    const totalSegV2 = tempsV2 !== null ? tempsV2 + pause : null;
    cumV2 = totalSegV2 !== null ? cumV2 + totalSegV2 : cumV2;

    rows.push({
      numero: seg.numero,
      nom: `Seg ${seg.numero} – ${seg.type}`,
      type: seg.type,
      distanceKm: seg.distanceKm,
      dPlus: seg.dPlus,
      dMinus: seg.dMinus,
      penteMoy: seg.penteMoy,
      dureeGPS,
      intensite, coefIntensite,
      technicite, coefTech,
      conditions, coefCond,
      coefTerrain,
      distCumDebut: excelRound(distCumDebut, 3),
      pctParcours,
      coefFatigue,
      tempsV1,
      pause,
      totalSegV1,
      cumulV1: totalSegV1 !== null ? cumV1 : null,
      cumulV1HM: formatHM(cumV1),
      coefMinetti,
      coefCalibPerso,
      coefProfil,
      tempsV2,
      totalSegV2,
      cumulV2: totalSegV2 !== null ? cumV2 : null,
      cumulV2HM: formatHM(cumV2),
    });

    cumDist += seg.distanceKm || 0;
  }

  const totals = {
    distanceKm: excelRound(sum(rows.map((r) => r.distanceKm)), 3),
    dPlus: excelRound(sum(rows.map((r) => r.dPlus)), 1),
    dMinus: excelRound(sum(rows.map((r) => r.dMinus)), 1),
    dureeGPS: excelRound(sum(rows.map((r) => r.dureeGPS)), 1),
    tempsV1: excelRound(sum(rows.map((r) => r.tempsV1)), 1),
    pause: excelRound(sum(rows.map((r) => r.pause)), 1),
    totalSegV1: excelRound(sum(rows.map((r) => r.totalSegV1)), 1),
    cumulV1: cumV1,
    cumulV1HM: formatHM(cumV1),
    tempsV2: excelRound(sum(rows.map((r) => r.tempsV2)), 1),
    totalSegV2: excelRound(sum(rows.map((r) => r.totalSegV2)), 1),
    cumulV2: cumV2,
    cumulV2HM: formatHM(cumV2),
  };

  return { rows, totals, k };
}

if (typeof module !== 'undefined') {
  module.exports = {
    excelRound, toNumber, average, sum, formatHM,
    parseImportCSV, assignSegmentGroups, buildSegments,
    minettiCostOfTransport, minettiTimeMultiplier, computePersonalCalibration,
    computeProfils, computeCourseAutoFields, computePacing,
  };
}
