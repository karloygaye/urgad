import { Router } from 'express';
import { dbRun, dbGet, dbAll } from '../db.js';
import { authMiddleware } from './_auth.js';
import { notify, pushStatus } from '../notify.js';

const router = Router();

/** Condition SQL "notifications de l'utilisateur connecté" (colonne user_id + anciennes lignes recipient_id). */
async function ownWhere(req: any): Promise<{ sql: string; params: any[] }> {
  const uid = Number(req.user.id);
  if (req.user.role === 'professional') {
    const prof = await dbGet('SELECT id FROM professionals WHERE user_id = ?', [uid]) as any;
    if (prof) return { sql: "(user_id = ? OR (user_id IS NULL AND recipient_type = 'professional' AND recipient_id = ?))", params: [uid, prof.id] };
  } else if (req.user.role === 'establishment') {
    const est = await dbGet('SELECT id FROM establishments WHERE user_id = ?', [uid]) as any;
    if (est) return { sql: "(user_id = ? OR (user_id IS NULL AND recipient_type = 'establishment' AND recipient_id = ?))", params: [uid, est.id] };
  } else if (req.user.isAdmin) {
    return { sql: "(user_id = ? OR (user_id IS NULL AND recipient_type = 'admin'))", params: [uid] };
  }
  return { sql: 'user_id = ?', params: [uid] };
}

function publicRow(n: any) {
  let data: any = null;
  try { data = n.data ? JSON.parse(n.data) : null; } catch { data = null; }
  return { ...n, read: Number(n.read) === 1, data };
}

/** Envoyer une notification (admin ou établissement) — passe par notify() : ligne in-app + push. */
router.post('/send', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ message: 'Admin uniquement.' });
    const { userId, recipientId, recipientType, type, title, content } = req.body || {};
    if (!title) return res.status(422).json({ message: 'Titre requis.' });
    let target = userId != null ? Number(userId) : null;
    if (target == null && recipientId != null) {
      if (recipientType === 'professional') target = (await dbGet('SELECT user_id FROM professionals WHERE id = ?', [recipientId]) as any)?.user_id ?? null;
      else if (recipientType === 'establishment') target = (await dbGet('SELECT user_id FROM establishments WHERE id = ?', [recipientId]) as any)?.user_id ?? null;
      else target = Number(recipientId);
    }
    if (target == null) return res.status(422).json({ message: 'Destinataire introuvable.' });
    const result = await notify(target, String(title), String(content || ''), {}, String(type || 'admin'));
    return res.status(201).json({ message: 'Notification envoyée.', ...result });
  } catch (err) { next(err); }
});

/** Mes notifications (le plus récent d'abord). ?unread=1 pour les non lues. ?all=1 (admin) : toutes. */
router.get('/', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '100'), 10) || 100));
    if (req.user.isAdmin && String(req.query.all || '') === '1') {
      return res.json((await dbAll(`SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT ${limit}`)).map(publicRow));
    }
    const w = await ownWhere(req);
    const unreadOnly = String(req.query.unread || '') === '1' ? ' AND (read = 0 OR read IS NULL)' : '';
    const rows = await dbAll(`SELECT * FROM notifications WHERE ${w.sql}${unreadOnly} ORDER BY created_at DESC, id DESC LIMIT ${limit}`, w.params);
    return res.json(rows.map(publicRow));
  } catch (err) { next(err); }
});

/** Compteur pour le badge. */
router.get('/unread-count', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const w = await ownWhere(req);
    const row = await dbGet(`SELECT COUNT(*) AS count FROM notifications WHERE ${w.sql} AND (read = 0 OR read IS NULL)`, w.params) as any;
    return res.json({ unread: Number(row?.count || 0), push: pushStatus() });
  } catch (err) { next(err); }
});

/** Marquer toutes comme lues (les miennes). */
router.post('/read-all', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const w = await ownWhere(req);
    await dbRun(`UPDATE notifications SET read = 1 WHERE ${w.sql}`, w.params);
    return res.json({ message: 'Toutes les notifications marquées comme lues.' });
  } catch (err) { next(err); }
});

/** Marquer une notification comme lue (seulement si elle m'appartient). */
router.post('/:id/read', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const w = await ownWhere(req);
    const row = await dbGet(`SELECT id FROM notifications WHERE id = ? AND ${w.sql}`, [req.params.id, ...w.params]) as any;
    if (!row) return res.status(404).json({ message: 'Notification introuvable.' });
    await dbRun('UPDATE notifications SET read = 1 WHERE id = ?', [row.id]);
    return res.json({ message: 'Notification marquée comme lue.' });
  } catch (err) { next(err); }
});

export default router;
