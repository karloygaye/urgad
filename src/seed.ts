import { initializeDb, dbRun, dbGet, dbExec, save } from './db.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { allowDemoSeed } from './runtime.js';

export const runSeed = async () => {
  await initializeDb();

  console.log('🌱 Seed URGAD — purge et initialisation...');

  // Purge
  await dbExec('DELETE FROM audit_log');
  await dbExec('DELETE FROM messages');
  await dbExec('DELETE FROM notifications');
  await dbExec('DELETE FROM applications');
  await dbExec('DELETE FROM missions');
  await dbExec('DELETE FROM establishments');
  await dbExec('DELETE FROM professionals');
  await dbExec('DELETE FROM users');
  try {
    await dbExec('DELETE FROM sqlite_sequence WHERE name IN ("users","professionals","establishments","missions","applications","notifications","messages","audit_log")');
  } catch {
    /* Postgres: pas de sqlite_sequence */
  }
  save();

  const hashedAdmin = await bcrypt.hash('admin123', 12);
  const hashedPro = await bcrypt.hash('pro123', 12);
  const hashedEst = await bcrypt.hash('est123', 12);

  // ── Admin ──
  await dbRun('INSERT INTO users (uuid, email, password, phone, first_name, last_name, role, is_admin, verified, verification_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [uuidv4(), 'admin@urgad.fr', hashedAdmin, '+33612345678', 'URGAD', 'Admin', 'admin', 1, 1, 'approved']);

  // ── Professionnels ──
  const prosData = [
    { first_name: 'Marie', last_name: 'Dupont', phone: '+33611111111', email: 'marie.dupont@email.fr', ddn: '1992-03-15' },
    { first_name: 'Jean', last_name: 'Martin', phone: '+33622222222', email: 'jean.martin@email.fr', ddn: '1988-07-22' },
    { first_name: 'Sophie', last_name: 'Lefebvre', phone: '+33633333333', email: 'sophie.lefebvre@email.fr', ddn: '1995-11-08' },
    { first_name: 'Pierre', last_name: 'Bernard', phone: '+33644444444', email: 'pierre.bernard@email.fr', ddn: '1985-01-30' },
  ];
  const proRecords = [];
  for (const p of prosData) {
    await dbRun('INSERT INTO users (uuid, email, password, phone, first_name, last_name, role, is_admin, verified, verification_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), p.email, hashedPro, p.phone, p.first_name, p.last_name, 'professional', 0, 1, 'approved']);
    const user = await dbGet('SELECT id FROM users WHERE email = ?', [p.email]) as any;
    await dbRun('INSERT INTO professionals (user_id, date_of_birth, bio, experience, skills, mobility_radius, availability) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [user.id, p.ddn, 'Aide-soignant diplômé avec 5 ans d\'expérience en EHPAD et cliniques.', 'EHPAD Les Jardins (2020-2023), Clinique Saint-Jean (2018-2020)', 'soins généraux, hygiène, rééducation légère, repos, accompagnement', 20, JSON.stringify({
        Lundi: { matin: true, apres_midi: true, nuit: false },
        Mardi: { matin: true, apres_midi: true, nuit: false },
        Mercredi: { matin: false, apres_midi: false, nuit: true },
        Jeudi: { matin: true, apres_midi: true, nuit: false },
        Vendredi: { matin: true, apres_midi: true, nuit: false },
        Samedi: { matin: false, apres_midi: true, nuit: false },
        Dimanche: { matin: false, apres_midi: false, nuit: true },
      })]);
    proRecords.push({ ...p, userId: user.id });
  }

  // ── Établissements ──
  const estsData = [
    { name: 'EHPAD Les Jardins', siret: '12345678900012', type: 'EHPAD', phone: '+33123456789', email: 'contact@ehpad-jardins.fr', address: '15 rue de la Paix', city: 'Paris', postal_code: '75002', responsible: 'Dr. Catherine Moreau' },
    { name: 'Maison de Retraite Soleil', siret: '98765432100013', type: 'Maison de retraite', phone: '+33456789012', email: 'contact@maison-soleil.fr', address: '8 avenue des Fontains', city: 'Lyon', postal_code: '69001', responsible: 'Mme. Isabelle Richard' },
    { name: 'Clinique Saint-Éloi', siret: '45678901200014', type: 'Clinique', phone: '+33567890123', email: 'accueil@saint-eloi.fr', address: '30 boulevard de l\'Hôpital', city: 'Bordeaux', postal_code: '33000', responsible: 'Dr. Marc Dubois' },
  ];
  const estRecords = [];
  for (const e of estsData) {
    await dbRun('INSERT INTO users (uuid, email, password, phone, first_name, last_name, role, is_admin, verified, verification_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), e.email, hashedEst, e.phone, e.name.split(' ')[0], e.name.split(' ').slice(1).join(' '), 'establishment', 0, 1, 'approved']);
    const user = await dbGet('SELECT id FROM users WHERE email = ?', [e.email]) as any;
    await dbRun('INSERT INTO establishments (user_id, name, siret, type, phone, email, address, city, postal_code, responsible, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [user.id, e.name, e.siret, e.type, e.phone, e.email, e.address, e.city, e.postal_code, e.responsible, 'approved']);
    estRecords.push({ ...e, userId: user.id });
  }

  // ── Missions ──
  const estIdEHPAD = await dbGet('SELECT id FROM establishments WHERE name = ?', ['EHPAD Les Jardins']) as any;
  const estIdSoleil = await dbGet('SELECT id FROM establishments WHERE name = ?', ['Maison de Retraite Soleil']) as any;
  const estIdEloi = await dbGet('SELECT id FROM establishments WHERE name = ?', ['Clinique Saint-Éloi']) as any;

  await dbRun('INSERT INTO missions (uuid, establishment_id, establishment_name, establishment_email, type, title, description, conditions, location, start_date, start_hour, end_hour, urgent, visible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [uuidv4(), estIdEHPAD?.id || 1, 'EHPAD Les Jardins', 'contact@ehpad-jardins.fr', 'vacation', 'Vacation week-end en EHPAD', 'Service de soins de week-end. Hygiène, assistance aux repas, accompagnement.', 'Rémunération vacation: taux journalier + demi', '15 rue de la Paix, 75002 Paris', '2026-09-19', '20:00', '07:00', 1, 1]);
  await dbRun('INSERT INTO missions (uuid, establishment_id, establishment_name, establishment_email, type, title, description, conditions, location, start_date, start_hour, end_hour, urgent, visible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [uuidv4(), estIdSoleil?.id || 2, 'Maison de Retraite Soleil', 'contact@maison-soleil.fr', 'remplacement', 'Remplacement AST en maison de retraite', 'Remplacement équipe AST pour la semaine. Soins courants, surveillance, animation.', 'Rémunération variable selon convention collective', '8 avenue des Fontains, 69001 Lyon', '2026-09-20', '07:00', '19:00', 0, 1]);
  await dbRun('INSERT INTO missions (uuid, establishment_id, establishment_name, establishment_email, type, title, description, conditions, location, start_date, start_hour, end_hour, urgent, visible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [uuidv4(), estIdEloi?.id || 3, 'Clinique Saint-Éloi', 'accueil@saint-eloi.fr', 'CDD', 'CDD Aide-soignant en clinique', 'Mission de 3 mois en service de neurologie. Soins techniques, prévention des escarres, accompagnement.', 'Rémunération CDD avec primes', '30 boulevard de l\'Hôpital, 33000 Bordeaux', '2026-10-01', '08:00', '20:00', 0, 1]);

  // ── Applications ──
  const missionVacation = await dbGet('SELECT id FROM missions WHERE title LIKE ?', ['Vacation%']) as any;
  await dbRun('INSERT INTO applications (uuid, mission_id, professional_id, professional_name, professional_role, professional_email, professional_phone, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [uuidv4(), missionVacation?.id || 1, proRecords[0].userId, 'Marie Dupont', 'Aide-soignant', 'marie.dupont@email.fr', '+33611111111', 'accepted']);
  await dbRun('INSERT INTO applications (uuid, mission_id, professional_id, professional_name, professional_role, professional_email, professional_phone, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [uuidv4(), missionVacation?.id || 1, proRecords[1].userId, 'Jean Martin', 'Aide-soignant', 'jean.martin@email.fr', '+33622222222', 'pending']);

  // ── Notifications ──
  await dbRun('INSERT INTO notifications (uuid, recipient_id, recipient_type, type, title, content) VALUES (?, ?, ?, ?, ?, ?)',
    [uuidv4(), proRecords[0].userId, 'professional', 'new_mission', 'Nouvelle mission disponible', 'Vacation week-end EHPAD Les Jardins — 7 km de votre domicile.']);
  await dbRun('INSERT INTO notifications (uuid, recipient_id, recipient_type, type, title, content) VALUES (?, ?, ?, ?, ?, ?)',
    [uuidv4(), proRecords[0].userId, 'professional', 'application_status', 'Candidature acceptée', 'Votre candidature pour la mission du 20 septembre a été acceptée.']);

  // ── Messages ──
  await dbRun('INSERT INTO messages (uuid, conversation_id, sender_id, sender_type, sender_name, content) VALUES (?, ?, ?, ?, ?, ?)',
    [uuidv4(), 'conv-1', proRecords[0].userId, 'professional', 'Marie Dupont', 'Bonjour, je souhaite confirmer ma mission pour samedi.']);
  await dbRun('INSERT INTO messages (uuid, conversation_id, sender_id, sender_type, sender_name, content) VALUES (?, ?, ?, ?, ?, ?)',
    [uuidv4(), 'conv-1', estRecords[0].userId, 'establishment', 'EHPAD Les Jardins', 'Bonjour Marie, oui tout est confirmé. À samedi soir !']);
  await dbRun('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)', ['conv-1', proRecords[0].userId, 'professional']);
  await dbRun('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)', ['conv-1', estRecords[0].userId, 'establishment']);

  // ── Audit log ──
  const admin = await dbGet('SELECT id, email FROM users WHERE email = ?', ['admin@urgad.fr']) as any;
  await dbRun('INSERT INTO audit_log (uuid, user_id, user_email, action, resource, details) VALUES (?, ?, ?, ?, ?, ?)',
    [uuidv4(), admin?.id || 1, 'admin@urgad.fr', 'login', '/admin', 'Connexion admin']);
  await dbRun('INSERT INTO audit_log (uuid, user_id, user_email, action, resource, details) VALUES (?, ?, ?, ?, ?, ?)',
    [uuidv4(), admin?.id || 1, 'admin@urgad.fr', 'view', '/admin/missions', 'Visualisation liste missions']);
  await dbRun('INSERT INTO audit_log (uuid, user_id, user_email, action, resource, details) VALUES (?, ?, ?, ?, ?, ?)',
    [uuidv4(), proRecords[0].userId, 'marie.dupont@email.fr', 'apply', '/missions/1', 'Candidature mission 1']);

  save();
  console.log('✅ Seed terminé avec succès !');
  console.log('   Admin: admin@urgad.fr / admin123');
  console.log('   Pro: marie.dupont@email.fr / pro123');
  console.log('   Est: contact@ehpad-jardins.fr / est123');
};

async function bootstrapAdminIfRequested(): Promise<void> {
  const email = (process.env.URGAD_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.URGAD_ADMIN_PASSWORD || '';
  if (!email || !password) return;
  if (password.length < 10) {
    console.warn('[SEED] URGAD_ADMIN_PASSWORD trop court (10 caractères min) — admin non créé');
    return;
  }
  const existing = await dbGet('SELECT id FROM users WHERE lower(email) = lower(?)', [email]) as { id?: number } | undefined;
  if (existing?.id) {
    console.log('[SEED] Admin déjà présent : ' + email);
    return;
  }
  const hashed = await bcrypt.hash(password, 12);
  const phone = (process.env.URGAD_ADMIN_PHONE || '').trim() || null;
  await dbRun(
    'INSERT INTO users (uuid, email, password, phone, first_name, last_name, role, is_admin, verified, verification_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [uuidv4(), email, hashed, phone, 'URGAD', 'Admin', 'admin', 1, 1, 'approved']
  );
  save();
  console.log('[SEED] Admin de production créé : ' + email);
}

/** Premier boot : démo seulement hors prod (ou URGAD_SEED=1). En prod, admin via URGAD_ADMIN_EMAIL. */
export const seedIfEmpty = async () => {
  await initializeDb();
  const row = await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM users');
  const count = Number(row?.c ?? 0);
  if (count > 0) {
    console.log(`[SEED] ${count} utilisateur(s) déjà présents — seed ignoré`);
    await bootstrapAdminIfRequested();
    return;
  }
  if (allowDemoSeed()) {
    console.log('[SEED] Base vide — chargement des comptes de démo');
    await runSeed();
    return;
  }
  console.log('[SEED] Production : pas de comptes démo. Définis URGAD_ADMIN_EMAIL + URGAD_ADMIN_PASSWORD (ou URGAD_SEED=1 le temps d’un boot).');
  await bootstrapAdminIfRequested();
};

if (/[\\/]seed\.(ts|js)$/i.test(process.argv[1] || '')) {
  runSeed().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
