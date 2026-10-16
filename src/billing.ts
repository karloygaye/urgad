import Stripe from 'stripe';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbRun } from './db.js';
import { type Plan, planById, planByName } from './plans.js';
import { notifyAdmins, notifySafe } from './notify.js';
import { adminBillingCopy, billingConfirmation, type BillingConfirmation, type BillingNoticeKind } from './billing-copy.js';

let client: Stripe | null | undefined;

export function stripeEnabled(): boolean {
  return !!(process.env.STRIPE_SECRET_KEY || '').trim();
}

export type StripeLiveStatus = {
  configured: boolean;
  livemode: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  missing: string[];
  message: string | null;
};

let liveCache: { at: number; status: StripeLiveStatus } | null = null;

export async function stripeLiveStatus(force = false): Promise<StripeLiveStatus> {
  if (!stripeEnabled()) {
    return {
      configured: false,
      livemode: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      missing: [],
      message: 'STRIPE_SECRET_KEY absente.',
    };
  }
  if (!force && liveCache && Date.now() - liveCache.at < 60_000) return liveCache.status;
  const stripe = getStripe()!;
  const acc = await stripe.accounts.retrieveCurrent();
  let missing: string[] = [];
  try {
    const cap = await stripe.accounts.retrieveCapability(acc.id, 'card_payments');
    missing = [...(cap.requirements?.currently_due || []), ...(cap.requirements?.past_due || [])];
    missing = [...new Set(missing)];
  } catch {
    missing = [];
  }
  const status: StripeLiveStatus = {
    configured: true,
    livemode: !!(process.env.STRIPE_SECRET_KEY || '').trim().startsWith('sk_live'),
    chargesEnabled: !!acc.charges_enabled,
    payoutsEnabled: !!acc.payouts_enabled,
    missing,
    message: acc.charges_enabled
      ? null
      : 'Compte Stripe live incomplet : ouvrez https://dashboard.stripe.com/settings/update et renseignez l’e-mail professionnel, le téléphone et le code MCC (activité). Tant que les cartes sont inactives, Checkout ne peut pas encaisser.',
  };
  liveCache = { at: Date.now(), status };
  return status;
}

export function getStripe(): Stripe | null {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) {
    client = null;
    return null;
  }
  if (!client) client = new Stripe(key);
  return client;
}

export function publicUrl(req?: { protocol?: string; get?: (h: string) => string | undefined }): string {
  const env = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '');
  if (env) return env.startsWith('http') ? env : 'https://' + env;
  if (req?.get) {
    const host = req.get('x-forwarded-host') || req.get('host') || '';
    if (host) {
      const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
      return proto + '://' + host;
    }
  }
  return 'https://urgad.fr';
}

async function ensurePriceId(stripe: Stripe, plan: Plan): Promise<string> {
  const lookup = 'urgad_' + plan.id + '_month';
  const listed = await stripe.prices.list({ lookup_keys: [lookup], active: true, limit: 1 });
  if (listed.data[0]) return listed.data[0].id;
  const product = await stripe.products.create({
    name: 'URGAD ' + plan.name,
    description: plan.tagline + ' — ' + plan.priceHt + ' € HT / mois',
    metadata: { urgad_plan: plan.id },
  });
  try {
    const price = await stripe.prices.create({
      product: product.id,
      currency: 'eur',
      unit_amount: plan.priceHt * 100,
      recurring: { interval: 'month' },
      lookup_key: lookup,
      transfer_lookup_key: true,
      tax_behavior: 'exclusive',
      nickname: plan.name + ' ' + plan.priceHt + ' € HT / mois',
      metadata: { urgad_plan: plan.id },
    });
    return price.id;
  } catch (e) {
    const again = await stripe.prices.list({ lookup_keys: [lookup], active: true, limit: 1 });
    if (again.data[0]) return again.data[0].id;
    throw e;
  }
}

export async function createCheckoutSession(opts: {
  plan: Plan;
  establishmentId: number;
  subscriptionRowId: number;
  email: string;
  existingCustomerId?: string | null;
  req?: { protocol?: string; get?: (h: string) => string | undefined };
}): Promise<{ url: string | null; reason: 'missing_key' | 'ok' | 'charges_disabled'; checkoutId?: string; customerId?: string }> {
  const stripe = getStripe();
  if (!stripe) return { url: null, reason: 'missing_key' };
  const live = await stripeLiveStatus();
  if (!live.chargesEnabled) return { url: null, reason: 'charges_disabled' };
  const priceId = await ensurePriceId(stripe, opts.plan);
  const base = publicUrl(opts.req);
  const success = base + '/urgad-etab.html?billing=success&session_id={CHECKOUT_SESSION_ID}';
  const cancel = base + '/urgad-etab.html?billing=cancel';
  const meta = {
    establishmentId: String(opts.establishmentId),
    planId: opts.plan.id,
    rowId: String(opts.subscriptionRowId),
  };
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    locale: 'fr',
    customer: opts.existingCustomerId || undefined,
    customer_email: opts.existingCustomerId ? undefined : opts.email || undefined,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: success,
    cancel_url: cancel,
    allow_promotion_codes: true,
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    metadata: meta,
    subscription_data: { metadata: meta },
    custom_text: {
      submit: {
        message:
          'Abonnement mensuel HT URGAD, reconduction tacite, résiliable pour la fin de période. Stripe envoie le reçu à cette adresse e-mail. URGAD confirme aussi dans Notifications (pas d’e-mail URGAD séparé).',
      },
      after_submit: {
        message: 'Vous revenez ensuite sur l’espace établissement. L’abonnement s’active dès confirmation du paiement.',
      },
    },
  });
  if (session.id) {
    await dbRun('UPDATE establishment_subscriptions SET stripe_checkout_id = ? WHERE id = ?', [session.id, opts.subscriptionRowId]);
  }
  return {
    url: session.url || null,
    reason: 'ok',
    checkoutId: session.id,
    customerId: typeof session.customer === 'string' ? session.customer : undefined,
  };
}

export async function createExtraMissionCheckout(opts: {
  plan: Plan;
  establishmentId: number;
  subscriptionRowId: number;
  email: string;
  existingCustomerId?: string | null;
  req?: { protocol?: string; get?: (h: string) => string | undefined };
}): Promise<{ url: string | null; reason: 'missing_key' | 'ok' | 'not_priced' | 'charges_disabled'; checkoutId?: string }> {
  const stripe = getStripe();
  if (!stripe) return { url: null, reason: 'missing_key' };
  const live = await stripeLiveStatus();
  if (!live.chargesEnabled) return { url: null, reason: 'charges_disabled' };
  const amount = opts.plan.extraMissionHt;
  if (amount == null || amount <= 0) return { url: null, reason: 'not_priced' };
  const base = publicUrl(opts.req);
  const meta = {
    kind: 'extra_mission',
    establishmentId: String(opts.establishmentId),
    rowId: String(opts.subscriptionRowId),
    extraHt: String(amount),
  };
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    locale: 'fr',
    customer: opts.existingCustomerId || undefined,
    customer_email: opts.existingCustomerId ? undefined : opts.email || undefined,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'eur',
        tax_behavior: 'exclusive',
        unit_amount: amount * 100,
        product_data: {
          name: 'URGAD — demande supplémentaire',
          description: '1 demande hors quota du plan ' + opts.plan.name + ' · ' + amount + ' € HT',
        },
      },
    }],
    success_url: base + '/urgad-etab.html?billing=extra&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: base + '/urgad-etab.html?billing=cancel',
    billing_address_collection: 'required',
    invoice_creation: { enabled: true },
    metadata: meta,
    custom_text: {
      submit: { message: 'Paiement unique HT. Cette demande s’ajoute à votre quota du mois. Stripe envoie le reçu par e-mail.' },
    },
  });
  return { url: session.url || null, reason: 'ok', checkoutId: session.id };
}

let portalConfigId: string | null | undefined;

async function portalConfigurationId(stripe: Stripe): Promise<string | undefined> {
  if (portalConfigId) return portalConfigId;
  const listed = await stripe.billingPortal.configurations.list({ limit: 5, active: true });
  if (listed.data[0]) {
    portalConfigId = listed.data[0].id;
    return portalConfigId;
  }
  const created = await stripe.billingPortal.configurations.create({
    business_profile: {
      headline: 'Facturation URGAD',
      privacy_policy_url: publicUrl() + '/confidentialite.html',
      terms_of_service_url: publicUrl() + '/cgu.html',
    },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      customer_update: { enabled: true, allowed_updates: ['email', 'address', 'tax_id'] },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
    },
  });
  portalConfigId = created.id;
  return portalConfigId;
}

export async function createPortalSession(opts: {
  customerId: string;
  req?: { protocol?: string; get?: (h: string) => string | undefined };
}): Promise<{ url: string | null; reason: 'missing_key' | 'ok' | 'no_customer' }> {
  const stripe = getStripe();
  if (!stripe) return { url: null, reason: 'missing_key' };
  if (!opts.customerId) return { url: null, reason: 'no_customer' };
  let configuration: string | undefined;
  try { configuration = await portalConfigurationId(stripe); }
  catch (e: any) { console.error('[STRIPE] portail config', e?.message || e); }
  const session = await stripe.billingPortal.sessions.create({
    customer: opts.customerId,
    configuration,
    return_url: publicUrl(opts.req) + '/urgad-etab.html?billing=portal',
    locale: 'fr',
  });
  return { url: session.url || null, reason: 'ok' };
}

type SubRow = {
  id: number;
  establishment_id: number;
  name: string;
  status: string;
  price: number;
  billing_notice: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_checkout_id: string | null;
  establishment_name: string;
  user_id: number;
  email: string | null;
};

async function loadSubRow(rowId: number): Promise<SubRow | undefined> {
  return dbGet<SubRow>(
    `SELECT s.*, e.name AS establishment_name, e.user_id, u.email
     FROM establishment_subscriptions s
     JOIN establishments e ON e.id = s.establishment_id
     JOIN users u ON u.id = e.user_id
     WHERE s.id = ?`,
    [rowId]
  );
}

async function findRowId(opts: { rowId?: number; subscriptionId?: string | null; customerId?: string | null; checkoutId?: string | null }): Promise<number | null> {
  if (opts.rowId) return opts.rowId;
  if (opts.subscriptionId) {
    const bySub = await dbGet<{ id: number }>('SELECT id FROM establishment_subscriptions WHERE stripe_subscription_id = ?', [opts.subscriptionId]);
    if (bySub?.id) return Number(bySub.id);
  }
  if (opts.checkoutId) {
    const byCk = await dbGet<{ id: number }>('SELECT id FROM establishment_subscriptions WHERE stripe_checkout_id = ?', [opts.checkoutId]);
    if (byCk?.id) return Number(byCk.id);
  }
  if (opts.customerId) {
    const byCust = await dbGet<{ id: number }>('SELECT id FROM establishment_subscriptions WHERE stripe_customer_id = ? ORDER BY id DESC LIMIT 1', [opts.customerId]);
    if (byCust?.id) return Number(byCust.id);
  }
  return null;
}

async function claimNotice(rowId: number, token: string): Promise<boolean> {
  const row = await dbGet<{ billing_notice: string | null }>('SELECT billing_notice FROM establishment_subscriptions WHERE id = ?', [rowId]);
  if (!row) return false;
  if (String(row.billing_notice || '') === token) return false;
  await dbRun('UPDATE establishment_subscriptions SET billing_notice = ? WHERE id = ?', [token, rowId]);
  return true;
}

async function recordSubscriptionFinance(row: SubRow, ref: string, amount: number, kind = 'Abonnement Stripe'): Promise<void> {
  if (!ref) return;
  const existing = await dbGet<{ id: number }>('SELECT id FROM finance_records WHERE reference = ?', [ref]);
  if (existing?.id) return;
  const uuid = uuidv4();
  const today = new Date().toISOString().slice(0, 10);
  await dbRun(
    'INSERT INTO finance_records (uuid, reference, establishment, kind, missions, amount, commission, record_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [uuid, ref, row.establishment_name, kind, kind.startsWith('Demande') ? 1 : 0, amount, amount, today, 'paid']
  );
}

async function announce(
  rowId: number,
  kind: BillingNoticeKind,
  noticeToken: string,
  extras?: { invoiceUrl?: string | null; email?: string | null; priceHt?: number | null }
): Promise<BillingConfirmation | null> {
  const row = await loadSubRow(rowId);
  if (!row) return null;
  const plan = planByName(row.name) || planById(String(row.name || '').toLowerCase());
  const copy = billingConfirmation(kind, {
    establishmentName: row.establishment_name,
    plan,
    planName: row.name,
    priceHt: extras?.priceHt ?? plan?.priceHt ?? Number(row.price),
    email: extras?.email || row.email,
    invoiceUrl: extras?.invoiceUrl || null,
  });
  if (!(await claimNotice(rowId, noticeToken))) return copy;
  if (kind === 'extra') {
    await dbRun('UPDATE establishment_subscriptions SET extra_credits = COALESCE(extra_credits, 0) + 1 WHERE id = ?', [rowId]);
  }
  await notifySafe(Number(row.user_id), copy.title, copy.body, {
    establishmentId: row.establishment_id,
    subscriptionId: row.id,
    planId: plan?.id || '',
    screen: 'subscription',
    invoiceUrl: copy.invoiceUrl || '',
  }, 'subscription_' + kind);
  const admin = adminBillingCopy(kind, {
    establishmentName: row.establishment_name,
    plan,
    planName: row.name,
    priceHt: plan?.priceHt ?? Number(row.price),
  });
  await notifyAdmins(admin.title, admin.body, {
    establishmentId: row.establishment_id,
    subscriptionId: row.id,
    screen: 'finance',
  }, 'admin_subscription_' + kind);
  if (kind === 'paid' || kind === 'renewed' || kind === 'extra') {
    const amount = extras?.priceHt ?? plan?.priceHt ?? Number(row.price) ?? 0;
    await recordSubscriptionFinance(row, noticeToken, amount, kind === 'extra' ? 'Demande extra Stripe' : 'Abonnement Stripe');
  }
  return copy;
}

export async function markSubscriptionPaid(rowId: number, extra: { customerId?: string | null; subscriptionId?: string | null; checkoutId?: string | null }): Promise<void> {
  const sets = ['status = ?'];
  const params: unknown[] = ['paid'];
  if (extra.customerId) {
    sets.push('stripe_customer_id = ?');
    params.push(extra.customerId);
  }
  if (extra.subscriptionId) {
    sets.push('stripe_subscription_id = ?');
    params.push(extra.subscriptionId);
  }
  if (extra.checkoutId) {
    sets.push('stripe_checkout_id = ?');
    params.push(extra.checkoutId);
  }
  params.push(rowId);
  await dbRun('UPDATE establishment_subscriptions SET ' + sets.join(', ') + ' WHERE id = ?', params);
}

function invoiceUrlFrom(inv: Stripe.Invoice | string | null | undefined): string | null {
  if (!inv || typeof inv === 'string') return null;
  return inv.hosted_invoice_url || inv.invoice_pdf || null;
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const nested = invoice.parent?.subscription_details?.subscription;
  if (typeof nested === 'string') return nested;
  if (nested && typeof nested === 'object' && 'id' in nested) return String(nested.id);
  const legacy = (invoice as unknown as { subscription?: string | Stripe.Subscription }).subscription;
  if (typeof legacy === 'string') return legacy;
  if (legacy && typeof legacy === 'object' && 'id' in legacy) return String(legacy.id);
  return null;
}

function invoiceRowMeta(invoice: Stripe.Invoice): number {
  const fromParent = Number(invoice.parent?.subscription_details?.metadata?.rowId || 0);
  if (fromParent) return fromParent;
  return Number(invoice.metadata?.rowId || 0);
}

export async function applyStripeEvent(event: Stripe.Event): Promise<void> {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const rowId = await findRowId({
      rowId: Number(session.metadata?.rowId || 0) || undefined,
      checkoutId: session.metadata?.kind === 'extra_mission' ? null : session.id,
      customerId: typeof session.customer === 'string' ? session.customer : null,
      subscriptionId: typeof session.subscription === 'string' ? session.subscription : null,
    });
    const customerId = typeof session.customer === 'string' ? session.customer : null;
    const subId = typeof session.subscription === 'string' ? session.subscription : null;
    if (rowId && session.metadata?.kind === 'extra_mission') {
      const extraHt = Number(session.metadata.extraHt || 0);
      const email = session.customer_details?.email || session.customer_email || null;
      await announce(rowId, 'extra', 'extra:' + session.id, {
        invoiceUrl: invoiceUrlFrom(session.invoice as Stripe.Invoice | string | null | undefined),
        email,
        priceHt: extraHt || null,
      });
      return;
    }
    if (rowId) {
      await markSubscriptionPaid(rowId, { customerId, subscriptionId: subId, checkoutId: session.id });
      const planId = session.metadata?.planId;
      const plan = planId ? planById(planId) : undefined;
      if (plan) {
        await dbRun('UPDATE establishment_subscriptions SET name = ?, price = ? WHERE id = ?', [plan.name, plan.priceHt, rowId]);
      }
      const email = session.customer_details?.email || session.customer_email || null;
      await announce(rowId, 'paid', 'paid:first', {
        invoiceUrl: invoiceUrlFrom(session.invoice as Stripe.Invoice | string | null | undefined),
        email,
      });
    }
    return;
  }
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
    const invoice = event.data.object as Stripe.Invoice;
    const subId = invoiceSubscriptionId(invoice);
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : null;
    const rowId = await findRowId({
      rowId: invoiceRowMeta(invoice) || undefined,
      subscriptionId: subId,
      customerId,
    });
    if (!rowId) return;
    if (event.type === 'invoice.paid') {
      await dbRun('UPDATE establishment_subscriptions SET status = ? WHERE id = ?', ['paid', rowId]);
      const billingReason = String(invoice.billing_reason || '');
      const first = billingReason === 'subscription_create' || billingReason === 'subscription';
      const kind: BillingNoticeKind = first ? 'paid' : 'renewed';
      await announce(rowId, kind, first ? 'paid:first' : 'paid:' + invoice.id, {
        invoiceUrl: invoice.hosted_invoice_url || invoice.invoice_pdf || null,
        email: invoice.customer_email,
      });
    } else {
      await dbRun('UPDATE establishment_subscriptions SET status = ? WHERE id = ?', ['past_due', rowId]);
      await announce(rowId, 'past_due', 'past_due:' + invoice.id, {
        invoiceUrl: invoice.hosted_invoice_url || null,
        email: invoice.customer_email,
      });
    }
    return;
  }
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as Stripe.Subscription;
    const rowId = await findRowId({
      rowId: Number(sub.metadata?.rowId || 0) || undefined,
      subscriptionId: sub.id,
      customerId: typeof sub.customer === 'string' ? sub.customer : null,
    });
    const statusMap: Record<string, string> = {
      active: 'paid',
      trialing: 'paid',
      past_due: 'past_due',
      canceled: 'canceled',
      unpaid: 'past_due',
      incomplete: 'pending',
      incomplete_expired: 'canceled',
      paused: 'pending',
    };
    const status = event.type === 'customer.subscription.deleted' ? 'canceled' : (statusMap[sub.status] || 'pending');
    if (!rowId) return;
    await dbRun('UPDATE establishment_subscriptions SET status = ?, stripe_subscription_id = ? WHERE id = ?', [status, sub.id, rowId]);
    if (status === 'canceled') await announce(rowId, 'canceled', 'canceled:' + sub.id);
    if (status === 'past_due') await announce(rowId, 'past_due', 'past_due:' + sub.id);
  }
}

export type ConfirmCheckoutResult = {
  ok: boolean;
  confirmation: BillingConfirmation | null;
};

export async function confirmCheckoutSession(sessionId: string, establishmentId: number): Promise<ConfirmCheckoutResult> {
  const stripe = getStripe();
  if (!stripe || !sessionId) return { ok: false, confirmation: null };
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['invoice', 'customer'] });
  const rowId = Number(session.metadata?.rowId || 0);
  const metaEst = Number(session.metadata?.establishmentId || 0);
  if (metaEst && metaEst !== establishmentId) return { ok: false, confirmation: null };
  const paid = session.status === 'complete' || session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  if (!paid || !rowId) return { ok: false, confirmation: null };
  const email =
    session.customer_details?.email ||
    session.customer_email ||
    (session.customer && typeof session.customer === 'object' && 'email' in session.customer ? String(session.customer.email || '') : null);
  if (session.metadata?.kind === 'extra_mission') {
    const extraHt = Number(session.metadata.extraHt || 0);
    const confirmation = await announce(rowId, 'extra', 'extra:' + session.id, {
      invoiceUrl: invoiceUrlFrom(session.invoice as Stripe.Invoice | string | null | undefined),
      email,
      priceHt: extraHt || null,
    });
    return { ok: true, confirmation };
  }
  const customerId = typeof session.customer === 'string' ? session.customer : (session.customer && typeof session.customer === 'object' ? session.customer.id : null);
  const subId = typeof session.subscription === 'string' ? session.subscription : null;
  await markSubscriptionPaid(rowId, { customerId, subscriptionId: subId, checkoutId: session.id });
  const planId = session.metadata?.planId;
  const plan = planId ? planById(planId) : undefined;
  if (plan) {
    await dbRun('UPDATE establishment_subscriptions SET name = ?, price = ? WHERE id = ?', [plan.name, plan.priceHt, rowId]);
  }
  const confirmation = await announce(rowId, 'paid', 'paid:first', {
    invoiceUrl: invoiceUrlFrom(session.invoice as Stripe.Invoice | string | null | undefined),
    email,
  });
  return { ok: true, confirmation };
}

export function subscriptionIsPaid(status: string | null | undefined): boolean {
  const s = String(status || '').toLowerCase();
  return s === 'paid' || s === 'active' || s === 'trialing';
}

export { billingConfirmation };
