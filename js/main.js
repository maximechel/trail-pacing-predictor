/* main.js — Bootstrap de l'application : état, orchestration, événements. */

const STORAGE_KEY_SETTINGS = 'trail-pacing-predictor:settings';
const STORAGE_KEY_STATE = 'trail-pacing-predictor:state';

const state = {
  settings: null,       // tables de coefficients (cf. data.js), modifiable par l'utilisateur
  csvRows: null,         // lignes IMPORT_CSV parsées
  segments: [],          // résultat SEGMENTS
  profils: null,         // résultat PROFILS
  auto: { distanceTotaleKm: 0, dPlusTotal: 0, dMinusTotal: 0 },
  categorie: '< 30 km',
  courseNom: 'Trail de reconnaissance 2026',
  globalDefaults: { intensite: 'Facile (endurance)', technicite: 'Modérée (singletrack)', conditions: 'Sec, bon sol' },
  rowOverrides: {},       // { [numero]: { intensite, technicite, conditions, pause } }
  pacing: null,
  showAdvanced: false,
};

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return deepClone(DEFAULT_SETTINGS);
}

function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(state.settings)); } catch (e) { /* ignore */ }
}

function suggestCategorie(distanceKm) {
  if (distanceKm < 30) return '< 30 km';
  if (distanceKm <= 60) return '30 - 60 km';
  if (distanceKm <= 100) return '60 - 100 km';
  return '> 100 km (ultra)';
}

function recomputeAll() {
  if (state.csvRows) {
    state.auto = computeCourseAutoFields(state.csvRows);
    const grouped = assignSegmentGroups(state.csvRows);
    state.segments = buildSegments(grouped);
    state.profils = computeProfils(state.segments, state.settings);
  } else {
    state.segments = [];
    state.profils = null;
  }

  state.pacing = state.segments.length
    ? computePacing(
        state.segments, state.settings, state.profils || { coefMontee: 1, coefPlat: 1, coefMixte: 1, coefDescente: 1 },
        state.auto.distanceTotaleKm, state.categorie, state.globalDefaults, state.rowOverrides,
      )
    : null;

  renderAll();
}

function renderAll() {
  // Résumé header
  const summary = $('#course-summary');
  if (state.segments.length) {
    summary.textContent = `Course : ${state.courseNom} | ${fmt(state.auto.distanceTotaleKm, 1)} km | D+ ${fmt(state.auto.dPlusTotal, 0)} m | Catégorie : ${state.categorie} | Profil : ${state.profils.profilForceVitesse} + ${state.profils.profilDescente}`;
  } else {
    summary.textContent = 'Importez un CSV de reconnaissance GPS pour commencer.';
  }

  // Paramètres
  $('#param-nom').value = state.courseNom;
  $('#param-distance').value = state.segments.length ? `${fmt(state.auto.distanceTotaleKm, 1)} km` : '—';
  $('#param-dplus').value = state.segments.length ? `${fmt(state.auto.dPlusTotal, 0)} m` : '—';
  $('#param-dminus').value = state.segments.length ? `${fmt(state.auto.dMinusTotal, 0)} m` : '—';
  populateSelect($('#param-categorie'), CATEGORIE_OPTIONS, state.categorie);
  const fatigueRow = state.settings.fatigue.find((f) => f.categorie === state.categorie);
  $('#param-k').value = fatigueRow ? String(fatigueRow.k) : '—';

  renderAllCoefTables(state.settings, () => { saveSettings(); recomputeAll(); });

  // Segments
  renderSegmentsTable(state.segments);

  // Profils
  renderProfils(state.profils);

  // Pacing — réglages globaux
  populateSelect($('#global-intensite'), state.settings.intensite, state.globalDefaults.intensite);
  populateSelect($('#global-technicite'), state.settings.technicite, state.globalDefaults.technicite);
  populateSelect($('#global-conditions'), state.settings.conditions, state.globalDefaults.conditions);

  renderPacingTable(state.pacing, state.settings, state.showAdvanced);
}

// ---------- Import FIT ----------

let lastFitCsvText = null;

function wireFitTab() {
  $('#fit-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = $('#fit-status');
    const summaryEl = $('#fit-summary');
    const actionsEl = $('#fit-actions');
    summaryEl.style.display = 'none';
    actionsEl.style.display = 'none';
    statusEl.className = 'status';
    statusEl.textContent = `⏳ Lecture de ${file.name}…`;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const { points, pointCount } = parseFitPoints(reader.result);
        if (pointCount < 2) {
          throw new Error("Aucune donnée GPS (latitude/longitude) trouvée dans ce fichier .fit. Vérifiez qu'il s'agit bien d'un enregistrement avec suivi GPS.");
        }
        const rows = buildImportRowsFromPoints(points);
        lastFitCsvText = importRowsToCSVText(rows);

        const distanceKm = (rows[rows.length - 1].distance_cum_m / 1000);
        const durationMin = rows.reduce((a, r) => a + (r.time_step_s || 0), 0) / 60;

        statusEl.className = 'status ok';
        statusEl.textContent = `✔ ${pointCount} points GPS lus et convertis avec succès.`;

        summaryEl.innerHTML = '';
        summaryEl.style.display = 'grid';
        [
          ['Points GPS', String(pointCount)],
          ['Distance estimée', `${fmt(distanceKm, 2)} km`],
          ['Durée', `${fmt(durationMin, 1)} min`],
        ].forEach(([label, value]) => {
          summaryEl.appendChild(el('label', {}, [label, el('input', { type: 'text', value, readonly: 'true' })]));
        });
        actionsEl.style.display = 'flex';
      } catch (err) {
        statusEl.className = 'status error';
        statusEl.textContent = `✖ ${err.message}`;
        lastFitCsvText = null;
      }
    };
    reader.onerror = () => {
      statusEl.className = 'status error';
      statusEl.textContent = "✖ Impossible de lire ce fichier.";
    };
    reader.readAsArrayBuffer(file);
  });

  $('#fit-send-btn').addEventListener('click', () => {
    if (!lastFitCsvText) return;
    $('#csv-textarea').value = lastFitCsvText;
    analyzeCSV(lastFitCsvText);
  });

  $('#fit-download-btn').addEventListener('click', () => {
    if (!lastFitCsvText) return;
    const blob = new Blob(['﻿' + lastFitCsvText], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'import_gps.csv';
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ---------- Import CSV ----------

function analyzeCSV(text) {
  const statusEl = $('#import-status');
  try {
    const rows = parseImportCSV(text);
    state.csvRows = rows;
    state.rowOverrides = {};
    const auto = computeCourseAutoFields(rows);
    state.categorie = suggestCategorie(auto.distanceTotaleKm);
    statusEl.className = 'status ok';
    statusEl.textContent = `✔ ${rows.length} points GPS importés.`;
    recomputeAll();
    goToTab('segments');
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = `✖ ${err.message}`;
  }
}

function wireImportTab() {
  $('#analyze-btn').addEventListener('click', () => {
    const text = $('#csv-textarea').value.trim();
    if (!text) {
      const statusEl = $('#import-status');
      statusEl.className = 'status error';
      statusEl.textContent = '✖ Collez ou chargez un CSV avant d\'analyser.';
      return;
    }
    analyzeCSV(text);
  });

  $('#csv-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      $('#csv-textarea').value = reader.result;
      analyzeCSV(reader.result);
    };
    reader.readAsText(file, 'UTF-8');
  });

  $('#load-example-btn').addEventListener('click', async () => {
    try {
      const res = await fetch('sample-data/exemple_import.csv');
      const text = await res.text();
      $('#csv-textarea').value = text;
      analyzeCSV(text);
    } catch (e) {
      const statusEl = $('#import-status');
      statusEl.className = 'status error';
      statusEl.textContent = "✖ Impossible de charger l'exemple.";
    }
  });

  $('#clear-btn').addEventListener('click', () => {
    $('#csv-textarea').value = '';
    state.csvRows = null;
    state.segments = [];
    state.profils = null;
    state.pacing = null;
    state.rowOverrides = {};
    $('#import-status').textContent = '';
    recomputeAll();
  });
}

// ---------- Paramètres ----------

function wireParametresTab() {
  $('#param-nom').addEventListener('input', (e) => {
    state.courseNom = e.target.value;
    const summary = $('#course-summary');
    if (state.segments.length) {
      summary.textContent = `Course : ${state.courseNom} | ${fmt(state.auto.distanceTotaleKm, 1)} km | D+ ${fmt(state.auto.dPlusTotal, 0)} m | Catégorie : ${state.categorie} | Profil : ${state.profils.profilForceVitesse} + ${state.profils.profilDescente}`;
    }
  });
  $('#param-categorie').addEventListener('change', (e) => { state.categorie = e.target.value; recomputeAll(); });
  $('#reset-settings-btn').addEventListener('click', () => {
    if (!confirm('Réinitialiser toutes les tables de coefficients aux valeurs par défaut ?')) return;
    state.settings = deepClone(DEFAULT_SETTINGS);
    saveSettings();
    recomputeAll();
  });
}

// ---------- Pacing ----------

function wirePacingTab() {
  $('#global-intensite').addEventListener('change', (e) => { state.globalDefaults.intensite = e.target.value; renderAll(); });
  $('#global-technicite').addEventListener('change', (e) => { state.globalDefaults.technicite = e.target.value; renderAll(); });
  $('#global-conditions').addEventListener('change', (e) => { state.globalDefaults.conditions = e.target.value; renderAll(); });

  $('#apply-global-btn').addEventListener('click', () => {
    state.rowOverrides = {};
    recomputeAll();
  });

  $('#toggle-full-columns').addEventListener('change', (e) => {
    state.showAdvanced = e.target.checked;
    renderPacingTable(state.pacing, state.settings, state.showAdvanced);
  });

  // Délégation d'événements sur le tableau pacing (dropdowns + pauses par segment)
  $('#pacing-table').addEventListener('change', (e) => {
    const target = e.target;
    const seg = target.dataset.seg;
    const field = target.dataset.field;
    if (!seg || !field) return;
    if (!state.rowOverrides[seg]) state.rowOverrides[seg] = {};
    if (field === 'pause') {
      state.rowOverrides[seg].pause = parseFloat(target.value) || 0;
    } else {
      state.rowOverrides[seg][field] = target.value;
    }
    recomputeAll();
  });

  $('#export-csv-btn').addEventListener('click', () => {
    if (!state.pacing) return;
    const csv = pacingToCSVString(state.pacing);
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pacing.csv';
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ---------- Bootstrap ----------

function init() {
  state.settings = loadSettings();
  initTabs();
  wireFitTab();
  wireImportTab();
  wireParametresTab();
  wirePacingTab();
  renderAll();
}

document.addEventListener('DOMContentLoaded', init);
