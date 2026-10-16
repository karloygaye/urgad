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

dotenv.config();
assertProductionConfig();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
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
  res.json(publicCatalog());
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
