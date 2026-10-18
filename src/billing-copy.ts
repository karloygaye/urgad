import { type BillingInterval, type Plan, parseBillingInterval, planPriceHt, pricePeriodLabel } from './plans.js';

export type BillingNoticeKind = 'paid' | 'renewed' | 'past_due' | 'canceled' | 'checkout_cancel' | 'extra';

export type BillingConfirmation = {
  kind: BillingNoticeKind;
  title: string;
  body: string;
  planName: string | null;
  priceHt: number | null;
  receiptNote: string;
  email: string | null;
  invoiceUrl: string | null;
};

export type BillingCopyContext = {
  establishmentName: string;
  plan?: Plan | null;
  planName?: string | null;
  interval?: BillingInterval | string | null;
  priceHt?: number | null;
  email?: string | null;
  invoiceUrl?: string | null;
};

const RECEIPT =
  'Stripe envoie le reçu et la facture HT à l’adresse e-mail du paiement (réglages Stripe → E-mails clients). URGAD n’envoie pas d’e-mail ni de SMS séparés : la confirmation est aussi dans Notifications.';

export function billingConfirmation(kind: BillingNoticeKind, ctx: BillingCopyContext): BillingConfirmation {
  const planName = ctx.plan?.name || ctx.planName || null;
  const interval = parseBillingInterval(ctx.interval);
  const priceHt = ctx.priceHt ?? (ctx.plan ? planPriceHt(ctx.plan, interval) : null);
  const etab = ctx.establishmentName || 'votre établissement';
  const priceBit = priceHt != null ? `${priceHt} € ${pricePeriodLabel(interval)}` : (interval === 'year' ? 'annuel HT' : 'mensuel HT');
  const planBit = planName ? `formule ${planName}` : 'formule URGAD';
  const email = ctx.email || null;
  const receiptNote = email
    ? `${RECEIPT} Destinataire prévu : ${email}.`
    : RECEIPT;

  if (kind === 'paid') {
    return {
      kind,
      title: `Abonnement ${planName || ''} activé`.replace(/\s+/g, ' ').trim(),
      body: `${etab} : la ${planBit} (${priceBit}) est active. Vous pouvez publier selon le quota de la formule. Reconduction tacite, résiliable pour la fin de période. ${receiptNote}`,
      planName,
      priceHt,
      receiptNote,
      email,
      invoiceUrl: ctx.invoiceUrl || null,
    };
  }
  if (kind === 'renewed') {
    return {
      kind,
      title: `Renouvellement ${planName || 'abonnement'} confirmé`.replace(/\s+/g, ' ').trim(),
      body: `${etab} : le prélèvement de la ${planBit} (${priceBit}) a bien abouti. ${receiptNote}`,
      planName,
      priceHt,
      receiptNote,
      email,
      invoiceUrl: ctx.invoiceUrl || null,
    };
  }
  if (kind === 'past_due') {
    return {
      kind,
      title: 'Paiement d’abonnement en échec',
      body: `${etab} : le prélèvement de la ${planBit} n’a pas abouti. Mettez à jour la carte depuis Abonnement, ou le Flash et les demandes au-delà de l’essai pourront être bloqués. Stripe relance aussi par e-mail si les reçus clients sont activés.`,
      planName,
      priceHt,
      receiptNote,
      email,
      invoiceUrl: ctx.invoiceUrl || null,
    };
  }
  if (kind === 'canceled') {
    return {
      kind,
      title: 'Abonnement résilié',
      body: `${etab} : la ${planBit} n’est plus active. Les 5 demandes offertes ne se rechargent pas. Pour publier à nouveau (hors essai restant), souscrivez Essentiel, Pro ou Premium.`,
      planName,
      priceHt,
      receiptNote,
      email,
      invoiceUrl: ctx.invoiceUrl || null,
    };
  }
  if (kind === 'extra') {
    return {
      kind,
      title: 'Demande supplémentaire achetée',
      body: `${etab} : une demande hors quota est créditée (${priceHt != null ? priceHt + ' € HT' : 'paiement unique'}). Publiez-la depuis Nouvelle demande. ${receiptNote}`,
      planName,
      priceHt,
      receiptNote,
      email,
      invoiceUrl: ctx.invoiceUrl || null,
    };
  }
  return {
    kind: 'checkout_cancel',
    title: 'Paiement non finalisé',
    body: `Aucun débit. ${etab} reste sur l’essai de 5 demandes (si encore disponible). Vous pouvez relancer le paiement quand vous voulez depuis Abonnement.`,
    planName,
    priceHt,
    receiptNote,
    email,
    invoiceUrl: null,
  };
}

export function adminBillingCopy(kind: BillingNoticeKind, ctx: BillingCopyContext): { title: string; body: string } {
  const planName = ctx.plan?.name || ctx.planName || 'plan';
  const interval = parseBillingInterval(ctx.interval);
  const priceHt = ctx.priceHt ?? (ctx.plan ? planPriceHt(ctx.plan, interval) : null);
  const etab = ctx.establishmentName || 'Établissement';
  const priceBit = priceHt != null ? `${priceHt} € ${pricePeriodLabel(interval)}` : '';
  if (kind === 'paid') return { title: 'Abonnement payé', body: `${etab} a activé ${planName}${priceBit ? ' · ' + priceBit : ''}.` };
  if (kind === 'renewed') return { title: 'Abonnement renouvelé', body: `${etab} : prélèvement ${planName} abouti${priceBit ? ' (' + priceBit + ')' : ''}.` };
  if (kind === 'past_due') return { title: 'Impayé abonnement', body: `${etab} : échec de paiement ${planName}. Relance Stripe + notification établissement envoyées.` };
  if (kind === 'canceled') return { title: 'Abonnement résilié', body: `${etab} a perdu ${planName}.` };
  if (kind === 'extra') return { title: 'Demande extra payée', body: `${etab} a acheté une demande hors quota${priceBit ? ' · ' + priceBit : ''}.` };
  return { title: 'Checkout abandonné', body: `${etab} a quitté Stripe sans payer.` };
}
