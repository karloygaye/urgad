/**
 * Vérification séparée de l'identité (CNI / passeport / titre de séjour, recto-verso) et du diplôme.
 * Statuts : en_attente | verifie | refuse (null = en_attente, rien déposé ou pas encore revu).
 * Un professionnel n'est proposable à un établissement que si les deux sont « verifie ».
 * Les pièces d'identité ne sont accessibles qu'aux administrateurs, jamais aux établissements.
 */
import fs from 'fs';
import path from 'path';
import { dbAll, dbGet, dbRun } from './db.js';
import { UPLOAD_DIR } from './uploads.js';

export type VerifKind = 'identity' | 'diploma';
export const VERIF_STATUSES = ['en_attente', 'verifie', 'refuse'] as const;
export const ID_KINDS = ['cni', 'passeport', 'titre_sejour'] as const;
export const DOC_CATEGORIES = ['identity', 'diploma', 'carte_vitale', 'vaccins', 'rib', 'other'] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];

export function statusOf(v: any): 'en_attente' | 'verifie' | 'refuse' {
  return v === 'verifie' || v === 'refuse' ? v : 'en_attente';
}

/** Catégorie d'un document à partir de ce que le client envoie. */
export function categoryOf(body: any): DocCategory {
  const c = String(body?.category || '').toLowerCase();
  if (c === 'identity' || c === 'identite') return 'identity';
  if (c === 'diploma' || c === 'diplome') return 'diploma';
  if (c === 'carte_vitale' || c === 'vitale') return 'carte_vitale';
  if (c === 'vaccins' || c === 'vaccin') return 'vaccins';
  if (c === 'rib') return 'rib';
  const t = (String(body?.type || body?.docType || '') + ' ' + String(body?.name || '')).toLowerCase();
  if (/identit|cni|carte nationale|passeport|passport|titre de s[eé]jour|titre_sejour/.test(t)) return 'identity';
  if (/dipl[oô]m|rpps|adeli|\bdeas\b|\bdei\b|attestation de formation/.test(t)) return 'diploma';
  if (/vitale/.test(t)) return 'carte_vitale';
  if (/vaccin/.test(t)) return 'vaccins';
  if (/\brib\b|\biban\b|relev[eé] d.identit/.test(t)) return 'rib';
  return 'other';
}

export function truthyFile(v: any): boolean {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

export function parseDocCategories(raw: unknown): DocCategory[] {
  const parts = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const out: DocCategory[] = [];
  for (const p of parts) {
    const c = String(p || '').trim().toLowerCase() as DocCategory;
    if ((DOC_CATEGORIES as readonly string[]).includes(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

export function categoryLabel(cat: string): string {
  return ({ identity: "pièce d'identité", diploma: 'diplôme', carte_vitale: 'carte Vitale', vaccins: 'vaccins', rib: 'RIB', other: 'autre document' } as Record<string, string>)[cat] || cat;
}

function documentRequestOf(p: any) {
  const categories = parseDocCategories(p?.document_request_categories);
  const message = String(p?.document_request_message || '').trim();
  if (!categories.length && !message) return null;
  return { categories, message, at: p.document_request_at || null, by: p.document_request_by || null };
}

export async function verificationOf(userId: number) {
  const p = await dbGet<any>('SELECT identity_status, identity_reason, identity_reviewed_by, identity_reviewed_at, diploma_status, diploma_reason, diploma_reviewed_by, diploma_reviewed_at, document_request_categories, document_request_message, document_request_at, document_request_by FROM professionals WHERE user_id = ?', [userId]);
  const docs = await dbAll<any>("SELECT id, name, doc_type, category, id_kind, side, status, review_reason, reviewed_by, reviewed_at, created_at, file_purged_at, stored_name, mime_type, size_bytes FROM professional_documents WHERE user_id = ? ORDER BY id DESC", [userId]);
  const of = (cat: string) => docs.filter((d) => d.category === cat);
  const identityDocs = of('identity');
  const diplomaDocs = of('diploma');
  return {
    identity: {
      status: statusOf(p?.identity_status), reason: p?.identity_reason || null, reviewedBy: p?.identity_reviewed_by || null, reviewedAt: p?.identity_reviewed_at || null,
      documents: identityDocs.length, sides: Array.from(new Set(identityDocs.map((d) => d.side).filter(Boolean))),
    },
    diploma: {
      status: statusOf(p?.diploma_status), reason: p?.diploma_reason || null, reviewedBy: p?.diploma_reviewed_by || null, reviewedAt: p?.diploma_reviewed_at || null,
      documents: diplomaDocs.length,
    },
    carteVitale: { documents: of('carte_vitale').length },
    vaccins: { documents: of('vaccins').length },
    rib: { documents: of('rib').length },
    proposable: statusOf(p?.identity_status) === 'verifie' && statusOf(p?.diploma_status) === 'verifie',
    documentRequest: documentRequestOf(p),
    documents: docs.map((d) => ({
      id: d.id, name: d.name, type: d.doc_type || '', category: d.category || 'other', idKind: d.id_kind || null, side: d.side || null,
      status: d.status || 'pending', reason: d.review_reason || null, reviewedBy: d.reviewed_by || null, reviewedAt: d.reviewed_at || null,
      createdAt: d.created_at || null, hasFile: !!d.stored_name || truthyFile(d.has_file), filePurgedAt: d.file_purged_at || null,
      mimeType: d.mime_type || null, sizeBytes: d.size_bytes || 0,
    })),
  };
}

export async function isProposable(userId: number | null | undefined): Promise<{ ok: boolean; identity: string; diploma: string }> {
  if (!userId) return { ok: false, identity: 'en_attente', diploma: 'en_attente' };
  const p = await dbGet<any>("SELECT p.identity_status, p.diploma_status, u.deleted_at, u.verification_status FROM professionals p JOIN users u ON u.id = p.user_id WHERE p.user_id = ?", [userId]);
  const identity = statusOf(p?.identity_status), diploma = statusOf(p?.diploma_status);
  const blocked = p?.verification_status === 'suspended';
  return { ok: !!p && !p.deleted_at && !blocked && identity === 'verifie' && diploma === 'verifie', identity, diploma };
}

export async function syncAccountAfterReview(userId: number) {
  const user = await dbGet<any>('SELECT verification_status FROM users WHERE id = ?', [userId]);
  if (!user || user.verification_status === 'suspended' || user.verification_status === 'deleted') return await isProposable(userId);
  const v = await isProposable(userId);
  if (v.ok) await dbRun("UPDATE users SET verified = 1, verification_status = 'approved' WHERE id = ?", [userId]);
  else await dbRun("UPDATE users SET verified = 0, verification_status = 'pending' WHERE id = ?", [userId]);
  return v;
}

/** Décision admin sur l'identité ou le diplôme. Un refus peut être annulé (en_attente) ou passé en vérifié. */
export async function applyReview(userId: number, kind: VerifKind, decision: 'verifie' | 'refuse' | 'en_attente', reason: string, reviewer: string) {
  const prefix = kind === 'identity' ? 'identity' : 'diploma';
  const docStatus = decision === 'verifie' ? 'approved' : decision === 'refuse' ? 'rejected' : 'pending';
  await dbRun(`UPDATE professionals SET ${prefix}_status = ?, ${prefix}_reason = ?, ${prefix}_reviewed_by = ?, ${prefix}_reviewed_at = datetime('now') WHERE user_id = ?`,
    [decision, decision === 'refuse' ? reason : null, reviewer, userId]);
  await dbRun("UPDATE professional_documents SET status = ?, review_reason = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE user_id = ? AND category = ?",
    [docStatus, decision === 'refuse' ? reason : null, reviewer, userId, kind]);
  return syncAccountAfterReview(userId);
}

export async function requestMoreDocuments(userId: number, categories: DocCategory[], message: string, reviewer: string) {
  const cats = categories.length ? categories : (['identity', 'diploma', 'carte_vitale', 'vaccins', 'rib'] as DocCategory[]);
  await dbRun("UPDATE professionals SET document_request_categories = ?, document_request_message = ?, document_request_at = datetime('now'), document_request_by = ? WHERE user_id = ?",
    [cats.join(','), message, reviewer, userId]);
  if (cats.includes('identity')) {
    await dbRun("UPDATE professionals SET identity_status = 'en_attente' WHERE user_id = ? AND (identity_status IS NULL OR identity_status = 'refuse')", [userId]);
  }
  if (cats.includes('diploma')) {
    await dbRun("UPDATE professionals SET diploma_status = 'en_attente' WHERE user_id = ? AND (diploma_status IS NULL OR diploma_status = 'refuse')", [userId]);
  }
  await syncAccountAfterReview(userId);
  return verificationOf(userId);
}

export async function consumeDocumentRequest(userId: number, category: string) {
  const p = await dbGet<any>('SELECT document_request_categories FROM professionals WHERE user_id = ?', [userId]);
  const cats = parseDocCategories(p?.document_request_categories);
  if (!cats.length) return;
  const left = cats.filter((c) => c !== category);
  if (left.length === cats.length) return;
  if (!left.length) {
    await dbRun('UPDATE professionals SET document_request_categories = NULL, document_request_message = NULL, document_request_at = NULL, document_request_by = NULL WHERE user_id = ?', [userId]);
  } else {
    await dbRun('UPDATE professionals SET document_request_categories = ? WHERE user_id = ?', [left.join(','), userId]);
  }
}

/** Nouveau dépôt : la vérification correspondante repasse « en_attente » (sauf si déjà vérifiée). */
export async function onDocumentUploaded(userId: number, category: string) {
  if (category === 'identity' || category === 'diploma') {
    const col = category === 'identity' ? 'identity_status' : 'diploma_status';
    await dbRun(`UPDATE professionals SET ${col} = 'en_attente' WHERE user_id = ? AND (${col} IS NULL OR ${col} = 'refuse')`, [userId]);
    await syncAccountAfterReview(userId);
  }
  await consumeDocumentRequest(userId, category);
}

/** Durée de conservation du fichier d'identité après vérification (paramètre identity_file_retention_days, défaut 30 j, à valider). */
export async function identityRetentionDays(): Promise<number> {
  const row = await dbGet<any>("SELECT value FROM platform_settings WHERE setting_key = 'identity_file_retention_days'");
  const n = parseInt(String(row?.value ?? '30'), 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

/**
 * Minimisation : une fois l'identité vérifiée depuis plus de N jours, le fichier est effacé du disque.
 * La ligne reste (type de pièce, statut, qui/quand) comme preuve de la vérification.
 */
export async function purgeVerifiedIdentityFiles(): Promise<number> {
  const days = await identityRetentionDays();
  const rows = await dbAll<any>("SELECT d.id, d.stored_name, p.identity_reviewed_at FROM professional_documents d JOIN professionals p ON p.user_id = d.user_id WHERE d.category = 'identity' AND d.stored_name IS NOT NULL AND p.identity_status = 'verifie' AND p.identity_reviewed_at IS NOT NULL");
  const limit = Date.now() - days * 86400000;
  let purged = 0;
  for (const r of rows) {
    const t = Date.parse(String(r.identity_reviewed_at).replace(' ', 'T') + 'Z');
    if (!Number.isFinite(t) || t > limit) continue;
    const file = path.join(UPLOAD_DIR, path.basename(String(r.stored_name)));
    if (file.startsWith(UPLOAD_DIR)) { try { fs.unlinkSync(file); } catch { /* déjà absent */ } }
    await dbRun("UPDATE professional_documents SET stored_name = NULL, file_bytes = NULL, file_purged_at = datetime('now') WHERE id = ?", [r.id]);
    purged++;
  }
  return purged;
}
