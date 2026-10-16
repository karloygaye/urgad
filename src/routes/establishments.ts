import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { dbRun, dbGet, dbAll } from '../db.js';
import { config } from '../config.js';
import { confirmCheckoutSession, createCheckoutSession, createExtraMissionCheckout, createPortalSession, stripeEnabled, stripeLiveStatus, subscriptionIsPaid } from '../billing.js';
import { planById, planByName, publicCatalog, trialInfo, usageThisMonth } from '../plans.js';
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

function publicSubscription(row: any, payment?: { charged?: boolean; paid?: boolean; providerCalled?: boolean; reason?: string; checkoutUrl?: string | null }, extras?: { usage?: { missions: number; flash: number; since: string } }) {
  const plan = planByName(row.name);
  const paid = payment?.paid ?? subscriptionIsPaid(row.status);
  return {
    id: row.id,
    establishmentId: row.establishment_id,
    name: row.name,
    planId: plan?.id || null,
    status: row.status,
    price: plan?.priceHt ?? row.price,
    createdAt: row.created_at || null,
    charged: paid,
    paid,
    stripeEnabled: stripeEnabled(),
    checkoutUrl: payment?.checkoutUrl || null,
    providerCalled: payment?.providerCalled ?? false,
    reason: payment?.reason,
    plan: plan || null,
    usage: extras?.usage || null,
    extraCredits: Number(row.extra_credits || 0),
    extraMissionHt: plan?.extraMissionHt ?? null,
    portalAvailable: !!(row.stripe_customer_id && stripeEnabled() && (paid || String(row.status || '').toLowerCase() === 'past_due')),
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

/** Abonnement : fiche, essai, Checkout Stripe et confirmation. */
router.get('/me/subscription', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const estab = await ownEstablishment(req.user.id);
    if (!estab) return res.status(404).json({ message: 'Établissement non trouvé.' });
    let row = await dbGet('SELECT * FROM establishment_subscriptions WHERE establishment_id = ? ORDER BY id DESC LIMIT 1', [estab.id]) as any;
    if (row) {
      const catalogPlan = planByName(row.name);
      if (catalogPlan && Number(row.price) !== catalogPlan.priceHt) {
        await dbRun('UPDATE establishment_subscriptions SET price = ? WHERE id = ?', [catalogPlan.priceHt, row.id]);
        row = { ...row, price: catalogPlan.priceHt };
      }
    }
    const usage = await usageThisMonth(Number(estab.id));
    const paid = row ? subscriptionIsPaid(row.status) : false;
    const trial = await trialInfo(Number(estab.id), paid);
    const live = await stripeLiveStatus();
    return res.json({
      subscription: row ? publicSubscription(row, undefined, { usage }) : null,
      catalog: {
        ...publicCatalog(),
        stripeEnabled: stripeEnabled(),
        stripeChargesEnabled: live.chargesEnabled,
        stripeLivemode: live.livemode,
        stripeMessage: live.message,
      },
      usage,
      trial,
      stripeEnabled: stripeEnabled(),
      stripeChargesEnabled: live.chargesEnabled,
    });
  } catch (err) { next(err); }
});

router.post('/me/subscription', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const estab = await ownEstablishment(req.user.id);
    if (!estab) return res.status(404).json({ message: 'Établissement non trouvé.' });
    const plan = planById(String(req.body?.id || '')) || planByName(String(req.body?.name || ''));
    if (!plan) return res.status(422).json({ message: 'Plan inconnu. Essentiel, Pro ou Premium.' });
    const name = plan.name;
    const price = plan.priceHt;
    const existing = await dbGet('SELECT * FROM establishment_subscriptions WHERE establishment_id = ? ORDER BY id DESC LIMIT 1', [estab.id]) as any;
    let id = existing?.id ?? null;
    const keepPaid = existing && subscriptionIsPaid(existing.status) && String(existing.name) === name;
    const status = keepPaid ? existing.status : 'pending';
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
    if (id == null) return res.status(500).json({ message: 'Abonnement non enregistré.' });
    const user = await dbGet<{ email: string }>('SELECT email FROM users WHERE id = ?', [req.user.id]);
    let checkoutUrl: string | null = null;
    let reason: 'missing_key' | 'ok' | 'already_paid' | 'charges_disabled' = 'missing_key';
    if (keepPaid) {
      reason = 'already_paid';
    } else if (stripeEnabled()) {
      const checkout = await createCheckoutSession({
        plan,
        establishmentId: Number(estab.id),
        subscriptionRowId: Number(id),
        email: String(user?.email || ''),
        existingCustomerId: existing?.stripe_customer_id || null,
        req,
      });
      checkoutUrl = checkout.url;
      reason = checkout.reason;
      if (checkout.customerId) {
        await dbRun('UPDATE establishment_subscriptions SET stripe_customer_id = ? WHERE id = ?', [checkout.customerId, id]);
      }
    }
    const live = reason === 'charges_disabled' ? await stripeLiveStatus() : null;
    const message = reason === 'already_paid'
      ? 'Cette formule est déjà active.'
      : reason === 'ok'
        ? 'Redirection vers Stripe pour le paiement de l’abonnement.'
        : reason === 'charges_disabled'
          ? (live?.message || 'Stripe live n’encaisse pas encore les cartes. Complétez l’activation du compte.')
          : 'Abonnement enregistré en attente. STRIPE_SECRET_KEY absente : aucun débit.';
    return res.status(existing ? 200 : 201).json({
      subscription: publicSubscription({ id, establishment_id: estab.id, name, status, price, created_at: null }, {
        charged: keepPaid, paid: keepPaid, providerCalled: reason === 'ok', reason, checkoutUrl,
      }),
      checkoutUrl,
      message,
    });
  } catch (err) { next(err); }
});

router.post('/me/subscription/confirm', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const estab = await ownEstablishment(req.user.id);
    if (!estab) return res.status(404).json({ message: 'Établissement non trouvé.' });
    const sessionId = String(req.body?.sessionId || req.body?.session_id || '').trim();
    if (!sessionId) return res.status(422).json({ message: 'sessionId requis.' });
    const result = await confirmCheckoutSession(sessionId, Number(estab.id));
    const row = await dbGet('SELECT * FROM establishment_subscriptions WHERE establishment_id = ? ORDER BY id DESC LIMIT 1', [estab.id]) as any;
    const confirmation = result.confirmation;
    const message = result.ok
      ? (confirmation?.title || 'Paiement confirmé') + '. ' + (confirmation?.body || 'Abonnement actif.')
      : 'Paiement non confirmé. Si vous avez payé, patientez quelques secondes : le webhook Stripe active aussi la formule. Sinon contactez URGAD.';
    return res.json({
      confirmed: result.ok,
      subscription: row ? publicSubscription(row) : null,
      confirmation,
      message,
    });
  } catch (err) { next(err); }
});

router.post('/me/subscription/portal', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const estab = await ownEstablishment(req.user.id);
    if (!estab) return res.status(404).json({ message: 'Établissement non trouvé.' });
    const row = await dbGet('SELECT * FROM establishment_subscriptions WHERE establishment_id = ? ORDER BY id DESC LIMIT 1', [estab.id]) as any;
    if (!row?.stripe_customer_id) return res.status(422).json({ message: 'Aucun client Stripe : payez d’abord un abonnement.' });
    const portal = await createPortalSession({ customerId: String(row.stripe_customer_id), req });
    if (!portal.url) return res.status(503).json({ message: 'Portail Stripe indisponible.' });
    return res.json({ url: portal.url, message: 'Ouverture du portail facturation Stripe (factures, carte, résiliation).' });
  } catch (err) { next(err); }
});

router.post('/me/subscription/extra', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const estab = await ownEstablishment(req.user.id);
    if (!estab) return res.status(404).json({ message: 'Établissement non trouvé.' });
    const row = await dbGet('SELECT * FROM establishment_subscriptions WHERE establishment_id = ? ORDER BY id DESC LIMIT 1', [estab.id]) as any;
    if (!row || !subscriptionIsPaid(row.status)) return res.status(402).json({ message: 'Un abonnement payé est requis pour acheter une demande extra.', code: 'trial_exhausted' });
    const plan = planByName(row.name);
    if (!plan || plan.extraMissionHt == null) return res.status(422).json({ message: 'Cette formule n’a pas de tarif extra.' });
    if (plan.extraMissionHt === 0) return res.status(422).json({ message: 'Le plan Premium inclut les demandes illimitées : pas de extra à payer.' });
    const user = await dbGet<{ email: string }>('SELECT email FROM users WHERE id = ?', [req.user.id]);
    const checkout = await createExtraMissionCheckout({
      plan,
      establishmentId: Number(estab.id),
      subscriptionRowId: Number(row.id),
      email: String(user?.email || ''),
      existingCustomerId: row.stripe_customer_id || null,
      req,
    });
    if (!checkout.url) {
      const live = await stripeLiveStatus();
      return res.status(503).json({ message: checkout.reason === 'charges_disabled' ? (live.message || 'Stripe n’encaisse pas encore.') : 'Paiement extra indisponible.' });
    }
    return res.json({
      checkoutUrl: checkout.url,
      extraHt: plan.extraMissionHt,
      message: 'Redirection vers Stripe pour 1 demande supplémentaire (' + plan.extraMissionHt + ' € HT).',
    });
  } catch (err) { next(err); }
});

export default router;
