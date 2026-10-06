/* main.js — Bootstrap de l'application : état, orchestration, événements. */

const STORAGE_KEY_SETTINGS = 'trail-pacing-predictor:settings';
const STORAGE_KEY_STATE = 'trail-pacing-predictor:state';
const STORAGE_KEY_LOGO = 'trail-pacing-predictor:logo';
const DEFAULT_LOGO_SRC = 'assets/logo.png';

const state = {
  settings: null,       // tables de coefficients (cf. data.js), modifiable par l'utilisateur
  csvRows: null,         // lignes IMPORT_CSV parsées
  elevationProfile: null, // profil altimétrique échantillonné (repli quand csvRows est absent, ex. estimation rechargée)
  gpxElevationProfile: null, // profil altimétrique du GPX officiel de la course, si chargé (prioritaire sur celui du FIT)
  segments: [],          // résultat SEGMENTS
  profils: null,         // résultat PROFILS
  auto: { distanceTotaleKm: 0, dPlusTotal: 0, dMinusTotal: 0 },
  categorie: '< 30 km',
  courseNom: 'Trail de reconnaissance 2026',
  heureDepart: null,     // heure de départ officielle ("HH:MM"), pour calculer l'heure de passage à chaque repère du PDF
  globalDefaults: { intensite: 'Facile (endurance)', technicite: 'Modérée (singletrack)', conditions: 'Sec, bon sol' },
  rowOverrides: {},       // { [numero]: { intensite, technicite, conditions, pause } }
  rowMeta: {},            // { [numero]: { selected, label } } — purement présentationnel (repères, export)
  kmOverrides: {},        // { [kmIndex]: { distanceKm, dPlus, dMinus, dureeMin, deleted, note } } — corrections manuelles km par km
  segmentOverrides: {},   // { [numero]: { deleted } } — segments supprimés depuis l'onglet Segments
  kmTable: [],            // tableau km par km MESURÉ (brut), reconstruit à chaque recomputeAll()
  effectiveSegments: [],  // segments après application de kmOverrides — utilisés pour profils/pacing (segments = version brute, pour la référence)
  pacing: null,
  showAdvanced: false,
  athletes: [],           // profils athlètes (cf. athletes.js)
  activeAthleteId: null,
  editingAthleteId: null, // id en cours de modification dans le formulaire (null = création)
  loadedEstimationId: null, // id de l'estimation chargée depuis l'historique d'un athlète (null = nouvelle estimation)
};

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

/*
 * Brouillon de travail en cours : contrairement aux onglets internes de l'app (qui ne font que
 * masquer/afficher des sections — l'état JS n'est jamais perdu en changeant d'onglet), un
 * changement d'onglet DU NAVIGATEUR ou un rechargement de la page effaçait jusqu'ici tout le travail
 * en cours (import GPS, repères, pauses, réglages…) tant qu'il n'avait pas été explicitement
 * enregistré dans le profil d'un athlète. On sauvegarde donc automatiquement l'état courant dans le
 * localStorage à chaque modification, et on le restaure au chargement de la page.
 */
let draftSaveTimer = null;

function saveDraft() {
  const draft = {
    courseNom: state.courseNom,
    categorie: state.categorie,
    heureDepart: state.heureDepart,
    csvRows: state.csvRows,
    // Repli compact (échantillonné) au cas où les points bruts ci-dessus ne survivraient pas au
    // quota localStorage (cf. rattrapage ci-dessous) : garde un profil altimétrique précis malgré tout.
    elevationProfile: state.elevationProfile || downsampleElevationProfile(state.csvRows),
    gpxElevationProfile: state.gpxElevationProfile,
    segments: state.segments,
    profils: state.profils,
    auto: state.auto,
    globalDefaults: state.globalDefaults,
    rowOverrides: state.rowOverrides,
    rowMeta: state.rowMeta,
    kmOverrides: state.kmOverrides,
    segmentOverrides: state.segmentOverrides,
    showAdvanced: state.showAdvanced,
    loadedEstimationId: state.loadedEstimationId,
  };
  try {
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(draft));
  } catch (e) {
    // Quota localStorage dépassé (grosse trace GPS, ex. import multi-fichiers .fit) : on retente sans
    // les points bruts, seule partie vraiment volumineuse — segments/réglages/repères restent sauvegardés.
    try {
      localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify({ ...draft, csvRows: null }));
    } catch (e2) { /* ignore : rien de plus à faire, le brouillon ne sera pas restauré */ }
  }
}

function scheduleDraftSave() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(saveDraft, 500);
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_STATE);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function clearDraft() {
  try { localStorage.removeItem(STORAGE_KEY_STATE); } catch (e) { /* ignore */ }
}

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

/**
 * Reconstruit state.effectiveSegments (segments après application des corrections manuelles
 * kilomètre par kilomètre, cf. js/engine.js applyKmOverrides) à partir de state.segments (bruts) et
 * state.kmOverrides. C'est effectiveSegments — pas segments — qui alimente computeProfils et
 * computePacing : la table "Segments" et le tableau "Km par km" continuent d'afficher les valeurs
 * mesurées brutes, mais le calcul de pacing reflète les corrections de l'utilisateur.
 */
function recomputeEffectiveSegments() {
  state.kmTable = state.segments.length ? buildKmTable(state.segments) : [];
  // 1) corrections km par km, 2) retrait des segments supprimés depuis l'onglet Segments.
  state.effectiveSegments = removeDeletedSegments(
    applyKmOverrides(state.segments, state.kmOverrides), state.segmentOverrides,
  );
}

function recomputeAll() {
  // Si un CSV brut est chargé, on recalcule tout depuis les points GPS. Sinon on garde
  // segments/auto tels quels : c'est le cas quand une estimation sauvegardée a été rechargée
  // depuis un profil athlète (elle ne contient pas les points GPS bruts, déjà agrégés).
  if (state.csvRows) {
    state.auto = computeCourseAutoFields(state.csvRows);
    const grouped = assignSegmentGroups(state.csvRows);
    state.segments = buildSegments(grouped);
  }

  recomputeEffectiveSegments();
  state.profils = state.effectiveSegments.length ? computeProfils(state.effectiveSegments, state.settings) : null;

  const distanceTotaleEffectiveKm = sum(state.effectiveSegments.map((s) => s.distanceKm || 0));
  state.pacing = state.effectiveSegments.length
    ? computePacing(
        state.effectiveSegments, state.settings, state.profils || { calibMontee: 1, calibDescente: 1 },
        distanceTotaleEffectiveKm, state.categorie, state.globalDefaults, state.rowOverrides,
      )
    : null;

  renderAll();
}

/**
 * Recalcule uniquement le pacing (temps V1/V2), sans retoucher aux segments/profils/auto — utilisé
 * pour les réglages par ligne (intensité, technicité, conditions, pause) qui n'affectent pas la
 * segmentation. Beaucoup plus léger que recomputeAll() sur une grosse reconnaissance GPS (plusieurs
 * milliers de points/segments après un import multi-fichiers .fit), ce qui évite les ralentissements
 * ou plantages perçus lors de clics répétés (ex. flèches d'un champ pause).
 */
function recomputePacingOnly() {
  const distanceTotaleEffectiveKm = sum(state.effectiveSegments.map((s) => s.distanceKm || 0));
  state.pacing = state.effectiveSegments.length
    ? computePacing(
        state.effectiveSegments, state.settings, state.profils || { calibMontee: 1, calibDescente: 1 },
        distanceTotaleEffectiveKm, state.categorie, state.globalDefaults, state.rowOverrides,
      )
    : null;

  renderAll();
}

function renderAll() {
  // Paramètres
  $('#param-nom').value = state.courseNom;
  $('#param-heure-depart').value = state.heureDepart || '';
  $('#param-distance').value = state.segments.length ? `${fmt(state.auto.distanceTotaleKm, 1)} km` : '—';
  $('#param-dplus').value = state.segments.length ? `${fmt(state.auto.dPlusTotal, 0)} m` : '—';
  $('#param-dminus').value = state.segments.length ? `${fmt(state.auto.dMinusTotal, 0)} m` : '—';
  populateSelect($('#param-categorie'), CATEGORIE_OPTIONS, state.categorie);
  const fatigueRow = state.settings.fatigue.find((f) => f.categorie === state.categorie);
  $('#param-k').value = fatigueRow ? String(fatigueRow.k) : '—';

  renderAllCoefTables(state.settings, () => { saveSettings(); recomputeAll(); });

  // Segments
  renderSegmentsTable(state.segments, state.segmentOverrides);

  // Profils
  renderProfils(state.profils);

  // Km par km
  renderKmTable(state.kmTable, state.kmOverrides, {
    distanceKm: sum(state.effectiveSegments.map((s) => s.distanceKm || 0)),
    dPlus: sum(state.effectiveSegments.map((s) => s.dPlus || 0)),
    dMinus: sum(state.effectiveSegments.map((s) => s.dMinus || 0)),
    dureeMin: sum(state.effectiveSegments.map((s) => s.dureeMin || 0)),
  });

  // Pacing — réglages globaux
  populateSelect($('#global-intensite'), state.settings.intensite, state.globalDefaults.intensite);
  populateSelect($('#global-technicite'), state.settings.technicite, state.globalDefaults.technicite);
  populateSelect($('#global-conditions'), state.settings.conditions, state.globalDefaults.conditions);

  populateBulkSelect('#bulk-intensite', state.settings.intensite);
  populateBulkSelect('#bulk-technicite', state.settings.technicite);
  populateBulkSelect('#bulk-conditions', state.settings.conditions);

  renderPacingTable(state.pacing, state.settings, state.showAdvanced, state.rowMeta);
  updateExportButtonLabel();
  const pdfBtn = $('#generate-pdf-btn');
  if (pdfBtn) pdfBtn.style.display = state.pacing ? 'inline-block' : 'none';
  renderGpxStatus();

  // Athlètes
  renderAthletesList(state.athletes, state.activeAthleteId, {
    onSelect: selectAthlete, onDeselect: deselectAthlete, onEdit: editAthlete, onDelete: deleteAthleteUI,
  });
  const activeAthlete = state.athletes.find((a) => a.id === state.activeAthleteId) || null;
  renderEstimationsTable(activeAthlete, { onLoad: loadEstimation, onDelete: deleteEstimationUI });
  updateSaveEstimationSection(activeAthlete);

  scheduleDraftSave();
}

/** Liste déroulante de la modification groupée : « — inchangé — » + les libellés de la table de coefficients. */
function populateBulkSelect(selector, options) {
  const select = $(selector);
  if (!select) return;
  const previous = select.value;
  select.innerHTML = '';
  select.appendChild(el('option', { value: '' }, '— inchangé —'));
  options.forEach((opt) => {
    const label = typeof opt === 'string' ? opt : opt.label;
    select.appendChild(el('option', { value: label }, label));
  });
  if (previous && Array.from(select.options).some((o) => o.value === previous)) select.value = previous;
}

function wireBulkEdit() {
  const statusEl = $('#bulk-status');
  const setStatus = (cls, msg) => { statusEl.className = `status ${cls}`; statusEl.textContent = msg; };

  $('#bulk-range-btn').addEventListener('click', () => {
    if (!state.pacing) return;
    const from = parseFloat($('#bulk-range-from').value);
    const to = parseFloat($('#bulk-range-to').value);
    if (Number.isNaN(from) || Number.isNaN(to)) { setStatus('error', 'Renseignez le km de début et le km de fin.'); return; }
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const EPS = 1e-6;
    let n = 0;
    state.pacing.rows.forEach((row) => {
      const start = row.distCumDebut || 0;
      const end = start + (row.distanceKm || 0);
      // Une ligne est cochée si elle recouvre la portion [lo, hi] du parcours (la ligne Départ, de
      // longueur nulle, l'est si son point de départ y est inclus).
      const overlaps = end > start + EPS ? (end > lo + EPS && start < hi - EPS) : (start >= lo - EPS && start <= hi + EPS);
      if (overlaps) {
        if (!state.rowMeta[row.numero]) state.rowMeta[row.numero] = {};
        state.rowMeta[row.numero].selected = true;
        n += 1;
      }
    });
    renderPacingTable(state.pacing, state.settings, state.showAdvanced, state.rowMeta);
    updateExportButtonLabel();
    scheduleDraftSave();
    setStatus('ok', `${n} ligne${n > 1 ? 's' : ''} cochée${n > 1 ? 's' : ''} (du km ${lo} au km ${hi}).`);
  });

  $('#bulk-apply-btn').addEventListener('click', () => {
    if (!state.pacing) return;
    const values = {
      intensite: $('#bulk-intensite').value,
      technicite: $('#bulk-technicite').value,
      conditions: $('#bulk-conditions').value,
    };
    const fields = Object.keys(values).filter((f) => values[f] !== '');
    if (fields.length === 0) { setStatus('error', 'Choisissez au moins une valeur à appliquer (intensité, technicité ou conditions).'); return; }
    const selected = state.pacing.rows.filter((r) => state.rowMeta[r.numero] && state.rowMeta[r.numero].selected);
    if (selected.length === 0) { setStatus('error', 'Aucune ligne cochée : cochez des lignes (ou une plage de N°) avant d\'appliquer.'); return; }
    selected.forEach((row) => {
      if (!state.rowOverrides[row.numero]) state.rowOverrides[row.numero] = {};
      fields.forEach((f) => { state.rowOverrides[row.numero][f] = values[f]; });
    });
    recomputePacingOnly();
    setStatus('ok', `✔ ${fields.join(', ')} appliqué${fields.length > 1 ? 's' : ''} à ${selected.length} ligne${selected.length > 1 ? 's' : ''}.`);
  });
}

function updateSaveEstimationSection(activeAthlete) {
  const btn = $('#save-estimation-btn');
  const btnAsNew = $('#save-estimation-as-new-btn');
  const hint = $('#save-estimation-hint');
  const editingHint = $('#save-estimation-editing-hint');

  const loadedEst = (activeAthlete && state.loadedEstimationId)
    ? activeAthlete.estimations.find((e) => e.id === state.loadedEstimationId)
    : null;

  if (!activeAthlete) {
    btn.style.display = 'none';
    btnAsNew.style.display = 'none';
    editingHint.style.display = 'none';
    hint.style.display = 'block';
    hint.textContent = "Sélectionnez un athlète actif dans l'onglet Athlètes pour pouvoir enregistrer cette estimation dans son historique.";
    return;
  }

  const hasPacing = !!state.pacing;
  btn.style.display = hasPacing ? 'inline-block' : 'none';
  hint.style.display = hasPacing ? 'none' : 'block';
  hint.textContent = 'Importez une reconnaissance GPS (onglet Import) pour pouvoir enregistrer une estimation.';

  if (loadedEst) {
    const dateStr = new Date(loadedEst.dateModified || loadedEst.dateCreated).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    btn.textContent = `💾 Mettre à jour l'estimation du ${dateStr}`;
    btnAsNew.style.display = hasPacing ? 'inline-block' : 'none';
    editingHint.style.display = 'block';
    editingHint.textContent = `Vous modifiez l'estimation « ${loadedEst.courseNom || 'sans nom'} » enregistrée le ${dateStr} pour ${athleteFullName(activeAthlete)}. Vous pouvez mettre à jour cette entrée, ou enregistrer vos changements comme une nouvelle estimation séparée.`;
  } else {
    btn.textContent = `💾 Enregistrer dans le profil de ${athleteFullName(activeAthlete)}`;
    btnAsNew.style.display = 'none';
    editingHint.style.display = 'none';
  }
}

function updateExportButtonLabel() {
  const btn = $('#export-csv-btn');
  if (!btn) return;
  const nSelected = Object.values(state.rowMeta).filter((m) => m && m.selected).length;
  btn.textContent = nSelected > 0
    ? `⬇ Exporter la sélection (${nSelected} ligne${nSelected > 1 ? 's' : ''})`
    : '⬇ Exporter le pacing en CSV';
}

function renderGpxStatus() {
  const statusEl = $('#gpx-status');
  const resetBtn = $('#gpx-reset-btn');
  if (!statusEl || !resetBtn) return;
  if (state.gpxElevationProfile && state.gpxElevationProfile.length >= 2) {
    statusEl.className = 'status ok';
    statusEl.textContent = `✔ GPX officiel chargé (${state.gpxElevationProfile.length} points) — utilisé pour le profil altimétrique du PDF.`;
    resetBtn.style.display = 'inline-block';
  } else {
    resetBtn.style.display = 'none';
  }
}

// ---------- Athlètes ----------

const STORAGE_KEY_ACTIVE_ATHLETE = 'trail-pacing-predictor:activeAthlete';

function persistAthletes() {
  saveAthletes(state.athletes);
}

function selectAthlete(id) {
  state.activeAthleteId = id;
  state.loadedEstimationId = null; // changer d'athlète actif : on ne "modifie" plus une estimation d'un autre athlète
  try { localStorage.setItem(STORAGE_KEY_ACTIVE_ATHLETE, state.activeAthleteId || ''); } catch (e) { /* ignore */ }
  renderAll();
}

function deselectAthlete() {
  state.activeAthleteId = null;
  state.loadedEstimationId = null;
  try { localStorage.setItem(STORAGE_KEY_ACTIVE_ATHLETE, ''); } catch (e) { /* ignore */ }
  renderAll();
}

function editAthlete(id) {
  const athlete = state.athletes.find((a) => a.id === id);
  if (!athlete) return;
  state.editingAthleteId = id;
  $('#athlete-form-id').value = id;
  $('#athlete-prenom').value = athlete.prenom || '';
  $('#athlete-nom').value = athlete.nom || '';
  $('#athlete-age').value = athlete.age || '';
  $('#athlete-taille').value = athlete.tailleCm || '';
  $('#athlete-poids').value = athlete.poidsKg || '';
  $('#athlete-vma').value = athlete.vmaKmh || '';
  $('#athlete-form').style.display = 'grid';
}

function deleteAthleteUI(id) {
  const athlete = state.athletes.find((a) => a.id === id);
  if (!athlete) return;
  if (!confirm(`Supprimer l'athlète ${athleteFullName(athlete)} et ses ${athlete.estimations.length} estimation(s) ?`)) return;
  state.athletes = deleteAthlete(state.athletes, id);
  if (state.activeAthleteId === id) { state.activeAthleteId = null; state.loadedEstimationId = null; }
  persistAthletes();
  renderAll();
}

function loadEstimation(estimationId) {
  const athlete = state.athletes.find((a) => a.id === state.activeAthleteId);
  if (!athlete) return;
  const est = athlete.estimations.find((e) => e.id === estimationId);
  if (!est) return;

  state.csvRows = null; // pas de points GPS bruts dans l'instantané : on repart des segments déjà calculés
  state.elevationProfile = est.elevationProfile || null; // profil altimétrique échantillonné (repli précis pour le PDF)
  state.gpxElevationProfile = est.gpxElevationProfile || null;
  state.courseNom = est.courseNom;
  state.categorie = est.categorie;
  state.heureDepart = est.heureDepart ?? null;
  state.auto = { ...est.auto };
  state.segments = est.segments;
  state.profils = est.profils;
  state.globalDefaults = { ...est.globalDefaults };
  state.rowOverrides = JSON.parse(JSON.stringify(est.rowOverrides || {}));
  state.rowMeta = JSON.parse(JSON.stringify(est.rowMeta || {}));
  state.kmOverrides = JSON.parse(JSON.stringify(est.kmOverrides || {}));
  state.segmentOverrides = JSON.parse(JSON.stringify(est.segmentOverrides || {}));
  state.loadedEstimationId = estimationId; // permet de "mettre à jour" cette même entrée en la resauvegardant

  recomputeAll();
  goToTab('pacing');
}

function deleteEstimationUI(estimationId) {
  if (!confirm('Supprimer cette estimation ?')) return;
  deleteEstimation(state.athletes, state.activeAthleteId, estimationId);
  if (state.loadedEstimationId === estimationId) state.loadedEstimationId = null;
  persistAthletes();
  renderAll();
}

function resetAthleteForm() {
  state.editingAthleteId = null;
  $('#athlete-form').reset();
  $('#athlete-form-id').value = '';
  $('#athlete-form').style.display = 'none';
}

function wireAthletesTab() {
  $('#athlete-new-btn').addEventListener('click', () => {
    resetAthleteForm();
    $('#athlete-form').style.display = 'grid';
  });

  $('#athlete-form-cancel').addEventListener('click', () => resetAthleteForm());

  $('#athlete-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const data = {
      prenom: $('#athlete-prenom').value.trim(),
      nom: $('#athlete-nom').value.trim(),
      age: parseInt($('#athlete-age').value, 10) || null,
      tailleCm: parseFloat($('#athlete-taille').value) || null,
      poidsKg: parseFloat($('#athlete-poids').value) || null,
      vmaKmh: parseFloat($('#athlete-vma').value) || null,
    };
    if (!data.prenom && !data.nom) {
      alert('Merci de renseigner au moins un prénom ou un nom.');
      return;
    }

    const editingId = $('#athlete-form-id').value;
    if (editingId) {
      const athlete = state.athletes.find((a) => a.id === editingId);
      if (athlete) Object.assign(athlete, data);
    } else {
      state.athletes.push(createAthlete(data));
    }
    persistAthletes();
    resetAthleteForm();
    renderAll();
  });
}

// ---------- Import FIT (jusqu'à 4 parties, reconnaissance faite en plusieurs fois) ----------

let lastFitCsvText = null;
// fitParts[i] = null (rien chargé) ou { fileName, rows, pointCount, distanceKm } pour la partie i+1.
const fitParts = [null, null, null, null];

function updateFitCombinedSummary() {
  const statusEl = $('#fit-status');
  const summaryEl = $('#fit-summary');
  const actionsEl = $('#fit-actions');

  const loadedIndexes = fitParts
    .map((p, i) => (p ? i : null))
    .filter((i) => i !== null);

  if (loadedIndexes.length === 0) {
    statusEl.className = 'status';
    statusEl.textContent = '';
    summaryEl.style.display = 'none';
    actionsEl.style.display = 'none';
    lastFitCsvText = null;
    return;
  }

  // Signale un éventuel "trou" dans la numérotation des parties (ex. Partie 1 et 3 chargées sans
  // Partie 2) : les parties sont tout de même fusionnées dans l'ordre de leur numéro, mais mieux
  // vaut prévenir l'utilisateur que l'ordre attendu n'est peut-être pas respecté.
  const firstMissingBeforeLast = loadedIndexes.some((i, k) => k > 0 && i !== loadedIndexes[k - 1] + 1);

  const orderedRows = loadedIndexes.map((i) => fitParts[i].rows);
  const merged = mergeFitParts(orderedRows);
  lastFitCsvText = importRowsToCSVText(merged);

  const distanceKm = merged[merged.length - 1].distance_cum_m / 1000;
  const durationMin = merged.reduce((a, r) => a + (r.time_step_s || 0), 0) / 60;
  const totalPoints = merged.length;

  statusEl.className = firstMissingBeforeLast ? 'status error' : 'status ok';
  statusEl.textContent = firstMissingBeforeLast
    ? `⚠ ${loadedIndexes.length} partie(s) chargée(s), mais la numérotation a un trou (vérifiez l'ordre Partie 1 → 4) — fusion faite dans l'ordre des numéros malgré tout.`
    : `✔ ${loadedIndexes.length} partie${loadedIndexes.length > 1 ? 's' : ''} lue${loadedIndexes.length > 1 ? 's' : ''} et mise${loadedIndexes.length > 1 ? 's' : ''} bout à bout avec succès.`;

  summaryEl.innerHTML = '';
  summaryEl.style.display = 'grid';
  [
    ['Parties combinées', String(loadedIndexes.length)],
    ['Points GPS (total)', String(totalPoints)],
    ['Distance estimée', `${fmt(distanceKm, 2)} km`],
    ['Durée', `${fmt(durationMin, 1)} min`],
  ].forEach(([label, value]) => {
    summaryEl.appendChild(el('label', {}, [label, el('input', { type: 'text', value, readonly: 'true' })]));
  });
  actionsEl.style.display = 'flex';
}

function renderFitPartStatus(partNum) {
  const statusEl = document.querySelector(`.fit-part-status[data-part="${partNum}"]`);
  if (!statusEl) return;
  const part = fitParts[partNum - 1];
  statusEl.innerHTML = '';
  if (!part) {
    statusEl.className = 'fit-part-status';
    statusEl.textContent = '';
    return;
  }
  if (part.error) {
    statusEl.className = 'fit-part-status error';
    statusEl.textContent = `✖ ${part.error}`;
    return;
  }
  statusEl.className = 'fit-part-status ok';
  statusEl.append(`✔ ${part.fileName} — ${part.pointCount} pts, ${fmt(part.distanceKm, 2)} km  `);
  const removeBtn = el('button', { type: 'button', class: 'fit-part-remove' }, ['✕ Retirer']);
  removeBtn.addEventListener('click', () => {
    fitParts[partNum - 1] = null;
    const input = document.querySelector(`.fit-part-input[data-part="${partNum}"]`);
    if (input) input.value = '';
    renderFitPartStatus(partNum);
    updateFitCombinedSummary();
  });
  statusEl.appendChild(removeBtn);
}

function wireFitTab() {
  document.querySelectorAll('.fit-part-input').forEach((input) => {
    input.addEventListener('change', (e) => {
      const partNum = parseInt(input.dataset.part, 10);
      const file = e.target.files[0];
      if (!file) return;

      fitParts[partNum - 1] = null;
      const statusEl = document.querySelector(`.fit-part-status[data-part="${partNum}"]`);
      if (statusEl) { statusEl.className = 'fit-part-status'; statusEl.textContent = `⏳ Lecture de ${file.name}…`; }

      const reader = new FileReader();
      reader.onload = () => {
        try {
          const { points, pointCount } = parseFitPoints(reader.result);
          if (pointCount < 2) {
            throw new Error("Aucune donnée GPS trouvée dans ce fichier .fit.");
          }
          const rows = buildImportRowsFromPoints(points);
          const distanceKm = rows[rows.length - 1].distance_cum_m / 1000;
          fitParts[partNum - 1] = { fileName: file.name, rows, pointCount, distanceKm };
        } catch (err) {
          fitParts[partNum - 1] = { error: err.message };
        }
        renderFitPartStatus(partNum);
        updateFitCombinedSummary();
      };
      reader.onerror = () => {
        fitParts[partNum - 1] = { error: 'Impossible de lire ce fichier.' };
        renderFitPartStatus(partNum);
        updateFitCombinedSummary();
      };
      reader.readAsArrayBuffer(file);
    });
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
    state.elevationProfile = null; // les points bruts fraîchement importés font foi, plus besoin du repli
    state.rowOverrides = {};
    state.rowMeta = {};
    state.kmOverrides = {};
    state.segmentOverrides = {};
    state.loadedEstimationId = null; // une nouvelle reconnaissance GPS = une nouvelle estimation, pas une modification
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
    state.elevationProfile = null;
    state.gpxElevationProfile = null;
    state.segments = [];
    state.profils = null;
    state.pacing = null;
    state.rowOverrides = {};
    state.rowMeta = {};
    state.kmOverrides = {};
    state.segmentOverrides = {};
    state.kmTable = [];
    state.effectiveSegments = [];
    state.loadedEstimationId = null;
    $('#import-status').textContent = '';
    $('#gpx-file-input').value = '';
    $('#gpx-status').className = 'status';
    $('#gpx-status').textContent = '';
    clearDraft();
    recomputeAll();
  });
}

// ---------- Paramètres ----------

function wireParametresTab() {
  $('#param-nom').addEventListener('input', (e) => {
    state.courseNom = e.target.value;
    scheduleDraftSave();
  });
  $('#param-heure-depart').addEventListener('input', (e) => {
    // heure de départ non renseignée = champ vidé -> repli sur null (pas de colonne "Heure passage" au PDF)
    state.heureDepart = e.target.value || null;
    scheduleDraftSave();
  });
  $('#param-categorie').addEventListener('change', (e) => { state.categorie = e.target.value; recomputeAll(); });
  $('#reset-settings-btn').addEventListener('click', () => {
    if (!confirm('Réinitialiser toutes les tables de coefficients aux valeurs par défaut ?')) return;
    state.settings = deepClone(DEFAULT_SETTINGS);
    saveSettings();
    recomputeAll();
  });

  $('#logo-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      try {
        localStorage.setItem(STORAGE_KEY_LOGO, dataUrl);
      } catch (err) {
        alert("Ce logo est trop volumineux pour être sauvegardé dans le navigateur. Essayez une image plus légère.");
        return;
      }
      $('#app-logo').src = dataUrl;
    };
    reader.readAsDataURL(file);
  });

  $('#logo-reset-btn').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY_LOGO);
    $('#app-logo').src = DEFAULT_LOGO_SRC;
  });
}

function loadLogo() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_LOGO);
    if (saved) $('#app-logo').src = saved;
  } catch (e) { /* ignore */ }
}

// ---------- Segments : suppression ----------

function wireSegmentsTab() {
  const table = $('#segments-table');
  if (!table) return;
  table.addEventListener('change', (e) => {
    const target = e.target;
    const seg = target.dataset.seg;
    if (seg === undefined || target.type !== 'checkbox') return;
    if (target.checked) state.segmentOverrides[seg] = { deleted: true };
    else delete state.segmentOverrides[seg];
    recomputeAll();
  });
  const resetBtn = $('#seg-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      state.segmentOverrides = {};
      recomputeAll();
    });
  }
}

// ---------- Km par km (contrôle + corrections manuelles) ----------

function wireKmTab() {
  const table = $('#km-table');
  if (!table) return;

  table.addEventListener('change', (e) => {
    const target = e.target;
    const km = target.dataset.km;
    const field = target.dataset.field;
    if (km === undefined || !field) return;
    if (field === 'note') return; // géré par l'écouteur 'input' ci-dessous (évite de perdre le focus)

    if (!state.kmOverrides[km]) state.kmOverrides[km] = {};

    if (field === 'deleted') {
      state.kmOverrides[km].deleted = target.checked;
    } else {
      const v = target.value.trim();
      if (v === '') {
        delete state.kmOverrides[km][field];
      } else {
        const n = parseFloat(v);
        if (!Number.isNaN(n)) state.kmOverrides[km][field] = n;
      }
    }
    // Une entrée totalement vide (aucun champ, pas de note) est nettoyée pour ne pas polluer
    // l'état sauvegardé indéfiniment.
    const ov = state.kmOverrides[km];
    if (ov && !ov.deleted && ov.distanceKm === undefined && ov.dPlus === undefined
      && ov.dMinus === undefined && ov.dureeMin === undefined && !ov.note) {
      delete state.kmOverrides[km];
    }

    // Une correction km change la segmentation effective vue par profils/pacing : recalcul complet.
    recomputeAll();
  });

  table.addEventListener('input', (e) => {
    const target = e.target;
    if (target.dataset.field !== 'note') return;
    const km = target.dataset.km;
    if (km === undefined) return;
    if (!state.kmOverrides[km]) state.kmOverrides[km] = {};
    state.kmOverrides[km].note = target.value;
    scheduleDraftSave();
  });

  const resetBtn = $('#km-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (!confirm('Effacer toutes les corrections manuelles km par km ?')) return;
      state.kmOverrides = {};
      recomputeAll();
    });
  }
}

// ---------- Pacing ----------

function wirePacingTab() {
  $('#global-intensite').addEventListener('change', (e) => { state.globalDefaults.intensite = e.target.value; renderAll(); });
  $('#global-technicite').addEventListener('change', (e) => { state.globalDefaults.technicite = e.target.value; renderAll(); });
  $('#global-conditions').addEventListener('change', (e) => { state.globalDefaults.conditions = e.target.value; renderAll(); });

  $('#apply-global-btn').addEventListener('click', () => {
    // Remet intensité/technicité/conditions de chaque ligne sur les réglages globaux, mais conserve
    // les pauses ravito déjà saisies (elles ne dépendent pas de ces réglages).
    const next = {};
    Object.keys(state.rowOverrides).forEach((seg) => {
      const pause = state.rowOverrides[seg] && state.rowOverrides[seg].pause;
      if (typeof pause === 'number' && pause !== 0) next[seg] = { pause };
    });
    state.rowOverrides = next;
    recomputeAll();
  });

  $('#toggle-full-columns').addEventListener('change', (e) => {
    state.showAdvanced = e.target.checked;
    renderPacingTable(state.pacing, state.settings, state.showAdvanced, state.rowMeta);
  });

  // Délégation d'événements sur le tableau pacing (dropdowns, pauses, sélection, repères)
  $('#pacing-table').addEventListener('change', (e) => {
    const target = e.target;

    // Case "Tout" dans l'en-tête : coche/décoche toutes les lignes
    if (target.dataset.selectAll !== undefined) {
      const checked = target.checked;
      state.pacing.rows.forEach((row) => {
        if (!state.rowMeta[row.numero]) state.rowMeta[row.numero] = {};
        state.rowMeta[row.numero].selected = checked;
      });
      renderPacingTable(state.pacing, state.settings, state.showAdvanced, state.rowMeta);
      updateExportButtonLabel();
      scheduleDraftSave();
      return;
    }

    const seg = target.dataset.seg;
    const field = target.dataset.field;
    if (!seg || !field) return;

    if (field === 'rowSelected') {
      if (!state.rowMeta[seg]) state.rowMeta[seg] = {};
      state.rowMeta[seg].selected = target.checked;
      updateExportButtonLabel();
      scheduleDraftSave();
      return;
    }
    if (field === 'rowLabel') return; // géré par l'écouteur 'input' ci-dessous (évite de perdre le focus)

    if (!state.rowOverrides[seg]) state.rowOverrides[seg] = {};
    if (field === 'pause') {
      state.rowOverrides[seg].pause = parseFloat(target.value) || 0;
    } else {
      state.rowOverrides[seg][field] = target.value;
    }
    // Réglages par ligne (intensité/technicité/conditions/pause) : ne changent pas la segmentation,
    // un recalcul complet (recomputeAll) est inutile et coûteux sur une grosse trace GPS — on ne
    // recalcule que le pacing pour rester réactif (cf. flèches du champ pause).
    recomputePacingOnly();
  });

  // Champ "Repère" : mise à jour de l'état à chaque frappe, sans reconstruire le tableau
  // (sinon le champ perdrait le focus au milieu de la saisie).
  $('#pacing-table').addEventListener('input', (e) => {
    const target = e.target;
    // Pause ravito : enregistrée dès la frappe (sans attendre la sortie du champ), pour ne jamais
    // être perdue si on change d'onglet ou recharge la page avant que le champ ne perde le focus.
    if (target.dataset.field === 'pause' && target.dataset.seg) {
      const segKey = target.dataset.seg;
      if (!state.rowOverrides[segKey]) state.rowOverrides[segKey] = {};
      state.rowOverrides[segKey].pause = parseFloat(target.value) || 0;
      scheduleDraftSave();
      return;
    }
    if (target.dataset.field !== 'rowLabel') return;
    const seg = target.dataset.seg;
    if (!seg) return;
    if (!state.rowMeta[seg]) state.rowMeta[seg] = {};
    state.rowMeta[seg].label = target.value;
    scheduleDraftSave();
  });

  $('#export-csv-btn').addEventListener('click', () => {
    if (!state.pacing) return;
    const csv = pacingToCSVString(state.pacing, state.rowMeta);
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pacing.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  $('#save-estimation-btn').addEventListener('click', () => {
    if (!state.activeAthleteId || !state.pacing) return;
    const athlete = state.athletes.find((a) => a.id === state.activeAthleteId);
    if (!athlete) return;
    const snapshot = buildEstimationSnapshot(state);
    const statusEl = $('#save-estimation-status');
    const stillExists = state.loadedEstimationId && athlete.estimations.some((e) => e.id === state.loadedEstimationId);

    if (stillExists) {
      updateEstimationInAthlete(state.athletes, state.activeAthleteId, state.loadedEstimationId, snapshot);
      statusEl.textContent = `✔ Estimation mise à jour dans le profil de ${athleteFullName(athlete)}.`;
    } else {
      addEstimationToAthlete(state.athletes, state.activeAthleteId, snapshot);
      state.loadedEstimationId = snapshot.id; // resauvegarder mettra désormais à jour cette nouvelle entrée
      statusEl.textContent = `✔ Estimation enregistrée dans le profil de ${athleteFullName(athlete)}.`;
    }
    persistAthletes();
    statusEl.className = 'status ok';
    renderAll();
  });

  $('#save-estimation-as-new-btn').addEventListener('click', () => {
    if (!state.activeAthleteId || !state.pacing) return;
    const athlete = state.athletes.find((a) => a.id === state.activeAthleteId);
    if (!athlete) return;
    const snapshot = buildEstimationSnapshot(state);
    addEstimationToAthlete(state.athletes, state.activeAthleteId, snapshot);
    state.loadedEstimationId = snapshot.id;
    persistAthletes();
    const statusEl = $('#save-estimation-status');
    statusEl.className = 'status ok';
    statusEl.textContent = `✔ Nouvelle estimation enregistrée dans le profil de ${athleteFullName(athlete)}.`;
    renderAll();
  });

  const gpxInput = $('#gpx-file-input');
  if (gpxInput) {
    gpxInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const statusEl = $('#gpx-status');
      statusEl.className = 'status';
      statusEl.textContent = `⏳ Lecture de ${file.name}…`;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const rows = parseGpxElevationRows(reader.result);
          state.gpxElevationProfile = downsampleElevationProfile(rows, 400);
          if (!state.gpxElevationProfile) throw new Error("Profil altimétrique introuvable dans ce fichier.");
          renderGpxStatus();
          scheduleDraftSave();
        } catch (err) {
          state.gpxElevationProfile = null;
          statusEl.className = 'status error';
          statusEl.textContent = `✖ ${err.message}`;
        }
      };
      reader.onerror = () => {
        statusEl.className = 'status error';
        statusEl.textContent = '✖ Impossible de lire ce fichier.';
      };
      reader.readAsText(file, 'UTF-8');
    });
  }

  const gpxResetBtn = $('#gpx-reset-btn');
  if (gpxResetBtn) {
    gpxResetBtn.addEventListener('click', () => {
      state.gpxElevationProfile = null;
      $('#gpx-file-input').value = '';
      $('#gpx-status').className = 'status';
      $('#gpx-status').textContent = '';
      renderGpxStatus();
      scheduleDraftSave();
    });
  }

  const pdfBtn = $('#generate-pdf-btn');
  if (pdfBtn) {
    pdfBtn.addEventListener('click', async () => {
      const statusEl = $('#pdf-status');
      statusEl.className = 'status';
      statusEl.textContent = '⏳ Génération du PDF…';
      pdfBtn.disabled = true;
      try {
        await generatePacingPDF(state);
        statusEl.className = 'status ok';
        statusEl.textContent = '✔ PDF généré et téléchargé.';
      } catch (err) {
        statusEl.className = 'status error';
        statusEl.textContent = `⚠ ${err.message || 'Erreur lors de la génération du PDF.'}`;
      } finally {
        pdfBtn.disabled = false;
      }
    });
  }
}

// ---------- Bootstrap ----------

function init() {
  state.settings = loadSettings();
  state.athletes = loadAthletes();
  try {
    const savedActive = localStorage.getItem(STORAGE_KEY_ACTIVE_ATHLETE);
    if (savedActive && state.athletes.some((a) => a.id === savedActive)) state.activeAthleteId = savedActive;
  } catch (e) { /* ignore */ }

  // Restaure le travail en cours (import GPS, segments, réglages, repères, pauses, nom de course)
  // s'il y en a un : évite de tout perdre en changeant d'onglet navigateur ou en rechargeant la page.
  const draft = loadDraft();
  if (draft) {
    state.courseNom = draft.courseNom ?? state.courseNom;
    state.categorie = draft.categorie ?? state.categorie;
    state.heureDepart = draft.heureDepart ?? null;
    state.csvRows = draft.csvRows ?? null;
    state.elevationProfile = draft.elevationProfile ?? null;
    state.gpxElevationProfile = draft.gpxElevationProfile ?? null;
    state.segments = draft.segments ?? [];
    state.profils = draft.profils ?? null;
    state.auto = draft.auto ?? state.auto;
    state.globalDefaults = draft.globalDefaults ?? state.globalDefaults;
    state.rowOverrides = draft.rowOverrides ?? {};
    state.rowMeta = draft.rowMeta ?? {};
    state.kmOverrides = draft.kmOverrides ?? {};
    state.segmentOverrides = draft.segmentOverrides ?? {};
    state.showAdvanced = !!draft.showAdvanced;
    if (draft.loadedEstimationId) state.loadedEstimationId = draft.loadedEstimationId;
  }

  initTabs();
  wireAthletesTab();
  wireFitTab();
  wireImportTab();
  wireParametresTab();
  wireSegmentsTab();
  wireKmTab();
  wirePacingTab();
  wireBulkEdit();
  loadLogo();
  $('#app-logo').addEventListener('error', () => { $('#app-logo').style.display = 'none'; });
  $('#toggle-full-columns').checked = state.showAdvanced;
  recomputeAll(); // reconstruit le pacing à partir des segments/réglages restaurés (comme pour une estimation chargée)
}

document.addEventListener('DOMContentLoaded', init);
