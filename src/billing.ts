import Stripe from 'stripe';
import { dbGet, dbRun } from './db.js';
import { type Plan, planById } from './plans.js';

let client: Stripe | null | undefined;

export function stripeEnabled(): boolean {
  return !!(process.env.STRIPE_SECRET_KEY || '').trim();
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
  return 'https://urgad-api.onrender.com';
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
}): Promise<{ url: string | null; reason: 'missing_key' | 'ok'; checkoutId?: string; customerId?: string }> {
  const stripe = getStripe();
  if (!stripe) return { url: null, reason: 'missing_key' };
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

export async function applyStripeEvent(event: Stripe.Event): Promise<void> {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const rowId = Number(session.metadata?.rowId || 0);
    const customerId = typeof session.customer === 'string' ? session.customer : null;
    const subId = typeof session.subscription === 'string' ? session.subscription : null;
    if (rowId) await markSubscriptionPaid(rowId, { customerId, subscriptionId: subId, checkoutId: session.id });
    return;
  }
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as Stripe.Subscription;
    const rowId = Number(sub.metadata?.rowId || 0);
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
    if (rowId) {
      await dbRun('UPDATE establishment_subscriptions SET status = ?, stripe_subscription_id = ? WHERE id = ?', [status, sub.id, rowId]);
      return;
    }
    const row = await dbGet<{ id: number }>('SELECT id FROM establishment_subscriptions WHERE stripe_subscription_id = ?', [sub.id]);
    if (row?.id) await dbRun('UPDATE establishment_subscriptions SET status = ? WHERE id = ?', [status, row.id]);
  }
}

export async function confirmCheckoutSession(sessionId: string, establishmentId: number): Promise<boolean> {
  const stripe = getStripe();
  if (!stripe || !sessionId) return false;
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const rowId = Number(session.metadata?.rowId || 0);
  const metaEst = Number(session.metadata?.establishmentId || 0);
  if (metaEst && metaEst !== establishmentId) return false;
  const paid = session.status === 'complete' || session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  if (!paid || !rowId) return false;
  const customerId = typeof session.customer === 'string' ? session.customer : null;
  const subId = typeof session.subscription === 'string' ? session.subscription : null;
  await markSubscriptionPaid(rowId, { customerId, subscriptionId: subId, checkoutId: session.id });
  const planId = session.metadata?.planId;
  const plan = planId ? planById(planId) : undefined;
  if (plan) {
    await dbRun('UPDATE establishment_subscriptions SET name = ?, price = ? WHERE id = ?', [plan.name, plan.priceHt, rowId]);
  }
  return true;
}

export function subscriptionIsPaid(status: string | null | undefined): boolean {
  const s = String(status || '').toLowerCase();
  return s === 'paid' || s === 'active' || s === 'trialing';
}
