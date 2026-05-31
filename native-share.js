// Module natif — login Firebase iOS (skipNativeAuth: true)
(function () {
  var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  window.IS_NATIVE_APP = isNative;
  if (!isNative) return;

  var FA = window.Capacitor.Plugins.FirebaseAuthentication;
  if (!FA) { console.error('[Auth] FirebaseAuthentication plugin introuvable'); return; }

  function patchCloud() {
    if (typeof Cloud === 'undefined' || typeof firebase === 'undefined') {
      return setTimeout(patchCloud, 200);
    }

    Cloud.signInGoogle = async function () {
      try {
        var result = await FA.signInWithGoogle();
        if (!result.credential || !result.credential.idToken) throw new Error('Pas de idToken Google');
        var cred = firebase.auth.GoogleAuthProvider.credential(result.credential.idToken);
        await firebase.auth().signInWithCredential(cred);
        console.log('[Auth] Google OK');
      } catch (e) {
        console.error('[Auth] Google erreur', e);
        if (e.message && e.message.toLowerCase().indexOf('cancel') >= 0) return;
        alert('Connexion Google : ' + (e.message || e));
        throw e;
      }
    };

    Cloud.signInApple = async function () {
      try {
        // skipNativeAuth:true → le plugin gère le nonce en interne, on récupère juste le credential
        var result = await FA.signInWithApple();
        console.log('[Auth] Apple result', JSON.stringify(result.credential));
        if (!result.credential || !result.credential.idToken) throw new Error('Pas de idToken Apple');
        var provider = new firebase.auth.OAuthProvider('apple.com');
        // Utiliser le nonce retourné par le plugin tel quel
        var credOptions = { idToken: result.credential.idToken };
        if (result.credential.nonce) credOptions.rawNonce = result.credential.nonce;
        if (result.credential.rawNonce) credOptions.rawNonce = result.credential.rawNonce;
        var cred = provider.credential(credOptions);
        await firebase.auth().signInWithCredential(cred);
        console.log('[Auth] Apple OK');
      } catch (e) {
        console.error('[Auth] Apple erreur', e);
        if (e.message && e.message.toLowerCase().indexOf('cancel') >= 0) return;
        alert('Connexion Apple : ' + (e.message || e));
        throw e;
      }
    };

    var origSignOut = Cloud.signOut;
    Cloud.signOut = async function () {
      try { await FA.signOut(); } catch (e) {}
      if (origSignOut) return origSignOut();
    };

    console.log('[Auth] Cloud patché (skipNativeAuth: true)');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', patchCloud);
  } else {
    patchCloud();
  }
})();

// --- AdMob : bannière + interstitielle ---
(function () {
  if (!window.IS_NATIVE_APP) return;

  const BANNER_ID = 'ca-app-pub-7090581291853912/4930609655';
  const INTER_ID  = 'ca-app-pub-7090581291853912/7003754596';

  let interLoaded = false;
  let filmsAddedSinceLoad = 0;
  let sessionCount = parseInt(localStorage.getItem('_admob_sessions') || '0') + 1;
  localStorage.setItem('_admob_sessions', sessionCount);

  async function initAdMob() {
    try {
      const { AdMob } = await import('https://esm.sh/@capacitor-community/admob@8.0.0');

      // Initialiser AdMob (sans ATT pour l'instant — on l'ajoutera avant soumission)
      await AdMob.initialize({ requestTrackingAuthorization: true });

      // Bannière en bas, permanente
      await AdMob.showBanner({
        adId: BANNER_ID,
        adSize: 'BANNER',
        position: 'BOTTOM_CENTER',
        margin: 60, // au-dessus de la tabbar
        isTesting: false,
      });

      console.log('[AdMob] Bannière affichée');

      // Précharger l'interstitielle
      loadInter(AdMob);

      // Interstitielle après 10 films ajoutés
      window._admobOnFilmAdded = function() {
        filmsAddedSinceLoad++;
        if (filmsAddedSinceLoad >= 10 && interLoaded) {
          filmsAddedSinceLoad = 0;
          showInter(AdMob);
        }
      };

      // Interstitielle avant export PDF
      window._admobOnPdfExport = function() {
        if (interLoaded) showInter(AdMob);
      };

      // Interstitielle à la 3e session et toutes les 3 sessions
      if (sessionCount % 3 === 0 && interLoaded) {
        setTimeout(() => showInter(AdMob), 3000);
      }

    } catch (e) {
      console.warn('[AdMob] init erreur', e);
    }
  }

  async function loadInter(AdMob) {
    try {
      await AdMob.prepareInterstitial({ adId: INTER_ID, isTesting: false });
      interLoaded = true;
      console.log('[AdMob] Interstitielle prête');
    } catch (e) {
      console.warn('[AdMob] interstitielle load erreur', e);
    }
  }

  async function showInter(AdMob) {
    try {
      interLoaded = false;
      await AdMob.showInterstitial();
      // Recharger pour la prochaine fois
      setTimeout(() => loadInter(AdMob), 1000);
    } catch (e) {
      console.warn('[AdMob] interstitielle show erreur', e);
    }
  }

  // Attendre que l'app soit chargée
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAdMob);
  } else {
    setTimeout(initAdMob, 1500);
  }
})();
