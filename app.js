/* ============================================================
   DVDthèque — app.js
   PWA vanilla. Pas de build, pas de dépendance externe.
   Organisation :
     1. Utils & état global
     2. Store (IndexedDB) — couche données offline-first
     3. MovieAPI — abstraction de recherche film (TMDB/OMDb pluggable)
     4. Scanner — code-barres via BarcodeDetector natif
     5. AudioRecorder — commentaires audio (MediaRecorder)
     6. UI / Router / Rendu des vues
     7. Bootstrap
   ============================================================ */

'use strict';

/* ============================================================
   1. UTILS & ÉTAT GLOBAL
   ============================================================ */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const State = {
  series: [],
  movies: [],          // cache mémoire de la collection
  view: 'library',
  layout: 'grid',
  sort: 'title',
  formatFilter: '',    // '' = tout, sinon 'DVD' | 'Blu-ray' | '4K'
  filters: {},         // {genre, year, format, rating}
  search: '',
  currentId: null,     // film ouvert en détail
  settings: { theme: 'dark', apiProvider: 'tmdb', apiKey: 'ff585a6b49828b724cd3c876a48cf5e0' },
};

const GENRES = ['Action','Animation','Aventure','Comédie','Crime','Documentaire',
  'Drame','Fantastique','Guerre','Histoire','Horreur','Musique','Mystère',
  'Romance','Science-Fiction','Thriller','Western'];

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

const TAG_LABELS = {
  top3: '🏆 Top 3', nanard: '🤪 Nanard', navet: '💩 Navet',
  classic: '🎩 Classique', zombie: '🧟 Zombie', findumonde: '🌍 Fin du monde',
};

function fmtDuration(min) {
  if (!min) return '—';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
}

// Formate un prix en euros (ex: 4.5 -> "4,50 €")
function fmtPrice(v) {
  if (v == null || v === '') return '';
  return Number(v).toFixed(2).replace('.', ',') + ' €';
}

// Affiche N étoiles avec support demi-étoile visuelle
// rating = 0..5 par pas de 0.5
// mode 'text' = pour vignettes (petites étoiles CSS)
// mode 'edit' = étoiles cliquables dans l'éditeur
function renderStars(rating, mode = 'text') {
  const r = Number(rating) || 0;
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    const full  = r >= i;
    const half  = !full && r >= i - 0.5;
    if (mode === 'text') {
      // Affichage inline : étoile pleine, demi-étoile CSS, ou vide
      if (full)      stars.push('<span class="star full">★</span>');
      else if (half) stars.push('<span class="star half"><span class="star-fg">★</span><span class="star-bg">★</span></span>');
      else           stars.push('<span class="star empty">★</span>');
    } else {
      // Étoile cliquable dans l'éditeur
      let cls = full ? 'full' : half ? 'half' : 'empty';
      stars.push(`<span class="star edit-star ${cls}" data-i="${i}">${
        full ? '★' : half
          ? '<span class="star-fg">★</span><span class="star-bg">★</span>'
          : '★'
      }</span>`);
    }
  }
  if (mode === 'text') return `<span class="stars-wrap">${stars.join('')}</span>`;
  return `<div class="rating-stars" id="rating-edit">${stars.join('')}</div>`;
}

/* ============================================================
   2. STORE — IndexedDB (offline-first)
   Remplace SQLite : même rôle, natif navigateur, persistant.
   Stores : "movies" (collection) et "kv" (réglages, blobs audio).
   ============================================================ */
const Store = (() => {
  const DB = 'dvdtheque', VER = 1;
  let db = null;

  function open() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB, VER);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('movies'))
          d.createObjectStore('movies', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv'))
          d.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => { db = req.result; res(db); };
      req.onerror = () => rej(req.error);
    });
  }

  const tx = (store, mode) => db.transaction(store, mode).objectStore(store);
  const wrap = (req) => new Promise((res, rej) => {
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  });

  return {
    init: open,
    allMovies:  ()      => wrap(tx('movies', 'readonly').getAll()),
    putMovie:   (m)     => wrap(tx('movies', 'readwrite').put(m)),
    delMovie:   (id)    => wrap(tx('movies', 'readwrite').delete(id)),
    getKV:      (k)     => wrap(tx('kv', 'readonly').get(k)).then(r => r && r.v),
    setKV:      (k, v)  => wrap(tx('kv', 'readwrite').put({ k, v })),
    clearMovies:()      => wrap(tx('movies', 'readwrite').clear()),
  };
})();

/* ============================================================
   3. MOVIEAPI — abstraction de recherche film
   Implémentations interchangeables. Si pas de clé API,
   bascule sur un mode "stub" qui renvoie une fiche vierge
   pré-remplie avec le code-barres, pour saisie manuelle.
   ============================================================ */
const MovieAPI = (() => {

  // --- Provider TMDB (recherche par titre ; pas de lookup EAN natif) ---
  async function tmdbSearchByTitle(title, key) {
    const url = `https://api.themoviedb.org/3/search/movie?language=fr-FR&query=${encodeURIComponent(title)}&api_key=${key}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('TMDB ' + r.status);
    const j = await r.json();
    const hit = j.results && j.results[0];
    if (!hit) return null;
    return tmdbDetails(hit.id, key);
  }

  async function tmdbDetails(id, key) {
    const url = `https://api.themoviedb.org/3/movie/${id}?language=fr-FR&append_to_response=credits&api_key=${key}`;
    const r = await fetch(url); const j = await r.json();
    const director = (j.credits?.crew || []).find(c => c.job === 'Director');
    const cast = (j.credits?.cast || []).slice(0, 5).map(c => c.name).join(', ');
    return {
      title: j.title || '',
      originalTitle: j.original_title || '',
      year: (j.release_date || '').slice(0, 4),
      synopsis: j.overview || '',
      genre: (j.genres && j.genres[0]?.name) || '',
      director: director ? director.name : '',
      actors: cast,
      duration: j.runtime || 0,
      poster: j.poster_path ? `https://image.tmdb.org/t/p/w500${j.poster_path}` : '',
    };
  }

  // --- Provider OMDb (supporte recherche titre) ---
  async function omdbSearchByTitle(title, key) {
    const r = await fetch(`https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${key}`);
    const j = await r.json();
    if (j.Response === 'False') return null;
    return {
      title: j.Title || '', originalTitle: j.Title || '',
      year: (j.Year || '').slice(0, 4), synopsis: j.Plot || '',
      genre: (j.Genre || '').split(',')[0]?.trim() || '',
      director: j.Director || '', actors: j.Actors || '',
      duration: parseInt(j.Runtime) || 0,
      poster: j.Poster && j.Poster !== 'N/A' ? j.Poster : '',
    };
  }

  /* Recherche par code-barres (EAN/UPC).
     ⚠️ Réalité : ni TMDB ni OMDb n'indexent les EAN de boîtiers DVD.
     On tente un lookup EAN via UPCitemdb à travers un proxy CORS
     (les appels directs sont bloqués depuis le navigateur). Si on
     obtient un libellé, on cherche le film par titre sur TMDB.
     À défaut, la fiche s'ouvre avec le code pré-rempli (l'utilisateur
     complète le titre, ou utilise l'OCR de la jaquette). */
  async function searchByBarcode(ean) {
    // Proxies CORS publics (on essaie dans l'ordre, ils sont parfois instables)
    const proxies = [
      (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
      (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    ];
    const target = `https://api.upcitemdb.com/prod/trial/lookup?upc=${ean}`;

    for (const wrap of proxies) {
      try {
        const r = await fetch(wrap(target));
        if (!r.ok) continue;
        const j = await r.json();
        const item = j.items && j.items[0];
        if (item && item.title) {
          const cleaned = item.title
            .replace(/\b(dvd|blu-?ray|4k|uhd|edition|steelbook|combo|coffret)\b/gi, '')
            .replace(/\s+/g, ' ').trim();
          const film = await searchByTitle(cleaned);
          if (film) return { ...film, barcode: ean };
          return blankFromBarcode(ean, cleaned); // titre deviné, à valider
        }
      } catch (e) { /* proxy KO, on essaie le suivant */ }
    }
    // Aucun résultat : fiche avec code pré-rempli
    return blankFromBarcode(ean, '');
  }

  async function searchByTitle(title) {
    const { apiProvider, apiKey } = State.settings;
    if (!apiKey) return null;
    try {
      return apiProvider === 'omdb'
        ? await omdbSearchByTitle(title, apiKey)
        : await tmdbSearchByTitle(title, apiKey);
    } catch (e) { console.warn('API film:', e); return null; }
  }

  /* Renvoie une LISTE de résultats TMDB (pour laisser l'utilisateur choisir
     entre "Casino" 1995 et "Casino Royale", par ex.). */
  async function searchMulti(title) {
    const { apiKey } = State.settings;
    if (!apiKey) return [];
    try {
      const url = `https://api.themoviedb.org/3/search/movie?language=fr-FR&query=${encodeURIComponent(title)}&api_key=${apiKey}`;
      const r = await fetch(url);
      if (!r.ok) return [];
      const j = await r.json();
      return (j.results || []).slice(0, 8).map(m => ({
        id: m.id,
        title: m.title || '',
        year: (m.release_date || '').slice(0, 4),
        poster: m.poster_path ? `https://image.tmdb.org/t/p/w185${m.poster_path}` : '',
      }));
    } catch (e) { console.warn('searchMulti:', e); return []; }
  }

  // Détails complets d'un film à partir de son id TMDB
  async function getDetails(id) {
    const { apiKey } = State.settings;
    try { return await tmdbDetails(id, apiKey); }
    catch (e) { console.warn('getDetails:', e); return null; }
  }

  function blankFromBarcode(ean, guessTitle) {
    return {
      title: guessTitle || '', originalTitle: '', year: '', synopsis: '',
      genre: '', director: '', actors: '', duration: 0, poster: '', barcode: ean,
    };
  }

  return { searchByBarcode, searchByTitle, searchMulti, getDetails, blankFromBarcode };
})();

/* ============================================================
   3b. CLOUD — sync Firestore (pattern ALPHABRAVO)
   - SDK Firebase compat chargé via <script> dans index.html.
   - Config en dur ci-dessous (FIREBASE_CONFIG) : remplacer les
     valeurs par celles de TON projet (console Firebase → ⚙️ →
     Paramètres → Vos applications → icône </>).
   - Auth anonyme. Stockage : users/{uid}/movies/{movieId}.
   - L'audio compressé (~16kbps, 30s, max 3/film) tient sous la
     limite Firestore de 1 Mo/document.
   - Tant que FIREBASE_CONFIG n'est pas rempli, l'app reste 100% locale.
   ============================================================ */

// ⬇️⬇️⬇️  REMPLACE CES VALEURS PAR TA CONFIG FIREBASE  ⬇️⬇️⬇️
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAeodo3johut0aZNYzfkSmnSs8eqFf6J-U",
  authDomain:        "dvdtheque-280da.firebaseapp.com",
  projectId:         "dvdtheque-280da",
  storageBucket:     "dvdtheque-280da.firebasestorage.app",
  messagingSenderId: "620487889182",
  appId:             "1:620487889182:web:656118ca705533d642f90f",
};
// ⬆️⬆️⬆️  REMPLACE CES VALEURS PAR TA CONFIG FIREBASE  ⬆️⬆️⬆️

const Cloud = (() => {
  let db = null, auth = null, uid = null, ready = false;
  let currentUser = null;
  let onChangeCb = null;

  function configured() {
    return typeof firebase !== 'undefined'
      && FIREBASE_CONFIG.projectId
      && FIREBASE_CONFIG.projectId !== 'TON_PROJET';
  }

  function enabled() { return ready && !!uid; }
  function user() { return currentUser; }

  // Initialise Firebase et écoute l'état de connexion.
  // NE connecte PAS automatiquement : l'utilisateur clique "Se connecter".
  // onChange(user|null) est rappelé à chaque changement d'état.
  async function init(onChange) {
    if (!configured()) return false;
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db   = firebase.firestore();
    onChangeCb = onChange;

    // Persistance locale : l'utilisateur reste connecté entre les sessions
    try { await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch (e) {}

    auth.onAuthStateChanged((u) => {
      if (u) { currentUser = u; uid = u.uid; ready = true; }
      else   { currentUser = null; uid = null; ready = false; }
      if (onChangeCb) onChangeCb(currentUser);
    });
    return true;
  }

  // Détecte si on tourne dans Capacitor (app native iOS/Android)
  // Connexion Google (web popup — overridé en natif par native-share.js)
  async function signInGoogle() {
    if (!auth) return;
    const provider = new firebase.auth.GoogleAuthProvider();
    try { await auth.signInWithPopup(provider); }
    catch (e) {
      const c = e && e.code || '';
      if (c.includes('popup') || c.includes('cancelled') || c.includes('blocked') ||
          c === 'auth/operation-not-supported-in-this-environment') {
        await auth.signInWithRedirect(provider);
      } else throw e;
    }
  }

  // Connexion Apple (web popup — overridé en natif par native-share.js)
  async function signInApple() {
    if (!auth) return;
    const provider = new firebase.auth.OAuthProvider('apple.com');
    provider.addScope('email'); provider.addScope('name');
    try { await auth.signInWithPopup(provider); }
    catch (e) {
      const c = e && e.code || '';
      if (c.includes('popup') || c.includes('cancelled') || c.includes('blocked') ||
          c === 'auth/operation-not-supported-in-this-environment') {
        await auth.signInWithRedirect(provider);
      } else throw e;
    }
  }

    async function signOut() {
    if (auth) await auth.signOut();
  }

  function moviesCol() {
    return db.collection('users').doc(uid).collection('movies');
  }

  function docTooBig(movie) {
    return new Blob([JSON.stringify(movie)]).size > 1000 * 1024;
  }

  async function pushMovie(movie) {
    if (!enabled()) return;
    if (docTooBig(movie)) {
      toast('Film trop volumineux pour la sync (trop d’audio) — gardé en local');
      return;
    }
    await moviesCol().doc(movie.id).set(movie);
  }

  async function deleteRemote(id) {
    if (!enabled()) return;
    await moviesCol().doc(id).delete();
  }

  async function pullAll() {
    if (!enabled()) return [];
    const snap = await moviesCol().get();
    const out = [];
    snap.forEach((d) => out.push(d.data()));
    return out;
  }

  async function pushAll(movies) {
    if (!enabled()) return;
    for (const m of movies) {
      if (!docTooBig(m)) await moviesCol().doc(m.id).set(m);
    }
  }

  return { init, configured, enabled, user, signInGoogle, signInApple, signOut,
           pushMovie, deleteRemote, pullAll, pushAll, uid: () => uid };
})();

/* ============================================================
   4. SCANNER — code-barres, double moteur
   - BarcodeDetector natif si présent (Chrome/Android) : rapide.
   - Sinon ZXing-wasm (iOS Safari, Firefox…) : décodage WASM
     d'une frame vidéo capturée sur <canvas>.
   Même résultat dans les deux cas : un EAN passé à onResult.

   ZXing v3 (IIFE global "ZXingWASM") est chargé à la demande
   depuis jsDelivr ; le binaire .wasm est pointé vers le CDN via
   prepareZXingModule. Cf. index.html (balise <script> + dépôt offline possible).
   ============================================================ */
const Scanner = (() => {
  const ZXING_VER = '3.0.3';
  const ZXING_IIFE = `https://cdn.jsdelivr.net/npm/zxing-wasm@${ZXING_VER}/dist/iife/reader/index.js`;
  const ZXING_WASM = `https://cdn.jsdelivr.net/npm/zxing-wasm@${ZXING_VER}/dist/reader/zxing_reader.wasm`;
  const FORMATS_NATIVE = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
  const FORMATS_ZXING  = ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E'];
  const ZXING_THROTTLE = 220; // ms entre deux décodages WASM

  let stream = null, raf = null, detector = null, onResult = null;
  let mode = null;            // 'native' | 'zxing'
  let canvas = null, ctx = null, lastDecode = 0, zxingReady = false, decoding = false;

  // Charge le script IIFE ZXing une seule fois et configure le chemin du .wasm
  function loadZXing() {
    if (window.ZXingWASM) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = ZXING_IIFE;
      s.onload = () => {
        try {
          // Pointe le binaire wasm vers le CDN (sinon ZXing le cherche en relatif)
          window.ZXingWASM.prepareZXingModule({
            overrides: {
              locateFile: (path, prefix) =>
                path.endsWith('.wasm') ? ZXING_WASM : (prefix + path),
            },
          });
        } catch (e) { /* prepareZXingModule absente sur très vieilles versions */ }
        res();
      };
      s.onerror = () => rej(new Error('Chargement ZXing impossible (réseau ?)'));
      document.head.appendChild(s);
    });
  }

  async function start(cb) {
    onResult = cb;
    const modal = $('#scanner-modal'), video = $('#scanner-video'), hint = $('#scanner-hint');
    modal.hidden = false;
    hint.textContent = 'Initialisation de la caméra…';

    // 1. Ouvrir la caméra (geste utilisateur requis sur iOS — OK, déclenché par tap)
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      video.srcObject = stream;
      video.setAttribute('playsinline', ''); // indispensable iOS
      await video.play();
    } catch (e) {
      hint.textContent = 'Caméra indisponible : ' + (e.message || e.name || '');
      console.warn(e);
      return;
    }

    // 2. Choisir le moteur
    if ('BarcodeDetector' in window) {
      try {
        detector = new BarcodeDetector({ formats: FORMATS_NATIVE });
        mode = 'native';
      } catch (e) { mode = null; }
    }
    if (mode !== 'native') {
      hint.textContent = 'Chargement du moteur de scan…';
      try {
        await loadZXing();
        mode = 'zxing';
        zxingReady = true;
        canvas = document.createElement('canvas');
        ctx = canvas.getContext('2d', { willReadFrequently: true });
      } catch (e) {
        hint.textContent = "Scan auto indisponible. Saisie manuelle…";
        console.warn(e);
        setTimeout(() => { stop(); openEditor(MovieAPI.blankFromBarcode('', '')); }, 1600);
        return;
      }
    }

    hint.textContent = 'Visez le code-barres au dos du boîtier';
    loop(video);
  }

  function loop(video) {
    if (!mode) return;
    if (mode === 'native') decodeNative(video);
    else decodeZXing(video);
    raf = requestAnimationFrame(() => loop(video));
  }

  async function decodeNative(video) {
    if (decoding) return;
    decoding = true;
    try {
      const codes = await detector.detect(video);
      if (codes && codes.length) return finish(codes[0].rawValue);
    } catch (e) { /* frame non décodable */ }
    decoding = false;
  }

  async function decodeZXing(video) {
    const now = performance.now();
    if (decoding || !zxingReady || (now - lastDecode) < ZXING_THROTTLE) return;
    if (!video.videoWidth) return;
    decoding = true; lastDecode = now;
    try {
      // Capture la frame courante. On réduit la résolution pour la vitesse.
      const scale = Math.min(1, 1000 / video.videoWidth);
      canvas.width  = Math.round(video.videoWidth  * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const results = await window.ZXingWASM.readBarcodes(imgData, {
        tryHarder: true,
        formats: FORMATS_ZXING,
        maxNumberOfSymbols: 1, // v3
        maxSymbols: 1,         // v1/v2 (clé ignorée si inconnue)
      });
      if (results && results.length && results[0].text) {
        return finish(results[0].text);
      }
    } catch (e) { /* décodage raté sur cette frame, on continue */ }
    decoding = false;
  }

  function finish(ean) {
    if (navigator.vibrate) navigator.vibrate(80);
    const cb = onResult;
    stop();
    cb && cb(ean);
  }

  function stop() {
    $('#scanner-modal').hidden = true;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    detector = null; mode = null; decoding = false;
  }

  return { start, stop };
})();

/* ============================================================
   5. AUDIORECORDER — commentaires audio (MediaRecorder)
   Stocke un Blob audio compressé (Opus ~16 kbps) pour rester
   compatible avec la sync Firestore (limite 1 Mo / document).
   - Bitrate volontairement bas : voix intelligible, ~78 Ko/30s en base64.
   - Durée plafonnée (auto-stop) pour borner la taille.
   ⚠️ iOS Safari : MediaRecorder supporté sur iOS récents ; on
   détecte et on prévient si indisponible.
   ============================================================ */
const AudioRecorder = (() => {
  const MAX_SEC = 30;             // durée max par enregistrement
  const BITRATE = 16000;          // 16 kbps — voix
  const MAX_PER_MOVIE = 3;        // nb max de commentaires audio par film

  let rec = null, chunks = [], stream = null, startTs = 0, autoStop = null, onAuto = null;

  function supported() { return 'MediaRecorder' in window && navigator.mediaDevices; }

  // cb appelé si l'auto-stop se déclenche (pour mettre à jour l'UI)
  async function start(onAutoStop) {
    if (!supported()) throw new Error('Enregistrement audio non supporté sur ce navigateur.');
    onAuto = onAutoStop;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    chunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
      : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    const opts = { audioBitsPerSecond: BITRATE };
    if (mime) opts.mimeType = mime;
    rec = new MediaRecorder(stream, opts);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start();
    startTs = Date.now();
    // Auto-stop à MAX_SEC
    autoStop = setTimeout(() => { onAuto && onAuto(); }, MAX_SEC * 1000);
  }

  function stop() {
    return new Promise((res) => {
      if (autoStop) { clearTimeout(autoStop); autoStop = null; }
      if (!rec) return res(null);
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: (rec && rec.mimeType) || 'audio/webm' });
        const dur = Math.min(MAX_SEC, Math.round((Date.now() - startTs) / 1000));
        stream.getTracks().forEach(t => t.stop());
        rec = null; stream = null;
        res({ blob, dur });
      };
      rec.stop();
    });
  }

  // Blob -> base64 (pour stockage IndexedDB sérialisable et sync Firestore)
  const blobToB64 = (blob) => new Promise((res) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob);
  });

  return { supported, start, stop, blobToB64, MAX_SEC, MAX_PER_MOVIE };
})();

/* ============================================================
/* ============================================================
   6. UI / ROUTER / RENDU
   ============================================================ */

/* ---- Navigation entre vues ---- */
const scrollSave = { library: 0, wishlist: 0 };

function go(view, opts = {}) {
  // Gérer les vues séries
  if (view === 'series-list') { showSeries && showSeries(); return; }
  if (view === 'series-search') { showAddSeriesModal && showAddSeriesModal(); return; }
  if (view === 'series-stats') { showSeriesStats && showSeriesStats(); return; }

  // Si on revient sur une vue films depuis le mode séries, reswitcher
  if (State.mediaMode === 'series') {
    State.mediaMode = 'films';
    switchTabbar('films');
    const btnFilms = $('#toggle-films');
    const btnSeries = $('#toggle-series');
    if (btnFilms) btnFilms.classList.add('active');
    if (btnSeries) btnSeries.classList.remove('active');
    // Réafficher les éléments films cachés par showSeries
    const formatSeg = $('#format-seg');
    const toolbar = document.querySelector('.toolbar');
    const activeFilters = $('#active-filters');
    if (formatSeg) formatSeg.hidden = false;
    if (toolbar) toolbar.hidden = false;
    if (activeFilters) activeFilters.hidden = false;
  }

  // Afficher/masquer le header bibliothèque
  const libHeader = $('#library-header');
  if (libHeader) libHeader.hidden = (view !== 'library');
  // Sauvegarder la position avant de quitter library ou wishlist
  if (State.view === 'library' || State.view === 'wishlist') {
    scrollSave[State.view] = $('#views').scrollTop;
  }

  State.view = view;
  $$('.view').forEach(v => (v.hidden = v.dataset.view !== view));
  $$('.tab[data-go]').forEach(t => t.classList.toggle('active', t.dataset.go === view));

  const titles = { library: 'DVDthèque', wishlist: 'Wishlist', random: 'Aléatoire', quiz: 'Quiz', profile: 'Profil', detail: '' };
  $('#topbar-title').textContent = opts.title || titles[view] || '';
  $('#back-btn').hidden = view !== 'detail';
  $('#search-toggle').hidden = view !== 'library';
  if (view !== 'library') { $('#searchbar').hidden = true; }

  if (view === 'library') { renderLibrary(); requestAnimationFrame(() => { $('#views').scrollTop = scrollSave.library; }); }
  else if (view === 'wishlist') { renderWishlist(); requestAnimationFrame(() => { $('#views').scrollTop = scrollSave.wishlist; }); }
  else {
    if (view === 'random') renderRandomView();
    if (view === 'quiz') renderQuizHome();
    if (view === 'profile') renderProfile();
    $('#views').scrollTop = 0;
  }
}

/* ---- Filtre + tri appliqués à la collection ---- */
function visibleMovies() {
  let list = State.movies.filter(m => !m.wishlist); // biblio = hors wishlist
  const f = State.filters;
  const noAccent = (str) => (str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const s = noAccent(State.search.trim());

  // Filtre maître par format (Tout / DVD / Blu-ray / 4K)
  if (State.formatFilter) list = list.filter(m => (m.format || 'DVD') === State.formatFilter);

  if (s) list = list.filter(m =>
    noAccent(m.title).includes(s) ||
    noAccent(m.director).includes(s) ||
    noAccent(m.actors).includes(s));
  if (f.genre)  list = list.filter(m => m.genre === f.genre);
  if (f.tag)    list = list.filter(m => m.tag === f.tag);
  if (f.year)   list = list.filter(m => String(m.year) === String(f.year));
  if (f.format) list = list.filter(m => m.format === f.format);
  if (f.rating) list = list.filter(m => (m.rating || 0) >= f.rating);

  const by = State.sort;
  list.sort((a, b) => {
    switch (by) {
      case 'title':       return (a.title||'').localeCompare(b.title||'');
      case 'title_desc':  return (b.title||'').localeCompare(a.title||'');
      case 'year':        return (a.year||0) - (b.year||0);
      case 'year_desc':   return (b.year||0) - (a.year||0);
      case 'rating_desc': return (b.rating||0) - (a.rating||0);
      case 'added_desc':  return (b.addedAt||0) - (a.addedAt||0);
      default: return 0;
    }
  });
  return list;
}

/* ---- Rendu bibliothèque ---- */
function renderLibrary() {
  const grid = $('#library-grid');
  const list = visibleMovies();
  $('#library-empty').hidden = list.length !== 0;
  grid.className = 'grid' + (State.layout === 'list' ? ' list' : '');

  grid.innerHTML = list.map(m => {
    const poster = m.poster
      ? `style="background-image:url('${m.poster.replace(/'/g, "%27")}')"` : '';
    const initial = (m.title || '?').charAt(0).toUpperCase();
    const priceTxt = (m.price != null && m.price !== '') ? fmtPrice(m.price) : '';
    if (State.layout === 'list') {
      return `<div class="card" data-id="${m.id}">
        <div class="poster-wrap"><div class="poster" ${poster}>${m.poster ? '' : initial}</div></div>
        <div class="meta">
          <div class="t">${esc(m.title)}</div>
          <div class="sub">${m.year || '—'} · ${esc(m.genre || '')} · ${m.format || 'DVD'}${priceTxt ? ' · <span class="price-inline">' + priceTxt + '</span>' : ''}</div>
          <div class="sub">${m.rating ? renderStars(m.rating) : ''}</div>
        </div></div>`;
    }
    return `<div class="card" data-id="${m.id}">
      <div class="poster-wrap">
        <div class="poster" ${poster}>${m.poster ? '' : initial}</div>
        <span class="fmt-badge">${m.format || 'DVD'}</span>
        ${m.tag === 'top3' ? '<span class="top3-badge">🏆 TOP 3</span>' : ''}
      </div>
      <div class="meta"><div class="t">${esc(m.title)}</div><div class="y">${m.year || ''}${priceTxt ? ' <span class="price-inline">' + priceTxt + '</span>' : ''}</div>${m.rating ? `<div class="card-stars">${renderStars(m.rating)}</div>` : ''}</div>
    </div>`;
  }).join('');

  $$('.card', grid).forEach(c =>
    c.addEventListener('click', () => openDetail(c.dataset.id)));

  // Récapitulatif en bas : nombre de films (toujours) + valeur (si prix renseignés)
  const totalBox = $('#library-total');
  const withPrice = list.filter(m => m.price != null && m.price !== '');
  if (list.length) {
    const nb = `<b>${list.length}</b> film${list.length > 1 ? 's' : ''}`;
    let html = nb;
    if (withPrice.length) {
      const total = withPrice.reduce((s, m) => s + Number(m.price), 0);
      html += ` · Valeur : <b>${fmtPrice(total)}</b>`;
      if (withPrice.length < list.length) {
        html += ` <span class="muted small">(${withPrice.length}/${list.length} avec prix)</span>`;
      }
    }
    totalBox.innerHTML = html;
    totalBox.hidden = false;
  } else {
    totalBox.hidden = true;
  }

  renderActiveFilters();
}

/* Rendu de la wishlist (films souhaités, champ wishlist=true) */
function renderWishlist() {
  const grid = $('#wishlist-grid');
  const list = State.movies.filter(m => m.wishlist);
  $('#wishlist-empty').hidden = list.length !== 0;
  grid.className = 'grid';
  grid.innerHTML = list.map(m => {
    const poster = m.poster
      ? `style="background-image:url('${m.poster.replace(/'/g, "%27")}')"` : '';
    const initial = (m.title || '?').charAt(0).toUpperCase();
    return `<div class="card" data-id="${m.id}">
      <div class="poster-wrap">
        <div class="poster" ${poster}>${m.poster ? '' : initial}</div>
        <span class="fmt-badge wish">♡ ${m.format || 'DVD'}</span>
      </div>
      <div class="meta"><div class="t">${esc(m.title)}</div><div class="y">${m.year || ''}</div></div>
    </div>`;
  }).join('');
  $$('.card', grid).forEach(c =>
    c.addEventListener('click', () => openDetail(c.dataset.id)));
}

function renderActiveFilters() {
  const box = $('#active-filters'); const f = State.filters;
  const chips = [];
  if (f.genre)  chips.push(['Genre', f.genre, 'genre']);
  if (f.tag)    chips.push(['Catégorie', TAG_LABELS[f.tag] || f.tag, 'tag']);
  if (f.year)   chips.push(['Année', f.year, 'year']);
  if (f.format) chips.push(['Format', f.format, 'format']);
  if (f.rating) chips.push(['Note', '★' + f.rating + '+', 'rating']);
  box.innerHTML = chips.map(([k, v, key]) =>
    `<span class="chip"><b>${k}:</b> ${esc(String(v))} <span class="x" data-key="${key}">✕</span></span>`).join('');
  $$('.chip .x', box).forEach(x => x.addEventListener('click', () => {
    delete State.filters[x.dataset.key]; renderLibrary();
  }));
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---- Détail film ---- */
function openDetail(id) {
  const m = State.movies.find(x => x.id === id);
  if (!m) return;
  State.currentId = id;
  go('detail', { title: m.title });
  renderDetail(m);
}

function renderDetail(m) {
  const c = $('#detail-content');
  const hero = m.poster ? `style="background-image:url('${m.poster}')"` : '';
  c.innerHTML = `
    <div class="detail-hero" ${hero}>
      <div class="detail-poster" style="${m.poster ? `background-image:url('${m.poster}')` : ''}"></div>
      <div class="detail-headline">
        <h2>${esc(m.title)}</h2>
        ${m.originalTitle && m.originalTitle !== m.title ? `<div class="orig">${esc(m.originalTitle)}</div>` : ''}
        <div class="facts">${[m.year, m.genre, fmtDuration(m.duration), m.format].filter(Boolean).join(' · ')}</div>
      </div>
    </div>

    <div class="detail-section">
      <h4>Ma note</h4>
      ${renderStars(m.rating || 0, 'edit')}
    </div>

    ${m.synopsis ? `<div class="detail-section"><h4>Synopsis</h4><p>${esc(m.synopsis)}</p></div>` : ''}

    <div class="detail-section">
      <h4>Fiche technique</h4>
      <div class="info-grid">
        <div><div class="lbl">Réalisateur</div><div class="val">${esc(m.director) || '—'}</div></div>
        <div><div class="lbl">Acteurs</div><div class="val">${esc(m.actors) || '—'}</div></div>
        <div><div class="lbl">Durée</div><div class="val">${fmtDuration(m.duration)}</div></div>
        <div><div class="lbl">Prix d'achat</div><div class="val">${m.price != null && m.price !== '' ? fmtPrice(m.price) : '—'}</div></div>
        <div><div class="lbl">Code-barres</div><div class="val">${m.barcode || '—'}</div></div>
        ${m.tag ? `<div><div class="lbl">Catégorie</div><div class="val">${TAG_LABELS[m.tag] || m.tag}</div></div>` : ''}
      </div>
    </div>

    <div class="detail-section">
      <h4>Commentaires audio</h4>
      <div class="audio-list" id="audio-list"></div>
      <button class="rec-btn" id="rec-btn" style="margin-top:8px"><span>🎙️</span> Enregistrer un commentaire</button>
    </div>

    <div class="detail-section">
      <h4>Commentaire texte</h4>
      <div id="text-comments"></div>
      <div class="field" style="margin-top:8px">
        <textarea id="new-comment" placeholder="Votre avis sur ce film…"></textarea>
      </div>
      <button class="btn-secondary" id="add-text-comment" style="width:100%">Ajouter le commentaire</button>
      ${m.wishlist ? `<button class="btn-primary" id="detail-found" style="width:100%;margin-top:10px">✅ J'ai trouvé ce film → l'ajouter à ma collection</button>` : ''}
    </div>

    <div class="detail-actions">
      <button class="btn-secondary" id="detail-edit">Modifier</button>
      <button class="btn-secondary" id="detail-share">Partager</button>
      <button class="btn-secondary" id="detail-delete" style="color:var(--accent)">Supprimer</button>
    </div>
  `;

  // Note
  $$('#rating-edit .edit-star').forEach(s => s.addEventListener('click', async () => {
    const i = +s.dataset.i;
    const cur = m.rating || 0;
    // 1er clic sur cette étoile → demi (i-0.5)
    // 2e clic (déjà à demi) → pleine (i)
    // 3e clic (déjà pleine) → efface (retour à i-1)
    if (cur === i - 0.5) m.rating = i;
    else if (cur === i)  m.rating = i - 1 || 0;
    else                 m.rating = i - 0.5;
    await Store.putMovie(m);
    if (Cloud.enabled()) Cloud.pushMovie(m).catch(() => {});
    renderDetail(m);
  }));
  // Audio
  renderAudioList(m);
  $('#rec-btn').addEventListener('click', () => toggleRecording(m));
  // Texte
  renderTextComments(m);
  $('#add-text-comment').addEventListener('click', async () => {
    const v = $('#new-comment').value.trim(); if (!v) return;
    m.textComments = m.textComments || [];
    m.textComments.push({ id: uid(), text: v, at: Date.now() });
    await Store.putMovie(m);
    if (Cloud.enabled()) Cloud.pushMovie(m).catch(() => {});
    renderDetail(m);
  });
  // Actions
  const foundBtn = $('#detail-found');
  if (foundBtn) foundBtn.addEventListener('click', async () => {
    m.wishlist = false;            // passe de la wishlist à la collection
    m.addedAt = Date.now();        // daté comme un nouvel ajout
    await Store.putMovie(m);
    if (Cloud.enabled()) Cloud.pushMovie(m).catch(() => {});
    toast('Ajouté à votre collection ✅');
    go('library');
  });
  $('#detail-edit').addEventListener('click', () => openEditor(m, true));
  $('#detail-share').addEventListener('click', () => shareMovie(m));
  $('#detail-delete').addEventListener('click', async () => {
    const lieu = m.wishlist ? 'la wishlist' : 'la collection';
    if (!confirm(`Supprimer ce film de ${lieu} ?`)) return;
    await Store.delMovie(m.id);
    if (Cloud.enabled()) Cloud.deleteRemote(m.id).catch(() => {});
    State.movies = State.movies.filter(x => x.id !== m.id);
    toast('Film supprimé'); go(m.wishlist ? 'wishlist' : 'library');
  });
}

function renderTextComments(m) {
  const box = $('#text-comments');
  const list = m.textComments || [];
  box.innerHTML = list.map(c => `<div class="text-comment">${esc(c.text)}
    <div class="when">${new Date(c.at).toLocaleDateString('fr-FR')}</div></div>`).join('');
}

/* ---- Audio : rendu + record ---- */
function renderAudioList(m) {
  const box = $('#audio-list');
  const list = m.audio || [];
  if (!list.length) { box.innerHTML = `<p class="muted small">Aucun commentaire audio.</p>`; return; }
  box.innerHTML = list.map(a => `<div class="audio-item" data-id="${a.id}">
    <span class="play">▶</span>
    <span class="label">Commentaire audio</span>
    <span class="dur">${a.dur || 0}s</span>
    <span class="del">🗑</span>
  </div>`).join('');
  $$('.audio-item', box).forEach(item => {
    const a = list.find(x => x.id === item.dataset.id);
    item.querySelector('.play').addEventListener('click', () => {
      const audio = new Audio(a.data); audio.play();
    });
    item.querySelector('.del').addEventListener('click', async () => {
      m.audio = m.audio.filter(x => x.id !== a.id);
      await Store.putMovie(m); renderDetail(m);
    });
  });
}

let recording = false;
let recCountdown = null;
async function toggleRecording(m) {
  const btn = $('#rec-btn');

  if (!recording) {
    // Garde-fou : nombre max de commentaires audio par film
    if ((m.audio || []).length >= AudioRecorder.MAX_PER_MOVIE) {
      toast(`Maximum ${AudioRecorder.MAX_PER_MOVIE} commentaires audio par film`);
      return;
    }
    try {
      // L'auto-stop (durée max) réutilise le même chemin que l'arrêt manuel
      await AudioRecorder.start(() => { if (recording) toggleRecording(m); });
      recording = true;
      btn.classList.add('recording');
      let left = AudioRecorder.MAX_SEC;
      const paint = () => { btn.innerHTML = `<span class="rec-dot"></span> Arrêter (${left}s)`; };
      paint();
      recCountdown = setInterval(() => { left--; if (left >= 0) paint(); }, 1000);
    } catch (e) { toast(e.message); }
  } else {
    if (recCountdown) { clearInterval(recCountdown); recCountdown = null; }
    const out = await AudioRecorder.stop();
    recording = false;
    if (out) {
      const b64 = await AudioRecorder.blobToB64(out.blob);
      m.audio = m.audio || [];
      m.audio.push({ id: uid(), data: b64, dur: out.dur, at: Date.now() });
      await Store.putMovie(m);
      if (Cloud.enabled()) Cloud.pushMovie(m).catch(() => {});
    }
    renderDetail(m);
  }
}

/* ---- Aléatoire ---- */
function renderRandomView() {
  const gsel = $('#random-genre');
  const genres = [...new Set(State.movies.filter(m=>!m.wishlist).map(m => m.genre).filter(Boolean))].sort();
  const tags = [...new Set(State.movies.filter(m=>!m.wishlist && m.tag).map(m => m.tag))];
  gsel.innerHTML = '<option value="">Tous genres</option>' +
    genres.map(g => `<option value="g:${esc(g)}">${esc(g)}</option>`).join('') +
    (tags.length ? '<option disabled>──────────</option>' : '') +
    tags.map(t => `<option value="t:${t}">${TAG_LABELS[t] || t}</option>`).join('');
}

let randomPick = null;
function spinRandom() {
  const sel = $('#random-genre').value;
  const minR = +$('#random-rating').value;
  const isTag = sel.startsWith('t:');
  const isGenre = sel.startsWith('g:');
  const genre = isGenre ? sel.slice(2) : '';
  const tag = isTag ? sel.slice(2) : '';
  let pool = State.movies.filter(m =>
    !m.wishlist &&
    (!State.formatFilter || (m.format || 'DVD') === State.formatFilter) &&
    (!genre || m.genre === genre) &&
    (!tag || m.tag === tag) &&
    (m.rating || 0) >= minR);
  if (!pool.length) { toast('Aucun film ne correspond'); return; }

  const reel = $('#random-reel');
  reel.classList.add('spinning');
  $('#random-open').hidden = true;
  let ticks = 0;
  const iv = setInterval(() => {
    const r = pool[Math.floor(Math.random() * pool.length)];
    reel.innerHTML = r.poster
      ? `<div class="poster" style="background-image:url('${r.poster}')"></div>`
      : `<div class="reel-placeholder">${esc((r.title||'?')[0])}</div>`;
    if (++ticks > 14) {
      clearInterval(iv);
      reel.classList.remove('spinning');
      randomPick = pool[Math.floor(Math.random() * pool.length)];
      reel.innerHTML = randomPick.poster
        ? `<div class="poster" style="background-image:url('${randomPick.poster}')"></div>`
        : `<div class="reel-placeholder">${esc(randomPick.title)}</div>`;
      $('#random-open').hidden = false;
    }
  }, 90);
}

/* ---- Profil ---- */
function renderProfile() {
  $('#profile-meta').textContent = `${State.movies.length} film${State.movies.length > 1 ? 's' : ''} dans la collection`;
  $('#set-theme').textContent = 'Thème : ' + (State.settings.theme === 'dark' ? 'Sombre' : 'Clair');

  // Utiliser l'utilisateur Firebase web directement si Cloud.user() est null (mode natif)
  const u = (Cloud.user && Cloud.user()) || (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser);
  const nameEl = $('#profile-name'), avatarEl = $('#profile-avatar'), cloudBtn = $('#set-cloud');
  if (u) {
    nameEl.textContent = u.displayName || u.email || 'Connecté';
    if (u.photoURL) {
      avatarEl.style.backgroundImage = `url('${u.photoURL}')`;
      avatarEl.textContent = '';
    } else {
      avatarEl.style.backgroundImage = '';
      avatarEl.textContent = (u.displayName || u.email || '?').charAt(0).toUpperCase();
    }
    if (cloudBtn) { cloudBtn.textContent = '⎋ Se déconnecter'; cloudBtn.classList.add('danger'); }
  } else {
    nameEl.textContent = 'Invité';
    avatarEl.style.backgroundImage = '';
    avatarEl.textContent = '?';
    if (cloudBtn) { cloudBtn.textContent = 'Se connecter'; cloudBtn.classList.remove('danger'); }
  }

  renderProfileStats();
}

/* Petites phrases rigolotes selon le genre dominant */
const GENRE_QUIPS = {
  'Action': "Alors, on s'est ramolli ? 💥",
  'Horreur': "BOUUUH ! Même pas peur 👻",
  'Comédie': "Toujours le mot pour rire 😄",
  'Drame': "Sors les mouchoirs 😢",
  'Science-Fiction': "Direction les étoiles 🚀",
  'Thriller': "Toujours sur les nerfs 🔪",
  'Romance': "Cœur d'artichaut, va 💕",
  'Animation': "Resté un grand enfant 🎨",
  'Aventure': "L'âme d'un explorateur 🗺️",
  'Documentaire': "La culture, c'est ton truc 🎓",
  'Fantastique': "La tête dans les nuages 🐉",
  'Guerre': "Au rapport, soldat ! 🎖️",
  'Western': "Y'a un nouveau shérif en ville 🤠",
  'Crime': "Un vrai esprit de détective 🕵️",
  'Histoire': "Passionné du passé 📜",
  'Musique': "La vie en chansons 🎵",
  'Mystère': "Toujours à fouiner 🔎",
};

/* Couleurs du camembert (réutilisées dans l'ordre) */
const PIE_COLORS = ['#e50914','#f5b301','#1f7a3d','#2563eb','#9333ea','#db2777','#0891b2','#ea580c','#65a30d','#7c3aed','#0d9488','#c026d3','#dc2626','#ca8a04','#16a34a','#4f46e5','#be123c'];

function renderProfileStats() {
  const box = $('#profile-stats');
  if (!box) return;
  const films = State.movies.filter(m => !m.wishlist);
  const nb = films.length;
  // Total heures de visionnage
  const totalMin = films.reduce((s, m) => s + (Number(m.duration) || 0), 0);
  const h = Math.floor(totalMin / 60), min = totalMin % 60;
  const dureeStr = totalMin ? `${h}h${String(min).padStart(2, '0')}` : '—';

  // Répartition par genre
  const byGenre = {};
  films.forEach(m => { const g = m.genre || 'Autre'; byGenre[g] = (byGenre[g] || 0) + 1; });
  const entries = Object.entries(byGenre).sort((a, b) => b[1] - a[1]);

  if (!nb) {
    box.innerHTML = `<div class="stat-row"><div class="stat-cell"><div class="stat-num">0</div><div class="stat-lbl">film</div></div></div>`;
    return;
  }

  // Genre dominant + quip
  const topGenre = entries[0][0];
  const quip = GENRE_QUIPS[topGenre] || `Fan de ${topGenre} 🎬`;

  // Camembert SVG (donut) avec segments
  const total = nb;
  const cx = 80, cy = 80, r = 70, rin = 38;
  let acc = 0;
  const segs = entries.map(([g, count], i) => {
    const frac = count / total;
    const start = acc * 2 * Math.PI - Math.PI / 2;
    acc += frac;
    const end = acc * 2 * Math.PI - Math.PI / 2;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end),   y2 = cy + r * Math.sin(end);
    const color = PIE_COLORS[i % PIE_COLORS.length];
    const path = `M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z`;
    // Position du compteur au milieu du segment
    const mid = (start + end) / 2;
    const lr = (r + rin) / 2 + 6;
    const lx = cx + lr * Math.cos(mid), ly = cy + lr * Math.sin(mid);
    return { path, color, count, g, lx, ly };
  });

  box.innerHTML = `
    <div class="stat-lines">
      <div class="stat-line"><span class="stat-n">${nb}</span> film${nb>1?'s':''}</div>
      <div class="stat-line"><span class="stat-n">${dureeStr}</span> de visionnage</div>
    </div>
    <div class="genre-quip">${quip}</div>
    <div class="pie-wrap">
      <svg viewBox="0 0 160 160" class="pie-svg">
        ${segs.map(s => `<path d="${s.path}" fill="${s.color}" stroke="var(--bg)" stroke-width="1.5"/>`).join('')}
        <circle cx="${cx}" cy="${cy}" r="${rin}" fill="var(--bg)"/>
        ${segs.filter(s => s.count / total > 0.06).map(s =>
          `<text x="${s.lx.toFixed(1)}" y="${s.ly.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="11" font-weight="700" fill="#fff">${s.count}</text>`).join('')}
        <text x="${cx}" y="${cy-4}" text-anchor="middle" font-size="15" font-weight="800" fill="var(--text)">${nb}</text>
        <text x="${cx}" y="${cy+11}" text-anchor="middle" font-size="8" fill="var(--text-dim)">films</text>
      </svg>
      <div class="pie-legend">
        ${entries.map(([g, count], i) =>
          `<div class="legend-item"><span class="legend-dot" style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></span>${esc(g)} <b>${count}</b></div>`).join('')}
      </div>
    </div>`;
}

/* ---- Éditeur de fiche (ajout/modif manuels) ---- */
function openEditor(data, isEdit = false, onDone = null) {
  closeSheet();
  const m = isEdit ? data : {
    id: uid(), addedAt: Date.now(), format: 'DVD', rating: 0,
    audio: [], textComments: [], ...data,
  };

  $('#edit-title-h').textContent = isEdit ? 'Modifier' : 'Nouveau film';
  $('#edit-form').innerHTML = `
    <button class="btn-primary" id="tmdb-fill" style="margin-bottom:16px">🔍 Remplir automatiquement depuis TMDB</button>
    <div class="field"><label>Ajouter à</label><select id="f-dest">
      <option value="library" ${!m.wishlist ? 'selected' : ''}>Ma collection</option>
      <option value="wishlist" ${m.wishlist ? 'selected' : ''}>Wishlist (à trouver)</option>
    </select></div>
    ${field('title', 'Titre', m.title)}
    ${field('originalTitle', 'Titre original', m.originalTitle)}
    <div class="field"><label>Format</label><select id="f-format">
      ${['DVD','Blu-ray','4K'].map(o => `<option ${m.format===o?'selected':''}>${o}</option>`).join('')}
    </select></div>
    ${field('year', 'Année', m.year, 'number')}
    <div class="field"><label>Genre</label><select id="f-genre">
      <option value="">—</option>
      ${GENRES.map(g => `<option ${m.genre===g?'selected':''}>${g}</option>`).join('')}
    </select></div>
    <div class="field"><label>Catégorie perso</label><select id="f-tag">
      <option value="" ${!m.tag ? 'selected' : ''}>— Aucune</option>
      <option value="top3" ${m.tag==='top3' ? 'selected' : ''}>🏆 Top 3</option>
      <option value="nanard" ${m.tag==='nanard' ? 'selected' : ''}>🤪 Nanard</option>
      <option value="navet" ${m.tag==='navet' ? 'selected' : ''}>💩 Navet</option>
      <option value="classic" ${m.tag==='classic' ? 'selected' : ''}>🎩 Classique</option>
      <option value="zombie" ${m.tag==='zombie' ? 'selected' : ''}>🧟 Zombie</option>
      <option value="findumonde" ${m.tag==='findumonde' ? 'selected' : ''}>🌍 Fin du monde</option>
    </select></div>
    ${field('director', 'Réalisateur', m.director)}
    ${field('actors', 'Acteurs', m.actors)}
    ${field('duration', 'Durée (min)', m.duration, 'number')}
    ${field('price', "Prix d'achat (€)", m.price, 'number')}
    <div class="field">
      <label>Jaquette</label>
      <div class="poster-input-row">
        <input id="f-poster" type="url" placeholder="URL de l'affiche" value="${esc(m.poster||'')}"/>
        <button type="button" id="btn-photo-jacket" class="btn-photo-jacket" title="Prendre une photo">📷</button>
      </div>
    </div>
    <div id="poster-preview"></div>
    <div class="field"><label>Synopsis</label><textarea id="f-synopsis">${esc(m.synopsis||'')}</textarea></div>
    ${field('barcode', 'Code-barres', m.barcode)}
  `;
  $('#edit-modal').hidden = false;
  $('#edit-backdrop').hidden = false;
  renderPosterPreview(m.poster);

  // Bouton photo jaquette : prendre une photo ou choisir dans la galerie
  $('#btn-photo-jacket').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment'; // caméra arrière par défaut sur mobile
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const dataURL = await fileToDataURL(file);
      $('#f-poster').value = dataURL;
      renderPosterPreview(dataURL);
      toast('Photo ajoutée ✅');
    };
    input.click();
  });

  // Recherche TMDB à partir du titre saisi → remplit tous les champs + jaquette.
  // Messages d'erreur affichés à l'écran (pas besoin de la console).
  // Remplit les champs de l'éditeur à partir d'un id TMDB
  async function fillFromTmdbId(id, fallbackTitle) {
    const key = State.settings.apiKey;
    const dr = await fetch(`https://api.themoviedb.org/3/movie/${id}?language=fr-FR&append_to_response=credits&api_key=${key}`);
    const d = await dr.json();
    const director = (d.credits?.crew || []).find(c => c.job === 'Director');
    const cast = (d.credits?.cast || []).slice(0, 5).map(c => c.name).join(', ');
    $('#f-title').value         = d.title || fallbackTitle;
    $('#f-originalTitle').value = d.original_title || '';
    $('#f-year').value          = (d.release_date || '').slice(0, 4);
    $('#f-director').value      = director ? director.name : '';
    $('#f-actors').value        = cast;
    $('#f-duration').value      = d.runtime || '';
    $('#f-poster').value        = d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : '';
    $('#f-synopsis').value      = d.overview || '';
    if (d.genres && d.genres[0]) {
      const opt = [...$('#f-genre').options].find(o => o.value.toLowerCase() === d.genres[0].name.toLowerCase());
      if (opt) $('#f-genre').value = opt.value;
    }
    renderPosterPreview($('#f-poster').value);
    toast('Champs remplis ✅');
  }

  $('#tmdb-fill').onclick = async () => {
    const title = $('#f-title').value.trim();
    if (!title) { toast('Saisis d’abord un titre'); return; }
    toast('Recherche TMDB : ' + title + '…');
    try {
      const key = State.settings.apiKey;
      const url = `https://api.themoviedb.org/3/search/movie?language=fr-FR&query=${encodeURIComponent(title)}&api_key=${key}`;
      const r = await fetch(url);
      if (!r.ok) { alert('TMDB erreur HTTP ' + r.status + ' (clé invalide ?)'); return; }
      const j = await r.json();
      const results = (j.results || []).slice(0, 8);
      if (!results.length) { alert('Aucun film trouvé pour « ' + title +' ».'); return; }
      if (results.length === 1) {
        await fillFromTmdbId(results[0].id, title);
      } else {
        // Plusieurs résultats -> on laisse choisir
        showTmdbPicker(results, (id) => fillFromTmdbId(id, title));
      }
    } catch (e) {
      alert('Erreur réseau TMDB : ' + (e.message || e));
    }
  };

  $('#edit-save').onclick = async () => {
    m.title         = $('#f-title').value.trim() || 'Sans titre';
    m.originalTitle = $('#f-originalTitle').value.trim();
    m.format        = $('#f-format').value;
    m.year          = $('#f-year').value;
    m.genre         = $('#f-genre').value;
    m.director      = $('#f-director').value.trim();
    m.actors        = $('#f-actors').value.trim();
    m.duration      = +$('#f-duration').value || 0;
    m.poster        = $('#f-poster').value.trim();
    m.synopsis      = $('#f-synopsis').value.trim();
    m.barcode       = $('#f-barcode').value.trim();
    const pv = $('#f-price').value.trim();
    m.price = pv === '' ? null : (parseFloat(pv.replace(',', '.')) || null);
    // Catégorie perso (étiquette unique) avec limite de 3 pour le Top 3
    const newTag = $('#f-tag').value;
    if (newTag === 'top3' && m.tag !== 'top3') {
      const top3Count = State.movies.filter(x => x.id !== m.id && x.tag === 'top3').length;
      if (top3Count >= 3) {
        alert('Votre Top 3 est déjà complet (3 films). Retirez-en un d\'abord pour ajouter celui-ci.');
        return; // on bloque l'enregistrement, l'utilisateur ajuste
      }
    }
    m.tag = newTag;
    m.wishlist      = $('#f-dest').value === 'wishlist'; // destination choisie

    // Détection de doublon : même titre + même format, DANS LA MÊME collection
    // (biblio ou wishlist). Un film en wishlist n'est pas un doublon d'un film
    // déjà possédé, et inversement.
    if (!isEdit) {
      const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
      const sameFormatDup = State.movies.some(x =>
        !!x.wishlist === !!m.wishlist &&
        norm(x.title) === norm(m.title) && (x.format || 'DVD') === m.format);
      if (sameFormatDup) {
        const lieu = m.wishlist ? 'votre wishlist' : 'votre collection';
        const ok = confirm(`« ${m.title} » est déjà dans ${lieu} en ${m.format}.\n\nVoulez-vous modifier le format (DVD / Blu-ray / 4K) ?\n\nOK = revenir changer le format\nAnnuler = ne pas ajouter`);
        if (ok) {
          toast('Changez le format puis validez');
          return;
        } else {
          closeEditor();
          if (typeof onDone === 'function') { onDone(false); return; }
          go(m.wishlist ? 'wishlist' : 'library');
          return;
        }
      }
    }

    await Store.putMovie(m);
    if (!isEdit) State.movies.push(m);
    if (Cloud.enabled()) Cloud.pushMovie(m).catch(() => {});
    closeEditor();
    toast(isEdit ? 'Film modifié' : (m.wishlist ? 'Ajouté à la wishlist' : 'Film ajouté'));
    if (typeof onDone === 'function') { onDone(true); return; } // import : titre suivant
    isEdit ? renderDetail(m) : go(m.wishlist ? 'wishlist' : 'library');
  };
  $('#edit-cancel').onclick = () => {
    closeEditor();
    if (typeof onDone === 'function') onDone(false); // import : on passe ce titre
  };
}
function field(key, label, val, type = 'text') {
  return `<div class="field"><label>${label}</label>
    <input id="f-${key}" type="${type}" value="${esc(val ?? '')}" /></div>`;
}
function closeEditor() { $('#edit-modal').hidden = true; $('#edit-backdrop').hidden = true; }

/* Mini-sélecteur de résultats TMDB (par-dessus l'éditeur).
   results = [{id, title, release_date, poster_path}], onPick(id) */
function showTmdbPicker(results, onPick) {
  let modal = $('#tmdb-picker');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'tmdb-picker';
    modal.className = 'modal';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="modal-head">
      <button class="btn-ghost" id="tmdb-pick-cancel" style="width:auto">Annuler</button>
      <strong>Quel film ?</strong><span></span>
    </div>
    <div class="modal-body">
      <p class="muted small">Plusieurs films correspondent. Touchez le bon :</p>
      <div class="tmdb-results">
        ${results.map(r => {
          const year = (r.release_date || '').slice(0, 4);
          const poster = r.poster_path ? `https://image.tmdb.org/t/p/w185${r.poster_path}` : '';
          return `<button class="tmdb-result" data-id="${r.id}">
            <div class="tmdb-poster" style="${poster ? `background-image:url('${poster}')` : ''}">${poster ? '' : '🎬'}</div>
            <div class="tmdb-info">
              <div class="tmdb-title">${esc(r.title || '')}</div>
              <div class="tmdb-year">${year || '—'}</div>
            </div>
          </button>`;
        }).join('')}
      </div>
    </div>`;
  modal.hidden = false;
  $('#edit-backdrop').hidden = false;
  const close = () => { modal.hidden = true; if ($('#edit-modal').hidden) $('#edit-backdrop').hidden = true; };
  $$('.tmdb-result', modal).forEach(b => b.addEventListener('click', () => {
    close();
    onPick(Number(b.dataset.id));
  }));
  $('#tmdb-pick-cancel').addEventListener('click', close);
}

/* Aperçu de la jaquette dans l'éditeur */
function renderPosterPreview(url) {
  const box = $('#poster-preview');
  if (!box) return;
  box.innerHTML = url
    ? `<img src="${esc(url)}" alt="jaquette" style="max-width:120px;border-radius:8px;border:1px solid var(--border);margin-bottom:8px" />`
    : '';
}

/* ---- Partage ---- */
async function shareMovie(m) {
  // Texte : infos du film + commentaires écrits
  const lines = [];
  lines.push(`🎬 ${m.title}${m.year ? ' (' + m.year + ')' : ''}`);
  if (m.director) lines.push(`Réalisateur : ${m.director}`);
  if (m.genre)    lines.push(`Genre : ${m.genre}`);
  if (m.format)   lines.push(`Format : ${m.format}`);
  if (m.rating)   lines.push(`Note : ${renderStars(m.rating)}`);
  if (m.synopsis) lines.push(`\n${m.synopsis}`);
  const texts = (m.textComments || []).map(c => c.text).filter(Boolean);
  if (texts.length) {
    lines.push(`\n📝 Commentaires :`);
    texts.forEach(t => lines.push(`• ${t}`));
  }
  const txt = lines.join('\n');

  // On joint UNIQUEMENT l'affiche (compatible WhatsApp/Messenger).
  let posterFile = null;
  if (m.poster) {
    try {
      const resp = await fetch(m.poster);
      const blob = await resp.blob();
      const ext = (blob.type.split('/')[1] || 'jpg').split('+')[0];
      posterFile = new File([blob], `${m.title}.${ext}`, { type: blob.type });
    } catch (e) { /* affiche non récupérée */ }
  }

  // 1) Tentative : texte + affiche
  if (posterFile && navigator.canShare && navigator.canShare({ files: [posterFile] })) {
    try {
      await navigator.share({ title: m.title, text: txt, files: [posterFile] });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  // 2) Repli : texte seul (+ lien de l'affiche)
  const txtWithLink = m.poster ? `${txt}\n\nAffiche : ${m.poster}` : txt;
  if (navigator.share) {
    try { await navigator.share({ title: m.title, text: txtWithLink }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  // 3) Repli ultime : presse-papier
  await navigator.clipboard?.writeText(txtWithLink);
  toast('Copié dans le presse-papier');
}

/* ---- Add sheet ---- */
function openSheet()  { $('#add-sheet').hidden = false; $('#sheet-backdrop').hidden = false; }
function closeSheet() { $('#add-sheet').hidden = true;  $('#sheet-backdrop').hidden = true; }

/* ---- Flux d'ajout par scan ---- */
async function startScanFlow() {
  closeSheet();
  Scanner.start(async (ean) => {
    toast('Code détecté : ' + ean + ' — recherche…');
    const film = await MovieAPI.searchByBarcode(ean);
    // Si on a trouvé un vrai film (titre + jaquette), on ouvre la fiche pré-remplie.
    if (film.title && film.poster) {
      toast('Film trouvé ✅');
      openEditor(film);
      return;
    }
    // Sinon : code lu mais film non identifié (limite des bases EAN→DVD).
    // Film non identifié : ouvrir l'éditeur avec le code-barres pré-rempli
    openEditor(film);
  });
}

// Code-barres en attente d'être rattaché à un film créé via OCR
let pendingBarcode = '';

/* ---- Flux d'ajout par photo de jaquette (OCR) ---- */
function fileToDataURL(file) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(file);
  });
}

/* ============================================================
   IMPORT D'UNE LISTE DE TITRES (copier-coller)
   L'utilisateur colle une liste (un titre par ligne). Pour chaque
   titre : recherche TMDB -> choix du bon résultat -> éditeur complet
   pré-rempli -> validation -> titre suivant automatiquement.
   ============================================================ */
let importQueue = [];   // titres restants à traiter
let importIndex = 0;    // position courante (pour l'affichage "x sur n")
let importTotal = 0;

function startImportFlow() {
  closeSheet();
  showOcrModal(); // on réutilise la modale OCR
  setOcrState('import-input', {});
}

// Démarre le traitement de la liste collée
function beginImport(text) {
  const titles = text.split('\n')
    .map(t => t.trim())
    .filter(t => t.length >= 1);
  if (!titles.length) { closeOcrModal(); toast('Liste vide'); return; }
  importQueue = titles;
  importIndex = 0;
  importTotal = titles.length;
  processNextImport();
}

// Traite le titre courant de la file
async function processNextImport() {
  if (!importQueue.length) {
    closeOcrModal();
    toast('Import terminé ✅');
    go('library');
    return;
  }
  importIndex = importTotal - importQueue.length + 1;
  const title = importQueue[0];

  showOcrModal();
  setOcrState('import-progress', { title, index: importIndex, total: importTotal });

  const results = await MovieAPI.searchMulti(title);
  if (!results.length) {
    // Rien trouvé : on ouvre l'éditeur avec juste le titre, puis suivant
    closeOcrModal();
    importQueue.shift();
    openEditor({ title }, false, () => processNextImport());
    return;
  }
  // On affiche les résultats à choisir (avec contexte d'import)
  setOcrState('import-choose', { title, results, index: importIndex, total: importTotal });
}

// L'utilisateur a choisi un résultat TMDB pour le titre d'import courant
async function pickImportResult(id) {
  closeOcrModal();
  importQueue.shift();
  let film = { };
  if (id) {
    toast('Chargement de la fiche…');
    film = await MovieAPI.getDetails(id) || {};
  }
  // Éditeur complet pré-rempli ; à la validation OU annulation -> titre suivant
  openEditor({ ...film }, false, () => processNextImport());
}

// L'utilisateur saute le titre courant
function skipImport() {
  importQueue.shift();
  processNextImport();
}

/* Recadre l'image sur la zone choisie (en %) et renvoie un dataURL */
function cropImage(dataURL, cropPct) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const sx = img.width  * cropPct.x;
      const sy = img.height * cropPct.y;
      const sw = img.width  * cropPct.w;
      const sh = img.height * cropPct.h;
      const canvas = document.createElement('canvas');
      canvas.width = sw; canvas.height = sh;
      canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      res(canvas.toDataURL('image/png'));
    };
    img.onerror = () => rej(new Error('Image illisible'));
    img.src = dataURL;
  });
}

/* L'utilisateur a choisi un film précis dans la liste TMDB */
async function pickTmdbResult(id) {
  closeOcrModal();
  toast('Chargement de la fiche…');
  const barcode = pendingBarcode; pendingBarcode = '';
  const film = await MovieAPI.getDetails(id);
  if (film) {
    toast('Film trouvé ✅');
    openEditor({ ...film, barcode });
  } else {
    toast('Erreur — saisie manuelle');
    openEditor({ ...MovieAPI.blankFromBarcode(barcode, '') });
  }
}

/* --- Modale OCR (réutilise le backdrop d'édition) --- */
function showOcrModal() {
  let modal = $('#ocr-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'ocr-modal';
    modal.className = 'modal';
    document.body.appendChild(modal);
  }
  modal.hidden = false;
  $('#edit-backdrop').hidden = false;
}
function closeOcrModal() {
  const modal = $('#ocr-modal');
  if (modal) modal.hidden = true;
  $('#edit-backdrop').hidden = true;
}
function setOcrState(state, data = {}) {
  const modal = $('#ocr-modal');
  if (!modal) return;
  if (state === 'import-input') {
    modal.innerHTML = `
      <div class="modal-head">
        <button class="btn-ghost" id="ocr-cancel" style="width:auto">Annuler</button>
        <strong>Nouveau film</strong><span></span>
      </div>
      <div class="modal-body">
        <p class="muted small">Entrez le titre du film, ou une liste — <b>un titre par ligne</b>.<br>Vous validerez la fiche de chaque film un par un à l'étape suivante.</p>
        <div class="field" style="margin-top:12px">
          <textarea id="import-textarea" rows="10" placeholder="Casino&#10;Le Parrain&#10;Heat&#10;Pulp Fiction&#10;…"></textarea>
        </div>
        <button class="btn-primary" id="import-start-btn">Importer ces films</button>
      </div>`;
    $('#import-start-btn').addEventListener('click', () => {
      const txt = $('#import-textarea').value;
      if (txt.trim()) beginImport(txt);
    });
    $('#ocr-cancel').addEventListener('click', closeOcrModal);
  } else if (state === 'import-progress') {
    modal.innerHTML = `
      <div class="modal-head">
        <span></span><strong>Import ${data.index}/${data.total}</strong><span></span>
      </div>
      <div class="modal-body" style="text-align:center;padding-top:40px">
        <div class="ocr-spinner">🔍</div>
        <p class="muted">Recherche : « ${esc(data.title)} »…</p>
      </div>`;
  } else if (state === 'import-choose') {
    modal.innerHTML = `
      <div class="modal-head">
        <button class="btn-ghost" id="ocr-cancel" style="width:auto">Arrêter</button>
        <strong>${data.index}/${data.total} · ${esc(data.title)}</strong>
        <button class="btn-link" id="import-skip">Passer</button>
      </div>
      <div class="modal-body">
        <p class="muted small">Choisissez le bon film (ou « Passer ») :</p>
        <div class="tmdb-results">
          ${data.results.map(r => `
            <button class="tmdb-result" data-id="${r.id}">
              <div class="tmdb-poster" style="${r.poster ? `background-image:url('${r.poster}')` : ''}">${r.poster ? '' : '🎬'}</div>
              <div class="tmdb-info">
                <div class="tmdb-title">${esc(r.title)}</div>
                <div class="tmdb-year">${r.year || '—'}</div>
              </div>
            </button>`).join('')}
        </div>
        <button class="btn-ghost" id="import-manual" style="margin-top:10px">Aucun ne correspond — saisir à la main</button>
      </div>`;
    $$('.tmdb-result', modal).forEach(b =>
      b.addEventListener('click', () => pickImportResult(Number(b.dataset.id))));
    $('#import-skip').addEventListener('click', skipImport);
    $('#import-manual').addEventListener('click', () => pickImportResult(null));
    $('#ocr-cancel').addEventListener('click', () => {
      importQueue = []; closeOcrModal(); toast('Import arrêté'); go('library');
    });
  }
  const cancel = $('#ocr-cancel');
  if (cancel) cancel.addEventListener('click', closeOcrModal);
}

/* ---- Filtres : catégories perso + genres ---- */
function openFilters() {
  const genres = GENRES;
  const cats = Object.entries(TAG_LABELS).map(([v, label]) => ({ v, label }));

  showOcrModal();
  const modal = $('#ocr-modal');
  modal.innerHTML = `
    <div class="modal-head">
      <button class="btn-ghost" id="ocr-cancel" style="width:auto">Fermer</button>
      <strong>Filtrer</strong><span></span>
    </div>
    <div class="modal-body">
      <p class="muted small" style="margin-bottom:6px">Catégories</p>
      <div class="genre-list">
        <button class="genre-item ${!State.filters.tag ? 'active' : ''}" data-tag="">Toutes</button>
        ${cats.map(c => `
          <button class="genre-item ${State.filters.tag === c.v ? 'active' : ''}" data-tag="${c.v}">${c.label}</button>
        `).join('')}
      </div>
      <p class="muted small" style="margin:16px 0 6px">Genre</p>
      <div class="genre-list">
        <button class="genre-item ${!State.filters.genre ? 'active' : ''}" data-g="">Tous les genres</button>
        ${genres.map(g => `
          <button class="genre-item ${State.filters.genre === g ? 'active' : ''}" data-g="${esc(g)}">${esc(g)}</button>
        `).join('')}
      </div>
    </div>`;
  $$('.genre-item[data-g]', modal).forEach(b => b.addEventListener('click', () => {
    const g = b.dataset.g;
    if (g) State.filters.genre = g; else delete State.filters.genre;
    closeOcrModal();
    renderLibrary();
  }));
  $$('.genre-item[data-tag]', modal).forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.tag;
    if (t) State.filters.tag = t; else delete State.filters.tag;
    closeOcrModal();
    renderLibrary();
  }));
  $('#ocr-cancel').addEventListener('click', closeOcrModal);
}

/* ---- Import / Export ---- */
async function exportJSON() {
  const data = JSON.stringify({ version: 1, exportedAt: Date.now(), movies: State.movies }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `dvdtheque-${new Date().toISOString().slice(0,10)}.json`;
  a.click(); URL.revokeObjectURL(url);
}

/* Charge jsPDF à la demande (CDN) */
function loadJsPDF() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
    s.onload = res;
    s.onerror = () => rej(new Error('Chargement jsPDF impossible (réseau ?)'));
    document.head.appendChild(s);
  });
}

/* Télécharge une image et la convertit en dataURL (pour l'intégrer au PDF).
   Renvoie null si échec (affiche manquante / réseau). */
function imageToDataURL(url) {
  return new Promise((res) => {
    if (!url) return res(null);
    // Utiliser canvas pour contourner les restrictions CORS dans WebView Capacitor
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        res(canvas.toDataURL('image/jpeg', 0.85));
      } catch (e) {
        // Si canvas tainted (CORS), on retourne null
        res(null);
      }
    };
    img.onerror = () => res(null);
    // Ajouter timestamp pour éviter le cache
    // Forcer JPEG — remplacer .webp par .jpg et utiliser w342 pour TMDB
    let cleanUrl = url;
    // Si c'est une URL TMDB, forcer le format JPEG
    if (url.includes('image.tmdb.org')) {
      cleanUrl = url.replace('/w500/', '/w342/').replace('.webp', '.jpg');
    } else if (url.startsWith('data:image/webp')) {
      // Image base64 WEBP — on ne peut pas la convertir sans lib, on skip
      res(null);
      return;
    }
    img.src = cleanUrl;
  });
}

/* Exporte la collection visible (respecte le filtre actif) en PDF,
   sous forme de grille de vignettes : affiche + titre + réalisateur
   + année + genre + format. */
async function exportPDF(mode = 'library', withPrice = false) {
  if (window._admobOnPdfExport) window._admobOnPdfExport();
  // Afficher un toast pendant la génération
  toast('Génération du PDF en cours…');
  const isWish = mode === 'wishlist';
  const movies = isWish
    ? State.movies.filter(m => m.wishlist)
    : visibleMovies();
  if (!movies.length) { toast(isWish ? 'Wishlist vide' : 'Aucun film à exporter'); return; }

  toast('Génération du PDF…');
  try {
    await loadJsPDF();
  } catch (e) { toast(e.message); return; }

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = 210, pageH = 297;
  const margin = 12;
  const cols = 3;
  const gap = 8;
  const cellW = (pageW - margin * 2 - gap * (cols - 1)) / cols; // largeur d'une vignette
  const posterH = cellW * 1.4;      // ratio affiche ~ 1:1.4
  const textH = 20;                 // hauteur réservée au texte sous l'affiche
  const cellH = posterH + textH;
  const headerH = 22;  // hauteur réservée à l'en-tête (titre + 2 lignes)
  const rowsPerPage = Math.floor((pageH - margin * 2 - headerH) / (cellH + gap));

  // Titre du document
  pdf.setFontSize(18);
  pdf.text(isWish ? 'Ma Wishlist' : 'Ma DVDthèque', margin, margin + 4);
  pdf.setFontSize(10);
  pdf.setTextColor(120);
  // Portée
  let portee;
  if (isWish) {
    portee = 'Films recherchés';
  } else {
    portee = State.formatFilter ? `Format : ${State.formatFilter}` : 'Collection complète';
    if (State.filters.genre) portee += ` · Genre : ${State.filters.genre}`;
  }
  pdf.text(`${portee} — ${movies.length} film(s)`, margin, margin + 10);
  // Date de création du PDF
  const dateStr = new Date().toLocaleDateString('fr-FR', {
    day: '2-digit', month: 'long', year: 'numeric',
  });
  pdf.text(`Généré le ${dateStr}`, margin, margin + 15);
  pdf.setTextColor(0);

  // Position courante en Y absolue (gère en-têtes de genre + grille)
  const startY = margin + headerH;
  let curY = startY;   // haut de la rangée courante
  let col = 0;

  // Dessine une vignette à la position (x, curY)
  async function drawCell(m, x) {
    const y = curY;
    const img = await imageToDataURL(m.poster);
    if (img) {
      try { pdf.addImage(img, 'JPEG', x, y, cellW, posterH); }
      catch (e) { pdf.setDrawColor(200); pdf.rect(x, y, cellW, posterH); }
    } else {
      pdf.setFillColor(235); pdf.rect(x, y, cellW, posterH, 'F');
      pdf.setFontSize(22); pdf.setTextColor(150);
      pdf.text((m.title || '?').charAt(0).toUpperCase(), x + cellW / 2, y + posterH / 2, { align: 'center', baseline: 'middle' });
      pdf.setTextColor(0);
    }
    // Titre sous l'affiche — plus gros et gras
    let ty = y + posterH + 5;
    pdf.setFont(undefined, 'bold'); pdf.setFontSize(10); pdf.setTextColor(0);
    const title = pdf.splitTextToSize(m.title || 'Sans titre', cellW);
    pdf.text(title.slice(0, 2), x, ty);
    ty += title.length > 1 ? 8 : 5;
    // Meta
    pdf.setFont(undefined, 'normal'); pdf.setFontSize(7); pdf.setTextColor(90);
    const meta = [m.director, m.year, m.format].filter(Boolean).join(' · ');
    const metaLines = pdf.splitTextToSize(meta, cellW);
    pdf.text(metaLines.slice(0, 2), x, ty);
    if (withPrice && m.price != null && m.price !== '') {
      ty += (metaLines.length > 1 ? 6 : 3.5);
      pdf.setFontSize(8); pdf.setTextColor(0);
      pdf.text(fmtPrice(m.price), x, ty);
    }
    pdf.setTextColor(0);
  }

  // Saut de ligne dans la grille
  function nextRow() { col = 0; curY += cellH + gap; }
  function ensureSpace(needed) {
    if (curY + needed > pageH - margin) { pdf.addPage(); curY = margin + 6; col = 0; }
  }

  if (isWish) {
    // Wishlist : pas de groupement, grille simple
    for (const m of movies) {
      if (col === 0) ensureSpace(cellH);
      await drawCell(m, margin + col * (cellW + gap));
      col++;
      if (col >= cols) nextRow();
    }
  } else {
    // Collection : groupé par genre, en-tête par genre
    const byGenre = {};
    movies.forEach(m => {
      const g = m.genre || 'Sans genre';
      (byGenre[g] = byGenre[g] || []).push(m);
    });
    const genresSorted = Object.keys(byGenre).sort((a, b) => a.localeCompare(b));
    for (const g of genresSorted) {
      // En-tête de genre
      if (col !== 0) nextRow();            // termine la rangée en cours
      ensureSpace(28 + cellH);             // place pour l'en-tête grand + au moins une rangée
      curY += 4;
      pdf.setFont(undefined, 'bold'); pdf.setFontSize(36); pdf.setTextColor(0);
      pdf.text(`${g}  (${byGenre[g].length})`, margin, curY);
      pdf.setFont(undefined, 'normal');
      pdf.setDrawColor(200); pdf.line(margin, curY + 4, pageW - margin, curY + 4);
      curY += 20;
      col = 0;
      // Films du genre
      for (const m of byGenre[g]) {
        if (col === 0) ensureSpace(cellH);
        await drawCell(m, margin + col * (cellW + gap));
        col++;
        if (col >= cols) nextRow();
      }
      if (col !== 0) nextRow(); // termine la rangée avant le genre suivant
    }
  }

  // Total de la collection (si prix demandés)
  if (withPrice) {
    const withP = movies.filter(m => m.price != null && m.price !== '');
    if (withP.length) {
      const total = withP.reduce((s, m) => s + Number(m.price), 0);
      let totalY = curY + 4;
      if (totalY > pageH - margin - 10) { pdf.addPage(); totalY = margin + 10; }
      pdf.setFont(undefined, 'bold'); pdf.setFontSize(12); pdf.setTextColor(0);
      pdf.text(`Valeur totale de la collection : ${fmtPrice(total)}`, margin, totalY);
      pdf.setFont(undefined, 'normal'); pdf.setFontSize(8); pdf.setTextColor(120);
      pdf.text(`(${withP.length} film(s) avec prix sur ${movies.length})`, margin, totalY + 5);
      pdf.setTextColor(0);
    }
  }

  const fname = `${isWish ? 'wishlist' : 'ma-dvdtheque'}-${new Date().toISOString().slice(0,10)}.pdf`;
  // Sur mobile, ouvrir le partage natif si possible, sinon télécharger
  const blob = pdf.output('blob');
  const file = new File([blob], fname, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: isWish ? 'Ma Wishlist' : 'Ma DVDthèque' }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  // Repli : téléchargement
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fname; a.click();
  URL.revokeObjectURL(url);
  toast('PDF généré ✅');
}
function importJSON() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'application/json';
  input.onchange = async () => {
    const file = input.files[0]; if (!file) return;
    try {
      const j = JSON.parse(await file.text());
      const incoming = j.movies || [];
      for (const m of incoming) { m.id = m.id || uid(); await Store.putMovie(m); }
      State.movies = await Store.allMovies();
      toast(`${incoming.length} film(s) importé(s)`); go('library');
    } catch (e) { toast('Fichier invalide'); }
  };
  input.click();
}

/* ---- Thème ---- */
async function toggleTheme() {
  State.settings.theme = State.settings.theme === 'dark' ? 'light' : 'dark';
  applyTheme(); await Store.setKV('settings', State.settings); renderProfile();
}
function applyTheme() {
  document.documentElement.setAttribute('data-theme', State.settings.theme);
}

/* ---- Clé API ---- */
async function configureAPI() {
  const provider = prompt('Fournisseur API ("tmdb" ou "omdb") :', State.settings.apiProvider) || 'tmdb';
  const key = prompt(`Clé API ${provider.toUpperCase()} :`, State.settings.apiKey || '');
  if (key !== null) {
    State.settings.apiProvider = provider.trim().toLowerCase();
    State.settings.apiKey = key.trim();
    await Store.setKV('settings', State.settings);
    toast('Réglages API enregistrés');
  }
}

/* ============================================================
   QUIZ — connaissance de sa collection
   Génère des questions à choix multiple à partir des films de la
   collection (pas wishlist). Plusieurs types de questions par film.
   Packs de 10. Code couleur vert/rouge. Score final. Stats par film
   sauvegardées (localement + cloud) pour : évaluation globale + faire
   revenir plus souvent les films à faible score.
   ============================================================ */
const Quiz = (() => {
  const PACK_SIZE = 10;
  let pack = [];        // questions du pack courant
  let idx = 0;          // index question courante
  let correct = 0;      // bonnes réponses du pack
  let answered = false; // a-t-on déjà répondu à la question affichée
  let stats = null;     // { films: {id: {asked, correct}}, totalAsked, totalCorrect, packs }

  // Charge les stats depuis le stockage (clé 'quizStats')
  async function loadStats() {
    if (stats) return stats;
    stats = (await Store.getKV('quizStats')) || { films: {}, totalAsked: 0, totalCorrect: 0, packs: 0 };
    return stats;
  }
  async function saveStats() {
    await Store.setKV('quizStats', stats);
  }

  // Films jouables = collection (hors wishlist) avec au moins un titre
  function pool() {
    return State.movies.filter(m => !m.wishlist && m.title);
  }

  // Choisit n éléments distincts au hasard dans un tableau
  function sample(arr, n) {
    const c = [...arr];
    const out = [];
    while (c.length && out.length < n) {
      out.push(c.splice(Math.floor(Math.random() * c.length), 1)[0]);
    }
    return out;
  }
  function shuffle(arr) { return sample(arr, arr.length); }

  // Types de questions générables pour un film, selon ses données dispo
  function buildQuestion(film, all) {
    const types = [];
    if (film.director) types.push('director');
    if (film.year) types.push('year');
    if (film.actors) types.push('actor');
    if (film.genre) types.push('genre');
    if (film.synopsis && film.synopsis.length > 40) {
      types.push('synopsis');        // deviner le film d'après le résumé
      types.push('synopsis-start');  // comment commence le résumé (1ère phrase)
    }
    if (film.poster) types.push('poster'); // affiche zoomée
    if (!types.length) return null;
    const type = sample(types, 1)[0];

    const others = all.filter(m => m.id !== film.id);
    const wrongFrom = (key, val) => {
      const vals = [...new Set(others.map(m => m[key]).filter(v => v && v !== val))];
      return sample(vals, 3);
    };

    let q, answer, options, image = null, zoom = null;
    switch (type) {
      case 'director': {
        q = `Qui a réalisé « ${film.title} » ?`;
        answer = film.director;
        options = shuffle([answer, ...wrongFrom('director', answer)]);
        break;
      }
      case 'year': {
        q = `En quelle année est sorti « ${film.title} » ?`;
        answer = String(film.year);
        const wrongYears = [];
        while (wrongYears.length < 3) {
          const delta = (Math.floor(Math.random() * 11) - 5);
          const y = String(Number(film.year) + delta);
          if (y !== answer && !wrongYears.includes(y)) wrongYears.push(y);
        }
        options = shuffle([answer, ...wrongYears]);
        break;
      }
      case 'actor': {
        const firstActor = film.actors.split(',')[0].trim();
        q = `Quel acteur joue dans « ${film.title} » ?`;
        answer = firstActor;
        const otherActors = [...new Set(others
          .map(m => (m.actors || '').split(',')[0].trim())
          .filter(a => a && a !== answer))];
        options = shuffle([answer, ...sample(otherActors, 3)]);
        break;
      }
      case 'genre': {
        q = `À quel genre appartient « ${film.title} » ?`;
        answer = film.genre;
        const otherGenres = GENRES.filter(g => g !== answer);
        options = shuffle([answer, ...sample(otherGenres, 3)]);
        break;
      }
      case 'synopsis': {
        q = `Quel film correspond à ce résumé ?\n\n« ${film.synopsis.slice(0, 180)}… »`;
        answer = film.title;
        options = shuffle([answer, ...wrongFrom('title', answer)]);
        break;
      }
      case 'synopsis-start': {
        // Donne le titre, demande quelle est la première phrase de son résumé
        const firstSentence = (film.synopsis.split(/(?<=[.!?])\s/)[0] || film.synopsis).slice(0, 120);
        q = `Quel est le début du résumé de « ${film.title} » ?`;
        answer = firstSentence + '…';
        // Mauvaises réponses : débuts de résumés d'autres films
        const otherStarts = others
          .filter(m => m.synopsis && m.synopsis.length > 40)
          .map(m => (m.synopsis.split(/(?<=[.!?])\s/)[0] || m.synopsis).slice(0, 120) + '…');
        options = shuffle([answer, ...sample([...new Set(otherStarts)], 3)]);
        break;
      }
      case 'poster': {
        q = `Quel est ce film ? (détail de l'affiche)`;
        answer = film.title;
        image = film.poster;
        zoom = {
          size: 280 + Math.floor(Math.random() * 120),
          x: Math.floor(Math.random() * 100),
          y: Math.floor(Math.random() * 100),
        };
        options = shuffle([answer, ...wrongFrom('title', answer)]);
        break;
      }
    }
    // Il faut au moins 2 options valides
    options = options.filter(Boolean);
    if (options.length < 2 || !answer) return null;
    return { filmId: film.id, q, answer, options, image, zoom };
  }

  // Construit un pack de 10 questions, en privilégiant les films à faible score
  function buildPack() {
    const films = pool();
    if (films.length < 4) return [];

    // Poids : films souvent ratés ou jamais vus reviennent plus souvent
    const weighted = [];
    films.forEach(m => {
      const s = stats.films[m.id];
      let weight = 3; // par défaut
      if (s && s.asked > 0) {
        const rate = s.correct / s.asked;
        weight = rate < 0.5 ? 6 : rate < 0.8 ? 3 : 1; // mauvais score -> plus fréquent
      } else {
        weight = 4; // jamais posé -> un peu prioritaire
      }
      for (let i = 0; i < weight; i++) weighted.push(m);
    });

    const out = [];
    let guard = 0;
    while (out.length < PACK_SIZE && guard < 200) {
      guard++;
      const film = sample(weighted, 1)[0];
      const question = buildQuestion(film, films);
      if (question) out.push(question);
    }
    return out;
  }

  async function start() {
    await loadStats();
    pack = buildPack();
    idx = 0; correct = 0; answered = false;
    if (!pack.length) { renderQuizHome(); return; }
    renderQuestion();
  }

  function renderQuestion() {
    const box = $('#quiz-content');
    const question = pack[idx];
    answered = false;
    box.innerHTML = `
      <div class="quiz-head">
        <span>Question ${idx + 1}/${pack.length}</span>
        <span>Score : ${correct}</span>
      </div>
      ${question.image ? (question.zoom
        ? `<div class="quiz-image zoomed" style="background-image:url('${question.image}');background-size:${question.zoom.size}%;background-position:${question.zoom.x}% ${question.zoom.y}%"></div>`
        : `<div class="quiz-image" style="background-image:url('${question.image}')"></div>`) : ''}
      <div class="quiz-q">${esc(question.q).replace(/\n/g, '<br>')}</div>
      <div class="quiz-options">
        ${question.options.map((o, i) => `<button class="quiz-opt" data-i="${i}">${esc(o)}</button>`).join('')}
      </div>
      <button class="btn-primary" id="quiz-next" hidden>${idx + 1 < pack.length ? 'Question suivante' : 'Voir le résultat'}</button>
    `;
    $$('.quiz-opt', box).forEach(b =>
      b.addEventListener('click', () => answerQuestion(b, question)));
    $('#quiz-next').addEventListener('click', () => {
      idx++;
      if (idx < pack.length) renderQuestion();
      else finishPack();
    });
  }

  async function answerQuestion(btn, question) {
    if (answered) return;
    answered = true;
    const chosen = question.options[+btn.dataset.i];
    const isRight = chosen === question.answer;

    // Code couleur
    $$('.quiz-opt').forEach(b => {
      b.disabled = true;
      const val = question.options[+b.dataset.i];
      if (val === question.answer) b.classList.add('right');      // bonne réponse en vert
      else if (b === btn) b.classList.add('wrong');               // mauvaise choisie en rouge
    });
    if (isRight) correct++;

    // Maj stats par film
    const s = stats.films[question.filmId] || { asked: 0, correct: 0 };
    s.asked++; if (isRight) s.correct++;
    stats.films[question.filmId] = s;
    stats.totalAsked++; if (isRight) stats.totalCorrect++;

    $('#quiz-next').hidden = false;
  }

  async function finishPack() {
    stats.packs = (stats.packs || 0) + 1;
    await saveStats();

    const pct = Math.round((correct / pack.length) * 100);
    const globalPct = stats.totalAsked ? Math.round((stats.totalCorrect / stats.totalAsked) * 100) : 0;
    const box = $('#quiz-content');
    box.innerHTML = `
      <div class="quiz-result">
        <div class="quiz-score-big">${correct}/${pack.length}</div>
        <p class="muted">${pct}% de bonnes réponses sur ce quiz</p>
        <div class="quiz-eval">
          <div class="lbl">Connaissance de votre collection</div>
          <div class="quiz-eval-pct">${globalPct}%</div>
          <div class="quiz-level">${levelLabel(globalPct)}</div>
          <div class="muted small">Évaluation sur ${stats.totalAsked} question(s) au total · ${stats.packs} quiz joué(s)</div>
        </div>
        <button class="btn-primary" id="quiz-again">Nouveau quiz</button>
        <button class="btn-ghost" id="quiz-home">Retour</button>
      </div>`;
    $('#quiz-again').addEventListener('click', () => start());
    $('#quiz-home').addEventListener('click', () => renderQuizHome());
  }

  function levelLabel(pct) {
    if (pct >= 90) return '🏆 Expert de votre collection';
    if (pct >= 75) return '🎬 Grand connaisseur';
    if (pct >= 50) return '🍿 Bon amateur';
    if (pct >= 25) return '👀 Débutant';
    return '🌱 À découvrir';
  }

  return { start, loadStats, levelLabel, getStats: () => stats };
})();

/* Écran d'accueil du Quiz */
async function renderQuizHome() {
  const box = $('#quiz-content');
  const films = State.movies.filter(m => !m.wishlist && m.title);
  if (films.length < 4) {
    box.innerHTML = `
      <div class="quiz-intro">
        <div class="quiz-icon">❓</div>
        <h2>Quiz collection</h2>
        <p class="muted">Ajoutez au moins 4 films à votre collection pour débloquer le quiz. (Vous en avez ${films.length}.)</p>
      </div>`;
    return;
  }
  await Quiz.loadStats();
  const s = Quiz.getStats();
  const globalPct = s && s.totalAsked ? Math.round((s.totalCorrect / s.totalAsked) * 100) : null;
  box.innerHTML = `
    <div class="quiz-intro">
      <div class="quiz-icon">❓</div>
      <h2>Quiz collection</h2>
      <p class="muted">Testez votre connaissance de vos ${films.length} films. 10 questions par partie.</p>
      ${globalPct != null ? `
        <div class="quiz-eval">
          <div class="lbl">Votre niveau actuel</div>
          <div class="quiz-eval-pct">${globalPct}%</div>
          <div class="quiz-level">${Quiz.levelLabel(globalPct)}</div>
          <div class="muted small">${s.totalAsked} question(s) · ${s.packs || 0} quiz joué(s)</div>
        </div>` : ''}
      <button class="btn-primary" id="quiz-start">${globalPct != null ? 'Rejouer un quiz' : 'Commencer le quiz'}</button>
    </div>`;
  $('#quiz-start').addEventListener('click', () => Quiz.start());
}

/* ============================================================
   7. BOOTSTRAP
   ============================================================ */
async function boot() {
  await Store.init();

  const saved = await Store.getKV('settings');
  if (saved) State.settings = { ...State.settings, ...saved };
  applyTheme();

  bindEvents();
  bindLogin();
  bindMediaToggle();

  // Service worker : zéro cache + auto-update.
  // Quand un nouveau service worker prend le contrôle, on recharge
  // la page une seule fois pour servir la dernière version (sans
  // que l'utilisateur ait à vider quoi que ce soit).
  if ('serviceWorker' in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.update(); // cherche une nouvelle version immédiatement
      // Vérifie aussi à chaque retour sur l'app (onglet réactivé)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update();
      });
    }).catch(() => {});
  }

  if (Cloud.configured()) {
    // Mode connecté : on affiche l'écran de login tant que Firebase
    // n'a pas confirmé une session. onAuthChanged gère l'affichage.
    showLogin(true);
    try {
      await Cloud.init(onAuthChanged);
    } catch (e) {
      console.warn('Cloud init:', e);
      // En cas d'échec d'init, on bascule en mode local pour ne pas bloquer
      showLogin(false);
      State.movies = await Store.allMovies();
      go('library');
    }
  } else {
    // Pas de config Firebase : mode 100% local, pas de mur de connexion
    showLogin(false);
    State.movies = await Store.allMovies();
    go('library');
  }
}

/* Affiche / masque l'écran de connexion plein écran */
function showLogin(show) {
  const screen = $('#login-screen'), app = $('#app');
  if (screen) screen.hidden = !show;
  if (app) app.style.display = show ? 'none' : '';
}

// ── Store Séries ─────────────────────────────────────────────
function seriesKey() { return 'dvd_series_' + (Cloud.uid ? Cloud.uid() : 'local'); }

function loadSeries() {
  try { State.series = JSON.parse(localStorage.getItem(seriesKey()) || '[]'); }
  catch(e) { State.series = []; }
}

function saveSeries() {
  localStorage.setItem(seriesKey(), JSON.stringify(State.series));
  if (Cloud.enabled && Cloud.enabled()) {
    Cloud.pushSeries && Cloud.pushSeries(State.series);
  }
}

function addSeries(s) {
  if (State.series.find(x => x.id === s.id)) return;
  s.addedAt = Date.now();
  s.watchStatus = 'watching'; // watching | completed | dropped | plantowatch
  s.seenEpisodes = {}; // { "S1E1": true, ... }
  s.rating = 0;
  State.series.push(s);
  saveSeries();
  renderSeries();
}

function removeSeries(id) {
  State.series = State.series.filter(s => s.id !== id);
  saveSeries();
  renderSeries();
}

function toggleEpisodeSeen(seriesId, season, episode) {
  const s = State.series.find(x => x.id === seriesId);
  if (!s) return;
  const key = `S${season}E${episode}`;
  s.seenEpisodes = s.seenEpisodes || {};
  s.seenEpisodes[key] = !s.seenEpisodes[key];
  // Calculer progression
  const total = s.seasons ? s.seasons.reduce((acc, ss) => acc + ss.episodeCount, 0) : 0;
  const seen = Object.values(s.seenEpisodes).filter(Boolean).length;
  s.episodesSeen = seen;
  s.episodesTotal = total;
  // Auto-compléter statut
  if (seen >= total && total > 0) s.watchStatus = 'completed';
  else if (seen > 0) s.watchStatus = 'watching';
  saveSeries();
}

const SERIES_STATUS = {
  watching:    '▶ En cours',
  completed:   '✅ Terminé',
  dropped:     '❌ Abandonné',
  plantowatch: '🔖 À voir',
};

async function openSeriesDetail(seriesId) {
  const s = State.series.find(x => x.id === seriesId);
  if (!s) return;
  const apiKey = State.settings.apiKey;

  // Charger les saisons si pas encore chargées
  if (s.seasons && s.seasons.length > 0 && !s.seasons[0].episodes) {
    toast('Chargement des épisodes…');
    for (const season of s.seasons) {
      try {
        season.episodes = await tmdbSeasonDetails(s.tmdbId, season.number, apiKey);
      } catch(e) { season.episodes = []; }
    }
    saveSeries();
  }

  const seen = Object.values(s.seenEpisodes || {}).filter(Boolean).length;
  const total = s.episodesTotal || s.nbEpisodes || 0;
  const pct = total > 0 ? Math.round(seen / total * 100) : 0;

  const seasonsHtml = (s.seasons || []).map(season => {
    const eps = season.episodes || [];
    const seenInSeason = eps.filter(e => s.seenEpisodes[`S${season.number}E${e.number}`]).length;
    const allSeen = seenInSeason === eps.length && eps.length > 0;
    return `
      <div class="series-season">
        <div class="series-season-header" onclick="toggleSeason(this)">
          <span>Saison ${season.number} — ${season.name}</span>
          <span class="season-progress">${seenInSeason}/${eps.length}</span>
          <button class="btn-ghost season-all-btn" onclick="event.stopPropagation();markSeasonAll('${seriesId}',${season.number},${!allSeen})" style="font-size:.8rem;padding:4px 8px">
            ${allSeen ? 'Tout décocher' : 'Tout cocher'}
          </button>
        </div>
        <div class="series-episodes" hidden>
          ${eps.map(e => `
            <label class="episode-row">
              <input type="checkbox" ${s.seenEpisodes[`S${season.number}E${e.number}`] ? 'checked' : ''}
                onchange="toggleEpisodeSeen('${seriesId}',${season.number},${e.number});updateSeriesDetail('${seriesId}')">
              <span class="ep-num">S${season.number}E${String(e.number).padStart(2,'0')}</span>
              <span class="ep-name">${e.name}</span>
              ${e.runtime ? `<span class="ep-runtime">${e.runtime}min</span>` : ''}
            </label>
          `).join('')}
        </div>
      </div>`;
  }).join('');

  const html = `
    <div class="series-detail">
      <div class="series-detail-header" style="background-image:url('${s.poster}')">
        <div class="series-detail-overlay">

        </div>
      </div>
      <div class="series-detail-body">
        <h2>${s.name} ${s.year ? '('+s.year+')' : ''}</h2>
        <div class="series-status-row">
          <select onchange="setSeriesStatus('${seriesId}',this.value)" class="select">
            ${Object.entries(SERIES_STATUS).map(([k,v]) => `<option value="${k}" ${s.watchStatus===k?'selected':''}>${v}</option>`).join('')}
          </select>
          <div class="series-rating">
            ${[1,2,3,4,5].map(n => `<span onclick="setSeriesRating('${seriesId}',${n})" style="cursor:pointer;font-size:1.4rem">${n <= (s.rating||0) ? '★' : '☆'}</span>`).join('')}
          </div>
        </div>
        <div class="series-progress-bar">
          <div class="series-progress-fill" id="progress-fill-${seriesId}" style="width:${pct}%"></div>
        </div>
        <div class="series-progress-text" id="progress-text-${seriesId}">${seen} / ${total} épisodes vus (${pct}%)</div>
        <p class="series-overview">${s.overview || ''}</p>
        <div class="series-seasons">${seasonsHtml}</div>
      </div>
    </div>`;

  // Afficher le détail dans #series-detail, cacher la liste
  const seriesGrid = $('#series-grid');
  const seriesSearchBar = $('#series-searchbar');
  const seriesEmpty = $('#series-empty');
  if (seriesGrid) seriesGrid.hidden = true;
  if (seriesSearchBar) seriesSearchBar.hidden = true;
  if (seriesEmpty) seriesEmpty.hidden = true;

  let detail = $('#series-detail');
  if (!detail) {
    detail = document.createElement('div');
    detail.id = 'series-detail';
    const view = $('[data-view="series"]');
    if (view) view.appendChild(detail);
  }
  detail.innerHTML = html;
  detail.hidden = false;
  State.seriesDetailOpen = seriesId;
}

function toggleSeason(header) {
  const eps = header.nextElementSibling;
  if (eps) eps.hidden = !eps.hidden;
}

function markSeasonAll(seriesId, seasonNum, seen) {
  const s = State.series.find(x => x.id === seriesId);
  if (!s) return;
  const season = s.seasons && s.seasons.find(ss => ss.number === seasonNum);
  if (!season || !season.episodes) return;
  season.episodes.forEach(e => {
    s.seenEpisodes[`S${seasonNum}E${e.number}`] = seen;
  });
  const total = s.seasons.reduce((acc, ss) => acc + ss.episodeCount, 0);
  s.episodesSeen = Object.values(s.seenEpisodes).filter(Boolean).length;
  s.episodesTotal = total;
  if (s.episodesSeen >= total && total > 0) s.watchStatus = 'completed';
  saveSeries();
  openSeriesDetail(seriesId);
}

function setSeriesStatus(seriesId, status) {
  const s = State.series.find(x => x.id === seriesId);
  if (s) { s.watchStatus = status; saveSeries(); }
}

function setSeriesRating(seriesId, rating) {
  const s = State.series.find(x => x.id === seriesId);
  if (s) { s.rating = rating; saveSeries(); openSeriesDetail(seriesId); }
}

function updateSeriesDetail(seriesId) {
  const s = State.series.find(x => x.id === seriesId);
  if (!s) return;
  const seen = Object.values(s.seenEpisodes || {}).filter(Boolean).length;
  const total = s.episodesTotal || 0;
  const pct = total > 0 ? Math.round(seen / total * 100) : 0;
  const fill = $(`#progress-fill-${seriesId}`);
  const text = $(`#progress-text-${seriesId}`);
  if (fill) fill.style.width = pct + '%';
  if (text) text.textContent = `${seen} / ${total} épisodes vus (${pct}%)`;
}

async function showAddSeriesModal() {
  const title = prompt('Nom de la série à rechercher :');
  if (!title) return;
  toast('Recherche en cours…');
  try {
    const results = await tmdbSearchSeries(title, State.settings.apiKey);
    if (!results.length) { alert('Aucune série trouvée.'); return; }

    // Afficher picker résultats
    const pickerHtml = results.map((s, i) => `
      <div class="series-picker-item" onclick="selectSeriesResult(${i})">
        <img src="${s.poster || ''}" onerror="this.style.display='none'" style="width:50px;height:75px;object-fit:cover;border-radius:6px">
        <div>
          <div style="font-weight:700">${s.name}</div>
          <div style="color:var(--text-dim);font-size:.85rem">${s.year}</div>
        </div>
      </div>`).join('');

    const modal = document.createElement('div');
    modal.id = 'series-picker';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:200;overflow-y:auto;padding:20px';
    modal.innerHTML = `
      <div style="max-width:500px;margin:0 auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h3 style="color:#fff;margin:0">Choisir une série</h3>
          <button onclick="document.getElementById('series-picker').remove()" style="background:none;border:none;color:#fff;font-size:1.5rem;cursor:pointer">✕</button>
        </div>
        <div id="series-picker-results">${pickerHtml}</div>
      </div>`;
    document.body.appendChild(modal);
    window._seriesPickerResults = results;
  } catch(e) {
    alert('Erreur : ' + e.message);
  }
}

async function selectSeriesResult(idx) {
  const s = window._seriesPickerResults[idx];
  document.getElementById('series-picker') && document.getElementById('series-picker').remove();
  toast('Chargement de la série…');
  try {
    const details = await tmdbSeriesDetails(s.tmdbId, State.settings.apiKey);
    addSeries(details);
    toast('✅ ' + details.name + ' ajoutée !');
    renderSeries();
  } catch(e) {
    alert('Erreur : ' + e.message);
  }
}

// ── TMDB Séries (fonctions globales) ─────────────────────────
async function tmdbSearchSeries(title, key) {
  const url = `https://api.themoviedb.org/3/search/tv?api_key=${key}&query=${encodeURIComponent(title)}&language=fr-FR`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('TMDB ' + r.status);
  const j = await r.json();
  return (j.results || []).slice(0, 8).map(s => ({
    id: 'tv_' + s.id,
    tmdbId: s.id,
    name: s.name,
    year: s.first_air_date ? s.first_air_date.slice(0, 4) : '',
    poster: s.poster_path ? `https://image.tmdb.org/t/p/w185${s.poster_path}` : '',
    overview: s.overview || '',
  }));
}

async function tmdbSeriesDetails(tmdbId, key) {
  const url = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${key}&language=fr-FR`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('TMDB ' + r.status);
  const j = await r.json();
  return {
    id: 'tv_' + j.id,
    tmdbId: j.id,
    name: j.name,
    year: j.first_air_date ? j.first_air_date.slice(0, 4) : '',
    poster: j.poster_path ? `https://image.tmdb.org/t/p/w500${j.poster_path}` : '',
    overview: j.overview || '',
    genres: (j.genres || []).map(g => g.name),
    status: j.status || '',
    nbSeasons: j.number_of_seasons || 0,
    nbEpisodes: j.number_of_episodes || 0,
    seasons: (j.seasons || []).filter(s => s.season_number > 0).map(s => ({
      number: s.season_number,
      name: s.name,
      episodeCount: s.episode_count,
      poster: s.poster_path ? `https://image.tmdb.org/t/p/w185${s.poster_path}` : '',
    })),
  };
}

async function tmdbSeasonDetails(tmdbId, seasonNum, key) {
  const url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNum}?api_key=${key}&language=fr-FR`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('TMDB ' + r.status);
  const j = await r.json();
  return (j.episodes || []).map(e => ({
    number: e.episode_number,
    name: e.name,
    overview: e.overview || '',
    airDate: e.air_date || '',
    runtime: e.runtime || 0,
  }));
}

function showSeriesStats() {
  const series = State.series || [];
  const totalSeries = series.length;
  const completed = series.filter(s => s.watchStatus === 'completed').length;
  const watching = series.filter(s => s.watchStatus === 'watching').length;
  const plantowatch = series.filter(s => s.watchStatus === 'plantowatch').length;
  const dropped = series.filter(s => s.watchStatus === 'dropped').length;
  const totalEp = series.reduce((acc, s) => acc + (s.episodesSeen || 0), 0);

  const view = $('[data-view="series"]');
  if (!view) return;
  view.innerHTML = `
    <div style="padding:20px">
      <h2 style="margin-bottom:20px">📊 Mes stats séries</h2>
      <div class="stats-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px">
        <div class="stat-card" style="background:var(--surface);border-radius:16px;padding:16px;text-align:center">
          <div style="font-size:2rem;font-weight:800;color:var(--accent)">${totalSeries}</div>
          <div style="color:var(--text-dim);font-size:.85rem">Séries</div>
        </div>
        <div class="stat-card" style="background:var(--surface);border-radius:16px;padding:16px;text-align:center">
          <div style="font-size:2rem;font-weight:800;color:var(--accent)">${totalEp}</div>
          <div style="color:var(--text-dim);font-size:.85rem">Épisodes vus</div>
        </div>
        <div class="stat-card" style="background:var(--surface);border-radius:16px;padding:16px;text-align:center">
          <div style="font-size:2rem;font-weight:800;color:#22c55e">${completed}</div>
          <div style="color:var(--text-dim);font-size:.85rem">Terminées</div>
        </div>
        <div class="stat-card" style="background:var(--surface);border-radius:16px;padding:16px;text-align:center">
          <div style="font-size:2rem;font-weight:800;color:#3b82f6">${watching}</div>
          <div style="color:var(--text-dim);font-size:.85rem">En cours</div>
        </div>
        <div class="stat-card" style="background:var(--surface);border-radius:16px;padding:16px;text-align:center">
          <div style="font-size:2rem;font-weight:800;color:#f59e0b">${plantowatch}</div>
          <div style="color:var(--text-dim);font-size:.85rem">À voir</div>
        </div>
        <div class="stat-card" style="background:var(--surface);border-radius:16px;padding:16px;text-align:center">
          <div style="font-size:2rem;font-weight:800;color:#ef4444">${dropped}</div>
          <div style="color:var(--text-dim);font-size:.85rem">Abandonnées</div>
        </div>
      </div>
    </div>`;
  view.hidden = false;
  $('#series-grid') && ($('#series-grid').hidden = true);
  $('#series-empty') && ($('#series-empty').hidden = true);
  document.querySelectorAll('#tabbar .tab').forEach(t => t.classList.remove('active'));
  const statsTab = document.querySelector('[data-go="series-stats"]');
  if (statsTab) statsTab.classList.add('active');
}

function switchTabbar(mode) {
  document.querySelectorAll('.tab-films').forEach(t => t.hidden = (mode === 'series'));
  document.querySelectorAll('.tab-series').forEach(t => t.hidden = (mode === 'films'));
  document.querySelectorAll('#tabbar .tab').forEach(t => t.classList.remove('active'));
  if (mode === 'films') {
    const libTab = document.querySelector('[data-go="library"]');
    if (libTab) libTab.classList.add('active');
  } else {
    const seriesTab = document.querySelector('[data-go="series-list"]');
    if (seriesTab) seriesTab.classList.add('active');
  }
}

function showFilms() {
  const btnFilms = $('#toggle-films');
  const btnSeries = $('#toggle-series');
  if (btnFilms) btnFilms.classList.add('active');
  if (btnSeries) btnSeries.classList.remove('active');
  State.mediaMode = 'films';
  switchTabbar('films');
  go('library');
}

function showSeries() {
  // Toggle boutons
  const btnFilms = $('#toggle-films');
  const btnSeries = $('#toggle-series');
  if (btnSeries) btnSeries.classList.add('active');
  if (btnFilms) btnFilms.classList.remove('active');

  // Cacher éléments films
  ['#format-seg','#library-grid','#library-total','#library-empty','#active-filters'].forEach(id => {
    const el = $(id); if (el) el.hidden = true;
  });
  const toolbar = document.querySelector('.toolbar');
  if (toolbar) toolbar.hidden = true;

  // State
  State.mediaMode = 'series';
  State.view = 'series';

  // Afficher vue séries
  $$('.view').forEach(v => v.hidden = true);
  const seriesView = $('[data-view="series"]');
  if (seriesView) {
    seriesView.hidden = false;
    // S'assurer que series-grid et series-empty sont dans la vue
    if (!$('#series-grid')) {
      const grid = document.createElement('div');
      grid.id = 'series-grid';
      seriesView.insertBefore(grid, seriesView.firstChild);
    }
    if (!$('#series-empty')) {
      const empty = document.createElement('div');
      empty.id = 'series-empty';
      empty.className = 'empty-state';
      empty.innerHTML = '<div class="empty-icon">📺</div><p>Aucune série. Ajoutez-en une avec le bouton ＋.</p>';
      seriesView.appendChild(empty);
    }
  }

  // Topbar
  $('#topbar-title').textContent = 'Séries';
  $('#back-btn').hidden = true;
  $('#search-toggle').hidden = true;

  // Tabbar
  switchTabbar('series');

  // Cacher le détail si ouvert
  const detail = $('#series-detail');
  if (detail) detail.hidden = true;
  State.seriesSearch = '';

  renderSeries();
}

function bindMediaToggle() {
  const btnFilms = $('#toggle-films');
  const btnSeries = $('#toggle-series');
  if (btnFilms) btnFilms.addEventListener('click', showFilms);
  if (btnSeries) btnSeries.addEventListener('click', showSeries);
  loadSeries();
}

function renderSeries() {
  const grid = $('#series-grid');
  const empty = $('#series-empty');
  if (!grid) return;
  let series = State.series || [];

  const noAccent = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const q = noAccent(State.seriesSearch || '');
  if (q) series = series.filter(s =>
    noAccent(s.name).includes(q) ||
    noAccent((s.genres||[]).join(' ')).includes(q)
  );

  if (series.length === 0) {
    grid.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  grid.hidden = false;
  grid.className = 'grid' + (State.layout === 'list' ? ' list' : '');

  grid.innerHTML = series.map(s => {
    const seen = s.episodesSeen || 0;
    const total = s.episodesTotal || s.nbEpisodes || 0;
    const pct = total > 0 ? Math.round(seen / total * 100) : 0;
    const poster = s.poster ? `style="background-image:url('${s.poster.replace(/'/g, "%27")}')"` : '';
    const initial = (s.name || '?').charAt(0).toUpperCase();
    if (State.layout === 'list') {
      return `<div class="card" data-id="${s.id}">
        <div class="poster-wrap"><div class="poster" ${poster}>${s.poster ? '' : initial}</div></div>
        <div class="meta">
          <div class="t">${esc(s.name)}</div>
          <div class="sub">${s.year || '—'} · ${s.nbSeasons || '?'} saisons</div>
          <div class="sub" style="color:var(--accent)">${seen}/${total} ép. · ${pct}%</div>
        </div>
      </div>`;
    }
    return `<div class="card" data-id="${s.id}">
      <div class="poster-wrap">
        <div class="poster" ${poster}>${s.poster ? '' : initial}</div>
        <span class="fmt-badge">TV</span>
      </div>
      <div class="meta">
        <div class="t">${esc(s.name)}</div>
        <div class="y">${s.year || ''}</div>
        <div class="series-mini-progress">
          <div class="series-mini-bar" style="width:${pct}%"></div>
        </div>
        <div style="font-size:.75rem;color:var(--accent);font-weight:600">${seen}/${total} ép.</div>
      </div>
    </div>`;
  }).join('');

  $$('.card', grid).forEach(c =>
    c.addEventListener('click', () => openSeriesDetail(c.dataset.id)));
}

function bindLogin() {
  const showErr = (msg) => {
    const err = $('#login-error');
    if (err) { err.textContent = msg; err.hidden = false; }
  };
  const hideErr = () => { const err = $('#login-error'); if (err) err.hidden = true; };

  const btnG = $('#login-google-btn');
  if (btnG) btnG.addEventListener('click', async () => {
    hideErr();
    try { await Cloud.signInGoogle(); }
    catch (e) { console.warn(e); showErr('Connexion Google échouée. Réessayez.'); }
  });

  const btnA = $('#login-apple-btn');
  if (btnA) btnA.addEventListener('click', async () => {
    hideErr();
    try { await Cloud.signInApple(); }
    catch (e) { console.warn(e); showErr('Connexion Apple échouée. Réessayez.'); }
  });

  const btnSkip = $('#login-skip-btn');
  if (btnSkip) btnSkip.addEventListener('click', () => {
    showLogin(false);
    go('library');
  });
}

/* Appelé à chaque changement d'état de connexion Google. */
let _firstAuth = true;
async function onAuthChanged(user) {
  if (user) {
    // Connecté : on masque le login, on charge la liste du compte
    showLogin(false);
    State.movies = await Store.allMovies();
    go('library');
    renderProfile();
    try {
      await syncCloud();
      renderLibrary();
    } catch (e) { console.warn('sync après login:', e); }
  } else {
    // Pas (ou plus) connecté : on vide l'affichage local et on montre le login
    if (!_firstAuth) {
      State.movies = [];
      await Store.clearMovies();
    }
    showLogin(true);
  }
  _firstAuth = false;
}

/* Fusion locale <-> distante. Stratégie simple : union par id, le
   plus récemment modifié gagne (champ addedAt/at faute de updatedAt).
   Pour un test c'est suffisant ; un vrai merge viendra côté Flutter. */
async function syncCloud() {
  if (!Cloud.enabled()) return;
  const remote = await Cloud.pullAll();
  const localById = new Map(State.movies.map(m => [m.id, m]));
  const remoteById = new Map(remote.map(m => [m.id, m]));

  // Distant -> local (ajoute ce qui manque localement)
  for (const r of remote) {
    if (!localById.has(r.id)) {
      await Store.putMovie(r);
      localById.set(r.id, r);
    }
  }
  // Local -> distant (pousse ce qui manque à distance)
  for (const l of State.movies) {
    if (!remoteById.has(l.id)) {
      await Cloud.pushMovie(l).catch(() => {});
    }
  }
  State.movies = await Store.allMovies();
}

/* Connexion / déconnexion Google depuis le profil */
async function cloudSignIn() {
  if (!Cloud.configured()) {
    alert('Sync cloud non configurée (FIREBASE_CONFIG manquant dans app.js).');
    return;
  }
  try {
    toast('Connexion Google…');
    await Cloud.signInGoogle();
    // onAuthChanged fait le reste (sync + affichage)
  } catch (e) {
    console.warn(e);
    toast('Connexion annulée ou échouée');
  }
}

async function cloudSignOut() {
  if (confirm('Se déconnecter ?')) {
    try {
      // Déconnexion plugin natif si disponible
      if (window.IS_NATIVE_APP && window.Capacitor && window.Capacitor.Plugins.FirebaseAuthentication) {
        await window.Capacitor.Plugins.FirebaseAuthentication.signOut();
      }
      await Cloud.signOut();
      State.movies = [];
      showLogin(true);
    } catch (e) { toast('Erreur déconnexion'); }
  }
}

function bindEvents() {
  // Tabs
  $$('.tab[data-go]').forEach(t => t.addEventListener('click', () => go(t.dataset.go)));
  $('#add-tab').addEventListener('click', () => {
    if (State.mediaMode === 'series') showAddSeriesModal();
    else startImportFlow();
  });

  // Topbar
  $('#back-btn').addEventListener('click', () => {
    const m = State.movies.find(x => x.id === State.currentId);
    go(m && m.wishlist ? 'wishlist' : 'library');
  });
  $('#search-toggle').addEventListener('click', () => {
    const sb = $('#searchbar'); sb.hidden = !sb.hidden;
    if (!sb.hidden) $('#search-input').focus();
  });
  $('#search-input').addEventListener('input', (e) => {
    State.search = e.target.value; renderLibrary();
  });

  // Toolbar
  $$('#layout-seg button').forEach(b => b.addEventListener('click', () => {
    State.layout = b.dataset.layout;
    $$('#layout-seg button').forEach(x => x.classList.toggle('active', x === b));
    renderLibrary();
  }));
  $$('#format-seg button').forEach(b => b.addEventListener('click', () => {
    State.formatFilter = b.dataset.fmt;
    $$('#format-seg button').forEach(x => x.classList.toggle('active', x === b));
    renderLibrary();
  }));
  $('#sort-select').addEventListener('change', (e) => { State.sort = e.target.value; renderLibrary(); });
  $('#filter-btn').addEventListener('click', openFilters);

  // Add sheet
  $('#sheet-backdrop').addEventListener('click', closeSheet);
  $('#act-cancel').addEventListener('click', closeSheet);
  $('#act-import').addEventListener('click', () => {
    if (State.mediaMode === 'series') showAddSeriesModal();
    else startImportFlow();
  });
  $('[data-action="add"]')?.addEventListener('click', () => {
    if (State.mediaMode === 'series') showAddSeriesModal();
    else startImportFlow();
  });

  // Scanner
  $('#scanner-close').addEventListener('click', () => Scanner.stop());

  // Edit backdrop
  $('#edit-backdrop').addEventListener('click', closeEditor);

  // Random
  $('#random-go').addEventListener('click', spinRandom);
  $('#random-open').addEventListener('click', () => randomPick && openDetail(randomPick.id));

  // Profile
  $('#set-pdf').addEventListener('click', () => {
    const withPrice = confirm("Inclure les prix d'achat et le total dans le PDF ?\n\nOK = avec les prix\nAnnuler = sans les prix");
    exportPDF('library', withPrice);
  });
  $('#set-pdf-wish').addEventListener('click', () => exportPDF('wishlist', false));
  $('#set-theme').addEventListener('click', toggleTheme);
  $('#set-cloud').addEventListener('click', () => {
    const fbUser = (Cloud.user && Cloud.user()) || (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser);
    if (fbUser) cloudSignOut();
    else cloudSignIn();
  });
  $('#set-wipe').addEventListener('click', async () => {
    if (!confirm('Vider toute la collection ? Action irréversible.')) return;
    await Store.clearMovies(); State.movies = []; toast('Collection vidée'); go('library');
  });
}

/* ---- Données d'exemple ---- */
async function seedDemo() {
  const demo = [
    { title: 'Le Voyage', year: '2021', genre: 'Drame', format: 'Blu-ray', rating: 4,
      director: 'A. Martin', actors: 'J. Dupont, M. Leroy', duration: 118,
      synopsis: 'Un road-trip introspectif à travers les Alpes.' },
    { title: 'Nébuleuse', year: '2019', genre: 'Science-Fiction', format: '4K', rating: 5,
      director: 'C. Nolan', actors: 'E. Stone', duration: 142,
      synopsis: 'Une expédition spatiale aux confins du système solaire.' },
    { title: 'Comédie de Quartier', year: '2015', genre: 'Comédie', format: 'DVD', rating: 3,
      director: 'P. Durand', actors: 'L. Bernard', duration: 95, synopsis: '' },
  ];
  for (const d of demo) {
    const m = { id: uid(), addedAt: Date.now() - Math.random()*1e9,
      audio: [], textComments: [], poster: '', ...d };
    await Store.putMovie(m);
  }
  State.movies = await Store.allMovies();
}

document.addEventListener('DOMContentLoaded', boot);
