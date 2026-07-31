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

/**
 * Formate un nombre pour un rendu jsPDF : `fmt()` insère un espace fine insécable (séparateur de
 * milliers en français) que la police standard du PDF ne sait pas afficher (elle le rend en glyphe
 * cassé, visible comme un « / »). On la remplace par un espace normal, sans risque ici.
 */
function fmtPdf(n, digits = 0) {
  return fmt(n, digits).replace(/[  ]/g, ' ');
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
 *   volontairement exclue (elle est déjà affichée à part) pour ne pas la compter deux fois.
 * - `cumulV2` / `cumulV2HM` : temps cumulé total au départ de ce repère (pause ravito de ce repère
 *   comprise), identique à la colonne "Temps cumulé" de l'onglet Pacing.
 */
function getLandmarkRows(state) {
  if (!state.pacing) return [];
  const rows = state.pacing.rows
    .filter((row) => state.rowMeta[row.numero] && state.rowMeta[row.numero].label && state.rowMeta[row.numero].label.trim() !== '')
    .map((row) => ({
      numero: row.numero,
      label: state.rowMeta[row.numero].label.trim(),
      type: row.type,
      distCumFin: (row.distCumDebut || 0) + (row.distanceKm || 0),
      dPlus: row.dPlus,
      dMinus: row.dMinus,
      pause: row.pause || 0,
      cumulV2: row.cumulV2,
      cumulV2HM: row.cumulV2HM,
    }));

  let prevCumul = 0;
  rows.forEach((lm) => {
    const cumulDeparture = (lm.cumulV2 !== null && lm.cumulV2 !== undefined) ? lm.cumulV2 : prevCumul;
    lm.tempsSegment = excelRound(cumulDeparture - prevCumul - lm.pause, 1);
    prevCumul = cumulDeparture;
  });

  return rows;
}

/**
 * Construit le profil altimétrique (distance cumulée en km / altitude en m) à afficher sur le graphique.
 * Utilise les points GPS bruts si disponibles (profil fin) ; sinon reconstruit un profil approximatif
 * (altitude relative) à partir des D+/D- de chaque segment — cas d'une estimation rechargée depuis un
 * profil athlète, qui ne conserve pas les points GPS bruts.
 */
function buildElevationProfile(state) {
  if (state.csvRows && state.csvRows.length > 1) {
    const rows = state.csvRows;
    const maxPoints = 400;
    const step = Math.max(1, Math.floor(rows.length / maxPoints));
    const points = [];
    for (let i = 0; i < rows.length; i += step) {
      const r = rows[i];
      if (typeof r.distance_cum_m === 'number' && typeof r.altitude_m === 'number') {
        points.push({ distKm: r.distance_cum_m / 1000, alt: r.altitude_m });
      }
    }
    const last = rows[rows.length - 1];
    if (last && typeof last.distance_cum_m === 'number' && typeof last.altitude_m === 'number') {
      const lastKm = last.distance_cum_m / 1000;
      if (!points.length || points[points.length - 1].distKm !== lastKm) {
        points.push({ distKm: lastKm, alt: last.altitude_m });
      }
    }
    if (points.length >= 2) return { points, approximate: false };
  }

  // Repli : profil approximatif reconstruit depuis les segments (altitude relative, départ à 0).
  const points = [{ distKm: 0, alt: 0 }];
  let cum = 0;
  let alt = 0;
  (state.segments || []).forEach((seg) => {
    cum += seg.distanceKm || 0;
    alt += (seg.dPlus || 0) - (seg.dMinus || 0);
    points.push({ distKm: cum, alt });
  });
  return { points, approximate: true };
}

/**
 * Dessine le profil altimétrique + marqueurs de repères sur un canvas hors écran, et renvoie ce canvas
 * (converti ensuite en image PNG pour être inséré dans le PDF).
 */
function drawElevationChartCanvas(profile, landmarks, totalDistanceKm) {
  const W = 1700;
  const H = 620;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const pts = profile.points;
  const padL = 80;
  const padR = 30;
  const padTop = landmarks.length ? 130 : 40;
  const padBottom = 60;
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

  // Repères : ligne verticale pointillée + point + étiquette (empilée en alternance pour limiter les recouvrements)
  landmarks.forEach((lm, idx) => {
    const x = xOf(lm.distCumFin);

    let nearest = pts[0];
    let bestDiff = Infinity;
    for (const p of pts) {
      const diff = Math.abs(p.distKm - lm.distCumFin);
      if (diff < bestDiff) { bestDiff = diff; nearest = p; }
    }
    const dotY = yOf(nearest.alt);

    ctx.setLineDash([7, 6]);
    ctx.strokeStyle = '#0505c5';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, padTop); ctx.lineTo(x, H - padBottom); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#0505c5';
    ctx.beginPath(); ctx.arc(x, dotY, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();

    const rowIdx = idx % 2;
    const labelBaseY = padTop - 14 - rowIdx * 42;

    ctx.textAlign = 'center';
    ctx.font = 'bold 21px -apple-system, sans-serif';
    ctx.fillStyle = '#0505c5';
    ctx.fillText(lm.label, x, labelBaseY - 20);
    ctx.font = '18px -apple-system, sans-serif';
    ctx.fillStyle = '#444441';
    ctx.fillText(`${lm.distCumFin.toFixed(1)} km · D+${Math.round(lm.dPlus)} m · D-${Math.round(lm.dMinus)} m`, x, labelBaseY);
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
    const athleteLine = `👤 ${athleteFullName(activeAthlete)}`;
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

  if (profile.approximate) {
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text("Profil altimétrique approximatif (estimation reconstruite depuis les segments, sans les points GPS bruts).", marginX, cursorY + 3);
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
    const body = landmarks.map((lm) => [
      lm.label,
      `${fmtPdf(lm.distCumFin, 2)} km`,
      `${fmtPdf(lm.dPlus, 0)} m`,
      `${fmtPdf(lm.dMinus, 0)} m`,
      formatHM(lm.tempsSegment),
      lm.pause > 0 ? `${fmtPdf(lm.pause, 0)} min` : '—',
      lm.cumulV2HM,
    ]);
    doc.autoTable({
      startY: cursorY,
      head: [['Repère', 'Distance cumulée', 'D+', 'D-', 'Temps segment', 'Pause ravito', 'Temps cumulé']],
      body,
      theme: 'striped',
      headStyles: { fillColor: BRAND_BLUE_RGB, textColor: 255 },
      alternateRowStyles: { fillColor: [244, 246, 245] },
      styles: { fontSize: 9, cellPadding: 2.5 },
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
    slugify, getLandmarkRows, buildElevationProfile, drawElevationChartCanvas, generatePacingPDF,
  };
}
