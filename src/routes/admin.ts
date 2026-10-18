import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { dbRun, dbGet, dbAll } from '../db.js';
import { config } from '../config.js';
import { notify, notifySafe, pushStatus } from '../notify.js';
import { resolveFileBytes } from '../uploads.js';
import { backfillCoordinates, haversineKm, num } from '../geo.js';
import { proUserIdForApplication } from './applications.js';
import { notifyProsForMission } from '../matching.js';

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

function requireAdmin(req: any, res: any, next: any) {
  if (!req.user?.isAdmin) return res.status(403).json({ message: 'Accès réservé aux administrateurs.' });
  next();
}

// Stats dashboard
router.get('/stats', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const professionals = await dbGet('SELECT COUNT(*) as count FROM users WHERE role = \'professional\'') as any;
    const establishments = await dbGet('SELECT COUNT(*) as count FROM users WHERE role = \'establishment\'') as any;
    const missions = await dbGet('SELECT COUNT(*) as count FROM missions WHERE status != \'cancelled\'') as any;
    const applications = await dbGet('SELECT COUNT(*) as count FROM applications') as any;
    const pendingVerification = await dbGet('SELECT COUNT(*) as count FROM users WHERE verification_status = \'pending\'') as any;
    const activeUsers = await dbGet('SELECT COUNT(*) as count FROM users WHERE last_login >= datetime(\'now\', \'-7 days\')') as any;
    return res.json({
      professionals: professionals?.count || 0,
      establishments: establishments?.count || 0,
      missions: missions?.count || 0,
      applications: applications?.count || 0,
      pendingVerification: pendingVerification?.count || 0,
      activeUsers: activeUsers?.count || 0,
    });
  } catch (err) { next(err); }
});

// Professionnels récents (admin)
router.get('/professionals/recent', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const pros = await dbAll('SELECT u.id, u.email, u.phone, u.first_name, u.last_name, u.role, u.verified, u.verification_status, u.created_at FROM users u WHERE u.role = \'professional\' ORDER BY u.created_at DESC LIMIT 20');
    return res.json(pros);
  } catch (err) { next(err); }
});

// Missions récentes (admin)
router.get('/missions/recent', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const missions = await dbAll('SELECT * FROM missions ORDER BY created_at DESC LIMIT 10');
    return res.json(missions);
  } catch (err) { next(err); }
});

// Candidatures récentes (admin)
router.get('/applications/recent', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const apps = await dbAll('SELECT a.*, u.first_name, u.last_name FROM applications a JOIN professionals p ON p.id = a.professional_id JOIN users u ON u.id = p.user_id ORDER BY a.created_at DESC LIMIT 20');
    return res.json(apps);
  } catch (err) { next(err); }
});

// Gestion professionnels (admin)
router.get('/professionals', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const { status } = req.query;
    let query = 'SELECT u.*, p.* FROM users u LEFT JOIN professionals p ON p.user_id = u.id WHERE u.role = \'professional\'';
    if (status === 'approved') query += " AND u.verified = 1 AND u.verification_status = 'approved'";
    else if (status === 'pending') query += " AND (u.verified = 0 OR u.verification_status = 'pending')";
    query += ' ORDER BY u.created_at DESC';
    const pros = await dbAll(query);
    return res.json(pros.map(({ password, ...rest }: any) => rest));
  } catch (err) { next(err); }
});

// Détail professionnel (admin)
router.get('/professionals/:id', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const prof = await dbGet('SELECT u.*, p.* FROM users u LEFT JOIN professionals p ON p.user_id = u.id WHERE u.id = ? AND u.role = \'professional\'', [req.params.id]) as any;
    if (!prof) return res.status(404).json({ message: 'Professionnel non trouvé.' });
    const applications = await dbAll('SELECT a.*, m.title, m.type, m.start_date, m.establishment_name FROM applications a JOIN missions m ON m.id = a.mission_id WHERE a.professional_id = (SELECT id FROM professionals WHERE user_id = ?) ORDER BY a.created_at DESC', [prof.id]);
    const missions = await dbAll('SELECT m.* FROM missions m JOIN applications a ON a.mission_id = m.id WHERE a.professional_id = (SELECT id FROM professionals WHERE user_id = ?) AND m.status = \'completed\' ORDER BY m.start_date DESC', [prof.id]);
    const notifications = await dbAll('SELECT * FROM notifications WHERE recipient_id = (SELECT id FROM professionals WHERE user_id = ?) ORDER BY created_at DESC LIMIT 20', [prof.id]);
    return res.json({ ...prof, applications, missions, notifications });
  } catch (err) { next(err); }
});

// Renoyer code (admin)
router.post('/professionals/:id/resend-verification', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const prof = await dbGet('SELECT * FROM users WHERE id = ?', [req.params.id]) as any;
    if (!prof) return res.status(404).json({ message: 'Professionnel non trouvé.' });
    return res.status(410).json({ message: 'Pas de SMS. Le téléphone du professionnel est celui saisi à l’inscription.', smsSent: false });
  } catch (err) { next(err); }
});

// Approuver (admin)
router.post('/professionals/:id/approve-verification', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    await dbRun('UPDATE users SET verified = 1, verification_status = \'approved\' WHERE id = ?', [req.params.id]);
    // Identité et diplôme se vérifient séparément (POST /api/verification/:userId/review) : on ne touche qu'aux autres documents.
    await dbRun("UPDATE professional_documents SET status = 'approved' WHERE user_id = ? AND status = 'pending' AND (category IS NULL OR category = 'other')", [req.params.id]);
    await notifySafe(Number(req.params.id), 'Profil vérifié ✅', 'Vos documents ont été validés. Vous pouvez postuler aux missions.', { screen: 'my-documents' }, 'verification_approved');
    return res.json({ message: 'Professionnel vérifié.' });
  } catch (err) { next(err); }
});

router.post('/professionals/:id/suspend', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ? AND role = \'professional\'', [req.params.id]) as any;
    if (!user) return res.status(404).json({ message: 'Professionnel non trouvé.' });
    await dbRun("UPDATE users SET verification_status = 'suspended', verified = 0 WHERE id = ?", [req.params.id]);
    await notifySafe(Number(req.params.id), 'Compte suspendu', 'Votre compte professionnel est suspendu. Vous ne pouvez plus postuler. Contactez URGAD.', { screen: 'profile' }, 'verification_rejected');
    await dbRun('INSERT INTO audit_log (uuid, user_id, user_email, action, resource, details) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), req.user.id, req.user.email, 'suspend_professional', 'user:' + req.params.id, user.email]);
    return res.json({ message: 'Professionnel suspendu.' });
  } catch (err) { next(err); }
});

router.post('/professionals/:id/unsuspend', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ? AND role = \'professional\'', [req.params.id]) as any;
    if (!user) return res.status(404).json({ message: 'Professionnel non trouvé.' });
    await dbRun("UPDATE users SET verification_status = 'approved', verified = 1 WHERE id = ?", [req.params.id]);
    await notifySafe(Number(req.params.id), 'Compte réactivé', 'Votre compte professionnel est de nouveau actif.', { screen: 'home' }, 'verification_approved');
    await dbRun('INSERT INTO audit_log (uuid, user_id, user_email, action, resource, details) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), req.user.id, req.user.email, 'unsuspend_professional', 'user:' + req.params.id, user.email]);
    return res.json({ message: 'Professionnel réactivé.' });
  } catch (err) { next(err); }
});

// Refuser (admin)
router.post('/professionals/:id/reject-verification', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const { reason } = req.body;
    await dbRun('UPDATE users SET verification_status = \'rejected\' WHERE id = ?', [req.params.id]);
    await notifySafe(Number(req.params.id), 'Vérification refusée', 'Vos documents n\'ont pas pu être validés' + (reason ? ' : ' + String(reason).slice(0, 300) : '.') + ' Merci de déposer un document lisible et à jour.', { screen: 'my-documents' }, 'verification_rejected');
    return res.json({ message: 'Vérification refusée.', reason: reason || '' });
  } catch (err) { next(err); }
});

// Établissements (admin)
router.get('/establishments', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const ests = await dbAll(`SELECT e.*, u.email, u.phone, u.first_name, u.last_name, u.verification_status AS user_verification_status,
      (SELECT name FROM establishment_subscriptions WHERE establishment_id = e.id ORDER BY id DESC LIMIT 1) AS subscription_name,
      (SELECT status FROM establishment_subscriptions WHERE establishment_id = e.id ORDER BY id DESC LIMIT 1) AS subscription_status,
      (SELECT price FROM establishment_subscriptions WHERE establishment_id = e.id ORDER BY id DESC LIMIT 1) AS subscription_price,
      (SELECT COUNT(*) FROM establishment_documents WHERE establishment_id = e.id) AS document_count
    FROM establishments e JOIN users u ON u.id = e.user_id ORDER BY e.created_at DESC`);
    return res.json(ests);
  } catch (err) { next(err); }
});


router.get('/establishments/:id/documents', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const estab = await dbGet('SELECT id FROM establishments WHERE id = ?', [req.params.id]) as any;
    if (!estab) return res.status(404).json({ message: 'Établissement non trouvé.' });
    const rows = await dbAll('SELECT * FROM establishment_documents WHERE establishment_id = ? ORDER BY id DESC', [estab.id]);
    const out = [];
    for (const row of rows || []) {
      const file = await dbGet('SELECT id, stored_name, mime_type, size_bytes FROM document_files WHERE owner_type = ? AND document_id = ? ORDER BY id DESC LIMIT 1', ['establishment', (row as any).id]) as any;
      out.push({
        id: (row as any).id,
        establishmentId: (row as any).establishment_id,
        name: (row as any).name,
        type: (row as any).doc_type || '',
        status: (row as any).status || 'pending',
        createdAt: (row as any).created_at || null,
        fileStored: !!file,
        storage: file ? 'database' : 'metadata',
        sizeBytes: file?.size_bytes || 0,
        storedName: file?.stored_name || null,
        mimeType: file?.mime_type || null
      });
    }
    return res.json(out);
  } catch (err) { next(err); }
});

router.get('/establishments/:id/documents/:docId/file', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const d = await dbGet<any>('SELECT d.id, d.name, d.establishment_id FROM establishment_documents d WHERE d.id = ? AND d.establishment_id = ?', [req.params.docId, req.params.id]);
    if (!d) return res.status(404).json({ message: 'Document introuvable.' });
    const file = await dbGet<any>('SELECT stored_name, mime_type, file_bytes FROM document_files WHERE owner_type = ? AND document_id = ? ORDER BY id DESC LIMIT 1', ['establishment', d.id]);
    const bytes = resolveFileBytes(file?.stored_name, file?.file_bytes);
    if (!bytes) {
      return res.status(404).json({
        message: 'Fichier absent du serveur. Les justificatifs déposés avant la conservation en base ont été perdus : l’établissement doit les envoyer à nouveau.',
      });
    }
    await dbRun('INSERT INTO audit_log (uuid, user_id, user_email, action, resource, details) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), req.user.id, req.user.email || null, 'document_view', 'establishment_document:' + d.id, d.name]);
    res.setHeader('Content-Type', file?.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="etab-document-${d.id}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(bytes);
  } catch (err) { next(err); }
});

router.post('/establishments/:id/request-documents', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const estab = await dbGet<any>('SELECT * FROM establishments WHERE id = ?', [req.params.id]);
    if (!estab) return res.status(404).json({ message: 'Établissement non trouvé.' });
    const message = String(req.body?.message || '').trim().slice(0, 500);
    if (!message) return res.status(422).json({ message: 'Indiquez le document manquant ou illisible.' });
    const nextStatus = estab.status === 'rejected' ? 'pending' : estab.status;
    await dbRun("UPDATE establishments SET document_request_message = ?, document_request_at = datetime('now'), document_request_by = ?, status = ? WHERE id = ?",
      [message, String(req.user.email || 'admin#' + req.user.id), nextStatus, estab.id]);
    const user = await dbGet<any>('SELECT verification_status FROM users WHERE id = ?', [estab.user_id]);
    if (user && user.verification_status === 'rejected') {
      await dbRun("UPDATE users SET verification_status = 'pending', verified = 0 WHERE id = ?", [estab.user_id]);
    }
    await notifySafe(Number(estab.user_id), 'Complément de documents demandé', message, { screen: 'documents' }, 'admin_document');
    await dbRun('INSERT INTO audit_log (uuid, user_id, user_email, action, resource, details) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), req.user.id, req.user.email || null, 'establishment_request_documents', 'establishment:' + estab.id, message]);
    return res.json({ message: 'Demande envoyée à l’établissement.' });
  } catch (err) { next(err); }
});

router.post('/establishments/:id/approve', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const estab = await dbGet('SELECT * FROM establishments WHERE id = ?', [req.params.id]) as any;
    if (!estab) return res.status(404).json({ message: 'Établissement non trouvé.' });
    await dbRun("UPDATE establishments SET status = ?, document_request_message = NULL, document_request_at = NULL, document_request_by = NULL WHERE id = ?", ['approved', estab.id]);
    await dbRun('UPDATE users SET verified = 1, verification_status = ? WHERE id = ?', ['approved', estab.user_id]);
    await dbRun("UPDATE establishment_documents SET status = 'approved' WHERE establishment_id = ? AND status = 'pending'", [estab.id]);
    await notifySafe(Number(estab.user_id), 'Établissement validé ✅', `${estab.name} est validé. Vous pouvez publier vos missions.`, { screen: 'dashboard' }, 'establishment_approved');
    const updated = await dbGet('SELECT * FROM establishments WHERE id = ?', [estab.id]);
    return res.json({ message: 'Établissement approuvé.', establishment: updated });
  } catch (err) { next(err); }
});

router.post('/establishments/:id/suspend', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const estab = await dbGet('SELECT * FROM establishments WHERE id = ?', [req.params.id]) as any;
    if (!estab) return res.status(404).json({ message: 'Établissement non trouvé.' });
    await dbRun("UPDATE establishments SET status = 'suspended' WHERE id = ?", [estab.id]);
    await dbRun("UPDATE users SET verification_status = 'suspended', verified = 0 WHERE id = ?", [estab.user_id]);
    await notifySafe(Number(estab.user_id), 'Compte suspendu', `${estab.name} est suspendu. Vous ne pouvez plus publier de demandes. Contactez URGAD.`, { screen: 'profile' }, 'establishment_rejected');
    await dbRun('INSERT INTO audit_log (uuid, user_id, user_email, action, resource, details) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), req.user.id, req.user.email, 'suspend_establishment', 'establishment:' + estab.id, estab.name]);
    return res.json({ message: 'Établissement suspendu.' });
  } catch (err) { next(err); }
});

router.post('/establishments/:id/unsuspend', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const estab = await dbGet('SELECT * FROM establishments WHERE id = ?', [req.params.id]) as any;
    if (!estab) return res.status(404).json({ message: 'Établissement non trouvé.' });
    await dbRun("UPDATE establishments SET status = 'approved' WHERE id = ?", [estab.id]);
    await dbRun("UPDATE users SET verification_status = 'approved', verified = 1 WHERE id = ?", [estab.user_id]);
    await notifySafe(Number(estab.user_id), 'Compte réactivé', `${estab.name} est de nouveau actif. Vous pouvez publier des demandes.`, { screen: 'dashboard' }, 'establishment_approved');
    await dbRun('INSERT INTO audit_log (uuid, user_id, user_email, action, resource, details) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), req.user.id, req.user.email, 'unsuspend_establishment', 'establishment:' + estab.id, estab.name]);
    return res.json({ message: 'Établissement réactivé.' });
  } catch (err) { next(err); }
});

router.post('/establishments/:id/reject', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const estab = await dbGet('SELECT * FROM establishments WHERE id = ?', [req.params.id]) as any;
    if (!estab) return res.status(404).json({ message: 'Établissement non trouvé.' });
    await dbRun('UPDATE establishments SET status = ? WHERE id = ?', ['rejected', estab.id]);
    await dbRun('UPDATE users SET verified = 0, verification_status = ? WHERE id = ?', ['rejected', estab.user_id]);
    await notifySafe(Number(estab.user_id), 'Établissement non validé', `${estab.name} n'a pas été validé` + (req.body?.reason ? ' : ' + String(req.body.reason).slice(0, 300) : '.') + ' Contactez le support URGAD.', { screen: 'documents' }, 'establishment_rejected');
    const updated = await dbGet('SELECT * FROM establishments WHERE id = ?', [estab.id]);
    return res.json({ message: 'Établissement refusé.', reason: req.body?.reason || '', establishment: updated });
  } catch (err) { next(err); }
});

// Missions (admin)
router.get('/missions', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const { status } = req.query;
    let query = 'SELECT m.*, c.latitude, c.longitude, c.geocode_precision, c.source AS coordinates_source FROM missions m LEFT JOIN mission_coordinates c ON c.mission_id = m.id';
    const params: any[] = [];
    if (status) { query += ' WHERE m.status = ?'; params.push(String(status)); }
    query += ' ORDER BY m.start_date DESC';
    const missions = await dbAll(query, params);
    return res.json(missions);
  } catch (err) { next(err); }
});

// Détail mission (admin)
router.get('/missions/:id', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const mission = await dbGet('SELECT * FROM missions WHERE id = ?', [req.params.id]) as any;
    if (!mission) return res.status(404).json({ message: 'Mission non trouvée.' });
    const applications = await dbAll('SELECT a.*, u.first_name, u.last_name, p.bio, p.skills FROM applications a JOIN professionals p ON p.id = a.professional_id JOIN users u ON u.id = p.user_id WHERE a.mission_id = ? ORDER BY a.created_at DESC', [req.params.id]);
    return res.json({ ...mission, applications });
  } catch (err) { next(err); }
});

router.post('/missions/:id/notify', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const mission = await dbGet('SELECT * FROM missions WHERE id = ?', [req.params.id]) as any;
    if (!mission) return res.status(404).json({ message: 'Mission non trouvée.' });
    if (req.body?.flash) {
      await dbRun('UPDATE missions SET urgent = 1, visible = 1 WHERE id = ?', [req.params.id]);
    } else {
      await dbRun('UPDATE missions SET visible = 1 WHERE id = ?', [req.params.id]);
    }
    const notified = await notifyProsForMission(Number(req.params.id), { force: true });
    await dbRun('INSERT INTO audit_log (uuid, user_id, user_email, action, resource, details) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), req.user.id, req.user.email, req.body?.flash ? 'mission_flash' : 'mission_notify', 'mission:' + req.params.id, String(notified)]);
    return res.json({ message: notified ? `${notified} professionnel(s) notifié(s) dans le rayon.` : 'Aucun professionnel dans le rayon (adresse manquante ou hors zone).', notified });
  } catch (err) { next(err); }
});

// Modifier statut mission (admin)
router.patch('/missions/:id/status', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const { status } = req.body;
    if (!['published', 'completed', 'cancelled', 'pending', 'open'].includes(status)) return res.status(422).json({ message: 'Statut invalide.' });
    const mapped = status === 'open' ? 'published' : status;
    const mission = await dbGet('SELECT * FROM missions WHERE id = ?', [req.params.id]) as any;
    if (!mission) return res.status(404).json({ message: 'Mission non trouvée.' });
    await dbRun('UPDATE missions SET status = ? WHERE id = ?', [mapped, req.params.id]);
    if (mapped === 'published') await dbRun('UPDATE missions SET visible = 1 WHERE id = ?', [req.params.id]);
    if (mapped === 'cancelled') await dbRun('UPDATE missions SET visible = 0 WHERE id = ?', [req.params.id]);
    await dbRun('INSERT INTO audit_log (uuid, user_id, user_email, action, resource, details) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), req.user.id, req.user.email, 'mission_status', 'mission:' + req.params.id, mapped]);
    const est = await dbGet('SELECT user_id FROM establishments WHERE id = ?', [mission.establishment_id]) as any;
    if (est?.user_id) {
      const labels: Record<string, string> = { published: 'Mission publiée', completed: 'Mission marquée terminée', cancelled: 'Mission annulée', pending: 'Mission en attente' };
      await notifySafe(Number(est.user_id), labels[mapped] || 'Mission mise à jour',
        `${mission.establishment_name || ''} — « ${mission.title || ''} » (${String(mission.start_date || '').slice(0, 10)})`,
        { missionId: mission.id, screen: 'missions' }, 'mission_status');
    }
    return res.json({ message: `Mission mise à jour avec statut "${mapped}".` });
  } catch (err) { next(err); }
});

// Candidatures (admin)
router.get('/applications', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const apps = await dbAll('SELECT a.*, m.title, m.establishment_name, u.first_name, u.last_name, p.bio, p.skills FROM applications a JOIN missions m ON m.id = a.mission_id JOIN professionals p ON p.id = a.professional_id JOIN users u ON u.id = p.user_id ORDER BY a.created_at DESC');
    return res.json(apps);
  } catch (err) { next(err); }
});

// Modifier candidature (admin)
router.put('/applications/:id', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const { status, reason } = req.body;
    if (status && !['pending', 'accepted', 'rejected', 'withdrawn', 'proposed'].includes(String(status))) {
      return res.status(422).json({ message: 'Statut de candidature invalide.' });
    }
    const before = await dbGet('SELECT a.*, m.title, m.establishment_name, m.start_date FROM applications a LEFT JOIN missions m ON m.id = a.mission_id WHERE a.id = ?', [req.params.id]) as any;
    if (!before) return res.status(404).json({ message: 'Candidature introuvable.' });
    await dbRun('UPDATE applications SET status = ?, reason = ? WHERE id = ?', [status || 'pending', reason || '', req.params.id]);
    if (before && before.status !== status && (status === 'accepted' || status === 'rejected')) {
      const uid = await proUserIdForApplication(before);
      if (uid) {
        await notifySafe(uid, status === 'accepted' ? 'Candidature acceptée ✅' : 'Candidature non retenue',
          `${before.establishment_name || 'L\'établissement'} — « ${before.title || 'mission'} » (${String(before.start_date || '').slice(0, 10)})`,
          { missionId: before.mission_id, applicationId: before.id, screen: 'missions' }, status === 'accepted' ? 'application_accepted' : 'application_rejected');
      }
    }
    return res.json({ message: 'Candidature mise à jour.' });
  } catch (err) { next(err); }
});

// Messages (admin: conversations)
router.get('/messages/conversations', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const conversations = await dbAll(`
      SELECT DISTINCT m.conversation_id,
        (SELECT m2.content FROM messages m2 WHERE m2.conversation_id = m.conversation_id ORDER BY m2.created_at DESC LIMIT 1) as last_message,
        (SELECT m2.created_at FROM messages m2 WHERE m2.conversation_id = m.conversation_id ORDER BY m2.created_at DESC LIMIT 1) as last_message_date,
        (SELECT COUNT(*) FROM messages m2 WHERE m2.conversation_id = m.conversation_id) as message_count
      FROM messages m
      GROUP BY m.conversation_id
      ORDER BY last_message_date DESC
    `);
    return res.json(conversations);
  } catch (err) { next(err); }
});

// Messages (admin: tous)
router.get('/messages', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const messages = await dbAll('SELECT * FROM messages ORDER BY created_at DESC LIMIT 500');
    return res.json(messages);
  } catch (err) { next(err); }
});

// Notifications (admin: toutes)
router.get('/notifications', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const notifications = await dbAll('SELECT * FROM notifications ORDER BY created_at DESC');
    return res.json(notifications);
  } catch (err) { next(err); }
});

// Envoyer notification (admin)
router.post('/notifications/send', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const { userId, recipientId, recipientType, type, title, content } = req.body;
    if ((!recipientId && !userId) || !title) return res.status(422).json({ message: 'Destinataire et titre requis.' });
    let target: number | null = userId != null ? Number(userId) : null;
    if (target == null) {
      if (recipientType === 'professional') target = (await dbGet('SELECT user_id FROM professionals WHERE id = ?', [recipientId]) as any)?.user_id ?? null;
      else if (recipientType === 'establishment') target = (await dbGet('SELECT user_id FROM establishments WHERE id = ?', [recipientId]) as any)?.user_id ?? null;
      else target = Number(recipientId);
    }
    if (target == null) return res.status(404).json({ message: 'Destinataire introuvable.' });
    const result = await notify(Number(target), String(title), String(content || ''), {}, String(type || 'admin'));
    return res.status(201).json({ message: 'Notification envoyée.', ...result });
  } catch (err) { next(err); }
});

/** Une notification (in-app + push si Firebase configuré) par utilisateur ciblé. Pas d'SMS, pas d'e-mail. */
router.post('/notifications/bulk', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const audience = String(req.body?.audience || '').trim();
    const title = String(req.body?.title || '').trim().slice(0, 180);
    const content = String(req.body?.content || '').trim().slice(0, 2000);
    const type = String(req.body?.type || 'admin').trim().slice(0, 40) || 'admin';
    if (!title) return res.status(422).json({ message: 'Titre requis.' });
    const allowed = ['professionals', 'establishments', 'verified_professionals', 'all'];
    if (!allowed.includes(audience)) return res.status(422).json({ message: 'Audience inconnue.' });
    const userIds: number[] = [];
    if (audience === 'professionals' || audience === 'all') {
      const rows = await dbAll("SELECT p.user_id FROM professionals p JOIN users u ON u.id = p.user_id WHERE u.deleted_at IS NULL") as any[];
      for (const row of rows || []) userIds.push(Number(row.user_id));
    }
    if (audience === 'verified_professionals') {
      const rows = await dbAll("SELECT p.user_id FROM professionals p JOIN users u ON u.id = p.user_id WHERE u.deleted_at IS NULL AND u.verification_status NOT IN ('suspended','rejected') AND p.identity_status = 'verifie' AND p.diploma_status = 'verifie'") as any[];
      for (const row of rows || []) userIds.push(Number(row.user_id));
    }
    if (audience === 'establishments' || audience === 'all') {
      const rows = await dbAll("SELECT e.user_id FROM establishments e JOIN users u ON u.id = e.user_id WHERE u.deleted_at IS NULL") as any[];
      for (const row of rows || []) userIds.push(Number(row.user_id));
    }
    const pushes: Record<string, number> = {};
    for (const uid of userIds) {
      const r = await notifySafe(uid, title, content, { screen: 'notif' }, type);
      if (r) pushes[r.push] = (pushes[r.push] || 0) + 1;
    }
    return res.status(201).json({
      message: 'Notifications enregistrées' + (pushStatus().configured ? ' et envoyées en push.' : ' (push désactivé : FIREBASE_SERVICE_ACCOUNT absent).') + ' Aucun SMS envoyé.',
      count: userIds.length,
      push: pushes,
      smsSent: false
    });
  } catch (err) { next(err); }
});

router.get('/admins', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const rows = await dbAll("SELECT id, uuid, email, phone, first_name, last_name, role, is_admin, verified, last_login, created_at FROM users WHERE is_admin = 1 OR role = 'admin' ORDER BY id ASC");
    return res.json(rows);
  } catch (err) { next(err); }
});

router.post('/admins', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const firstName = String(req.body?.firstName || req.body?.first_name || '').trim().slice(0, 80);
    const lastName = String(req.body?.lastName || req.body?.last_name || '').trim().slice(0, 80);
    if (!email || !password) return res.status(422).json({ message: 'E-mail et mot de passe requis.' });
    if (password.length < 6) return res.status(422).json({ message: 'Le mot de passe doit contenir au moins 6 caractères.' });
    const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return res.status(409).json({ message: 'Cet email est déjà utilisé.' });
    const hashed = await bcrypt.hash(password, 12);
    const inserted = await dbRun(
      'INSERT INTO users (uuid, email, password, phone, first_name, last_name, role, is_admin, verified, verification_status) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)',
      [uuidv4(), email, hashed, '', firstName, lastName, 'admin', 'approved']
    );
    let id = inserted.lastInsertRowid;
    if (id == null) {
      const row = await dbGet('SELECT id FROM users WHERE email = ?', [email]) as any;
      id = row?.id ?? null;
    }
    return res.status(201).json({
      id,
      email,
      firstName,
      lastName,
      role: 'admin',
      isAdmin: true,
      message: 'Compte admin créé. Mot de passe hashé.'
    });
  } catch (err) { next(err); }
});

router.post('/admins/:id/deactivate', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const id = Number(req.params.id);
    if (id === Number(req.user.id)) return res.status(409).json({ message: 'Vous ne pouvez pas désactiver votre propre compte.' });
    const target = await dbGet('SELECT * FROM users WHERE id = ?', [id]) as any;
    if (!target || Number(target.is_admin) !== 1) return res.status(404).json({ message: 'Administrateur introuvable.' });
    const others = await dbGet("SELECT COUNT(*) as c FROM users WHERE is_admin = 1 AND id != ?", [id]) as any;
    if (Number(others?.c || 0) < 1) return res.status(409).json({ message: 'Il doit rester au moins un administrateur.' });
    await dbRun('UPDATE users SET is_admin = 0 WHERE id = ?', [id]);
    await dbRun('INSERT INTO audit_log (uuid, user_id, user_email, action, resource, details) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), req.user.id, req.user.email, 'deactivate_admin', 'user:' + id, target.email]);
    return res.json({ message: 'Administrateur désactivé.' });
  } catch (err) { next(err); }
});

router.get('/reports/summary.csv', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const professionals = await dbGet("SELECT COUNT(*) as count FROM users WHERE role = 'professional'") as any;
    const establishments = await dbGet("SELECT COUNT(*) as count FROM users WHERE role = 'establishment'") as any;
    const missions = await dbGet('SELECT COUNT(*) as count FROM missions') as any;
    const lines = [
      'metric,count',
      'professionals,' + (professionals?.count || 0),
      'establishments,' + (establishments?.count || 0),
      'missions,' + (missions?.count || 0)
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="urgad-summary.csv"');
    return res.send(lines.join('\n') + '\n');
  } catch (err) { next(err); }
});

// Litiges (admin)
router.get('/disputes', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const disputes = await dbAll('SELECT * FROM disputes ORDER BY created_at DESC');
    return res.json(disputes);
  } catch (err) { next(err); }
});

// Journal d'audit (admin)
router.get('/audit', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const logs = await dbAll('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 500');
    return res.json(logs);
  } catch (err) { next(err); }
});

// Ajouter entrée audit (admin)
router.post('/audit', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const { action, resource, details } = req.body;
    if (!action) return res.status(422).json({ message: 'Action requise.' });
    await dbRun('INSERT INTO audit_log (uuid, user_id, user_email, action, resource, details) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), req.user?.id, req.user?.email, action, resource || '', details || '']);
    return res.status(201).json({ message: 'Entrée audit ajoutée.' });
  } catch (err) { next(err); }
});

const SETTING_DEFAULTS: Record<string, string> = {
  platform_name: 'URGAD',
  slogan: 'Le soin au bon endroit, au bon moment',
  contact_email: 'leprincegaye@urgad.fr',
  contact_phone: '+33 1 23 45 67 89',
  address: 'Paris, France',
  match_radius_km: '20',
  match_max_notifications: '50',
  match_min_hours: '2',
  match_flash_mode: '30min',
  match_weight_diploma: '30',
  match_weight_distance: '25',
  match_weight_availability: '25',
  match_weight_skills: '15',
  match_weight_rating: '5',
  commission_percent: '0',
  flash_fee: 'inclus Pro / Premium',
  essentiel_price: '199€ HT/mois',
  pro_plan_price: '249€ HT/mois ou 2739€ HT/an',
  premium_price: '299€ HT/mois ou 3289€ HT/an',
  pro_fee: '0€ (gratuit)',
  security_2fa: '1',
  manual_validation: '1',
  audit_logs: '1',
  maintenance_mode: '0',
};

function parseAmount(value: any): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value ?? '').replace(/€/g, '').replace(/\s/g, '').replace(',', '.');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthStamp(): string {
  return new Date().toISOString().slice(0, 7);
}

router.post('/disputes', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const { pro, etab, mission, reason, priority, status } = req.body || {};
    if (!String(reason || '').trim()) return res.status(422).json({ message: 'Motif requis.' });
    const allowedStatus = ['open', 'investigating', 'resolved'];
    const allowedPriority = ['low', 'medium', 'high'];
    const nextStatus = allowedStatus.includes(status) ? status : 'open';
    const nextPriority = allowedPriority.includes(priority) ? priority : 'medium';
    const uuid = uuidv4();
    await dbRun(
      'INSERT INTO disputes (uuid, pro, etab, mission, reason, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuid, String(pro || ''), String(etab || ''), String(mission || ''), String(reason).trim(), nextStatus, nextPriority]
    );
    const row = await dbGet('SELECT * FROM disputes WHERE uuid = ?', [uuid]);
    return res.status(201).json(row);
  } catch (err) { next(err); }
});

router.put('/disputes/:id', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const current = await dbGet('SELECT * FROM disputes WHERE id = ?', [req.params.id]) as any;
    if (!current) return res.status(404).json({ message: 'Litige non trouvé.' });
    const body = req.body || {};
    const allowedStatus = ['open', 'investigating', 'resolved'];
    const allowedPriority = ['low', 'medium', 'high'];
    const status = body.status != null ? body.status : current.status;
    const priority = body.priority != null ? body.priority : current.priority;
    if (!allowedStatus.includes(status)) return res.status(422).json({ message: 'Statut de litige invalide.' });
    if (priority && !allowedPriority.includes(priority)) return res.status(422).json({ message: 'Priorité invalide.' });
    await dbRun(
      'UPDATE disputes SET pro = ?, etab = ?, mission = ?, reason = ?, status = ?, priority = ?, resolution = ?, internal_notes = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [
        body.pro != null ? String(body.pro) : (current.pro || ''),
        body.etab != null ? String(body.etab) : (current.etab || ''),
        body.mission != null ? String(body.mission) : (current.mission || ''),
        body.reason != null ? String(body.reason) : (current.reason || ''),
        status,
        priority || 'medium',
        body.resolution != null ? String(body.resolution) : (current.resolution || ''),
        body.internalNotes != null ? String(body.internalNotes) : (current.internal_notes || ''),
        req.params.id,
      ]
    );
    const row = await dbGet('SELECT * FROM disputes WHERE id = ?', [req.params.id]);
    return res.json(row);
  } catch (err) { next(err); }
});

router.get('/support-tickets', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const rows = await dbAll('SELECT * FROM support_tickets ORDER BY created_at DESC');
    return res.json(rows);
  } catch (err) { next(err); }
});

router.post('/support-tickets', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const { userName, type, subject, priority, status } = req.body || {};
    if (!String(subject || '').trim()) return res.status(422).json({ message: 'Sujet requis.' });
    const allowedStatus = ['open', 'in_progress', 'resolved'];
    const allowedPriority = ['low', 'medium', 'high'];
    const nextStatus = allowedStatus.includes(status) ? status : 'open';
    const nextPriority = allowedPriority.includes(priority) ? priority : 'medium';
    const uuid = uuidv4();
    await dbRun(
      'INSERT INTO support_tickets (uuid, user_name, type, subject, priority, status) VALUES (?, ?, ?, ?, ?, ?)',
      [uuid, String(userName || ''), String(type || ''), String(subject).trim(), nextPriority, nextStatus]
    );
    const row = await dbGet('SELECT * FROM support_tickets WHERE uuid = ?', [uuid]);
    return res.status(201).json(row);
  } catch (err) { next(err); }
});

router.put('/support-tickets/:id', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const current = await dbGet('SELECT * FROM support_tickets WHERE id = ?', [req.params.id]) as any;
    if (!current) return res.status(404).json({ message: 'Ticket non trouvé.' });
    const body = req.body || {};
    const allowedStatus = ['open', 'in_progress', 'resolved'];
    const allowedPriority = ['low', 'medium', 'high'];
    const status = body.status != null ? body.status : current.status;
    const priority = body.priority != null ? body.priority : current.priority;
    if (!allowedStatus.includes(status)) return res.status(422).json({ message: 'Statut de ticket invalide.' });
    if (priority && !allowedPriority.includes(priority)) return res.status(422).json({ message: 'Priorité invalide.' });
    await dbRun(
      'UPDATE support_tickets SET user_name = ?, type = ?, subject = ?, priority = ?, status = ?, reply = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [
        body.userName != null ? String(body.userName) : (current.user_name || ''),
        body.type != null ? String(body.type) : (current.type || ''),
        body.subject != null ? String(body.subject) : (current.subject || ''),
        priority || 'medium',
        status,
        body.reply != null ? String(body.reply) : (current.reply || ''),
        req.params.id,
      ]
    );
    const row = await dbGet('SELECT * FROM support_tickets WHERE id = ?', [req.params.id]);
    return res.json(row);
  } catch (err) { next(err); }
});

router.get('/settings', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const rows = await dbAll('SELECT setting_key, value FROM platform_settings') as any[];
    const stored: Record<string, string> = {};
    for (const row of rows || []) {
      if (row && row.setting_key) stored[String(row.setting_key)] = row.value == null ? '' : String(row.value);
    }
    return res.json({ values: { ...SETTING_DEFAULTS, ...stored }, storedKeys: Object.keys(stored) });
  } catch (err) { next(err); }
});

router.put('/settings', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const body = req.body || {};
    const entries = Object.entries(body).filter(([key]) => Object.prototype.hasOwnProperty.call(SETTING_DEFAULTS, key));
    if (!entries.length) return res.status(422).json({ message: 'Aucune clé de paramètre reconnue.' });
    for (const [key, value] of entries) {
      await dbRun(
        'INSERT INTO platform_settings (setting_key, value, updated_at) VALUES (?, ?, datetime(\'now\')) ON CONFLICT(setting_key) DO UPDATE SET value = excluded.value, updated_at = datetime(\'now\')',
        [key, value == null ? '' : String(value)]
      );
    }
    const rows = await dbAll('SELECT setting_key, value FROM platform_settings') as any[];
    const stored: Record<string, string> = {};
    for (const row of rows || []) {
      if (row && row.setting_key) stored[String(row.setting_key)] = row.value == null ? '' : String(row.value);
    }
    return res.json({ values: { ...SETTING_DEFAULTS, ...stored }, storedKeys: Object.keys(stored) });
  } catch (err) { next(err); }
});

router.get('/finance', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const rows = await dbAll('SELECT * FROM finance_records ORDER BY record_date DESC, id DESC');
    return res.json(rows);
  } catch (err) { next(err); }
});

router.post('/finance', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const body = req.body || {};
    const amount = parseAmount(body.amount);
    if (!String(body.establishment || '').trim()) return res.status(422).json({ message: 'Établissement requis.' });
    if (amount == null) return res.status(422).json({ message: 'Montant invalide.' });
    const commission = parseAmount(body.commission);
    const status = body.status === 'paid' ? 'paid' : 'pending';
    const missions = Number(body.missions);
    const uuid = uuidv4();
    await dbRun(
      'INSERT INTO finance_records (uuid, reference, establishment, kind, missions, amount, commission, record_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        uuid,
        String(body.reference || ''),
        String(body.establishment).trim(),
        String(body.kind || 'Facture missions'),
        Number.isFinite(missions) ? Math.trunc(missions) : 0,
        amount,
        commission == null ? 0 : commission,
        String(body.recordDate || todayStamp()),
        status,
      ]
    );
    const row = await dbGet('SELECT * FROM finance_records WHERE uuid = ?', [uuid]) as any;
    if (row && !row.reference) {
      await dbRun('UPDATE finance_records SET reference = ? WHERE id = ?', ['FIN-' + row.id, row.id]);
    }
    const saved = await dbGet('SELECT * FROM finance_records WHERE uuid = ?', [uuid]);
    return res.status(201).json(saved);
  } catch (err) { next(err); }
});

router.put('/finance/:id', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const current = await dbGet('SELECT * FROM finance_records WHERE id = ?', [req.params.id]) as any;
    if (!current) return res.status(404).json({ message: 'Écriture finance introuvable.' });
    const body = req.body || {};
    const amount = body.amount != null ? parseAmount(body.amount) : Number(current.amount);
    const commission = body.commission != null ? parseAmount(body.commission) : Number(current.commission);
    if (amount == null || commission == null) return res.status(422).json({ message: 'Montant invalide.' });
    const status = body.status != null ? body.status : current.status;
    if (!['pending', 'paid'].includes(status)) return res.status(422).json({ message: 'Statut finance invalide.' });
    const missions = body.missions != null ? Number(body.missions) : Number(current.missions);
    await dbRun(
      'UPDATE finance_records SET reference = ?, establishment = ?, kind = ?, missions = ?, amount = ?, commission = ?, record_date = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [
        body.reference != null ? String(body.reference) : (current.reference || ''),
        body.establishment != null ? String(body.establishment) : (current.establishment || ''),
        body.kind != null ? String(body.kind) : (current.kind || ''),
        Number.isFinite(missions) ? Math.trunc(missions) : 0,
        amount,
        commission,
        body.recordDate != null ? String(body.recordDate) : (current.record_date || ''),
        status,
        req.params.id,
      ]
    );
    const row = await dbGet('SELECT * FROM finance_records WHERE id = ?', [req.params.id]);
    return res.json(row);
  } catch (err) { next(err); }
});

router.get('/matching', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const actions = await dbAll('SELECT * FROM matching_actions ORDER BY created_at DESC LIMIT 50');
    const urgentMissions = await dbAll('SELECT id, establishment_name, title, type, status, application_count, start_date, start_hour, end_hour, urgent FROM missions WHERE urgent = 1 ORDER BY created_at DESC LIMIT 20');
    return res.json({ actions, urgentMissions });
  } catch (err) { next(err); }
});

router.post('/matching/simulate', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const body = req.body || {};
    const missionId = body.missionId != null && body.missionId !== '' ? Number(body.missionId) : null;
    if (missionId != null) {
      const mission = await dbGet('SELECT id FROM missions WHERE id = ?', [missionId]);
      if (!mission) return res.status(404).json({ message: 'Mission introuvable.' });
    }
    const radius = Number(body.radiusKm);
    const radiusKm = Number.isFinite(radius) && radius > 0 ? Math.trunc(radius) : 20;
    const skills = String(body.skills || '').trim();
    const center = missionId != null ? await dbGet('SELECT latitude, longitude FROM mission_coordinates WHERE mission_id = ?', [missionId]) as any : null;
    const cLat = num(center?.latitude), cLng = num(center?.longitude);
    const pros = await dbAll(
      "SELECT u.id as user_id, u.first_name, u.last_name, u.email, p.skills, p.mobility_radius, p.latitude, p.longitude, p.city FROM users u LEFT JOIN professionals p ON p.user_id = u.id WHERE u.role = 'professional' AND u.deleted_at IS NULL AND u.verification_status NOT IN ('suspended','rejected') AND p.identity_status = 'verifie' AND p.diploma_status = 'verifie'"
    ) as any[];
    const tokens = skills.split(/[,;]+/).map((part: string) => part.trim().toLowerCase()).filter(Boolean);
    let withoutCoordinates = 0;
    const matched = (pros || []).filter((pro) => {
      if (!tokens.length) return true;
      const hay = String(pro.skills || '').toLowerCase();
      return tokens.some((token: string) => hay.includes(token));
    }).map((pro) => {
      const pLat = num(pro.latitude), pLng = num(pro.longitude);
      const distanceKm = (cLat != null && cLng != null && pLat != null && pLng != null) ? Math.round(haversineKm(cLat, cLng, pLat, pLng) * 10) / 10 : null;
      return {
        userId: pro.user_id,
        name: ((pro.first_name || '') + ' ' + (pro.last_name || '')).trim() || pro.email || 'Professionnel',
        email: pro.email || '',
        skills: pro.skills || '',
        mobilityRadius: pro.mobility_radius,
        city: pro.city || '',
        distanceKm,
      };
    }).filter((pro) => {
      if (cLat == null || cLng == null) return true; // pas de mission géolocalisée : pas de filtre distance
      if (pro.distanceKm == null) { withoutCoordinates++; return false; }
      return pro.distanceKm <= radiusKm;
    }).sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    const uuid = uuidv4();
    await dbRun(
      'INSERT INTO matching_actions (uuid, mission_id, radius_km, skills, result_count) VALUES (?, ?, ?, ?, ?)',
      [uuid, missionId, radiusKm, skills, matched.length]
    );
    const action = await dbGet('SELECT * FROM matching_actions WHERE uuid = ?', [uuid]);
    return res.status(201).json({
      message: 'Simulation enregistrée.',
      note: (cLat != null && cLng != null)
        ? `Distance réelle (haversine) depuis la mission. ${withoutCoordinates} professionnel(s) sans adresse géocodée exclu(s).`
        : (missionId != null ? 'Mission sans coordonnées : pas de filtre distance.' : 'Choisissez une mission pour filtrer par distance réelle.'),
      distanceFilter: cLat != null && cLng != null,
      withoutCoordinates,
      count: matched.length,
      radiusKm,
      skills,
      missionId,
      professionals: matched,
      action,
    });
  } catch (err) { next(err); }
});

/** Couverture géographique : ce qui a des coordonnées et ce qui n'en a pas. */
router.get('/geocoding', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const establishments = await dbAll('SELECT id, name, address, postal_code, city, latitude, longitude, geocode_label, geocode_precision FROM establishments ORDER BY id');
    const professionals = await dbAll("SELECT u.id AS user_id, u.email, p.address, p.postal_code, p.city, p.latitude, p.longitude, p.geocode_label, p.geocode_precision FROM professionals p JOIN users u ON u.id = p.user_id WHERE u.deleted_at IS NULL ORDER BY u.id");
    const missions = await dbAll('SELECT m.id, m.title, m.location, m.start_date, c.latitude, c.longitude, c.geocode_label, c.geocode_precision, c.source FROM missions m LEFT JOIN mission_coordinates c ON c.mission_id = m.id ORDER BY m.id');
    return res.json({ establishments, professionals, missions, push: pushStatus() });
  } catch (err) { next(err); }
});

router.post('/geocoding/backfill', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    return res.json(await backfillCoordinates());
  } catch (err) { next(err); }
});

/** Valider / refuser un document (pro ou établissement) + notification au propriétaire. */
router.post('/documents/:kind/:id/:decision', authMiddleware, requireAdmin, async (req: any, res: any, next: any) => {
  try {
    const { kind, id, decision } = req.params;
    if (!['approve', 'reject'].includes(decision)) return res.status(422).json({ message: 'Décision : approve ou reject.' });
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const reason = String(req.body?.reason || '').slice(0, 300);
    let ownerId: number | null = null, name = '';
    if (kind === 'professional') {
      const d = await dbGet('SELECT id, user_id, name FROM professional_documents WHERE id = ?', [id]) as any;
      if (!d) return res.status(404).json({ message: 'Document introuvable.' });
      await dbRun('UPDATE professional_documents SET status = ? WHERE id = ?', [status, id]);
      ownerId = Number(d.user_id); name = d.name;
    } else if (kind === 'establishment') {
      const d = await dbGet('SELECT d.*, e.user_id FROM establishment_documents d JOIN establishments e ON e.id = d.establishment_id WHERE d.id = ?', [id]) as any;
      if (!d) return res.status(404).json({ message: 'Document introuvable.' });
      await dbRun('UPDATE establishment_documents SET status = ? WHERE id = ?', [status, id]);
      ownerId = Number(d.user_id); name = d.name;
    } else return res.status(422).json({ message: 'Type : professional ou establishment.' });
    await notifySafe(ownerId, status === 'approved' ? 'Document validé ✅' : 'Document refusé',
      `« ${name} » ${status === 'approved' ? 'a été validé.' : 'a été refusé' + (reason ? ' : ' + reason : '.')}`,
      { documentId: Number(id), screen: kind === 'professional' ? 'my-documents' : 'documents' }, status === 'approved' ? 'document_approved' : 'document_rejected');
    return res.json({ message: status === 'approved' ? 'Document validé.' : 'Document refusé.', status });
  } catch (err) { next(err); }
});

router.get('/analytics', authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const professionals = await dbGet('SELECT COUNT(*) as count FROM users WHERE role = \'professional\'') as any;
    const establishments = await dbGet('SELECT COUNT(*) as count FROM users WHERE role = \'establishment\'') as any;
    const missions = await dbGet('SELECT COUNT(*) as count FROM missions WHERE status != \'cancelled\'') as any;
    const applications = await dbGet('SELECT COUNT(*) as count FROM applications') as any;
    const accepted = await dbGet('SELECT COUNT(*) as count FROM applications WHERE status = \'accepted\'') as any;
    const pendingApps = await dbGet('SELECT COUNT(*) as count FROM applications WHERE status = \'pending\'') as any;
    const urgent = await dbGet('SELECT COUNT(*) as count FROM missions WHERE urgent = 1 AND status != \'cancelled\'') as any;
    const missionRows = await dbAll('SELECT created_at, start_date, type, status FROM missions') as any[];
    const disputeRows = await dbAll('SELECT status FROM disputes') as any[];
    const ticketRows = await dbAll('SELECT status FROM support_tickets') as any[];
    const financeRows = await dbAll('SELECT amount, commission, status, record_date FROM finance_records') as any[];
    const byType: Record<string, number> = {};
    const byMonth: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    const dayKeys: string[] = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
      const key = d.toISOString().slice(0, 10);
      dayKeys.push(key);
      byDay[key] = 0;
    }
    for (const row of missionRows || []) {
      if (row.status === 'cancelled') continue;
      const type = row.type || 'autre';
      byType[type] = (byType[type] || 0) + 1;
      const month = String(row.start_date || row.created_at || '').slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(month)) byMonth[month] = (byMonth[month] || 0) + 1;
      const day = String(row.created_at || '').slice(0, 10);
      if (Object.prototype.hasOwnProperty.call(byDay, day)) byDay[day] += 1;
    }
    const countStatus = (rows: any[], name: string) => (rows || []).filter((row) => row.status === name).length;
    const today = todayStamp();
    const month = monthStamp();
    let amount = 0;
    let commission = 0;
    let pendingAmount = 0;
    let todayAmount = 0;
    let monthAmount = 0;
    let pendingCount = 0;
    for (const row of financeRows || []) {
      const value = Number(row.amount) || 0;
      const fee = Number(row.commission) || 0;
      amount += value;
      commission += fee;
      const date = String(row.record_date || '');
      if (row.status === 'pending') {
        pendingCount += 1;
        pendingAmount += value;
      }
      if (date.slice(0, 10) === today) todayAmount += value;
      if (date.slice(0, 7) === month) monthAmount += value;
    }
    const appCount = applications?.count || 0;
    const acceptedCount = accepted?.count || 0;
    return res.json({
      professionals: professionals?.count || 0,
      establishments: establishments?.count || 0,
      missions: missions?.count || 0,
      applications: appCount,
      acceptedApplications: acceptedCount,
      pendingApplications: pendingApps?.count || 0,
      urgentMissions: urgent?.count || 0,
      fillRate: appCount ? Math.round((acceptedCount / appCount) * 1000) / 10 : null,
      disputes: {
        total: (disputeRows || []).length,
        open: countStatus(disputeRows, 'open'),
        investigating: countStatus(disputeRows, 'investigating'),
        resolved: countStatus(disputeRows, 'resolved'),
      },
      tickets: {
        total: (ticketRows || []).length,
        open: countStatus(ticketRows, 'open'),
        in_progress: countStatus(ticketRows, 'in_progress'),
        resolved: countStatus(ticketRows, 'resolved'),
      },
      finance: {
        count: (financeRows || []).length,
        amount,
        commission,
        pendingCount,
        pendingAmount,
        todayAmount,
        monthAmount,
      },
      missionsByType: Object.entries(byType).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
      missionsByMonth: Object.keys(byMonth).sort().map((key) => ({ month: key, count: byMonth[key] })),
      missionsByDay: dayKeys.map((day) => ({ day, count: byDay[day] })),
    });
  } catch (err) { next(err); }
});

export default router;
