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
