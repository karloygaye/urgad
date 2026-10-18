import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { dbRun, dbGet, dbAll } from '../db.js';
import { config } from '../config.js';
import { geocodeEstablishment, geocodeProfessionalByUser } from '../geo.js';
import { notifyAdmins, notifySafe } from '../notify.js';

function welcomePro(userId: number, firstName: string) {
  const name = String(firstName || '').trim() || 'vous';
  void notifySafe(
    userId,
    'Bienvenue sur URGAD',
    `Bonjour ${name}. Votre compte professionnel est créé. Déposez pièce d’identité et diplôme : sans validation, vous ne pourrez pas être proposé à un établissement.`,
    { screen: 'my-documents' },
    'welcome'
  );
}

function welcomeEtab(userId: number, establishmentName: string) {
  const name = String(establishmentName || '').trim() || 'votre établissement';
  void notifySafe(
    userId,
    'Bienvenue sur URGAD',
    `${name} : votre compte est créé. Après validation back-office, vous pourrez publier des demandes (5 essais offerts, sans carte).`,
    { screen: 'dashboard' },
    'welcome'
  );
}

/** Les CGU et la politique de confidentialité doivent être acceptées à l'inscription. */
export const TERMS_VERSION = '2026-10-08';
function termsAccepted(body: any): boolean {
  const v = body?.acceptTerms ?? body?.accept_terms ?? body?.termsAccepted;
  return v === true || v === 'true' || v === 1 || v === '1';
}
const TERMS_MESSAGE = 'Vous devez accepter les CGU et la politique de confidentialité pour créer un compte.';

const router = Router();

function authMiddleware(req: any, res: any, next: any) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Token d\'authentification requis.' });
    const decoded = jwt.verify(token, config.jwtSecret) as any;
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: 'Token invalide ou expiré.' });
  }
}

/** Register professionnel */
router.post('/register/professional', async (req, res, next) => {
  try {
    const { email, password, phone, firstName, lastName } = req.body;
    if (!email || !password || !phone || !firstName || !lastName) {
      return res.status(422).json({ message: 'Email, mot de passe, téléphone, prénom et nom requis.' });
    }
    if (!termsAccepted(req.body)) return res.status(422).json({ message: TERMS_MESSAGE, code: 'terms_required', termsVersion: TERMS_VERSION });
    const address = String(req.body.address || '').trim().slice(0, 200);
    const city = String(req.body.city || '').trim().slice(0, 100);
    const postalCode = String(req.body.postalCode || req.body.postal_code || '').trim().slice(0, 10);
    const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return res.status(409).json({ message: 'Cet email est déjà utilisé.' });
    const hashed = await bcrypt.hash(password, 12);
    const inserted = await dbRun('INSERT INTO users (uuid, email, password, phone, first_name, last_name, role, accepted_terms_at, terms_version) VALUES (?, ?, ?, ?, ?, ?, ?, datetime(\'now\'), ?)',
      [uuidv4(), email, hashed, phone, firstName, lastName, 'professional', TERMS_VERSION]);
    let userId = inserted.lastInsertRowid;
    if (userId == null) {
      const row = await dbGet('SELECT id FROM users WHERE email = ?', [email]) as any;
      userId = row?.id ?? null;
    }
    if (userId == null) return res.status(500).json({ message: 'Compte non créé.' });
    const profession = String(req.body.profession || '').trim().slice(0, 80) || null;
    await dbRun('INSERT INTO professionals (user_id, address, city, postal_code, profession) VALUES (?, ?, ?, ?, ?)', [userId, address, city, postalCode, profession]);
    if (address || city || postalCode) {
      try { await geocodeProfessionalByUser(Number(userId)); } catch (e) { console.error('[GEO] pro:', e); }
    }
    void notifyAdmins('Nouveau professionnel inscrit', `${firstName} ${lastName} (${email}) — documents à vérifier.`, { userId, screen: 'verification' }, 'admin_new_pro');
    welcomePro(Number(userId), firstName);
    const token = jwt.sign({ id: Number(userId), role: 'professional', email, isAdmin: false }, config.jwtSecret, { expiresIn: '7d' });
    await dbRun('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?', [userId]);
    return res.json({
      message: 'Compte créé. Téléphone enregistré.',
      userId,
      token,
      user: { id: Number(userId), email, role: 'professional', isAdmin: false, verified: false },
      smsSent: false,
    });
  } catch (err) { next(err); }
});

/** Register établissement */
router.post('/register/establishment', async (req, res, next) => {
  try {
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const name = String(body.name || '').trim();
    const phone = String(body.phone || '').trim();
    const siret = String(body.siret || '').trim();
    const type = String(body.type || '').trim();
    const address = String(body.address || '').trim();
    const city = String(body.city || '').trim();
    const postalCode = String(body.postalCode || body.postal_code || '').trim();
    const responsible = String(body.responsible || body.contact || '').trim();
    if (!email || !password || !name) {
      return res.status(422).json({ message: 'Nom, e-mail et mot de passe requis.' });
    }
    if (!termsAccepted(body)) return res.status(422).json({ message: TERMS_MESSAGE, code: 'terms_required', termsVersion: TERMS_VERSION });
    if (password.length < 6) {
      return res.status(422).json({ message: 'Le mot de passe doit contenir au moins 6 caractères.' });
    }
    const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email]) as any;
    if (existing) {
      // Établissement saisi par l'équipe (prospect) : il récupère sa fiche et ses demandes en s'inscrivant avec le même e-mail.
      const prospect = await dbGet("SELECT e.id FROM establishments e JOIN users u ON u.id = e.user_id WHERE u.id = ? AND e.status = 'prospect' AND u.verification_status = 'prospect'", [existing.id]) as any;
      if (!prospect) return res.status(409).json({ message: 'Cet email est déjà utilisé.' });
      const parts0 = responsible.split(/\s+/).filter(Boolean);
      await dbRun("UPDATE users SET password = ?, phone = ?, first_name = ?, last_name = ?, verification_status = 'pending', accepted_terms_at = datetime('now'), terms_version = ? WHERE id = ?",
        [await bcrypt.hash(password, 12), phone, parts0[0] || '', parts0.slice(1).join(' '), TERMS_VERSION, existing.id]);
      await dbRun("UPDATE establishments SET name = ?, siret = ?, type = ?, phone = ?, address = ?, city = ?, postal_code = ?, responsible = ?, status = 'pending' WHERE id = ?",
        [name, siret, type, phone, address, city, postalCode, responsible, prospect.id]);
      try { await geocodeEstablishment(Number(prospect.id)); } catch (e) { console.error('[GEO] etab:', e); }
      void notifyAdmins('Prospect inscrit', `${name} (${email}) a créé son compte — à valider.`, { establishmentId: prospect.id, screen: 'establishments' }, 'admin_new_establishment');
      welcomeEtab(Number(existing.id), name);
      return res.status(201).json({ message: 'Compte établissement créé (fiche existante récupérée). Validation back-office en attente.', termsVersion: TERMS_VERSION, userId: existing.id, establishmentId: prospect.id, status: 'pending', claimedProspect: true });
    }
    const hashed = await bcrypt.hash(password, 12);
    const parts = responsible.split(/\s+/).filter(Boolean);
    const firstName = parts[0] || '';
    const lastName = parts.slice(1).join(' ');
    const inserted = await dbRun(
      'INSERT INTO users (uuid, email, password, phone, first_name, last_name, role, verified, verification_status, accepted_terms_at, terms_version) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, datetime(\'now\'), ?)',
      [uuidv4(), email, hashed, phone, firstName, lastName, 'establishment', 'pending', TERMS_VERSION]
    );
    let userId = inserted.lastInsertRowid;
    if (userId == null) {
      const row = await dbGet('SELECT id FROM users WHERE email = ?', [email]) as any;
      userId = row?.id ?? null;
    }
    if (userId == null) return res.status(500).json({ message: 'Compte non créé.' });
    const estInserted = await dbRun(
      'INSERT INTO establishments (user_id, name, siret, type, phone, email, address, city, postal_code, responsible, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, name, siret, type, phone, email, address, city, postalCode, responsible, 'pending']
    );
    let establishmentId = estInserted.lastInsertRowid;
    if (establishmentId == null) {
      const row = await dbGet('SELECT id FROM establishments WHERE user_id = ?', [userId]) as any;
      establishmentId = row?.id ?? null;
    }
    if (establishmentId != null) {
      try { await geocodeEstablishment(Number(establishmentId)); } catch (e) { console.error('[GEO] etab:', e); }
    }
    void notifyAdmins('Nouvel établissement à valider', `${name} (${email})${city ? ' — ' + city : ''}`, { establishmentId, screen: 'establishments' }, 'admin_new_establishment');
    welcomeEtab(Number(userId), name);
    return res.status(201).json({
      message: 'Compte établissement créé. Validation back-office en attente.',
      termsVersion: TERMS_VERSION,
      userId,
      establishmentId,
      status: 'pending'
    });
  } catch (err) { next(err); }
});

/** Login */
router.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '').trim();
    if (!email || !password) return res.status(422).json({ message: 'Email et mot de passe requis.' });
    const user = await dbGet('SELECT * FROM users WHERE lower(email) = ?', [email]) as any;
    if (!user || user.deleted_at) return res.status(401).json({ message: 'Identifiants invalides.' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ message: 'Identifiants invalides.' });
    const token = jwt.sign({ id: user.id, role: user.role, email: user.email, isAdmin: user.is_admin === 1 }, config.jwtSecret, { expiresIn: '7d' });
    await dbRun('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?', [user.id]);
    return res.json({ token, user: { id: user.id, email: user.email, role: user.role, isAdmin: user.is_admin === 1, verified: user.verified === 1 } });
  } catch (err) { next(err); }
});

/** Profile */
router.get('/profile', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]) as any;
    if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé.' });
    let extra: any = {};
    if (user.role === 'professional') {
      extra = await dbGet('SELECT * FROM professionals WHERE user_id = ?', [req.user.id]) || {};
      return res.json({ id: user.id, ...extra, email: user.email, phone: user.phone, role: user.role, isAdmin: user.is_admin === 1, verified: user.verified === 1, verification_status: user.verification_status, created_at: user.created_at, last_login: user.last_login, accepted_terms_at: user.accepted_terms_at, terms_version: user.terms_version });
    } else if (user.role === 'establishment') {
      extra = await dbGet('SELECT * FROM establishments WHERE user_id = ?', [req.user.id]) || {};
      return res.json({ id: user.id, ...extra, email: user.email, phone: user.phone, role: user.role, isAdmin: user.is_admin === 1, verified: user.verified === 1, verification_status: user.verification_status, created_at: user.created_at, accepted_terms_at: user.accepted_terms_at, terms_version: user.terms_version });
    }
    return res.json({
      id: user.id,
      email: user.email,
      phone: user.phone,
      firstName: user.first_name || '',
      lastName: user.last_name || '',
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      role: user.role,
      isAdmin: user.is_admin === 1,
      verified: user.verified === 1,
      verification_status: user.verification_status,
      created_at: user.created_at,
      last_login: user.last_login,
    });
  } catch (err) { next(err); }
});

/** Update profile — mise à jour partielle : un champ absent garde sa valeur. */
router.put('/profile', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const b = req.body || {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]) as any;
    if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé.' });
    await dbRun('UPDATE users SET phone = ?, first_name = ?, last_name = ? WHERE id = ?', [
      has('phone') ? String(b.phone || '') : (user.phone || ''),
      has('firstName') ? String(b.firstName || '') : (user.first_name || ''),
      has('lastName') ? String(b.lastName || '') : (user.last_name || ''),
      req.user.id]);
    let geocode: any = undefined;
    if (req.user.role === 'professional') {
      const p = await dbGet('SELECT * FROM professionals WHERE user_id = ?', [req.user.id]) as any || {};
      const pick = (k: string, col: string) => has(k) ? (b[k] == null ? '' : String(b[k])) : (p[col] ?? '');
      const addressChanged = (has('address') && String(b.address || '') !== String(p.address || ''))
        || (has('city') && String(b.city || '') !== String(p.city || ''))
        || (has('postalCode') && String(b.postalCode || '') !== String(p.postal_code || ''));
      await dbRun('UPDATE professionals SET profession = ?, experience_years = ? WHERE user_id = ?', [
        has('profession') ? (String(b.profession || '').trim().slice(0, 80) || null) : (p.profession ?? null),
        has('experienceYears') ? (Number.isFinite(Number(b.experienceYears)) && b.experienceYears !== '' && b.experienceYears != null ? Math.max(0, Math.min(60, Math.trunc(Number(b.experienceYears)))) : null) : (p.experience_years ?? null),
        req.user.id]);
      await dbRun('UPDATE professionals SET bio = ?, skills = ?, services = ?, hours = ?, mobility = ?, mobility_radius = ?, date_of_birth = ?, availability = ?, address = ?, city = ?, postal_code = ? WHERE user_id = ?', [
        pick('bio', 'bio'), pick('skills', 'skills'), pick('services', 'services'), pick('hours', 'hours'), pick('mobility', 'mobility'),
        has('mobilityRadius') ? (Number(b.mobilityRadius) || 20) : (p.mobility_radius ?? 20),
        has('dateOfBirth') ? (b.dateOfBirth || null) : (p.date_of_birth ?? null),
        has('availability') ? (b.availability ? JSON.stringify(b.availability) : null) : (p.availability ?? null),
        pick('address', 'address').slice(0, 200), pick('city', 'city').slice(0, 100), pick('postalCode', 'postal_code').slice(0, 10),
        req.user.id]);
      if (addressChanged || (p.latitude == null && (p.address || p.city || b.address || b.city))) {
        try { geocode = await geocodeProfessionalByUser(Number(req.user.id)); } catch (e) { console.error('[GEO] pro:', e); geocode = null; }
      }
    }
    const updated = await dbGet('SELECT id, uuid, email, phone, first_name, last_name, role, verified, verification_status FROM users WHERE id = ?', [req.user.id]);
    const pro = req.user.role === 'professional' ? await dbGet('SELECT address, city, postal_code, latitude, longitude, geocode_label, geocode_precision, mobility_radius, profession, experience_years FROM professionals WHERE user_id = ?', [req.user.id]) : undefined;
    return res.json({ message: 'Profil mis à jour.', user: updated, professional: pro, geocoded: geocode === undefined ? undefined : !!geocode });
  } catch (err) { next(err); }
});

/** Version des CGU en vigueur. */
router.get('/terms', (_req, res) => {
  res.json({ termsVersion: TERMS_VERSION, cgu: '/cgu.html', privacy: '/confidentialite.html' });
});

/** Ancien flux SMS : le téléphone est enregistré à l'inscription, sans code. */
router.post('/request-code', (_req, res) => {
  res.status(410).json({ message: 'Pas de code SMS. Le téléphone est enregistré à l’inscription.', smsSent: false });
});

router.post('/verify', (_req, res) => {
  res.status(410).json({ message: 'Pas de vérification SMS. Le téléphone est déjà enregistré.', smsSent: false });
});

export default router;
