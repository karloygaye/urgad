import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { dbAll, dbGet, dbRun } from './db.js';
import { config } from './config.js';
import { publicUrl } from './billing.js';
import { sendMail } from './mail.js';
import { notifyAdmins, notifySafe } from './notify.js';
import { isProduction } from './runtime.js';

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function spaceOfUser(user: { is_admin?: number; role?: string }) {
  if (user.is_admin) return 'admin';
  if (user.role === 'establishment') return 'establishment';
  if (user.role === 'professional') return 'professional';
  return 'professional';
}

export function loginPath(space: string) {
  if (space === 'establishment') return '/urgad-etab.html';
  if (space === 'admin') return '/urgad-bo.html';
  return '/urgad-pro.html';
}

export function spaceLabel(space: string) {
  if (space === 'establishment') return 'établissement';
  if (space === 'admin') return 'back-office';
  return 'professionnel';
}

const GENERIC =
  'Si un compte existe pour cet e-mail, un lien de réinitialisation a été préparé (valable 1 heure). Consultez votre messagerie. Sinon écrivez à leprincegaye@urgad.fr (établissements) ou rachel@urgad.fr (soignants).';

function buildResetUrl(req: any, token: string, space: string) {
  return publicUrl(req) + '/reset.html?token=' + encodeURIComponent(token) + '&space=' + encodeURIComponent(space);
}

async function insertResetToken(userId: number) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  await dbRun('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)', [
    userId,
    hashToken(token),
    expires,
  ]);
  return token;
}

async function mailReset(email: string, resetUrl: string) {
  return sendMail({
    to: email,
    subject: 'Réinitialiser votre mot de passe URGAD',
    text:
      'Bonjour,\n\nVous avez demandé à réinitialiser le mot de passe de votre espace URGAD.\n' +
      'Ce lien est valable 1 heure :\n' +
      resetUrl +
      '\n\nSi vous n’êtes pas à l’origine de cette demande, ignorez ce message.\n\nURGAD — https://urgad.fr',
  });
}

async function announceReset(user: { email: string }, space: string, mailed: boolean, resetUrl: string) {
  await notifyAdmins(
    'Mot de passe oublié',
    mailed
      ? `${user.email} (${spaceLabel(space)}) a demandé une réinitialisation. Un e-mail avec le lien a été envoyé.`
      : `${user.email} (${spaceLabel(space)}) a demandé une réinitialisation. Pas d’e-mail automatique : copiez ce lien (1 h) : ${resetUrl}`,
    { screen: 'notif', email: user.email, space, mailed, resetUrl },
    'admin_password_reset'
  );
}

/** Génère un lien (1 h) pour un compte déjà chargé — usage back-office. */
export async function issueResetLinkForUser(
  user: { id: number; email: string; role?: string; is_admin?: number },
  req?: any
) {
  const token = await insertResetToken(Number(user.id));
  const space = spaceOfUser(user);
  const resetUrl = buildResetUrl(req, token, space);
  const mailed = await mailReset(user.email, resetUrl);
  await announceReset(user, space, mailed, resetUrl);
  return { resetUrl, mailed, space, email: user.email, expiresInMinutes: 60 };
}

export async function issueResetLinkByUserId(userId: number, req?: any) {
  const user = await dbGet<any>('SELECT id, email, role, is_admin FROM users WHERE id = ? AND deleted_at IS NULL', [userId]);
  if (!user) {
    const err: any = new Error('Utilisateur introuvable.');
    err.status = 404;
    throw err;
  }
  return issueResetLinkForUser(user, req);
}

function parseUtc(raw: string) {
  const s = String(raw || '').trim();
  if (!s) return 0;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') : s.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

async function loadTokenRow(token: string) {
  const tokenHash = hashToken(String(token || '').trim());
  if (tokenHash.length < 16) return null;
  const row = await dbGet<any>(
    `SELECT r.id, r.user_id, r.expires_at, r.used_at, u.email, u.role, u.is_admin, u.deleted_at
     FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?`,
    [tokenHash]
  );
  if (!row || row.deleted_at || row.used_at) return null;
  if (parseUtc(row.expires_at) < Date.now()) return null;
  return row;
}

export async function requestPasswordReset(emailRaw: string, req?: any) {
  const email = String(emailRaw || '').trim().toLowerCase();
  const out: { message: string; mailed: boolean; resetUrl?: string } = { message: GENERIC, mailed: false };
  if (!email || !email.includes('@')) return out;
  const user = await dbGet<any>('SELECT id, email, role, is_admin FROM users WHERE lower(email) = ? AND deleted_at IS NULL', [email]);
  if (!user) return out;
  const recent = await dbAll<any>('SELECT created_at FROM password_resets WHERE user_id = ?', [user.id]);
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const nRecent = (recent || []).filter((r) => parseUtc(r.created_at) >= hourAgo).length;
  if (nRecent >= 5) return out;
  const issued = await issueResetLinkForUser(user, req);
  out.mailed = issued.mailed;
  if (!isProduction()) out.resetUrl = issued.resetUrl;
  return out;
}

export async function inspectResetToken(token: string) {
  const row = await loadTokenRow(token);
  if (!row) return null;
  const email = String(row.email || '');
  const at = email.indexOf('@');
  const masked = at > 1 ? email[0] + '••••' + email.slice(at) : '••••';
  const space = spaceOfUser(row);
  return { emailMasked: masked, space, spaceLabel: spaceLabel(space) };
}

export async function consumeResetToken(token: string, newPassword: string) {
  const password = String(newPassword || '');
  if (password.length < 6) {
    const err: any = new Error('Le mot de passe doit contenir au moins 6 caractères.');
    err.status = 422;
    throw err;
  }
  const row = await loadTokenRow(token);
  if (!row) {
    const err: any = new Error('Lien invalide ou expiré. Demandez une nouvelle réinitialisation.');
    err.status = 400;
    throw err;
  }
  await dbRun("UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL", [row.user_id]);
  await dbRun("UPDATE users SET password = ?, password_changed_at = datetime('now') WHERE id = ?", [await bcrypt.hash(password, 12), row.user_id]);
  await notifySafe(
    Number(row.user_id),
    'Mot de passe modifié',
    'Votre mot de passe URGAD a été réinitialisé. Si ce n’était pas vous, contactez-nous tout de suite.',
    { screen: 'login' },
    'password_changed'
  );
  const space = spaceOfUser(row);
  const jwtToken = jwt.sign(
    { id: Number(row.user_id), role: row.role, email: row.email, isAdmin: row.is_admin === 1 },
    config.jwtSecret,
    { expiresIn: config.jwtExpiry }
  );
  return {
    token: jwtToken,
    space,
    loginPath: loginPath(space),
    user: { id: Number(row.user_id), email: row.email, role: row.role, isAdmin: row.is_admin === 1 },
  };
}

export async function changePassword(userId: number, currentPassword: string, newPassword: string) {
  const user = await dbGet<any>('SELECT id, password FROM users WHERE id = ? AND deleted_at IS NULL', [userId]);
  if (!user) {
    const err: any = new Error('Compte introuvable.');
    err.status = 404;
    throw err;
  }
  const ok = await bcrypt.compare(String(currentPassword || ''), user.password);
  if (!ok) {
    const err: any = new Error('Mot de passe actuel incorrect.');
    err.status = 401;
    throw err;
  }
  if (String(newPassword || '').length < 6) {
    const err: any = new Error('Le nouveau mot de passe doit contenir au moins 6 caractères.');
    err.status = 422;
    throw err;
  }
  await dbRun("UPDATE users SET password = ?, password_changed_at = datetime('now') WHERE id = ?", [await bcrypt.hash(String(newPassword), 12), userId]);
  await dbRun("UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL", [userId]);
  return { message: 'Mot de passe mis à jour. Les autres appareils devront se reconnecter à l’expiration du jeton.' };
}
