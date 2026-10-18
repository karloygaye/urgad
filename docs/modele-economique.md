# Modèle économique URGAD — comment ça tient

Les soignants sont gratuits. Les établissements paient un **abonnement logiciel HT / mois**. **0 %** de commission sur l’heure travaillée. C’est la différence avec l’intérim : le salaire reste celui de la convention de l’établissement.

Simulateur + mails remplis : canvas « URGAD — modèle économique et mails ». Textes bruts : `mails/modeles.md`.

## Offre (catalogue produit)

| Formule | Prix HT / mois | Demandes | Flash | Extra HT |
|---|---:|---|---|---:|
| Essai établissement | 0 € | 5 à vie, sans carte | non | — |
| Essentiel | 199 € | 12 / mois | non | 25 € |
| Pro (cœur de cible) | 249 € | 30 / mois | illimité | 15 € |
| Premium | 299 € | illimité | illimité | 0 € |
| Soignant | 0 € | candidatures libres | — | — |

Un EHPAD qui remplace 2 à 3 nuits par semaine tient dans le **Pro**. L’Essentiel est l’entrée. Le Premium est pour un groupe ou un gros site. Ne pas vendre Premium au premier appel.

## Unité économique (ordre de grandeur)

| Poste | Montant |
|---|---|
| 1 Pro | 249 € HT / mois |
| TVA 20 % encaissée | +49,80 € (reversée) |
| Stripe ~ 1,5 % + 0,25 € | ~ 4 € |
| Infra (Render + domaine) répartie | ~ 30 € / mois **au total**, pas par client |
| Marge brute sur 1 Pro | ~ 245 € HT avant temps humain |

Le premier Pro paie déjà l’infra plusieurs fois. Le vrai coût au début : **15–25 minutes de matching humain** par demande (Leprince / Rachel). Automatiser dès que 8 établissements paient.

## Trajectoire (pas un marché national d’abord)

| Étape | Où | Soignants vérifiés | Établissements payants | Objectif CA HT / mois |
|---|---|---|---|---|
| 1 — Preuve | 1 ville (Lyon **ou** Paris) | 40–60 AS / IDE / AES | 8 (surtout Pro) | ~ 2 000 € |
| 2 — Rythme | Même bassin + 1 voisine | 120+ | 25 | ~ 6 000 € |
| 3 — Tenue | 2–3 bassins | 250+ | 40 | ~ 10 000 € |

Mix type étape 1 : 2 Essentiel + 5 Pro + 1 Premium ≈ 1 942 € HT. Les extras (15–25 €) sont un filet, pas le moteur.

## Entonnoir

1. Recruter les soignants de **la** ville **avant** d’appeler les cadres.
2. 10 appels cadres / jour → 2 essais → 1 Pro si le premier week-end est sauvé.
3. Cible : cadre de santé / responsable des remplacements, pas la direction générale.
4. Taux de pourvoi visé : **70 % dès la 2e demande**. Sinon l’essai de 5 demandes ne convertit pas.
5. Relance mail J+4, puis appel. À la 4e demande : proposer Pro. Après la 5e : checkout.

Les 5 demandes offertes ne rapportent rien. Elles doivent être **pourvues**.

## Ce qu’il ne faut pas faire

- Commission sur le salaire (ça tue la différenciation).
- Pubs nationales avant d’avoir 8 payants dans une ville.
- Flash pendant l’essai (réservé Pro / Premium payés).
- Ouvrir 10 départements sans stock de soignants.
- Promettre un délai de pourvoi que le bassin ne tient pas.

## Semaine type (étape 1)

| Jour | Établissements | Soignants |
|---|---|---|
| Lun–mer | 10 appels + mail 1 | Vérifier 8 dossiers (identité + diplôme) |
| Jeu | Relances J+4 (mail 2) | Relance documents (mail 7) |
| Ven | Saisir / matcher les demandes du week-end | Mail 8 aux profils dans le rayon |
| Sam–dim | Suivi Flash (uniquement clients Pro) | Secours si empêchement (mail 9) |

## Paiements (état)

Stripe live est ouvert : cartes et virements sortants actifs. Produits Checkout : Essentiel 199 €, Pro 249 €, Premium 299 € HT / mois. Webhook et portail facturation sur https://urgad.fr.

Reste dashboard Stripe : cocher **Customer emails** (reçus), renseigner le **siège** pour la TVA (Stripe Tax encore pending). Render : Postgres free expire le 15/11/2026.

## Fichiers

- `mails/modeles.md` — 9 textes (5 établissements, 3 soignants, 1 interne).
- Catalogue prix : `src/plans.ts`.
