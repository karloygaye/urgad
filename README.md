# URGAD

Mise en relation établissements de soin et professionnels. Prod : [https://urgad.fr](https://urgad.fr) (alias [https://urgad.com](https://urgad.com), encore `https://urgad-api.onrender.com` le temps du DNS).

## Ordre réaliste (prod + stores)

1. **API réelle** — Postgres Render, plus de comptes `admin123`, domaine, admin via `URGAD_ADMIN_EMAIL`.
2. **App unique Capacitor** (cette étape) — une app iOS/Android qui ouvre l’accueil, puis Pro ou Établissement.
3. **Firebase + push** — `google-services.json`, APNs, `FIREBASE_SERVICE_ACCOUNT`, puis `URGAD_NATIVE_PUSH = true`.
4. **Stores** — TestFlight / Play interne, puis review (compte démo réel, CGU, pas de paiement in-app sur l’app Pro).
5. **Établissements** — le site web reste le canal principal ; raccourci écran d’accueil en complément.

## Local

```bash
npm ci
npx tsx src/index.ts
```

[http://127.0.0.1:3001](http://127.0.0.1:3001) — sans `DATABASE_URL`, sqlite `urgad.db`. Hors production, seed démo si la base est vide (`admin@urgad.fr` / `admin123`).

Identité visuelle : épingle or (lieu de soin) + U gravé (soignant). Pack à télécharger : `public/urgad-logos.zip` ou la page `/logos.html`. Sources `public/logo.svg` (sigle), `public/logo-icon.svg` (icône app), `public/logo-lockup.svg` (sigle + mot).

Film 40 s (storyboard accueil réel) : `/motion.html`, fichiers `urgad-film-16x9.mp4` / `1x1` / `9x16`. Captures des espaces : `/captures.html`.

## Production (Render)

Dans le dashboard, **avant** d’ouvrir au public :

| Variable | Valeur |
|---|---|
| `DATABASE_URL` | Internal URL du Postgres (Francfort) |
| `JWT_SECRET` | Secret long (pas celui de démo) |
| `NODE_ENV` | `production` |
| `URGAD_SEED` | `0` |
| `URGAD_ADMIN_EMAIL` | Ton email |
| `URGAD_ADMIN_PASSWORD` | ≥ 10 caractères, une fois pour créer l’admin |

Stripe : `STRIPE_SECRET_KEY` active Checkout (Essentiel 199 € / mois ; Pro 249 € / mois ou 2 739 € / an ; Premium 299 € / mois ou 3 289 € / an). `STRIPE_WEBHOOK_SECRET` pour les renouvellements. Sans clé, le plan est enregistré sans débit. Pas de SMS : le téléphone est enregistré à l’inscription ; les alertes partent en notification (in-app, son/vibration navigateur, push si configuré). Inscription → bienvenue au compte concerné. Abonnement Stripe → confirmation in-app. Mission dans le rayon → « Nouvelle mission » au professionnel. Validation (documents, établissement, candidature) : son et vibration. La messagerie est privée : un fil n’apparaît que chez ses membres.

Après paiement : confirmation in-app (établissement + admin), écriture finance, écran de succès. Portail Stripe (factures, carte, résiliation en fin de période). Demandes extra hors quota : 25 € HT (Essentiel) / 15 € HT (Pro), 0 € (Premium). Stripe envoie le reçu si **Settings → Customer emails** (Successful payments / Failed payments) est coché. Webhook : `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`.

Santé : `GET /api/health` (`production`, `db`, `stripe.chargesEnabled`).

Missions côté pro : le filtrage par rayon (adresse du profil ou position, 20 km par défaut) reste prioritaire. Les missions publiées plus loin apparaissent sous **Hors de votre rayon** (avec la distance). Une demande BO « validée » (profil pourvu) n’est plus listée.

Justificatifs (identité, diplôme, Vitale, vaccins, RIB) : les octets sont enregistrés en Postgres (`file_bytes`) en plus du disque. Le disque Render est vidé à chaque déploiement ; « Voir le fichier » lit donc la base. Les fichiers déposés *avant* cette conservation doivent être renvoyés par le professionnel.

## Passer en production (à faire une fois)

Le site tourne déjà en `NODE_ENV=production` sur Render. **Stripe live encaisse** (`charges_enabled` + `payouts_enabled`) : Checkout mensuel 199 / 249 / 299 € HT, annuel Pro 2 739 € et Premium 3 289 € HT, webhook `https://urgad.fr/api/billing/webhook`.

Encore à faire dans le dashboard Stripe (pas d’API) :

1. **E-mails reçus** : Settings → Customer emails → Successful / Failed payments (reçu PDF).
2. **TVA** : Tax → renseigner le siège (Stripe Tax est en `pending` sans adresse). Sans ça, Checkout prélève le montant HT tel quel, sans 20 % auto.
3. **Render — plan payant** : le web `free` s’endort ; le Postgres free expire le 15/11/2026. Passez le service en Starter et la base en Basic dans le dashboard Render (carte bancaire).
4. **CGU / confidentialité** : remplacer `[RAISON SOCIALE]` / SIRET, faire relire un avocat.

## App iOS / Android (Capacitor)

App unique `fr.urgad.app`. Le HTML de `public/` est empaqueté ; l’API appelée est `https://urgad.fr` (voir `public/native-config.js`).

```bash
npm ci
npx cap sync
npx cap open android   # Android Studio
npx cap open ios       # Xcode, macOS uniquement
```

Mot de passe oublié : lien « Mot de passe oublié ? » sur les 3 espaces, page `/reset.html` (1 heure, un usage). L’e-mail part tout seul via SMTP OVH (`leprincegaye@urgad.fr`, soignants : `rachel@urgad.fr` si `SMTP_PASS_RACHEL` est défini). Le back-office reçoit aussi une notification. Compte connecté : changement de mot de passe dans le profil.

| Variable | Valeur |
|---|---|
| `SMTP_HOST` | `ssl0.ovh.net` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` / `SMTP_PASS` | Boîte `leprincegaye@urgad.fr` |
| `SMTP_USER_RACHEL` / `SMTP_PASS_RACHEL` | Optionnel, mails soignants |

Session : le jeton est gardé sur l’appareil (`localStorage`, 30 jours) pour rester connecté après fermeture de l’app. Les missions, messages et abonnements restent dans Postgres, pas dans le téléphone.

Push écran verrouillé : laisser `URGAD_NATIVE_PUSH` à `false` tant que Firebase n’est pas configuré (sinon Android peut crasher). Sur le navigateur, autoriser les notifications du site. Pour l’app : `google-services.json` (Android), APNs + `GoogleService-Info.plist` (iOS), `FIREBASE_SERVICE_ACCOUNT` sur Render, puis `URGAD_NATIVE_PUSH = true`.

## Modèle économique et mails

Playbook CA / mix d’abonnés : `docs/modele-economique.md`.  
9 mails prêts à copier (établissements, soignants, match) : `mails/modeles.md`.  
Envoyer depuis `leprincegaye@urgad.fr` (établissements, bouton Email in-app) et `rachel@urgad.fr` (mails soignants), signature https://urgad.fr.

## Comptes

- Démo locale uniquement, jamais en production.
- Admin prod : variables `URGAD_ADMIN_*` au premier boot (base vide).
