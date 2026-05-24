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
  movies: [],          // cache mémoire de la collection
  view: 'library',
  layout: 'grid',
  sort: 'title',
  filters: {},         // {genre, year, format, rating}
  search: '',
  currentId: null,     // film ouvert en détail
  settings: { theme: 'dark', apiProvider: 'tmdb', apiKey: '' },
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

function fmtDuration(min) {
  if (!min) return '—';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
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
     Un vrai lookup EAN→film nécessite une API dédiée (ex. barcodelookup,
     ou une base type Discogs/UPCitemdb) puis re-recherche par titre.
     Ici on tente UPCitemdb (gratuit, limité) pour obtenir un libellé,
     puis on cherche le film par ce libellé. À défaut → fiche manuelle. */
  async function searchByBarcode(ean) {
    try {
      const r = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${ean}`);
      const j = await r.json();
      const item = j.items && j.items[0];
      if (item && item.title) {
        const cleaned = item.title.replace(/\b(dvd|blu-?ray|4k|uhd|edition|steelbook)\b/gi, '').trim();
        const film = await searchByTitle(cleaned);
        if (film) return { ...film, barcode: ean };
        return blankFromBarcode(ean, cleaned);
      }
    } catch (e) { /* réseau / quota → on retombe sur la saisie */ }
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

  function blankFromBarcode(ean, guessTitle) {
    return {
      title: guessTitle || '', originalTitle: '', year: '', synopsis: '',
      genre: '', director: '', actors: '', duration: 0, poster: '', barcode: ean,
    };
  }

  return { searchByBarcode, searchByTitle, blankFromBarcode };
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
  apiKey:            "TON_API_KEY",
  authDomain:        "TON_PROJET.firebaseapp.com",
  projectId:         "TON_PROJET",
  storageBucket:     "TON_PROJET.firebasestorage.app",
  messagingSenderId: "TON_SENDER_ID",
  appId:             "TON_APP_ID",
};
// ⬆️⬆️⬆️  REMPLACE CES VALEURS PAR TA CONFIG FIREBASE  ⬆️⬆️⬆️

const Cloud = (() => {
  let db = null, auth = null, uid = null, ready = false;

  // Détecte si la config a bien été remplie (sinon on reste local)
  function configured() {
    return typeof firebase !== 'undefined'
      && FIREBASE_CONFIG.projectId
      && FIREBASE_CONFIG.projectId !== 'TON_PROJET';
  }

  function enabled() { return ready && !!uid; }

  // Initialise Firebase + auth anonyme. Résout quand l'uid est prêt
  // (fix race condition : on n'utilise jamais uid avant ce point).
  async function init() {
    if (!configured()) return false;
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db   = firebase.firestore();

    await auth.signInAnonymously();
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('Auth timeout')), 15000);
      auth.onAuthStateChanged((user) => {
        if (user) { uid = user.uid; ready = true; clearTimeout(to); res(); }
      });
    });
    return true;
  }

  function moviesCol() {
    return db.collection('users').doc(uid).collection('movies');
  }

  // Limite Firestore = 1 Mo / document
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

  return { init, configured, enabled, pushMovie, deleteRemote, pullAll, pushAll, uid: () => uid };
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
   5b. OCR — reconnaissance du titre sur jaquette (Tesseract.js)
   Chargé à la demande depuis jsDelivr (v5, global "Tesseract").
   Renvoie une liste de lignes candidates triées par taille de
   texte (les plus grosses = plus probablement le titre).
   L'utilisateur choisit/corrige avant la recherche TMDB.
   ============================================================ */
const OCR = (() => {
  const TESS_VER = '5';
  const TESS_SRC = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VER}/dist/tesseract.min.js`;
  let worker = null;

  function loadLib() {
    if (window.Tesseract) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = TESS_SRC;
      s.onload = res;
      s.onerror = () => rej(new Error('Chargement Tesseract impossible (réseau ?)'));
      document.head.appendChild(s);
    });
  }

  // image = dataURL, Blob, canvas… (tout ce qu'accepte Tesseract)
  // onProgress = callback(0..1) pour la barre de progression
  async function recognize(image, onProgress) {
    await loadLib();
    if (!worker) {
      worker = await window.Tesseract.createWorker('fra+eng', 1, {
        logger: (m) => {
          if (m.status === 'recognizing text' && onProgress) onProgress(m.progress);
        },
      });
    }
    const { data } = await worker.recognize(image);
    return extractCandidates(data);
  }

  // Trie les lignes par hauteur de bbox décroissante (titre = gros texte),
  // nettoie le bruit (lignes trop courtes, mentions légales en majuscules longues).
  function extractCandidates(data) {
    const lines = (data.lines || [])
      .map(l => {
        const bbox = l.bbox || {};
        const h = (bbox.y1 || 0) - (bbox.y0 || 0);
        const text = (l.text || '').replace(/\s+/g, ' ').trim();
        return { text, h, conf: l.confidence || 0 };
      })
      .filter(l => l.text.length >= 2 && /[a-zA-ZÀ-ÿ0-9]/.test(l.text))
      .filter(l => !/^(dvd|blu-?ray|4k uhd|tous droits|all rights)/i.test(l.text));

    // Score = hauteur de texte pondérée par la confiance OCR
    lines.sort((a, b) => (b.h * (b.conf / 100 + 0.5)) - (a.h * (a.conf / 100 + 0.5)));
    // Dédoublonne et garde le top 6
    const seen = new Set(), out = [];
    for (const l of lines) {
      const k = l.text.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k); out.push(l.text);
      if (out.length >= 6) break;
    }
    // Texte brut complet en dernier recours
    return { candidates: out, rawText: (data.text || '').trim() };
  }

  async function terminate() {
    if (worker) { await worker.terminate(); worker = null; }
  }

  return { recognize, terminate };
})();

/* ============================================================
   6. UI / ROUTER / RENDU
   ============================================================ */

/* ---- Navigation entre vues ---- */
function go(view, opts = {}) {
  State.view = view;
  $$('.view').forEach(v => (v.hidden = v.dataset.view !== view));
  $$('.tab[data-go]').forEach(t => t.classList.toggle('active', t.dataset.go === view));

  const titles = { library: 'DVDthèque', random: 'Aléatoire', profile: 'Profil', detail: '' };
  $('#topbar-title').textContent = opts.title || titles[view] || '';
  $('#back-btn').hidden = view !== 'detail';
  $('#search-toggle').hidden = view !== 'library';
  if (view !== 'library') { $('#searchbar').hidden = true; }

  if (view === 'library') renderLibrary();
  if (view === 'random') renderRandomView();
  if (view === 'profile') renderProfile();
  $('#views').scrollTop = 0;
}

/* ---- Filtre + tri appliqués à la collection ---- */
function visibleMovies() {
  let list = [...State.movies];
  const f = State.filters, s = State.search.toLowerCase().trim();

  if (s) list = list.filter(m =>
    (m.title || '').toLowerCase().includes(s) ||
    (m.director || '').toLowerCase().includes(s) ||
    (m.actors || '').toLowerCase().includes(s));
  if (f.genre)  list = list.filter(m => m.genre === f.genre);
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
  $('#library-empty').hidden = State.movies.length !== 0;
  grid.className = 'grid' + (State.layout === 'list' ? ' list' : '');

  grid.innerHTML = list.map(m => {
    const poster = m.poster
      ? `style="background-image:url('${m.poster.replace(/'/g, "%27")}')"` : '';
    const initial = (m.title || '?').charAt(0).toUpperCase();
    if (State.layout === 'list') {
      return `<div class="card" data-id="${m.id}">
        <div class="poster-wrap"><div class="poster" ${poster}>${m.poster ? '' : initial}</div></div>
        <div class="meta">
          <div class="t">${esc(m.title)}</div>
          <div class="sub">${m.year || '—'} · ${esc(m.genre || '')} · ${m.format || 'DVD'}</div>
          <div class="sub">${'★'.repeat(m.rating||0)}${'☆'.repeat(5-(m.rating||0))}</div>
        </div></div>`;
    }
    return `<div class="card" data-id="${m.id}">
      <div class="poster-wrap">
        <div class="poster" ${poster}>${m.poster ? '' : initial}</div>
        <span class="fmt-badge">${m.format || 'DVD'}</span>
      </div>
      <div class="meta"><div class="t">${esc(m.title)}</div><div class="y">${m.year || ''}</div></div>
    </div>`;
  }).join('');

  $$('.card', grid).forEach(c =>
    c.addEventListener('click', () => openDetail(c.dataset.id)));

  renderActiveFilters();
}

function renderActiveFilters() {
  const box = $('#active-filters'); const f = State.filters;
  const chips = [];
  if (f.genre)  chips.push(['Genre', f.genre, 'genre']);
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
      <div class="rating-stars" id="rating-edit">${[1,2,3,4,5].map(i =>
        `<span data-v="${i}" class="${i <= (m.rating||0) ? 'on' : ''}">★</span>`).join('')}</div>
    </div>

    ${m.synopsis ? `<div class="detail-section"><h4>Synopsis</h4><p>${esc(m.synopsis)}</p></div>` : ''}

    <div class="detail-section">
      <h4>Fiche technique</h4>
      <div class="info-grid">
        <div><div class="lbl">Réalisateur</div><div class="val">${esc(m.director) || '—'}</div></div>
        <div><div class="lbl">Acteurs</div><div class="val">${esc(m.actors) || '—'}</div></div>
        <div><div class="lbl">Durée</div><div class="val">${fmtDuration(m.duration)}</div></div>
        <div><div class="lbl">Code-barres</div><div class="val">${m.barcode || '—'}</div></div>
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
    </div>

    <div class="detail-actions">
      <button class="btn-secondary" id="detail-edit">Modifier</button>
      <button class="btn-secondary" id="detail-share">Partager</button>
      <button class="btn-secondary" id="detail-delete" style="color:var(--accent)">Supprimer</button>
    </div>
  `;

  // Note
  $$('#rating-edit span').forEach(s => s.addEventListener('click', async () => {
    m.rating = +s.dataset.v; await Store.putMovie(m);
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
  $('#detail-edit').addEventListener('click', () => openEditor(m, true));
  $('#detail-share').addEventListener('click', () => shareMovie(m));
  $('#detail-delete').addEventListener('click', async () => {
    if (!confirm('Supprimer ce film de la collection ?')) return;
    await Store.delMovie(m.id);
    if (Cloud.enabled()) Cloud.deleteRemote(m.id).catch(() => {});
    State.movies = State.movies.filter(x => x.id !== m.id);
    toast('Film supprimé'); go('library');
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
  gsel.innerHTML = '<option value="">Tous genres</option>' +
    [...new Set(State.movies.map(m => m.genre).filter(Boolean))].sort()
      .map(g => `<option>${esc(g)}</option>`).join('');
}

let randomPick = null;
function spinRandom() {
  const genre = $('#random-genre').value;
  const minR = +$('#random-rating').value;
  let pool = State.movies.filter(m => (!genre || m.genre === genre) && (m.rating || 0) >= minR);
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
}

/* ---- Éditeur de fiche (ajout/modif manuels) ---- */
function openEditor(data, isEdit = false) {
  closeSheet();
  const m = isEdit ? data : {
    id: uid(), addedAt: Date.now(), format: 'DVD', rating: 0,
    audio: [], textComments: [], ...data,
  };
  $('#edit-title-h').textContent = isEdit ? 'Modifier' : 'Nouveau film';
  $('#edit-form').innerHTML = `
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
    ${field('director', 'Réalisateur', m.director)}
    ${field('actors', 'Acteurs', m.actors)}
    ${field('duration', 'Durée (min)', m.duration, 'number')}
    ${field('poster', 'URL jaquette', m.poster)}
    <div class="field"><label>Synopsis</label><textarea id="f-synopsis">${esc(m.synopsis||'')}</textarea></div>
    ${field('barcode', 'Code-barres', m.barcode)}
  `;
  $('#edit-modal').hidden = false; $('#edit-backdrop').hidden = false;

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
    await Store.putMovie(m);
    if (!isEdit) State.movies.push(m);
    if (Cloud.enabled()) Cloud.pushMovie(m).catch(() => {});
    closeEditor();
    toast(isEdit ? 'Film modifié' : 'Film ajouté');
    isEdit ? renderDetail(m) : go('library');
  };
  $('#edit-cancel').onclick = closeEditor;
}
function field(key, label, val, type = 'text') {
  return `<div class="field"><label>${label}</label>
    <input id="f-${key}" type="${type}" value="${esc(val ?? '')}" /></div>`;
}
function closeEditor() { $('#edit-modal').hidden = true; $('#edit-backdrop').hidden = true; }

/* ---- Partage ---- */
async function shareMovie(m) {
  const txt = `🎬 ${m.title} (${m.year})\n${m.genre} · ${m.format}\nNote : ${'★'.repeat(m.rating||0)}\n${m.synopsis || ''}`;
  if (navigator.share) {
    try { await navigator.share({ title: m.title, text: txt }); } catch (e) {}
  } else {
    await navigator.clipboard?.writeText(txt);
    toast('Copié dans le presse-papier');
  }
}

/* ---- Add sheet ---- */
function openSheet()  { $('#add-sheet').hidden = false; $('#sheet-backdrop').hidden = false; }
function closeSheet() { $('#add-sheet').hidden = true;  $('#sheet-backdrop').hidden = true; }

/* ---- Flux d'ajout par scan ---- */
async function startScanFlow() {
  closeSheet();
  Scanner.start(async (ean) => {
    toast('Code détecté : ' + ean);
    const film = await MovieAPI.searchByBarcode(ean);
    openEditor(film); // pré-rempli (ou vierge si lookup échoue), l'utilisateur valide
  });
}

/* ---- Flux d'ajout par photo de jaquette (OCR) ---- */
function startPhotoFlow() {
  closeSheet();
  // input fichier avec capture caméra arrière sur mobile
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const dataURL = await fileToDataURL(file);
    runOCR(dataURL);
  };
  input.click();
}

function fileToDataURL(file) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(file);
  });
}

async function runOCR(dataURL) {
  showOcrModal();
  setOcrState('progress', { pct: 0 });
  try {
    const { candidates, rawText } = await OCR.recognize(dataURL, (p) => {
      setOcrState('progress', { pct: Math.round(p * 100) });
    });
    if (!candidates.length) {
      setOcrState('empty', { rawText });
    } else {
      setOcrState('choose', { candidates, dataURL });
    }
  } catch (e) {
    toast(e.message || 'OCR échoué');
    closeOcrModal();
    openEditor({}); // repli saisie manuelle
  }
}

/* Recherche le titre choisi sur TMDB puis ouvre l'éditeur pré-rempli */
async function ocrSearchTitle(title) {
  closeOcrModal();
  toast('Recherche : ' + title);
  const film = await MovieAPI.searchByTitle(title);
  if (film) openEditor({ ...film });
  else openEditor(MovieAPI.blankFromBarcode('', title)); // au moins le titre pré-rempli
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
  if (state === 'progress') {
    modal.innerHTML = `
      <div class="modal-head">
        <span></span><strong>Lecture de la jaquette…</strong>
        <button class="btn-ghost" id="ocr-cancel" style="width:auto">Annuler</button>
      </div>
      <div class="modal-body" style="text-align:center;padding-top:40px">
        <div class="ocr-spinner">🔍</div>
        <p class="muted">Analyse du texte… ${data.pct || 0}%</p>
        <div class="ocr-bar"><div class="ocr-bar-fill" style="width:${data.pct||0}%"></div></div>
        <p class="muted small" style="margin-top:20px">Le moteur OCR (~2 Mo) se charge au premier usage.</p>
      </div>`;
  } else if (state === 'choose') {
    modal.innerHTML = `
      <div class="modal-head">
        <button class="btn-ghost" id="ocr-cancel" style="width:auto">Annuler</button>
        <strong>Quel est le titre ?</strong>
        <button class="btn-link" id="ocr-manual2">Manuel</button>
      </div>
      <div class="modal-body">
        <p class="muted small">Texte détecté sur la jaquette. Touchez le titre du film :</p>
        <div class="ocr-candidates">
          ${data.candidates.map(c =>
            `<button class="ocr-cand" data-t="${esc(c)}">${esc(c)}</button>`).join('')}
        </div>
        <div class="field" style="margin-top:16px">
          <label>Ou corrigez / saisissez le titre</label>
          <input id="ocr-edit-title" type="text" placeholder="Titre du film" />
        </div>
        <button class="btn-primary" id="ocr-search-btn">Rechercher ce film</button>
      </div>`;
    $$('.ocr-cand', modal).forEach(b =>
      b.addEventListener('click', () => ocrSearchTitle(b.dataset.t)));
    $('#ocr-search-btn').addEventListener('click', () => {
      const v = $('#ocr-edit-title').value.trim();
      if (v) ocrSearchTitle(v);
    });
    $('#ocr-manual2').addEventListener('click', () => { closeOcrModal(); openEditor({}); });
  } else if (state === 'empty') {
    modal.innerHTML = `
      <div class="modal-head">
        <button class="btn-ghost" id="ocr-cancel" style="width:auto">Annuler</button>
        <strong>Aucun titre lisible</strong><span></span>
      </div>
      <div class="modal-body">
        <p class="muted">Le texte n'a pas pu être lu de façon fiable. Vous pouvez saisir le titre manuellement.</p>
        <div class="field" style="margin-top:12px">
          <input id="ocr-edit-title" type="text" placeholder="Titre du film" />
        </div>
        <button class="btn-primary" id="ocr-search-btn">Rechercher</button>
        <button class="btn-ghost" id="ocr-manual2" style="margin-top:8px">Saisie complète manuelle</button>
      </div>`;
    $('#ocr-search-btn').addEventListener('click', () => {
      const v = $('#ocr-edit-title').value.trim();
      if (v) ocrSearchTitle(v);
    });
    $('#ocr-manual2').addEventListener('click', () => { closeOcrModal(); openEditor({}); });
  }
  const cancel = $('#ocr-cancel');
  if (cancel) cancel.addEventListener('click', closeOcrModal);
}

/* ---- Filtres (prompt simple, pas de lib) ---- */
function openFilters() {
  const genre = prompt('Filtrer par genre (vide = tous) :\n' + GENRES.join(', '), State.filters.genre || '');
  if (genre !== null) {
    if (genre.trim()) State.filters.genre = genre.trim(); else delete State.filters.genre;
    renderLibrary();
  }
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
   7. BOOTSTRAP
   ============================================================ */
async function boot() {
  await Store.init();

  const saved = await Store.getKV('settings');
  if (saved) State.settings = { ...State.settings, ...saved };
  applyTheme();

  State.movies = await Store.allMovies();
  if (!State.movies.length) await seedDemo();

  bindEvents();
  go('library');

  // Service worker (offline)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Sync cloud : init automatique si FIREBASE_CONFIG est renseigné
  if (Cloud.configured()) {
    try {
      await Cloud.init();
      await syncCloud();      // fusion silencieuse au démarrage
      renderLibrary();
    } catch (e) { console.warn('Cloud init:', e); }
  }
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

/* Bouton « Sync cloud » du profil : affiche le statut et permet de
   resynchroniser. La config est en dur dans FIREBASE_CONFIG (app.js). */
async function configureCloud() {
  if (!Cloud.configured()) {
    alert('Sync cloud non configurée.\n\nOuvre app.js et remplace les valeurs de FIREBASE_CONFIG par celles de ton projet Firebase (console → ⚙️ Paramètres → Vos applications → icône </>). Puis recharge la page.');
    return;
  }
  if (Cloud.enabled()) {
    if (confirm('Sync cloud active ✅\n\nOK = resynchroniser maintenant.')) {
      toast('Synchronisation…');
      try { await syncCloud(); renderLibrary(); toast('Sync terminée'); }
      catch (e) { toast('Erreur sync : ' + (e.message || '')); }
    }
    return;
  }
  // Configuré mais pas encore connecté (ex. échec auth) : on retente
  toast('Connexion à Firebase…');
  try {
    await Cloud.init();
    await syncCloud();
    renderLibrary();
    toast('Sync cloud activée');
  } catch (e) {
    console.warn(e);
    toast('Échec Firebase : ' + (e.message || '') + ' — vérifie Auth anonyme');
  }
}

function bindEvents() {
  // Tabs
  $$('.tab[data-go]').forEach(t => t.addEventListener('click', () => go(t.dataset.go)));
  $('#add-tab').addEventListener('click', openSheet);

  // Topbar
  $('#back-btn').addEventListener('click', () => go('library'));
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
  $('#sort-select').addEventListener('change', (e) => { State.sort = e.target.value; renderLibrary(); });
  $('#filter-btn').addEventListener('click', openFilters);

  // Add sheet
  $('#sheet-backdrop').addEventListener('click', closeSheet);
  $('#act-cancel').addEventListener('click', closeSheet);
  $('#act-manual').addEventListener('click', () => { closeSheet(); openEditor({}); });
  $('#act-scan').addEventListener('click', startScanFlow);
  $('#act-photo').addEventListener('click', startPhotoFlow);
  $('[data-action="add"]')?.addEventListener('click', openSheet);

  // Scanner
  $('#scanner-close').addEventListener('click', () => Scanner.stop());

  // Edit backdrop
  $('#edit-backdrop').addEventListener('click', closeEditor);

  // Random
  $('#random-go').addEventListener('click', spinRandom);
  $('#random-open').addEventListener('click', () => randomPick && openDetail(randomPick.id));

  // Profile
  $('#set-export').addEventListener('click', exportJSON);
  $('#set-import').addEventListener('click', importJSON);
  $('#set-theme').addEventListener('click', toggleTheme);
  $('#set-api').addEventListener('click', configureAPI);
  $('#set-cloud').addEventListener('click', configureCloud);
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
