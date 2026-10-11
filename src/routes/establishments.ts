import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { dbRun, dbGet, dbAll } from '../db.js';
import { config } from '../config.js';
import { prepareSubscriptionPayment } from '../billing.js';
import { saveBase64File } from '../uploads.js';
import { geocodeEstablishment } from '../geo.js';
import { notifyAdmins } from '../notify.js';

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

/** Profil établissement courant */
router.get('/me', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const est = await dbGet('SELECT e.*, u.email, u.phone, u.first_name, u.last_name, u.created_at FROM establishments e JOIN users u ON u.id = e.user_id WHERE e.user_id = ?', [req.user.id]) as any;
    if (!est) return res.status(404).json({ message: 'Établissement non trouvé.' });
    return res.json(est);
  } catch (err) { next(err); }
});

/** Liste établissements (admin) */
router.get('/', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ message: 'Admin uniquement.' });
    const ests = await dbAll('SELECT e.*, u.email, u.first_name, u.last_name, u.phone FROM establishments e JOIN users u ON u.id = e.user_id ORDER BY e.created_at DESC');
    return res.json(ests);
  } catch (err) { next(err); }
});

/** Établissement par ID (admin) */
router.get('/:id', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ message: 'Admin uniquement.' });
    const est = await dbGet('SELECT e.*, u.email, u.phone, u.first_name, u.last_name FROM establishments e JOIN users u ON u.id = e.user_id WHERE e.id = ?', [req.params.id]) as any;
    if (!est) return res.status(404).json({ message: 'Établissement non trouvé.' });
    return res.json(est);
  } catch (err) { next(err); }
});

/** Mise à jour établissement */
router.put('/me', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const { name, siret, type, phone, email, address, city, postalCode, responsible } = req.body;
    const before = await dbGet('SELECT id, address, city, postal_code, latitude FROM establishments WHERE user_id = ?', [req.user.id]) as any;
    await dbRun('UPDATE establishments SET name = ?, siret = ?, type = ?, phone = ?, email = ?, address = ?, city = ?, postal_code = ?, responsible = ? WHERE user_id = ?',
      [name || '', siret || '', type || '', phone || '', email || '', address || '', city || '', postalCode || '', responsible || '', req.user.id]);
    if (before && (before.latitude == null || String(before.address || '') !== String(address || '') || String(before.city || '') !== String(city || '') || String(before.postal_code || '') !== String(postalCode || ''))) {
      try { await geocodeEstablishment(Number(before.id)); } catch (e) { console.error('[GEO] etab:', e); }
    }
    const updated = await dbGet('SELECT e.*, u.email, u.phone FROM establishments e JOIN users u ON u.id = e.user_id WHERE e.user_id = ?', [req.user.id]);
    return res.json(updated);
  } catch (err) { next(err); }
});


async function ownEstablishment(userId: number) {
  return dbGet('SELECT * FROM establishments WHERE user_id = ?', [userId]) as any;
}

async function publicDocument(row: any) {
  const file = row.id != null
    ? await dbGet('SELECT * FROM document_files WHERE owner_type = ? AND document_id = ? ORDER BY id DESC LIMIT 1', ['establishment', row.id]) as any
    : null;
  return {
    id: row.id,
    establishmentId: row.establishment_id,
    name: row.name,
    type: row.doc_type || '',
    status: row.status || 'pending',
    createdAt: row.created_at || null,
    fileStored: !!file,
    storage: file ? 'disk' : 'metadata',
    sizeBytes: file?.size_bytes || 0,
    storedName: file?.stored_name || null,
    mimeType: file?.mime_type || null
  };
}

function publicSubscription(row: any, payment?: { charged: false; paid: false; providerCalled: false; reason: string }) {
  return {
    id: row.id,
    establishmentId: row.establishment_id,
    name: row.name,
    status: row.status,
    price: row.price,
    createdAt: row.created_at || null,
    charged: false,
    paid: false,
    providerCalled: payment ? payment.providerCalled : false,
    reason: payment ? payment.reason : undefined
  };
}

/** Documents : métadonnées + octets du fichier sous uploads/. */
router.get('/me/documents', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const estab = await ownEstablishment(req.user.id);
    if (!estab) return res.status(404).json({ message: 'Établissement non trouvé.' });
    const rows = await dbAll('SELECT * FROM establishment_documents WHERE establishment_id = ? ORDER BY id DESC', [estab.id]);
    const out = [];
    for (const row of rows || []) out.push(await publicDocument(row));
    return res.json(out);
  } catch (err) { next(err); }
});

router.post('/me/documents', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const estab = await ownEstablishment(req.user.id);
    if (!estab) return res.status(404).json({ message: 'Établissement non trouvé.' });
    const name = String(req.body?.name || '').trim().slice(0, 200);
    const docType = String(req.body?.type || req.body?.docType || '').trim().slice(0, 80) || 'autre';
    if (!name) return res.status(422).json({ message: 'Nom du document requis.' });
    let saved;
    try {
      saved = saveBase64File(req.body || {});
    } catch (err: any) {
      return res.status(err.status || 422).json({ message: err.message || 'Fichier refusé.' });
    }
    const inserted = await dbRun(
      'INSERT INTO establishment_documents (establishment_id, name, doc_type, status) VALUES (?, ?, ?, ?)',
      [estab.id, name, docType, 'pending']
    );
    let id = inserted.lastInsertRowid;
    if (id == null) {
      const row = await dbGet('SELECT id FROM establishment_documents WHERE establishment_id = ? AND name = ? ORDER BY id DESC LIMIT 1', [estab.id, name]) as any;
      id = row?.id ?? null;
    }
    if (id == null) return res.status(500).json({ message: 'Document non enregistré.' });
    await dbRun(
      'INSERT INTO document_files (owner_type, document_id, stored_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)',
      ['establishment', id, saved.storedName, saved.mimeType, saved.sizeBytes]
    );
    void notifyAdmins('Document établissement à vérifier', `${estab.name} a déposé « ${name} » (${docType}).`, { establishmentId: estab.id, documentId: id, screen: 'establishments' }, 'admin_document');
    return res.status(201).json({
      ...(await publicDocument({ id, establishment_id: estab.id, name, doc_type: docType, status: 'pending', created_at: null })),
      message: 'Fichier enregistré sur le disque du serveur.'
    });
  } catch (err) { next(err); }
});

/** Abonnement : fiche name / status / price. Pas de paiement. */
router.get('/me/subscription', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const estab = await ownEstablishment(req.user.id);
    if (!estab) return res.status(404).json({ message: 'Établissement non trouvé.' });
    const row = await dbGet('SELECT * FROM establishment_subscriptions WHERE establishment_id = ? ORDER BY id DESC LIMIT 1', [estab.id]) as any;
    return res.json({ subscription: row ? publicSubscription(row) : null });
  } catch (err) { next(err); }
});

router.post('/me/subscription', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const estab = await ownEstablishment(req.user.id);
    if (!estab) return res.status(404).json({ message: 'Établissement non trouvé.' });
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const price = Number(req.body?.price);
    if (!name) return res.status(422).json({ message: 'Nom du plan requis.' });
    if (!Number.isFinite(price) || price < 0) return res.status(422).json({ message: 'Prix invalide.' });
    const payment = prepareSubscriptionPayment({ name, price, establishmentId: estab.id });
    const status = payment.status;
    const existing = await dbGet('SELECT id FROM establishment_subscriptions WHERE establishment_id = ? ORDER BY id DESC LIMIT 1', [estab.id]) as any;
    let id = existing?.id ?? null;
    if (existing) {
      await dbRun('UPDATE establishment_subscriptions SET name = ?, status = ?, price = ? WHERE id = ?', [name, status, price, existing.id]);
    } else {
      const inserted = await dbRun(
        'INSERT INTO establishment_subscriptions (establishment_id, name, status, price) VALUES (?, ?, ?, ?)',
        [estab.id, name, status, price]
      );
      id = inserted.lastInsertRowid;
      if (id == null) {
        const row = await dbGet('SELECT id FROM establishment_subscriptions WHERE establishment_id = ? ORDER BY id DESC LIMIT 1', [estab.id]) as any;
        id = row?.id ?? null;
      }
    }
    const message = payment.reason === 'missing_key'
      ? 'Abonnement enregistré en attente. STRIPE_SECRET_KEY absente : aucun paiement, rien n\'est marqué payé.'
      : 'Abonnement enregistré en attente. Le prestataire n\'est pas appelé : aucun paiement.';
    return res.status(existing ? 200 : 201).json({
      subscription: publicSubscription({ id, establishment_id: estab.id, name, status, price, created_at: null }, payment),
      message
    });
  } catch (err) { next(err); }
});

export default router;
