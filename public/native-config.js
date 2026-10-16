/* Chargé avant urgad-store.js. Sur le web (Render), same-origin : ne rien forcer.
   Dans l’app Capacitor, l’origine n’est pas l’API : on pointe vers la prod. */
(function () {
  var native = false;
  try {
    native = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  } catch (e) {}
  if (!native) return;
  if (!window.URGAD_API) window.URGAD_API = 'https://urgad-api.onrender.com';
  if (typeof window.URGAD_NATIVE_PUSH === 'undefined') window.URGAD_NATIVE_PUSH = false;
})();
