/** Runtime flags. Demo seed and SMS codes stay off in production unless explicitly enabled. */

export function isProduction(): boolean {
  return (process.env.NODE_ENV || '').trim() === 'production';
}

/** Demo accounts (admin123 / pro123). Off in production unless URGAD_SEED=1. */
export function allowDemoSeed(): boolean {
  const raw = (process.env.URGAD_SEED || '').trim();
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  return !isProduction();
}

/** Return phone verification codes in JSON. Off in production unless URGAD_EXPOSE_CODES=1. */
export function exposeVerificationCodes(): boolean {
  const raw = (process.env.URGAD_EXPOSE_CODES || '').trim();
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  return !isProduction();
}

export function assertProductionConfig(): void {
  if (!isProduction()) return;
  const jwt = (process.env.JWT_SECRET || '').trim();
  if (!jwt || jwt === 'urgad-dev-secret-change-in-production') {
    throw new Error('JWT_SECRET est requis en production (valeur longue et unique, pas le secret de démo).');
  }
  if (!(process.env.DATABASE_URL || '').trim()) {
    console.warn('[URGAD] DATABASE_URL absent : sqlite fichier, données perdues à chaque redéploiement Render. Branche Postgres avant d’ouvrir au public.');
  }
}
