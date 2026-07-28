/*
 * data.js — Tables de référence par défaut (issues de l'onglet PARAMÈTRES du fichier Excel V3).
 * Toutes ces valeurs sont éditables par l'utilisateur dans l'onglet "Paramètres" de l'application ;
 * elles sont alors sauvegardées dans le localStorage du navigateur.
 */

const DEFAULT_SETTINGS = {
  course: {
    nom: 'Trail de reconnaissance 2026',
    categorie: '< 30 km', // liste : voir FATIGUE_TABLE
  },

  // Facteur de fatigue (k) par catégorie de course. Formule : Coef = 1 + k × (%parcours)^1.5
  fatigue: [
    { categorie: '< 30 km', k: 0.10, max: '+10% max', description: 'Courses courtes — fatigue modérée' },
    { categorie: '30 - 60 km', k: 0.20, max: '+20% max', description: 'Semi-marathon et marathon montagne' },
    { categorie: '60 - 100 km', k: 0.35, max: '+35% max', description: 'Courses longues — fatigue marquée' },
    { categorie: '> 100 km (ultra)', k: 0.55, max: '+55% max', description: 'Ultra trail — fatigue sévère' },
  ],

  // Coefficients d'intensité de reconnaissance. Coef < 1 => plus rapide que la reco.
  intensite: [
    { label: 'Plus rapide que course', coef: 1.10, pct: '+10%', description: 'Reconn. plus rapide que le jour J' },
    { label: 'Allure course', coef: 1.00, pct: 'identique reco', description: 'Même allure que prévu en course' },
    { label: 'Modéré (entraînement)', coef: 0.90, pct: '-10%', description: 'Allure entraînement confortable' },
    { label: 'Facile (endurance)', coef: 0.78, pct: '-22%', description: 'Allure fondamentale, endurance de base' },
    { label: 'Très facile (récup)', coef: 0.65, pct: '-35%', description: 'Allure très lente, exploration' },
    { label: 'Marche / rando', coef: 0.50, pct: '-50%', description: 'Marche nordique ou randonnée' },
  ],

  // Coefficients de technicité du terrain.
  technicite: [
    { label: 'Facile (chemin large)', coef: 1.00, description: 'Chemin forestier, piste entretenue' },
    { label: 'Modérée (singletrack)', coef: 1.05, description: 'Singletrack, quelques racines ou pierres' },
    { label: 'Difficile (technique)', coef: 1.12, description: 'Pierriers, souches, passages exigeants' },
    { label: 'Très difficile', coef: 1.22, description: 'Éscalade, falaises, haute montagne' },
  ],

  // Coefficients conditions terrain / météo.
  conditions: [
    { label: 'Sec, bon sol', coef: 1.00, description: 'Conditions idéales' },
    { label: 'Humide / sol stable', coef: 1.06, description: 'Après pluie, sol compact' },
    { label: 'Boue légère', coef: 1.12, description: 'Sol détrempé localement' },
    { label: 'Boue lourde', coef: 1.20, description: 'Sol très boueux' },
    { label: 'Nuit - bon sol', coef: 1.07, description: 'Éclairage frontal, perte de repères' },
    { label: 'Nuit + humide', coef: 1.13, description: 'Nuit et conditions humides' },
    { label: 'Chaleur (25-30°C)', coef: 1.08, description: 'Chaleur modérée' },
    { label: 'Chaleur forte (>30°C)', coef: 1.15, description: 'Chaleur sévère' },
    { label: 'Neige tassée', coef: 1.18, description: 'Neige dure ou partiellement fondue' },
  ],

  // Coefficients profil force-vitesse (montée/plat/mixte). Seuils de classification : voir engine.js
  profilForceVitesse: [
    { profil: 'Grimpeur', montee: 0.93, plat: 1.05, mixte: 0.97 },
    { profil: 'Équilibré', montee: 1.00, plat: 1.00, mixte: 1.00 },
    { profil: 'Rouleur', montee: 1.08, plat: 0.95, mixte: 1.03 },
  ],

  // Coefficients profil descente.
  profilDescente: [
    { profil: 'Bon descendeur', coef: 0.92, gain: '-8%', description: 'Vitesse descente +8 % — exploiter les descentes' },
    { profil: 'Descendeur moyen', coef: 1.00, gain: '0%', description: 'Pas d’ajustement — rythme standard' },
    { profil: 'Descendeur faible', coef: 1.10, gain: '+10%', description: 'Prudence en descente — prévoir plus de temps' },
  ],
};

// Options de catégorie de course (liste déroulante PARAMÈTRES!C9)
const CATEGORIE_OPTIONS = ['< 30 km', '30 - 60 km', '60 - 100 km', '> 100 km (ultra)'];

// Colonnes attendues dans le CSV importé (IMPORT_CSV, 16 colonnes)
const IMPORT_CSV_COLUMNS = [
  'point_index', 'time', 'latitude', 'longitude', 'altitude_m',
  'distance_step_m', 'distance_cum_m', 'time_step_s', 'speed_m_s', 'speed_km_h',
  'elevation_delta_m', 'slope_percent_raw', 'segment_type_raw',
  'slope_percent_smooth_5pts', 'speed_km_h_smooth_5pts', 'segment_type_smooth',
];

if (typeof module !== 'undefined') {
  module.exports = { DEFAULT_SETTINGS, CATEGORIE_OPTIONS, IMPORT_CSV_COLUMNS };
}
