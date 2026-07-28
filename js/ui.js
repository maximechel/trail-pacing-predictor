/* ui.js — Rendu DOM et gestion des tableaux éditables. Aucune dépendance externe. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

// ---------- Onglets ----------

function initTabs() {
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach((b) => b.classList.remove('active'));
      $$('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(`#tab-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

function goToTab(name) {
  $(`.tab-btn[data-tab="${name}"]`)?.click();
}

// ---------- Selects (dropdowns) ----------

function populateSelect(selectEl, options, selectedValue) {
  selectEl.innerHTML = '';
  options.forEach((opt) => {
    const label = typeof opt === 'string' ? opt : opt.label;
    const o = el('option', { value: label }, label);
    if (label === selectedValue) o.selected = true;
    selectEl.appendChild(o);
  });
}

// ---------- Tables de coefficients éditables (onglet Paramètres) ----------

function renderNumberCell(value, onCommit, step = '0.01') {
  const input = el('input', { type: 'number', step, value: String(value) });
  input.addEventListener('change', () => onCommit(parseFloat(input.value)));
  const td = el('td', {}, input);
  return td;
}

function renderFatigueTable(settings, onChange) {
  const table = $('#table-fatigue');
  table.innerHTML = '';
  table.appendChild(el('thead', {}, el('tr', {}, [
    el('th', {}, 'Catégorie'), el('th', {}, 'k'), el('th', {}, 'Ralentissement max'), el('th', {}, 'Description'),
  ])));
  const tbody = el('tbody');
  settings.fatigue.forEach((row, i) => {
    const tr = el('tr', {}, [
      el('td', {}, row.categorie),
      renderNumberCell(row.k, (v) => { settings.fatigue[i].k = v; onChange(); }),
      el('td', {}, row.max),
      el('td', {}, row.description),
    ]);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

function renderSimpleCoefTable(tableId, rows, onChange, extraCols = []) {
  const table = $(tableId);
  table.innerHTML = '';
  table.appendChild(el('thead', {}, el('tr', {}, [
    el('th', {}, 'Label'), el('th', {}, 'Coef'), ...extraCols.map((c) => el('th', {}, c)),
  ])));
  const tbody = el('tbody');
  rows.forEach((row, i) => {
    const tr = el('tr', {}, [
      el('td', {}, row.label),
      renderNumberCell(row.coef, (v) => { rows[i].coef = v; onChange(); }),
      ...extraCols.map((c) => el('td', {}, row[c.toLowerCase()] ?? row.description ?? '')),
    ]);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

function renderProfilFVTable(settings, onChange) {
  const table = $('#table-profil-fv');
  table.innerHTML = '';
  table.appendChild(el('thead', {}, el('tr', {}, [
    el('th', {}, 'Profil'), el('th', {}, 'Coef montée'), el('th', {}, 'Coef plat'), el('th', {}, 'Coef mixte'),
  ])));
  const tbody = el('tbody');
  settings.profilForceVitesse.forEach((row, i) => {
    const tr = el('tr', {}, [
      el('td', {}, row.profil),
      renderNumberCell(row.montee, (v) => { settings.profilForceVitesse[i].montee = v; onChange(); }),
      renderNumberCell(row.plat, (v) => { settings.profilForceVitesse[i].plat = v; onChange(); }),
      renderNumberCell(row.mixte, (v) => { settings.profilForceVitesse[i].mixte = v; onChange(); }),
    ]);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

function renderProfilDescTable(settings, onChange) {
  const table = $('#table-profil-desc');
  table.innerHTML = '';
  table.appendChild(el('thead', {}, el('tr', {}, [
    el('th', {}, 'Profil descente'), el('th', {}, 'Coef'), el('th', {}, 'Interprétation'),
  ])));
  const tbody = el('tbody');
  settings.profilDescente.forEach((row, i) => {
    const tr = el('tr', {}, [
      el('td', {}, row.profil),
      renderNumberCell(row.coef, (v) => { settings.profilDescente[i].coef = v; onChange(); }),
      el('td', {}, row.description),
    ]);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

function renderAllCoefTables(settings, onChange) {
  renderFatigueTable(settings, onChange);
  renderSimpleCoefTable('#table-intensite', settings.intensite, onChange, ['Description']);
  renderSimpleCoefTable('#table-technicite', settings.technicite, onChange, ['Description']);
  renderSimpleCoefTable('#table-conditions', settings.conditions, onChange, ['Description']);
  renderProfilFVTable(settings, onChange);
  renderProfilDescTable(settings, onChange);
}

// ---------- Segments ----------

function renderSegmentsTable(segments) {
  const tbody = $('#segments-table tbody');
  tbody.innerHTML = '';
  if (!segments || segments.length === 0) {
    tbody.appendChild(el('tr', {}, el('td', { colspan: '8' }, 'Aucun segment — importez un CSV.')));
    return;
  }
  segments.forEach((s) => {
    const tr = el('tr', { class: `type-${s.type}` }, [
      el('td', {}, String(s.numero)),
      el('td', { class: 'type-cell' }, s.type),
      el('td', {}, fmt(s.distanceKm, 3)),
      el('td', {}, fmt(s.dPlus, 1)),
      el('td', {}, fmt(s.dMinus, 1)),
      el('td', {}, fmt(s.dureeMin, 2)),
      el('td', {}, fmt(s.vitesseMoy, 2)),
      el('td', {}, fmt(s.penteMoy, 1)),
    ]);
    tbody.appendChild(tr);
  });
}

// ---------- Profils ----------

function profilItem(label, value) {
  return el('div', { class: 'profil-item' }, [
    el('div', { class: 'label' }, label),
    el('div', { class: 'value' }, String(value)),
  ]);
}

function renderProfils(profils) {
  const fvGrid = $('#profil-fv-grid');
  const descGrid = $('#profil-desc-grid');
  const statsGrid = $('#profil-stats-grid');
  fvGrid.innerHTML = '';
  descGrid.innerHTML = '';
  statsGrid.innerHTML = '';
  if (!profils) return;
  fvGrid.append(
    profilItem('🏔 Vitesse moy MONTÉE', profils.vitesseMontee !== null ? `${fmt(profils.vitesseMontee)} km/h` : '—'),
    profilItem('🏃 Vitesse moy PLAT', profils.vitessePlat !== null ? `${fmt(profils.vitessePlat)} km/h` : '—'),
    profilItem('⬇️ Vitesse moy DESCENTE', profils.vitesseDescente !== null ? `${fmt(profils.vitesseDescente)} km/h` : '—'),
    profilItem('📊 Ratio Montée / Plat', profils.ratioMonteePlat ?? 'N/A'),
    profilItem('📉 Indice Descente', profils.indiceDescente ?? 'N/A'),
    profilItem('⭐ PROFIL FORCE-VITESSE', profils.profilForceVitesse),
    profilItem('→ Coef profil MONTÉE', profils.coefMontee),
    profilItem('→ Coef profil PLAT', profils.coefPlat),
    profilItem('→ Coef profil MIXTE', profils.coefMixte),
  );

  descGrid.append(
    profilItem('⭐ PROFIL DESCENTE', profils.profilDescente),
    profilItem('→ Coef profil DESCENTE', profils.coefDescente),
    profilItem('🧬 Profil complet', profils.profilComplet),
  );

  statsGrid.append(
    profilItem('Nb segments MONTÉE', `${profils.nbMontee} seg`),
    profilItem('Nb segments PLAT', `${profils.nbPlat} seg`),
    profilItem('Nb segments DESCENTE', `${profils.nbDescente} seg`),
  );
}

// ---------- Pacing ----------

const PACING_COLUMNS = [
  { key: 'rowSelected', label: '☑', adv: false, editable: 'checkbox' },
  { key: 'rowLabel', label: 'Repère (village / ravito)', adv: false, editable: 'text' },
  { key: 'numero', label: 'N°', adv: false, align: 'right' },
  { key: 'type', label: 'Type', adv: false, align: 'left' },
  { key: 'distanceKm', label: 'Dist. (km)', adv: false, digits: 3 },
  { key: 'distCumFin', label: 'Distance cumulée (km)', adv: false, digits: 3 },
  { key: 'dPlus', label: 'D+ (m)', adv: false, digits: 1 },
  { key: 'dMinus', label: 'D- (m)', adv: false, digits: 1 },
  { key: 'penteMoy', label: 'Pente moy (%)', adv: true, digits: 1 },
  { key: 'dureeGPS', label: 'Durée GPS (min)', adv: false, digits: 1 },
  { key: 'intensite', label: 'Intensité', adv: false, editable: 'select', options: 'intensite' },
  { key: 'coefIntensite', label: 'Coef Int.', adv: true, digits: 2 },
  { key: 'technicite', label: 'Technicité', adv: false, editable: 'select', options: 'technicite' },
  { key: 'coefTech', label: 'Coef Tech.', adv: true, digits: 2 },
  { key: 'conditions', label: 'Conditions', adv: false, editable: 'select', options: 'conditions' },
  { key: 'coefCond', label: 'Coef Cond.', adv: true, digits: 2 },
  { key: 'coefTerrain', label: 'Coef Terrain', adv: true, digits: 3 },
  { key: 'distCumDebut', label: 'Dist. cum. début (km)', adv: true, digits: 3 },
  { key: 'pctParcoursPct', label: '% Parcours', adv: true, digits: 1 },
  { key: 'coefFatigue', label: 'Coef Fatigue', adv: true, digits: 3 },
  { key: 'tempsV1', label: 'Temps prévu (min) V1', adv: true, digits: 1 },
  { key: 'pause', label: 'Pause ravito (min)', adv: false, editable: 'number' },
  { key: 'totalSegV1', label: 'Total seg (min) V1', adv: true, digits: 1 },
  { key: 'cumulV1', label: 'Cumul (min) V1', adv: true, digits: 1 },
  { key: 'cumulV1HM', label: 'Cumul V1 (h min)', adv: true, align: 'left' },
  { key: 'coefProfil', label: 'Coef Profil', adv: true, digits: 2 },
  { key: 'tempsV2', label: 'Temps prévu (min) V2', adv: false, digits: 1 },
  { key: 'totalSegV2', label: 'Total seg (min) V2', adv: true, digits: 1 },
  { key: 'cumulV2', label: 'Cumul (min) V2', adv: true, digits: 1 },
  { key: 'cumulV2HM', label: 'Cumul V2 (h min)', adv: false, align: 'left' },
];

/** Valeur d'une colonne "spéciale" non stockée directement sur la ligne pacing (repère, sélection, distance cumulée fin). */
function pacingSpecialValue(col, row, rowMeta) {
  const meta = (rowMeta && rowMeta[row.numero]) || {};
  if (col.key === 'rowSelected') return !!meta.selected;
  if (col.key === 'rowLabel') return meta.label || '';
  if (col.key === 'distCumFin') {
    return (row.distCumDebut !== null && row.distanceKm !== null) ? row.distCumDebut + row.distanceKm : null;
  }
  if (col.key === 'pctParcoursPct') return row.pctParcours !== null ? row.pctParcours * 100 : null;
  return undefined;
}

function renderPacingTable(pacing, settings, showAdvanced, rowMeta = {}) {
  const table = $('#pacing-table');
  table.classList.toggle('show-advanced', showAdvanced);
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  const tfoot = table.querySelector('tfoot');
  thead.innerHTML = '';
  tbody.innerHTML = '';
  tfoot.innerHTML = '';

  const headRow = el('tr');
  PACING_COLUMNS.forEach((col) => {
    let content = col.label;
    if (col.key === 'rowSelected') {
      const cb = el('input', { type: 'checkbox', 'data-select-all': '1' });
      content = [cb, ' Tout'];
    }
    const th = el('th', { class: col.adv ? 'adv' : '' }, content);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  if (!pacing || pacing.rows.length === 0) {
    tbody.appendChild(el('tr', {}, el('td', { colspan: String(PACING_COLUMNS.length) }, 'Aucun segment — importez un CSV.')));
    return;
  }

  pacing.rows.forEach((row) => {
    const tr = el('tr', { class: `type-${row.type}`, 'data-seg': String(row.numero) });
    PACING_COLUMNS.forEach((col) => {
      let td;
      if (col.editable === 'select') {
        const select = el('select', { 'data-field': col.key, 'data-seg': String(row.numero) });
        populateSelect(select, settings[col.options], row[col.key]);
        td = el('td', { class: col.adv ? 'adv' : '' }, select);
      } else if (col.editable === 'number') {
        const input = el('input', {
          type: 'number', step: '1', min: '0', value: String(row[col.key] ?? 0),
          class: 'pause-input', 'data-field': col.key, 'data-seg': String(row.numero),
        });
        td = el('td', { class: col.adv ? 'adv' : '' }, input);
      } else if (col.editable === 'checkbox') {
        const checked = pacingSpecialValue(col, row, rowMeta);
        const input = el('input', { type: 'checkbox', 'data-field': col.key, 'data-seg': String(row.numero) });
        if (checked) input.checked = true;
        td = el('td', { class: col.adv ? 'adv' : '' }, input);
      } else if (col.editable === 'text') {
        const value = pacingSpecialValue(col, row, rowMeta);
        const input = el('input', {
          type: 'text', placeholder: 'ex. Ravito du Col', value: String(value),
          'data-field': col.key, 'data-seg': String(row.numero),
        });
        td = el('td', { class: col.adv ? 'adv' : '' }, input);
      } else {
        let val = row[col.key];
        const special = pacingSpecialValue(col, row, rowMeta);
        if (special !== undefined) val = special;
        let text = col.digits !== undefined ? fmt(val, col.digits) : (val ?? '—');
        if (col.key === 'pctParcoursPct' && val !== null) text += ' %';
        td = el('td', { class: `${col.adv ? 'adv ' : ''}${col.key === 'type' ? 'type-cell' : ''}` }, String(text));
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  // ligne total
  const t = pacing.totals;
  const totalsByKey = {
    rowSelected: '', rowLabel: '',
    numero: 'TOTAL', type: '', distanceKm: fmt(t.distanceKm, 3), distCumFin: fmt(t.distanceKm, 3),
    dPlus: fmt(t.dPlus, 1), dMinus: fmt(t.dMinus, 1),
    penteMoy: '', dureeGPS: fmt(t.dureeGPS, 1), intensite: '', coefIntensite: '', technicite: '', coefTech: '',
    conditions: '', coefCond: '', coefTerrain: '', distCumDebut: '', pctParcoursPct: '', coefFatigue: '',
    tempsV1: fmt(t.tempsV1, 1), pause: fmt(t.pause, 1), totalSegV1: fmt(t.totalSegV1, 1),
    cumulV1: fmt(t.cumulV1, 1), cumulV1HM: t.cumulV1HM, coefProfil: '',
    tempsV2: fmt(t.tempsV2, 1), totalSegV2: fmt(t.totalSegV2, 1), cumulV2: fmt(t.cumulV2, 1), cumulV2HM: t.cumulV2HM,
  };
  const footRow = el('tr');
  PACING_COLUMNS.forEach((col) => {
    footRow.appendChild(el('td', { class: col.adv ? 'adv' : '' }, String(totalsByKey[col.key] ?? '')));
  });
  tfoot.appendChild(footRow);
}

/**
 * Exporte le pacing en CSV. Si au moins une ligne est cochée (rowMeta[numero].selected), seules les
 * lignes cochées sont exportées (utile pour un roadbook avec seulement les repères importants) ;
 * sinon toutes les lignes sont exportées.
 */
function pacingToCSVString(pacing, rowMeta = {}) {
  const selectedNumeros = pacing.rows.filter((r) => rowMeta[r.numero] && rowMeta[r.numero].selected);
  const rowsToExport = selectedNumeros.length > 0 ? selectedNumeros : pacing.rows;

  const headers = PACING_COLUMNS.filter((c) => c.key !== 'rowSelected').map((c) => c.label);
  const lines = [headers.join(';')];
  rowsToExport.forEach((row) => {
    const line = PACING_COLUMNS.filter((c) => c.key !== 'rowSelected').map((col) => {
      const special = pacingSpecialValue(col, row, rowMeta);
      if (special !== undefined) {
        if (special === null) return '';
        if (typeof special === 'number') return special.toFixed(col.digits !== undefined ? col.digits : 3);
        return String(special);
      }
      const v = row[col.key];
      return v === null || v === undefined ? '' : String(v);
    });
    lines.push(line.join(';'));
  });
  return lines.join('\n');
}

if (typeof module !== 'undefined') {
  module.exports = { PACING_COLUMNS, pacingToCSVString, pacingSpecialValue };
}
