import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { dbAll, dbGet, dbRun } from '../db.js';
import { authMiddleware } from './_auth.js';
import { UPLOAD_DIR } from '../uploads.js';
import { notifySafe } from '../notify.js';
import { applyReview, identityRetentionDays, purgeVerifiedIdentityFiles, statusOf, verificationOf } from '../verification.js';

const router = Router();

async function audit(req: any, action: string, resource: string, details: string) {
  try {
    await dbRun('INSERT INTO audit_log (uuid, user_id, user_email, action, resource, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), req.user.id, req.user.email || null, action, resource, details.slice(0, 500), String(req.ip || '').slice(0, 64)]);
  } catch { /* journal best effort */ }
}

/** Le pro voit ses statuts (identité / diplôme), motifs et documents (métadonnées). */
router.get('/me', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (req.user.role !== 'professional') return res.status(403).json({ message: 'Compte professionnel requis.' });
    return res.json({ ...(await verificationOf(Number(req.user.id))), identityRetentionDays: await identityRetentionDays() });
  } catch (err) { next(err); }
});

/** File de vérification (admin). */
router.get('/queue', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ message: 'Réservé aux administrateurs.' });
    const pros = await dbAll<any>("SELECT u.id AS user_id, u.email, u.phone, u.first_name, u.last_name, u.created_at, p.profession, p.identity_status, p.diploma_status FROM users u JOIN professionals p ON p.user_id = u.id WHERE u.role = 'professional' AND u.deleted_at IS NULL ORDER BY u.created_at DESC");
    const out = [];
    for (const p of pros) {
      const v = await verificationOf(Number(p.user_id));
      out.push({ userId: p.user_id, name: `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email, email: p.email, phone: p.phone, profession: p.profession || null, createdAt: p.created_at, ...v });
    }
    return res.json({ identityRetentionDays: await identityRetentionDays(), professionals: out });
  } catch (err) { next(err); }
});

/** Décision admin : { kind: identity|diploma, decision: verifie|refuse, reason } */
router.post('/:userId/review', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ message: 'Réservé aux administrateurs.' });
    const userId = Number(req.params.userId);
    const kind = String(req.body?.kind || '');
    const decision = String(req.body?.decision || '');
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    if (kind !== 'identity' && kind !== 'diploma') return res.status(422).json({ message: 'kind : identity ou diploma.' });
    if (decision !== 'verifie' && decision !== 'refuse') return res.status(422).json({ message: 'decision : verifie ou refuse.' });
    if (decision === 'refuse' && !reason) return res.status(422).json({ message: 'Motif requis pour un refus.' });
    const p = await dbGet<any>("SELECT p.id FROM professionals p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND u.deleted_at IS NULL", [userId]);
    if (!p) return res.status(404).json({ message: 'Professionnel introuvable.' });
    if (decision === 'verifie') {
      const n = await dbGet<any>('SELECT COUNT(*) AS n FROM professional_documents WHERE user_id = ? AND category = ?', [userId, kind]);
      if (!Number(n?.n)) return res.status(409).json({ message: kind === 'identity' ? 'Aucune pièce d\'identité déposée.' : 'Aucun diplôme déposé.' });
    }
    const v = await applyReview(userId, kind, decision, reason, String(req.user.email || 'admin#' + req.user.id));
    await audit(req, 'verification_' + kind + '_' + decision, 'professional:' + userId, reason);
    const label = kind === 'identity' ? 'Pièce d\'identité' : 'Diplôme';
    await notifySafe(userId, decision === 'verifie' ? `${label} vérifié(e) ✅` : `${label} refusé(e)`,
      decision === 'verifie' ? (v.ok ? 'Identité et diplôme vérifiés : votre profil peut être proposé aux établissements.' : `${label} validé(e). Il reste à vérifier : ${kind === 'identity' ? 'le diplôme' : 'la pièce d\'identité'}.`)
        : `Motif : ${reason}. Merci de déposer un document lisible et à jour.`,
      { screen: 'my-documents', kind }, decision === 'verifie' ? 'verification_approved' : 'verification_rejected');
    return res.json({ message: 'Décision enregistrée.', ...(await verificationOf(userId)) });
  } catch (err) { next(err); }
});

/**
 * Fichier d'un document professionnel.
 * - Pièce d'identité : administrateurs uniquement (accès journalisé).
 * - Diplôme / autre : administrateurs et le professionnel lui-même.
 * - Établissements : jamais.
 */
router.get('/documents/:id/file', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const d = await dbGet<any>('SELECT * FROM professional_documents WHERE id = ?', [req.params.id]);
    if (!d) return res.status(404).json({ message: 'Document introuvable.' });
    const isOwner = req.user.role === 'professional' && Number(d.user_id) === Number(req.user.id);
    if (req.user.role === 'establishment' && !req.user.isAdmin) return res.status(403).json({ message: 'Les établissements n\'ont pas accès aux justificatifs des professionnels.' });
    if (d.category === 'identity' && !req.user.isAdmin) return res.status(403).json({ message: 'Pièce d\'identité : accès réservé à l\'équipe de vérification.' });
    if (!req.user.isAdmin && !isOwner) return res.status(403).json({ message: 'Non autorisé.' });
    if (!d.stored_name) return res.status(410).json({ message: d.file_purged_at ? 'Fichier effacé après vérification (minimisation RGPD).' : 'Aucun fichier stocké.' });
    const file = path.join(UPLOAD_DIR, path.basename(String(d.stored_name)));
    if (!file.startsWith(UPLOAD_DIR) || !fs.existsSync(file)) return res.status(404).json({ message: 'Fichier absent du serveur.' });
    if (req.user.isAdmin) await audit(req, 'document_view', 'professional_document:' + d.id, `${d.category || 'other'} user#${d.user_id}`);
    res.setHeader('Content-Type', d.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="document-${d.id}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(file);
  } catch (err) { next(err); }
});

/** Purge manuelle des fichiers d'identité vérifiés au-delà de la durée de conservation (admin). */
router.post('/purge-identity-files', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ message: 'Réservé aux administrateurs.' });
    const purged = await purgeVerifiedIdentityFiles();
    return res.json({ purged, retentionDays: await identityRetentionDays() });
  } catch (err) { next(err); }
});

export { statusOf };
export default router;
