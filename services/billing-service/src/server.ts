import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { body, param, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
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

if (!JWT_SECRET) throw new Error('JWT_SECRET is required');
if (!MONGO_URL) throw new Error('MONGO_URL is required');
if (!RABBITMQ_URL) throw new Error('RABBITMQ_URL is required');

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
app.use(express.json({ limit: '2mb' }));
app.use(helmet());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'billing-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

app.get('/subscription-plans', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.user!.role.toLowerCase();
  const includeInactive = req.query.includeInactive === 'true';
  const filter: any = includeInactive && role === 'admin' ? {} : { active: true };
  const plans = await plansCollection().find(filter).sort({ price: 1 }).toArray();
  res.json(plans.map(toPlanResponse));
});

app.post(
  '/subscription-plans',
  authenticate,
  requireAdmin,
  [body('name').isLength({ min: 1 }), body('price').isNumeric()],
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
      features: Array.isArray(payload.features) ? payload.features : [],
      maxEmployees: toNullableNumberOrDefault(payload.maxEmployees, 0),
      maxSubBusinessUsers: toNullableNumberOrDefault(payload.maxSubBusinessUsers, null),
      maxProducts: toNullableNumberOrDefault(payload.maxProducts, null),
      maxEmailsPerMonth: toNullableNumberOrDefault(payload.maxEmailsPerMonth, null),
      maxJobs: toNullableNumberOrDefault(payload.maxJobs, 0),
      stripePriceId: payload.stripePriceId ?? null,
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

app.get('/subscriptions/me', authenticate, async (req: AuthRequest, res: Response) => {
  const sub = await subsCollection().findOne({ userId: req.user!.id } as any, { sort: { currentPeriodEnd: -1 } } as any);
  if (!sub) return res.json(null);
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

    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + 1);

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

  const updates: Partial<UserSubscriptionDoc> = { cancelAtPeriodEnd: true, updatedAt: new Date() };
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

app.get('/custom-plan-config', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
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
    body('bannerDaysBeforeExpiry').optional().isInt({ min: 0 })
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const payload = req.body as Partial<CustomPlanConfigDoc>;
    const now = new Date();
    const existing = await customConfigCollection().findOne({} as any);

    const base: CustomPlanConfigDoc = existing
      ? { ...existing, ...payload, updatedAt: now }
      : {
          _id: crypto.randomUUID(),
          jobPrice: typeof payload.jobPrice === 'number' ? payload.jobPrice : 0,
          productPrice: typeof payload.productPrice === 'number' ? payload.productPrice : 0,
          emailPrice: typeof payload.emailPrice === 'number' ? payload.emailPrice : 0,
          userPrice: typeof payload.userPrice === 'number' ? payload.userPrice : 0,
          storagePrice: typeof payload.storagePrice === 'number' ? payload.storagePrice : 0,
          bannerDaysBeforeExpiry:
            typeof payload.bannerDaysBeforeExpiry === 'number' ? payload.bannerDaysBeforeExpiry : null,
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
