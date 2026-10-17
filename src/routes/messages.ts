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

/** Créer une conversation */
router.post('/conversation', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const { participantId, participantType } = req.body;
    if (!participantId || !participantType) return res.status(422).json({ message: 'Participant ID et type requis.' });
    const existing = await dbAll('SELECT conversation_id FROM messages WHERE sender_id = ? AND sender_type = ? LIMIT 1', [req.user.id, req.user.role]);
    let conversationId: string;
    if (existing.length > 0) {
      conversationId = existing[0].conversation_id;
    } else {
      conversationId = uuidv4();
    }
    return res.json({ conversationId });
  } catch (err) { next(err); }
});

/** Envoyer un message */
router.post('/', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const { conversationId, recipientId, recipientType, content } = req.body;
    if (!conversationId || !content) return res.status(422).json({ message: 'Conversation et contenu requis.' });
    const senderType = req.user.role;
    let senderName = 'URGAD';
    if (req.user.isAdmin) senderName = 'URGAD';
    else if (req.user.role === 'professional') {
      const u = await dbGet('SELECT first_name, last_name FROM users WHERE id = ?', [req.user.id]) as any;
      senderName = `${u?.first_name || ''} ${u?.last_name || ''}`.trim() || 'Professionnel';
    } else {
      const e = await dbGet('SELECT name FROM establishments WHERE user_id = ?', [req.user.id]) as any;
      senderName = e?.name || 'Établissement';
    }
    await dbRun('INSERT INTO messages (uuid, conversation_id, sender_id, sender_type, sender_name, content) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), conversationId, req.user.id, senderType, senderName, content]);
    // Destinataires : les autres participants de la conversation (+ recipientId s'il désigne un utilisateur).
    const others = await dbAll('SELECT DISTINCT sender_id FROM messages WHERE conversation_id = ? AND sender_id != ?', [conversationId, req.user.id]) as any[];
    const targets = new Set<number>(others.map((o) => Number(o.sender_id)));
    if (recipientId != null && Number(recipientId) !== Number(req.user.id)) {
      if (recipientType === 'establishment') {
        const e = await dbGet('SELECT user_id FROM establishments WHERE id = ? OR user_id = ?', [recipientId, recipientId]) as any;
        if (e) targets.add(Number(e.user_id));
      } else {
        const u = await dbGet('SELECT id FROM users WHERE id = ?', [recipientId]) as any;
        if (u) targets.add(Number(u.id));
      }
    }
    const preview = String(content).slice(0, 140);
    for (const uid of targets) {
      const screen = 'chat-' + conversationId;
      await notifySafe(uid, 'Nouveau message de ' + senderName, preview, { conversationId, screen }, 'new_message');
    }
    return res.status(201).json({ message: 'Message envoyé.', notified: targets.size });
  } catch (err) { next(err); }
});

/** Lister conversations */
router.get('/conversations', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const conversations = await dbAll(`
      SELECT DISTINCT m.conversation_id,
        (SELECT m2.content FROM messages m2 WHERE m2.conversation_id = m.conversation_id ORDER BY m2.created_at DESC LIMIT 1) as last_message,
        (SELECT m2.created_at FROM messages m2 WHERE m2.conversation_id = m.conversation_id ORDER BY m2.created_at DESC LIMIT 1) as last_message_date,
        (SELECT COUNT(*) FROM messages m2 WHERE m2.conversation_id = m.conversation_id) as message_count,
        (SELECT m2.sender_name FROM messages m2 WHERE m2.conversation_id = m.conversation_id ORDER BY m2.created_at DESC LIMIT 1) as other_participant
      FROM messages m
      WHERE m.sender_id = ? OR m.sender_type = ?
      GROUP BY m.conversation_id
      ORDER BY last_message_date DESC
    `, [req.user.id, req.user.role]);
    return res.json(conversations);
  } catch (err) { next(err); }
});

/** Lister messages d'une conversation */
router.get('/conversation/:id', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const messages = await dbAll('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', [req.params.id]);
    return res.json(messages);
  } catch (err) { next(err); }
});

export default router;
