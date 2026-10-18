import { dbGet, dbRun } from './db.js';

/** Modèle économique URGAD : les soignants sont gratuits ; les établissements paient un abonnement HT.
 *  Pas de commission sur le salaire du professionnel (différenciation vs intérim).
 *  Stripe Checkout si STRIPE_SECRET_KEY est défini. Pro / Premium : mois ou année (1 mois offert). */

export type PlanId = 'essentiel' | 'pro' | 'premium';
export type BillingInterval = 'month' | 'year';

export type Plan = {
  id: PlanId;
  name: string;
  priceHt: number;
  yearlyPriceHt: number | null;
  period: 'month';
  currency: 'EUR';
  highlight: boolean;
  badge: string | null;
  tagline: string;
  audience: string;
  missionsPerMonth: number | null;
  flashPerMonth: number | null;
  extraMissionHt: number | null;
  perks: string[];
};

export function parseBillingInterval(value: unknown): BillingInterval {
  const s = String(value || '').trim().toLowerCase();
  if (s === 'year' || s === 'yearly' || s === 'annual' || s === 'annuel' || s === 'an') return 'year';
  return 'month';
}

export function planAllowsYearly(plan: Plan): boolean {
  return plan.yearlyPriceHt != null && plan.yearlyPriceHt > 0;
}

export function planPriceHt(plan: Plan, interval: BillingInterval = 'month'): number {
  if (interval === 'year' && planAllowsYearly(plan)) return Number(plan.yearlyPriceHt);
  return plan.priceHt;
}

export function pricePeriodLabel(interval: BillingInterval): string {
  return interval === 'year' ? 'HT / an' : 'HT / mois';
}

export const BILLING_MODEL = {
  whoPays: 'establishment' as const,
  professionals: { priceHt: 0, note: 'Inscription, candidatures et messagerie gratuites. Jamais de paiement in-app côté soignant.' },
  tax: 'HT' as const,
  renewal: 'Mensuel, ou annuel Pro / Premium (1 mois offert). Reconduction tacite, résiliable pour la fin de période.',
  commissionOnWages: 0,
  positioning: 'Abonnement logiciel d’intermédiaire : l’établissement rémunère le soignant selon sa convention. URGAD ne prend pas de marge sur l’heure travaillée.',
  payment: 'Carte via Stripe Checkout (HT, live). Essentiel au mois ; Pro et Premium au mois ou à l’année.',
  trialMissions: 5,
  trialNote: '5 demandes offertes à l’inscription, sans carte. L’abonnement peut être pris tout de suite ou après ces 5 essais. Le Flash (urgence) reste réservé au Pro et au Premium payés.',
};

export const FREE_TRIAL_MISSIONS = BILLING_MODEL.trialMissions;

export const PLANS: Plan[] = [
  {
    id: 'essentiel',
    name: 'Essentiel',
    priceHt: 199,
    yearlyPriceHt: null,
    period: 'month',
    currency: 'EUR',
    highlight: false,
    badge: null,
    tagline: 'Remplacements ponctuels, un site',
    audience: 'EHPAD ou clinique qui publie quelques besoins par mois',
    missionsPerMonth: 12,
    flashPerMonth: 0,
    extraMissionHt: 25,
    perks: [
      '12 demandes de mission par mois calendaire',
      'Matching sur rayon et disponibilités',
      'Profils à valider (identité / diplôme côté URGAD)',
      'Messagerie une fois le match fait',
      'Dépôt KBIS et documents établissement',
      '1 établissement, support e-mail',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    priceHt: 249,
    yearlyPriceHt: 2739,
    period: 'month',
    currency: 'EUR',
    highlight: true,
    badge: 'Le plus choisi',
    tagline: 'Volume + urgences de nuit',
    audience: 'Établissement qui recourt souvent aux vacations et au Flash',
    missionsPerMonth: 30,
    flashPerMonth: null,
    extraMissionHt: 15,
    perks: [
      '30 demandes de mission par mois',
      'Missions Flash (urgence) illimitées',
      'Visibilité prioritaire auprès des soignants proches',
      'Messagerie et documents inclus',
      'Suivi des profils proposés sans plafond quotidien',
      'Support prioritaire (réponse sous 1 jour ouvré)',
    ],
  },
  {
    id: 'premium',
    name: 'Premium',
    priceHt: 299,
    yearlyPriceHt: 3289,
    period: 'month',
    currency: 'EUR',
    highlight: false,
    badge: 'Volume illimité',
    tagline: 'Groupe ou gros besoin, zéro friction',
    audience: 'Plusieurs services, week-ends chargés, besoin d’un volume ouvert',
    missionsPerMonth: null,
    flashPerMonth: null,
    extraMissionHt: 0,
    perks: [
      'Demandes de mission illimitées',
      'Flash illimité',
      'Matching prioritaire + multi-besoins le même jour',
      'Tableau de bord et historique complets',
      'Interlocuteur dédié URGAD',
      'Demandes supplémentaires : 0 €',
    ],
  },
];

export function planById(id: string): Plan | undefined {
  return PLANS.find((p) => p.id === String(id || '').trim().toLowerCase());
}

export function planByName(name: string): Plan | undefined {
  const n = String(name || '').trim().toLowerCase();
  return PLANS.find((p) => p.name.toLowerCase() === n || p.id === n);
}

export function publicCatalog() {
  return {
    model: BILLING_MODEL,
    plans: PLANS,
  };
}

function monthStartIso(): string {
  const d = new Date();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}-01`;
}

export async function usageThisMonth(establishmentId: number): Promise<{ missions: number; flash: number; since: string }> {
  const since = monthStartIso();
  const all = await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM missions WHERE establishment_id = ? AND created_at >= ?', [establishmentId, since]);
  const flash = await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM missions WHERE establishment_id = ? AND created_at >= ? AND urgent = 1', [establishmentId, since]);
  return { missions: Number(all?.c ?? 0), flash: Number(flash?.c ?? 0), since };
}

export async function lifetimeMissions(establishmentId: number): Promise<number> {
  const all = await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM missions WHERE establishment_id = ?', [establishmentId]);
  return Number(all?.c ?? 0);
}

export type TrialInfo = { limit: number; used: number; remaining: number; active: boolean };

export async function trialInfo(establishmentId: number, paid: boolean): Promise<TrialInfo> {
  const used = await lifetimeMissions(establishmentId);
  const remaining = Math.max(0, FREE_TRIAL_MISSIONS - used);
  return { limit: FREE_TRIAL_MISSIONS, used, remaining, active: !paid && remaining > 0 };
}

export async function assertEstablishmentActive(establishmentId: number): Promise<void> {
  const est = await dbGet<{ status: string; verification_status: string }>('SELECT e.status, u.verification_status FROM establishments e JOIN users u ON u.id = e.user_id WHERE e.id = ?', [establishmentId]);
  if (!est) {
    const err: any = new Error('Établissement introuvable.');
    err.status = 404;
    err.code = 'not_found';
    throw err;
  }
  if (est.status === 'suspended' || est.verification_status === 'suspended') {
    const err: any = new Error('Compte établissement suspendu. Contactez URGAD.');
    err.status = 403;
    err.code = 'account_suspended';
    throw err;
  }
  if (est.status === 'rejected' || est.verification_status === 'rejected') {
    const err: any = new Error('Compte établissement non validé. Vous ne pouvez pas publier de demande.');
    err.status = 403;
    err.code = 'account_rejected';
    throw err;
  }
}

export async function assertEstablishmentPublish(establishmentId: number, opts: { urgent?: boolean } = {}): Promise<Plan | null> {
  await assertEstablishmentActive(establishmentId);
  const row = await dbGet<{ id: number; name: string; status: string; extra_credits: number | null }>('SELECT id, name, status, extra_credits FROM establishment_subscriptions WHERE establishment_id = ? ORDER BY id DESC LIMIT 1', [establishmentId]);
  const plan = row?.name ? planByName(row.name) : undefined;
  const stripeOn = !!(process.env.STRIPE_SECRET_KEY || '').trim();
  const paid = ['paid', 'active', 'trialing'].includes(String(row?.status || '').toLowerCase());
  const subscribed = !!plan && (!stripeOn || paid);
  const usedMonth = await usageThisMonth(establishmentId);

  if (opts.urgent) {
    if (!subscribed || !plan || plan.flashPerMonth === 0) {
      const err: any = new Error('Les missions Flash (urgence) sont incluses à partir du plan Pro (249 € HT / mois) payé. Les 5 demandes offertes sont des demandes standard.');
      err.status = 402;
      err.code = 'flash_plan';
      throw err;
    }
    if (plan.flashPerMonth != null && usedMonth.flash >= plan.flashPerMonth) {
      const err: any = new Error('Quota Flash du mois atteint.');
      err.status = 402;
      err.code = 'flash_quota';
      throw err;
    }
  }

  if (subscribed && plan) {
    if (plan.missionsPerMonth != null && usedMonth.missions >= plan.missionsPerMonth) {
      const credits = Number(row?.extra_credits || 0);
      if (credits > 0 && row?.id) {
        await dbRun('UPDATE establishment_subscriptions SET extra_credits = COALESCE(extra_credits, 0) - 1 WHERE id = ? AND COALESCE(extra_credits, 0) > 0', [row.id]);
        return plan;
      }
      const extra = plan.extraMissionHt != null ? ` Demande supplémentaire : ${plan.extraMissionHt} € HT.` : '';
      const err: any = new Error(`Quota du plan ${plan.name} atteint (${plan.missionsPerMonth} demandes ce mois).${extra}`);
      err.status = 402;
      err.code = 'mission_quota';
      err.extraHt = plan.extraMissionHt;
      throw err;
    }
    return plan;
  }

  const life = await lifetimeMissions(establishmentId);
  if (life >= FREE_TRIAL_MISSIONS) {
    const err: any = new Error('Les 5 demandes offertes sont utilisées. Choisissez un abonnement (Essentiel, Pro ou Premium) pour continuer. Vous pouviez vous abonner dès la première demande.');
    err.status = 402;
    err.code = 'trial_exhausted';
    throw err;
  }
  return null;
}
