/* URGAD client — static files only. JWT in sessionStorage, never a database.
   Writes go through the API. Default base is the local preview.
   Deploy: set window.URGAD_API to the public API origin before this script. */
(function(){
  var BASE = (function(){
    try {
      var configured = window.URGAD_API || '';
      if (!configured) {
        var meta = document.querySelector('meta[name="urgad-api"]');
        if (meta && meta.content) configured = meta.content;
      }
      if (!configured && location.search) {
        var q = new URLSearchParams(location.search).get('api');
        if (q) configured = q;
      }
      if (configured) return String(configured).replace(/\/$/, '');
      // Same-origin when UI is served by the API (:3001) or a Vite proxy.
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        return String(location.origin).replace(/\/$/, '');
      }
    } catch (e) {}
    return 'http://127.0.0.1:3001';
  })();

  function storageKey(role){ return 'urgad.jwt.' + role; }
  function token(role){
    try { return sessionStorage.getItem(storageKey(role)) || ''; }
    catch (e) { return ''; }
  }
  function setToken(role, value){
    sessionStorage.setItem(storageKey(role), value);
  }
  function clearToken(role){
    try { sessionStorage.removeItem(storageKey(role)); } catch (e) {}
  }

  async function request(role, method, path, body){
    var headers = { 'Accept': 'application/json' };
    var jwt = role ? token(role) : '';
    if (jwt) headers.Authorization = 'Bearer ' + jwt;
    var opts = { method: method, headers: headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var res;
    try {
      res = await fetch(BASE + path, opts);
    } catch (e) {
      var down = new Error('API injoignable (' + BASE + ').');
      down.cause = e;
      throw down;
    }
    var text = await res.text();
    var data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch (e2) { data = { message: text.slice(0, 200) }; }
    }
    if (!res.ok) {
      var msg = (data && data.message) ? String(data.message) : ('HTTP ' + res.status);
      var err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function openAuthBlob(role, path){
    var res = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + token(role) } });
    if (!res.ok) { var t = ''; try { t = (await res.json()).message; } catch (e) {} throw new Error(t || ('HTTP ' + res.status)); }
    var blob = await res.blob();
    var url = URL.createObjectURL(blob);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 120000);
    return { url: url, blob: blob, mime: blob.type || res.headers.get('Content-Type') || '' };
  }

  function stripSecrets(row){
    if (!row || typeof row !== 'object') return row;
    var copy = Object.assign({}, row);
    delete copy.password;
    return copy;
  }

  function formatDate(iso){
    if (!iso) return '';
    var d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function coord(v){
    if (v == null || v === '') return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function mapMission(m){
    return {
      id: m.id,
      uuid: m.uuid,
      type: m.type || '',
      title: m.title || '',
      etab: m.establishment_name || '',
      etabId: m.establishment_id,
      address: m.location || '',
      lat: coord(m.latitude != null ? m.latitude : m.lat),
      lng: coord(m.longitude != null ? m.longitude : m.lng),
      distance: (m.distance_km != null && m.distance_km !== '') ? Number(m.distance_km) : null,
      geoPrecision: m.geocode_precision || null,
      date: formatDate(m.start_date),
      startDate: m.start_date || '',
      start: m.start_hour || '',
      end: m.end_hour || '',
      service: '',
      price: m.conditions || '—',
      urgent: m.urgent === 1 || m.urgent === true,
      desc: m.description || '',
      profession: '',
      status: m.status || 'pending',
      apiStatus: m.status || 'pending',
      candidates: m.applicationCount != null ? m.applicationCount : (m.application_count || 0),
      assigned: null,
      source: 'api'
    };
  }

  function mapApplication(a){
    var name = a.professional_name || (((a.first_name || '') + ' ' + (a.last_name || '')).trim());
    return {
      id: a.id,
      missionId: a.mission_id,
      etab: a.establishment_name || '',
      proName: name || 'Professionnel',
      proEmail: a.professional_email || '',
      role: a.professional_role || '',
      date: a.start_date ? formatDate(a.start_date) : '',
      start: a.start_hour || '',
      end: a.end_hour || '',
      price: '',
      status: a.status || 'pending',
      statusLabel: a.status_label || ({ pending: 'En attente', proposed: "Proposé à l'établissement", accepted: 'Confirmé', rejected: 'Non retenu', withdrawn: 'Retirée' })[a.status] || a.status || '',
      reason: a.reason || '',
      title: a.title || '',
      source: 'api'
    };
  }

  function initials(name){
    return String(name || 'ET').split(/\s+/).filter(Boolean).slice(0, 2).map(function(w){ return w.charAt(0); }).join('').toUpperCase() || 'ET';
  }

  function mapConversation(c){
    var who = c.other_participant || 'Conversation';
    return {
      id: c.conversation_id,
      etab: who,
      proName: who,
      proEmail: '',
      avatar: initials(who),
      preview: c.last_message || '',
      time: c.last_message_date || '',
      unreadPro: 0,
      unreadEtab: 0,
      messageCount: c.message_count || 0,
      thread: [],
      source: 'api'
    };
  }

  function mapMessage(m){
    var from = m.sender_type === 'professional' ? 'pro' : (m.sender_type === 'establishment' ? 'etab' : (m.sender_type || 'other'));
    return { from: from, text: m.content || '', time: m.created_at || '', sender: m.sender_name || '' };
  }

  function mapProfessional(row){
    row = stripSecrets(row);
    var userId = row.user_id || row.id;
    var name = (((row.first_name || '') + ' ' + (row.last_name || '')).trim()) || row.email || 'Professionnel';
    var verified = row.verified === 1 || row.verified === true || row.verification_status === 'approved';
    return {
      id: userId,
      userId: userId,
      name: name,
      role: row.profession || 'Aide-soignant',
      city: row.city || '—',
      status: row.verification_status === 'suspended' ? 'rejected' : (verified ? 'verified' : (row.verification_status === 'rejected' ? 'rejected' : 'pending')),
      suspended: row.verification_status === 'suspended',
      verificationStatus: row.verification_status || '',
      exp: '—',
      distance: '—',
      email: row.email || '',
      phone: row.phone || '',
      rating: 0,
      reviews: 0,
      missions: 0,
      joined: row.created_at || '',
      skills: row.skills ? String(row.skills).split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [],
      lat: coord(row.latitude != null ? row.latitude : row.lat),
      lng: coord(row.longitude != null ? row.longitude : row.lng),
      availability: row.availability || null,
      phoneVerified: row.verified === 1 || row.verified === true,
      source: 'api'
    };
  }

  function mapEstablishment(row){
    row = stripSecrets(row);
    var raw = row.status || '';
    var status = 'pending';
    if (raw === 'approved' || raw === 'verified') status = 'verified';
    else if (raw === 'rejected') status = 'rejected';
    else if (raw === 'prospect') status = 'prospect';
    else if (raw === 'suspended' || row.user_verification_status === 'suspended' || row.verification_status === 'suspended') status = 'suspended';
    var subscription = null;
    if (row.subscription && row.subscription.name) subscription = row.subscription;
    else if (row.subscription_name) {
      subscription = {
        name: row.subscription_name,
        status: row.subscription_status || 'pending',
        price: row.subscription_price,
        paid: false,
        charged: false
      };
    }
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name || '',
      type: row.type || '',
      city: row.city || '',
      status: status,
      missions: 0,
      beds: '—',
      siret: row.siret || '',
      contact: row.responsible || (((row.first_name || '') + ' ' + (row.last_name || '')).trim()),
      phone: row.phone || '',
      email: row.email || '',
      address: row.address || '',
      postalCode: row.postal_code || '',
      documentCount: row.document_count != null ? row.document_count : 0,
      documentRequest: row.document_request_message ? { message: row.document_request_message, at: row.document_request_at || null, by: row.document_request_by || null } : null,
      subscription: subscription,
      lat: coord(row.latitude != null ? row.latitude : row.lat),
      lng: coord(row.longitude != null ? row.longitude : row.lng),
      source: 'api'
    };
  }

  function mapEstablishmentAccount(row){
    var e = mapEstablishment(row);
    return {
      name: e.name,
      email: e.email,
      contact: e.contact,
      phone: e.phone,
      address: e.address,
      city: e.city,
      type: e.type,
      siret: e.siret,
      postalCode: e.postalCode,
      etabId: e.id,
      userId: e.userId,
      status: e.status,
      subscription: e.subscription || null,
      documentCount: e.documentCount || 0,
      documentRequest: e.documentRequest || null,
      lat: e.lat,
      lng: e.lng,
      geocodeLabel: row.geocode_label || '',
      geocodePrecision: row.geocode_precision || '',
      source: 'api'
    };
  }

  async function login(email, password, expected){
    var data = await request(null, 'POST', '/api/auth/login', {
      email: String(email || '').trim().toLowerCase(),
      password: String(password || '').trim()
    });
    if (!data || !data.token || !data.user) throw new Error('Réponse de connexion inattendue.');
    var role = data.user.role;
    if (expected === 'admin') {
      if (!data.user.isAdmin) throw new Error('Ce compte n\'est pas administrateur. Back-office : urgad-bo.html');
      setToken('admin', data.token);
    } else if (expected && role !== expected) {
      var pages = { professional: 'urgad-pro.html (soignant)', establishment: 'urgad-etab.html (établissement)', admin: 'urgad-bo.html (admin)' };
      throw new Error('Mauvais espace. Ce compte est « ' + role + ' » — ouvrez ' + (pages[role] || role) + '.');
    } else {
      setToken(role === 'admin' ? 'admin' : role, data.token);
    }
    return data;
  }

  function readFile(file){
    return new Promise(function(resolve, reject){
      if (!file) return reject(new Error('Fichier requis.'));
      if (file.size > 6 * 1024 * 1024) return reject(new Error('Fichier trop lourd (6 Mo maximum).'));
      var reader = new FileReader();
      reader.onload = function(){
        var result = String(reader.result || '');
        var comma = result.indexOf(',');
        resolve({
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          contentBase64: comma >= 0 ? result.slice(comma + 1) : result
        });
      };
      reader.onerror = function(){ reject(new Error('Lecture du fichier impossible.')); };
      reader.readAsDataURL(file);
    });
  }

  async function registerProfessional(draft){
    var data = await request(null, 'POST', '/api/auth/register/professional', {
      email: draft.email,
      password: draft.password,
      phone: draft.phone,
      firstName: draft.firstName,
      lastName: draft.lastName || '',
      address: draft.address || '',
      city: draft.city || '',
      postalCode: draft.postalCode || '',
      profession: draft.profession || '',
      acceptTerms: draft.acceptTerms === true
    });
    if (data && data.token) setToken('professional', data.token);
    return data;
  }

  async function registerEstablishment(draft){
    return request(null, 'POST', '/api/auth/register/establishment', {
      email: draft.email,
      password: draft.password,
      phone: draft.phone || '',
      name: draft.name,
      siret: draft.siret || '',
      type: draft.type || '',
      address: draft.address || '',
      city: draft.city || '',
      postalCode: draft.postalCode || '',
      responsible: draft.responsible || draft.contact || '',
      acceptTerms: draft.acceptTerms === true
    });
  }

  function previewState(){
    return {
      missions: [],
      professionals: [],
      establishments: [],
      candidatures: [],
      threads: [],
      accounts: { pros: [], etabs: [], admins: [] },
      sessions: { pro: null, etab: null, bo: null },
      draftPro: null,
      disputes: [
        {id:'LIT-LOCAL',pro:'Aperçu',etab:'Aperçu',mission:'—',reason:'Pas de table litiges',status:'open',priority:'low',created:'local'}
      ],
      supportTickets: [
        {id:'SUP-LOCAL',user:'Aperçu',type:'Local',subject:'Pas d\'endpoint ticket',priority:'low',status:'open',created:'local'}
      ],
      admins: [
        {id:1,name:'Admin API',email:'admin@urgad.fr',role:'Administrateur',status:'active',lastLogin:'—'}
      ],
      auditLog: [],
      feedItems: [],
      alerts: { pro: [], etab: [], bo: [] },
      proProfile: {
        firstName:'', lastName:'', email:'', phone:'',
        birthDate:'', address:'', city:'', postalCode:'',
        role:'Aide-soignant', experience:'—', rating:'—', reviews:0, totalMissions:'—',
        totalHours:'—', totalEarnings:'—', acceptanceRate:'—', responseTime:'—',
        joined:'', radius:20,
        skills:[], preferredServices:[], preferredTypes:[], previousEmployers:[]
      },
      documents: [
        {name:'Diplôme',file:null,size:null,status:'missing',date:null,icon:'🎓'},
        {name:'Pièce d\'identité',file:null,size:null,status:'missing',date:null,icon:'🆔'}
      ],
      reviews: [],
      monthlyStats: [],
      localPreview: true
    };
  }

  window.UrgadApi = {
    BASE: BASE,
    token: token,
    setToken: setToken,
    clearToken: clearToken,
    request: request,
    login: login,
    registerProfessional: registerProfessional,
    registerEstablishment: registerEstablishment,
    requestCode: function(body){ return request(null, 'POST', '/api/auth/request-code', body); },
    verifyPhone: function(body){ return request(null, 'POST', '/api/auth/verify', body); },
    readFile: readFile,
    professionalDocuments: function(){ return request('professional', 'GET', '/api/professionals/me/documents'); },
    addProfessionalDocument: function(body){
      return request('professional', 'POST', '/api/professionals/me/documents', {
        name: body.name, type: body.type, fileName: body.fileName, mimeType: body.mimeType, contentBase64: body.contentBase64,
        category: body.category || undefined, idKind: body.idKind || undefined, side: body.side || undefined
      });
    },
    health: function(){ return request(null, 'GET', '/api/health'); },
    profile: function(role){ return request(role, 'GET', '/api/auth/profile'); },
    updateProfile: function(role, body){ return request(role, 'PUT', '/api/auth/profile', body); },
    professional: function(role, id){ return request(role, 'GET', '/api/professionals/' + id); },
    setMobility: function(role, userId, mobilityRadius){
      return request(role, 'PUT', '/api/professionals/' + userId + '/mobility', { mobilityRadius: mobilityRadius });
    },
    setAvailability: function(role, userId, availability){
      return request(role, 'PUT', '/api/professionals/' + userId + '/availability', { availability: availability });
    },
    missions: function(role){ return request(role, 'GET', '/api/missions'); },
    createMission: function(role, body){ return request(role, 'POST', '/api/missions', body); },
    apply: function(role, missionId){ return request(role, 'POST', '/api/applications', { missionId: missionId }); },
    myApplications: function(role){ return request(role, 'GET', '/api/applications/my'); },
    missionApplications: function(role, missionId){ return request(role, 'GET', '/api/applications/mission/' + missionId); },
    acceptApplication: function(role, id){ return request(role, 'POST', '/api/applications/' + id + '/accept', {}); },
    rejectApplication: function(role, id, reason){ return request(role, 'POST', '/api/applications/' + id + '/reject', { reason: reason || '' }); },
    withdrawApplication: function(role, id){ return request(role, 'POST', '/api/applications/' + id + '/withdraw', {}); },
    establishmentMe: function(){ return request('establishment', 'GET', '/api/establishments/me'); },
    updateEstablishment: function(body){ return request('establishment', 'PUT', '/api/establishments/me', body); },
    establishmentDocuments: function(){ return request('establishment', 'GET', '/api/establishments/me/documents'); },
    addEstablishmentDocument: function(body){ return request('establishment', 'POST', '/api/establishments/me/documents', { name: body.name, type: body.type, fileName: body.fileName, mimeType: body.mimeType, contentBase64: body.contentBase64 }); },
    establishmentSubscription: function(){ return request('establishment', 'GET', '/api/establishments/me/subscription'); },
    billingCatalog: function(){ return request(null, 'GET', '/api/billing/plans'); },
    saveEstablishmentSubscription: function(body){ return request('establishment', 'POST', '/api/establishments/me/subscription', { id: body.id, name: body.name }); },
    confirmEstablishmentSubscription: function(sessionId){ return request('establishment', 'POST', '/api/establishments/me/subscription/confirm', { sessionId: sessionId }); },
    establishmentBillingPortal: function(){ return request('establishment', 'POST', '/api/establishments/me/subscription/portal', {}); },
    buyExtraMission: function(){ return request('establishment', 'POST', '/api/establishments/me/subscription/extra', {}); },
    notifications: function(role){ return request(role, 'GET', '/api/notifications'); },
    unreadCount: function(role){ return request(role, 'GET', '/api/notifications/unread-count'); },
    markNotificationRead: function(role, id){ return request(role, 'POST', '/api/notifications/' + encodeURIComponent(id) + '/read', {}); },
    markAllNotificationsRead: function(role){ return request(role, 'POST', '/api/notifications/read-all', {}); },
    registerDevice: function(role, token, platform){ return request(role, 'POST', '/api/devices', { token: token, platform: platform }); },
    unregisterDevice: function(role, token){ return request(role, 'DELETE', '/api/devices', { token: token }); },
    nearbyMissions: function(role, opts){
      var q = [];
      opts = opts || {};
      if (opts.lat != null && opts.lng != null) { q.push('lat=' + encodeURIComponent(opts.lat)); q.push('lng=' + encodeURIComponent(opts.lng)); }
      if (opts.radius != null) q.push('radius=' + encodeURIComponent(opts.radius));
      return request(role, 'GET', '/api/missions/nearby' + (q.length ? '?' + q.join('&') : ''));
    },
    exportMyData: function(role){ return request(role, 'GET', '/api/me/export'); },
    deleteMyAccount: function(role, password){ return request(role, 'DELETE', '/api/me', { password: password }); },
    termsInfo: function(){ return request(null, 'GET', '/api/auth/terms'); },
    adminGeocoding: function(){ return request('admin', 'GET', '/api/admin/geocoding'); },
    conversations: function(role){ return request(role, 'GET', '/api/messages/conversations'); },
    conversationMessages: function(role, id){ return request(role, 'GET', '/api/messages/conversation/' + encodeURIComponent(id)); },
    openConversation: function(role, participantId, participantType){
      return request(role, 'POST', '/api/messages/conversation', { participantId: participantId, participantType: participantType });
    },
    sendMessage: function(role, conversationId, content, recipientId, recipientType){
      var body = { conversationId: conversationId, content: content };
      if (recipientId != null) body.recipientId = recipientId;
      if (recipientType) body.recipientType = recipientType;
      return request(role, 'POST', '/api/messages', body);
    },
    adminStats: function(){ return request('admin', 'GET', '/api/admin/stats'); },
    adminProfessionals: function(){ return request('admin', 'GET', '/api/admin/professionals'); },
    adminEstablishments: function(){ return request('admin', 'GET', '/api/admin/establishments'); },
    adminApplications: function(){ return request('admin', 'GET', '/api/admin/applications'); },
    adminMissions: function(){ return request('admin', 'GET', '/api/admin/missions'); },
    adminConversations: function(){ return request('admin', 'GET', '/api/admin/messages/conversations'); },
    adminAudit: function(){ return request('admin', 'GET', '/api/admin/audit'); },
    adminNotifications: function(){ return request('admin', 'GET', '/api/admin/notifications'); },
    bulkNotify: function(body){ return request('admin', 'POST', '/api/admin/notifications/bulk', body); },
    adminUsers: function(){ return request('admin', 'GET', '/api/admin/admins'); },
    createAdminUser: function(body){ return request('admin', 'POST', '/api/admin/admins', body); },
    downloadAdminReport: async function(){
      var headers = { 'Accept': 'text/csv' };
      var jwt = token('admin');
      if (jwt) headers.Authorization = 'Bearer ' + jwt;
      var res = await fetch(BASE + '/api/admin/reports/summary.csv', { headers: headers });
      var textBody = await res.text();
      if (!res.ok) {
        var msg = textBody.slice(0, 200) || ('HTTP ' + res.status);
        try { var parsed = JSON.parse(textBody); if (parsed && parsed.message) msg = parsed.message; } catch (e) {}
        throw new Error(msg);
      }
      var blob = new Blob([textBody], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'urgad-summary.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 1500);
      return textBody;
    },
    approveProfessional: function(userId){ return request('admin', 'POST', '/api/admin/professionals/' + userId + '/approve-verification', {}); },
    rejectProfessional: function(userId, reason){ return request('admin', 'POST', '/api/admin/professionals/' + userId + '/reject-verification', { reason: reason || '' }); },
    suspendProfessional: function(userId){ return request('admin', 'POST', '/api/admin/professionals/' + userId + '/suspend', {}); },
    unsuspendProfessional: function(userId){ return request('admin', 'POST', '/api/admin/professionals/' + userId + '/unsuspend', {}); },
    patchMissionStatus: function(id, status){ return request('admin', 'PATCH', '/api/admin/missions/' + id + '/status', { status: status }); },
    notifyMissionPros: function(id, flash){ return request('admin', 'POST', '/api/admin/missions/' + id + '/notify', { flash: !!flash }); },
    deactivateAdmin: function(id){ return request('admin', 'POST', '/api/admin/admins/' + id + '/deactivate', {}); },
    sendNotification: function(body){ return request('admin', 'POST', '/api/admin/notifications/send', body); },
    updateApplication: function(id, status, reason){ return request('admin', 'PUT', '/api/admin/applications/' + id, { status: status, reason: reason || '' }); },
    suspendEstablishment: function(id){ return request('admin', 'POST', '/api/admin/establishments/' + id + '/suspend', {}); },
    unsuspendEstablishment: function(id){ return request('admin', 'POST', '/api/admin/establishments/' + id + '/unsuspend', {}); },
    downloadCsv: function(filename, headers, rows){
      function cell(c){
        var s = String(c == null ? '' : c);
        if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      }
      var csv = [headers.map(cell).join(';')].concat((rows || []).map(function(r){ return r.map(cell).join(';'); })).join('\n');
      var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename || 'urgad.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 1500);
    },
    adminEstablishmentDocuments: function(id){ return request('admin', 'GET', '/api/admin/establishments/' + id + '/documents'); },
    openEstablishmentDocument: function(estId, docId){ return openAuthBlob('admin', '/api/admin/establishments/' + estId + '/documents/' + docId + '/file'); },
    requestEstablishmentDocuments: function(id, message){ return request('admin', 'POST', '/api/admin/establishments/' + id + '/request-documents', { message: message || '' }); },
    approveEstablishment: function(id){ return request('admin', 'POST', '/api/admin/establishments/' + id + '/approve', {}); },
    rejectEstablishment: function(id, reason){ return request('admin', 'POST', '/api/admin/establishments/' + id + '/reject', { reason: reason || '' }); },
    adminDisputes: function(){ return request('admin', 'GET', '/api/admin/disputes'); },
    createDispute: function(body){ return request('admin', 'POST', '/api/admin/disputes', body); },
    updateDispute: function(id, body){ return request('admin', 'PUT', '/api/admin/disputes/' + id, body); },
    adminTickets: function(){ return request('admin', 'GET', '/api/admin/support-tickets'); },
    createTicket: function(body){ return request('admin', 'POST', '/api/admin/support-tickets', body); },
    updateTicket: function(id, body){ return request('admin', 'PUT', '/api/admin/support-tickets/' + id, body); },
    adminSettings: function(){ return request('admin', 'GET', '/api/admin/settings'); },
    saveSettings: function(body){ return request('admin', 'PUT', '/api/admin/settings', body); },
    adminFinance: function(){ return request('admin', 'GET', '/api/admin/finance'); },
    createFinance: function(body){ return request('admin', 'POST', '/api/admin/finance', body); },
    updateFinance: function(id, body){ return request('admin', 'PUT', '/api/admin/finance/' + id, body); },
    adminMatching: function(){ return request('admin', 'GET', '/api/admin/matching'); },
    simulateMatching: function(body){ return request('admin', 'POST', '/api/admin/matching/simulate', body); },
    adminAnalytics: function(){ return request('admin', 'GET', '/api/admin/analytics'); },
    // Demandes : l'équipe trouve le profil, l'établissement valide
    adminRequests: function(status){ return request('admin', 'GET', '/api/requests' + (status ? '?status=' + encodeURIComponent(status) : '')); },
    adminRequest: function(id){ return request('admin', 'GET', '/api/requests/' + id); },
    adminCreateRequest: function(body){ return request('admin', 'POST', '/api/requests', body); },
    proposeProfile: function(id, body){ return request('admin', 'POST', '/api/requests/' + id + '/propose', body); },
    setRequestStatus: function(id, status, reason){ return request('admin', 'POST', '/api/requests/' + id + '/status', { status: status, reason: reason || '' }); },
    etabRequests: function(){ return request('establishment', 'GET', '/api/requests'); },
    quickRequest: function(body){ return request('establishment', 'POST', '/api/requests/quick', body); },
    validateRequest: function(id){ return request('establishment', 'POST', '/api/requests/' + id + '/validate', {}); },
    requestOtherProfile: function(id, reason){ return request('establishment', 'POST', '/api/requests/' + id + '/request-other', { reason: reason || '' }); },
    // Vérification identité / diplôme
    verificationMe: function(){ return request('professional', 'GET', '/api/verification/me'); },
    verificationQueue: function(){ return request('admin', 'GET', '/api/verification/queue'); },
    verificationDossier: function(userId){ return request('admin', 'GET', '/api/verification/dossier/' + userId); },
    reviewVerification: function(userId, kind, decision, reason){ return request('admin', 'POST', '/api/verification/' + userId + '/review', { kind: kind, decision: decision, reason: reason || '' }); },
    requestProfessionalDocuments: function(userId, categories, message){ return request('admin', 'POST', '/api/verification/' + userId + '/request-documents', { categories: categories || [], message: message || '' }); },
    openDocument: function(role, id){ return openAuthBlob(role, '/api/verification/documents/' + id + '/file'); },
    reviewProfessionalDocument: function(id, decision, reason){
      var dec = (decision === 'verifie' || decision === 'approve' || decision === 'approved') ? 'approve' : 'reject';
      return request('admin', 'POST', '/api/admin/documents/professional/' + id + '/' + dec, { reason: reason || '' });
    },
    reviewEstablishmentDocument: function(id, decision, reason){
      var dec = (decision === 'verifie' || decision === 'approve' || decision === 'approved') ? 'approve' : 'reject';
      return request('admin', 'POST', '/api/admin/documents/establishment/' + id + '/' + dec, { reason: reason || '' });
    },
    mapMission: mapMission,
    mapApplication: mapApplication,
    mapConversation: mapConversation,
    mapMessage: mapMessage,
    mapProfessional: mapProfessional,
    mapEstablishment: mapEstablishment,
    mapEstablishmentAccount: mapEstablishmentAccount,
    stripSecrets: stripSecrets
  };

  window.UrgadStore = {
    load: previewState,
    save: function(){ /* intentionally not localStorage */ },
    clock: function(){ return new Date().toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' }); }
  };
})();
