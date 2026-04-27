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
const event_bus_1 = require("@blindscloud/event-bus");
dotenv_1.default.config();
const PORT = parseInt(process.env.PORT || '4008', 10);
const JWT_SECRET = process.env.JWT_SECRET || '';
const MONGO_URL = process.env.MONGO_URL || '';
const RABBITMQ_URL = process.env.RABBITMQ_URL || '';
const EVENT_EXCHANGE = process.env.EVENT_EXCHANGE || 'blindscloud.events';
if (!JWT_SECRET)
    throw new Error('JWT_SECRET is required');
if (!MONGO_URL)
    throw new Error('MONGO_URL is required');
if (!RABBITMQ_URL)
    throw new Error('RABBITMQ_URL is required');
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
app.use(express_1.default.json({ limit: '2mb' }));
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
app.get('/subscription-plans', authenticate, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const includeInactive = req.query.includeInactive === 'true';
    const filter = includeInactive && role === 'admin' ? {} : { active: true };
    const plans = await plansCollection().find(filter).sort({ price: 1 }).toArray();
    res.json(plans.map(toPlanResponse));
});
app.post('/subscription-plans', authenticate, requireAdmin, [(0, express_validator_1.body)('name').isLength({ min: 1 }), (0, express_validator_1.body)('price').isNumeric()], async (req, res) => {
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
app.get('/subscriptions/me', authenticate, async (req, res) => {
    const sub = await subsCollection().findOne({ userId: req.user.id }, { sort: { currentPeriodEnd: -1 } });
    if (!sub)
        return res.json(null);
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
    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + 1);
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
    const updates = { cancelAtPeriodEnd: true, updatedAt: new Date() };
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
app.get('/custom-plan-config', authenticate, requireAdmin, async (_req, res) => {
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
    (0, express_validator_1.body)('bannerDaysBeforeExpiry').optional().isInt({ min: 0 })
], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const payload = req.body;
    const now = new Date();
    const existing = await customConfigCollection().findOne({});
    const base = existing
        ? { ...existing, ...payload, updatedAt: now }
        : {
            _id: crypto_1.default.randomUUID(),
            jobPrice: typeof payload.jobPrice === 'number' ? payload.jobPrice : 0,
            productPrice: typeof payload.productPrice === 'number' ? payload.productPrice : 0,
            emailPrice: typeof payload.emailPrice === 'number' ? payload.emailPrice : 0,
            userPrice: typeof payload.userPrice === 'number' ? payload.userPrice : 0,
            storagePrice: typeof payload.storagePrice === 'number' ? payload.storagePrice : 0,
            bannerDaysBeforeExpiry: typeof payload.bannerDaysBeforeExpiry === 'number' ? payload.bannerDaysBeforeExpiry : null,
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
