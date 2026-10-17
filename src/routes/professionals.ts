import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { dbRun, dbGet, dbAll } from '../db.js';
import { config } from '../config.js';
import { saveBase64File } from '../uploads.js';
import { notifyAdmins } from '../notify.js';
import { categoryOf, onDocumentUploaded, ID_KINDS } from '../verification.js';

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

/** Lister professionnels (admin ou anonyme en lecture seule) */
router.get('/', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ message: 'Réservé aux administrateurs.' });
    const pros = await dbAll('SELECT u.id, u.email, u.phone, u.first_name, u.last_name, u.role, u.verified, u.verification_status, u.created_at, p.bio, p.skills, p.mobility_radius, p.availability, p.city, p.latitude, p.longitude FROM users u LEFT JOIN professionals p ON p.user_id = u.id WHERE u.role = \'professional\' ORDER BY u.created_at DESC');
    return res.json(pros);
  } catch (err) { next(err); }
});


function publicProDocument(row: any) {
  const stored = !!row.stored_name;
  return {
    id: row.id,
    name: row.name,
    type: row.doc_type || '',
    category: row.category || 'other',
    idKind: row.id_kind || null,
    side: row.side || null,
    reason: row.review_reason || null,
    filePurgedAt: row.file_purged_at || null,
    status: row.status || 'pending',
    createdAt: row.created_at || null,
    fileStored: stored,
    storage: stored ? 'disk' : 'metadata',
    sizeBytes: row.size_bytes || 0,
    storedName: row.stored_name || null,
    mimeType: row.mime_type || null
  };
}

/** Documents du professionnel connecté : métadonnées + fichier sur disque. */
router.get('/me/documents', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (req.user.role !== 'professional' && !req.user.isAdmin) return res.status(403).json({ message: 'Compte professionnel requis.' });
    const rows = await dbAll('SELECT * FROM professional_documents WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
    return res.json((rows || []).map(publicProDocument));
  } catch (err) { next(err); }
});

router.post('/me/documents', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (req.user.role !== 'professional' && !req.user.isAdmin) return res.status(403).json({ message: 'Compte professionnel requis.' });
    const name = String(req.body?.name || req.body?.fileName || '').trim().slice(0, 200);
    const docType = String(req.body?.type || req.body?.docType || '').trim().slice(0, 80) || 'autre';
    if (!name) return res.status(422).json({ message: 'Nom du document requis.' });
    const category = categoryOf(req.body);
    const idKindRaw = String(req.body?.idKind || '').toLowerCase();
    const idKind = category === 'identity' ? ((ID_KINDS as readonly string[]).includes(idKindRaw) ? idKindRaw : null) : null;
    const sideRaw = String(req.body?.side || '').toLowerCase();
    const side = category === 'identity' && (sideRaw === 'recto' || sideRaw === 'verso') ? sideRaw : null;
    if (category === 'identity' && !idKind) return res.status(422).json({ message: 'Type de pièce requis : cni, passeport ou titre_sejour.' });
    let saved;
    try {
      saved = saveBase64File(req.body || {});
    } catch (err: any) {
      return res.status(err.status || 422).json({ message: err.message || 'Fichier refusé.' });
    }
    const inserted = await dbRun(
      'INSERT INTO professional_documents (user_id, name, doc_type, status, stored_name, mime_type, size_bytes, category, id_kind, side) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, name, docType, 'pending', saved.storedName, saved.mimeType, saved.sizeBytes, category, idKind, side]
    );
    await onDocumentUploaded(Number(req.user.id), category);
    let id = inserted.lastInsertRowid;
    if (id == null) {
      const row = await dbGet('SELECT id FROM professional_documents WHERE user_id = ? AND stored_name = ? ORDER BY id DESC LIMIT 1', [req.user.id, saved.storedName]) as any;
      id = row?.id ?? null;
    }
    const who = await dbGet('SELECT first_name, last_name, email FROM users WHERE id = ?', [req.user.id]) as any;
    const catLabel = category === 'identity' ? ('pièce d\'identité' + (side ? ' ' + side : '')) : category === 'diploma' ? 'diplôme' : category === 'carte_vitale' ? 'carte Vitale' : category === 'vaccins' ? 'vaccins' : category === 'rib' ? 'RIB' : docType;
    void notifyAdmins('Document professionnel à vérifier', `${((who?.first_name || '') + ' ' + (who?.last_name || '')).trim() || who?.email} a déposé « ${name} » (${catLabel}).`, { userId: req.user.id, documentId: id, screen: 'verification' }, 'admin_document');
    return res.status(201).json({
      ...publicProDocument({
        id, name, doc_type: docType, status: 'pending', created_at: null, category, id_kind: idKind, side,
        stored_name: saved.storedName, mime_type: saved.mimeType, size_bytes: saved.sizeBytes
      }),
      message: 'Document enregistré sur le disque du serveur.'
    });
  } catch (err) { next(err); }
});

/** Profil professionnel par ID */
router.get('/:id', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    // Les établissements ne parcourent plus les profils : seule la carte du profil proposé leur est montrée (/api/requests).
    if (!req.user.isAdmin && Number(req.params.id) !== Number(req.user.id)) return res.status(403).json({ message: 'Non autorisé.' });
    const prof = await dbGet('SELECT u.id, u.email, u.phone, u.first_name, u.last_name, u.role, u.verified, u.verification_status, u.created_at, p.bio, p.skills, p.mobility_radius, p.availability, p.date_of_birth, p.address, p.city, p.postal_code, p.latitude, p.longitude, p.geocode_label, p.geocode_precision FROM users u LEFT JOIN professionals p ON p.user_id = u.id WHERE u.id = ? AND u.role = \'professional\'', [req.params.id]) as any;
    if (!prof) return res.status(404).json({ message: 'Professionnel non trouvé.' });
    return res.json(prof);
  } catch (err) { next(err); }
});

/** Mettre à jour disponibilités */
router.put('/:id/availability', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const prof = await dbGet('SELECT * FROM professionals WHERE user_id = (SELECT id FROM users WHERE id = ?)', [req.params.id]) as any;
    if (!prof) return res.status(404).json({ message: 'Professionnel non trouvé.' });
    if (prof.user_id !== req.user.id && !req.user.isAdmin) return res.status(403).json({ message: 'Non autorisé.' });
    const { availability } = req.body;
    await dbRun('UPDATE professionals SET availability = ? WHERE user_id = ?', [JSON.stringify(availability || {}), req.params.id]);
    return res.json({ message: 'Disponibilités mises à jour.' });
  } catch (err) { next(err); }
});

/** Mettre à jour zone de déplacement */
router.put('/:id/mobility', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const prof = await dbGet('SELECT * FROM professionals WHERE user_id = (SELECT id FROM users WHERE id = ?)', [req.params.id]) as any;
    if (!prof) return res.status(404).json({ message: 'Professionnel non trouvé.' });
    if (prof.user_id !== req.user.id && !req.user.isAdmin) return res.status(403).json({ message: 'Non autorisé.' });
    const { mobilityRadius } = req.body;
    await dbRun('UPDATE professionals SET mobility_radius = ? WHERE user_id = ?', [mobilityRadius || 20, req.params.id]);
    return res.json({ message: 'Zone de déplacement mise à jour.' });
  } catch (err) { next(err); }
});

export default router;
