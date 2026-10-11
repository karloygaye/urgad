/**
 * Only place that reads STRIPE_SECRET_KEY, and the only place a payment
 * provider would be called later. This function does not charge a card and
 * does not call Stripe or any other provider.
 * When the key is missing, the subscription stays pending and unpaid.
 */
export function prepareSubscriptionPayment(plan: { name: string; price: number; establishmentId: number }): {
  status: 'pending';
  charged: false;
  paid: false;
  providerCalled: false;
  reason: 'missing_key' | 'provider_not_wired';
} {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) {
    return { status: 'pending', charged: false, paid: false, providerCalled: false, reason: 'missing_key' };
  }
  // A real provider call would use `key` and `plan` only inside this block.
  // It is not wired: do not charge, and do not mark the plan paid.
  void plan;
  return { status: 'pending', charged: false, paid: false, providerCalled: false, reason: 'provider_not_wired' };
}
