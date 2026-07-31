# 🏔 Prédicteur de Pacing Trail — V3 (web app)

Application web statique reproduisant fidèlement le classeur Excel **« V3 — Prédicteur de temps trail »** :
import d'un fichier **.fit** (montre GPS) ou d'un CSV GPS déjà traité, segmentation automatique, profil
athlète force-vitesse / descente, et moteur de pacing (temps prévisionnels V1/V2 par segment) avec réglages
d'intensité, de technicité, de conditions et de fatigue. L'application permet aussi de créer des **profils
athlètes** et d'y enregistrer plusieurs estimations de course dans le temps.

Tout le calcul s'exécute **localement dans le navigateur** — aucune donnée n'est envoyée à un serveur.
Aucune dépendance, aucun build : HTML + CSS + JavaScript vanilla.

## 🚀 Démo en ligne

Une fois le dépôt poussé sur GitHub et Pages activé (voir plus bas), l'application sera accessible à :

```
https://<votre-utilisateur-github>.github.io/<nom-du-depot>/
```

## 📦 Déployer sur GitHub Pages

1. Créez un nouveau dépôt GitHub (public ou privé) et poussez le contenu de ce dossier :

   ```bash
   cd trail-pacing-predictor
   git init
   git add .
   git commit -m "Initial commit — Prédicteur de pacing trail V3"
   git branch -M main
   git remote add origin https://github.com/<votre-utilisateur>/<nom-du-depot>.git
   git push -u origin main
   ```

2. Sur GitHub : **Settings → Pages → Build and deployment → Source : GitHub Actions**.
   Le workflow fourni (`.github/workflows/deploy.yml`) déploie automatiquement le site à chaque push sur `main`.

3. Après quelques secondes, l'URL de votre site apparaît dans l'onglet **Actions** (job *pages-build-deployment*)
   et dans **Settings → Pages**.

Aucune étape de build n'est nécessaire : le site est servi tel quel.

> ⚠️ **Cache navigateur** : `index.html` charge `css/style.css` et les fichiers `js/*.js` avec un paramètre
> `?v=20`. Après chaque mise à jour du CSS ou du JS, incrémentez ce numéro (`?v=21`, `?v=22`…) dans `index.html`
> avant de pousser — sinon les navigateurs qui ont déjà visité le site peuvent continuer à afficher
> l'ancienne version de ces fichiers pendant un moment, même après un déploiement réussi.

## 🖥 Utilisation en local

Ouvrir `index.html` directement dans un navigateur fonctionne pour l'essentiel, mais le bouton **« Charger un
exemple »** utilise `fetch()` pour lire `sample-data/exemple_import.csv`, ce qui nécessite un petit serveur local
(les navigateurs bloquent `fetch` sur `file://`) :

```bash
cd trail-pacing-predictor
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

## 🧭 Fonctionnement de l'outil

L'application suit exactement le même pipeline que les onglets du classeur Excel d'origine :

| Onglet Excel | Étape dans l'app | Description |
|---|---|---|
| *(nouveau, sans équivalent Excel)* | **1. Athlètes** | Gestion des profils athlètes et de leurs estimations enregistrées |
| *(nouveau, sans équivalent Excel)* | **2. Import FIT** | Conversion locale d'un fichier `.fit` (montre GPS) vers le format CSV 16 colonnes attendu par l'étape suivante |
| `IMPORT_CSV` | **3. Import CSV** | Collez ou chargez le CSV GPS traité (16 colonnes, séparateur `;`) |
| `TRAITEMENT` | *(interne)* | Segmentation automatique par regroupement des points GPS consécutifs de même type (`segment_type_smooth`) |
| `SEGMENTS` | **5. Segments** | Agrégation par segment : distance, D+/D-, durée, vitesse et pente moyennes |
| `PROFILS` | **6. Profil GPS** | Classification automatique du profil force-vitesse (Grimpeur / Équilibré / Rouleur) et du profil descente, calculée depuis la reconnaissance GPS importée |
| `PARAMÈTRES` | **4. Paramètres** | Infos course (distance/D+/D- calculées auto depuis le CSV), catégorie, apparence (logo), et toutes les tables de coefficients éditables |
| `PACING` | **7. Pacing** | Temps prévisionnels par segment : V1 = sans profil athlète, V2 = ajusté au profil (grimpeur/rouleur + descente) |

### Profils athlètes (nouveau)

L'onglet **1. Athlètes** permet de créer un profil par coureur pour lequel vous réalisez des prédictions :
prénom, nom, âge, taille, poids et VMA. Sélectionnez un athlète comme **actif** (bouton « Sélectionner » sur
sa fiche, qui devient un badge « ✔ Actif » non cliquable une fois sélectionné — un bouton « Désélectionner »
séparé apparaît si besoin, pour éviter de perdre la sélection par un re-clic accidentel) : un bouton
**« Enregistrer dans le profil de … »** apparaît alors dans l'onglet Pacing une fois une estimation calculée.
Chaque enregistrement conserve le nom de la course, la catégorie, les segments, le profil GPS calculé, les
réglages (intensité/technicité/conditions par segment) et les résultats V1/V2 — vous pouvez ainsi accumuler
plusieurs estimations pour un même athlète et les recharger à tout moment (bouton « 📂 Charger » dans la
liste des estimations). Tout est sauvegardé dans le `localStorage` du navigateur ; la taille, l'âge, le
poids et la VMA sont pour l'instant purement informatifs et n'influencent pas le calcul du pacing (qui reste
basé sur les vitesses mesurées lors de la reconnaissance GPS).

**Modifier une estimation déjà enregistrée** : après avoir chargé une estimation existante (« 📂 Charger »)
et modifié des réglages dans l'onglet Pacing, le bouton d'enregistrement se transforme en
**« 💾 Mettre à jour l'estimation du … »** : vos changements remplacent cette même entrée (au lieu d'en
créer une copie). Un bouton secondaire **« 🆕 Enregistrer comme nouvelle estimation »** reste disponible si
vous préférez garder l'ancienne version et en créer une nouvelle à côté. Chaque estimation enregistrée
conserve aussi un **profil altimétrique échantillonné** (~400 points, léger) en plus des segments déjà
agrégés : le graphique de dénivelé du PDF reste donc fidèle au relief réel même après avoir rechargé une
estimation, sans avoir besoin de conserver tous les points GPS bruts (trop volumineux à stocker durablement).

### Travail en cours toujours conservé

Tout ce que vous faites dans l'onglet Pacing (import GPS, segments, repères, pauses, réglages, nom de la
course…) est automatiquement sauvegardé dans le `localStorage` du navigateur au fil de vos modifications, et
restauré au chargement de la page. Changer d'onglet dans le navigateur, fermer puis rouvrir l'onglet, ou
recharger la page ne fait donc plus rien perdre — même sans avoir cliqué sur « Enregistrer cette estimation ».
Seul le bouton **« 🗑 Effacer »** de l'onglet Import CSV efface ce brouillon volontairement.

### Import FIT → CSV

L'onglet **2. Import FIT** lit directement le fichier `.fit` exporté par une montre GPS (Garmin, Wahoo,
Suunto, Coros…) et reconstruit localement, dans le navigateur, les 16 colonnes du format CSV attendu par
l'étape suivante :

- lecture binaire du format FIT (définitions/données, en-têtes normaux et « timestamp compressé ») — aucune
  librairie externe, tout est fait par `js/fit-parser.js` ;
- extraction des points GPS (latitude, longitude, altitude, horodatage) depuis les messages `record` ;
- calcul de la distance entre points par trigonométrie sphérique (formule de Haversine), du dénivelé, de la
  vitesse, de la pente, du lissage sur 5 points et de la classification plat / montée / descente
  (seuils : pente > 3 % = montée, < -3 % = descente, sinon plat) — méthode validée par comparaison exacte
  avec les colonnes déjà calculées d'une reconnaissance GPS réelle.

Une fois converti, le CSV généré peut être envoyé directement vers l'onglet **Import CSV** (bouton
« Envoyer vers l'onglet Import CSV ») ou téléchargé pour archivage.

> Limite connue : si votre montre écrit occasionnellement des points sans coordonnées GPS (perte de signal),
> ces points sont simplement ignorés ; le calcul de distance/temps se fait alors entre les deux points
> valides encadrants.

#### Reconnaissance en plusieurs fois (jusqu'à 4 fichiers .fit)

Si le parcours a été reconnu en plusieurs sorties (donc plusieurs fichiers `.fit`), l'onglet **2. Import
FIT** propose 4 emplacements **« Partie 1 »** à **« Partie 4 »**. Chargez vos fichiers dans l'ordre du
parcours (Partie 1 = début de la course) : l'application les met bout à bout automatiquement pour
reconstituer une seule trace continue, avant de calculer les 16 colonnes GPS habituelles sur l'ensemble.

Chaque partie garde son propre calcul de distance/vitesse/pente (il peut s'écouler plusieurs heures, voire
plusieurs jours, entre deux sorties de reconnaissance — calculer une distance ou une vitesse entre la fin
d'une partie et le début de la suivante n'aurait pas de sens). Seule la **distance cumulée** est décalée
partie par partie pour que le total corresponde bien à la course entière ; le résumé combiné (points GPS,
distance totale, durée) tient compte des parties réellement chargées. Une seule partie suffit si vous n'avez
qu'un seul fichier — le comportement est alors identique à avant. Un bouton **« ✕ Retirer »** apparaît sous
chaque partie chargée pour la retirer et en charger une autre à la place.

### Format du CSV attendu

Le CSV doit contenir exactement ces 16 colonnes (en-tête en première ligne, séparateur `;`, UTF-8) :

```
point_index;time;latitude;longitude;altitude_m;distance_step_m;distance_cum_m;time_step_s;
speed_m_s;speed_km_h;elevation_delta_m;slope_percent_raw;segment_type_raw;
slope_percent_smooth_5pts;speed_km_h_smooth_5pts;segment_type_smooth
```

C'est le même format « GPS traité » que celui utilisé par l'outil Excel d'origine : distance, dénivelé, vitesse
et pente déjà calculés point par point à partir d'une trace GPX, avec un lissage sur 5 points et une
classification plat / montée / descente (seuil : pente < -3 % = descente, > 3 % = montée, sinon plat). Un
fichier d'exemple synthétique est fourni dans `sample-data/exemple_import.csv`.

### Moteur de pacing

Pour chaque segment, le temps prévu est calculé ainsi (identique aux formules Excel) :

```
Coef Terrain   = Coef Technicité × Coef Conditions
% Parcours     = distance cumulée en début de segment / distance totale
Coef Fatigue   = 1 + k × (% Parcours)^1.5        (k dépend de la catégorie de course)
Temps V1 (min) = Durée GPS × Coef Intensité × Coef Terrain × Coef Fatigue
Temps V2 (min) = Temps V1 × Coef Profil           (profil athlète : montée/plat/descente)
```

Les cumuls (V1 et V2) s'additionnent segment par segment, avec les pauses ravitaillement ajoutées à chaque
étape.

### Repères et export ciblé (roadbook)

Dans l'onglet **Pacing**, chaque ligne dispose de deux colonnes supplémentaires en début de tableau :

- une case à cocher (☑) pour sélectionner les lignes à exporter — une case « Tout » dans l'en-tête permet de
  tout cocher/décocher d'un coup ;
- un champ **Repère** libre pour nommer le point (village traversé, ravitaillement, sommet…), utile pour se
  repérer sur le parcours.

Une colonne **Distance cumulée (km)** (distance déjà parcourue une fois le segment terminé) est affichée par
défaut pour savoir où se situe chaque repère sur le parcours.

Le bouton **« Exporter le pacing en CSV »** exporte uniquement les lignes cochées si au moins une case est
sélectionnée (utile pour un roadbook allégé avec seulement les points clés) ; si aucune ligne n'est cochée,
il exporte l'intégralité du tableau comme avant.

### Export PDF (roadbook)

Dans l'onglet **Pacing**, le bouton **« 🖨 Générer le PDF »** produit un document A4 téléchargeable
comprenant :

- un en-tête avec votre logo, le titre « Prévisionnel d'allure pour la course *(nom saisi dans
  l'onglet Paramètres)* », le **nom de l'athlète actif** sur sa propre ligne bien visible (le cas
  échéant), puis le kilométrage total, le D+, le D- et la catégorie ;
- le profil altimétrique du parcours (aire verte). Par ordre de priorité : le **GPX officiel de la
  course** si vous en avez chargé un (voir ci-dessous) — plus fiable qu'un relevé de montre sur
  plusieurs jours ; sinon les points GPS bruts de la reconnaissance importée (.fit) ; sinon, si une
  estimation a été rechargée depuis un profil athlète (sans points GPS bruts), le profil échantillonné
  conservé dans cette estimation ; et en tout dernier recours, un profil approximatif recalculé à
  partir des D+/D- de chaque segment (signalé comme tel sur le PDF) ;
- sur ce graphique, un repère visuel (ligne pointillée + point) pour chaque ligne du tableau Pacing
  dont le champ **Repère** est renseigné, avec son nom, sa distance cumulée et son D+/D- ; les
  étiquettes des repères intermédiaires sont réparties **une fois sur deux au-dessus et une fois sur
  deux en-dessous** du graphique pour rester lisibles même avec de nombreux repères rapprochés. Le
  **départ et l'arrivée** sont traités à part : placés tout en haut, dans une couleur différente
  (rose) pour bien les distinguer, et alignés vers l'intérieur du graphique (plutôt que centrés) pour
  ne jamais être tronqués en bord de page ;
- un tableau récapitulatif ne reprenant que ces mêmes lignes « Repère » (distance cumulée, D+, D-,
  **D+ cumulé, D- cumulé**, temps du segment, **pause ravito** et temps cumulé). Le D+ et le D- de
  chaque ligne correspondent au dénivelé entre ce repère et le précédent repère renseigné (somme des
  segments intermédiaires, y compris non nommés) — et non au seul segment portant le repère ; le D+
  cumulé et le D- cumulé indiquent, eux, le dénivelé total depuis le départ de la course jusqu'à ce
  repère. Le temps du segment est le temps de déplacement pur entre ce repère et le précédent repère
  renseigné (même logique de calcul que le D+/D- du segment) — la pause ravito de ce repère est
  volontairement exclue du temps de segment et affichée séparément dans sa propre colonne, pour ne
  pas la compter deux fois ;
- un bandeau de pied de page avec le logo Ruthene Coach'in — Pôle sport & santé
  (`assets/footer-logo.png`) et les coordonnées du préparateur physique.

Renseignez donc au moins un **Repère** dans le tableau Pacing avant de générer le PDF pour que le
tableau et les annotations du graphique soient utiles. La génération se fait entièrement dans le
navigateur (librairies jsPDF / jspdf-autotable chargées depuis un CDN), sans envoi de données à un
serveur.

#### Profil altimétrique de référence (GPX officiel)

Si le relevé GPS de votre reconnaissance (.fit) est imprécis — dérive d'altitude sur plusieurs jours,
montre sans altimètre barométrique fiable — vous pouvez charger le **tracé GPX officiel de la course**
dans la carte « Export PDF » de l'onglet Pacing (bouton « 🗺️ Charger le GPX officiel »). Son profil
altimétrique remplace alors celui de la reconnaissance GPS **uniquement sur le graphique du PDF** : les
segments, les temps et le pacing restent basés sur votre reconnaissance GPS, seule l'allure du relief
affichée change. Le fichier est analysé localement (traces `trkpt`, routes `rtept` ou points isolés
`wpt`, dans cet ordre de priorité) et le profil retenu est conservé si vous enregistrez l'estimation
dans le profil d'un athlète. Un bouton « ↺ Revenir au profil de la reconnaissance GPS » permet de
retirer le GPX à tout moment.

## ⚙ Personnalisation

Toutes les tables de coefficients (fatigue, intensité, technicité, conditions, profils) sont éditables dans
l'onglet **Paramètres → Tables de coefficients (avancé)** et sont sauvegardées automatiquement dans le
`localStorage` du navigateur. Un bouton **« Réinitialiser aux valeurs par défaut »** permet de revenir à la
configuration d'origine du classeur Excel.

### Logo et couleurs du bandeau

Le bandeau du haut utilise par défaut le logo fourni dans `assets/logo.png` et un bleu assorti
(`#0505c5`, variable CSS `--brand-blue` dans `css/style.css`). Vous pouvez remplacer le logo directement
depuis l'onglet **Paramètres → Apparence** (bouton « Charger un logo ») : il est stocké dans le
`localStorage` du navigateur, aucune modification de fichier ni nouveau push GitHub n'est nécessaire. Pour
changer la couleur du bandeau de façon permanente, éditez `--brand-blue` / `--brand-blue-dark` dans
`css/style.css`.

## 🗂 Structure du projet

```
trail-pacing-predictor/
├── index.html                    Page principale (7 onglets)
├── css/style.css                 Styles
├── assets/logo.png                Logo par défaut du bandeau
├── js/
│   ├── data.js                   Tables de coefficients par défaut
│   ├── engine.js                 Moteur de calcul (port fidèle des formules Excel)
│   ├── fit-parser.js             Lecteur binaire du format .fit (Garmin FIT)
│   ├── fit-to-csv.js             Dérivation des 16 colonnes IMPORT_CSV depuis des points GPS bruts
│   ├── gpx-parser.js             Extraction du profil altimétrique depuis un fichier GPX officiel
│   ├── athletes.js               Gestion des profils athlètes et de leurs estimations
│   ├── pdf-export.js             Génération du PDF roadbook (profil dénivelé + tableau repères)
│   ├── ui.js                     Rendu des tableaux et formulaires
│   └── main.js                   État de l'application et câblage des événements
├── sample-data/exemple_import.csv  CSV de démonstration
└── .github/workflows/deploy.yml  Déploiement automatique sur GitHub Pages
```

## ✅ Fidélité au classeur Excel

Le moteur de calcul (`js/engine.js`) a été validé numériquement contre les valeurs réellement calculées par le
classeur Excel d'origine (segments, profils athlète, temps V1/V2 et totaux de course) : correspondance exacte
sur l'ensemble des colonnes testées. La reconstruction des colonnes GPS à partir de points bruts
(`js/fit-to-csv.js`) a elle aussi été validée en reproduisant, à partir de coordonnées lat/lon/altitude/temps
réelles, les colonnes déjà calculées d'une reconnaissance GPS de référence (correspondance exacte, y compris
sur la classification plat/montée/descente). Le lecteur `.fit` (`js/fit-parser.js`) a été testé sur des
fichiers FIT synthétiques couvrant les en-têtes normaux et les en-têtes à timestamp compressé.
