/**
 * Service unique de notification.
 * 1. Écrit toujours la ligne in-app dans `notifications`.
 * 2. Envoie un push Firebase Cloud Messaging (HTTP v1, via firebase-admin) vers les appareils
 *    enregistrés de l'utilisateur, seulement si FIREBASE_SERVICE_ACCOUNT est défini
 *    (JSON du compte de service, ou chemin vers le fichier). Sans identifiants : log + pas de push.
 * Aucun SMS, aucun e-mail.
 */
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { dbAll, dbGet, dbRun } from './db.js';

let messagingPromise: Promise<any | null> | null = null;
let pushDisabledReason = '';

function readServiceAccount(): any | null {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) { pushDisabledReason = 'FIREBASE_SERVICE_ACCOUNT absent'; return null; }
  try {
    const text = raw.startsWith('{') ? raw : fs.readFileSync(raw, 'utf8');
    const json = JSON.parse(text);
    if (!json.project_id || !json.private_key || !json.client_email) throw new Error('champs project_id / private_key / client_email manquants');
    return json;
  } catch (e: any) {
    pushDisabledReason = 'FIREBASE_SERVICE_ACCOUNT illisible: ' + (e?.message || e);
    return null;
  }
}

async function getMessaging(): Promise<any | null> {
  if (!messagingPromise) {
    messagingPromise = (async () => {
      const account = readServiceAccount();
      if (!account) { console.log('[PUSH] désactivé —', pushDisabledReason); return null; }
      try {
        const appMod: any = await import('firebase-admin/app');
        const msgMod: any = await import('firebase-admin/messaging');
        const app = appMod.getApps().length ? appMod.getApps()[0] : appMod.initializeApp({ credential: appMod.cert(account) });
        console.log('[PUSH] Firebase Cloud Messaging actif (projet ' + account.project_id + ')');
        return msgMod.getMessaging(app);
      } catch (e: any) {
        pushDisabledReason = 'firebase-admin indisponible: ' + (e?.message || e);
        console.log('[PUSH] désactivé —', pushDisabledReason);
        return null;
      }
    })();
  }
  return messagingPromise;
}

export function pushStatus(): { configured: boolean; reason: string } {
  const configured = !!(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  return { configured, reason: configured ? (pushDisabledReason || 'ok') : 'FIREBASE_SERVICE_ACCOUNT absent' };
}

/** Destinataire "legacy" (recipient_id = id de la fiche pro / établissement) pour rester compatible. */
async function legacyRecipient(userId: number): Promise<{ id: number; type: string }> {
  const u = await dbGet<any>('SELECT id, role, is_admin FROM users WHERE id = ?', [userId]);
  if (u?.role === 'professional') {
    const p = await dbGet<any>('SELECT id FROM professionals WHERE user_id = ?', [userId]);
    if (p) return { id: Number(p.id), type: 'professional' };
  }
  if (u?.role === 'establishment') {
    const e = await dbGet<any>('SELECT id FROM establishments WHERE user_id = ?', [userId]);
    if (e) return { id: Number(e.id), type: 'establishment' };
  }
  return { id: userId, type: u?.is_admin ? 'admin' : (u?.role || 'user') };
}

export interface NotifyResult { notificationId: string; push: 'sent' | 'partial' | 'failed' | 'no_device' | 'skipped_no_credentials'; devices: number; }

export async function notify(userId: number, title: string, body: string, data: Record<string, any> = {}, type = 'info'): Promise<NotifyResult> {
  const uuid = uuidv4();
  const recipient = await legacyRecipient(userId);
  const payload: Record<string, string> = {};
  for (const [k, v] of Object.entries({ type, ...data })) if (v != null) payload[k] = String(v);
  await dbRun('INSERT INTO notifications (uuid, recipient_id, recipient_type, type, title, content, user_id, data, push_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [uuid, recipient.id, recipient.type, type, String(title).slice(0, 180), String(body || '').slice(0, 2000), userId, JSON.stringify(payload), 'pending']);

  let status: NotifyResult['push'] = 'no_device';
  const devices = await dbAll<any>('SELECT token, platform FROM device_tokens WHERE user_id = ?', [userId]);
  const messaging = await getMessaging();
  if (!messaging) {
    status = 'skipped_no_credentials';
    console.log(`[PUSH skip] user=${userId} devices=${devices.length} "${title}" — ${pushDisabledReason || 'pas d\'identifiants Firebase'}`);
  } else if (devices.length) {
    try {
      const res = await messaging.sendEachForMulticast({
        tokens: devices.map((d) => d.token),
        notification: { title: String(title).slice(0, 180), body: String(body || '').slice(0, 1000) },
        data: { ...payload, notificationId: uuid },
        android: {
          priority: 'high',
          notification: {
            channelId: 'urgad',
            sound: 'default',
            defaultSound: true,
            defaultVibrateTimings: true,
            vibrateTimingsMillis: [0, 180, 80, 180],
          },
        },
        apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      });
      // Jetons expirés / désinstallés : on les retire.
      res.responses.forEach((r: any, i: number) => {
        const code = r?.error?.code || '';
        if (!r.success && (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token') || code.includes('invalid-argument'))) {
          void dbRun('DELETE FROM device_tokens WHERE token = ?', [devices[i].token]);
        }
      });
      status = res.failureCount === 0 ? 'sent' : (res.successCount > 0 ? 'partial' : 'failed');
    } catch (e: any) {
      status = 'failed';
      console.error('[PUSH] échec envoi:', e?.message || e);
    }
  }
  await dbRun('UPDATE notifications SET push_status = ? WHERE uuid = ?', [status, uuid]);
  return { notificationId: uuid, push: status, devices: devices.length };
}

/** Ne jamais faire échouer la requête métier à cause d'une notification. */
export async function notifySafe(userId: number | null | undefined, title: string, body: string, data: Record<string, any> = {}, type = 'info'): Promise<NotifyResult | null> {
  if (userId == null) return null;
  try { return await notify(Number(userId), title, body, data, type); }
  catch (e: any) { console.error('[NOTIFY] erreur:', e?.message || e); return null; }
}

export async function notifyAdmins(title: string, body: string, data: Record<string, any> = {}, type = 'admin'): Promise<number> {
  const admins = await dbAll<any>("SELECT id FROM users WHERE (is_admin = 1 OR role = 'admin') AND deleted_at IS NULL");
  for (const a of admins) await notifySafe(Number(a.id), title, body, data, type);
  return admins.length;
}
