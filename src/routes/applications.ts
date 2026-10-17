import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { dbRun, dbGet, dbAll } from '../db.js';
import { config } from '../config.js';
import { notifyAdmins, notifySafe } from '../notify.js';
import { effectiveStatus, normPoste, POSTES, profileCard, refuseProposal, setStatus, validateProposal } from '../requests.js';

/** Utilisateur pro d'une candidature : e-mail d'abord (fiable), sinon professional_id. */
export async function proUserIdForApplication(app: any): Promise<number | null> {
  if (app?.professional_email) {
    const u = await dbGet("SELECT id FROM users WHERE lower(email) = lower(?) AND role = 'professional'", [app.professional_email]) as any;
    if (u) return Number(u.id);
  }
  const p = await dbGet('SELECT user_id FROM professionals WHERE id = ?', [app?.professional_id]) as any;
  return p ? Number(p.user_id) : null;
}

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

/** Candidater à une mission */
router.post('/', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const { missionId } = req.body;
    if (!missionId) return res.status(422).json({ message: 'ID de mission requis.' });
    const mission = await dbGet('SELECT * FROM missions WHERE id = ?', [missionId]) as any;
    if (!mission) return res.status(404).json({ message: 'Mission non trouvée.' });
    if (mission.status === 'cancelled') return res.status(409).json({ message: 'Mission annulée.' });
    if (mission.status === 'completed') return res.status(409).json({ message: 'Mission terminée.' });
    if (['validee', 'realisee', 'annulee'].includes(effectiveStatus(mission))) return res.status(409).json({ message: 'Mission déjà pourvue.' });
    const prof = await dbGet('SELECT p.id, p.profession, u.first_name, u.last_name, u.email, u.phone, u.verification_status FROM professionals p JOIN users u ON u.id = p.user_id WHERE p.user_id = ?', [req.user.id]) as any;
    if (!prof) return res.status(404).json({ message: 'Professionnel non trouvé.' });
    if (prof.verification_status === 'suspended') return res.status(403).json({ message: 'Compte suspendu. Contactez URGAD.' });
    const existing = await dbGet('SELECT id FROM applications WHERE mission_id = ? AND professional_id = ?', [missionId, prof.id]);
    if (existing) return res.status(409).json({ message: 'Vous avez déjà candidaté.' });
    const appUuid = uuidv4();
    await dbRun('INSERT INTO applications (uuid, mission_id, professional_id, professional_name, professional_role, professional_email, professional_phone, status, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [appUuid, missionId, prof.id, `${prof.first_name} ${prof.last_name}`, POSTES[normPoste(prof.profession)] || prof.profession || 'Professionnel', prof.email, prof.phone, 'pending', 'candidature']);
    await dbRun('UPDATE missions SET application_count = application_count + 1 WHERE id = ?', [missionId]);
    const app = await dbGet('SELECT * FROM applications WHERE uuid = ?', [appUuid]) as any;
    // Nouveau modèle : l'équipe URGAD présélectionne ; l'établissement ne reçoit que le profil proposé.
    if (effectiveStatus(mission) === 'nouvelle') await setStatus(Number(mission.id), 'en_recherche', { id: Number(req.user.id), role: 'professional' }, 'first_application', '', app?.id ?? null);
    const notified = await notifyAdmins('Nouvelle candidature',
      `${prof.first_name} ${prof.last_name} a postulé à « ${mission.title} » — ${mission.establishment_name} (${String(mission.start_date).slice(0, 10)}).`,
      { missionId: mission.id, applicationId: app?.id, screen: 'requests' }, 'application_received');
    return res.status(201).json({ ...app, notifiedAdmins: notified });
  } catch (err) { next(err); }
});

/** Mes candidatures (pro) */
router.get('/my', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const prof = await dbGet('SELECT id FROM professionals WHERE user_id = ?', [req.user.id]) as any;
    if (!prof) return res.json([]);
    const apps = await dbAll('SELECT a.*, m.title, m.type, m.start_date, m.start_hour, m.end_hour, m.establishment_name, m.location, m.status as mission_status, m.request_status FROM applications a JOIN missions m ON m.id = a.mission_id WHERE a.professional_id = ? ORDER BY a.created_at DESC', [prof.id]) as any[];
    const LABELS: Record<string, string> = { pending: 'En attente', proposed: 'Proposé à l\'établissement', accepted: 'Confirmé', rejected: 'Non retenu', withdrawn: 'Retirée' };
    return res.json(apps.map((a) => ({ ...a, status_label: LABELS[a.status] || a.status })));
  } catch (err) { next(err); }
});

/** Candidatures d'une mission (établissement/admin) */
router.get('/mission/:missionId', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const mission = await dbGet('SELECT * FROM missions WHERE id = ?', [req.params.missionId]) as any;
    if (!mission) return res.status(404).json({ message: 'Mission non trouvée.' });
    if (req.user.role === 'establishment') {
      const estId = await dbGet('SELECT id FROM establishments WHERE user_id = ?', [req.user.id]) as any;
      if (!estId || mission.establishment_id !== estId?.id) return res.status(403).json({ message: 'Non autorisé.' });
      // L'établissement ne parcourt pas la liste : seulement le profil proposé / confirmé, sous forme de carte.
      const visible = await dbAll("SELECT id, status FROM applications WHERE mission_id = ? AND status IN ('proposed', 'accepted')", [req.params.missionId]) as any[];
      const cards = [];
      for (const v of visible) cards.push({ id: v.id, status: v.status, ...(await profileCard(Number(v.id), Number(mission.id), v.status === 'accepted')) });
      return res.json(cards);
    } else if (!req.user.isAdmin) return res.status(403).json({ message: 'Admin ou établissement uniquement.' });
    const apps = await dbAll('SELECT a.*, u.first_name, u.last_name, p.bio, p.skills FROM applications a JOIN professionals p ON p.id = a.professional_id JOIN users u ON u.id = p.user_id WHERE a.mission_id = ? ORDER BY a.created_at DESC', [req.params.missionId]);
    return res.json(apps);
  } catch (err) { next(err); }
});

/** Accepter */
router.post('/:id/accept', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const app = await dbGet('SELECT * FROM applications WHERE id = ?', [req.params.id]) as any;
    if (!app) return res.status(404).json({ message: 'Candidature non trouvée.' });
    const mission = await dbGet('SELECT * FROM missions WHERE id = ?', [app.mission_id]) as any;
    if (!mission) return res.status(404).json({ message: 'Mission non trouvée.' });
    if (req.user.role === 'establishment') {
      const estId = await dbGet('SELECT id FROM establishments WHERE user_id = ?', [req.user.id]) as any;
      if (!estId || mission.establishment_id !== estId?.id) return res.status(403).json({ message: 'Non autorisé.' });
      if (app.status !== 'proposed') return res.status(409).json({ message: 'Seul le profil proposé par URGAD peut être validé.' });
      try { return res.json({ message: 'Profil validé.', ...(await validateProposal(Number(mission.id), { id: Number(req.user.id), role: 'establishment' })) }); }
      catch (e: any) { return res.status(e.status || 500).json({ message: e.message }); }
    } else if (!req.user.isAdmin) return res.status(403).json({ message: 'Admin ou établissement uniquement.' });
    await dbRun('UPDATE applications SET status = \'accepted\' WHERE id = ?', [req.params.id]);
    await notifySafe(await proUserIdForApplication(app), 'Candidature acceptée ✅',
      `${mission.establishment_name} a accepté votre candidature pour « ${mission.title} » le ${String(mission.start_date).slice(0, 10)}${mission.start_hour ? ' à ' + mission.start_hour : ''}.`,
      { missionId: mission.id, applicationId: app.id, screen: 'missions' }, 'application_accepted');
    return res.json({ message: 'Candidature acceptée.' });
  } catch (err) { next(err); }
});

/** Refuser */
router.post('/:id/reject', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const app = await dbGet('SELECT * FROM applications WHERE id = ?', [req.params.id]) as any;
    if (!app) return res.status(404).json({ message: 'Candidature non trouvée.' });
    const mission = await dbGet('SELECT * FROM missions WHERE id = ?', [app.mission_id]) as any;
    if (!mission) return res.status(404).json({ message: 'Mission non trouvée.' });
    if (req.user.role === 'establishment') {
      const estId = await dbGet('SELECT id FROM establishments WHERE user_id = ?', [req.user.id]) as any;
      if (!estId || mission.establishment_id !== estId?.id) return res.status(403).json({ message: 'Non autorisé.' });
      if (app.status !== 'proposed') return res.status(409).json({ message: 'Seul le profil proposé par URGAD peut être refusé.' });
      try { return res.json({ message: 'Autre profil demandé.', ...(await refuseProposal(Number(mission.id), String(req.body?.reason || ''), { id: Number(req.user.id), role: 'establishment' })) }); }
      catch (e: any) { return res.status(e.status || 500).json({ message: e.message }); }
    } else if (!req.user.isAdmin) return res.status(403).json({ message: 'Admin ou établissement uniquement.' });
    const { reason } = req.body;
    await dbRun('UPDATE applications SET status = \'rejected\', reason = ? WHERE id = ?', [reason || '', req.params.id]);
    await notifySafe(await proUserIdForApplication(app), 'Candidature non retenue',
      `${mission.establishment_name} n'a pas retenu votre candidature pour « ${mission.title} »${reason ? ' : ' + String(reason).slice(0, 200) : '.'}`,
      { missionId: mission.id, applicationId: app.id, screen: 'missions' }, 'application_rejected');
    return res.json({ message: 'Candidature refusée.' });
  } catch (err) { next(err); }
});

/** Retirer */
router.post('/:id/withdraw', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const app = await dbGet('SELECT * FROM applications WHERE id = ?', [req.params.id]) as any;
    if (!app) return res.status(404).json({ message: 'Candidature non trouvée.' });
    const prof = await dbGet('SELECT id FROM professionals WHERE user_id = ?', [req.user.id]) as any;
    if (!prof || app.professional_id !== prof.id) return res.status(403).json({ message: 'Non autorisé.' });
    if (app.status !== 'pending') return res.status(409).json({ message: 'Impossible de retirer une candidature traitée.' });
    await dbRun('UPDATE applications SET status = \'withdrawn\' WHERE id = ?', [req.params.id]);
    await dbRun('UPDATE missions SET application_count = application_count - 1 WHERE id = ?', [app.mission_id]);
    return res.json({ message: 'Candidature retirée.' });
  } catch (err) { next(err); }
});

export default router;
