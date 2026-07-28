# 🏔 Prédicteur de Pacing Trail — V3 (web app)

Application web statique reproduisant fidèlement le classeur Excel **« V3 — Prédicteur de temps trail »** :
import d'un CSV GPS traité, segmentation automatique, profil athlète force-vitesse / descente, et moteur de
pacing (temps prévisionnels V1/V2 par segment) avec réglages d'intensité, de technicité, de conditions et de
fatigue.

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
| `IMPORT_CSV` | **1. Import CSV** | Collez ou chargez le CSV GPS traité (16 colonnes, séparateur `;`) |
| `TRAITEMENT` | *(interne)* | Segmentation automatique par regroupement des points GPS consécutifs de même type (`segment_type_smooth`) |
| `SEGMENTS` | **3. Segments** | Agrégation par segment : distance, D+/D-, durée, vitesse et pente moyennes |
| `PROFILS` | **4. Profil athlète** | Classification automatique du profil force-vitesse (Grimpeur / Équilibré / Rouleur) et du profil descente |
| `PARAMÈTRES` | **2. Paramètres** | Infos course (distance/D+/D- calculées auto depuis le CSV), catégorie, et toutes les tables de coefficients éditables |
| `PACING` | **5. Pacing** | Temps prévisionnels par segment : V1 = sans profil athlète, V2 = ajusté au profil (grimpeur/rouleur + descente) |

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

## ⚙ Personnalisation

Toutes les tables de coefficients (fatigue, intensité, technicité, conditions, profils) sont éditables dans
l'onglet **Paramètres → Tables de coefficients (avancé)** et sont sauvegardées automatiquement dans le
`localStorage` du navigateur. Un bouton **« Réinitialiser aux valeurs par défaut »** permet de revenir à la
configuration d'origine du classeur Excel.

## 🗂 Structure du projet

```
trail-pacing-predictor/
├── index.html                    Page principale (5 onglets)
├── css/style.css                 Styles
├── js/
│   ├── data.js                   Tables de coefficients par défaut
│   ├── engine.js                 Moteur de calcul (port fidèle des formules Excel)
│   ├── ui.js                     Rendu des tableaux et formulaires
│   └── main.js                   État de l'application et câblage des événements
├── sample-data/exemple_import.csv  CSV de démonstration
└── .github/workflows/deploy.yml  Déploiement automatique sur GitHub Pages
```

## ✅ Fidélité au classeur Excel

Le moteur de calcul (`js/engine.js`) a été validé numériquement contre les valeurs réellement calculées par le
classeur Excel d'origine (segments, profils athlète, temps V1/V2 et totaux de course) : correspondance exacte
sur l'ensemble des colonnes testées.
