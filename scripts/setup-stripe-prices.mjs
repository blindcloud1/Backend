#!/usr/bin/env node
/**
 * setup-stripe-prices.mjs
 * -----------------------------------------------------------------------------
 * Creates the Stripe Products + Prices for the Basic / Standard / Premium plans
 * and wires the resulting Price IDs into the BlindsCloud subscription plans.
 *
 * WHY THIS EXISTS
 *   The BlindsCloud backend needs a Stripe Price ID for the `monthly` and
 *   `yearly` billing cycles:
 *     monthly -> plan.stripePriceId        -> billing-service:374
 *     yearly  -> plan.stripePriceIdYearly  -> billing-service:377
 *   The `one_month` cycle does NOT need one (it is built inline with
 *   `price_data`, billing-service:413-448).
 *
 *   Without these IDs the backend rejects checkout with HTTP 400:
 *     "Plan is missing stripePriceId (monthly)"
 *     "Plan is missing stripePriceIdYearly (yearly)"
 *
 * USAGE
 *   From the Backend/Backend folder:
 *
 *     $env:STRIPE_SECRET_KEY = "sk_test_..."     # or put it in .env
 *     $env:ADMIN_TOKEN       = "<admin JWT>"      # login as admin first
 *     node scripts/setup-stripe-prices.mjs
 *
 *   Optional env vars:
 *     API_URL              default http://localhost:3001  (the api-gateway)
 *     PLAN_BASIC_MONTHLY   default 19
 *     PLAN_BASIC_YEARLY    default 190
 *     PLAN_STANDARD_MONTHLY default 49
 *     PLAN_STANDARD_YEARLY  default 490
 *     PLAN_PREMIUM_MONTHLY  default 199
 *     PLAN_PREMIUM_YEARLY   default 1990
 *
 *   ADMIN_TOKEN:
 *     curl -sS -X POST http://localhost:3001/api/auth/login \
 *       -H 'Content-Type: application/json' \
 *       -d '{"email":"admin@blindscloud.co.uk","password":"password"}'
 *     -> copy the .token value
 *
 * NOTES
 *   - Run this against a TEST-mode key first. The live BlindsCloud VPS is
 *     currently on test keys (its checkout sessions start with `cs_test_`),
 *     so test Price IDs will work there. When you switch to live keys you
 *     must re-run this script with the live key; the Price IDs differ.
 *   - `lookup_key` can only be set at creation time. Re-running the script
 *     will fail on duplicate lookup_key, which is intentional (it stops you
 *     creating duplicate prices by accident).
 *   - Yearly = 10 x monthly (2 months free), matching the existing intent in
 *     the live plans (price 30 -> priceYearly 300, price 50 -> priceYearly 500).
 *   - Quotas: `null` means UNLIMITED. `0` means BLOCK EVERYTHING
 *     (jobs-service:170 returns null for unlimited; the billing service
 *     defaults a missing value to 0 - billing-service:251,255).
 * =============================================================================
 */

import Stripe from 'stripe';
import 'dotenv/config';

const API = (process.env.API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

if (!STRIPE_KEY) {
  console.error('ERROR: STRIPE_SECRET_KEY is not set.');
  process.exit(1);
}
if (!ADMIN_TOKEN) {
  console.error('ERROR: ADMIN_TOKEN is not set. See the header of this file for how to get one.');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_KEY, { apiVersion: '2024-06-20' });

// ---------------------------------------------------------------------------
// The plan ladder.
// ---------------------------------------------------------------------------
const PLANS = [
  {
    name: 'Basic',
    // matchExisting: names currently in the database that should be renamed
    matchExisting: ['Basic'],
    description: 'For small teams starting with BlindsCloud',
    monthly: Number(process.env.PLAN_BASIC_MONTHLY || 19),
    yearly: Number(process.env.PLAN_BASIC_YEARLY || 190),
    maxEmployees: 5,
    maxSubBusinessUsers: 1,
    maxProducts: 50,
    maxEmailsPerMonth: 500,
    maxJobs: 20,
    features: [
      'Core job posting tools',
      'Email notifications',
      'Basic reporting',
      'Card and bank transfer payments',
      'Email history access',
    ],
  },
  {
    name: 'Standard',
    matchExisting: ['Pro', 'Professional', 'Standard'],
    description: 'For growing businesses that need more control',
    monthly: Number(process.env.PLAN_STANDARD_MONTHLY || 49),
    yearly: Number(process.env.PLAN_STANDARD_YEARLY || 490),
    maxEmployees: 25,
    maxSubBusinessUsers: 5,
    maxProducts: 500,
    maxEmailsPerMonth: 5000,
    maxJobs: 100,
    features: [
      'Everything in Basic',
      'Advanced analytics',
      'Priority support',
      'Advanced payment options',
      'Full email history',
    ],
  },
  {
    name: 'Premium',
    matchExisting: ['Enterprises', 'Enterprise', 'Enterprise Plus', 'Premium'],
    description: 'For large organizations with advanced needs',
    monthly: Number(process.env.PLAN_PREMIUM_MONTHLY || 199),
    yearly: Number(process.env.PLAN_PREMIUM_YEARLY || 1990),
    maxEmployees: null, // null = unlimited
    maxSubBusinessUsers: null,
    maxProducts: null,
    maxEmailsPerMonth: null,
    maxJobs: null,
    features: [
      'Everything in Standard',
      'Dedicated success manager',
      'Custom onboarding and training',
      'Enterprise payment controls',
      'Enterprise email tracking',
    ],
  },
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function api(path, opts = {}) {
  const res = await fetch(`${API}/api/billing${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

function assertSameCurrency() {
  // Stripe prices carry their own currency; the BlindsCloud backend hardcodes
  // 'gbp' for the inline one_month path (billing-service:422) so keep it GBP.
  return 'gbp';
}

// ---------------------------------------------------------------------------
// 1. Create the Stripe Products + Prices
// ---------------------------------------------------------------------------
const created = [];

for (const plan of PLANS) {
  const slug = plan.name.toLowerCase();

  const product = await stripe.products.create({
    name: `BlindsCloud ${plan.name}`,
    description: plan.description,
    metadata: { plan: plan.name },
  });

  const monthly = await stripe.prices.create({
    product: product.id,
    currency: assertSameCurrency(),
    unit_amount: Math.round(plan.monthly * 100),
    recurring: { interval: 'month' },
    lookup_key: `blindscloud_${slug}_monthly`,
  });

  const yearly = await stripe.prices.create({
    product: product.id,
    currency: assertSameCurrency(),
    unit_amount: Math.round(plan.yearly * 100),
    recurring: { interval: 'year' },
    lookup_key: `blindscloud_${slug}_yearly`,
  });

  created.push({ ...plan, productId: product.id, monthlyPriceId: monthly.id, yearlyPriceId: yearly.id });

  console.log(`[stripe] ${plan.name}`);
  console.log(`         product : ${product.id}`);
  console.log(`         monthly : ${monthly.id}   (GBP ${plan.monthly} / month)`);
  console.log(`         yearly  : ${yearly.id}   (GBP ${plan.yearly} / year)`);
}

// ---------------------------------------------------------------------------
// 2. Wire the Price IDs + prices + quotas into the BlindsCloud plans
// ---------------------------------------------------------------------------
const existing = await api('/subscription-plans');
console.log(`\n[blindscloud] found ${existing.length} existing plan(s)`);

for (const c of created) {
  const plan = existing.find((p) =>
    (c.matchExisting || [c.name]).some(
      (n) => String(p.name || '').trim().toLowerCase() === String(n).trim().toLowerCase()
    )
  );

  const payload = {
    name: c.name,
    description: c.description,
    price: c.monthly,                 // monthly display price
    priceOneMonth: c.monthly,         // one-off 30-day price (no Stripe ID needed)
    priceYearly: c.yearly,            // yearly display price
    setupFee: null,
    stripePriceId: c.monthlyPriceId,      // -> monthly cycle
    stripePriceIdYearly: c.yearlyPriceId,  // -> yearly cycle
    maxEmployees: c.maxEmployees,
    maxSubBusinessUsers: c.maxSubBusinessUsers,
    maxProducts: c.maxProducts,
    maxEmailsPerMonth: c.maxEmailsPerMonth,
    maxJobs: c.maxJobs,
    features: c.features,
    active: true,
  };

  if (plan) {
    const id = plan._id || plan.id;
    await api(`/subscription-plans/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    console.log(`[blindscloud] updated "${plan.name}" -> "${c.name}"  (${id})`);
  } else {
    const made = await api('/subscription-plans', { method: 'POST', body: JSON.stringify(payload) });
    console.log(`[blindscloud] created "${c.name}"  (${made._id || made.id})`);
  }
}

// ---------------------------------------------------------------------------
// 3. Summary
// ---------------------------------------------------------------------------
console.log('\n================ PASTE-BACK TABLE ================');
console.log('Plan      | Stripe Monthly Price ID     | Stripe Yearly Price ID');
console.log('----------|-----------------------------|----------------------------');
for (const c of created) {
  console.log(`${c.name.padEnd(10)}| ${c.monthlyPriceId.padEnd(27)} | ${c.yearlyPriceId}`);
}
console.log('==================================================\n');
console.log('Paste them in: Admin -> Subscriptions -> Edit plan ->');
console.log('"Stripe Integration (Advanced)" ->');
console.log('  Stripe Monthly Price ID  <- monthly ID');
console.log('  Stripe Yearly Price ID   <- yearly ID');
