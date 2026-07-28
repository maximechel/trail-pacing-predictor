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
 * Construit un instantané (snapshot) de l'état courant de l'application, destiné à être enregistré
 * dans le profil d'un athlète. Ne contient pas les points GPS bruts (trop volumineux) : uniquement
 * les segments déjà agrégés, le profil calculé, les réglages et les résultats du pacing.
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
  };
}

function addEstimationToAthlete(athletes, athleteId, snapshot) {
  const athlete = athletes.find((a) => a.id === athleteId);
  if (!athlete) return false;
  athlete.estimations.unshift(snapshot); // le plus récent en premier
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
    loadAthletes, saveAthletes, createAthlete, athleteFullName,
    buildEstimationSnapshot, addEstimationToAthlete, deleteEstimation, deleteAthlete, makeId,
  };
}
