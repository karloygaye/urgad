import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initializeDb } from './db.js';
import { seedIfEmpty } from './seed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import authRoutes from './routes/auth.js';
import professionalRoutes from './routes/professionals.js';
import establishmentRoutes from './routes/establishments.js';
import missionRoutes from './routes/missions.js';
import applicationRoutes from './routes/applications.js';
import notificationRoutes from './routes/notifications.js';
import messageRoutes from './routes/messages.js';
import adminRoutes from './routes/admin.js';
import deviceRoutes from './routes/devices.js';
import meRoutes from './routes/me.js';
import requestRoutes from './routes/requests.js';
import verificationRoutes from './routes/verification.js';
import { purgeVerifiedIdentityFiles } from './verification.js';
import { backfillCoordinates } from './geo.js';
import { pushStatus } from './notify.js';
import { assertProductionConfig } from './runtime.js';
import { publicCatalog } from './plans.js';
import { applyStripeEvent, getStripe, stripeEnabled } from './billing.js';

dotenv.config();
assertProductionConfig();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
function billingWebhookInfo(_req: any, res: any) {
  res.status(200).json({
    ok: true,
    method: 'POST',
    message: 'Endpoint Stripe. N’ouvrez pas cette URL dans le navigateur : Stripe envoie un POST signé. Dans le dashboard Stripe → Webhooks → Add endpoint, collez cette URL et choisissez checkout.session.completed, customer.subscription.updated, customer.subscription.deleted, invoice.paid, invoice.payment_failed.',
    stripeKey: stripeEnabled(),
    webhookSecret: !!(process.env.STRIPE_WEBHOOK_SECRET || '').trim(),
  });
}
app.get('/api/billing/webhook', billingWebhookInfo);
app.head('/api/billing/webhook', (_req, res) => res.status(200).end());
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const stripe = getStripe();
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!stripe || !secret) {
    res.status(503).json({ message: 'Webhook Stripe non configuré (STRIPE_WEBHOOK_SECRET manquant). Le paiement Checkout fonctionne déjà via le retour session_id.' });
    return;
  }
  const sig = req.headers['stripe-signature'];
  if (!sig || typeof sig !== 'string') {
    res.status(400).json({ message: 'Signature Stripe manquante.' });
    return;
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (e: any) {
    res.status(400).json({ message: e?.message || 'Signature invalide.' });
    return;
  }
  dbReady.then(() => applyStripeEvent(event)).then(() => {
    res.json({ received: true });
  }).catch((e) => {
    console.error('[STRIPE] webhook', e);
    if (!res.headersSent) res.status(500).json({ message: 'Webhook Stripe en erreur.' });
  });
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// One init. Sqlite file when DATABASE_URL is unset; Postgres otherwise.
const dbReady = initializeDb().catch((e) => {
  console.error('DB init error:', e);
  throw e;
});
// Coordonnées manquantes : géocodage des adresses déjà stockées (BAN), en tâche de fond.
dbReady.then(async () => {
  try {
    await seedIfEmpty();
  } catch (e) {
    console.error('[SEED] boot error:', e);
  }
  try {
    const r = await backfillCoordinates();
    const missing = [
      ...r.establishments.filter((x) => !x.result).map((x) => 'établissement #' + x.id + ' ' + x.name),
      ...r.professionals.filter((x) => !x.result).map((x) => 'pro user #' + x.userId + (x.reason ? ' (' + x.reason + ')' : '')),
      ...r.missions.filter((x) => !x.result).map((x) => 'mission #' + x.id),
    ];
    console.log(`[GEO] backfill: ${r.establishments.length} étab., ${r.professionals.length} pros, ${r.missions.length} missions traités. Sans coordonnées: ${missing.length ? missing.join(', ') : 'aucun'}`);
  } catch (e) { console.error('[GEO] backfill error:', e); }
  // Minimisation : fichiers d'identité effacés après vérification + durée de conservation (paramètre identity_file_retention_days).
  const purge = async () => { try { const n = await purgeVerifiedIdentityFiles(); if (n) console.log('[RGPD] fichiers d\'identité effacés après vérification : ' + n); } catch (e) { console.error('[RGPD] purge:', e); } };
  void purge();
  setInterval(purge, 12 * 3600 * 1000).unref();
  const ps = pushStatus();
  console.log('[PUSH] ' + (ps.configured ? 'FIREBASE_SERVICE_ACCOUNT défini' : 'FIREBASE_SERVICE_ACCOUNT absent : notifications in-app uniquement, push ignoré'));
  console.log('[STRIPE] ' + (stripeEnabled() ? 'Checkout abonnements activé' : 'STRIPE_SECRET_KEY absente : plans enregistrés sans débit'));
}).catch(() => {});
app.use((req, res, next) => {
  dbReady.then(() => next()).catch((e) => {
    console.error('DB init error:', e);
    if (!res.headersSent) res.status(500).json({ message: 'Base de données indisponible.' });
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/professionals', professionalRoutes);
app.use('/api/establishments', establishmentRoutes);
app.use('/api/missions', missionRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/me', meRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/verification', verificationRoutes);

app.get('/api/billing/plans', (_req, res) => {
  res.json({ ...publicCatalog(), stripeEnabled: stripeEnabled() });
});

// Health
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'URGAD API', version: '1.2.0', timestamp: new Date().toISOString(), push: pushStatus().configured ? 'fcm' : 'disabled' });
});

// Fronts produit : public/ (déploiement) puis sibling urgad-preview (dev local)
const previewCandidates = [
  process.env.PREVIEW_DIR,
  path.resolve(__dirname, '..', 'public'),
  path.resolve(__dirname, '..', '..', 'urgad-preview'),
].filter(Boolean) as string[];
const previewDir = previewCandidates.find((d) => fs.existsSync(d)) || previewCandidates[1];
app.use(express.static(previewDir));
app.get('/', (_req, res) => {
  res.sendFile(path.join(previewDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`URGAD API running on http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
  console.log(`UI:     http://localhost:${PORT}/ (preview HTML)`);
  console.log(`Pro:    http://localhost:${PORT}/urgad-pro.html`);
  console.log(`Etab:   http://localhost:${PORT}/urgad-etab.html`);
  console.log(`Admin:  http://localhost:${PORT}/urgad-bo.html`);
});

export default app;
