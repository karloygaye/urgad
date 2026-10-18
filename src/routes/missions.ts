import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { dbRun, dbGet, dbAll } from '../db.js';
import { config } from '../config.js';
import { geocodeMission, haversineKm, num } from '../geo.js';
import { defaultRadiusKm, notifyProsForMission } from '../matching.js';
import { logEvent, normPoste } from '../requests.js';
import { assertEstablishmentPublish } from '../plans.js';
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

/** Créer une mission */
router.post('/', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const { type, title, description, conditions, location, startDate, endDate, startHour, endHour, establishmentName, establishmentEmail, urgent } = req.body;
    if (!type || !title || !startDate || !startHour || !endHour || !establishmentName) {
      return res.status(422).json({ message: 'Type, titre, date, horaires et nom établissement requis.' });
    }
    // Si pas d'establishmentId, on vérifie que le user est un établissement
    if (req.user.role === 'establishment') {
      const est = await dbGet('SELECT id, email FROM establishments WHERE user_id = ?', [req.user.id]) as any;
      if (!est) return res.status(422).json({ message: 'Établissement non trouvé.' });
      try { await assertEstablishmentPublish(Number(est.id), { urgent: !!urgent }); }
      catch (e: any) { if (e?.status) return res.status(e.status).json({ message: e.message, code: e.code, extraHt: e.extraHt }); throw e; }
      const estEmail = establishmentEmail || est.email || '';
      const { lastInsertRowid } = await dbRun('INSERT INTO missions (uuid, establishment_id, establishment_name, establishment_email, type, title, description, conditions, location, start_date, end_date, start_hour, end_hour, urgent, visible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [uuidv4(), est.id, establishmentName, estEmail, type, title, description || '', conditions || '', location || '', startDate, endDate || null, startHour, endHour, urgent ? 1 : 0, 1]);
      return res.status(201).json(await afterCreate(lastInsertRowid, req));
    } else if (req.user.isAdmin) {
      const estEmail = establishmentEmail || '';
      const estId = req.body.establishmentId;
      if (!estId) return res.status(422).json({ message: 'establishmentId requis pour un admin.' });
      const { lastInsertRowid } = await dbRun('INSERT INTO missions (uuid, establishment_id, establishment_name, establishment_email, type, title, description, conditions, location, start_date, end_date, start_hour, end_hour, urgent, visible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [uuidv4(), estId, establishmentName, estEmail, type, title, description || '', conditions || '', location || '', startDate, endDate || null, startHour, endHour, urgent ? 1 : 0, 1]);
      return res.status(201).json(await afterCreate(lastInsertRowid, req));
    }
    return res.status(403).json({ message: 'Compte professionnel — impossible de créer une mission.' });
  } catch (err) { next(err); }
});

/** Géocode la mission puis prévient les pros dans leur rayon. Ne fait jamais échouer la création. */
async function afterCreate(id: number | null, req: any) {
  const out: any = { id, message: 'Mission créée.' };
  if (id == null) return out;
  // Formulaire détaillé = une demande comme les autres (statut « nouvelle », source plateforme).
  const b = req.body || {};
  const source = ['telephone', 'email', 'formulaire', 'plateforme'].includes(String(b.source)) ? String(b.source) : 'plateforme';
  await dbRun('UPDATE missions SET request_status = ?, request_source = ?, poste = ?, request_notes = ?, created_by_user_id = ? WHERE id = ?',
    ['nouvelle', source, normPoste(b.poste || b.title) || 'autre', String(b.notes || b.description || '').slice(0, 2000), req.user.id, id]);
  await logEvent(Number(id), { id: Number(req.user.id), role: req.user.isAdmin ? 'admin' : req.user.role }, 'created', null, 'nouvelle', null, 'source=' + source);
  out.requestStatus = 'nouvelle';
  try {
    const g = await geocodeMission(Number(id));
    out.latitude = g?.latitude ?? null;
    out.longitude = g?.longitude ?? null;
    out.coordinatesSource = g?.source ?? null;
  } catch (e) { console.error('[GEO] mission:', e); }
  try { out.notifiedProfessionals = await notifyProsForMission(Number(id)); } catch (e) { console.error('[NOTIFY] mission:', e); }
  if (req.user.role === 'establishment') {
    const when = `${String(b.startDate || '').slice(0, 10)} ${b.startHour || ''}–${b.endHour || ''}`;
    try {
      out.notifiedAdmins = await notifyAdmins(
        Number(b.urgent) ? 'Nouvelle demande urgente' : 'Nouvelle demande à traiter',
        `${b.establishmentName || 'Établissement'} : ${b.title || b.poste || 'mission'} le ${when}${b.conditions ? ' — ' + String(b.conditions).slice(0, 80) : ''}`,
        { missionId: id, screen: 'requests' }, 'request_new');
    } catch (e) { console.error('[NOTIFY] admin request:', e); }
  }
  return out;
}

const MISSION_SELECT = 'SELECT m.*, c.latitude, c.longitude, c.geocode_precision, c.source AS coordinates_source FROM missions m LEFT JOIN mission_coordinates c ON c.mission_id = m.id';

/**
 * Missions visibles par un pro, filtrées par distance réelle (haversine) :
 * origine = ?lat&lng (position de l'appareil) sinon l'adresse géocodée du pro ;
 * rayon = ?radius sinon le rayon de déplacement du pro, sinon le rayon par défaut du matching.
 */
async function missionsForPro(req: any) {
  const prof = await dbGet('SELECT latitude, longitude, mobility_radius, geocode_label, geocode_precision, address, city, postal_code FROM professionals WHERE user_id = ?', [req.user.id]) as any;
  const qLat = num(req.query.lat), qLng = num(req.query.lng);
  let origin: any = null;
  if (qLat != null && qLng != null && Math.abs(qLat) <= 90 && Math.abs(qLng) <= 180) origin = { latitude: qLat, longitude: qLng, source: 'device' };
  else if (num(prof?.latitude) != null && num(prof?.longitude) != null) origin = { latitude: Number(prof.latitude), longitude: Number(prof.longitude), source: 'profile_address', label: prof.geocode_label, precision: prof.geocode_precision };
  const qRadius = num(req.query.radius);
  const fallback = await defaultRadiusKm();
  const radiusKm = qRadius != null && qRadius > 0 ? Math.min(qRadius, 1000) : (num(prof?.mobility_radius) || fallback);
  const radiusSource = qRadius != null && qRadius > 0 ? 'query' : (num(prof?.mobility_radius) ? 'professional' : 'platform_default');
  const rows = await dbAll(MISSION_SELECT + " WHERE m.visible = 1 AND m.status != 'cancelled' AND m.status != 'completed' AND COALESCE(m.request_status, 'nouvelle') NOT IN ('validee','realisee','annulee') AND date(m.start_date) >= date('now') ORDER BY m.start_date ASC") as any[];
  const withCount = (list: any[]) => list.map((m) => ({ ...m, applicationCount: m.application_count || 0 }));
  let missions: any[];
  let outside: any[] = [];
  let withoutCoordinates = 0;
  if (origin) {
    missions = [];
    outside = [];
    for (const m of rows) {
      const lat = num(m.latitude), lng = num(m.longitude);
      if (lat == null || lng == null) {
        withoutCoordinates++;
        missions.push({ ...m, distance_km: null, unlocated: true });
        continue;
      }
      const d = Math.round(haversineKm(origin.latitude, origin.longitude, lat, lng) * 10) / 10;
      if (d <= radiusKm) missions.push({ ...m, distance_km: d });
      else outside.push({ ...m, distance_km: d });
    }
    missions.sort((a, b) => (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9) || String(a.start_date).localeCompare(String(b.start_date)));
    outside.sort((a, b) => a.distance_km - b.distance_km || String(a.start_date).localeCompare(String(b.start_date)));
  } else {
    missions = rows.map((m) => ({ ...m, distance_km: null }));
  }
  return {
    filter: origin ? 'distance' : 'none',
    reason: origin ? undefined : 'Adresse du professionnel non géocodée : renseignez votre adresse (profil) ou partagez votre position.',
    origin, radiusKm, radiusSource, totalUpcoming: rows.length, withoutCoordinates,
    missions: withCount(missions),
    outside: withCount(outside.slice(0, 50)),
    outsideTotal: outside.length,
  };
}

/** Lister missions (pro : filtré par rayon réel ; établissement : les siennes ; admin : toutes) */
router.get('/', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    let missions: any[];
    if (req.user.role === 'establishment') {
      const estId = await dbGet('SELECT id FROM establishments WHERE user_id = ?', [req.user.id]) as any;
      if (!estId) return res.json([]);
      missions = await dbAll(MISSION_SELECT + ' WHERE m.establishment_id = ? ORDER BY m.start_date DESC', [estId?.id]);
    } else if (req.user.isAdmin) {
      missions = await dbAll(MISSION_SELECT + ' ORDER BY m.start_date DESC');
    } else {
      const result = await missionsForPro(req);
      res.setHeader('X-Urgad-Distance-Filter', result.filter);
      res.setHeader('X-Urgad-Radius-Km', String(result.radiusKm));
      return res.json(result.missions);
    }
    missions = missions.map((m) => ({ ...m, applicationCount: m.application_count || 0 }));
    return res.json(missions);
  } catch (err) { next(err); }
});

/** Missions autour de moi, avec l'origine et le rayon utilisés (pour la carte du pro). */
router.get('/nearby', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (req.user.role !== 'professional') return res.status(403).json({ message: 'Compte professionnel requis.' });
    return res.json(await missionsForPro(req));
  } catch (err) { next(err); }
});

/** Mission par ID */
router.get('/:id', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const mission = await dbGet(MISSION_SELECT + ' WHERE m.id = ?', [req.params.id]) as any;
    if (!mission) return res.status(404).json({ message: 'Mission non trouvée.' });
    let distance_km: number | null = null;
    if (req.user.role === 'professional') {
      const p = await dbGet('SELECT latitude, longitude FROM professionals WHERE user_id = ?', [req.user.id]) as any;
      if (num(p?.latitude) != null && num(mission.latitude) != null) distance_km = Math.round(haversineKm(Number(p.latitude), Number(p.longitude), Number(mission.latitude), Number(mission.longitude)) * 10) / 10;
    }
    return res.json({ ...mission, distance_km, applicationCount: mission.application_count || 0 });
  } catch (err) { next(err); }
});

/** Publier */
router.post('/:id/publish', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const mission = await dbGet('SELECT * FROM missions WHERE id = ?', [req.params.id]) as any;
    if (!mission) return res.status(404).json({ message: 'Mission non trouvée.' });
    if (mission.status !== 'pending') return res.status(409).json({ message: 'Déjà publiée ou disponible.' });
    await dbRun("UPDATE missions SET status = 'published', visible = 1, request_status = CASE WHEN request_status IN ('validee','realisee','annulee') THEN request_status ELSE 'en_recherche' END, published_at = datetime('now') WHERE id = ?", [req.params.id]);
    let notified = 0;
    try {
      const c = await dbGet('SELECT latitude FROM mission_coordinates WHERE mission_id = ?', [req.params.id]) as any;
      if (!c || c.latitude == null) await geocodeMission(Number(req.params.id));
      notified = await notifyProsForMission(Number(req.params.id));
    } catch (e) { console.error('[NOTIFY] publish:', e); }
    return res.json({ message: 'Mission publiée.', notifiedProfessionals: notified });
  } catch (err) { next(err); }
});

/** Fermer / terminer */
router.post('/:id/close', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (!req.user.isAdmin && req.user.role !== 'establishment') return res.status(403).json({ message: 'Non autorisé.' });
    await dbRun('UPDATE missions SET status = \'completed\' WHERE id = ?', [req.params.id]);
    return res.json({ message: 'Mission terminée.' });
  } catch (err) { next(err); }
});

/** Annuler */
router.post('/:id/cancel', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    if (!req.user.isAdmin && req.user.role !== 'establishment') return res.status(403).json({ message: 'Non autorisé.' });
    await dbRun('UPDATE missions SET status = \'cancelled\' WHERE id = ?', [req.params.id]);
    return res.json({ message: 'Mission annulée.' });
  } catch (err) { next(err); }
});

export default router;
