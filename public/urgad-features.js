/* URGAD — fonctions partagées : notifications (badge, sondage 30 s, navigateur, push natif),
   carte des missions (Leaflet + fond MapLibre OpenFreeMap), liens légaux, droits RGPD.
   Dépend de urgad-store.js (window.UrgadApi). */
(function(){
  var A = function(){ return window.UrgadApi; };
  var POLL_MS = 30000;

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function timeAgo(iso){
    if (!iso) return '';
    var d = new Date(String(iso).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(iso)) ? '' : 'Z'));
    if (isNaN(d.getTime())) return String(iso);
    var s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 60) return "à l'instant";
    if (s < 3600) return 'il y a ' + Math.floor(s / 60) + ' min';
    if (s < 86400) return 'il y a ' + Math.floor(s / 3600) + ' h';
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  var ICONS = { new_mission: '📍', application_received: '👤', application_accepted: '✅', application_rejected: '❌', new_message: '💬',
    verification_approved: '✅', verification_rejected: '⚠️', establishment_approved: '✅', establishment_rejected: '⚠️',
    document_approved: '📄', document_rejected: '📄', admin_new_pro: '🆕', admin_new_establishment: '🏢', admin_document: '📄',
    welcome: '👋', password_changed: '🔑', admin_password_reset: '🔑',
    subscription_paid: '💳', subscription_renewed: '💳', subscription_past_due: '⚠️', subscription_canceled: '🛑', subscription_extra: '➕',
    admin_subscription_paid: '💰', admin_subscription_renewed: '💰', admin_subscription_past_due: '⚠️', admin_subscription_canceled: '🛑' };
  function iconFor(type){ return ICONS[type] || '🔔'; }

  var audioCtx = null;
  function unlockAudio(){
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function(ev){
    document.addEventListener(ev, unlockAudio, { once: true, passive: true });
  });
  function vibrate(pattern){
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
  }
  function tone(freq, dur, gain, at){
    try {
      if (!audioCtx) unlockAudio();
      if (!audioCtx) return;
      var t0 = audioCtx.currentTime + (at || 0);
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain || 0.12, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    } catch (e) {}
  }
  function isAlertNotif(n){
    var t = String(n && n.type || '');
    var title = String(n && n.title || '');
    return /approved|accepted|welcome|subscription_paid|subscription_renewed|new_mission|establishment_approved|document_approved|application_accepted|verification_approved/.test(t)
      || /urgent|validé|confirmé|Bienvenue|Abonnement|Mission confirmée/i.test(title);
  }
  function playAlert(n){
    var title = String(n && n.title || '');
    var urgent = /urgent|🚨/i.test(title) || (n && n.type === 'new_mission' && /urgent/i.test(title));
    var strong = urgent || isAlertNotif(n);
    try {
      if (strong) {
        vibrate(urgent ? [80, 50, 80, 50, 180] : [50, 40, 120]);
        tone(880, 0.12, 0.16, 0);
        tone(1174, 0.16, 0.14, 0.12);
        if (urgent) tone(1318, 0.2, 0.12, 0.28);
      } else {
        vibrate(35);
        tone(740, 0.08, 0.08, 0);
      }
    } catch (e) {}
  }

  /* ---------- Notifications in-app : sondage + badge + notification navigateur ---------- */
  var pollers = {};
  function startNotifications(role, onChange){
    stopNotifications(role);
    var state = { role: role, list: [], unread: 0, seen: null, timer: null, onChange: onChange };
    pollers[role] = state;
    async function tick(){
      if (!A() || !A().token(role)) return;
      try {
        var rows = await A().notifications(role) || [];
        var unread = rows.filter(function(n){ return !n.read; });
        if (state.seen) {
          unread.filter(function(n){ return !state.seen[n.id]; }).slice(0, 5).forEach(function(n){ browserNotify(n); });
        }
        state.seen = {};
        rows.forEach(function(n){ state.seen[n.id] = true; });
        state.list = rows; state.unread = unread.length;
        if (typeof state.onChange === 'function') state.onChange(rows, unread.length);
      } catch (e) { /* API momentanément injoignable : on réessaiera */ }
    }
    state.refresh = tick;
    tick();
    state.timer = setInterval(tick, POLL_MS);
    enableAlertsForSession(role);
    return state;
  }
  function enableAlertsForSession(role){
    registerNativePush(role);
    if (browserPermission() === 'default') enableBrowserNotifications();
  }
  function stopNotifications(role){
    var st = pollers[role];
    if (st && st.timer) clearInterval(st.timer);
    delete pollers[role];
  }
  function refreshNotifications(role){ var st = pollers[role]; return st ? st.refresh() : Promise.resolve(); }
  async function markRead(role, id){
    try { await A().markNotificationRead(role, id); } catch (e) {}
    return refreshNotifications(role);
  }
  async function markAllRead(role){
    try { await A().markAllNotificationsRead(role); } catch (e) {}
    return refreshNotifications(role);
  }
  function setBadge(el, count){
    if (!el) return;
    el.textContent = count > 99 ? '99+' : String(count || '');
    el.style.display = count > 0 ? '' : 'none';
  }

  function browserSupported(){ return typeof window.Notification !== 'undefined' && !isNative(); }
  function browserPermission(){ return browserSupported() ? Notification.permission : 'unsupported'; }
  async function enableBrowserNotifications(){
    if (!browserSupported()) return 'unsupported';
    try { return await Notification.requestPermission(); } catch (e) { return 'denied'; }
  }
  function browserNotify(n){
    playAlert(n);
    if (!browserSupported() || Notification.permission !== 'granted') return;
    try {
      var urgent = /urgent|🚨/i.test(n.title || '') || n.type === 'new_mission';
      new Notification(n.title || 'URGAD', {
        body: n.content || '',
        tag: 'urgad-' + n.id,
        requireInteraction: urgent || isAlertNotif(n),
        silent: false
      });
    } catch (e) {}
  }

  /* ---------- Push natif (Capacitor @capacitor/push-notifications) ---------- */
  function isNative(){
    try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); } catch (e) { return false; }
  }
  async function registerNativePush(role){
    if (!isNative()) return { status: 'web' };
    var P = window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
    if (!P) return { status: 'plugin_missing' };
    // Android sans google-services.json : PushNotifications.register() fait planter l'app (FirebaseApp non initialisé).
    // Le build natif positionne window.URGAD_NATIVE_PUSH (push-config.js) ; false = ne pas s'enregistrer.
    if (window.URGAD_NATIVE_PUSH === false || (window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'android' && window.URGAD_NATIVE_PUSH !== true)) return { status: 'disabled_no_firebase_config' };
    try {
      var perm = await P.checkPermissions();
      if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await P.requestPermissions();
      if (perm.receive !== 'granted') return { status: 'denied' };
      if (!registerNativePush._listeners) {
        registerNativePush._listeners = true;
        await P.addListener('registration', async function(t){
          try { localStorage.setItem('urgad.push.token', t.value); } catch (e) {}
          var platform = (window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || 'android';
          var r = registerNativePush._role;
          if (r && A() && A().token(r)) { try { await A().registerDevice(r, t.value, platform === 'ios' ? 'ios' : 'android'); } catch (e) {} }
        });
        await P.addListener('registrationError', function(err){ console.warn('[URGAD push] registration error', err); });
        await P.addListener('pushNotificationReceived', function(n){
          playAlert({ title: (n && n.title) || '', content: (n && n.body) || '', type: (n && n.data && n.data.type) || '' });
          refreshNotifications(registerNativePush._role);
        });
        await P.addListener('pushNotificationActionPerformed', function(a){
          var screen = a && a.notification && a.notification.data && a.notification.data.screen;
          if (screen && typeof window.showProScreen === 'function') { try { window.showProScreen(screen); } catch (e) {} }
        });
      }
      registerNativePush._role = role;
      await P.register(); // sans google-services.json (Android) / APNs (iOS), l'erreur arrive dans registrationError
      return { status: 'registering' };
    } catch (e) {
      console.warn('[URGAD push] indisponible :', e && e.message ? e.message : e);
      return { status: 'error', message: String(e && e.message || e) };
    }
  }
  async function unregisterNativePush(role){
    var token = null;
    try { token = localStorage.getItem('urgad.push.token'); } catch (e) {}
    if (token && A() && A().token(role)) { try { await A().unregisterDevice(role, token); } catch (e) {} }
    try { localStorage.removeItem('urgad.push.token'); } catch (e) {}
  }

  /* ---------- Carte des missions ---------- */
  function pinIcon(color, emoji, size){
    size = size || 34;
    return L.divIcon({ className: '', html: '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:' + color + ';border:3px solid #0A0E1A;display:flex;align-items:center;justify-content:center;font-size:' + Math.round(size * 0.42) + 'px;box-shadow:0 4px 12px ' + color + '80">' + emoji + '</div>', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }
  function groupByCoords(items){
    var groups = {};
    items.forEach(function(m){
      if (m.lat == null || m.lng == null) return;
      var k = Number(m.lat).toFixed(5) + ',' + Number(m.lng).toFixed(5);
      (groups[k] = groups[k] || []).push(m);
    });
    return Object.keys(groups).map(function(k){ return groups[k]; });
  }
  /**
   * opts: { missions, origin:{lat,lng,label}, radiusKm, establishment:{lat,lng,name,address}, openFn:'nomFonctionGlobale', openLabel }
   * Retourne la carte Leaflet (ou null si Leaflet absent).
   */
  function missionsMap(containerId, opts){
    var el = document.getElementById(containerId);
    if (!el || typeof L === 'undefined') return null;
    if (el._urgadMap) { try { el._urgadMap.remove(); } catch (e) {} el._urgadMap = null; }
    opts = opts || {};
    var map = L.map(containerId, { zoomControl: false, attributionControl: true }).setView([46.6, 2.4], 5);
    L.control.zoom({ position: 'topright' }).addTo(map);
    if (typeof window.addUrgadBaseMap === 'function') window.addUrgadBaseMap(map);
    else L.maplibreGL({ style: 'https://tiles.openfreemap.org/styles/dark' }).addTo(map);
    var pts = [];
    if (opts.origin && opts.origin.lat != null) {
      L.marker([opts.origin.lat, opts.origin.lng], { icon: pinIcon('#D4AF37', '📍', 34) }).addTo(map).bindPopup('<strong>' + esc(opts.origin.label || 'Votre position') + '</strong>');
      pts.push([opts.origin.lat, opts.origin.lng]);
      if (opts.radiusKm) {
        var c = L.circle([opts.origin.lat, opts.origin.lng], { radius: opts.radiusKm * 1000, color: '#D4AF37', weight: 1.5, fillColor: '#D4AF37', fillOpacity: 0.07, dashArray: '6,6' }).addTo(map);
        var b = c.getBounds(); pts.push([b.getSouth(), b.getWest()]); pts.push([b.getNorth(), b.getEast()]);
      }
    }
    if (opts.establishment && opts.establishment.lat != null) {
      L.marker([opts.establishment.lat, opts.establishment.lng], { icon: pinIcon('#10B981', '🏥', 36), zIndexOffset: -100 }).addTo(map)
        .bindPopup('<strong>' + esc(opts.establishment.name || 'Établissement') + '</strong><br>' + esc(opts.establishment.address || ''));
      pts.push([opts.establishment.lat, opts.establishment.lng]);
    }
    groupByCoords(opts.missions || []).forEach(function(group){
      var first = group[0];
      var urgent = group.some(function(m){ return m.urgent; });
      var html = group.map(function(m){
        return '<div style="margin:6px 0;min-width:190px"><strong>' + esc(m.etab || m.title) + '</strong>' + (m.urgent ? ' 🚨' : '') +
          '<br><span style="font-size:12px">' + esc(m.title || m.type) + '<br>' + esc(m.date || '') + ' · ' + esc(m.start || '') + ' → ' + esc(m.end || '') +
          (m.distance != null ? '<br>📏 ' + String(m.distance).replace('.', ',') + ' km' : '') + '</span>' +
          (opts.openFn ? '<br><button onclick="' + opts.openFn + '(' + JSON.stringify(m.id) + ')" style="margin-top:6px;padding:6px 10px;border-radius:8px;background:linear-gradient(135deg,#D4AF37,#F5D76E);color:#0A0E1A;font-weight:600;border:0;cursor:pointer">' + esc(opts.openLabel || 'Voir la mission') + '</button>' : '') + '</div>';
      }).join('<hr style="border:0;border-top:1px solid rgba(255,255,255,0.1)">');
      var label = group.length > 1 ? String(group.length) : (urgent ? '🚨' : '📋');
      L.marker([first.lat, first.lng], { icon: pinIcon(urgent ? '#EF4444' : '#3B82F6', label, 32) }).addTo(map).bindPopup(html, { maxWidth: 280 });
      pts.push([first.lat, first.lng]);
    });
    if (pts.length === 1) map.setView(pts[0], 13);
    else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 14 });
    el._urgadMap = map;
    setTimeout(function(){ try { map.invalidateSize(); } catch (e) {} }, 150);
    return map;
  }

  /* ---------- Liens légaux ---------- */
  function legalLinksHtml(){
    return '<a href="cgu.html" target="_blank" rel="noopener">CGU</a> · <a href="confidentialite.html" target="_blank" rel="noopener">Confidentialité</a>';
  }
  function legalFooter(){
    return '<div class="urgad-legal-footer" style="text-align:center;font-size:11px;color:var(--text-dim,#64748B);padding:14px 10px">© URGAD · ' + legalLinksHtml() + '</div>';
  }
  var css = document.createElement('style');
  css.textContent = '.urgad-legal-footer a,.urgad-legal a{color:var(--gold-soft,#E8C866);text-decoration:none}.urgad-legal-footer a:hover,.urgad-legal a:hover{text-decoration:underline}' +
    '.urgad-badge{position:absolute;top:2px;right:calc(50% - 22px);min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:#EF4444;color:#fff;font-size:10px;font-weight:700;line-height:17px;text-align:center}' +
    '.urgad-badge-inline{display:inline-block;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#EF4444;color:#fff;font-size:10px;font-weight:700;line-height:18px;text-align:center;margin-left:6px}' +
    '.urgad-notif-unread{border-color:rgba(212,175,55,0.45)!important;background:rgba(212,175,55,0.05)!important}' +
    '.urgad-modal-back{position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px}' +
    '.urgad-modal-box{background:var(--bg-card,#151A2E);border:1px solid var(--border,rgba(255,255,255,0.1));border-radius:16px;max-width:420px;width:100%;padding:22px;color:var(--text,#F1F5F9)}' +
    '.urgad-modal-box h3{margin:0 0 10px;font-size:17px}.urgad-modal-box p{font-size:13px;color:var(--text-muted,#94A3B8);line-height:1.5;margin:0 0 12px}' +
    '.urgad-modal-box input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--border,rgba(255,255,255,0.15));background:var(--surface,#0F1424);color:inherit;margin-bottom:14px}' +
    '.urgad-modal-actions{display:flex;gap:10px;justify-content:flex-end}.urgad-modal-actions button{padding:10px 16px;border-radius:10px;border:0;font-weight:600;cursor:pointer}' +
    '.urgad-btn-ghost{background:transparent;color:var(--text-muted,#94A3B8);border:1px solid var(--border,rgba(255,255,255,0.15))!important}.urgad-btn-danger{background:#DC2626;color:#fff}';
  document.head.appendChild(css);

  /* ---------- RGPD : export / suppression ---------- */
  async function downloadMyData(role){
    var data = await A().exportMyData(role);
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'urgad-mes-donnees.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
    return data;
  }
  /** Fenêtre de confirmation avec mot de passe, puis DELETE /api/me. done(err|null) */
  function confirmDeleteAccount(role, done){
    var back = document.createElement('div');
    back.className = 'urgad-modal-back';
    back.innerHTML = '<div class="urgad-modal-box"><h3>Supprimer mon compte</h3>' +
      '<p>Vos données personnelles seront effacées ou anonymisées et vos justificatifs supprimés du serveur. Cette action est définitive. Pensez à télécharger vos données avant.</p>' +
      '<input type="password" id="urgad-del-pass" placeholder="Votre mot de passe pour confirmer" autocomplete="current-password">' +
      '<div class="urgad-modal-actions"><button class="urgad-btn-ghost" id="urgad-del-cancel">Annuler</button><button class="urgad-btn-danger" id="urgad-del-ok">Supprimer définitivement</button></div></div>';
    document.body.appendChild(back);
    var close = function(){ back.remove(); };
    back.addEventListener('click', function(e){ if (e.target === back) close(); });
    back.querySelector('#urgad-del-cancel').onclick = close;
    back.querySelector('#urgad-del-ok').onclick = async function(){
      var pass = back.querySelector('#urgad-del-pass').value;
      if (!pass) { back.querySelector('#urgad-del-pass').focus(); return; }
      this.disabled = true;
      try {
        await unregisterNativePush(role);
        var r = await A().deleteMyAccount(role, pass);
        close();
        A().clearToken(role);
        stopNotifications(role);
        done && done(null, r);
      } catch (e) { this.disabled = false; done && done(e); }
    };
    setTimeout(function(){ var i = back.querySelector('#urgad-del-pass'); if (i) i.focus(); }, 50);
  }

  /* ---------- Disponibilités : jours + dates (14 prochains jours) ---------- */
  var WEEKDAYS_FR = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
  function emptyAvailSlot(){ return { matin: false, apres_midi: false, nuit: false }; }
  function isoLocalDate(d){
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  function parseAvailability(raw){
    var obj = raw;
    if (!raw) return { weekly: {}, dates: {} };
    if (typeof raw === 'string') {
      try { obj = JSON.parse(raw); } catch (e) { return { weekly: {}, dates: {} }; }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { weekly: {}, dates: {} };
    var weekly = {};
    var dates = {};
    if (obj.weekly && typeof obj.weekly === 'object') weekly = Object.assign({}, obj.weekly);
    if (obj.dates && typeof obj.dates === 'object') dates = Object.assign({}, obj.dates);
    WEEKDAYS_FR.forEach(function(d){
      if (obj[d] && !weekly[d]) weekly[d] = obj[d];
    });
    Object.keys(obj).forEach(function(k){
      if (/^\d{4}-\d{2}-\d{2}$/.test(k)) dates[k] = obj[k];
    });
    return { weekly: weekly, dates: dates };
  }
  function normalizeAvailSlot(s){
    s = s || {};
    return {
      matin: !!(s.matin || s.morning),
      apres_midi: !!(s.apres_midi || s.afternoon),
      nuit: !!(s.nuit || s.night)
    };
  }
  function upcomingAvailDays(n){
    n = n || 14;
    var start = new Date();
    start.setHours(12, 0, 0, 0);
    var out = [];
    for (var i = 0; i < n; i++) {
      var d = new Date(start.getTime());
      d.setDate(start.getDate() + i);
      out.push({
        iso: isoLocalDate(d),
        weekday: WEEKDAYS_FR[d.getDay()],
        dateLabel: d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
        fullLabel: d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }),
        isToday: i === 0,
        isWeekend: d.getDay() === 0 || d.getDay() === 6
      });
    }
    return out;
  }
  function availSlotFor(avail, day){
    var a = parseAvailability(avail);
    return normalizeAvailSlot(a.dates[day.iso] || a.weekly[day.weekday] || emptyAvailSlot());
  }
  function availToggleHtml(iso, slot, on, clickable){
    var cls = on ? 'on' : 'off';
    var handler = clickable ? ' onclick="toggleAvail(this)"' : '';
    return '<div class="avail-cell"><div class="avail-toggle ' + cls + '" data-iso="' + iso + '" data-slot="' + slot + '"' + handler + '>' + (on ? '✓' : '✕') + '</div></div>';
  }
  function availabilityGridHtml(avail, opts){
    opts = opts || {};
    var clickable = opts.clickable !== false;
    var days = upcomingAvailDays(opts.days || 14);
    var rows = days.map(function(day){
      var s = availSlotFor(avail, day);
      var name = day.isToday ? "Aujourd'hui" : day.weekday;
      return '<div class="avail-row' + (day.isToday ? ' today' : '') + (day.isWeekend ? ' weekend' : '') + '">' +
        '<div class="avail-day"><div class="avail-day-name">' + esc(name) + '</div><div class="avail-day-date">' + esc(day.dateLabel) + '</div></div>' +
        availToggleHtml(day.iso, 'matin', s.matin, clickable) +
        availToggleHtml(day.iso, 'apres_midi', s.apres_midi, clickable) +
        availToggleHtml(day.iso, 'nuit', s.nuit, clickable) +
        '</div>';
    }).join('');
    return '<div class="avail-grid">' +
      '<div class="avail-row header"><div>Date</div><div>Matin</div><div>Après-midi</div><div>Nuit</div></div>' +
      rows + '</div>';
  }
  function collectAvailabilityFromGrid(root){
    var dates = {};
    var weekly = {};
    var nodes = (root || document).querySelectorAll('.avail-toggle[data-iso]');
    nodes.forEach(function(el){
      var iso = el.getAttribute('data-iso');
      var slot = el.getAttribute('data-slot');
      if (!dates[iso]) dates[iso] = emptyAvailSlot();
      if (slot && Object.prototype.hasOwnProperty.call(dates[iso], slot)) dates[iso][slot] = el.classList.contains('on');
    });
    upcomingAvailDays(14).forEach(function(day){
      if (dates[day.iso]) weekly[day.weekday] = dates[day.iso];
    });
    return { weekly: weekly, dates: dates };
  }
  function availabilityMenuHint(avail){
    var days = upcomingAvailDays(14);
    var on = 0;
    days.forEach(function(d){
      var s = availSlotFor(avail, d);
      if (s.matin || s.apres_midi || s.nuit) on++;
    });
    if (!on) return '14 prochains jours — aucun créneau';
    return on + ' jour(s) avec créneau sur 14';
  }

  var DOC_SLOTS = [
    { category: 'identity', title: "Pièce d'identité", hint: 'CNI, passeport ou titre de séjour — recto et verso', icon: '🆔', required: true, action: 'identity' },
    { category: 'diploma', title: 'Diplôme', hint: 'DEAS, DEI, attestation de formation…', icon: '🎓', required: true, action: 'diploma' },
    { category: 'carte_vitale', title: 'Carte Vitale', hint: 'Photo ou attestation de droits', icon: '💳', required: true, action: 'carte_vitale' },
    { category: 'vaccins', title: 'Vaccins à jour', hint: 'Carnet ou justificatif de vaccinations', icon: '💉', required: true, action: 'vaccins' },
    { category: 'rib', title: 'RIB', hint: 'Relevé d’identité bancaire au nom du soignant', icon: '🏦', required: true, action: 'rib' }
  ];
  var DOC_CAT_LABELS = { identity: "Pièce d'identité", diploma: 'Diplôme', carte_vitale: 'Carte Vitale', vaccins: 'Vaccins', rib: 'RIB', other: 'Autre' };
  function docCategoryLabel(cat){ return DOC_CAT_LABELS[cat] || cat || 'Document'; }

  function minutesFromHour(raw){
    var m = String(raw || '').trim().toLowerCase().replace('h', ':').match(/^(\d{1,2}):(\d{2})$/);
    if(!m) return null;
    var h = Number(m[1]), min = Number(m[2]);
    if(!isFinite(h) || !isFinite(min) || h > 23 || min > 59) return null;
    return h * 60 + min;
  }
  function durationHours(start, end){
    var a = minutesFromHour(start), b = minutesFromHour(end);
    if(a == null || b == null) return null;
    var mins = b - a;
    if(mins <= 0) mins += 24 * 60;
    return Math.round((mins / 60) * 100) / 100;
  }
  function parseHourlyRate(raw){
    if(raw == null || raw === '') return null;
    var n = Number(String(raw).replace(/\s/g, '').replace(',', '.').replace('€', ''));
    return isFinite(n) ? Math.round(n * 100) / 100 : null;
  }
  function formatEuro(n){
    if(n == null || !isFinite(Number(n))) return '—';
    return Number(n).toFixed(2).replace('.', ',') + ' €';
  }
  function formatHours(n){
    if(n == null || !isFinite(Number(n))) return '—';
    var v = Number(n);
    return (Math.round(v) === v ? String(v) : String(v).replace('.', ',')) + ' h';
  }
  function quotePay(rateRaw, start, end){
    var rate = parseHourlyRate(rateRaw);
    var hours = durationHours(start, end);
    if(rate == null || hours == null) return null;
    var total = Math.round(rate * hours * 100) / 100;
    return {
      hourlyRate: rate, durationHours: hours, totalAmount: total,
      label: formatEuro(total),
      detail: formatHours(hours) + ' × ' + formatEuro(rate) + '/h',
      conditions: formatEuro(total) + ' (' + formatHours(hours) + ' × ' + formatEuro(rate) + '/h)'
    };
  }
  function bindPayPreview(startId, endId, rateId, outId){
    function paint(){
      var startEl = document.getElementById(startId);
      var endEl = document.getElementById(endId);
      var rateEl = document.getElementById(rateId);
      var out = document.getElementById(outId);
      if(!out) return;
      var q = quotePay(rateEl && rateEl.value, startEl && startEl.value, endEl && endEl.value);
      if(!q){ out.textContent = 'Saisissez le tarif horaire : le total de la vacation se calcule tout seul (une nuit 20:00 → 07:00 = 11 h).'; return; }
      out.innerHTML = '<strong style="color:var(--emerald-soft);font-size:18px">'+esc(q.label)+'</strong> versés au soignant <span style="color:var(--text-muted)">('+esc(q.detail)+')</span>';
    }
    [startId, endId, rateId].forEach(function(id){
      var el = document.getElementById(id);
      if(el){ el.addEventListener('input', paint); el.addEventListener('change', paint); }
    });
    paint();
  }

  window.UrgadFeatures = {
    DOC_SLOTS: DOC_SLOTS, docCategoryLabel: docCategoryLabel,
    esc: esc, timeAgo: timeAgo, iconFor: iconFor,
    startNotifications: startNotifications, stopNotifications: stopNotifications, refreshNotifications: refreshNotifications,
    enableAlertsForSession: enableAlertsForSession,
    markRead: markRead, markAllRead: markAllRead, setBadge: setBadge, playAlert: playAlert, unlockAudio: unlockAudio,
    browserSupported: browserSupported, browserPermission: browserPermission, enableBrowserNotifications: enableBrowserNotifications,
    isNative: isNative, registerNativePush: registerNativePush, unregisterNativePush: unregisterNativePush,
    missionsMap: missionsMap, pinIcon: pinIcon,
    legalLinksHtml: legalLinksHtml, legalFooter: legalFooter,
    downloadMyData: downloadMyData, confirmDeleteAccount: confirmDeleteAccount,
    getNotifications: function(role){ var st = pollers[role]; return st ? st.list : []; },
    getUnread: function(role){ var st = pollers[role]; return st ? st.unread : 0; },
    parseAvailability: parseAvailability,
    upcomingAvailDays: upcomingAvailDays,
    availabilityGridHtml: availabilityGridHtml,
    collectAvailabilityFromGrid: collectAvailabilityFromGrid,
    availabilityMenuHint: availabilityMenuHint,
    durationHours: durationHours, parseHourlyRate: parseHourlyRate, formatEuro: formatEuro, formatHours: formatHours,
    quotePay: quotePay, bindPayPreview: bindPayPreview
  };
})();
