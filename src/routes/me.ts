/**
 * Droits RGPD dans le produit :
 *  GET    /api/me/export  -> toutes les données de l'utilisateur connecté (JSON, portabilité / accès)
 *  DELETE /api/me         -> suppression du compte (anonymisation + fichiers justificatifs effacés)
 */
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { dbRun, dbGet, dbAll } from '../db.js';
import { authMiddleware } from './_auth.js';
import { UPLOAD_DIR } from '../uploads.js';
import { forgetAddressCache } from '../geo.js';
import { setStatus } from '../requests.js';
import { notifyAdmins } from '../notify.js';

const router = Router();

function strip(row: any) {
  if (!row) return row;
  const { password, ...rest } = row;
  return rest;
}

router.get('/export', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const uid = Number(req.user.id);
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [uid]) as any;
    if (!user || user.deleted_at) return res.status(404).json({ message: 'Compte introuvable.' });
    const out: any = {
      exportedAt: new Date().toISOString(),
      service: 'URGAD',
      note: 'Export RGPD (droit d\'accès et à la portabilité, art. 15 et 20). Les fichiers justificatifs sont listés ; leur contenu peut être demandé au support.',
      account: strip(user),
    };
    const prof = await dbGet('SELECT * FROM professionals WHERE user_id = ?', [uid]) as any;
    if (prof) {
      out.professionalProfile = prof;
      out.documents = await dbAll('SELECT id, name, doc_type, category, id_kind, side, status, review_reason, reviewed_by, reviewed_at, file_purged_at, mime_type, size_bytes, created_at FROM professional_documents WHERE user_id = ?', [uid]);
      out.verification = { identity: { status: prof.identity_status || 'en_attente', reason: prof.identity_reason || null, reviewedAt: prof.identity_reviewed_at || null }, diploma: { status: prof.diploma_status || 'en_attente', reason: prof.diploma_reason || null, reviewedAt: prof.diploma_reviewed_at || null } };
      out.applications = await dbAll('SELECT a.*, m.title AS mission_title, m.establishment_name, m.start_date FROM applications a LEFT JOIN missions m ON m.id = a.mission_id WHERE a.professional_id = ? OR a.professional_email = ?', [prof.id, user.email]);
    }
    const est = await dbGet('SELECT * FROM establishments WHERE user_id = ?', [uid]) as any;
    if (est) {
      out.establishment = est;
      out.establishmentDocuments = await dbAll('SELECT d.id, d.name, d.doc_type, d.status, d.created_at, f.mime_type, f.size_bytes FROM establishment_documents d LEFT JOIN document_files f ON f.owner_type = \'establishment\' AND f.document_id = d.id WHERE d.establishment_id = ?', [est.id]);
      out.subscriptions = await dbAll('SELECT * FROM establishment_subscriptions WHERE establishment_id = ?', [est.id]);
      out.missions = await dbAll('SELECT m.*, c.latitude, c.longitude FROM missions m LEFT JOIN mission_coordinates c ON c.mission_id = m.id WHERE m.establishment_id = ?', [est.id]);
      out.requestHistory = await dbAll('SELECT r.mission_id, r.event, r.from_status, r.to_status, r.details, r.created_at FROM request_events r JOIN missions m ON m.id = r.mission_id WHERE m.establishment_id = ? ORDER BY r.id', [est.id]);
      out.applicationsReceived = await dbAll('SELECT a.id, a.mission_id, a.status, a.created_at FROM applications a JOIN missions m ON m.id = a.mission_id WHERE m.establishment_id = ?', [est.id]);
    }
    const convs = await dbAll('SELECT DISTINCT conversation_id FROM messages WHERE sender_id = ?', [uid]) as any[];
    out.messages = convs.length
      ? await dbAll(`SELECT conversation_id, sender_id, sender_type, sender_name, content, created_at FROM messages WHERE conversation_id IN (${convs.map(() => '?').join(',')}) ORDER BY created_at`, convs.map((c) => c.conversation_id))
      : [];
    out.notifications = await dbAll('SELECT type, title, content, read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC', [uid]);
    out.devices = (await dbAll('SELECT platform, created_at, updated_at FROM device_tokens WHERE user_id = ?', [uid]));
    out.phoneVerifications = await dbAll('SELECT phone, used, created_at FROM phone_verifications WHERE user_id = ?', [uid]);
    out.auditLog = await dbAll('SELECT action, resource, details, created_at FROM audit_log WHERE user_id = ? ORDER BY created_at DESC', [uid]);
    res.setHeader('Content-Disposition', `attachment; filename="urgad-export-${uid}.json"`);
    return res.json(out);
  } catch (err) { next(err); }
});

function removeUpload(storedName: any): boolean {
  if (!storedName) return false;
  const file = path.join(UPLOAD_DIR, path.basename(String(storedName)));
  if (!file.startsWith(UPLOAD_DIR)) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

router.delete('/', authMiddleware, async (req: any, res: any, next: any) => {
  try {
    const uid = Number(req.user.id);
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [uid]) as any;
    if (!user || user.deleted_at) return res.status(404).json({ message: 'Compte introuvable.' });
    if (user.is_admin === 1 || user.role === 'admin') return res.status(403).json({ message: 'Un compte administrateur se supprime depuis le back-office.' });
    const password = String(req.body?.password || '');
    if (!password || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: 'Mot de passe incorrect : suppression refusée.' });
    }
    let filesRemoved = 0;
    const anonEmail = `deleted-${user.uuid || uuidv4()}@deleted.urgad.invalid`;

    if (user.role === 'professional') {
      const prof = await dbGet('SELECT id, address, city, postal_code FROM professionals WHERE user_id = ?', [uid]) as any;
      if (prof) await forgetAddressCache({ address: prof.address, postalCode: prof.postal_code, city: prof.city });
      const docs = await dbAll('SELECT stored_name FROM professional_documents WHERE user_id = ?', [uid]) as any[];
      for (const d of docs) if (removeUpload(d.stored_name)) filesRemoved++;
      await dbRun('DELETE FROM professional_documents WHERE user_id = ?', [uid]);
      if (prof) {
        // Profil proposé en attente de réponse : la demande repart en recherche et l'équipe est prévenue.
        const proposed = await dbAll("SELECT a.id, a.mission_id FROM applications a WHERE (a.professional_id = ? OR a.professional_email = ?) AND a.status = 'proposed'", [prof.id, user.email]) as any[];
        for (const pa of proposed) {
          await dbRun('UPDATE missions SET proposed_application_id = NULL WHERE id = ? AND proposed_application_id = ?', [pa.mission_id, pa.id]);
          await dbRun('UPDATE missions SET backup_application_id = NULL WHERE id = ? AND backup_application_id = ?', [pa.mission_id, pa.id]);
          await setStatus(Number(pa.mission_id), 'en_recherche', { id: uid, role: 'professional' }, 'proposed_profile_deleted', 'Compte du professionnel supprimé', pa.id);
          await notifyAdmins('Profil proposé retiré', `Le professionnel proposé pour la demande #${pa.mission_id} a supprimé son compte : proposez un autre profil.`, { missionId: pa.mission_id, screen: 'requests' }, 'request_profile_withdrawn');
        }
        await dbRun("UPDATE applications SET status = 'withdrawn' WHERE (professional_id = ? OR professional_email = ?) AND status IN ('pending', 'proposed')", [prof.id, user.email]);
        await dbRun("UPDATE applications SET professional_name = 'Utilisateur supprimé', professional_email = NULL, professional_phone = NULL WHERE professional_id = ? OR professional_email = ?", [prof.id, user.email]);
        await dbRun("UPDATE professionals SET date_of_birth = NULL, bio = NULL, experience = NULL, previous_establishments = NULL, skills = NULL, services = NULL, hours = NULL, mobility = NULL, availability = NULL, avatar_url = NULL, verification_documents = NULL, address = NULL, city = NULL, postal_code = NULL, latitude = NULL, longitude = NULL, geocode_label = NULL, geocode_precision = NULL, profession = NULL, experience_years = NULL, identity_status = NULL, identity_reason = NULL, identity_reviewed_by = NULL, identity_reviewed_at = NULL, diploma_status = NULL, diploma_reason = NULL, diploma_reviewed_by = NULL, diploma_reviewed_at = NULL WHERE id = ?", [prof.id]);
      }
    }
    if (user.role === 'establishment') {
      const est = await dbGet('SELECT id FROM establishments WHERE user_id = ?', [uid]) as any;
      if (est) {
        const files = await dbAll("SELECT f.id, f.stored_name FROM document_files f JOIN establishment_documents d ON d.id = f.document_id WHERE f.owner_type = 'establishment' AND d.establishment_id = ?", [est.id]) as any[];
        for (const f of files) { if (removeUpload(f.stored_name)) filesRemoved++; await dbRun('DELETE FROM document_files WHERE id = ?', [f.id]); }
        await dbRun('DELETE FROM establishment_documents WHERE establishment_id = ?', [est.id]);
        // Les missions à venir sont annulées ; l'historique reste pour les professionnels concernés.
        await dbRun("UPDATE missions SET status = 'cancelled', visible = 0 WHERE establishment_id = ? AND status NOT IN ('completed', 'cancelled')", [est.id]);
        await dbRun("UPDATE missions SET establishment_email = NULL WHERE establishment_id = ?", [est.id]);
        await dbRun("UPDATE establishments SET name = 'Établissement supprimé', siret = NULL, phone = NULL, email = NULL, address = NULL, responsible = NULL, documents = NULL, status = 'deleted', latitude = NULL, longitude = NULL, geocode_label = NULL, geocode_precision = NULL WHERE id = ?", [est.id]);
      }
    }
    await dbRun("UPDATE messages SET sender_name = 'Utilisateur supprimé', content = '[message supprimé]' WHERE sender_id = ?", [uid]);
    await dbRun('DELETE FROM notifications WHERE user_id = ?', [uid]);
    await dbRun('DELETE FROM device_tokens WHERE user_id = ?', [uid]);
    await dbRun('DELETE FROM phone_verifications WHERE user_id = ?', [uid]);
    const scrambled = await bcrypt.hash(uuidv4(), 10);
    await dbRun("UPDATE users SET email = ?, password = ?, phone = NULL, first_name = 'Utilisateur', last_name = 'supprimé', verified = 0, verification_status = 'deleted', deleted_at = datetime('now') WHERE id = ?", [anonEmail, scrambled, uid]);
    await dbRun('UPDATE audit_log SET user_email = NULL WHERE user_id = ?', [uid]);
    await dbRun('INSERT INTO audit_log (uuid, user_id, user_email, action, resource, details) VALUES (?, ?, ?, ?, ?, ?)', [uuidv4(), uid, null, 'account_deleted', '/api/me', `RGPD: compte anonymisé, ${filesRemoved} fichier(s) supprimé(s)`]);
    return res.json({ message: 'Compte supprimé. Vos données personnelles ont été effacées ou anonymisées.', filesRemoved });
  } catch (err) { next(err); }
});

export default router;
