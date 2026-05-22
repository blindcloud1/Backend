import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { body, param, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import Stripe from 'stripe';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type {
  CustomPlanConfigDoc,
  PaymentHistoryDoc,
  PaymentStatus,
  SubscriptionPlanDoc,
  SubscriptionStatus,
  UserDoc,
  UserRole,
  UserSubscriptionDoc
} from '@blindscloud/models';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4008', 10);
const JWT_SECRET = process.env.JWT_SECRET || '';
const MONGO_URL = process.env.MONGO_URL || '';
const RABBITMQ_URL = process.env.RABBITMQ_URL || '';
const EVENT_EXCHANGE = process.env.EVENT_EXCHANGE || 'blindscloud.events';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const FRONTEND_URL = process.env.FRONTEND_URL || '';

if (!JWT_SECRET) throw new Error('JWT_SECRET is required');
if (!MONGO_URL) throw new Error('MONGO_URL is required');
if (!RABBITMQ_URL) throw new Error('RABBITMQ_URL is required');

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' }) : null;

type AuthUser = { id: string; email: string; role: UserRole | string };
type AuthRequest = Request & { user?: AuthUser };

const mongo = new MongoClient(MONGO_URL);
const eventBus = new EventBus({
  url: RABBITMQ_URL,
  exchange: EVENT_EXCHANGE,
  serviceName: 'billing-service'
});

const usersCollection = () => mongo.db('blindscloud').collection<UserDoc>('users');
const plansCollection = () => mongo.db('blindscloud').collection<SubscriptionPlanDoc>('subscription_plans');
const subsCollection = () => mongo.db('blindscloud').collection<UserSubscriptionDoc>('user_subscriptions');
const paymentsCollection = () => mongo.db('blindscloud').collection<PaymentHistoryDoc>('payment_history');
const customConfigCollection = () => mongo.db('blindscloud').collection<CustomPlanConfigDoc>('custom_plan_config');
const platformSettingsCollection = () => mongo.db('blindscloud').collection<any>('platform_settings');

const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  const header = req.header('authorization') || req.header('Authorization');
  if (!header) return res.status(401).json({ error: 'Missing Authorization header' });

  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Invalid Authorization header' });

  try {
    const decoded = jwt.verify(match[1], JWT_SECRET) as any;
    req.user = { id: String(decoded.userId), email: String(decoded.email), role: String(decoded.role) };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  const role = req.user?.role?.toLowerCase();
  if (role === 'admin') return next();
  return res.status(403).json({ error: 'Insufficient permissions' });
};

const getCurrentUser = async (req: AuthRequest): Promise<UserDoc | null> => {
  return usersCollection().findOne({ _id: req.user!.id } as any);
};

const toPlanResponse = (p: SubscriptionPlanDoc) => ({
  ...p,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt?.toISOString()
});

const toSubResponse = (s: UserSubscriptionDoc) => ({
  ...s,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt?.toISOString(),
  currentPeriodStart: s.currentPeriodStart.toISOString(),
  currentPeriodEnd: s.currentPeriodEnd.toISOString()
});

const toPaymentResponse = (p: PaymentHistoryDoc) => ({
  ...p,
  paymentDate: p.paymentDate.toISOString(),
  createdAt: p.createdAt.toISOString()
});

const toConfigResponse = (c: CustomPlanConfigDoc) => ({
  ...c,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt?.toISOString()
});

const isValidStatus = (value: any): value is SubscriptionStatus => {
  return ['active', 'cancelled', 'expired', 'trial', 'past_due'].includes(String(value));
};

const isValidPaymentStatus = (value: any): value is PaymentStatus => {
  return ['succeeded', 'failed', 'pending', 'refunded'].includes(String(value));
};

const toNullableNumberOrDefault = (value: any, defaultValue: number | null): number | null => {
  if (value === null) return null;
  if (value === undefined) return defaultValue;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : defaultValue;
};

const app = express();
app.use(
  express.json({
    limit: '2mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    }
  })
);
app.use(helmet());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'billing-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

app.get('/public/terms-and-conditions', async (_req: Request, res: Response) => {
  const doc = await platformSettingsCollection().findOne({ _id: 'subscription_terms' } as any);
  res.json({
    terms: typeof doc?.terms === 'string' ? doc.terms : '',
    updatedAt: doc?.updatedAt?.toISOString?.() || null
  });
});

app.get('/terms-and-conditions', authenticate, async (_req: AuthRequest, res: Response) => {
  const doc = await platformSettingsCollection().findOne({ _id: 'subscription_terms' } as any);
  res.json({
    terms: typeof doc?.terms === 'string' ? doc.terms : '',
    updatedAt: doc?.updatedAt?.toISOString?.() || null
  });
});

app.put(
  '/terms-and-conditions',
  authenticate,
  requireAdmin,
  [body('terms').isString().isLength({ max: 1000 })],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const terms = String((req.body as any)?.terms || '');
    const now = new Date();

    await platformSettingsCollection().updateOne(
      { _id: 'subscription_terms' } as any,
      {
        $set: {
          terms,
          updatedAt: now,
          updatedBy: req.user?.id || null
        },
        $setOnInsert: {
          createdAt: now
        }
      } as any,
      { upsert: true }
    );

    res.json({ terms, updatedAt: now.toISOString() });
  }
);

app.get('/subscription-plans', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.user!.role.toLowerCase();
  const includeInactive = req.query.includeInactive === 'true';
  const filter: any = includeInactive && role === 'admin' ? {} : { active: true };
  const plans = await plansCollection().find(filter).sort({ price: 1 }).toArray();

  const cfg = await customConfigCollection().findOne({} as any);
  const setupFeeEnabled = cfg?.setupFeeEnabled !== false;

  if (role === 'admin') {
    res.json(plans.map(p => ({ ...toPlanResponse(p), setupFeeEnabled })));
    return;
  }

  const hasPaidSetupFeeCount = await subsCollection().countDocuments(
    { userId: req.user!.id, setupFeeCharged: true } as any
  );
  const canChargeSetupFee = hasPaidSetupFeeCount === 0;

  res.json(
    plans.map(p => ({
      ...toPlanResponse(p),
      setupFeeEnabled,
      setupFeeApplies:
        setupFeeEnabled && canChargeSetupFee && Number(toNullableNumberOrDefault(p.setupFee, 0) || 0) > 0
    }))
  );
});

app.post(
  '/subscription-plans',
  authenticate,
  requireAdmin,
  [
    body('name').isLength({ min: 1 }),
    body('price').isNumeric(),
    body('priceOneMonth').optional().isNumeric(),
    body('priceYearly').optional().isNumeric(),
    body('setupFee').optional().isNumeric(),
    body('stripePriceIdYearly').optional().isString()
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const payload = req.body as Partial<SubscriptionPlanDoc>;
    const now = new Date();
    const plan: SubscriptionPlanDoc = {
      _id: crypto.randomUUID(),
      name: String(payload.name || ''),
      description: String(payload.description || ''),
      price: typeof payload.price === 'number' ? payload.price : Number(payload.price),
      priceOneMonth: toNullableNumberOrDefault((payload as any).priceOneMonth, null),
      priceYearly: toNullableNumberOrDefault((payload as any).priceYearly, null),
      setupFee: toNullableNumberOrDefault(payload.setupFee, null),
      features: Array.isArray(payload.features) ? payload.features : [],
      maxEmployees: toNullableNumberOrDefault(payload.maxEmployees, 0),
      maxSubBusinessUsers: toNullableNumberOrDefault(payload.maxSubBusinessUsers, null),
      maxProducts: toNullableNumberOrDefault(payload.maxProducts, null),
      maxEmailsPerMonth: toNullableNumberOrDefault(payload.maxEmailsPerMonth, null),
      maxJobs: toNullableNumberOrDefault(payload.maxJobs, 0),
      stripePriceId: payload.stripePriceId ?? null,
      stripePriceIdYearly: (payload as any).stripePriceIdYearly ?? null,
      active: payload.active ?? true,
      createdAt: now,
      updatedAt: now
    };

    await plansCollection().insertOne(plan as any);

    const event: CloudEvent<{ planId: string; name: string }> = {
      id: crypto.randomUUID(),
      type: 'subscriptionPlans.created',
      version: 1,
      source: 'billing-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { planId: plan._id, name: plan.name }
    };
    await eventBus.publish('subscriptionPlans.created', event);

    res.status(201).json(toPlanResponse(plan));
  }
);

app.put('/subscription-plans/:id', authenticate, requireAdmin, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const planId = req.params.id;
  const existing = await plansCollection().findOne({ _id: planId } as any);
  if (!existing) return res.status(404).json({ error: 'Plan not found' });

  const updates = req.body as Partial<SubscriptionPlanDoc>;
  delete (updates as any)._id;
  delete (updates as any).createdAt;
  if ((updates as any).setupFee !== undefined) {
    updates.setupFee = toNullableNumberOrDefault((updates as any).setupFee, null);
  }
  if ((updates as any).priceOneMonth !== undefined) {
    updates.priceOneMonth = toNullableNumberOrDefault((updates as any).priceOneMonth, null);
  }
  if ((updates as any).priceYearly !== undefined) {
    updates.priceYearly = toNullableNumberOrDefault((updates as any).priceYearly, null);
  }
  updates.updatedAt = new Date();

  const result = await plansCollection().updateOne({ _id: planId } as any, { $set: updates } as any);
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Plan not found' });
  const updated = await plansCollection().findOne({ _id: planId } as any);
  if (!updated) return res.status(404).json({ error: 'Plan not found' });

  const event: CloudEvent<{ planId: string }> = {
    id: crypto.randomUUID(),
    type: 'subscriptionPlans.updated',
    version: 1,
    source: 'billing-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { planId }
  };
  await eventBus.publish('subscriptionPlans.updated', event);

  res.json(toPlanResponse(updated));
});

app.delete('/subscription-plans/:id', authenticate, requireAdmin, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const planId = req.params.id;
  const existing = await plansCollection().findOne({ _id: planId } as any);
  if (!existing) return res.status(404).json({ error: 'Plan not found' });

  await plansCollection().deleteOne({ _id: planId } as any);

  const event: CloudEvent<{ planId: string }> = {
    id: crypto.randomUUID(),
    type: 'subscriptionPlans.deleted',
    version: 1,
    source: 'billing-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { planId }
  };
  await eventBus.publish('subscriptionPlans.deleted', event);

  res.json({ status: 'OK' });
});

const getFrontendBaseUrl = (req: Request): string => {
  if (FRONTEND_URL) return FRONTEND_URL.replace(/\/+$/, '');
  const origin = req.header('origin') || '';
  if (origin) return origin.replace(/\/+$/, '');
  const host = req.header('host') || '';
  if (!host) return '';
  const proto = req.header('x-forwarded-proto') || 'https';
  return `${proto}://${host}`.replace(/\/+$/, '');
};

app.post(
  '/stripe/checkout-session',
  authenticate,
  [body('planId').isLength({ min: 1 }), body('billingCycle').optional().isString()],
  async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  if (!stripe) return res.status(501).json({ error: 'Stripe is not configured' });

  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const { planId, billingCycle } = req.body as { planId: string; billingCycle?: string };
  const normalizedCycle =
    billingCycle === 'one_month' || billingCycle === 'yearly' || billingCycle === 'monthly'
      ? billingCycle
      : 'monthly';
  const plan = await plansCollection().findOne({ _id: String(planId), active: true } as any);
  if (!plan) return res.status(400).json({ error: 'Invalid planId' });
  if (normalizedCycle === 'monthly' && !plan.stripePriceId) {
    return res.status(400).json({ error: 'Plan is missing stripePriceId (monthly)' });
  }
  if (normalizedCycle === 'yearly' && !(plan as any).stripePriceIdYearly) {
    return res.status(400).json({ error: 'Plan is missing stripePriceIdYearly (yearly)' });
  }

  const cfg = await customConfigCollection().findOne({} as any);
  const setupFeeEnabled = cfg?.setupFeeEnabled !== false;
  const hasPaidSetupFeeCount = await subsCollection().countDocuments(
    { userId: req.user!.id, setupFeeCharged: true } as any
  );
  const canChargeSetupFee = hasPaidSetupFeeCount === 0;
  const planSetupFee = Number(toNullableNumberOrDefault((plan as any).setupFee, 0) || 0);
  const shouldChargeSetupFee = setupFeeEnabled && canChargeSetupFee && planSetupFee > 0;

  const existingCustomer = await subsCollection().findOne(
    { userId: req.user!.id, stripeCustomerId: { $exists: true, $ne: null } } as any,
    { sort: { createdAt: -1 } } as any
  );
  const stripeCustomerId =
    typeof existingCustomer?.stripeCustomerId === 'string' && existingCustomer.stripeCustomerId.length > 0
      ? existingCustomer.stripeCustomerId
      : (await stripe.customers.create({ email: currentUser.email, metadata: { userId: currentUser._id } })).id;

  const frontendBase = getFrontendBaseUrl(req);
  const termsUrl = `${frontendBase}/terms-and-conditions`;
  const successUrl = `${frontendBase}/`;
  const cancelUrl = `${frontendBase}/`;

  const commonMetadata = {
    userId: req.user!.id,
    planId: String(planId),
    billingCycle: normalizedCycle,
    setupFeeCharged: shouldChargeSetupFee ? 'true' : 'false',
    setupFeeAmount: shouldChargeSetupFee ? String(planSetupFee) : '0',
    termsUrl
  };

  const session =
    normalizedCycle === 'one_month'
      ? await stripe.checkout.sessions.create({
          customer: stripeCustomerId,
          mode: 'payment',
          line_items: [
            {
              price_data: {
                currency: 'gbp',
                unit_amount: Math.round(
                  Number(
                    toNullableNumberOrDefault((plan as any).priceOneMonth ?? (plan as any).price, 0) || 0
                  ) * 100
                ),
                product_data: { name: `${plan.name} (one-month)` }
              },
              quantity: 1
            },
            ...(shouldChargeSetupFee
              ? [
                  {
                    price_data: {
                      currency: 'gbp',
                      unit_amount: Math.round(planSetupFee * 100),
                      product_data: { name: `${plan.name} setup fee` }
                    },
                    quantity: 1
                  }
                ]
              : [])
          ],
          allow_promotion_codes: true,
          success_url: successUrl,
          cancel_url: cancelUrl,
          metadata: commonMetadata
        })
      : await stripe.checkout.sessions.create({
          customer: stripeCustomerId,
          mode: 'subscription',
          line_items: [
            {
              price: normalizedCycle === 'yearly' ? (plan as any).stripePriceIdYearly : plan.stripePriceId!,
              quantity: 1
            },
            ...(shouldChargeSetupFee
              ? [
                  {
                    price_data: {
                      currency: 'gbp',
                      unit_amount: Math.round(planSetupFee * 100),
                      product_data: { name: `${plan.name} setup fee` }
                    },
                    quantity: 1
                  }
                ]
              : [])
          ],
          allow_promotion_codes: true,
          success_url: successUrl,
          cancel_url: cancelUrl,
          metadata: commonMetadata,
          subscription_data: {
            metadata: {
              userId: req.user!.id,
              planId: String(planId),
              billingCycle: normalizedCycle
            }
          }
        });

  res.json({ url: session.url });
  }
);

app.post('/stripe/webhook', async (req: any, res: Response) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send('Stripe webhook not configured');
  }

  const sig = req.header('stripe-signature');
  if (!sig) return res.status(400).send('Missing stripe-signature');

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    return res.status(400).send(`Webhook Error: ${err?.message || String(err)}`);
  }

  if (event.type !== 'checkout.session.completed') {
    return res.json({ received: true });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const userId = String((session.metadata || {}).userId || '');
  const planId = String((session.metadata || {}).planId || '');
  const billingCycleRaw = String((session.metadata || {}).billingCycle || '');
  const billingCycle =
    billingCycleRaw === 'one_month' || billingCycleRaw === 'yearly' || billingCycleRaw === 'monthly'
      ? billingCycleRaw
      : 'monthly';
  const setupFeeCharged = String((session.metadata || {}).setupFeeCharged || '').toLowerCase() === 'true';
  const setupFeeAmount = Number((session.metadata || {}).setupFeeAmount || 0) || 0;
  const termsUrl = String((session.metadata || {}).termsUrl || '');

  if (!userId || !planId) return res.json({ received: true });

  const stripePaymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null;
  if (stripePaymentIntentId) {
    const existingPayment = await paymentsCollection().findOne({ stripePaymentIntentId } as any);
    if (existingPayment) return res.json({ received: true });
  }
  const stripeSubscriptionId = typeof session.subscription === 'string' ? session.subscription : null;
  if (stripeSubscriptionId) {
    const existing = await subsCollection().findOne({ stripeSubscriptionId } as any);
    if (existing) return res.json({ received: true });
  }

  const plan = await plansCollection().findOne({ _id: planId } as any);
  const user = await usersCollection().findOne({ _id: userId } as any);
  if (!plan || !user) return res.json({ received: true });

  const nowMs = Date.now();
  const activeStatuses: SubscriptionStatus[] = ['active', 'trial', 'past_due'];
  const activeSubs = await subsCollection()
    .find({ userId, status: { $in: activeStatuses } } as any)
    .sort({ currentPeriodEnd: -1 } as any)
    .toArray();

  const currentActive = activeSubs[0] || null;
  const currentActiveEndMs = currentActive?.currentPeriodEnd?.getTime?.() ?? NaN;
  const remainingMs =
    currentActive && Number.isFinite(currentActiveEndMs) && currentActiveEndMs > nowMs ? currentActiveEndMs - nowMs : 0;

  if (activeSubs.length > 0) {
    await subsCollection().updateMany(
      { userId, status: { $in: activeStatuses } } as any,
      { $set: { status: 'cancelled', cancelAtPeriodEnd: false, currentPeriodEnd: new Date(), updatedAt: new Date() } } as any
    );
  }

  const stripeSub = stripeSubscriptionId ? await stripe.subscriptions.retrieve(stripeSubscriptionId) : null;
  const stripeStartMs =
    stripeSub?.current_period_start ? stripeSub.current_period_start * 1000 : nowMs;
  const stripeEndMs =
    stripeSub?.current_period_end ? stripeSub.current_period_end * 1000 : nowMs;

  const startDate = new Date(stripeStartMs);
  const endDate =
    billingCycle === 'one_month' && !stripeSub
      ? (() => {
          const d = new Date(startDate);
          d.setMonth(d.getMonth() + 1);
          if (remainingMs > 0) d.setTime(d.getTime() + remainingMs);
          return d;
        })()
      : new Date(stripeEndMs + remainingMs);

  const mappedStatus: SubscriptionStatus = stripeSub?.status === 'trialing'
    ? 'trial'
    : stripeSub?.status === 'past_due'
    ? 'past_due'
    : stripeSub?.status === 'active'
    ? 'active'
    : 'active';

  const now = new Date();
  const subscription: UserSubscriptionDoc = {
    _id: crypto.randomUUID(),
    userId,
    planId,
    status: mappedStatus,
    stripeCustomerId: stripeSub && typeof stripeSub.customer === 'string' ? stripeSub.customer : undefined,
    stripeSubscriptionId: stripeSub?.id,
    currentPeriodStart: startDate,
    currentPeriodEnd: endDate,
    cancelAtPeriodEnd: false,
    grantedByAdmin: false,
    grantedBy: undefined,
    setupFeeCharged,
    setupFeeAmount,
    billingCycle,
    createdAt: now,
    updatedAt: now
  };

  await subsCollection().insertOne(subscription as any);

  const amountTotal = typeof session.amount_total === 'number' ? session.amount_total : null;
  const currency = typeof session.currency === 'string' ? session.currency.toUpperCase() : 'GBP';
  if (amountTotal !== null) {
    const payment: PaymentHistoryDoc = {
      _id: crypto.randomUUID(),
      userId,
      subscriptionId: subscription._id,
      amount: amountTotal / 100,
      currency,
      stripePaymentIntentId: stripePaymentIntentId || undefined,
      stripeInvoiceId: undefined,
      status: 'succeeded',
      paymentDate: new Date(),
      createdAt: new Date()
    };
    await paymentsCollection().insertOne(payment as any);
  }

  const frontendBase = getFrontendBaseUrl(req);
  const finalTermsUrl = termsUrl || `${frontendBase}/terms-and-conditions`;
  const pickNumber = (value: any): number => (typeof value === 'number' ? value : Number(value || 0) || 0);
  const planPrice =
    billingCycle === 'one_month'
      ? pickNumber((plan as any).priceOneMonth ?? (plan as any).price)
      : billingCycle === 'yearly'
      ? pickNumber((plan as any).priceYearly ?? (plan as any).price)
      : pickNumber((plan as any).price);

  const emailEvent: CloudEvent<{
    userId: string;
    planId: string;
    planName: string;
    planDescription?: string;
    planFeatures?: string[];
    planPrice: number;
    billingCycle: 'one_month' | 'monthly' | 'yearly';
    setupFeeAmount: number;
    setupFeeCharged: boolean;
    amountPaid?: number;
    currency?: string;
    periodStart: string;
    periodEnd: string;
    termsUrl: string;
  }> = {
    id: crypto.randomUUID(),
    type: 'subscriptions.paid',
    version: 1,
    source: 'billing-service',
    occurredAt: new Date().toISOString(),
    payload: {
      userId,
      planId,
      planName: String((plan as any).name || ''),
      planDescription: String((plan as any).description || ''),
      planFeatures: Array.isArray((plan as any).features) ? (plan as any).features.map((f: any) => String(f)) : [],
      planPrice,
      billingCycle,
      setupFeeAmount,
      setupFeeCharged,
      amountPaid: amountTotal !== null ? amountTotal / 100 : undefined,
      currency,
      periodStart: startDate.toISOString(),
      periodEnd: endDate.toISOString(),
      termsUrl: finalTermsUrl
    }
  };
  await eventBus.publish('subscriptions.paid', emailEvent);

  return res.json({ received: true });
});

app.get('/subscriptions/me', authenticate, async (req: AuthRequest, res: Response) => {
  const sub = await subsCollection().findOne({ userId: req.user!.id } as any, { sort: { currentPeriodEnd: -1 } } as any);
  if (!sub) return res.json(null);

  const now = Date.now();
  const endMs = sub.currentPeriodEnd?.getTime?.() ?? Date.parse(String((sub as any).currentPeriodEnd || ''));
  const shouldExpire = sub.status === 'active' && Number.isFinite(endMs) && endMs < now;

  if (shouldExpire) {
    await subsCollection().updateOne(
      { _id: sub._id } as any,
      { $set: { status: 'expired', updatedAt: new Date() } } as any
    );
    const updated = await subsCollection().findOne({ _id: sub._id } as any);
    if (updated) return res.json(toSubResponse(updated));
  }

  res.json(toSubResponse(sub));
});

app.get('/subscriptions', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const filter: any = {};
  if (typeof req.query.userId === 'string') filter.userId = req.query.userId;
  if (typeof req.query.status === 'string' && isValidStatus(req.query.status)) filter.status = req.query.status;
  const subs = await subsCollection().find(filter).sort({ createdAt: -1 }).toArray();
  res.json(subs.map(toSubResponse));
});

app.post(
  '/subscriptions/grant',
  authenticate,
  requireAdmin,
  [body('userId').isLength({ min: 1 }), body('planId').isLength({ min: 1 }), body('durationMonths').optional().isInt({ min: 1 })],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { userId, planId, durationMonths } = req.body as { userId: string; planId: string; durationMonths?: number };

    const targetUser = await usersCollection().findOne({ _id: String(userId) } as any);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const plan = await plansCollection().findOne({ _id: String(planId) } as any);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const monthsRaw = typeof durationMonths === 'number' ? durationMonths : Number(durationMonths);
    const months = Number.isFinite(monthsRaw) && monthsRaw > 0 ? Math.floor(monthsRaw) : 1;

    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + months);

    const existingSub = await subsCollection().findOne(
      { userId: String(userId) } as any,
      { sort: { currentPeriodEnd: -1 } } as any
    );

    const existingEndMs = existingSub?.currentPeriodEnd?.getTime?.() ?? NaN;
    const remainingMs =
      existingSub && existingSub.status === 'active' && Number.isFinite(existingEndMs) && existingEndMs > now.getTime()
        ? existingEndMs - now.getTime()
        : 0;
    if (remainingMs > 0) {
      end.setTime(end.getTime() + remainingMs);
    }

    const subscription: UserSubscriptionDoc = existingSub
      ? {
          ...existingSub,
          planId: String(planId),
          status: 'active',
          currentPeriodStart: now,
          currentPeriodEnd: end,
          cancelAtPeriodEnd: false,
          grantedByAdmin: true,
          grantedBy: req.user!.id,
          setupFeeCharged: false,
          setupFeeAmount: 0,
          updatedAt: now
        }
      : {
          _id: crypto.randomUUID(),
          userId: String(userId),
          planId: String(planId),
          status: 'active',
          stripeCustomerId: undefined,
          stripeSubscriptionId: undefined,
          currentPeriodStart: now,
          currentPeriodEnd: end,
          cancelAtPeriodEnd: false,
          grantedByAdmin: true,
          grantedBy: req.user!.id,
          setupFeeCharged: false,
          setupFeeAmount: 0,
          createdAt: now,
          updatedAt: now
        };

    if (existingSub) {
      await subsCollection().updateOne({ _id: existingSub._id } as any, { $set: subscription } as any);
    } else {
      await subsCollection().insertOne(subscription as any);
    }

    const event: CloudEvent<{ subscriptionId: string; userId: string; planId: string; grantedBy: string }> = {
      id: crypto.randomUUID(),
      type: 'subscriptions.granted',
      version: 1,
      source: 'billing-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { subscriptionId: subscription._id, userId: subscription.userId, planId: subscription.planId, grantedBy: req.user!.id }
    };
    await eventBus.publish('subscriptions.granted', event);

    res.status(201).json(toSubResponse(subscription));
  }
);

app.post(
  '/subscriptions/me',
  authenticate,
  [body('planId').isLength({ min: 1 })],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const currentUser = await getCurrentUser(req);
    if (!currentUser) return res.status(401).json({ error: 'User not found' });

    const { planId } = req.body as { planId: string };
    const plan = await plansCollection().findOne({ _id: planId, active: true } as any);
    if (!plan) return res.status(400).json({ error: 'Invalid planId' });

    const cfg = await customConfigCollection().findOne({} as any);
    const setupFeeEnabled = cfg?.setupFeeEnabled !== false;

    const hasPaidSetupFeeCount = await subsCollection().countDocuments(
      { userId: req.user!.id, setupFeeCharged: true } as any
    );
    const canChargeSetupFee = hasPaidSetupFeeCount === 0;
    const planSetupFee = Number(toNullableNumberOrDefault(plan.setupFee, 0) || 0);
    const shouldChargeSetupFee = setupFeeEnabled && canChargeSetupFee && planSetupFee > 0;

    const now = new Date();
    const activeStatuses: SubscriptionStatus[] = ['active', 'trial', 'past_due'];
    const activeSubs = await subsCollection()
      .find({ userId: req.user!.id, status: { $in: activeStatuses } } as any)
      .sort({ currentPeriodEnd: -1 } as any)
      .toArray();

    const currentActive = activeSubs[0] || null;
    const currentActiveEndMs = currentActive?.currentPeriodEnd?.getTime?.() ?? NaN;
    const remainingMs =
      currentActive && Number.isFinite(currentActiveEndMs) && currentActiveEndMs > now.getTime()
        ? currentActiveEndMs - now.getTime()
        : 0;

    if (activeSubs.length > 0) {
      await subsCollection().updateMany(
        { userId: req.user!.id, status: { $in: activeStatuses } } as any,
        { $set: { status: 'cancelled', cancelAtPeriodEnd: false, currentPeriodEnd: now, updatedAt: now } } as any
      );
    }

    const end = new Date(now);
    end.setMonth(end.getMonth() + 1);
    if (remainingMs > 0) {
      end.setTime(end.getTime() + remainingMs);
    }

    const subscription: UserSubscriptionDoc = {
      _id: crypto.randomUUID(),
      userId: req.user!.id,
      planId,
      status: 'active',
      stripeCustomerId: undefined,
      stripeSubscriptionId: undefined,
      currentPeriodStart: now,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: false,
      grantedByAdmin: false,
      grantedBy: undefined,
      setupFeeCharged: shouldChargeSetupFee,
      setupFeeAmount: shouldChargeSetupFee ? planSetupFee : 0,
      createdAt: now,
      updatedAt: now
    };

    await subsCollection().insertOne(subscription as any);

    const event: CloudEvent<{ subscriptionId: string; userId: string; planId: string }> = {
      id: crypto.randomUUID(),
      type: 'subscriptions.created',
      version: 1,
      source: 'billing-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { subscriptionId: subscription._id, userId: subscription.userId, planId: subscription.planId }
    };
    await eventBus.publish('subscriptions.created', event);

    res.status(201).json(toSubResponse(subscription));
  }
);

app.post('/subscriptions/:id/cancel', authenticate, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const role = req.user!.role.toLowerCase();
  const id = req.params.id;
  const existing = await subsCollection().findOne({ _id: id } as any);
  if (!existing) return res.status(404).json({ error: 'Subscription not found' });
  if (role !== 'admin' && existing.userId !== req.user!.id) return res.status(403).json({ error: 'Insufficient permissions' });

  const now = new Date();
  const updates: Partial<UserSubscriptionDoc> =
    role === 'admin'
      ? { status: 'cancelled', cancelAtPeriodEnd: false, currentPeriodEnd: now, updatedAt: now }
      : { cancelAtPeriodEnd: true, updatedAt: now };
  const result = await subsCollection().updateOne({ _id: id } as any, { $set: updates } as any);
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Subscription not found' });
  const updated = await subsCollection().findOne({ _id: id } as any);
  if (!updated) return res.status(404).json({ error: 'Subscription not found' });

  const event: CloudEvent<{ subscriptionId: string; userId: string }> = {
    id: crypto.randomUUID(),
    type: 'subscriptions.cancelRequested',
    version: 1,
    source: 'billing-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { subscriptionId: id, userId: updated.userId }
  };
  await eventBus.publish('subscriptions.cancelRequested', event);

  res.json(toSubResponse(updated));
});

app.get('/payments/me', authenticate, async (req: AuthRequest, res: Response) => {
  const payments = await paymentsCollection().find({ userId: req.user!.id } as any).sort({ paymentDate: -1 }).toArray();
  res.json(payments.map(toPaymentResponse));
});

app.get('/payments', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const filter: any = {};
  if (typeof req.query.userId === 'string') filter.userId = req.query.userId;
  if (typeof req.query.status === 'string' && isValidPaymentStatus(req.query.status)) filter.status = req.query.status;
  const payments = await paymentsCollection().find(filter).sort({ paymentDate: -1 }).toArray();
  res.json(payments.map(toPaymentResponse));
});

app.post(
  '/payments',
  authenticate,
  requireAdmin,
  [body('userId').isLength({ min: 1 }), body('amount').isNumeric(), body('status').isString()],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const payload = req.body as Partial<PaymentHistoryDoc> & { status: PaymentStatus };
    if (!isValidPaymentStatus(payload.status)) return res.status(400).json({ error: 'Invalid status' });

    const now = new Date();
    const payment: PaymentHistoryDoc = {
      _id: crypto.randomUUID(),
      userId: String(payload.userId || ''),
      subscriptionId: payload.subscriptionId,
      amount: typeof payload.amount === 'number' ? payload.amount : Number(payload.amount),
      currency: String(payload.currency || 'USD'),
      stripePaymentIntentId: payload.stripePaymentIntentId,
      stripeInvoiceId: payload.stripeInvoiceId,
      status: payload.status,
      paymentDate: payload.paymentDate instanceof Date ? payload.paymentDate : now,
      createdAt: now
    };

    await paymentsCollection().insertOne(payment as any);

    const event: CloudEvent<{ paymentId: string; userId: string; status: PaymentStatus }> = {
      id: crypto.randomUUID(),
      type: 'payments.created',
      version: 1,
      source: 'billing-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { paymentId: payment._id, userId: payment.userId, status: payment.status }
    };
    await eventBus.publish('payments.created', event);

    res.status(201).json(toPaymentResponse(payment));
  }
);

app.get('/custom-plan-config', authenticate, async (_req: AuthRequest, res: Response) => {
  const config = await customConfigCollection().findOne({} as any);
  if (!config) return res.json(null);
  res.json(toConfigResponse(config));
});

app.put(
  '/custom-plan-config',
  authenticate,
  requireAdmin,
  [
    body('jobPrice').optional().isNumeric(),
    body('productPrice').optional().isNumeric(),
    body('emailPrice').optional().isNumeric(),
    body('userPrice').optional().isNumeric(),
    body('storagePrice').optional().isNumeric(),
    body('bannerDaysBeforeExpiry').optional().isInt({ min: 0 }),
    body('setupFeeEnabled').optional().isBoolean()
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const payload = req.body as Partial<CustomPlanConfigDoc>;
    const now = new Date();
    const existing = await customConfigCollection().findOne({} as any);

    const base: CustomPlanConfigDoc = existing
      ? { ...existing, ...payload, setupFeeEnabled: payload.setupFeeEnabled ?? existing.setupFeeEnabled ?? true, updatedAt: now }
      : {
          _id: crypto.randomUUID(),
          jobPrice: typeof payload.jobPrice === 'number' ? payload.jobPrice : 0,
          productPrice: typeof payload.productPrice === 'number' ? payload.productPrice : 0,
          emailPrice: typeof payload.emailPrice === 'number' ? payload.emailPrice : 0,
          userPrice: typeof payload.userPrice === 'number' ? payload.userPrice : 0,
          storagePrice: typeof payload.storagePrice === 'number' ? payload.storagePrice : 0,
          bannerDaysBeforeExpiry:
            typeof payload.bannerDaysBeforeExpiry === 'number' ? payload.bannerDaysBeforeExpiry : null,
          setupFeeEnabled: payload.setupFeeEnabled ?? true,
          createdAt: now,
          updatedAt: now
        };

    await customConfigCollection().updateOne({ _id: base._id } as any, { $set: base } as any, { upsert: true });

    const event: CloudEvent<{ configId: string }> = {
      id: crypto.randomUUID(),
      type: 'customPlanConfig.updated',
      version: 1,
      source: 'billing-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { configId: base._id }
    };
    await eventBus.publish('customPlanConfig.updated', event);

    res.json(toConfigResponse(base));
  }
);

app.listen(PORT, '0.0.0.0', async () => {
  await mongo.connect();
  await eventBus.connect();
});
