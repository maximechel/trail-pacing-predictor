/*
 * pdf-export.js — Génération d'un PDF "roadbook" depuis l'onglet Pacing :
 * en-tête (logo + nom de course + km/D+/D-), profil altimétrique avec repères marqués,
 * et tableau récapitulatif limité aux lignes dont le champ Repère est renseigné.
 *
 * Utilise jsPDF + le plugin jspdf-autotable (chargés via CDN dans index.html).
 * Aucun calcul métier ici : uniquement mise en forme visuelle à partir de l'état déjà calculé.
 */

const BRAND_BLUE_RGB = [5, 5, 197];
const CHART_GREEN_LINE = '#3f9450';
const CHART_GREEN_FILL = 'rgba(63,148,80,0.22)';
// Vert du graphique altimétrique, réutilisé comme second bandeau d'en-tête du tableau des repères :
// bleu = colonnes utiles au coureur pendant sa course, vert = colonnes utiles à l'assistance (ce qui
// l'attend au ravito suivant, prévu pour la logistique plutôt que pour la lecture en course).
const ASSIST_GREEN_RGB = [63, 148, 80];

/**
 * Formate un nombre pour un rendu jsPDF : `fmt()` insère un espace fine insécable (séparateur de
 * milliers en français) que la police standard du PDF ne sait pas afficher (elle le rend en glyphe
 * cassé, visible comme un « / »). On la remplace par un espace normal, sans risque ici.
 */
function fmtPdf(n, digits = 0) {
  return fmt(n, digits).replace(/[  ]/g, ' ');
}

/**
 * Entier sans séparateur de milliers, pour les cellules de tableau étroites (D+/D- notamment) : le
 * séparateur de milliers (même remplacé par un espace normal via `fmtPdf`) reste un espace, sur
 * lequel jspdf-autotable coupe la ligne dès que la colonne est un peu juste (ex. "1 431" -> "1" /
 * "431" sur deux lignes). Un entier collé évite tout retour à la ligne dans ces colonnes.
 */
function fmtPdfInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return String(excelRound(n, 0));
}

/**
 * Variante PDF de `formatHM()` (colonnes "Temps cumulé" / "Temps segment suivant" uniquement — le
 * format standard "Xh YYmin", utilisé partout ailleurs dans l'app, n'est pas modifié) : dès que
 * l'heure affichée est au moins 1h, le suffixe "min" (déjà implicite vu le "h" qui précède) est
 * retiré pour rester plus compact — ex. "1h 27min" -> "1h 27", mais "0h 02min" reste inchangé (sans
 * le "h", "02" seul serait ambigu : minutes ou quoi d'autre ?).
 */
function formatHMPdf(minutes) {
  const full = formatHM(minutes);
  if (!full) return full;
  const h = Math.floor((minutes || 0) / 60);
  return h >= 1 ? full.replace(/min$/, '') : full;
}

/**
 * Calcule l'heure de passage à un repère à partir de l'heure de départ officielle ("HH:MM") et du
 * temps cumulé écoulé (en minutes) depuis le départ. Gère le passage à un jour suivant (courses
 * longues sur plusieurs jours) en ajoutant un suffixe compact "+Nj" (sans espace, pour ne jamais
 * provoquer de retour à la ligne dans une cellule de tableau étroite). Renvoie `null` si l'heure de
 * départ n'est pas renseignée ou invalide.
 */
function computeArrivalClock(startTimeStr, cumulMinutes) {
  if (!startTimeStr || cumulMinutes === null || cumulMinutes === undefined || Number.isNaN(cumulMinutes)) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(startTimeStr).trim());
  if (!m) return null;
  const startTotalMin = Number(m[1]) * 60 + Number(m[2]);
  const totalMin = Math.round(startTotalMin + cumulMinutes);
  const dayOffset = Math.floor(totalMin / 1440);
  const minOfDay = totalMin - dayOffset * 1440;
  const hh = String(Math.floor(minOfDay / 60)).padStart(2, '0');
  const mm = String(minOfDay % 60).padStart(2, '0');
  return dayOffset > 0 ? `${hh}:${mm}+${dayOffset}j` : `${hh}:${mm}`;
}

function slugify(text) {
  return (text || 'pacing')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'pacing';
}

/** Convertit un <img> déjà chargé en dataURL PNG. Retourne null si impossible (image absente/cassée). */
function imageElementToDataURL(imgEl) {
  return new Promise((resolve) => {
    if (!imgEl) { resolve(null); return; }
    const draw = () => {
      try {
        if (!imgEl.naturalWidth || !imgEl.naturalHeight) { resolve(null); return; }
        const canvas = document.createElement('canvas');
        canvas.width = imgEl.naturalWidth;
        canvas.height = imgEl.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imgEl, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch (e) {
        resolve(null); // image cassée / canvas "tainted" -> on continue sans logo
      }
    };
    if (imgEl.complete && imgEl.naturalWidth > 0) draw();
    else {
      imgEl.addEventListener('load', draw, { once: true });
      imgEl.addEventListener('error', () => resolve(null), { once: true });
    }
  });
}

/**
 * Charge une image du dossier `assets/` (logo de pied de page, fixe, non lié au logo d'en-tête
 * personnalisable) et la convertit en dataURL PNG. Résout `null` en cas d'échec (fichier absent…) —
 * le PDF est alors généré sans logo de pied de page plutôt que d'échouer.
 */
function loadAssetImageAsDataURL(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve({ dataUrl: canvas.toDataURL('image/png'), w: img.naturalWidth, h: img.naturalHeight });
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function getScaledDims(imgEl, maxHeight) {
  const nw = imgEl.naturalWidth || 1;
  const nh = imgEl.naturalHeight || 1;
  const h = maxHeight;
  const w = h * (nw / nh);
  return { w, h };
}

/**
 * Renvoie les lignes du pacing dont un repère (nom) a été renseigné, avec la distance cumulée
 * calculée (fin de segment), triées par ordre de parcours.
 *
 * - `pause` : la pause ravito réglée sur cette ligne (min), affichée dans sa propre colonne.
 * - `tempsSegment` : temps de déplacement pur entre ce repère et le repère précédent (somme des temps
 *   V2 de tous les segments intermédiaires, y compris non nommés) — la pause ravito de CE repère en est
 *   volontairement exclue (elle est déjà affichée à part) pour ne pas la compter deux fois. Non affiché
 *   directement dans le tableau du PDF (seul `tempsSegmentNext`, ci-dessous, l'est), mais utilisé en
 *   interne pour le calculer.
 * - `tempsSegmentNext` : le `tempsSegment` du repère SUIVANT, vu depuis cette ligne — même logique de
 *   décalage que `distNext`/`dPlusNext`/`dMinusNext` : permet à l'assistance de lire, sur une seule
 *   ligne, la distance, le D+, le D- ET le temps prévisionnel jusqu'au prochain ravito, sans changer
 *   de ligne. `null` pour le dernier repère (l'arrivée), qui n'a pas de suivant.
 * - `dPlus` / `dMinus` : D+/D- entre ce repère et le repère précédent (somme sur tous les segments
 *   intermédiaires, y compris non nommés) — et non le D+/D- du seul segment portant le repère. Non
 *   affichés directement dans le tableau du PDF (seuls les cumuls et les valeurs "suivant" le sont),
 *   mais utilisés en interne pour les calculer.
 * - `dPlusCumul` / `dMinusCumul` : D+/D- cumulé depuis le départ de la course jusqu'à ce repère.
 * - `cumulV2` / `cumulV2HM` : temps cumulé total au départ de ce repère (pause ravito de ce repère
 *   comprise), identique à la colonne "Temps cumulé" de l'onglet Pacing.
 * - `heureArrivee` : heure de passage estimée (horloge), calculée depuis `state.heureDepart` + le
 *   temps cumulé — `null` si aucune heure de départ n'a été renseignée.
 * - `distNext` / `dPlusNext` / `dMinusNext` : distance, D+ et D- entre ce repère et le repère SUIVANT (utile pour savoir,
 *   en quittant un ravito, ce qu'il reste à parcourir avant le prochain) — `null` pour le dernier repère
 *   (l'arrivée), qui n'a pas de suivant.
 *
 * Cas particulier du premier repère (le départ) : toutes ses valeurs numériques sont forcées à 0 (par
 * définition, rien n'a encore été parcouru/gravi/écoulé au départ), à l'exception de l'heure de
 * passage qui reprend telle quelle l'heure de départ renseignée. Ceci n'efface aucune information :
 * les mêmes valeurs (distance et D+ jusqu'au départ) restent visibles sur la ligne du repère suivant.
 */
function getLandmarkRows(state) {
  if (!state.pacing) return [];

  // Cumuls de D+/D- sur TOUS les segments du parcours (nommés ou non), dans l'ordre, pour pouvoir
  // ensuite calculer à la fois le delta depuis le repère précédent et le cumul depuis le départ pour
  // chaque repère nommé — même logique que `cumulV2` (déjà cumulé sur tous les segments).
  let cumDPlus = 0;
  let cumDMinus = 0;
  const allRows = state.pacing.rows.map((row) => {
    cumDPlus += row.dPlus || 0;
    cumDMinus += row.dMinus || 0;
    const meta = state.rowMeta[row.numero];
    return {
      numero: row.numero,
      label: meta && meta.label ? meta.label.trim() : '',
      type: row.type,
      distCumFin: (row.distCumDebut || 0) + (row.distanceKm || 0),
      pause: row.pause || 0,
      cumulV2: row.cumulV2,
      cumulV2HM: row.cumulV2HM,
      dPlusCumul: excelRound(cumDPlus, 1),
      dMinusCumul: excelRound(cumDMinus, 1),
    };
  });

  const rows = allRows.filter((row) => row.label !== '');

  let prevCumul = 0;
  let prevDPlusCumul = 0;
  let prevDMinusCumul = 0;
  rows.forEach((lm) => {
    const cumulDeparture = (lm.cumulV2 !== null && lm.cumulV2 !== undefined) ? lm.cumulV2 : prevCumul;
    lm.tempsSegment = excelRound(cumulDeparture - prevCumul - lm.pause, 1);
    prevCumul = cumulDeparture;

    lm.dPlus = excelRound(lm.dPlusCumul - prevDPlusCumul, 1);
    lm.dMinus = excelRound(lm.dMinusCumul - prevDMinusCumul, 1);
    prevDPlusCumul = lm.dPlusCumul;
    prevDMinusCumul = lm.dMinusCumul;

    lm.heureArrivee = state.heureDepart ? computeArrivalClock(state.heureDepart, lm.cumulV2) : null;
  });

  // Distance/D+/D-/temps jusqu'au repère suivant : lookahead sur le tableau déjà rempli ci-dessus
  // (chaque repère connaît désormais sa propre distance cumulée, son propre D+/D- et son propre temps
  // "depuis le précédent", qui est exactement la distance/D+/D-/temps "jusqu'au suivant" vu depuis la
  // ligne d'avant). Objectif : que l'assistance lise, sur UNE seule ligne, tout ce qui l'attend avant
  // le prochain ravito (distance, D+, D- ET temps prévisionnel), sans avoir à changer de ligne.
  rows.forEach((lm, i) => {
    const next = rows[i + 1];
    lm.distNext = next ? excelRound(next.distCumFin - lm.distCumFin, 2) : null;
    lm.dPlusNext = next ? next.dPlus : null;
    lm.dMinusNext = next ? next.dMinus : null;
    lm.tempsSegmentNext = next ? next.tempsSegment : null;
  });

  // Le premier repère nommé est par convention le départ de la course : toutes ses valeurs
  // numériques valent 0 (rien n'a encore été parcouru), sauf l'heure de passage (qui reprend l'heure
  // de départ renseignée telle quelle) et la distance/D+ jusqu'au repère suivant, qui restent les
  // vraies valeurs calculées ci-dessus — c'est justement l'information utile à afficher au départ
  // (ce qu'il reste à parcourir avant le premier ravito).
  if (rows.length > 0) {
    const first = rows[0];
    first.distCumFin = 0;
    first.dPlus = 0;
    first.dMinus = 0;
    first.dPlusCumul = 0;
    first.dMinusCumul = 0;
    first.tempsSegment = 0;
    first.pause = 0;
    first.cumulV2 = 0;
    first.cumulV2HM = formatHM(0);
    first.heureArrivee = state.heureDepart || null;
  }

  return rows;
}

/**
 * Construit le profil altimétrique (distance cumulée en km / altitude en m) à afficher sur le graphique,
 * du plus fiable au moins précis selon ce qui est disponible :
 * 1. GPX officiel de la course, si chargé (`state.gpxElevationProfile`) — volontairement prioritaire sur
 *    la reconnaissance GPS : un tracé officiel est généralement plus fiable qu'un relevé de montre sur
 *    plusieurs jours (dérive d'altitude cumulée) ;
 * 2. points GPS bruts de l'import en cours (profil fin, ré-échantillonné à ~400 points) ;
 * 3. profil échantillonné stocké dans l'estimation rechargée (`state.elevationProfile`) — bien plus
 *    précis que la reconstruction depuis les seuls D+/D- des segments, disponible même sans les points
 *    GPS bruts complets (non conservés dans l'historique athlète pour rester léger) ;
 * 4. profil approximatif (altitude relative, départ à 0) reconstruit depuis les D+/D- des segments —
 *    dernier repli si aucune des sources précédentes n'est disponible.
 */
function buildElevationProfile(state) {
  if (state.gpxElevationProfile && state.gpxElevationProfile.length >= 2) {
    return { points: state.gpxElevationProfile, source: 'gpx' };
  }

  const fromRaw = downsampleElevationProfile(state.csvRows);
  if (fromRaw) return { points: fromRaw, source: 'fit' };

  if (state.elevationProfile && state.elevationProfile.length >= 2) {
    return { points: state.elevationProfile, source: 'fit' };
  }

  // Dernier repli : profil approximatif reconstruit depuis les segments (altitude relative, départ à 0).
  const points = [{ distKm: 0, alt: 0 }];
  let cum = 0;
  let alt = 0;
  (state.segments || []).forEach((seg) => {
    cum += seg.distanceKm || 0;
    alt += (seg.dPlus || 0) - (seg.dMinus || 0);
    points.push({ distKm: cum, alt });
  });
  return { points, source: 'approximate' };
}

/**
 * Dessine le profil altimétrique + marqueurs de repères sur un canvas hors écran, et renvoie ce canvas
 * (converti ensuite en image PNG pour être inséré dans le PDF).
 */
function drawElevationChartCanvas(profile, landmarks, totalDistanceKm) {
  const W = 1700;
  // Repères alternés au-dessus ET en-dessous du graphique (1 sur 2 en haut, 1 sur 2 en bas) pour
  // limiter les recouvrements — la hauteur totale du canvas est donc plus grande dès qu'il y a des
  // repères, pour réserver de la place aux étiquettes du bas en plus de celles du haut.
  const padAxisBottom = 60; // axe + graduations de distance (inchangé, jamais de repère ici)
  const padLabelsBottom = landmarks.length ? 90 : 0; // étiquettes de repères "en bas", sous l'axe
  const H = 620 + padLabelsBottom;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const pts = profile.points;
  const padL = 80;
  const padR = 30;
  // +38 pour une rangée dédiée, tout en haut, au départ et à l'arrivée (cf. boucle des repères plus bas).
  const padTop = landmarks.length ? 108 : 40;
  const padBottom = padAxisBottom + padLabelsBottom;
  const plotW = W - padL - padR;
  const plotH = H - padTop - padBottom;

  const altitudes = pts.map((p) => p.alt);
  const minAlt = Math.min(...altitudes);
  const maxAlt = Math.max(...altitudes);
  const altRange = Math.max(1, maxAlt - minAlt);
  const altPad = altRange * 0.12;
  const yMin = minAlt - altPad;
  const yMax = maxAlt + altPad;
  const maxDist = totalDistanceKm || pts[pts.length - 1].distKm || 1;

  const xOf = (d) => padL + (d / maxDist) * plotW;
  const yOf = (a) => padTop + plotH - ((a - yMin) / (yMax - yMin)) * plotH;

  // Grille + axes
  ctx.strokeStyle = '#e1e6e3';
  ctx.lineWidth = 1.5;
  ctx.font = '19px -apple-system, sans-serif';
  ctx.fillStyle = '#6b7770';
  const nYTicks = 5;
  for (let i = 0; i <= nYTicks; i++) {
    const a = yMin + ((yMax - yMin) * i) / nYTicks;
    const y = yOf(a);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(a)} m`, padL - 12, y + 6);
  }
  const nXTicks = Math.min(12, Math.max(4, Math.round(maxDist / 5)));
  ctx.textAlign = 'center';
  for (let i = 0; i <= nXTicks; i++) {
    const d = (maxDist * i) / nXTicks;
    ctx.fillText(`${d.toFixed(1)} km`, xOf(d), H - padBottom + 32);
  }
  ctx.strokeStyle = '#b4b2a9';
  ctx.beginPath(); ctx.moveTo(padL, padTop); ctx.lineTo(padL, H - padBottom); ctx.lineTo(W - padR, H - padBottom); ctx.stroke();

  // Aire remplie + ligne d'altitude
  ctx.beginPath();
  pts.forEach((p, i) => { const x = xOf(p.distKm); const y = yOf(p.alt); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.lineTo(xOf(pts[pts.length - 1].distKm), yOf(yMin));
  ctx.lineTo(xOf(pts[0].distKm), yOf(yMin));
  ctx.closePath();
  ctx.fillStyle = CHART_GREEN_FILL;
  ctx.fill();

  ctx.beginPath();
  pts.forEach((p, i) => { const x = xOf(p.distKm); const y = yOf(p.alt); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.strokeStyle = CHART_GREEN_LINE;
  ctx.lineWidth = 4;
  ctx.stroke();

  // Repères : ligne verticale pointillée + point + étiquette. Départ et Arrivée sont un cas
  // particulier : à l'extrémité gauche/droite du graphique, un texte centré déborderait du canvas et
  // serait tronqué — ils sont donc alignés vers l'intérieur (gauche pour le départ, droite pour
  // l'arrivée), placés sur une rangée dédiée tout en haut (au-dessus des autres étiquettes) et dans
  // une couleur différente (rose de la marque) pour bien les distinguer des repères intermédiaires.
  // Les repères intermédiaires alternent 1 sur 2 au-dessus / 1 sur 2 en-dessous du graphique pour
  // répartir les étiquettes et limiter les recouvrements.
  const plotBottomY = H - padBottom; // haut de l'axe des distances (bas réel de la zone du graphique)
  let middleRank = 0;
  landmarks.forEach((lm) => {
    const x = xOf(lm.distCumFin);
    // "Bord" = repère situé tout près du départ ou de l'arrivée réelle du parcours (pas juste le
    // premier/dernier repère nommé) : un texte centré y déborderait du canvas et serait tronqué.
    const isStart = lm.distCumFin <= maxDist * 0.02;
    const isEnd = !isStart && lm.distCumFin >= maxDist * 0.98;
    const isEdge = isStart || isEnd;

    let nearest = pts[0];
    let bestDiff = Infinity;
    for (const p of pts) {
      const diff = Math.abs(p.distKm - lm.distCumFin);
      if (diff < bestDiff) { bestDiff = diff; nearest = p; }
    }
    const dotY = yOf(nearest.alt);

    const lineColor = isEdge ? '#ff216a' : '#0505c5';
    ctx.setLineDash([7, 6]);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, padTop); ctx.lineTo(x, plotBottomY); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = lineColor;
    ctx.beginPath(); ctx.arc(x, dotY, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();

    const kmLine = `${lm.distCumFin.toFixed(1)} km · D+${Math.round(lm.dPlus)} m · D-${Math.round(lm.dMinus)} m`;

    if (isEdge) {
      ctx.textAlign = isStart ? 'left' : 'right';
      const textX = isStart ? Math.max(x, padL) : Math.min(x, W - padR);
      const nameY = 26;
      ctx.font = 'bold 21px -apple-system, sans-serif';
      ctx.fillStyle = '#ff216a';
      ctx.fillText(lm.label, textX, nameY);
      ctx.font = '18px -apple-system, sans-serif';
      ctx.fillStyle = '#444441';
      ctx.fillText(kmLine, textX, nameY + 24);
    } else {
      const onTop = middleRank % 2 === 0;
      middleRank += 1;
      ctx.textAlign = 'center';
      if (onTop) {
        const labelBaseY = padTop - 14;
        ctx.font = 'bold 21px -apple-system, sans-serif';
        ctx.fillStyle = '#0505c5';
        ctx.fillText(lm.label, x, labelBaseY - 20);
        ctx.font = '18px -apple-system, sans-serif';
        ctx.fillStyle = '#444441';
        ctx.fillText(kmLine, x, labelBaseY);
      } else {
        const labelBaseY = plotBottomY + padAxisBottom + 26; // sous la ligne des graduations de distance
        ctx.font = 'bold 21px -apple-system, sans-serif';
        ctx.fillStyle = '#0505c5';
        ctx.fillText(lm.label, x, labelBaseY);
        ctx.font = '18px -apple-system, sans-serif';
        ctx.fillStyle = '#444441';
        ctx.fillText(kmLine, x, labelBaseY + 24);
      }
    }
  });

  return canvas;
}

/**
 * Génère et télécharge le PDF récapitulatif de pacing.
 * @param {object} state état de l'application (cf. main.js)
 */
async function generatePacingPDF(state) {
  if (typeof window.jspdf === 'undefined') {
    throw new Error("La librairie de génération PDF n'a pas pu être chargée (vérifiez votre connexion internet).");
  }
  if (!state.pacing || state.pacing.rows.length === 0) {
    throw new Error("Aucun pacing calculé — importez d'abord une reconnaissance GPS.");
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 15;
  let cursorY = 16;

  // ---- En-tête : logo + titre ----
  const logoImg = document.getElementById('app-logo');
  const logoVisible = logoImg && logoImg.style.display !== 'none';
  const logoDataUrl = logoVisible ? await imageElementToDataURL(logoImg) : null;

  let textX = marginX;
  if (logoDataUrl) {
    const dims = getScaledDims(logoImg, 16);
    try { doc.addImage(logoDataUrl, 'PNG', marginX, cursorY - 4, dims.w, dims.h); } catch (e) { /* ignore */ }
    textX = marginX + dims.w + 6;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...BRAND_BLUE_RGB);
  const title = `Prévisionnel d'allure pour la course ${state.courseNom || ''}`;
  const titleLines = doc.splitTextToSize(title, pageWidth - textX - marginX);
  doc.text(titleLines, textX, cursorY + 2);
  cursorY += 2 + titleLines.length * 6;

  const activeAthlete = (state.athletes || []).find((a) => a.id === state.activeAthleteId) || null;
  const subtitleWidth = pageWidth - textX - marginX;

  // Nom de l'athlète mis en avant sur sa propre ligne (plus visible que noyé dans la ligne km/D+/D-).
  if (activeAthlete) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...BRAND_BLUE_RGB);
    // Pas d'emoji ici : les polices standard PDF (helvetica) ne savent pas les afficher et
    // produisent des glyphes cassés (ex. "Ø=Üd" à la place de 👤) — texte brut uniquement.
    const athleteLine = `Athlète : ${athleteFullName(activeAthlete)}`;
    const athleteLines = doc.splitTextToSize(athleteLine, subtitleWidth);
    doc.text(athleteLines, textX, cursorY + 3);
    cursorY += 3 + athleteLines.length * 5.5;
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(90, 90, 90);
  const subtitle = [
    `${fmtPdf(state.auto.distanceTotaleKm, 1)} km`,
    `D+ ${fmtPdf(state.auto.dPlusTotal, 0)} m`,
    `D- ${fmtPdf(state.auto.dMinusTotal, 0)} m`,
    `Catégorie : ${state.categorie}`,
  ].join('   ·   ');
  const subtitleLines = doc.splitTextToSize(subtitle, subtitleWidth);
  doc.text(subtitleLines, textX, cursorY + 3);
  doc.setTextColor(0, 0, 0);

  cursorY += 3 + subtitleLines.length * 5.5;
  cursorY = Math.max(cursorY + 6, marginX + 24);

  // ---- Profil altimétrique ----
  const landmarks = getLandmarkRows(state);
  const profile = buildElevationProfile(state);
  const canvas = drawElevationChartCanvas(profile, landmarks, state.auto.distanceTotaleKm);
  const chartDataUrl = canvas.toDataURL('image/png');
  const chartW = pageWidth - marginX * 2;
  const chartH = chartW * (canvas.height / canvas.width);
  doc.addImage(chartDataUrl, 'PNG', marginX, cursorY, chartW, chartH);
  cursorY += chartH + 4;

  if (profile.source === 'approximate') {
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text("Profil altimétrique approximatif (estimation reconstruite depuis les segments, sans les points GPS bruts).", marginX, cursorY + 3);
    doc.setTextColor(0, 0, 0);
    cursorY += 6;
  } else if (profile.source === 'gpx') {
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text("Profil altimétrique basé sur le tracé GPX officiel de la course.", marginX, cursorY + 3);
    doc.setTextColor(0, 0, 0);
    cursorY += 6;
  }

  cursorY += 6;

  // ---- Tableau des repères ----
  if (landmarks.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(11);
    doc.setTextColor(120, 120, 120);
    doc.text("Aucun repère renseigné : ajoutez un nom dans la colonne « Repère » du tableau Pacing pour qu'il apparaisse ici.", marginX, cursorY + 5);
    doc.setTextColor(0, 0, 0);
  } else {
    // Ordre des colonnes pensé en deux blocs : le premier (bandeau bleu) regroupe ce qui est utile au
    // coureur en train de courir (où il en est) ; le second (bandeau vert, même vert que le graphique
    // altimétrique) regroupe ce qui sert surtout à l'assistance/logistique (ce qui l'attend ensuite).
    const ASSIST_COL_START = 6; // index de la première colonne "assistance" ("Distance suivante")
    const body = landmarks.map((lm) => [
      lm.label,
      fmtPdf(lm.distCumFin, 2),
      fmtPdfInt(lm.dPlusCumul),
      fmtPdfInt(lm.dMinusCumul),
      formatHMPdf(lm.cumulV2),
      lm.pause > 0 ? fmtPdfInt(lm.pause) : '—',
      (lm.distNext !== null && lm.distNext !== undefined) ? fmtPdf(lm.distNext, 2) : '—',
      (lm.dPlusNext !== null && lm.dPlusNext !== undefined) ? fmtPdfInt(lm.dPlusNext) : '—',
      (lm.dMinusNext !== null && lm.dMinusNext !== undefined) ? fmtPdfInt(lm.dMinusNext) : '—',
      (lm.tempsSegmentNext !== null && lm.tempsSegmentNext !== undefined) ? formatHMPdf(lm.tempsSegmentNext) : '—',
      lm.heureArrivee || '—',
    ]);
    doc.autoTable({
      startY: cursorY,
      head: [[
        'Repère', 'Distance cumulée (km)', 'D+ cumulé', 'D- cumulé', 'Temps cumulé', 'Ravito (min)',
        'Distance suivante (km)', 'D+ suivant', 'D- suivant', 'Temps segment suivant', 'Heure passage',
      ]],
      body,
      theme: 'striped',
      headStyles: { fillColor: BRAND_BLUE_RGB, textColor: 255 },
      alternateRowStyles: { fillColor: [244, 246, 245] },
      styles: { fontSize: 7.5, cellPadding: 1.8 },
      columnStyles: {
        0: { fontStyle: 'bold' }, // Repère : nom du point mis en avant
        5: { cellWidth: 13 },     // Ravito : colonne resserrée (valeurs courtes, souvent "—")
        // Largeur minimale réservée aux colonnes courtes mais sans espace (donc jamais de retour à la
        // ligne à proprement parler), pour éviter que l'algorithme d'auto-largeur ne les compresse trop.
        10: { cellWidth: 17, halign: 'center' },
      },
      // Bandeau d'en-tête à deux couleurs : bleu pour les colonnes "coureur", vert pour les colonnes
      // "assistance" (à partir de ASSIST_COL_START) — uniquement l'en-tête, le corps du tableau garde
      // ses rayures habituelles pour ne pas surcharger la lecture des données.
      didParseCell: (data) => {
        if (data.section === 'head' && data.column.index >= ASSIST_COL_START) {
          data.cell.styles.fillColor = ASSIST_GREEN_RGB;
        }
      },
      margin: { left: marginX, right: marginX, bottom: 26 },
    });
  }

  // ---- Bandeau de pied de page : logo + coordonnées ----
  const pageHeight = doc.internal.pageSize.getHeight();
  const footerLogo = await loadAssetImageAsDataURL('assets/footer-logo.png');
  const footerTop = pageHeight - 22;

  doc.setDrawColor(225, 230, 227);
  doc.setLineWidth(0.3);
  doc.line(marginX, footerTop, pageWidth - marginX, footerTop);

  let footerTextX = marginX;
  if (footerLogo) {
    const logoH = 13;
    const logoW = logoH * (footerLogo.w / footerLogo.h);
    try { doc.addImage(footerLogo.dataUrl, 'PNG', marginX, footerTop + 4.5, logoW, logoH); } catch (e) { /* ignore */ }
    footerTextX = marginX + logoW + 6;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(31, 42, 36);
  doc.text('Maxime CHELDA', footerTextX, footerTop + 9);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(90, 90, 90);
  doc.text('Préparateur physique   ·   maxime@ruthene-coachin.fr   ·   06.32.19.57.79', footerTextX, footerTop + 14.5);
  doc.setTextColor(0, 0, 0);

  doc.save(`pacing-${slugify(state.courseNom)}.pdf`);
}

if (typeof module !== 'undefined') {
  module.exports = {
    slugify, fmtPdfInt, formatHMPdf, computeArrivalClock, getLandmarkRows, buildElevationProfile, drawElevationChartCanvas, generatePacingPDF,
  };
}
