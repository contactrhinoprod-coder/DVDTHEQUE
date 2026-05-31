cd ~/Desktop/dvdtheque-app/www

python3 << 'PYEOF'
with open('app.js', 'r') as f:
    content = f.read()

old = """  // Connexion via Google (popup)
  async function signInGoogle() {
    if (!auth) return;
    const provider = new firebase.auth.GoogleAuthProvider();
    await auth.signInWithPopup(provider);
    // onAuthStateChanged se charge de la suite
  }"""

new = """  function isNative() {
    return window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
  }

  async function signInGoogle() {
    if (!auth) return;
    if (isNative()) {
      const { FirebaseAuthentication } = await import('https://esm.sh/@capacitor-firebase/authentication@8.2.0');
      const result = await FirebaseAuthentication.signInWithGoogle();
      const credential = firebase.auth.GoogleAuthProvider.credential(result.credential?.idToken);
      await auth.signInWithCredential(credential);
    } else {
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
  }

  async function signInApple() {
    if (!auth) return;
    if (isNative()) {
      const { FirebaseAuthentication } = await import('https://esm.sh/@capacitor-firebase/authentication@8.2.0');
      const result = await FirebaseAuthentication.signInWithApple();
      const provider = new firebase.auth.OAuthProvider('apple.com');
      const credential = provider.credential({ idToken: result.credential?.idToken, rawNonce: result.credential?.nonce });
      await auth.signInWithCredential(credential);
    } else {
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
  }"""

if old in content:
    content = content.replace(old, new)
    with open('app.js', 'w') as f:
        f.write(content)
    print("✅ signInGoogle + signInApple patchés")
else:
    print("❌ texte non trouvé - vérifier")
PYEOF
