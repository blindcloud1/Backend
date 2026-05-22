"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const express_validator_1 = require("express-validator");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const mongodb_1 = require("mongodb");
const crypto_1 = __importDefault(require("crypto"));
const stripe_1 = __importDefault(require("stripe"));
const event_bus_1 = require("@blindscloud/event-bus");
dotenv_1.default.config();
const PORT = parseInt(process.env.PORT || '4008', 10);
const JWT_SECRET = process.env.JWT_SECRET || '';
const MONGO_URL = process.env.MONGO_URL || '';
const RABBITMQ_URL = process.env.RABBITMQ_URL || '';
const EVENT_EXCHANGE = process.env.EVENT_EXCHANGE || 'blindscloud.events';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const FRONTEND_URL = process.env.FRONTEND_URL || '';
if (!JWT_SECRET)
    throw new Error('JWT_SECRET is required');
if (!MONGO_URL)
    throw new Error('MONGO_URL is required');
if (!RABBITMQ_URL)
    throw new Error('RABBITMQ_URL is required');
const stripe = STRIPE_SECRET_KEY ? new stripe_1.default(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' }) : null;
const mongo = new mongodb_1.MongoClient(MONGO_URL);
const eventBus = new event_bus_1.EventBus({
    url: RABBITMQ_URL,
    exchange: EVENT_EXCHANGE,
    serviceName: 'billing-service'
});
const usersCollection = () => mongo.db('blindscloud').collection('users');
const plansCollection = () => mongo.db('blindscloud').collection('subscription_plans');
const subsCollection = () => mongo.db('blindscloud').collection('user_subscriptions');
const paymentsCollection = () => mongo.db('blindscloud').collection('payment_history');
const customConfigCollection = () => mongo.db('blindscloud').collection('custom_plan_config');
const platformSettingsCollection = () => mongo.db('blindscloud').collection('platform_settings');
const authenticate = (req, res, next) => {
    const header = req.header('authorization') || req.header('Authorization');
    if (!header)
        return res.status(401).json({ error: 'Missing Authorization header' });
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match)
        return res.status(401).json({ error: 'Invalid Authorization header' });
    try {
        const decoded = jsonwebtoken_1.default.verify(match[1], JWT_SECRET);
        req.user = { id: String(decoded.userId), email: String(decoded.email), role: String(decoded.role) };
        next();
    }
    catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
};
const requireAdmin = (req, res, next) => {
    const role = req.user?.role?.toLowerCase();
    if (role === 'admin')
        return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
};
const getCurrentUser = async (req) => {
    return usersCollection().findOne({ _id: req.user.id });
};
const toPlanResponse = (p) => ({
    ...p,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt?.toISOString()
});
const toSubResponse = (s) => ({
    ...s,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt?.toISOString(),
    currentPeriodStart: s.currentPeriodStart.toISOString(),
    currentPeriodEnd: s.currentPeriodEnd.toISOString()
});
const toPaymentResponse = (p) => ({
    ...p,
    paymentDate: p.paymentDate.toISOString(),
    createdAt: p.createdAt.toISOString()
});
const toConfigResponse = (c) => ({
    ...c,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt?.toISOString()
});
const isValidStatus = (value) => {
    return ['active', 'cancelled', 'expired', 'trial', 'past_due'].includes(String(value));
};
const isValidPaymentStatus = (value) => {
    return ['succeeded', 'failed', 'pending', 'refunded'].includes(String(value));
};
const toNullableNumberOrDefault = (value, defaultValue) => {
    if (value === null)
        return null;
    if (value === undefined)
        return defaultValue;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : defaultValue;
};
const app = (0, express_1.default)();
app.use(express_1.default.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
        req.rawBody = buf;
    }
}));
app.use((0, helmet_1.default)());
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'billing-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
app.get('/public/terms-and-conditions', async (_req, res) => {
    const doc = await platformSettingsCollection().findOne({ _id: 'subscription_terms' });
    res.json({
        terms: typeof doc?.terms === 'string' ? doc.terms : '',
        updatedAt: doc?.updatedAt?.toISOString?.() || null
    });
});
app.get('/terms-and-conditions', authenticate, async (_req, res) => {
    const doc = await platformSettingsCollection().findOne({ _id: 'subscription_terms' });
    res.json({
        terms: typeof doc?.terms === 'string' ? doc.terms : '',
        updatedAt: doc?.updatedAt?.toISOString?.() || null
    });
});
app.put('/terms-and-conditions', authenticate, requireAdmin, [(0, express_validator_1.body)('terms').isString().isLength({ max: 1000 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const terms = String(req.body?.terms || '');
    const now = new Date();
    await platformSettingsCollection().updateOne({ _id: 'subscription_terms' }, {
        $set: {
            terms,
            updatedAt: now,
            updatedBy: req.user?.id || null
        },
        $setOnInsert: {
            createdAt: now
        }
    }, { upsert: true });
    res.json({ terms, updatedAt: now.toISOString() });
});
app.get('/subscription-plans', authenticate, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const includeInactive = req.query.includeInactive === 'true';
    const filter = includeInactive && role === 'admin' ? {} : { active: true };
    const plans = await plansCollection().find(filter).sort({ price: 1 }).toArray();
    const cfg = await customConfigCollection().findOne({});
    const setupFeeEnabled = cfg?.setupFeeEnabled !== false;
    if (role === 'admin') {
        res.json(plans.map(p => ({ ...toPlanResponse(p), setupFeeEnabled })));
        return;
    }
    const hasPaidSetupFeeCount = await subsCollection().countDocuments({ userId: req.user.id, setupFeeCharged: true });
    const canChargeSetupFee = hasPaidSetupFeeCount === 0;
    res.json(plans.map(p => ({
        ...toPlanResponse(p),
        setupFeeEnabled,
        setupFeeApplies: setupFeeEnabled && canChargeSetupFee && Number(toNullableNumberOrDefault(p.setupFee, 0) || 0) > 0
    })));
});
app.post('/subscription-plans', authenticate, requireAdmin, [
    (0, express_validator_1.body)('name').isLength({ min: 1 }),
    (0, express_validator_1.body)('price').isNumeric(),
    (0, express_validator_1.body)('priceOneMonth').optional().isNumeric(),
    (0, express_validator_1.body)('priceYearly').optional().isNumeric(),
    (0, express_validator_1.body)('setupFee').optional().isNumeric(),
    (0, express_validator_1.body)('stripePriceIdYearly').optional().isString()
], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const payload = req.body;
    const now = new Date();
    const plan = {
        _id: crypto_1.default.randomUUID(),
        name: String(payload.name || ''),
        description: String(payload.description || ''),
        price: typeof payload.price === 'number' ? payload.price : Number(payload.price),
        priceOneMonth: toNullableNumberOrDefault(payload.priceOneMonth, null),
        priceYearly: toNullableNumberOrDefault(payload.priceYearly, null),
        setupFee: toNullableNumberOrDefault(payload.setupFee, null),
        features: Array.isArray(payload.features) ? payload.features : [],
        maxEmployees: toNullableNumberOrDefault(payload.maxEmployees, 0),
        maxSubBusinessUsers: toNullableNumberOrDefault(payload.maxSubBusinessUsers, null),
        maxProducts: toNullableNumberOrDefault(payload.maxProducts, null),
        maxEmailsPerMonth: toNullableNumberOrDefault(payload.maxEmailsPerMonth, null),
        maxJobs: toNullableNumberOrDefault(payload.maxJobs, 0),
        stripePriceId: payload.stripePriceId ?? null,
        stripePriceIdYearly: payload.stripePriceIdYearly ?? null,
        active: payload.active ?? true,
        createdAt: now,
        updatedAt: now
    };
    await plansCollection().insertOne(plan);
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'subscriptionPlans.created',
        version: 1,
        source: 'billing-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { planId: plan._id, name: plan.name }
    };
    await eventBus.publish('subscriptionPlans.created', event);
    res.status(201).json(toPlanResponse(plan));
});
app.put('/subscription-plans/:id', authenticate, requireAdmin, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const planId = req.params.id;
    const existing = await plansCollection().findOne({ _id: planId });
    if (!existing)
        return res.status(404).json({ error: 'Plan not found' });
    const updates = req.body;
    delete updates._id;
    delete updates.createdAt;
    if (updates.setupFee !== undefined) {
        updates.setupFee = toNullableNumberOrDefault(updates.setupFee, null);
    }
    if (updates.priceOneMonth !== undefined) {
        updates.priceOneMonth = toNullableNumberOrDefault(updates.priceOneMonth, null);
    }
    if (updates.priceYearly !== undefined) {
        updates.priceYearly = toNullableNumberOrDefault(updates.priceYearly, null);
    }
    updates.updatedAt = new Date();
    const result = await plansCollection().updateOne({ _id: planId }, { $set: updates });
    if (result.matchedCount === 0)
        return res.status(404).json({ error: 'Plan not found' });
    const updated = await plansCollection().findOne({ _id: planId });
    if (!updated)
        return res.status(404).json({ error: 'Plan not found' });
    const event = {
        id: crypto_1.default.randomUUID(),
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
app.delete('/subscription-plans/:id', authenticate, requireAdmin, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const planId = req.params.id;
    const existing = await plansCollection().findOne({ _id: planId });
    if (!existing)
        return res.status(404).json({ error: 'Plan not found' });
    await plansCollection().deleteOne({ _id: planId });
    const event = {
        id: crypto_1.default.randomUUID(),
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
const getFrontendBaseUrl = (req) => {
    if (FRONTEND_URL)
        return FRONTEND_URL.replace(/\/+$/, '');
    const origin = req.header('origin') || '';
    if (origin)
        return origin.replace(/\/+$/, '');
    const host = req.header('host') || '';
    if (!host)
        return '';
    const proto = req.header('x-forwarded-proto') || 'https';
    return `${proto}://${host}`.replace(/\/+$/, '');
};
app.post('/stripe/checkout-session', authenticate, [(0, express_validator_1.body)('planId').isLength({ min: 1 }), (0, express_validator_1.body)('billingCycle').optional().isString()], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    if (!stripe)
        return res.status(501).json({ error: 'Stripe is not configured' });
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const { planId, billingCycle } = req.body;
    const normalizedCycle = billingCycle === 'one_month' || billingCycle === 'yearly' || billingCycle === 'monthly'
        ? billingCycle
        : 'monthly';
    const plan = await plansCollection().findOne({ _id: String(planId), active: true });
    if (!plan)
        return res.status(400).json({ error: 'Invalid planId' });
    if (normalizedCycle === 'monthly' && !plan.stripePriceId) {
        return res.status(400).json({ error: 'Plan is missing stripePriceId (monthly)' });
    }
    if (normalizedCycle === 'yearly' && !plan.stripePriceIdYearly) {
        return res.status(400).json({ error: 'Plan is missing stripePriceIdYearly (yearly)' });
    }
    const cfg = await customConfigCollection().findOne({});
    const setupFeeEnabled = cfg?.setupFeeEnabled !== false;
    const hasPaidSetupFeeCount = await subsCollection().countDocuments({ userId: req.user.id, setupFeeCharged: true });
    const canChargeSetupFee = hasPaidSetupFeeCount === 0;
    const planSetupFee = Number(toNullableNumberOrDefault(plan.setupFee, 0) || 0);
    const shouldChargeSetupFee = setupFeeEnabled && canChargeSetupFee && planSetupFee > 0;
    const existingCustomer = await subsCollection().findOne({ userId: req.user.id, stripeCustomerId: { $exists: true, $ne: null } }, { sort: { createdAt: -1 } });
    const stripeCustomerId = typeof existingCustomer?.stripeCustomerId === 'string' && existingCustomer.stripeCustomerId.length > 0
        ? existingCustomer.stripeCustomerId
        : (await stripe.customers.create({ email: currentUser.email, metadata: { userId: currentUser._id } })).id;
    const frontendBase = getFrontendBaseUrl(req);
    const termsUrl = `${frontendBase}/terms-and-conditions`;
    const successUrl = `${frontendBase}/`;
    const cancelUrl = `${frontendBase}/`;
    const commonMetadata = {
        userId: req.user.id,
        planId: String(planId),
        billingCycle: normalizedCycle,
        setupFeeCharged: shouldChargeSetupFee ? 'true' : 'false',
        setupFeeAmount: shouldChargeSetupFee ? String(planSetupFee) : '0',
        termsUrl
    };
    const session = normalizedCycle === 'one_month'
        ? await stripe.checkout.sessions.create({
            customer: stripeCustomerId,
            mode: 'payment',
            line_items: [
                {
                    price_data: {
                        currency: 'gbp',
                        unit_amount: Math.round(Number(toNullableNumberOrDefault(plan.priceOneMonth ?? plan.price, 0) || 0) * 100),
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
                    price: normalizedCycle === 'yearly' ? plan.stripePriceIdYearly : plan.stripePriceId,
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
                    userId: req.user.id,
                    planId: String(planId),
                    billingCycle: normalizedCycle
                }
            }
        });
    res.json({ url: session.url });
});
app.post('/stripe/webhook', async (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
        return res.status(500).send('Stripe webhook not configured');
    }
    const sig = req.header('stripe-signature');
    if (!sig)
        return res.status(400).send('Missing stripe-signature');
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
    }
    catch (err) {
        return res.status(400).send(`Webhook Error: ${err?.message || String(err)}`);
    }
    if (event.type !== 'checkout.session.completed') {
        return res.json({ received: true });
    }
    const session = event.data.object;
    const userId = String((session.metadata || {}).userId || '');
    const planId = String((session.metadata || {}).planId || '');
    const billingCycleRaw = String((session.metadata || {}).billingCycle || '');
    const billingCycle = billingCycleRaw === 'one_month' || billingCycleRaw === 'yearly' || billingCycleRaw === 'monthly'
        ? billingCycleRaw
        : 'monthly';
    const setupFeeCharged = String((session.metadata || {}).setupFeeCharged || '').toLowerCase() === 'true';
    const setupFeeAmount = Number((session.metadata || {}).setupFeeAmount || 0) || 0;
    const termsUrl = String((session.metadata || {}).termsUrl || '');
    if (!userId || !planId)
        return res.json({ received: true });
    const stripePaymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null;
    if (stripePaymentIntentId) {
        const existingPayment = await paymentsCollection().findOne({ stripePaymentIntentId });
        if (existingPayment)
            return res.json({ received: true });
    }
    const stripeSubscriptionId = typeof session.subscription === 'string' ? session.subscription : null;
    if (stripeSubscriptionId) {
        const existing = await subsCollection().findOne({ stripeSubscriptionId });
        if (existing)
            return res.json({ received: true });
    }
    const plan = await plansCollection().findOne({ _id: planId });
    const user = await usersCollection().findOne({ _id: userId });
    if (!plan || !user)
        return res.json({ received: true });
    const nowMs = Date.now();
    const activeStatuses = ['active', 'trial', 'past_due'];
    const activeSubs = await subsCollection()
        .find({ userId, status: { $in: activeStatuses } })
        .sort({ currentPeriodEnd: -1 })
        .toArray();
    const currentActive = activeSubs[0] || null;
    const currentActiveEndMs = currentActive?.currentPeriodEnd?.getTime?.() ?? NaN;
    const remainingMs = currentActive && Number.isFinite(currentActiveEndMs) && currentActiveEndMs > nowMs ? currentActiveEndMs - nowMs : 0;
    if (activeSubs.length > 0) {
        await subsCollection().updateMany({ userId, status: { $in: activeStatuses } }, { $set: { status: 'cancelled', cancelAtPeriodEnd: false, currentPeriodEnd: new Date(), updatedAt: new Date() } });
    }
    const stripeSub = stripeSubscriptionId ? await stripe.subscriptions.retrieve(stripeSubscriptionId) : null;
    const stripeStartMs = stripeSub?.current_period_start ? stripeSub.current_period_start * 1000 : nowMs;
    const stripeEndMs = stripeSub?.current_period_end ? stripeSub.current_period_end * 1000 : nowMs;
    const startDate = new Date(stripeStartMs);
    const endDate = billingCycle === 'one_month' && !stripeSub
        ? (() => {
            const d = new Date(startDate);
            d.setMonth(d.getMonth() + 1);
            if (remainingMs > 0)
                d.setTime(d.getTime() + remainingMs);
            return d;
        })()
        : new Date(stripeEndMs + remainingMs);
    const mappedStatus = stripeSub?.status === 'trialing'
        ? 'trial'
        : stripeSub?.status === 'past_due'
            ? 'past_due'
            : stripeSub?.status === 'active'
                ? 'active'
                : 'active';
    const now = new Date();
    const subscription = {
        _id: crypto_1.default.randomUUID(),
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
    await subsCollection().insertOne(subscription);
    const amountTotal = typeof session.amount_total === 'number' ? session.amount_total : null;
    const currency = typeof session.currency === 'string' ? session.currency.toUpperCase() : 'GBP';
    if (amountTotal !== null) {
        const payment = {
            _id: crypto_1.default.randomUUID(),
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
        await paymentsCollection().insertOne(payment);
    }
    const frontendBase = getFrontendBaseUrl(req);
    const finalTermsUrl = termsUrl || `${frontendBase}/terms-and-conditions`;
    const pickNumber = (value) => (typeof value === 'number' ? value : Number(value || 0) || 0);
    const planPrice = billingCycle === 'one_month'
        ? pickNumber(plan.priceOneMonth ?? plan.price)
        : billingCycle === 'yearly'
            ? pickNumber(plan.priceYearly ?? plan.price)
            : pickNumber(plan.price);
    const emailEvent = {
        id: crypto_1.default.randomUUID(),
        type: 'subscriptions.paid',
        version: 1,
        source: 'billing-service',
        occurredAt: new Date().toISOString(),
        payload: {
            userId,
            planId,
            planName: String(plan.name || ''),
            planDescription: String(plan.description || ''),
            planFeatures: Array.isArray(plan.features) ? plan.features.map((f) => String(f)) : [],
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
app.get('/subscriptions/me', authenticate, async (req, res) => {
    const sub = await subsCollection().findOne({ userId: req.user.id }, { sort: { currentPeriodEnd: -1 } });
    if (!sub)
        return res.json(null);
    const now = Date.now();
    const endMs = sub.currentPeriodEnd?.getTime?.() ?? Date.parse(String(sub.currentPeriodEnd || ''));
    const shouldExpire = sub.status === 'active' && Number.isFinite(endMs) && endMs < now;
    if (shouldExpire) {
        await subsCollection().updateOne({ _id: sub._id }, { $set: { status: 'expired', updatedAt: new Date() } });
        const updated = await subsCollection().findOne({ _id: sub._id });
        if (updated)
            return res.json(toSubResponse(updated));
    }
    res.json(toSubResponse(sub));
});
app.get('/subscriptions', authenticate, requireAdmin, async (req, res) => {
    const filter = {};
    if (typeof req.query.userId === 'string')
        filter.userId = req.query.userId;
    if (typeof req.query.status === 'string' && isValidStatus(req.query.status))
        filter.status = req.query.status;
    const subs = await subsCollection().find(filter).sort({ createdAt: -1 }).toArray();
    res.json(subs.map(toSubResponse));
});
app.post('/subscriptions/grant', authenticate, requireAdmin, [(0, express_validator_1.body)('userId').isLength({ min: 1 }), (0, express_validator_1.body)('planId').isLength({ min: 1 }), (0, express_validator_1.body)('durationMonths').optional().isInt({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const { userId, planId, durationMonths } = req.body;
    const targetUser = await usersCollection().findOne({ _id: String(userId) });
    if (!targetUser)
        return res.status(404).json({ error: 'User not found' });
    const plan = await plansCollection().findOne({ _id: String(planId) });
    if (!plan)
        return res.status(404).json({ error: 'Plan not found' });
    const monthsRaw = typeof durationMonths === 'number' ? durationMonths : Number(durationMonths);
    const months = Number.isFinite(monthsRaw) && monthsRaw > 0 ? Math.floor(monthsRaw) : 1;
    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + months);
    const existingSub = await subsCollection().findOne({ userId: String(userId) }, { sort: { currentPeriodEnd: -1 } });
    const existingEndMs = existingSub?.currentPeriodEnd?.getTime?.() ?? NaN;
    const remainingMs = existingSub && existingSub.status === 'active' && Number.isFinite(existingEndMs) && existingEndMs > now.getTime()
        ? existingEndMs - now.getTime()
        : 0;
    if (remainingMs > 0) {
        end.setTime(end.getTime() + remainingMs);
    }
    const subscription = existingSub
        ? {
            ...existingSub,
            planId: String(planId),
            status: 'active',
            currentPeriodStart: now,
            currentPeriodEnd: end,
            cancelAtPeriodEnd: false,
            grantedByAdmin: true,
            grantedBy: req.user.id,
            setupFeeCharged: false,
            setupFeeAmount: 0,
            updatedAt: now
        }
        : {
            _id: crypto_1.default.randomUUID(),
            userId: String(userId),
            planId: String(planId),
            status: 'active',
            stripeCustomerId: undefined,
            stripeSubscriptionId: undefined,
            currentPeriodStart: now,
            currentPeriodEnd: end,
            cancelAtPeriodEnd: false,
            grantedByAdmin: true,
            grantedBy: req.user.id,
            setupFeeCharged: false,
            setupFeeAmount: 0,
            createdAt: now,
            updatedAt: now
        };
    if (existingSub) {
        await subsCollection().updateOne({ _id: existingSub._id }, { $set: subscription });
    }
    else {
        await subsCollection().insertOne(subscription);
    }
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'subscriptions.granted',
        version: 1,
        source: 'billing-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { subscriptionId: subscription._id, userId: subscription.userId, planId: subscription.planId, grantedBy: req.user.id }
    };
    await eventBus.publish('subscriptions.granted', event);
    res.status(201).json(toSubResponse(subscription));
});
app.post('/subscriptions/me', authenticate, [(0, express_validator_1.body)('planId').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const { planId } = req.body;
    const plan = await plansCollection().findOne({ _id: planId, active: true });
    if (!plan)
        return res.status(400).json({ error: 'Invalid planId' });
    const cfg = await customConfigCollection().findOne({});
    const setupFeeEnabled = cfg?.setupFeeEnabled !== false;
    const hasPaidSetupFeeCount = await subsCollection().countDocuments({ userId: req.user.id, setupFeeCharged: true });
    const canChargeSetupFee = hasPaidSetupFeeCount === 0;
    const planSetupFee = Number(toNullableNumberOrDefault(plan.setupFee, 0) || 0);
    const shouldChargeSetupFee = setupFeeEnabled && canChargeSetupFee && planSetupFee > 0;
    const now = new Date();
    const activeStatuses = ['active', 'trial', 'past_due'];
    const activeSubs = await subsCollection()
        .find({ userId: req.user.id, status: { $in: activeStatuses } })
        .sort({ currentPeriodEnd: -1 })
        .toArray();
    const currentActive = activeSubs[0] || null;
    const currentActiveEndMs = currentActive?.currentPeriodEnd?.getTime?.() ?? NaN;
    const remainingMs = currentActive && Number.isFinite(currentActiveEndMs) && currentActiveEndMs > now.getTime()
        ? currentActiveEndMs - now.getTime()
        : 0;
    if (activeSubs.length > 0) {
        await subsCollection().updateMany({ userId: req.user.id, status: { $in: activeStatuses } }, { $set: { status: 'cancelled', cancelAtPeriodEnd: false, currentPeriodEnd: now, updatedAt: now } });
    }
    const end = new Date(now);
    end.setMonth(end.getMonth() + 1);
    if (remainingMs > 0) {
        end.setTime(end.getTime() + remainingMs);
    }
    const subscription = {
        _id: crypto_1.default.randomUUID(),
        userId: req.user.id,
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
    await subsCollection().insertOne(subscription);
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'subscriptions.created',
        version: 1,
        source: 'billing-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { subscriptionId: subscription._id, userId: subscription.userId, planId: subscription.planId }
    };
    await eventBus.publish('subscriptions.created', event);
    res.status(201).json(toSubResponse(subscription));
});
app.post('/subscriptions/:id/cancel', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const id = req.params.id;
    const existing = await subsCollection().findOne({ _id: id });
    if (!existing)
        return res.status(404).json({ error: 'Subscription not found' });
    if (role !== 'admin' && existing.userId !== req.user.id)
        return res.status(403).json({ error: 'Insufficient permissions' });
    const now = new Date();
    const updates = role === 'admin'
        ? { status: 'cancelled', cancelAtPeriodEnd: false, currentPeriodEnd: now, updatedAt: now }
        : { cancelAtPeriodEnd: true, updatedAt: now };
    const result = await subsCollection().updateOne({ _id: id }, { $set: updates });
    if (result.matchedCount === 0)
        return res.status(404).json({ error: 'Subscription not found' });
    const updated = await subsCollection().findOne({ _id: id });
    if (!updated)
        return res.status(404).json({ error: 'Subscription not found' });
    const event = {
        id: crypto_1.default.randomUUID(),
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
app.get('/payments/me', authenticate, async (req, res) => {
    const payments = await paymentsCollection().find({ userId: req.user.id }).sort({ paymentDate: -1 }).toArray();
    res.json(payments.map(toPaymentResponse));
});
app.get('/payments', authenticate, requireAdmin, async (req, res) => {
    const filter = {};
    if (typeof req.query.userId === 'string')
        filter.userId = req.query.userId;
    if (typeof req.query.status === 'string' && isValidPaymentStatus(req.query.status))
        filter.status = req.query.status;
    const payments = await paymentsCollection().find(filter).sort({ paymentDate: -1 }).toArray();
    res.json(payments.map(toPaymentResponse));
});
app.post('/payments', authenticate, requireAdmin, [(0, express_validator_1.body)('userId').isLength({ min: 1 }), (0, express_validator_1.body)('amount').isNumeric(), (0, express_validator_1.body)('status').isString()], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const payload = req.body;
    if (!isValidPaymentStatus(payload.status))
        return res.status(400).json({ error: 'Invalid status' });
    const now = new Date();
    const payment = {
        _id: crypto_1.default.randomUUID(),
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
    await paymentsCollection().insertOne(payment);
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'payments.created',
        version: 1,
        source: 'billing-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { paymentId: payment._id, userId: payment.userId, status: payment.status }
    };
    await eventBus.publish('payments.created', event);
    res.status(201).json(toPaymentResponse(payment));
});
app.get('/custom-plan-config', authenticate, async (_req, res) => {
    const config = await customConfigCollection().findOne({});
    if (!config)
        return res.json(null);
    res.json(toConfigResponse(config));
});
app.put('/custom-plan-config', authenticate, requireAdmin, [
    (0, express_validator_1.body)('jobPrice').optional().isNumeric(),
    (0, express_validator_1.body)('productPrice').optional().isNumeric(),
    (0, express_validator_1.body)('emailPrice').optional().isNumeric(),
    (0, express_validator_1.body)('userPrice').optional().isNumeric(),
    (0, express_validator_1.body)('storagePrice').optional().isNumeric(),
    (0, express_validator_1.body)('bannerDaysBeforeExpiry').optional().isInt({ min: 0 }),
    (0, express_validator_1.body)('setupFeeEnabled').optional().isBoolean()
], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const payload = req.body;
    const now = new Date();
    const existing = await customConfigCollection().findOne({});
    const base = existing
        ? { ...existing, ...payload, setupFeeEnabled: payload.setupFeeEnabled ?? existing.setupFeeEnabled ?? true, updatedAt: now }
        : {
            _id: crypto_1.default.randomUUID(),
            jobPrice: typeof payload.jobPrice === 'number' ? payload.jobPrice : 0,
            productPrice: typeof payload.productPrice === 'number' ? payload.productPrice : 0,
            emailPrice: typeof payload.emailPrice === 'number' ? payload.emailPrice : 0,
            userPrice: typeof payload.userPrice === 'number' ? payload.userPrice : 0,
            storagePrice: typeof payload.storagePrice === 'number' ? payload.storagePrice : 0,
            bannerDaysBeforeExpiry: typeof payload.bannerDaysBeforeExpiry === 'number' ? payload.bannerDaysBeforeExpiry : null,
            setupFeeEnabled: payload.setupFeeEnabled ?? true,
            createdAt: now,
            updatedAt: now
        };
    await customConfigCollection().updateOne({ _id: base._id }, { $set: base }, { upsert: true });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'customPlanConfig.updated',
        version: 1,
        source: 'billing-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { configId: base._id }
    };
    await eventBus.publish('customPlanConfig.updated', event);
    res.json(toConfigResponse(base));
});
app.listen(PORT, '0.0.0.0', async () => {
    await mongo.connect();
    await eventBus.connect();
});
