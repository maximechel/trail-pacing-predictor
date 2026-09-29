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
 * Les facteurs sont bornés à [0.85, 1.15] (± 15 %, du même ordre de grandeur que l'ancien système
 * à tables fixes) pour rester un ajustement fin et éviter les dérives en cas de reconnaissance
 * courte ou peu représentative — la difficulté de la pente elle-même est déjà intégralement
 * présente dans la durée mesurée sur le terrain (dureeGPS), ce facteur ne fait que la nuancer.
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

  const clamp = (f) => Math.max(0.85, Math.min(1.15, f));
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

// ---------- 6. PARAMÈTRES — champs auto ----------

function computeCourseAutoFields(csvRows) {
  const maxDistCum = csvRows.reduce((m, r) => Math.max(m, r.distance_cum_m || 0), 0);
  const distanceTotaleKm = excelRound(maxDistCum / 1000, 1);
  const dPlusTotal = excelRound(sum(csvRows.filter((r) => r.elevation_delta_m > 0).map((r) => r.elevation_delta_m)), 0);
  const dMinusTotal = excelRound(Math.abs(sum(csvRows.filter((r) => r.elevation_delta_m < 0).map((r) => r.elevation_delta_m))), 0);
  return { distanceTotaleKm, dPlusTotal, dMinusTotal };
}

// ---------- 7. PACING ----------

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

    // Coefficient de profil = calibration personnelle montée/descente de l'athlète (voir
    // computePersonalCalibration), un correctif MODESTE et borné (±15 %) appliqué au temps V1.
    // Important : dureeGPS vient de la reconnaissance GPS RÉELLE de l'athlète sur ce segment
    // précis — la difficulté de la pente y est donc déjà intégralement présente (un segment
    // raide a mécaniquement une dureeGPS mesurée plus longue). Le rôle de ce coefficient n'est
    // pas de re-modéliser l'effet de la pente depuis zéro (la courbe de Minetti sert uniquement,
    // en amont, à calculer CE facteur de calibration dans computePersonalCalibration, pas à
    // multiplier une seconde fois le temps mesuré) : c'est un ajustement fin qui reflète une
    // tendance personnelle constatée (ex. descend un peu plus prudemment que ce que sa vitesse
    // plat laisserait supposer), du même ordre de grandeur que l'ancien système à tables fixes.
    let coefProfil = 1;
    if (seg.type === 'montee') coefProfil = profils.calibMontee ?? 1;
    else if (seg.type === 'descente') coefProfil = profils.calibDescente ?? 1;

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

// ---------- 8. TABLEAU KILOMÈTRE PAR KILOMÈTRE (contrôle + corrections manuelles) ----------

/** Ajoute à chaque segment son intervalle de distance cumulée [kmStart, kmEnd) en km. */
function segmentsWithKmRange(segments) {
  let cum = 0;
  return segments.map((s) => {
    const kmStart = cum;
    const dist = s.distanceKm || 0;
    cum += dist;
    return { seg: s, kmStart, kmEnd: cum };
  });
}

/**
 * Construit le tableau kilomètre par kilomètre à partir des SEGMENTS mesurés (bruts, non corrigés) —
 * une vue de contrôle qui permet de repérer d'éventuelles erreurs de parcours lors de la
 * reconnaissance (arrêt GPS non détecté, saut de distance/altitude...). Chaque segment (montée/
 * plat/descente — plus court ou, parfois, plus long qu'un kilomètre) est réparti au prorata de sa
 * distance sur le ou les kilomètres qu'il chevauche.
 */
function buildKmTable(segments) {
  const withRange = segmentsWithKmRange(segments);
  const totalKm = withRange.length ? withRange[withRange.length - 1].kmEnd : 0;
  const nBins = Math.ceil(totalKm - 1e-9);
  const bins = [];
  for (let k = 0; k < nBins; k++) {
    const binStart = k;
    const binEnd = Math.min(k + 1, totalKm);
    let distanceKm = 0, dPlus = 0, dMinus = 0, dureeMin = 0;
    let montee = 0, plat = 0, descente = 0;
    withRange.forEach(({ seg, kmStart, kmEnd }) => {
      const overlap = Math.min(kmEnd, binEnd) - Math.max(kmStart, binStart);
      if (overlap <= 0) return;
      const segLen = kmEnd - kmStart;
      const frac = segLen > 0 ? overlap / segLen : 0;
      distanceKm += overlap;
      dPlus += (seg.dPlus || 0) * frac;
      dMinus += (seg.dMinus || 0) * frac;
      dureeMin += (seg.dureeMin || 0) * frac;
      if (seg.type === 'montee') montee += overlap;
      else if (seg.type === 'descente') descente += overlap;
      else plat += overlap;
    });
    const vitesseMoy = dureeMin > 0 ? excelRound((distanceKm / dureeMin) * 60, 2) : null;
    const penteMoy = distanceKm > 0 ? excelRound(((dPlus - dMinus) / (distanceKm * 1000)) * 100, 1) : null;
    bins.push({
      kmIndex: k,
      kmFin: excelRound(binEnd, 3),
      distanceKm: excelRound(distanceKm, 3),
      dPlus: excelRound(dPlus, 1),
      dMinus: excelRound(dMinus, 1),
      dureeMin: excelRound(dureeMin, 2),
      vitesseMoy,
      penteMoy,
      montee: excelRound(montee, 3),
      plat: excelRound(plat, 3),
      descente: excelRound(descente, 3),
    });
  }
  return bins;
}

/**
 * Applique les corrections manuelles saisies km par km (`kmOverrides`, objet indexé par `kmIndex`)
 * aux SEGMENTS mesurés, pour produire une version corrigée à transmettre à computeProfils/
 * computePacing à la place des segments bruts. Champs possibles par entrée de
 * `kmOverrides[kmIndex]` : `distanceKm`, `dPlus`, `dMinus`, `dureeMin` (chacun optionnel — un champ
 * non renseigné = valeur mesurée conservée pour ce kilomètre) et `deleted` (true = kilomètre
 * entièrement exclu du calcul, quels que soient les autres champs).
 *
 * Principe : pour chaque kilomètre corrigé, l'écart entre valeur corrigée et valeur mesurée (ou la
 * valeur mesurée entière si le kilomètre est supprimé) est réparti entre les segments qui
 * chevauchent ce kilomètre, au prorata de leur contribution mesurée à ce kilomètre précis (ou, si
 * cette contribution était nulle — ex. D+ ajouté sur un kilomètre qui n'en avait mesuré aucun —, au
 * prorata de leur simple chevauchement en distance). Un segment qui ne chevauche aucun kilomètre
 * corrigé n'est pas modifié ; un segment qui chevauche plusieurs kilomètres ne subit l'ajustement
 * que sur la portion concernée.
 */
function applyKmOverrides(segments, kmOverrides) {
  if (!kmOverrides || Object.keys(kmOverrides).length === 0) return segments;

  const withRange = segmentsWithKmRange(segments);
  const totalKm = withRange.length ? withRange[withRange.length - 1].kmEnd : 0;
  const nBins = Math.ceil(totalKm - 1e-9);

  // 1. Pour chaque kilomètre concerné par une correction, calcule la contribution mesurée de
  //    chaque segment qui le chevauche (portion de distance/D+/D-/durée).
  const binPortions = {}; // kmIndex -> [{ idx, overlap, pDist, pDPlus, pDMinus, pDuree }]
  const binTotals = {};   // kmIndex -> { distanceKm, dPlus, dMinus, dureeMin } (mesurés)

  withRange.forEach(({ seg, kmStart, kmEnd }, idx) => {
    const segLen = kmEnd - kmStart;
    const kFrom = Math.max(0, Math.floor(kmStart));
    const kTo = Math.min(nBins - 1, Math.ceil(kmEnd - 1e-9) - 1);
    for (let k = kFrom; k <= kTo; k++) {
      if (!kmOverrides[k]) continue;
      const binStart = k;
      const binEnd = Math.min(k + 1, totalKm);
      const overlap = Math.min(kmEnd, binEnd) - Math.max(kmStart, binStart);
      if (overlap <= 0) continue;
      const frac = segLen > 0 ? overlap / segLen : 0;
      const portion = {
        idx, overlap,
        pDist: overlap,
        pDPlus: (seg.dPlus || 0) * frac,
        pDMinus: (seg.dMinus || 0) * frac,
        pDuree: (seg.dureeMin || 0) * frac,
      };
      if (!binPortions[k]) binPortions[k] = [];
      binPortions[k].push(portion);
      if (!binTotals[k]) binTotals[k] = { distanceKm: 0, dPlus: 0, dMinus: 0, dureeMin: 0 };
      binTotals[k].distanceKm += portion.pDist;
      binTotals[k].dPlus += portion.pDPlus;
      binTotals[k].dMinus += portion.pDMinus;
      binTotals[k].dureeMin += portion.pDuree;
    }
  });

  // 2. Pour chaque segment, accumule le delta net (distance/D+/D-/durée) résultant de tous les
  //    kilomètres corrigés qu'il chevauche.
  const deltaByIdx = {};
  function addDelta(idx, field, value) {
    if (!deltaByIdx[idx]) deltaByIdx[idx] = { distanceKm: 0, dPlus: 0, dMinus: 0, dureeMin: 0 };
    deltaByIdx[idx][field] += value;
  }
  const FIELD_PORTION_KEY = { distanceKm: 'pDist', dPlus: 'pDPlus', dMinus: 'pDMinus', dureeMin: 'pDuree' };

  Object.keys(binPortions).forEach((kStr) => {
    const k = Number(kStr);
    const ov = kmOverrides[k];
    const portions = binPortions[k];
    const base = binTotals[k];

    if (ov && ov.deleted) {
      // Suppression complète du kilomètre : chaque segment perd exactement sa portion mesurée ici.
      portions.forEach((p) => {
        addDelta(p.idx, 'distanceKm', -p.pDist);
        addDelta(p.idx, 'dPlus', -p.pDPlus);
        addDelta(p.idx, 'dMinus', -p.pDMinus);
        addDelta(p.idx, 'dureeMin', -p.pDuree);
      });
      return;
    }

    Object.keys(FIELD_PORTION_KEY).forEach((field) => {
      const overrideVal = ov ? ov[field] : null;
      if (overrideVal === null || overrideVal === undefined || overrideVal === '') return;
      const baseVal = base[field];
      const delta = overrideVal - baseVal;
      if (delta === 0) return;
      const fieldKey = FIELD_PORTION_KEY[field];
      const distWeightDenom = base.distanceKm > 0 ? base.distanceKm : portions.length;
      portions.forEach((p) => {
        const weight = baseVal > 0 ? (p[fieldKey] / baseVal) : (p.overlap / distWeightDenom);
        addDelta(p.idx, field, delta * weight);
      });
    });
  });

  // 3. Applique les deltas cumulés à chaque segment concerné (les segments non concernés sont
  //    renvoyés tels quels, avec la même référence — numero/type préservés pour ne pas casser le
  //    lien avec les réglages par ligne du Pacing, indexés par numero).
  return segments.map((seg, idx) => {
    const d = deltaByIdx[idx];
    if (!d) return seg;
    const distanceKm = Math.max(0, excelRound((seg.distanceKm || 0) + d.distanceKm, 3));
    const dPlus = Math.max(0, excelRound((seg.dPlus || 0) + d.dPlus, 1));
    const dMinus = Math.max(0, excelRound((seg.dMinus || 0) + d.dMinus, 1));
    const dureeMin = Math.max(0, excelRound((seg.dureeMin || 0) + d.dureeMin, 2));
    const vitesseMoy = dureeMin > 0 ? excelRound((distanceKm / dureeMin) * 60, 2) : null;
    const penteMoy = distanceKm > 0 ? excelRound(((dPlus - dMinus) / (distanceKm * 1000)) * 100, 1) : seg.penteMoy;
    return { ...seg, distanceKm, dPlus, dMinus, dureeMin, vitesseMoy, penteMoy };
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    excelRound, toNumber, average, sum, formatHM,
    parseImportCSV, assignSegmentGroups, buildSegments,
    minettiCostOfTransport, minettiTimeMultiplier, computePersonalCalibration,
    computeProfils, computeCourseAutoFields, computePacing,
    buildKmTable, applyKmOverrides,
  };
}
