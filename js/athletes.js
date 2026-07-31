/*
 * athletes.js — Gestion des profils athlètes et de leurs estimations enregistrées.
 * Pure logique de données (aucune manipulation du DOM ici) ; persistance via localStorage.
 */

const ATHLETES_STORAGE_KEY = 'trail-pacing-predictor:athletes';

function loadAthletes() {
  try {
    const raw = localStorage.getItem(ATHLETES_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return [];
}

function saveAthletes(athletes) {
  try {
    localStorage.setItem(ATHLETES_STORAGE_KEY, JSON.stringify(athletes));
    return true;
  } catch (e) {
    return false;
  }
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createAthlete({ prenom, nom, age, tailleCm, poidsKg, vmaKmh }) {
  return {
    id: makeId(),
    prenom: prenom || '',
    nom: nom || '',
    age: age || null,
    tailleCm: tailleCm || null,
    poidsKg: poidsKg || null,
    vmaKmh: vmaKmh || null,
    estimations: [],
  };
}

function athleteFullName(athlete) {
  return [athlete.prenom, athlete.nom].filter(Boolean).join(' ') || 'Athlète sans nom';
}

/**
 * Échantillonne le profil altimétrique (distance cumulée en km / altitude en m) à partir des points
 * GPS bruts d'un import — au plus `maxPoints` points, répartis régulièrement le long du parcours.
 * Bien plus léger à stocker que les points bruts complets (qui peuvent représenter plusieurs Mo sur
 * une grosse reconnaissance, ex. import FIT multi-parties), tout en gardant un profil fidèle au
 * relief réel (contrairement à la reconstruction approximative depuis les seuls D+/D- des segments).
 * Retourne `null` si les données sont insuffisantes.
 */
function downsampleElevationProfile(csvRows, maxPoints = 400) {
  if (!csvRows || csvRows.length < 2) return null;
  const step = Math.max(1, Math.floor(csvRows.length / maxPoints));
  const points = [];
  for (let i = 0; i < csvRows.length; i += step) {
    const r = csvRows[i];
    if (typeof r.distance_cum_m === 'number' && typeof r.altitude_m === 'number') {
      points.push({ distKm: r.distance_cum_m / 1000, alt: r.altitude_m });
    }
  }
  const last = csvRows[csvRows.length - 1];
  if (last && typeof last.distance_cum_m === 'number' && typeof last.altitude_m === 'number') {
    const lastKm = last.distance_cum_m / 1000;
    if (!points.length || points[points.length - 1].distKm !== lastKm) {
      points.push({ distKm: lastKm, alt: last.altitude_m });
    }
  }
  return points.length >= 2 ? points : null;
}

/**
 * Construit un instantané (snapshot) de l'état courant de l'application, destiné à être enregistré
 * dans le profil d'un athlète. Ne contient pas les points GPS bruts complets (trop volumineux) —
 * uniquement les segments déjà agrégés, le profil calculé, les réglages, les résultats du pacing, et
 * un profil altimétrique échantillonné (léger) pour que le PDF reste précis même après rechargement.
 */
function buildEstimationSnapshot(state) {
  return {
    id: makeId(),
    dateCreated: new Date().toISOString(),
    courseNom: state.courseNom,
    categorie: state.categorie,
    auto: { ...state.auto },
    segments: state.segments,
    profils: state.profils,
    globalDefaults: { ...state.globalDefaults },
    rowOverrides: JSON.parse(JSON.stringify(state.rowOverrides)),
    rowMeta: JSON.parse(JSON.stringify(state.rowMeta)),
    pacingTotals: state.pacing ? state.pacing.totals : null,
    elevationProfile: state.elevationProfile || downsampleElevationProfile(state.csvRows),
    // Profil altimétrique du GPX officiel de la course, s'il a été chargé — prioritaire sur celui de la
    // reconnaissance GPS pour le PDF (cf. buildElevationProfile dans pdf-export.js).
    gpxElevationProfile: state.gpxElevationProfile || null,
  };
}

function addEstimationToAthlete(athletes, athleteId, snapshot) {
  const athlete = athletes.find((a) => a.id === athleteId);
  if (!athlete) return false;
  athlete.estimations.unshift(snapshot); // le plus récent en premier
  return true;
}

/**
 * Met à jour une estimation déjà enregistrée (même id, même date de création) au lieu d'en créer une
 * nouvelle — utilisé quand on a rechargé une estimation existante ("📂 Charger") pour la retoucher et
 * qu'on veut enregistrer les changements sur cette même entrée plutôt que d'en accumuler une copie.
 */
function updateEstimationInAthlete(athletes, athleteId, estimationId, snapshot) {
  const athlete = athletes.find((a) => a.id === athleteId);
  if (!athlete) return false;
  const idx = athlete.estimations.findIndex((e) => e.id === estimationId);
  if (idx === -1) return false;
  const original = athlete.estimations[idx];
  athlete.estimations[idx] = {
    ...snapshot,
    id: estimationId,
    dateCreated: original.dateCreated,
    dateModified: new Date().toISOString(),
  };
  return true;
}

function deleteEstimation(athletes, athleteId, estimationId) {
  const athlete = athletes.find((a) => a.id === athleteId);
  if (!athlete) return false;
  athlete.estimations = athlete.estimations.filter((e) => e.id !== estimationId);
  return true;
}

function deleteAthlete(athletes, athleteId) {
  return athletes.filter((a) => a.id !== athleteId);
}

if (typeof module !== 'undefined') {
  module.exports = {
    loadAthletes, saveAthletes, createAthlete, athleteFullName, downsampleElevationProfile,
    buildEstimationSnapshot, addEstimationToAthlete, updateEstimationInAthlete, deleteEstimation, deleteAthlete, makeId,
  };
}
