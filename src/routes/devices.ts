import { Router } from 'express';
import { dbRun, dbGet, dbAll } from '../db.js';
import { authMiddleware } from './_auth.js';
import { pushStatus } from '../notify.js';

const router = Router();
const PLATFORMS = ['android', 'ios', 'web'];

/** Enregistrer le jeton push (FCM / APNs via FCM) de l'appareil pour l'utilisateur connecté. */
router.post('/', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const token = String(req.body?.token || '').trim();
    const platform = String(req.body?.platform || '').trim().toLowerCase();
    if (token.length < 20 || token.length > 4096) return res.status(422).json({ message: 'Jeton appareil invalide.' });
    if (!PLATFORMS.includes(platform)) return res.status(422).json({ message: 'Plateforme : android, ios ou web.' });
    const existing = await dbGet('SELECT id FROM device_tokens WHERE token = ?', [token]) as any;
    if (existing) {
      await dbRun("UPDATE device_tokens SET user_id = ?, platform = ?, updated_at = datetime('now') WHERE id = ?", [req.user.id, platform, existing.id]);
    } else {
      await dbRun('INSERT INTO device_tokens (user_id, token, platform) VALUES (?, ?, ?)', [req.user.id, token, platform]);
    }
    const count = await dbGet('SELECT COUNT(*) AS count FROM device_tokens WHERE user_id = ?', [req.user.id]) as any;
    return res.status(existing ? 200 : 201).json({ message: 'Appareil enregistré.', platform, devices: Number(count?.count || 0), push: pushStatus() });
  } catch (err) { next(err); }
});

/** Mes appareils (jeton tronqué). */
router.get('/', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const rows = await dbAll('SELECT id, platform, token, created_at, updated_at FROM device_tokens WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
    return res.json({ devices: rows.map((r: any) => ({ ...r, token: String(r.token).slice(0, 12) + '…' })), push: pushStatus() });
  } catch (err) { next(err); }
});

/** Retirer un jeton (déconnexion / désinstallation). Body {token} ou /api/devices/:token */
async function removeToken(req: any, res: any, next: any) {
  try {
    const token = String(req.params?.token || req.body?.token || '').trim();
    if (!token) return res.status(422).json({ message: 'Jeton requis.' });
    await dbRun('DELETE FROM device_tokens WHERE token = ? AND user_id = ?', [token, req.user.id]);
    return res.json({ message: 'Appareil retiré.' });
  } catch (err) { next(err); }
}
router.delete('/', authMiddleware, removeToken);
router.delete('/:token', authMiddleware, removeToken);

export default router;
