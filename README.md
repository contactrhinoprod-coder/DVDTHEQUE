# DVDthèque — PWA de collection de DVD / Blu-ray / 4K

Application web installable (PWA) en JavaScript vanilla. Aucune dépendance, aucun build.
Même philosophie de déploiement qu'ALPHABRAVO : 4 fichiers + service worker, poussés sur GitHub Pages.

## Fichiers

```
dvdtheque/
├── index.html      # shell + toutes les vues
├── style.css       # thème cinéma (dark/light), responsive mobile + tablette
├── app.js          # logique : store IndexedDB, API film, scan, audio, routing
├── sw.js           # service worker (offline-first)
└── manifest.json   # métadonnées PWA + icônes (SVG inline)
```

## Lancer en local

Un serveur HTTP est requis (la caméra, le micro et les service workers ne marchent
pas en `file://`).

```bash
cd dvdtheque
python3 -m http.server 8000
# ouvrir http://localhost:8000
```

Pour tester caméra/micro sur téléphone, il faut **HTTPS** : GitHub Pages le fournit.

## Déploiement GitHub Pages

1. Créer un repo (ex. `DVDTHEQUE`), pousser ces fichiers à la racine.
2. Settings → Pages → Branch `main` / `/root`.
3. URL : `https://<user>.github.io/DVDTHEQUE/`.

## Fonctionnel dès maintenant

- Bibliothèque : grille / liste, tri (titre, année, note, ajout), recherche instantanée, filtre genre.
- Fiche détail : note ★, synopsis, fiche technique, partage natif, suppression.
- Ajout manuel complet.
- Scan code-barres (voir limites).
- Commentaires texte + audio (voir limites).
- Tirage aléatoire avec animation, filtré par genre / note.
- Stockage **offline** via IndexedDB (remplace SQLite, rôle identique).
- Import / export JSON.
- Thème sombre / clair.

## Configuration API film

Profil → « Clé API film ». Deux fournisseurs câblés :

- **TMDB** : recherche par titre. Clé gratuite sur themoviedb.org.
- **OMDb** : recherche par titre. Clé gratuite sur omdbapi.com.

L'abstraction est dans `MovieAPI` (`app.js`) — ajouter un provider = une fonction.

## Limites techniques à connaître (lecture importante)

1. **Scan → film n'est PAS direct.** Ni TMDB ni OMDb n'indexent les codes EAN
   des boîtiers DVD. Le flux tente un lookup EAN via UPCitemdb (gratuit, quota
   limité) pour deviner un titre, puis recherche le film par ce titre. En cas
   d'échec, la fiche s'ouvre pré-remplie avec le code-barres pour validation
   manuelle. Un vrai matching fiable nécessite une base DVD dédiée (payante).

2. **Scan iOS : géré via ZXing-wasm.** `BarcodeDetector` natif sert sur
   Android/Chromium (rapide). Sur iOS Safari et autres navigateurs sans cette
   API, l'app charge automatiquement **ZXing-wasm** (~1 Mo, WebAssembly) depuis
   jsDelivr au moment du scan, et décode les frames vidéo via canvas. Aucune
   action de ta part. Le `.wasm` n'est téléchargé que sur les appareils qui en
   ont besoin (pas sur Android). Pour un offline total, héberger
   `zxing_reader.wasm` dans le repo et changer la constante `ZXING_WASM` dans
   `app.js` (module Scanner).

3. **Audio sur iOS.** `MediaRecorder` est supporté sur iOS récents mais reste
   plus capricieux qu'Android. À tester sur ton matériel. Le code détecte
   l'absence de support et prévient.

4. **OCR jaquette : implémenté via Tesseract.js.** Photo de la jaquette →
   Tesseract.js (v5, ~2 Mo, chargé à la demande depuis jsDelivr) extrait les
   lignes de texte, l'app propose les candidats triés par taille (le titre est
   généralement le plus gros texte), tu choisis ou corriges, puis recherche
   TMDB. Fiabilité variable selon la netteté de la photo et le graphisme du
   titre — d'où la confirmation manuelle avant recherche. Langues : français +
   anglais. Fonctionne sur iOS comme Android.

5. **Auth.** Pas d'auth réelle dans ce MVP (mode invité, données locales). Les
   hooks Google/Apple login peuvent être ajoutés via Firebase comme sur ALPHABRAVO.

## Sync cloud (Firebase / Firestore) — pattern ALPHABRAVO

Le SDK Firebase (compat) est chargé via `<script>` dans `index.html`. La config
est **en dur** dans `app.js`, constante `FIREBASE_CONFIG` (en haut du fichier,
encadrée par des flèches). Remplacer les `TON_…` par les valeurs du projet
Firebase. Tant que ce n'est pas fait, l'app reste 100 % locale (aucune erreur).

L'app s'authentifie en **anonyme** au chargement (avec attente de l'uid avant
toute écriture — pas de race condition) et synchronise dans
`users/{uid}/movies/{movieId}`. Le bouton « Sync cloud » du Profil affiche le
statut et permet de resynchroniser.

### Audio et limite Firestore

Document limité à **1 Mo**. Audio compressé : **Opus 16 kbps mono, 30 s max,
3 commentaires/film** → ~313 Ko pour un film plein. Au-delà, le film reste local
(message affiché). Réglages dans `AudioRecorder` (`MAX_SEC`, `BITRATE`, `MAX_PER_MOVIE`).

### Règles Firestore (console → Firestore → Règles)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/movies/{movieId} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

Activer **Authentication → Sign-in method → Anonymous**.

### Vers Flutter

La future app Flutter peut pointer le **même projet Firebase** et lire la même
collection `users/{uid}/movies` — le schéma d'un film est un objet plat
(titre, année, genre, rating, audio base64, textComments…). Le test PWA n'est
donc pas jetable : les données saisies se retrouveront côté natif.

## Prochaines passes possibles

- Sync cloud (Firestore) — réutilisable depuis ALPHABRAVO.
- Export PDF de la collection.
- Auth réelle (Google / Apple via Firebase).
- Mise en cache du `.wasm` ZXing et du moteur Tesseract par le service worker
  (offline complet du scan/OCR après première utilisation).
```
