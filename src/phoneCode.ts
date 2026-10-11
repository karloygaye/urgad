import { dbGet, dbRun } from './db.js';

/** Store a 6-digit code. Does not call an SMS provider. */
export async function storePhoneCode(userId: number, phone: string): Promise<string> {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  await dbRun(
    'INSERT INTO phone_verifications (user_id, phone, code, used, expires_at) VALUES (?, ?, ?, 0, ?)',
    [userId, phone || '', code, expires]
  );
  return code;
}

export async function consumePhoneCode(userId: number, code: string): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const normalized = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) {
    return { ok: false, status: 422, message: 'Code à 6 chiffres requis.' };
  }
  const row = await dbGet(
    'SELECT * FROM phone_verifications WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1',
    [userId]
  ) as any;
  if (!row || String(row.code) !== normalized) {
    return { ok: false, status: 401, message: 'Code incorrect.' };
  }
  if (row.expires_at) {
    const exp = new Date(String(row.expires_at).replace(' ', 'T') + 'Z');
    if (!Number.isNaN(exp.getTime()) && exp.getTime() < Date.now()) {
      return { ok: false, status: 401, message: 'Code expiré. Demandez un nouveau code.' };
    }
  }
  await dbRun('UPDATE phone_verifications SET used = 1 WHERE id = ?', [row.id]);
  await dbRun('UPDATE users SET verified = 1 WHERE id = ?', [userId]);
  return { ok: true };
}
