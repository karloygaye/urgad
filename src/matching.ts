import { dbAll, dbGet, dbRun } from './db.js';
import { haversineKm, num } from './geo.js';
import { notifySafe } from './notify.js';

export async function defaultRadiusKm(): Promise<number> {
  const row = await dbGet<any>("SELECT value FROM platform_settings WHERE setting_key = 'match_radius_km'");
  const n = parseInt(String(row?.value ?? '20'), 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Pros dont l'adresse géocodée est dans leur propre rayon autour de la mission. */
export async function prosWithinRadiusOfMission(missionId: number): Promise<Array<{ userId: number; distanceKm: number; radiusKm: number }>> {
  const c = await dbGet<any>('SELECT latitude, longitude FROM mission_coordinates WHERE mission_id = ?', [missionId]);
  const lat = num(c?.latitude), lng = num(c?.longitude);
  if (lat == null || lng == null) return [];
  const fallback = await defaultRadiusKm();
  const pros = await dbAll<any>("SELECT p.user_id, p.latitude, p.longitude, p.mobility_radius FROM professionals p JOIN users u ON u.id = p.user_id WHERE u.role = 'professional' AND u.deleted_at IS NULL AND u.verification_status NOT IN ('suspended','rejected') AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL");
  const out: Array<{ userId: number; distanceKm: number; radiusKm: number }> = [];
  for (const p of pros) {
    const radius = num(p.mobility_radius) || fallback;
    const d = haversineKm(lat, lng, Number(p.latitude), Number(p.longitude));
    if (d <= radius) out.push({ userId: Number(p.user_id), distanceKm: Math.round(d * 10) / 10, radiusKm: radius });
  }
  return out;
}

/** "Nouvelle mission près de chez vous". force=true : relance même si déjà notifié (FLASH BO). */
export async function notifyProsForMission(missionId: number, opts: { force?: boolean } = {}): Promise<number> {
  const m = await dbGet<any>('SELECT id, title, establishment_name, start_date, start_hour, status, visible, notified_at, urgent FROM missions WHERE id = ?', [missionId]);
  if (!m || Number(m.visible) !== 1 || m.status === 'cancelled' || m.status === 'completed') return 0;
  if (!opts.force && m.notified_at) return 0;
  if (String(m.start_date || '').slice(0, 10) < todayIso()) return 0;
  await dbRun("UPDATE missions SET notified_at = datetime('now') WHERE id = ?", [missionId]);
  const targets = await prosWithinRadiusOfMission(missionId);
  for (const t of targets) {
    await notifySafe(t.userId,
      (Number(m.urgent) === 1 ? '🚨 Mission urgente' : 'Nouvelle mission') + ' à ' + t.distanceKm.toString().replace('.', ',') + ' km',
      `${m.establishment_name} — ${m.title} — le ${String(m.start_date).slice(0, 10)}${m.start_hour ? ' à ' + m.start_hour : ''}`,
      { missionId: m.id, distanceKm: t.distanceKm, screen: 'detail-' + m.id }, 'new_mission');
  }
  return targets.length;
}
