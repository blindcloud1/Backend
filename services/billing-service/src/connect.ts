import crypto from 'crypto';
import express, { NextFunction, Request, Response, Router } from 'express';
import { body, validationResult } from 'express-validator';
import type { MongoClient } from 'mongodb';
import type Stripe from 'stripe';
import type {
  ConnectPaymentStage,
  FinanceSettingsDoc,
  JobPaymentDoc,
  UserDoc
} from '@blindscloud/models';

/**
 * Stripe Connect job-payment ledger.
 *
 * This router is intentionally separate from the subscription billing routes in
 * server.ts. It reuses the billing service's Mongo connection, JWT middleware
 * and Stripe client, but never touches subscription plans/checkout/webhooks.
 *
 * Webhooks will be added later. Until then, POST /connect/sync reconciles the
 * ledger with Stripe on demand, so both the business Earnings page and the
 * admin Finance page show real data without needing a webhook or a cron worker.
 */

type AuthFn = (req: any, res: Response, next: NextFunction) => void;

interface ConnectRouterDeps {
  mongo: MongoClient;
  stripe: Stripe | null;
  authenticate: AuthFn;
  requireAdmin: AuthFn;
  frontendUrl: string;
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const HOLD_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SETTINGS = {
  commissionPercent: 5,
  commissionFixedPence: 0,
  holdDays: 7,
  currency: 'gbp'
};

const db = (mongo: MongoClient) => mongo.db('blindscloud');
const accountsCol = (mongo: MongoClient) => db(mongo).collection<any>('connect_accounts');
const paymentsCol = (mongo: MongoClient) => db(mongo).collection<any>('job_payments');
const payoutsCol = (mongo: MongoClient) => db(mongo).collection<any>('connect_payouts');
const settingsCol = (mongo: MongoClient) => db(mongo).collection<any>('finance_settings');
const usersCol = (mongo: MongoClient) => db(mongo).collection<UserDoc>('users');
const businessesCol = (mongo: MongoClient) => db(mongo).collection<any>('businesses');
const jobsCol = (mongo: MongoClient) => db(mongo).collection<any>('jobs');
const customersCol = (mongo: MongoClient) => db(mongo).collection<any>('customers');

const wrap = (fn: (req: Request, res: Response) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };

const iso = (value: any): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const asPence = (value: any): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

const asPositivePenceFromPounds = (value: any): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ApiError(400, 'Amount must be greater than zero');
  }
  return Math.round(n * 100);
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A held payment becomes "available" in the UI once its hold window has passed. */
const effectiveStatus = (payment: any): string => {
  const stored = String(payment?.status || 'awaiting_payment');
  if (stored !== 'pending') return stored;
  const availableAt = payment.availableAt ? new Date(payment.availableAt).getTime() : NaN;
  return Number.isFinite(availableAt) && availableAt <= Date.now() ? 'available' : 'pending';
};

const buildDateFilter = (query: any): Record<string, any> => {
  const from = typeof query?.from === 'string' ? query.from : '';
  const to = typeof query?.to === 'string' ? query.to : '';
  if (!from && !to) return {};
  const createdAt: Record<string, Date> = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) createdAt.$gte = new Date(`${from}T00:00:00.000Z`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) createdAt.$lte = new Date(`${to}T23:59:59.999Z`);
  return Object.keys(createdAt).length ? { createdAt } : {};
};

const attachBusinessNames = async (mongo: MongoClient, docs: any[]): Promise<void> => {
  const ids = Array.from(new Set(docs.map(d => String(d?.businessId || '')).filter(Boolean)));
  if (!ids.length) {
    docs.forEach(d => { d.businessName = 'Unknown business'; });
    return;
  }
  const [businesses, users] = await Promise.all([
    businessesCol(mongo).find({ _id: { $in: ids } } as any).toArray(),
    usersCol(mongo).find({ businessId: { $in: ids } } as any).toArray()
  ]);
  const businessMap = new Map(businesses.map((b: any) => [String(b._id), b]));
  const userMap = new Map(users.map((u: any) => [String((u as any).businessId), u]));
  docs.forEach(d => {
    const id = String(d?.businessId || '');
    const business: any = businessMap.get(id);
    const user: any = userMap.get(id);
    d.businessName = business?.name || business?.companyName || user?.email || 'Unknown business';
  });
};

const serializePayment = (p: any) => ({
  id: p._id,
  requestId: p.requestId,
  businessId: p.businessId,
  businessName: p.businessName || 'Unknown business',
  jobId: p.jobId,
  customerId: p.customerId || null,
  customerName: p.customerName || 'Customer',
  stage: p.stage,
  description: p.description || '',
  amountPence: asPence(p.amountPence),
  applicationFeePence: asPence(p.applicationFeePence),
  stripeFeePence: asPence(p.stripeFeePence),
  netPence: asPence(p.netPence),
  refundedPence: asPence(p.refundedPence),
  currency: p.currency || 'GBP',
  status: effectiveStatus(p),
  checkoutSessionId: p.checkoutSessionId || null,
  paymentIntentId: p.paymentIntentId || null,
  paidAt: iso(p.paidAt),
  availableAt: iso(p.availableAt),
  refundedAt: iso(p.refundedAt),
  failureCode: p.failureCode || null,
  createdAt: iso(p.createdAt),
  updatedAt: iso(p.updatedAt)
});

const serializePayout = (p: any) => ({
  id: p._id,
  businessId: p.businessId,
  businessName: p.businessName || 'Unknown business',
  stripeAccountId: p.stripeAccountId,
  stripePayoutId: p.stripePayoutId,
  amountPence: asPence(p.amountPence),
  currency: p.currency || 'GBP',
  status: p.status || 'pending',
  arrivalDate: iso(p.arrivalDate),
  failureCode: p.failureCode || null,
  description: p.description || null,
  createdAt: iso(p.createdAt),
  updatedAt: iso(p.updatedAt)
});

const serializeAccount = (a: any) => ({
  id: a._id,
  businessId: a.businessId,
  businessName: a.businessName || 'Unknown business',
  stripeAccountId: a.stripeAccountId,
  country: a.country || 'GB',
  currency: a.currency || 'GBP',
  email: a.email || null,
  chargesEnabled: !!a.chargesEnabled,
  payoutsEnabled: !!a.payoutsEnabled,
  detailsSubmitted: !!a.detailsSubmitted,
  requirementsCurrentlyDue: a.requirementsCurrentlyDue || [],
  requirementsEventuallyDue: a.requirementsEventuallyDue || [],
  payoutDelayDays: Number(a.payoutDelayDays || 7),
  createdAt: iso(a.createdAt),
  updatedAt: iso(a.updatedAt)
});

const sumPence = (docs: any[], field: string): number =>
  docs.reduce((total, doc) => total + asPence(doc?.[field]), 0);

export function createConnectRouter(deps: ConnectRouterDeps): Router {
  const { mongo, stripe, authenticate, requireAdmin, frontendUrl } = deps;
  const router = express.Router();

  const requireBusiness = (req: any, res: Response, next: NextFunction) => {
    const role = String(req.user?.role || '').toLowerCase();
    if (role !== 'business') {
      return res.status(403).json({ error: 'This area is only available to business accounts' });
    }
    return next();
  };

  const getSettings = async (): Promise<FinanceSettingsDoc> => {
    const stored = await settingsCol(mongo).findOne({ _id: 'finance_settings' } as any);
    return {
      _id: 'finance_settings',
      commissionPercent: Number(stored?.commissionPercent ?? DEFAULT_SETTINGS.commissionPercent),
      commissionFixedPence: asPence(stored?.commissionFixedPence ?? DEFAULT_SETTINGS.commissionFixedPence),
      holdDays: Number(stored?.holdDays ?? DEFAULT_SETTINGS.holdDays),
      currency: stored?.currency || DEFAULT_SETTINGS.currency,
      createdAt: stored?.createdAt instanceof Date ? stored.createdAt : new Date(),
      updatedAt: stored?.updatedAt instanceof Date ? stored.updatedAt : new Date()
    };
  };

  const requireStripe = (): Stripe => {
    if (!stripe) throw new ApiError(501, 'Stripe is not configured on the billing service');
    return stripe;
  };

  const getBusinessContext = async (req: any) => {
    const user = await usersCol(mongo).findOne({ _id: String(req.user?.id || '') } as any);
    const businessId = String((user as any)?.businessId || '');
    if (!businessId) throw new ApiError(403, 'Your user is not linked to a business');
    const business: any = await businessesCol(mongo).findOne({ _id: businessId } as any);
    return {
      businessId,
      email: String(user?.email || ''),
      businessName: String(business?.name || business?.companyName || user?.name || 'BlindsCloud business')
    };
  };

  const refreshAccountFromStripe = async (record: any): Promise<any> => {
    if (!stripe || !record?.stripeAccountId) return record;
    let account: any;
    try {
      account = await stripe.accounts.retrieve(record.stripeAccountId);
    } catch {
      return record;
    }
    const schedule = account?.settings?.payouts?.schedule;
    const update: any = {
      chargesEnabled: !!account.charges_enabled,
      payoutsEnabled: !!account.payouts_enabled,
      detailsSubmitted: !!account.details_submitted,
      requirementsCurrentlyDue: account?.requirements?.currently_due || [],
      requirementsEventuallyDue: account?.requirements?.eventually_due || [],
      payoutDelayDays: Number(schedule?.delay_days ?? record.payoutDelayDays ?? 7),
      updatedAt: new Date()
    };
    await accountsCol(mongo).updateOne({ _id: record._id }, { $set: update });
    return { ...record, ...update };
  };

  const ensureAccount = async (req: any): Promise<any> => {
    const client = requireStripe();
    const ctx = await getBusinessContext(req);
    const existing = await accountsCol(mongo).findOne({ businessId: ctx.businessId } as any);
    if (existing) return existing;

    const settings = await getSettings();
    const account: any = await client.accounts.create({
      type: 'express',
      country: 'GB',
      email: ctx.email,
      business_profile: { name: ctx.businessName },
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      },
      settings: {
        payouts: {
          schedule: { interval: 'daily', delay_days: clamp(settings.holdDays, 0, 30) }
        }
      }
    } as any);

    const now = new Date();
    const record = {
      _id: crypto.randomUUID(),
      businessId: ctx.businessId,
      stripeAccountId: String(account.id),
      country: 'GB',
      currency: 'GBP',
      email: ctx.email,
      businessName: ctx.businessName,
      chargesEnabled: !!account.charges_enabled,
      payoutsEnabled: !!account.payouts_enabled,
      detailsSubmitted: !!account.details_submitted,
      requirementsCurrentlyDue: account?.requirements?.currently_due || [],
      requirementsEventuallyDue: account?.requirements?.eventually_due || [],
      payoutDelayDays: clamp(settings.holdDays, 0, 30),
      createdAt: now,
      updatedAt: now
    };
    await accountsCol(mongo).insertOne(record);
    return record;
  };

  const syncLedger = async (businessId?: string) => {
    const client = requireStripe();
    const accountFilter: any = businessId ? { businessId } : {};
    const paymentFilter: any = { status: 'awaiting_payment', checkoutSessionId: { $exists: true } };
    if (businessId) paymentFilter.businessId = businessId;

    const [awaiting, accounts] = await Promise.all([
      paymentsCol(mongo).find(paymentFilter).toArray(),
      accountsCol(mongo).find(accountFilter).toArray()
    ]);

    let paymentsUpdated = 0;
    for (const payment of awaiting) {
      try {
        const session: any = await client.checkout.sessions.retrieve(String(payment.checkoutSessionId));
        const now = new Date();
        if (session.payment_status === 'paid') {
          const intent = session.payment_intent;
          const paymentIntentId = typeof intent === 'string' ? intent : intent?.id;
          const paidAt = session.created
            ? new Date(Number(session.created) * 1000)
            : new Date(now.getTime());
          const settings = await getSettings();
          await paymentsCol(mongo).updateOne({ _id: payment._id }, {
            $set: {
              status: 'pending',
              paymentIntentId: paymentIntentId || null,
              paidAt,
              availableAt: new Date(paidAt.getTime() + clamp(settings.holdDays, 0, 31) * HOLD_DAY_MS),
              failureCode: null,
              updatedAt: now
            }
          });
          paymentsUpdated += 1;
        } else if (session.status === 'expired') {
          await paymentsCol(mongo).updateOne({ _id: payment._id }, {
            $set: { status: 'failed', failureCode: 'checkout_expired', updatedAt: now }
          });
          paymentsUpdated += 1;
        }
      } catch (error: any) {
        console.error('[connect] failed to sync checkout session', payment.checkoutSessionId, error?.message);
      }
    }

    let payoutsUpdated = 0;
    for (const account of accounts) {
      try {
        const result = await client.payouts.list(
          { limit: 100 },
          { stripeAccount: String(account.stripeAccountId) }
        );
        for (const payout of result.data) {
          const now = new Date();
          const update: any = {
            businessId: account.businessId,
            stripeAccountId: account.stripeAccountId,
            stripePayoutId: payout.id,
            amountPence: asPence(payout.amount),
            currency: String(payout.currency || 'gbp').toUpperCase(),
            status: String(payout.status || 'pending'),
            arrivalDate: payout.arrival_date ? new Date(payout.arrival_date * 1000) : null,
            failureCode: (payout as any).failure_code || null,
            description: payout.description || null,
            updatedAt: now
          };
          await payoutsCol(mongo).updateOne(
            { stripePayoutId: payout.id },
            { $set: update, $setOnInsert: { _id: crypto.randomUUID(), createdAt: now } },
            { upsert: true }
          );
          payoutsUpdated += 1;
        }
      } catch (error: any) {
        console.error('[connect] failed to sync payouts', account.stripeAccountId, error?.message);
      }
    }

    return { paymentsUpdated, payoutsUpdated, accountsChecked: accounts.length };
  };

  // ---------------------------------------------------------------------------
  // Business: account + onboarding
  // ---------------------------------------------------------------------------

  router.get('/account', authenticate, requireBusiness, wrap(async (req, res) => {
    const ctx = await getBusinessContext(req);
    const record = await accountsCol(mongo).findOne({ businessId: ctx.businessId } as any);
    if (!record) return res.json(null);
    const refreshed = await refreshAccountFromStripe(record);
    return res.json(serializeAccount({ ...refreshed, businessName: ctx.businessName }));
  }));

  router.post('/accounts', authenticate, requireBusiness, wrap(async (req, res) => {
    const record = await ensureAccount(req);
    return res.status(201).json(serializeAccount(await refreshAccountFromStripe(record)));
  }));

  router.post('/onboarding-link', authenticate, requireBusiness, wrap(async (req, res) => {
    const client = requireStripe();
    const record = await ensureAccount(req);
    const origin = frontendUrl || `${req.protocol}://${req.get('host')}`;
    const link: any = await client.accountLinks.create({
      account: String(record.stripeAccountId),
      refresh_url: `${origin}/?connectRefresh=1`,
      return_url: `${origin}/?connectReturn=1`,
      type: 'account_onboarding'
    } as any);
    return res.json({ url: link.url, expiresAt: iso(link.expires_at) });
  }));

  router.post('/payout-settings', authenticate, requireBusiness, [
    body('delayDays').optional().isInt({ min: 0, max: 30 })
  ], wrap(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const client = requireStripe();
    const record = await accountsCol(mongo).findOne({ businessId: (await getBusinessContext(req)).businessId } as any);
    if (!record) throw new ApiError(404, 'Connect account not found');
    const delayDays = clamp(Number(req.body?.delayDays ?? record.payoutDelayDays ?? 7), 0, 30);
    await client.accounts.update(String(record.stripeAccountId), {
      settings: { payouts: { schedule: { interval: 'daily', delay_days: delayDays } } }
    } as any);
    await accountsCol(mongo).updateOne({ _id: record._id }, { $set: { payoutDelayDays: delayDays, updatedAt: new Date() } });
    return res.json({ delayDays });
  }));

  // ---------------------------------------------------------------------------
  // Business: earnings + payment requests
  // ---------------------------------------------------------------------------

  router.get('/earnings/summary', authenticate, requireBusiness, wrap(async (req, res) => {
    const ctx = await getBusinessContext(req);
    const dateFilter = buildDateFilter(req.query);
    const docs = await paymentsCol(mongo).find({ businessId: ctx.businessId, ...dateFilter } as any).toArray();
    const byStatus = (status: string) => docs.filter(d => effectiveStatus(d) === status);
    const paid = docs.filter(d => ['pending', 'available', 'paid_out'].includes(effectiveStatus(d)));
    const account = await accountsCol(mongo).findOne({ businessId: ctx.businessId } as any);
    const settings = await getSettings();
    return res.json({
      grossPence: sumPence(paid, 'amountPence'),
      commissionPence: sumPence(paid, 'applicationFeePence'),
      stripeFeePence: sumPence(paid, 'stripeFeePence'),
      netPence: sumPence(paid, 'netPence'),
      pendingPence: sumPence(byStatus('pending'), 'netPence'),
      availablePence: sumPence(byStatus('available'), 'netPence'),
      paidOutPence: sumPence(byStatus('paid_out'), 'netPence'),
      refundedPence: sumPence(docs.filter(d => effectiveStatus(d) === 'refunded'), 'refundedPence'),
      counts: {
        pending: byStatus('pending').length,
        available: byStatus('available').length,
        paidOut: byStatus('paid_out').length,
        refunded: docs.filter(d => effectiveStatus(d) === 'refunded').length,
        total: docs.length
      },
      holdDays: settings.holdDays,
      account: account ? serializeAccount({ ...account, businessName: ctx.businessName }) : null
    });
  }));

  router.get('/earnings/payments', authenticate, requireBusiness, wrap(async (req, res) => {
    const ctx = await getBusinessContext(req);
    const filter: any = { businessId: ctx.businessId, ...buildDateFilter(req.query) };
    if (typeof req.query.status === 'string' && req.query.status !== 'all') {
      filter.status = req.query.status;
    }
    if (typeof req.query.stage === 'string' && req.query.stage !== 'all') {
      filter.stage = req.query.stage;
    }
    if (typeof req.query.jobId === 'string' && req.query.jobId) {
      filter.jobId = req.query.jobId;
    }
    const docs = await paymentsCol(mongo).find(filter).sort({ createdAt: -1 }).limit(500).toArray();
    const search = String(req.query.search || '').trim().toLowerCase();
    const filtered = search
      ? docs.filter(d =>
          String(d.customerName || '').toLowerCase().includes(search) ||
          String(d.jobId || '').toLowerCase().includes(search) ||
          String(d.description || '').toLowerCase().includes(search))
      : docs;
    return res.json(filtered.map(serializePayment));
  }));

  router.get('/payouts', authenticate, requireBusiness, wrap(async (req, res) => {
    const ctx = await getBusinessContext(req);
    const filter: any = { businessId: ctx.businessId, ...buildDateFilter(req.query) };
    if (typeof req.query.status === 'string' && req.query.status !== 'all') filter.status = req.query.status;
    const docs = await payoutsCol(mongo).find(filter).sort({ createdAt: -1 }).limit(300).toArray();
    await attachBusinessNames(mongo, docs);
    return res.json(docs.map(serializePayout));
  }));

  router.post('/sync', authenticate, requireBusiness, wrap(async (req, res) => {
    const ctx = await getBusinessContext(req);
    return res.json(await syncLedger(ctx.businessId));
  }));

  router.post('/payment-requests', authenticate, requireBusiness, [
    body('jobId').isString().isLength({ min: 1 }),
    body('amount').isFloat({ gt: 0 }),
    body('stage').optional().isIn(['measurement_deposit', 'installation_final', 'other']),
    body('customerName').optional().isString().trim()
  ], wrap(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const client = requireStripe();
    const ctx = await getBusinessContext(req);
    const account = await accountsCol(mongo).findOne({ businessId: ctx.businessId } as any);
    if (!account) throw new ApiError(400, 'Please connect a bank account before requesting card payments');
    if (!account.payoutsEnabled) throw new ApiError(400, 'Stripe account setup is not complete yet. Finish onboarding first.');

    const jobId = String(req.body.jobId);
    const job: any = await jobsCol(mongo).findOne({ _id: jobId } as any);
    if (!job || String(job.businessId) !== ctx.businessId) {
      throw new ApiError(404, 'Job not found for this business');
    }
    const customer: any = job.customerId
      ? await customersCol(mongo).findOne({ _id: String(job.customerId) } as any)
      : null;
    const customerName = String(req.body.customerName || customer?.name || 'Customer');
    const stage: ConnectPaymentStage = (req.body.stage || 'measurement_deposit') as ConnectPaymentStage;
    const amountPence = asPositivePenceFromPounds(req.body.amount);
    const settings = await getSettings();
    const applicationFeePence = Math.min(
      Math.round(amountPence * (clamp(settings.commissionPercent, 0, 100) / 100)) + settings.commissionFixedPence,
      amountPence
    );
    const netPence = Math.max(0, amountPence - applicationFeePence);
    const requestId = crypto.randomUUID();
    const now = new Date();
    const origin = frontendUrl || `${req.protocol}://${req.get('host')}`;

    const doc: JobPaymentDoc = {
      _id: requestId,
      requestId,
      businessId: ctx.businessId,
      jobId,
      customerId: job.customerId ? String(job.customerId) : undefined,
      customerName,
      stage,
      description: String(job.title || 'BlindsCloud job payment'),
      amountPence,
      applicationFeePence,
      stripeFeePence: 0,
      netPence,
      refundedPence: 0,
      currency: 'GBP',
      status: 'awaiting_payment',
      createdAt: now,
      updatedAt: now
    };

    const session: any = await client.checkout.sessions.create({
      mode: 'payment',
      customer_email: customer?.email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'gbp',
          unit_amount: amountPence,
          product_data: {
            name: `${stage === 'installation_final' ? 'Installation balance' : 'Measurement deposit'} — ${doc.description}`,
            description: `Payment for ${ctx.businessName}`
          }
        }
      }],
      payment_intent_data: {
        on_behalf_of: String(account.stripeAccountId),
        transfer_data: { destination: String(account.stripeAccountId) },
        application_fee_amount: applicationFeePence,
        metadata: { requestId, businessId: ctx.businessId, jobId, stage }
      },
      metadata: { requestId, businessId: ctx.businessId, jobId, stage },
      success_url: `${origin}/?jobPayment=success&requestId=${encodeURIComponent(requestId)}&jobId=${encodeURIComponent(jobId)}`,
      cancel_url: `${origin}/?jobPayment=cancelled&requestId=${encodeURIComponent(requestId)}`
    } as any, { idempotencyKey: requestId });

    doc.checkoutSessionId = session.id;
    await paymentsCol(mongo).insertOne(doc as any);
    return res.status(201).json({ url: session.url, sessionId: session.id, requestId });
  }));

  router.post('/payment-requests/:id/refund', authenticate, requireBusiness, [
    body('amount').optional().isFloat({ gt: 0 }),
    body('reason').optional().isIn(['requested_by_customer', 'duplicate', 'fraudulent'])
  ], wrap(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const client = requireStripe();
    const ctx = await getBusinessContext(req);
    const payment = await paymentsCol(mongo).findOne({ _id: String(req.params.id), businessId: ctx.businessId } as any);
    if (!payment) throw new ApiError(404, 'Payment not found');
    const stillRefundable = asPence(payment.amountPence) - asPence(payment.refundedPence);
    if (stillRefundable <= 0) throw new ApiError(400, 'This payment has already been fully refunded');
    const requestedPence = req.body?.amount
      ? asPositivePenceFromPounds(req.body.amount)
      : stillRefundable;
    const refundPence = Math.min(requestedPence, stillRefundable);

    const refundParams: any = {
      amount: refundPence,
      reverse_transfer: true,
      refund_application_fee: true
    };
    if (payment.chargeId) refundParams.charge = payment.chargeId;
    else if (payment.paymentIntentId) refundParams.payment_intent = payment.paymentIntentId;
    else throw new ApiError(400, 'Stripe has not confirmed this payment yet');
    if (req.body?.reason) refundParams.reason = req.body.reason;

    const refund: any = await client.refunds.create(refundParams);
    const refundedPence = asPence(payment.refundedPence) + asPence(refund.amount);
    await paymentsCol(mongo).updateOne({ _id: payment._id }, {
      $set: {
        refundedPence,
        status: refundedPence >= asPence(payment.amountPence) ? 'refunded' : payment.status,
        refundedAt: new Date(),
        updatedAt: new Date()
      }
    });
    return res.json({ refundId: refund.id, refundedPence });
  }));

  // ---------------------------------------------------------------------------
  // Admin: finance overview
  // ---------------------------------------------------------------------------

  router.get('/admin/summary', authenticate, requireAdmin, wrap(async (req, res) => {
    const dateFilter = buildDateFilter(req.query);
    const [payments, accounts, payouts] = await Promise.all([
      paymentsCol(mongo).find(dateFilter).toArray(),
      accountsCol(mongo).find({}).toArray(),
      payoutsCol(mongo).find(dateFilter).toArray()
    ]);
    const paid = payments.filter(p => ['pending', 'available', 'paid_out'].includes(effectiveStatus(p)));
    const byStatus = (status: string) => payments.filter(p => effectiveStatus(p) === status);
    const perBusinessMap = new Map<string, any>();
    payments.forEach(p => {
      const id = String(p.businessId || 'unknown');
      if (!perBusinessMap.has(id)) {
        perBusinessMap.set(id, {
          businessId: id,
          grossPence: 0,
          commissionPence: 0,
          stripeFeePence: 0,
          netPence: 0,
          pendingPence: 0,
          availablePence: 0,
          refundedPence: 0,
          paymentCount: 0
        });
      }
      const row = perBusinessMap.get(id);
      row.paymentCount += 1;
      if (['pending', 'available', 'paid_out'].includes(effectiveStatus(p))) {
        row.grossPence += asPence(p.amountPence);
        row.commissionPence += asPence(p.applicationFeePence);
        row.stripeFeePence += asPence(p.stripeFeePence);
        row.netPence += asPence(p.netPence);
      }
      if (effectiveStatus(p) === 'pending') row.pendingPence += asPence(p.netPence);
      if (effectiveStatus(p) === 'available') row.availablePence += asPence(p.netPence);
      if (effectiveStatus(p) === 'refunded') row.refundedPence += asPence(p.refundedPence);
    });
    const perBusiness = Array.from(perBusinessMap.values());
    await attachBusinessNames(mongo, perBusiness);

    return res.json({
      grossPence: sumPence(paid, 'amountPence'),
      commissionPence: sumPence(paid, 'applicationFeePence'),
      stripeFeePence: sumPence(paid, 'stripeFeePence'),
      netPence: sumPence(paid, 'netPence'),
      pendingPence: sumPence(byStatus('pending'), 'netPence'),
      availablePence: sumPence(byStatus('available'), 'netPence'),
      paidOutPence: sumPence(byStatus('paid_out'), 'netPence'),
      refundedPence: sumPence(payments.filter(p => effectiveStatus(p) === 'refunded'), 'refundedPence'),
      payoutPence: sumPence(payouts, 'amountPence'),
      counts: {
        payments: payments.length,
        pending: byStatus('pending').length,
        available: byStatus('available').length,
        paidOut: byStatus('paid_out').length,
        refunded: byStatus('refunded').length,
        accounts: accounts.length,
        readyAccounts: accounts.filter(a => a.chargesEnabled && a.payoutsEnabled).length
      },
      perBusiness
    });
  }));

  router.get('/admin/payments', authenticate, requireAdmin, wrap(async (req, res) => {
    const filter: any = buildDateFilter(req.query);
    if (typeof req.query.businessId === 'string' && req.query.businessId) filter.businessId = req.query.businessId;
    if (typeof req.query.status === 'string' && req.query.status !== 'all') filter.status = req.query.status;
    if (typeof req.query.stage === 'string' && req.query.stage !== 'all') filter.stage = req.query.stage;
    const docs = await paymentsCol(mongo).find(filter).sort({ createdAt: -1 }).limit(1000).toArray();
    const search = String(req.query.search || '').trim().toLowerCase();
    const filtered = search
      ? docs.filter(d =>
          String(d.customerName || '').toLowerCase().includes(search) ||
          String(d.jobId || '').toLowerCase().includes(search) ||
          String(d.description || '').toLowerCase().includes(search))
      : docs;
    await attachBusinessNames(mongo, filtered);
    return res.json(filtered.map(serializePayment));
  }));

  router.get('/admin/payouts', authenticate, requireAdmin, wrap(async (req, res) => {
    const filter: any = buildDateFilter(req.query);
    if (typeof req.query.businessId === 'string' && req.query.businessId) filter.businessId = req.query.businessId;
    if (typeof req.query.status === 'string' && req.query.status !== 'all') filter.status = req.query.status;
    const docs = await payoutsCol(mongo).find(filter).sort({ createdAt: -1 }).limit(1000).toArray();
    await attachBusinessNames(mongo, docs);
    return res.json(docs.map(serializePayout));
  }));

  router.get('/admin/accounts', authenticate, requireAdmin, wrap(async (req, res) => {
    const docs = await accountsCol(mongo).find({}).sort({ createdAt: -1 }).toArray();
    await attachBusinessNames(mongo, docs);
    return res.json(docs.map(serializeAccount));
  }));

  router.get('/admin/settings', authenticate, requireAdmin, wrap(async (_req, res) => {
    const settings = await getSettings();
    return res.json({
      commissionPercent: settings.commissionPercent,
      commissionFixedPence: settings.commissionFixedPence,
      holdDays: settings.holdDays,
      currency: settings.currency
    });
  }));

  router.put('/admin/settings', authenticate, requireAdmin, [
    body('commissionPercent').isFloat({ min: 0, max: 100 }),
    body('commissionFixedPence').optional().isInt({ min: 0 }),
    body('holdDays').optional().isInt({ min: 0, max: 31 })
  ], wrap(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const update = {
      commissionPercent: Number(req.body.commissionPercent),
      commissionFixedPence: asPence(req.body.commissionFixedPence ?? 0),
      holdDays: clamp(Number(req.body.holdDays ?? 7), 0, 31),
      currency: 'gbp',
      updatedAt: new Date()
    };
    await settingsCol(mongo).updateOne(
      { _id: 'finance_settings' },
      { $set: update, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    return res.json({ ...update, _id: 'finance_settings' });
  }));

  router.post('/admin/sync', authenticate, requireAdmin, wrap(async (_req, res) => {
    return res.json(await syncLedger());
  }));

  router.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error('[connect]', error);
    return res.status(status).json({ error: error?.message || 'Unexpected finance error' });
  });

  return router;
}
