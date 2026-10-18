/**
 * Demandes de personnel : l'établissement indique le besoin (téléphone, e-mail, formulaire rapide),
 * l'équipe URGAD trouve et propose UN profil vérifié, l'établissement valide ou demande un autre profil.
 * Statuts : nouvelle → en_recherche → profil_propose → validee | refusee (→ re-proposer) → realisee | annulee.
 */
import { v4 as uuidv4 } from 'uuid';
import { dbAll, dbGet, dbRun } from './db.js';
import { geocodeMission, haversineKm, num } from './geo.js';
import { defaultRadiusKm, notifyProsForMission } from './matching.js';
import { notifyAdmins, notifySafe } from './notify.js';
import { isProposable, statusOf } from './verification.js';

export const REQUEST_STATUSES = ['nouvelle', 'en_recherche', 'profil_propose', 'validee', 'refusee', 'realisee', 'annulee'] as const;
export type RequestStatus = typeof REQUEST_STATUSES[number];
export const REQUEST_SOURCES = ['telephone', 'email', 'formulaire', 'plateforme'] as const;
export const POSTES: Record<string, string> = { infirmier: 'Infirmier(ère)', 'aide-soignant': 'Aide-soignant(e)', aes: 'AES', autre: 'Autre' };
export const STATUS_LABELS: Record<string, string> = {
  nouvelle: 'Nouvelle', en_recherche: 'En recherche', profil_propose: 'Profil proposé', validee: 'Validée', refusee: 'Refusée — à re-proposer', realisee: 'Réalisée', annulee: 'Annulée',
};

export function normPoste(v: any): string {
  const s = String(v || '').toLowerCase();
  if (/infirm|\bide\b/.test(s)) return 'infirmier';
  if (/aide[- ]?soign|\bas\b|\bast\b/.test(s)) return 'aide-soignant';
  if (/\baes\b|accompagnant/.test(s)) return 'aes';
  return s ? 'autre' : '';
}
export function effectiveStatus(m: any): RequestStatus {
  if (m?.request_status && (REQUEST_STATUSES as readonly string[]).includes(m.request_status)) return m.request_status;
  if (m?.status === 'cancelled') return 'annulee';
  if (m?.status === 'completed') return 'realisee';
  return 'nouvelle';
}

export async function logEvent(missionId: number, actor: { id?: number; role?: string } | null, event: string, from: string | null, to: string | null, applicationId: number | null = null, details = '') {
  try {
    await dbRun('INSERT INTO request_events (mission_id, actor_user_id, actor_role, event, from_status, to_status, application_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [missionId, actor?.id ?? null, actor?.role ?? null, event, from, to, applicationId, String(details || '').slice(0, 500)]);
  } catch (e) { console.error('[REQUEST] event:', e); }
}

export async function setStatus(missionId: number, to: RequestStatus, actor: any, event: string, details = '', applicationId: number | null = null) {
  const m = await dbGet<any>('SELECT * FROM missions WHERE id = ?', [missionId]);
  const from = effectiveStatus(m);
  await dbRun('UPDATE missions SET request_status = ? WHERE id = ?', [to, missionId]);
  if (to === 'annulee') await dbRun("UPDATE missions SET status = 'cancelled', visible = 0 WHERE id = ?", [missionId]);
  if (to === 'realisee') await dbRun("UPDATE missions SET status = 'completed', visible = 0 WHERE id = ?", [missionId]);
  if (to === 'validee') await dbRun("UPDATE missions SET visible = 0, validated_at = datetime('now') WHERE id = ?", [missionId]);
  if (to === 'en_recherche' || to === 'refusee' || to === 'nouvelle') {
    await dbRun("UPDATE missions SET visible = 1, status = CASE WHEN status IN ('cancelled','completed') THEN status ELSE 'published' END WHERE id = ?", [missionId]);
  }
  await logEvent(missionId, actor, event, from, to, applicationId, details);
  return { from, to };
}

async function establishmentUserId(estId: number): Promise<number | null> {
  const e = await dbGet<any>('SELECT user_id FROM establishments WHERE id = ?', [estId]);
  return e ? Number(e.user_id) : null;
}

/** Création d'une demande (admin pour le compte d'un établissement, ou formulaire rapide de l'établissement). */
export async function createRequest(input: {
  establishmentId: number; poste: string; date: string; startHour: string; endHour: string; notes?: string; source: string;
  urgent?: boolean; location?: string; createdBy: { id: number; role: string }; endDate?: string | null; conditions?: string;
}) {
  const est = await dbGet<any>('SELECT * FROM establishments WHERE id = ?', [input.establishmentId]);
  if (!est) throw Object.assign(new Error('Établissement introuvable.'), { status: 404 });
  const poste = normPoste(input.poste) || 'autre';
  const title = (POSTES[poste] || input.poste || 'Renfort') + (input.urgent ? ' — urgent' : '');
  const location = input.location || [est.address, [est.postal_code, est.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const ins = await dbRun(
    'INSERT INTO missions (uuid, establishment_id, establishment_name, establishment_email, type, title, description, conditions, location, start_date, end_date, start_hour, end_hour, urgent, visible, request_status, request_source, request_notes, poste, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [uuidv4(), est.id, est.name, est.email || '', 'Vacation', title, input.notes || '', input.conditions || '', location, input.date, input.endDate || null, input.startHour, input.endHour, input.urgent ? 1 : 0, 1, 'nouvelle', input.source, input.notes || '', poste, input.createdBy.id]);
  let id = ins.lastInsertRowid as number | null;
  if (id == null) { const r = await dbGet<any>('SELECT id FROM missions WHERE establishment_id = ? ORDER BY id DESC LIMIT 1', [est.id]); id = r?.id ?? null; }
  if (id == null) throw new Error('Demande non créée.');
  await logEvent(id, input.createdBy, 'created', null, 'nouvelle', null, `source=${input.source}`);
  const out: any = { id, requestStatus: 'nouvelle', establishmentId: est.id };
  try { const g = await geocodeMission(id); out.latitude = g?.latitude ?? null; out.longitude = g?.longitude ?? null; out.coordinatesSource = g?.source ?? null; } catch (e) { console.error('[GEO] request:', e); }
  try { out.notifiedProfessionals = await notifyProsForMission(id); } catch (e) { console.error('[NOTIFY] request:', e); out.notifiedProfessionals = 0; }
  const when = `${String(input.date).slice(0, 10)} ${input.startHour}–${input.endHour}`;
  if (input.createdBy.role === 'establishment') {
    await notifyAdmins('Nouvelle demande à traiter', `${est.name} : ${POSTES[poste] || poste} le ${when} (formulaire)`, { missionId: id, screen: 'requests' }, 'request_new');
  } else {
    await notifySafe(Number(est.user_id), 'Demande enregistrée', `Nous recherchons un(e) ${POSTES[poste] || poste} pour le ${when}. Nous vous proposerons un profil vérifié.`, { missionId: id, screen: 'requests' }, 'request_new');
  }
  return out;
}

/** Carte du profil proposé, telle que l'établissement la voit (pas de nom complet ni contact avant validation). */
export async function profileCard(applicationId: number | null, missionId: number, revealContact = false) {
  if (!applicationId) return null;
  const a = await dbGet<any>('SELECT a.*, p.user_id, p.profession, p.experience_years, p.experience, p.latitude, p.longitude, p.identity_status, p.diploma_status, u.first_name, u.last_name, u.phone, u.email FROM applications a JOIN professionals p ON p.id = a.professional_id JOIN users u ON u.id = p.user_id WHERE a.id = ?', [applicationId]);
  if (!a) return null;
  const c = await dbGet<any>('SELECT latitude, longitude FROM mission_coordinates WHERE mission_id = ?', [missionId]);
  const d = (num(a.latitude) != null && num(c?.latitude) != null) ? Math.round(haversineKm(Number(a.latitude), Number(a.longitude), Number(c.latitude), Number(c.longitude)) * 10) / 10 : null;
  let years = num(a.experience_years);
  if (years == null && a.experience) { const m = String(a.experience).match(/(\d{1,2})/); if (m) years = Number(m[1]); }
  const card: any = {
    applicationId: a.id,
    displayName: `${a.first_name || ''} ${(a.last_name || '').trim().charAt(0)}${a.last_name ? '.' : ''}`.trim() || 'Professionnel',
    qualification: POSTES[normPoste(a.profession)] || a.profession || a.professional_role || 'Non renseignée',
    experienceYears: years,
    distanceKm: d,
    identityVerified: statusOf(a.identity_status) === 'verifie',
    diplomaVerified: statusOf(a.diploma_status) === 'verifie',
    status: a.status,
    proposedAt: a.proposed_at || null,
  };
  if (revealContact) { card.fullName = `${a.first_name || ''} ${a.last_name || ''}`.trim(); card.phone = a.phone || null; card.email = a.email || null; }
  return card;
}

/** Candidats d'une demande : candidatures + suggestions (pros vérifiés, distance réelle, qualification). */
export async function candidatesFor(missionId: number) {
  const m = await dbGet<any>('SELECT * FROM missions WHERE id = ?', [missionId]);
  const c = await dbGet<any>('SELECT latitude, longitude FROM mission_coordinates WHERE mission_id = ?', [missionId]);
  const lat = num(c?.latitude), lng = num(c?.longitude);
  const poste = normPoste(m?.poste || m?.title);
  const fallback = await defaultRadiusKm();
  const pros = await dbAll<any>("SELECT p.id AS professional_id, p.user_id, p.profession, p.experience_years, p.latitude, p.longitude, p.mobility_radius, p.city, p.identity_status, p.diploma_status, u.first_name, u.last_name, u.email, u.phone FROM professionals p JOIN users u ON u.id = p.user_id WHERE u.role = 'professional' AND u.deleted_at IS NULL");
  const apps = await dbAll<any>('SELECT * FROM applications WHERE mission_id = ? ORDER BY created_at ASC', [missionId]);
  const byPro = new Map<number, any>(pros.map((p) => [Number(p.professional_id), p]));
  const info = (p: any) => {
    const dist = (lat != null && lng != null && num(p.latitude) != null) ? Math.round(haversineKm(lat, lng, Number(p.latitude), Number(p.longitude)) * 10) / 10 : null;
    const qual = normPoste(p.profession);
    return {
      userId: Number(p.user_id), professionalId: Number(p.professional_id),
      name: `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email, email: p.email, phone: p.phone, city: p.city || '',
      profession: p.profession || null, qualificationMatch: !poste || poste === 'autre' ? null : (qual ? qual === poste : null),
      experienceYears: num(p.experience_years), distanceKm: dist, mobilityRadius: num(p.mobility_radius) || fallback,
      identityStatus: statusOf(p.identity_status), diplomaStatus: statusOf(p.diploma_status),
      proposable: statusOf(p.identity_status) === 'verifie' && statusOf(p.diploma_status) === 'verifie',
    };
  };
  const applications = apps.map((a) => {
    const p = byPro.get(Number(a.professional_id));
    return { applicationId: a.id, status: a.status, origin: a.origin || 'candidature', createdAt: a.created_at, proposedAt: a.proposed_at, reason: a.reason || null,
      isProposed: Number(m?.proposed_application_id) === Number(a.id), isBackup: Number(m?.backup_application_id) === Number(a.id),
      ...(p ? info(p) : { name: a.professional_name, proposable: false, identityStatus: 'en_attente', diplomaStatus: 'en_attente' }) };
  });
  const applied = new Set(apps.map((a) => Number(a.professional_id)));
  const suggestions = pros.filter((p) => !applied.has(Number(p.professional_id))).map(info)
    .filter((p) => p.distanceKm == null ? lat == null : p.distanceKm <= Math.max(p.mobilityRadius, fallback))
    .filter((p) => p.qualificationMatch !== false)
    .sort((a, b) => Number(b.proposable) - Number(a.proposable) || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9))
    .slice(0, 30);
  return { poste, distanceFilter: lat != null, applications, suggestions };
}

/** Proposer un profil (un seul à la fois ; secours optionnel). Refusé si identité ou diplôme non vérifiés. */
export async function proposeProfile(missionId: number, target: { applicationId?: number; userId?: number }, actor: any, opts: { backupApplicationId?: number; backupUserId?: number; replace?: boolean; note?: string } = {}) {
  const m = await dbGet<any>('SELECT * FROM missions WHERE id = ?', [missionId]);
  if (!m) throw Object.assign(new Error('Demande introuvable.'), { status: 404 });
  const st = effectiveStatus(m);
  if (['validee', 'realisee', 'annulee'].includes(st)) throw Object.assign(new Error(`Demande ${STATUS_LABELS[st].toLowerCase()} : impossible de proposer.`), { status: 409 });
  if (st === 'profil_propose' && m.proposed_application_id && !opts.replace) throw Object.assign(new Error('Un profil est déjà proposé et attend la réponse de l\'établissement (replace=true pour le remplacer).'), { status: 409, code: 'already_proposed' });
  const appId = await ensureApplication(missionId, target);
  const a = await dbGet<any>('SELECT a.*, p.user_id FROM applications a JOIN professionals p ON p.id = a.professional_id WHERE a.id = ?', [appId]);
  const check = await isProposable(Number(a.user_id));
  if (!check.ok) throw Object.assign(new Error(`Profil non proposable : identité ${check.identity.replace('_', ' ')}, diplôme ${check.diploma.replace('_', ' ')}. Les deux doivent être vérifiés.`), { status: 409, code: 'pro_not_verified', identity: check.identity, diploma: check.diploma });
  if (['rejected', 'withdrawn'].includes(a.status) && !opts.replace) throw Object.assign(new Error('Cette candidature a déjà été écartée.'), { status: 409 });
  let backupId: number | null = null;
  if (opts.backupApplicationId || opts.backupUserId) {
    backupId = await ensureApplication(missionId, { applicationId: opts.backupApplicationId, userId: opts.backupUserId });
    const b = await dbGet<any>('SELECT p.user_id FROM applications a JOIN professionals p ON p.id = a.professional_id WHERE a.id = ?', [backupId]);
    const bc = await isProposable(Number(b?.user_id));
    if (!bc.ok) throw Object.assign(new Error('Profil de secours non vérifié (identité et diplôme requis).'), { status: 409, code: 'backup_not_verified' });
    if (backupId === appId) backupId = null;
  }
  if (m.proposed_application_id && Number(m.proposed_application_id) !== appId) {
    await dbRun("UPDATE applications SET status = 'pending', proposed_at = NULL WHERE id = ? AND status = 'proposed'", [m.proposed_application_id]);
  }
  await dbRun("UPDATE applications SET status = 'proposed', proposed_at = datetime('now') WHERE id = ?", [appId]);
  await dbRun("UPDATE missions SET proposed_application_id = ?, backup_application_id = ?, proposed_at = datetime('now'), refusal_reason = NULL WHERE id = ?", [appId, backupId, missionId]);
  await setStatus(missionId, 'profil_propose', actor, 'proposed', opts.note || '', appId);
  const card = await profileCard(appId, missionId);
  const when = `${String(m.start_date).slice(0, 10)}${m.start_hour ? ' ' + m.start_hour + '–' + (m.end_hour || '') : ''}`;
  await notifySafe(await establishmentUserId(Number(m.establishment_id)), 'Profil proposé — à valider',
    `${card?.displayName} (${card?.qualification}${card?.distanceKm != null ? ', ' + String(card.distanceKm).replace('.', ',') + ' km' : ''}) pour « ${m.title} » le ${when}. Identité et diplôme vérifiés.`,
    { missionId, applicationId: appId, screen: 'requests' }, 'request_profile_proposed');
  await notifySafe(Number(a.user_id), 'Votre profil a été proposé',
    `Nous avons proposé votre profil à ${m.establishment_name} pour « ${m.title} » le ${when}. Réponse de l'établissement à venir.`,
    { missionId, applicationId: appId, screen: 'missions' }, 'application_proposed');
  return { missionId, applicationId: appId, backupApplicationId: backupId, requestStatus: 'profil_propose', card };
}

async function ensureApplication(missionId: number, target: { applicationId?: number; userId?: number }): Promise<number> {
  if (target.applicationId) {
    const a = await dbGet<any>('SELECT id FROM applications WHERE id = ? AND mission_id = ?', [target.applicationId, missionId]);
    if (!a) throw Object.assign(new Error('Candidature introuvable pour cette demande.'), { status: 404 });
    return Number(a.id);
  }
  if (!target.userId) throw Object.assign(new Error('applicationId ou professionalUserId requis.'), { status: 422 });
  const p = await dbGet<any>("SELECT p.id, p.profession, u.first_name, u.last_name, u.email, u.phone FROM professionals p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND u.deleted_at IS NULL", [target.userId]);
  if (!p) throw Object.assign(new Error('Professionnel introuvable.'), { status: 404 });
  const existing = await dbGet<any>('SELECT id FROM applications WHERE mission_id = ? AND professional_id = ?', [missionId, p.id]);
  if (existing) return Number(existing.id);
  const uuid = uuidv4();
  await dbRun("INSERT INTO applications (uuid, mission_id, professional_id, professional_name, professional_role, professional_email, professional_phone, status, origin) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'suggestion')",
    [uuid, missionId, p.id, `${p.first_name || ''} ${p.last_name || ''}`.trim(), POSTES[normPoste(p.profession)] || p.profession || 'Professionnel', p.email, p.phone]);
  await dbRun('UPDATE missions SET application_count = application_count + 1 WHERE id = ?', [missionId]);
  const row = await dbGet<any>('SELECT id FROM applications WHERE uuid = ?', [uuid]);
  return Number(row.id);
}

/** L'établissement valide le profil proposé : mission confirmée au pro, autres candidats « non retenu ». */
export async function validateProposal(missionId: number, actor: any) {
  const m = await dbGet<any>('SELECT * FROM missions WHERE id = ?', [missionId]);
  if (!m || effectiveStatus(m) !== 'profil_propose' || !m.proposed_application_id) throw Object.assign(new Error('Aucun profil proposé à valider.'), { status: 409 });
  const appId = Number(m.proposed_application_id);
  const a = await dbGet<any>('SELECT a.*, p.user_id FROM applications a JOIN professionals p ON p.id = a.professional_id WHERE a.id = ?', [appId]);
  await dbRun("UPDATE applications SET status = 'accepted', decided_at = datetime('now') WHERE id = ?", [appId]);
  await setStatus(missionId, 'validee', actor, 'validated', '', appId);
  const others = await dbAll<any>("SELECT a.id, p.user_id FROM applications a JOIN professionals p ON p.id = a.professional_id WHERE a.mission_id = ? AND a.id != ? AND a.status IN ('pending', 'proposed')", [missionId, appId]);
  for (const o of others) {
    await dbRun("UPDATE applications SET status = 'rejected', reason = 'Mission pourvue', decided_at = datetime('now') WHERE id = ?", [o.id]);
    await notifySafe(Number(o.user_id), 'Candidature non retenue', `« ${m.title} » chez ${m.establishment_name} a été pourvue. Merci pour votre disponibilité.`, { missionId, applicationId: o.id, screen: 'missions' }, 'application_rejected');
  }
  const when = `${String(m.start_date).slice(0, 10)}${m.start_hour ? ' de ' + m.start_hour + ' à ' + (m.end_hour || '') : ''}`;
  await notifySafe(Number(a.user_id), 'Mission confirmée ✅', `${m.establishment_name} a validé votre profil : « ${m.title} » le ${when}, ${m.location || ''}.`, { missionId, applicationId: appId, screen: 'missions' }, 'application_accepted');
  await notifyAdmins('Profil validé par l\'établissement', `${m.establishment_name} a validé ${a.professional_name} pour « ${m.title} » (${String(m.start_date).slice(0, 10)}).`, { missionId, applicationId: appId, screen: 'requests' }, 'request_validated');
  return { missionId, applicationId: appId, requestStatus: 'validee', card: await profileCard(appId, missionId, true) };
}

/** L'établissement demande un autre profil : retour à l'équipe avec le motif. */
export async function refuseProposal(missionId: number, reason: string, actor: any) {
  const m = await dbGet<any>('SELECT * FROM missions WHERE id = ?', [missionId]);
  if (!m || effectiveStatus(m) !== 'profil_propose' || !m.proposed_application_id) throw Object.assign(new Error('Aucun profil proposé.'), { status: 409 });
  const appId = Number(m.proposed_application_id);
  const a = await dbGet<any>('SELECT a.*, p.user_id FROM applications a JOIN professionals p ON p.id = a.professional_id WHERE a.id = ?', [appId]);
  const why = String(reason || '').trim().slice(0, 500);
  await dbRun("UPDATE applications SET status = 'rejected', reason = ?, decided_at = datetime('now') WHERE id = ?", [why || 'Autre profil demandé', appId]);
  await dbRun('UPDATE missions SET proposed_application_id = NULL, refusal_reason = ? WHERE id = ?', [why || null, missionId]);
  await setStatus(missionId, 'refusee', actor, 'refused', why, appId);
  await notifyAdmins('Autre profil demandé', `${m.establishment_name} demande un autre profil pour « ${m.title} » (${String(m.start_date).slice(0, 10)})${why ? ' : ' + why : '.'}${m.backup_application_id ? ' Un profil de secours est disponible.' : ''}`, { missionId, applicationId: appId, screen: 'requests' }, 'request_refused');
  await notifySafe(Number(a.user_id), 'Candidature non retenue', `${m.establishment_name} n'a pas retenu votre profil pour « ${m.title} ». D'autres missions vous attendent.`, { missionId, applicationId: appId, screen: 'missions' }, 'application_rejected');
  return { missionId, requestStatus: 'refusee', backupApplicationId: m.backup_application_id || null };
}

/** Vue d'une demande pour l'établissement. */
export async function requestForEstablishment(m: any) {
  const st = effectiveStatus(m);
  const proposedId = m.proposed_application_id ? Number(m.proposed_application_id) : null;
  let confirmed: any = null;
  if (st === 'validee' || st === 'realisee') {
    const acc = await dbGet<any>("SELECT id FROM applications WHERE mission_id = ? AND status = 'accepted' ORDER BY decided_at DESC LIMIT 1", [m.id]);
    confirmed = acc ? await profileCard(Number(acc.id), m.id, true) : null;
  }
  return {
    id: m.id, title: m.title, poste: m.poste || normPoste(m.title), posteLabel: POSTES[m.poste || normPoste(m.title)] || m.title,
    date: m.start_date, startHour: m.start_hour, endHour: m.end_hour, notes: m.request_notes || m.description || '', urgent: Number(m.urgent) === 1,
    source: m.request_source || 'plateforme', requestStatus: st, requestStatusLabel: STATUS_LABELS[st], refusalReason: m.refusal_reason || null,
    latitude: m.latitude ?? null, longitude: m.longitude ?? null, location: m.location || '',
    proposed: st === 'profil_propose' && proposedId ? await profileCard(proposedId, m.id) : null,
    confirmed,
    createdAt: m.created_at,
  };
}
