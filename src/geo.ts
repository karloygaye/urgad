/**
 * Géocodage des adresses françaises via la Base Adresse Nationale (BAN).
 * https://api-adresse.data.gouv.fr/search/?q=...&limit=1  (repli : data.geopf.fr/geocodage)
 * Les résultats sont mis en cache dans geocode_cache. Aucune coordonnée n'est inventée :
 * - adresse trouvée avec un bon score  -> précision "address"
 * - sinon, la commune stockée (code postal + ville) -> précision "municipality"
 * - sinon null.
 */
import { dbGet, dbRun, dbAll } from './db.js';

const BAN_URLS = [
  'https://api-adresse.data.gouv.fr/search/',
  'https://data.geopf.fr/geocodage/search',
];
const MIN_ADDRESS_SCORE = 0.7;

export interface GeoResult {
  latitude: number;
  longitude: number;
  label: string;
  score: number;
  type: string;
  precision: 'address' | 'municipality';
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function num(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clean(s: any): string {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

async function fetchBan(params: Record<string, string>): Promise<any | null> {
  const qs = new URLSearchParams({ limit: '1', ...params }).toString();
  for (const base of BAN_URLS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(base + '?' + qs, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data: any = await res.json();
      return data?.features?.[0] || { none: true };
    } catch {
      // réseau indisponible : essayer le service suivant
    }
  }
  return null; // aucun service joignable -> ne pas mettre en cache
}

async function cached(key: string, params: Record<string, string>, accept: (f: any) => boolean, precision: GeoResult['precision']): Promise<GeoResult | null | undefined> {
  const hit = await dbGet<any>('SELECT * FROM geocode_cache WHERE query = ?', [key]);
  if (hit) {
    if (hit.latitude == null || hit.longitude == null) return null;
    return { latitude: Number(hit.latitude), longitude: Number(hit.longitude), label: hit.label || '', score: Number(hit.score || 0), type: hit.result_type || '', precision };
  }
  const f = await fetchBan(params);
  if (f === null) return undefined; // erreur réseau : on réessaiera plus tard
  let result: GeoResult | null = null;
  if (!f.none && f.geometry?.coordinates && accept(f)) {
    const [lng, lat] = f.geometry.coordinates;
    result = { latitude: Number(lat), longitude: Number(lng), label: String(f.properties?.label || ''), score: Number(f.properties?.score || 0), type: String(f.properties?.type || ''), precision };
  }
  try {
    await dbRun('INSERT INTO geocode_cache (query, latitude, longitude, label, score, result_type) VALUES (?, ?, ?, ?, ?, ?)',
      [key, result?.latitude ?? null, result?.longitude ?? null, result?.label ?? null, result?.score ?? null, result?.type ?? null]);
  } catch { /* doublon concurrent : ignorer */ }
  return result;
}

/** Géocode une adresse française. Retourne null si rien de fiable n'a été trouvé. */
export async function geocodeAddress(input: { address?: string; postalCode?: string; city?: string }): Promise<GeoResult | null> {
  const address = clean(input.address);
  const postalCode = clean(input.postalCode).replace(/\s/g, '');
  const city = clean(input.city);
  const cp = /^\d{5}$/.test(postalCode) ? postalCode : '';
  const full = clean([address, cp, city].filter(Boolean).join(' '));
  if (address && full.length >= 3) {
    const r = await cached('addr:' + full.toLowerCase(), { q: full, ...(cp ? { postcode: cp } : {}) }, (f) => {
      const p = f.properties || {};
      const okType = p.type === 'housenumber' || p.type === 'street' || p.type === 'locality';
      return okType && Number(p.score || 0) >= MIN_ADDRESS_SCORE;
    }, 'address');
    if (r) return r;
  }
  // Repli : la commune stockée (vraies coordonnées de la commune, précision réduite).
  const town = clean([cp, city].filter(Boolean).join(' '));
  if (city || cp) {
    const r = await cached('city:' + town.toLowerCase(), { q: city || cp, type: 'municipality', ...(cp ? { postcode: cp } : {}) }, (f) => {
      const p = f.properties || {};
      if (p.type !== 'municipality') return false;
      if (city && !cp) return Number(p.score || 0) >= 0.5;
      return true;
    }, 'municipality');
    if (r) return r;
  }
  return null;
}

/** RGPD : oublie l'adresse (rue) d'une personne dans le cache de géocodage. La commune seule n'est pas supprimée. */
export async function forgetAddressCache(input: { address?: string; postalCode?: string; city?: string }): Promise<void> {
  const address = clean(input.address);
  if (!address) return;
  const postalCode = clean(input.postalCode).replace(/\s/g, '');
  const cp = /^\d{5}$/.test(postalCode) ? postalCode : '';
  const full = clean([address, cp, clean(input.city)].filter(Boolean).join(' '));
  try { await dbRun('DELETE FROM geocode_cache WHERE query = ?', ['addr:' + full.toLowerCase()]); } catch { /* ignore */ }
}

/** "15 rue de la Paix, 75002 Paris" -> { address, postalCode, city } */
export function splitFreeAddress(text: string): { address: string; postalCode: string; city: string } {
  const s = clean(text);
  const m = s.match(/^(.*?)[,\s]+(\d{5})\s+(.+)$/);
  if (m) return { address: m[1].replace(/,$/, '').trim(), postalCode: m[2], city: m[3].trim() };
  return { address: s, postalCode: '', city: '' };
}

export async function geocodeEstablishment(estId: number): Promise<GeoResult | null> {
  const e = await dbGet<any>('SELECT id, address, city, postal_code FROM establishments WHERE id = ?', [estId]);
  if (!e) return null;
  const g = await geocodeAddress({ address: e.address, postalCode: e.postal_code, city: e.city });
  await dbRun('UPDATE establishments SET latitude = ?, longitude = ?, geocode_label = ?, geocode_precision = ? WHERE id = ?',
    [g?.latitude ?? null, g?.longitude ?? null, g?.label ?? null, g?.precision ?? null, estId]);
  return g;
}

export async function geocodeProfessionalByUser(userId: number): Promise<GeoResult | null> {
  const p = await dbGet<any>('SELECT id, address, city, postal_code FROM professionals WHERE user_id = ?', [userId]);
  if (!p) return null;
  const g = (p.address || p.city || p.postal_code)
    ? await geocodeAddress({ address: p.address, postalCode: p.postal_code, city: p.city })
    : null;
  await dbRun('UPDATE professionals SET latitude = ?, longitude = ?, geocode_label = ?, geocode_precision = ? WHERE id = ?',
    [g?.latitude ?? null, g?.longitude ?? null, g?.label ?? null, g?.precision ?? null, p.id]);
  return g;
}

/**
 * Mission : l'adresse saisie (location), complétée par le code postal / la ville de l'établissement.
 * Si elle échoue, la mission se déroule à l'établissement : on reprend ses coordonnées.
 */
export async function geocodeMission(missionId: number): Promise<{ latitude: number; longitude: number; source: string } | null> {
  const m = await dbGet<any>('SELECT m.id, m.location, m.establishment_id, e.address, e.city, e.postal_code, e.latitude AS e_lat, e.longitude AS e_lng, e.geocode_label AS e_label, e.geocode_precision AS e_prec FROM missions m LEFT JOIN establishments e ON e.id = m.establishment_id WHERE m.id = ?', [missionId]);
  if (!m) return null;
  let lat: number | null = null, lng: number | null = null, label: string | null = null, precision: string | null = null, source = '';
  const loc = clean(m.location);
  if (loc) {
    const parts = splitFreeAddress(loc);
    const g = await geocodeAddress({
      address: parts.address,
      postalCode: parts.postalCode || m.postal_code || '',
      city: parts.city || m.city || '',
    });
    if (g && g.precision === 'address') { lat = g.latitude; lng = g.longitude; label = g.label; precision = g.precision; source = 'mission_address'; }
  }
  if (lat == null) {
    let eLat = num(m.e_lat), eLng = num(m.e_lng), eLabel = m.e_label, ePrec = m.e_prec;
    if ((eLat == null || eLng == null) && m.establishment_id) {
      const g = await geocodeEstablishment(Number(m.establishment_id));
      if (g) { eLat = g.latitude; eLng = g.longitude; eLabel = g.label; ePrec = g.precision; }
    }
    if (eLat != null && eLng != null) { lat = eLat; lng = eLng; label = eLabel; precision = ePrec; source = 'establishment'; }
  }
  const existing = await dbGet<any>('SELECT id FROM mission_coordinates WHERE mission_id = ?', [missionId]);
  if (existing) {
    await dbRun('UPDATE mission_coordinates SET latitude = ?, longitude = ?, geocode_label = ?, geocode_precision = ?, source = ? WHERE mission_id = ?', [lat, lng, label, precision, source || null, missionId]);
  } else {
    await dbRun('INSERT INTO mission_coordinates (mission_id, latitude, longitude, geocode_label, geocode_precision, source) VALUES (?, ?, ?, ?, ?, ?)', [missionId, lat, lng, label, precision, source || null]);
  }
  return lat != null && lng != null ? { latitude: lat, longitude: lng, source } : null;
}

/** Complète les coordonnées manquantes à partir des adresses déjà stockées. */
export async function backfillCoordinates(): Promise<{ establishments: any[]; professionals: any[]; missions: any[] }> {
  const report = { establishments: [] as any[], professionals: [] as any[], missions: [] as any[] };
  const ests = await dbAll<any>('SELECT id, name, address, city, postal_code FROM establishments WHERE latitude IS NULL OR longitude IS NULL');
  for (const e of ests) {
    const g = await geocodeEstablishment(Number(e.id));
    report.establishments.push({ id: e.id, name: e.name, address: [e.address, e.postal_code, e.city].filter(Boolean).join(' '), result: g ? { label: g.label, precision: g.precision, score: g.score } : null });
  }
  const pros = await dbAll<any>('SELECT user_id, address, city, postal_code FROM professionals WHERE (latitude IS NULL OR longitude IS NULL)');
  for (const p of pros) {
    const hasAddr = !!(p.address || p.city || p.postal_code);
    const g = hasAddr ? await geocodeProfessionalByUser(Number(p.user_id)) : null;
    report.professionals.push({ userId: p.user_id, address: [p.address, p.postal_code, p.city].filter(Boolean).join(' ') || null, result: g ? { label: g.label, precision: g.precision } : null, reason: hasAddr ? undefined : 'aucune adresse enregistrée' });
  }
  const missions = await dbAll<any>('SELECT m.id, m.title, m.location FROM missions m LEFT JOIN mission_coordinates c ON c.mission_id = m.id WHERE c.latitude IS NULL OR c.longitude IS NULL');
  for (const m of missions) {
    const g = await geocodeMission(Number(m.id));
    report.missions.push({ id: m.id, title: m.title, location: m.location, result: g });
  }
  return report;
}
