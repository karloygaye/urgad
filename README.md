# URGAD

Mise en relation établissements de soin et professionnels. API Node + aperçu HTML, déjà en ligne : [https://urgad-api.onrender.com](https://urgad-api.onrender.com).

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

## Production (Render)

Dans le dashboard, **avant** d’ouvrir au public :

| Variable | Valeur |
|---|---|
| `DATABASE_URL` | Internal URL du Postgres (Francfort) |
| `JWT_SECRET` | Secret long (pas celui de démo) |
| `NODE_ENV` | `production` |
| `URGAD_SEED` | `0` |
| `URGAD_EXPOSE_CODES` | `0` |
| `URGAD_ADMIN_EMAIL` | Ton email |
| `URGAD_ADMIN_PASSWORD` | ≥ 10 caractères, une fois pour créer l’admin |

Stripe : `STRIPE_SECRET_KEY` active Checkout (199 / 249 / 299 € HT / mois). `STRIPE_WEBHOOK_SECRET` pour les renouvellements. Sans clé, le plan est enregistré sans débit. Les codes SMS ne sont plus renvoyés dans le JSON en production.

Après paiement : confirmation in-app (établissement + admin), écriture finance, écran de succès. Portail Stripe (factures, carte, résiliation en fin de période). Demandes extra hors quota : 25 € HT (Essentiel) / 15 € HT (Pro), 0 € (Premium). Stripe envoie le reçu si **Settings → Customer emails** (Successful payments / Failed payments) est coché. Webhook : `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`.

Santé : `GET /api/health`.

## App iOS / Android (Capacitor)

App unique `fr.urgad.app`. Le HTML de `public/` est empaqueté ; l’API appelée est `https://urgad-api.onrender.com` (voir `public/native-config.js`).

```bash
npm ci
npx cap sync
npx cap open android   # Android Studio
npx cap open ios       # Xcode, macOS uniquement
```

Push : laisser `URGAD_NATIVE_PUSH` à `false` tant que Firebase n’est pas configuré (sinon Android peut crasher). Ensuite poser les fichiers Firebase et passer le flag à `true`.

## Comptes

- Démo locale uniquement, jamais en production.
- Admin prod : variables `URGAD_ADMIN_*` au premier boot (base vide).
