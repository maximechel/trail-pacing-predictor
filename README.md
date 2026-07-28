# 🏔 Prédicteur de Pacing Trail — V3 (web app)

Application web statique reproduisant fidèlement le classeur Excel **« V3 — Prédicteur de temps trail »** :
import d'un fichier **.fit** (montre GPS) ou d'un CSV GPS déjà traité, segmentation automatique, profil
athlète force-vitesse / descente, et moteur de pacing (temps prévisionnels V1/V2 par segment) avec réglages
d'intensité, de technicité, de conditions et de fatigue.

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
| *(nouveau, sans équivalent Excel)* | **1. Import FIT** | Conversion locale d'un fichier `.fit` (montre GPS) vers le format CSV 16 colonnes attendu par l'étape suivante |
| `IMPORT_CSV` | **2. Import CSV** | Collez ou chargez le CSV GPS traité (16 colonnes, séparateur `;`) |
| `TRAITEMENT` | *(interne)* | Segmentation automatique par regroupement des points GPS consécutifs de même type (`segment_type_smooth`) |
| `SEGMENTS` | **4. Segments** | Agrégation par segment : distance, D+/D-, durée, vitesse et pente moyennes |
| `PROFILS` | **5. Profil athlète** | Classification automatique du profil force-vitesse (Grimpeur / Équilibré / Rouleur) et du profil descente |
| `PARAMÈTRES` | **3. Paramètres** | Infos course (distance/D+/D- calculées auto depuis le CSV), catégorie, et toutes les tables de coefficients éditables |
| `PACING` | **6. Pacing** | Temps prévisionnels par segment : V1 = sans profil athlète, V2 = ajusté au profil (grimpeur/rouleur + descente) |

### Import FIT → CSV (nouveau)

L'onglet **1. Import FIT** lit directement le fichier `.fit` exporté par une montre GPS (Garmin, Wahoo,
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

## ⚙ Personnalisation

Toutes les tables de coefficients (fatigue, intensité, technicité, conditions, profils) sont éditables dans
l'onglet **Paramètres → Tables de coefficients (avancé)** et sont sauvegardées automatiquement dans le
`localStorage` du navigateur. Un bouton **« Réinitialiser aux valeurs par défaut »** permet de revenir à la
configuration d'origine du classeur Excel.

## 🗂 Structure du projet

```
trail-pacing-predictor/
├── index.html                    Page principale (6 onglets)
├── css/style.css                 Styles
├── js/
│   ├── data.js                   Tables de coefficients par défaut
│   ├── engine.js                 Moteur de calcul (port fidèle des formules Excel)
│   ├── fit-parser.js             Lecteur binaire du format .fit (Garmin FIT)
│   ├── fit-to-csv.js             Dérivation des 16 colonnes IMPORT_CSV depuis des points GPS bruts
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
