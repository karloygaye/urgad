import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { dbRun, dbGet, dbAll } from '../db.js';
import { config } from '../config.js';
import { notifySafe } from '../notify.js';

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

async function resolveUserId(participantId: any, participantType?: string): Promise<number | null> {
  const id = Number(participantId);
  if (!Number.isFinite(id) || id <= 0) return null;
  if (participantType === 'establishment') {
    const e = await dbGet('SELECT user_id FROM establishments WHERE id = ? OR user_id = ?', [id, id]) as any;
    return e ? Number(e.user_id) : null;
  }
  if (participantType === 'professional') {
    const p = await dbGet('SELECT user_id FROM professionals WHERE id = ? OR user_id = ?', [id, id]) as any;
    if (p) return Number(p.user_id);
  }
  const u = await dbGet('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', [id]) as any;
  return u ? Number(u.id) : null;
}

async function displayName(userId: number): Promise<string> {
  const u = await dbGet('SELECT first_name, last_name, role, is_admin FROM users WHERE id = ?', [userId]) as any;
  if (!u) return 'URGAD';
  if (u.is_admin) return 'URGAD';
  if (u.role === 'establishment') {
    const e = await dbGet('SELECT name FROM establishments WHERE user_id = ?', [userId]) as any;
    return e?.name || 'Établissement';
  }
  const name = `${u.first_name || ''} ${u.last_name || ''}`.trim();
  return name || 'Professionnel';
}

async function isMember(conversationId: string, userId: number): Promise<boolean> {
  const row = await dbGet('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [conversationId, userId]);
  return !!row;
}

async function addMember(conversationId: string, userId: number, role: string) {
  try {
    await dbRun('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)', [conversationId, userId, role]);
  } catch {
    /* déjà membre */
  }
}

async function findPairConversation(a: number, b: number): Promise<string | null> {
  const row = await dbGet(
    `SELECT cm1.conversation_id AS conversation_id
     FROM conversation_members cm1
     JOIN conversation_members cm2 ON cm1.conversation_id = cm2.conversation_id
     WHERE cm1.user_id = ? AND cm2.user_id = ?
       AND (SELECT COUNT(*) FROM conversation_members cx WHERE cx.conversation_id = cm1.conversation_id) = 2
     LIMIT 1`,
    [a, b]
  ) as any;
  return row?.conversation_id || null;
}

async function openPair(me: number, meRole: string, other: number): Promise<string> {
  const existing = await findPairConversation(me, other);
  if (existing) {
    await addMember(existing, me, meRole);
    return existing;
  }
  const id = uuidv4();
  const otherUser = await dbGet('SELECT role FROM users WHERE id = ?', [other]) as any;
  await addMember(id, me, meRole);
  await addMember(id, other, otherUser?.role || 'user');
  return id;
}

async function otherLabel(conversationId: string, me: number): Promise<string> {
  const other = await dbGet(
    'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ? LIMIT 1',
    [conversationId, me]
  ) as any;
  if (!other) return 'Conversation';
  return displayName(Number(other.user_id));
}

/** Ouvrir (ou réutiliser) un fil privé à deux. */
router.post('/conversation', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const { participantId, participantType } = req.body;
    const otherId = await resolveUserId(participantId, participantType);
    if (!otherId) return res.status(422).json({ message: 'Participant introuvable.' });
    if (otherId === Number(req.user.id)) return res.status(422).json({ message: 'Impossible d’ouvrir une conversation avec soi-même.' });
    const conversationId = await openPair(Number(req.user.id), req.user.role, otherId);
    return res.json({ conversationId });
  } catch (err) { next(err); }
});

/** Envoyer un message — uniquement aux membres de la conversation. */
router.post('/', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const { conversationId: rawConv, recipientId, recipientType, content } = req.body;
    if (!content || !String(content).trim()) return res.status(422).json({ message: 'Contenu requis.' });
    const me = Number(req.user.id);
    let conversationId = String(rawConv || '').trim();
    const otherId = recipientId != null ? await resolveUserId(recipientId, recipientType) : null;
    if (otherId && otherId !== me) {
      conversationId = await openPair(me, req.user.role, otherId);
    } else if (conversationId) {
      if (!(await isMember(conversationId, me)) && !req.user.isAdmin) {
        return res.status(403).json({ message: 'Cette conversation ne vous concerne pas.' });
      }
      if (req.user.isAdmin) await addMember(conversationId, me, 'admin');
    } else {
      return res.status(422).json({ message: 'Conversation ou destinataire requis.' });
    }
    const senderName = await displayName(me);
    const senderType = req.user.isAdmin ? 'admin' : req.user.role;
    await dbRun('INSERT INTO messages (uuid, conversation_id, sender_id, sender_type, sender_name, content) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), conversationId, me, senderType, senderName, String(content).trim()]);
    await addMember(conversationId, me, senderType);
    const members = await dbAll('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?', [conversationId, me]) as any[];
    const preview = String(content).trim().slice(0, 140);
    const screen = 'chat-' + conversationId;
    for (const m of members) {
      await notifySafe(Number(m.user_id), 'Nouveau message de ' + senderName, preview, { conversationId, screen }, 'new_message');
    }
    return res.status(201).json({ message: 'Message envoyé.', conversationId, notified: members.length });
  } catch (err) { next(err); }
});

/** Lister uniquement mes conversations. */
router.get('/conversations', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const me = Number(req.user.id);
    const rows = await dbAll(
      `SELECT cm.conversation_id,
         (SELECT m2.content FROM messages m2 WHERE m2.conversation_id = cm.conversation_id ORDER BY m2.created_at DESC LIMIT 1) as last_message,
         (SELECT m2.created_at FROM messages m2 WHERE m2.conversation_id = cm.conversation_id ORDER BY m2.created_at DESC LIMIT 1) as last_message_date,
         (SELECT COUNT(*) FROM messages m2 WHERE m2.conversation_id = cm.conversation_id) as message_count
       FROM conversation_members cm
       WHERE cm.user_id = ?
       ORDER BY last_message_date DESC`,
      [me]
    ) as any[];
    const conversations = [];
    for (const row of rows) {
      conversations.push({
        ...row,
        other_participant: await otherLabel(row.conversation_id, me),
      });
    }
    return res.json(conversations);
  } catch (err) { next(err); }
});

/** Messages d'une conversation : membres uniquement (admin : lecture BO). */
router.get('/conversation/:id', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const conversationId = String(req.params.id || '');
    if (!req.user.isAdmin && !(await isMember(conversationId, Number(req.user.id)))) {
      return res.status(403).json({ message: 'Cette conversation ne vous concerne pas.' });
    }
    const messages = await dbAll('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', [conversationId]);
    return res.json(messages);
  } catch (err) { next(err); }
});

export default router;
