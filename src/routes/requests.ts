import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { dbAll, dbGet, dbRun } from '../db.js';
import { authMiddleware } from './_auth.js';
import { geocodeEstablishment } from '../geo.js';
import {
  REQUEST_SOURCES, REQUEST_STATUSES, STATUS_LABELS, POSTES, candidatesFor, createRequest, effectiveStatus, normPoste,
  profileCard, proposeProfile, refuseProposal, requestForEstablishment, setStatus, validateProposal,
} from '../requests.js';
import { notifySafe } from '../notify.js';
import { assertEstablishmentPublish } from '../plans.js';

const router = Router();
const MISSION_SELECT = 'SELECT m.*, c.latitude, c.longitude, c.geocode_precision FROM missions m LEFT JOIN mission_coordinates c ON c.mission_id = m.id';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_RE = /^\d{1,2}[:h]\d{2}$/;

function fail(res: any, err: any) {
  return res.status(err.status || 500).json({ message: err.message || 'Erreur.', code: err.code, identity: err.identity, diploma: err.diploma, extraHt: err.extraHt });
}
function actorOf(req: any) { return { id: Number(req.user.id), role: req.user.isAdmin ? 'admin' : req.user.role }; }
function readSlot(b: any) {
  const date = String(b.date || b.startDate || '').slice(0, 10);
  const startHour = String(b.startHour || b.start || '').replace('h', ':');
  const endHour = String(b.endHour || b.end || '').replace('h', ':');
  if (!DATE_RE.test(date)) return { error: 'Date requise (AAAA-MM-JJ).' };
  if (!HOUR_RE.test(startHour) || !HOUR_RE.test(endHour)) return { error: 'Horaires requis (HH:MM).' };
  return { date, startHour, endHour };
}
async function ownEstablishment(userId: number) {
  return dbGet<any>('SELECT * FROM establishments WHERE user_id = ?', [userId]);
}

/** Liste : admin = toutes les demandes ; établissement = les siennes (avec le profil proposé). */
router.get('/', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (req.user.isAdmin) {
      const rows = await dbAll<any>(MISSION_SELECT + ' ORDER BY m.start_date DESC, m.id DESC');
      const status = String(req.query.status || '');
      const out = [];
      for (const m of rows) {
        const st = effectiveStatus(m);
        if (status && st !== status) continue;
        const counts = await dbGet<any>("SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending FROM applications WHERE mission_id = ?", [m.id]);
        const proposed = m.proposed_application_id ? await dbGet<any>('SELECT professional_name FROM applications WHERE id = ?', [m.proposed_application_id]) : null;
        out.push({ id: m.id, title: m.title, poste: m.poste || normPoste(m.title), establishmentId: m.establishment_id, establishmentName: m.establishment_name,
          date: m.start_date, startHour: m.start_hour, endHour: m.end_hour, urgent: Number(m.urgent) === 1, source: m.request_source || 'plateforme',
          requestStatus: st, requestStatusLabel: STATUS_LABELS[st], notes: m.request_notes || '', refusalReason: m.refusal_reason || null,
          applications: Number(counts?.n || 0), pendingApplications: Number(counts?.pending || 0), proposedName: proposed?.professional_name || null,
          latitude: m.latitude ?? null, longitude: m.longitude ?? null, createdAt: m.created_at });
      }
      return res.json({ statuses: REQUEST_STATUSES.map((s) => ({ code: s, label: STATUS_LABELS[s] })), requests: out });
    }
    if (req.user.role === 'establishment') {
      const est = await ownEstablishment(req.user.id);
      if (!est) return res.json({ requests: [] });
      const rows = await dbAll<any>(MISSION_SELECT + ' WHERE m.establishment_id = ? ORDER BY m.start_date DESC, m.id DESC', [est.id]);
      const out = [];
      for (const m of rows) out.push(await requestForEstablishment(m));
      return res.json({ requests: out });
    }
    return res.status(403).json({ message: 'Réservé aux établissements et à l\'équipe URGAD.' });
  } catch (err) { next(err); }
});

/** Création par l'équipe (téléphone / e-mail / formulaire), pour un établissement existant ou un prospect. */
router.post('/', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ message: 'Réservé à l\'équipe URGAD. Établissement : POST /api/requests/quick.' });
    const b = req.body || {};
    const slot = readSlot(b);
    if ('error' in slot) return res.status(422).json({ message: slot.error });
    const source = String(b.source || 'telephone');
    if (!(REQUEST_SOURCES as readonly string[]).includes(source)) return res.status(422).json({ message: 'Source : telephone, email ou formulaire.' });
    if (!normPoste(b.poste)) return res.status(422).json({ message: 'Poste requis (infirmier, aide-soignant…).' });
    let establishmentId = Number(b.establishmentId) || null;
    let prospectCreated = false;
    if (!establishmentId) {
      const p = b.prospect || {};
      const name = String(p.name || '').trim().slice(0, 200);
      if (!name) return res.status(422).json({ message: 'Choisissez un établissement ou renseignez le nom du prospect.' });
      const email = String(p.email || '').trim().toLowerCase().slice(0, 200);
      if (email) {
        const exists = await dbGet<any>('SELECT u.id, e.id AS est_id FROM users u LEFT JOIN establishments e ON e.user_id = u.id WHERE lower(u.email) = ?', [email]);
        if (exists?.est_id) establishmentId = Number(exists.est_id);
        else if (exists) return res.status(409).json({ message: 'Cet e-mail appartient déjà à un autre compte.' });
      }
      if (!establishmentId) {
        // Compte « prospect » : pas de connexion possible (mot de passe aléatoire) ; l'établissement le récupère en s'inscrivant avec cet e-mail.
        const userEmail = email || `prospect-${uuidv4()}@prospect.urgad.invalid`;
        const ins = await dbRun("INSERT INTO users (uuid, email, password, phone, first_name, last_name, role, verified, verification_status) VALUES (?, ?, ?, ?, ?, ?, 'establishment', 0, 'prospect')",
          [uuidv4(), userEmail, await bcrypt.hash(uuidv4(), 10), String(p.phone || '').slice(0, 40), String(p.contact || '').slice(0, 100), '']);
        let uid = ins.lastInsertRowid as number | null;
        if (uid == null) { const r = await dbGet<any>('SELECT id FROM users WHERE email = ?', [userEmail]); uid = r?.id ?? null; }
        const ei = await dbRun("INSERT INTO establishments (user_id, name, type, phone, email, address, city, postal_code, responsible, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prospect', ?)",
          [uid, name, String(p.type || '').slice(0, 80), String(p.phone || '').slice(0, 40), email, String(p.address || '').slice(0, 200), String(p.city || '').slice(0, 100), String(p.postalCode || '').slice(0, 10), String(p.contact || '').slice(0, 100), source]);
        establishmentId = ei.lastInsertRowid as number | null;
        if (establishmentId == null) { const r = await dbGet<any>('SELECT id FROM establishments WHERE user_id = ?', [uid]); establishmentId = r?.id ?? null; }
        try { await geocodeEstablishment(Number(establishmentId)); } catch (e) { console.error('[GEO] prospect:', e); }
        prospectCreated = true;
      }
    }
    const out = await createRequest({
      establishmentId: Number(establishmentId), poste: String(b.poste), date: slot.date, startHour: slot.startHour, endHour: slot.endHour,
      notes: String(b.notes || '').slice(0, 2000), source, urgent: !!b.urgent, createdBy: actorOf(req), conditions: String(b.conditions || '').slice(0, 300),
    });
    return res.status(201).json({ message: 'Demande créée.', prospectCreated, ...out });
  } catch (err: any) { if (err.status) return fail(res, err); next(err); }
});

/** Formulaire rapide de l'établissement : poste, date, horaires, commentaire. */
router.post('/quick', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (req.user.role !== 'establishment') return res.status(403).json({ message: 'Compte établissement requis.' });
    const est = await ownEstablishment(req.user.id);
    if (!est) return res.status(404).json({ message: 'Établissement non trouvé.' });
    const b = req.body || {};
    const slot = readSlot(b);
    if ('error' in slot) return res.status(422).json({ message: slot.error });
    if (!normPoste(b.poste)) return res.status(422).json({ message: 'Poste requis.' });
    if (slot.date < new Date().toISOString().slice(0, 10)) return res.status(422).json({ message: 'La date doit être aujourd\'hui ou plus tard.' });
    try { await assertEstablishmentPublish(Number(est.id), { urgent: !!b.urgent }); }
    catch (e: any) { if (e?.status) return fail(res, e); throw e; }
    const out = await createRequest({ establishmentId: est.id, poste: String(b.poste), date: slot.date, startHour: slot.startHour, endHour: slot.endHour,
      notes: String(b.comment || b.notes || '').slice(0, 2000), source: 'formulaire', urgent: !!b.urgent, createdBy: actorOf(req) });
    return res.status(201).json({ message: 'Demande envoyée. Nous vous proposons un profil vérifié rapidement.', ...out });
  } catch (err: any) { if (err.status) return fail(res, err); next(err); }
});

/** Détail (admin) : demande, établissement, candidats, suggestions, historique. Établissement : sa demande. */
router.get('/:id', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const m = await dbGet<any>(MISSION_SELECT + ' WHERE m.id = ?', [req.params.id]);
    if (!m) return res.status(404).json({ message: 'Demande introuvable.' });
    if (req.user.role === 'establishment' && !req.user.isAdmin) {
      const est = await ownEstablishment(req.user.id);
      if (!est || Number(est.id) !== Number(m.establishment_id)) return res.status(403).json({ message: 'Non autorisé.' });
      return res.json(await requestForEstablishment(m));
    }
    if (!req.user.isAdmin) return res.status(403).json({ message: 'Non autorisé.' });
    const est = await dbGet<any>('SELECT e.id, e.name, e.type, e.phone, e.email, e.address, e.city, e.postal_code, e.responsible, e.status, e.source, e.latitude, e.longitude FROM establishments e WHERE e.id = ?', [m.establishment_id]);
    const st = effectiveStatus(m);
    const events = await dbAll<any>('SELECT r.*, u.email AS actor_email FROM request_events r LEFT JOIN users u ON u.id = r.actor_user_id WHERE r.mission_id = ? ORDER BY r.id ASC', [m.id]);
    return res.json({
      id: m.id, title: m.title, poste: m.poste || normPoste(m.title), posteLabel: POSTES[m.poste || normPoste(m.title)] || m.title,
      date: m.start_date, startHour: m.start_hour, endHour: m.end_hour, urgent: Number(m.urgent) === 1, location: m.location,
      source: m.request_source || 'plateforme', notes: m.request_notes || m.description || '', requestStatus: st, requestStatusLabel: STATUS_LABELS[st],
      refusalReason: m.refusal_reason || null, latitude: m.latitude ?? null, longitude: m.longitude ?? null, geocodePrecision: m.geocode_precision || null,
      establishment: est,
      proposed: m.proposed_application_id ? await profileCard(Number(m.proposed_application_id), m.id, true) : null,
      backup: m.backup_application_id ? await profileCard(Number(m.backup_application_id), m.id, true) : null,
      ...(await candidatesFor(m.id)),
      events: events.map((e) => ({ at: e.created_at, event: e.event, from: e.from_status, to: e.to_status, actor: e.actor_email || e.actor_role, details: e.details, applicationId: e.application_id })),
    });
  } catch (err) { next(err); }
});

/** Proposer un profil (admin). */
router.post('/:id/propose', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ message: 'Réservé à l\'équipe URGAD.' });
    const b = req.body || {};
    const out = await proposeProfile(Number(req.params.id), { applicationId: Number(b.applicationId) || undefined, userId: Number(b.professionalUserId || b.userId) || undefined }, actorOf(req),
      { backupApplicationId: Number(b.backupApplicationId) || undefined, backupUserId: Number(b.backupUserId) || undefined, replace: b.replace === true, note: String(b.note || '') });
    return res.json({ message: 'Profil proposé à l\'établissement.', ...out });
  } catch (err: any) { if (err.status) return fail(res, err); next(err); }
});

/** Changement de statut manuel (admin) : en_recherche, nouvelle, realisee, annulee. */
router.post('/:id/status', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ message: 'Réservé à l\'équipe URGAD.' });
    const to = String(req.body?.status || '');
    if (!['nouvelle', 'en_recherche', 'realisee', 'annulee'].includes(to)) return res.status(422).json({ message: 'Statut manuel : nouvelle, en_recherche, realisee ou annulee (les autres passent par proposer / valider / refuser).' });
    const m = await dbGet<any>('SELECT * FROM missions WHERE id = ?', [req.params.id]);
    if (!m) return res.status(404).json({ message: 'Demande introuvable.' });
    const from = effectiveStatus(m);
    if (to === 'realisee' && from !== 'validee') return res.status(409).json({ message: 'Seule une demande validée peut être marquée réalisée.' });
    if (from === 'profil_propose' && (to === 'nouvelle' || to === 'en_recherche')) {
      await dbRun("UPDATE applications SET status = 'pending', proposed_at = NULL WHERE id = ? AND status = 'proposed'", [m.proposed_application_id]);
      await dbRun('UPDATE missions SET proposed_application_id = NULL WHERE id = ?', [m.id]);
    }
    await setStatus(Number(m.id), to as any, actorOf(req), 'status_' + to, String(req.body?.reason || '').slice(0, 300));
    const est = await dbGet<any>('SELECT user_id FROM establishments WHERE id = ?', [m.establishment_id]);
    const confirmed = await dbAll<any>("SELECT p.user_id FROM applications a JOIN professionals p ON p.id = a.professional_id WHERE a.mission_id = ? AND a.status IN ('accepted', 'proposed', 'pending')", [m.id]);
    if (to === 'annulee') {
      await notifySafe(Number(est?.user_id), 'Demande annulée', `« ${m.title} » du ${String(m.start_date).slice(0, 10)} est annulée.`, { missionId: m.id, screen: 'requests' }, 'request_cancelled');
      for (const c of confirmed) await notifySafe(Number(c.user_id), 'Mission annulée', `« ${m.title} » chez ${m.establishment_name} (${String(m.start_date).slice(0, 10)}) est annulée.`, { missionId: m.id, screen: 'missions' }, 'mission_cancelled');
      await dbRun("UPDATE applications SET status = 'rejected', reason = 'Mission annulée' WHERE mission_id = ? AND status IN ('pending', 'proposed')", [m.id]);
    } else if (to === 'realisee') {
      await notifySafe(Number(est?.user_id), 'Mission réalisée', `« ${m.title} » du ${String(m.start_date).slice(0, 10)} est marquée réalisée.`, { missionId: m.id, screen: 'requests' }, 'request_completed');
    }
    return res.json({ message: 'Statut mis à jour.', requestStatus: to, from });
  } catch (err) { next(err); }
});

/** L'établissement valide le profil proposé. */
router.post('/:id/validate', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (req.user.role !== 'establishment') return res.status(403).json({ message: 'Compte établissement requis.' });
    const est = await ownEstablishment(req.user.id);
    const m = await dbGet<any>('SELECT establishment_id FROM missions WHERE id = ?', [req.params.id]);
    if (!m) return res.status(404).json({ message: 'Demande introuvable.' });
    if (!est || Number(est.id) !== Number(m.establishment_id)) return res.status(403).json({ message: 'Non autorisé.' });
    const out = await validateProposal(Number(req.params.id), actorOf(req));
    return res.json({ message: 'Profil validé : la mission est confirmée au professionnel.', ...out });
  } catch (err: any) { if (err.status) return fail(res, err); next(err); }
});

/** L'établissement demande un autre profil (motif facultatif). */
router.post('/:id/request-other', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (req.user.role !== 'establishment') return res.status(403).json({ message: 'Compte établissement requis.' });
    const est = await ownEstablishment(req.user.id);
    const m = await dbGet<any>('SELECT establishment_id FROM missions WHERE id = ?', [req.params.id]);
    if (!m) return res.status(404).json({ message: 'Demande introuvable.' });
    if (!est || Number(est.id) !== Number(m.establishment_id)) return res.status(403).json({ message: 'Non autorisé.' });
    const out = await refuseProposal(Number(req.params.id), String(req.body?.reason || ''), actorOf(req));
    return res.json({ message: 'Demande transmise : nous vous proposons un autre profil.', ...out });
  } catch (err: any) { if (err.status) return fail(res, err); next(err); }
});

export default router;
