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
const PORT = parseInt(process.env.PORT || '4009', 10);
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
    serviceName: 'notifications-service'
});
const notificationsCollection = () => mongo.db('blindscloud').collection('notifications');
const pushSubscriptionsCollection = () => mongo.db('blindscloud').collection('push_subscriptions');
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
const toNotificationResponse = (n) => ({
    ...n,
    createdAt: n.createdAt.toISOString()
});
const toSubscriptionResponse = (s) => ({
    ...s,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt?.toISOString()
});
const isValidNotificationType = (value) => {
    return [
        'reminder',
        'job',
        'system',
        'job_assigned',
        'job_accepted',
        'job_cancelled',
        'job_completed',
        'quotation_sent',
        'receipt_sent',
        'followup_sent'
    ].includes(String(value));
};
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '2mb' }));
app.use((0, helmet_1.default)());
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'notifications-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
app.get('/notifications', authenticate, async (req, res) => {
    const onlyUnread = req.query.unread === 'true';
    const filter = { userId: req.user.id };
    if (onlyUnread)
        filter.read = false;
    const notifications = await notificationsCollection().find(filter).sort({ createdAt: -1 }).limit(200).toArray();
    res.json(notifications.map(toNotificationResponse));
});
app.post('/notifications', authenticate, requireAdmin, [(0, express_validator_1.body)('userId').isLength({ min: 1 }), (0, express_validator_1.body)('title').isLength({ min: 1 }), (0, express_validator_1.body)('message').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const payload = req.body;
    const type = payload.type && isValidNotificationType(payload.type) ? payload.type : 'system';
    const notification = {
        _id: crypto_1.default.randomUUID(),
        userId: payload.userId,
        title: payload.title,
        message: payload.message,
        type,
        read: false,
        metadata: payload.metadata || {},
        createdAt: new Date()
    };
    await notificationsCollection().insertOne(notification);
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'notifications.created',
        version: 1,
        source: 'notifications-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { notificationId: notification._id, userId: notification.userId, type: notification.type }
    };
    await eventBus.publish('notifications.created', event);
    res.status(201).json(toNotificationResponse(notification));
});
app.post('/notifications/:id/read', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const id = req.params.id;
    const existing = await notificationsCollection().findOne({ _id: id, userId: req.user.id });
    if (!existing)
        return res.status(404).json({ error: 'Notification not found' });
    await notificationsCollection().updateOne({ _id: id }, { $set: { read: true } });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'notifications.read',
        version: 1,
        source: 'notifications-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { notificationId: id, userId: req.user.id }
    };
    await eventBus.publish('notifications.read', event);
    res.json({ status: 'OK' });
});
app.delete('/notifications/:id', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const id = req.params.id;
    const existing = await notificationsCollection().findOne({ _id: id, userId: req.user.id });
    if (!existing)
        return res.status(404).json({ error: 'Notification not found' });
    await notificationsCollection().deleteOne({ _id: id });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'notifications.deleted',
        version: 1,
        source: 'notifications-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { notificationId: id, userId: req.user.id }
    };
    await eventBus.publish('notifications.deleted', event);
    res.json({ status: 'OK' });
});
app.get('/push-subscriptions', authenticate, async (req, res) => {
    const subs = await pushSubscriptionsCollection().find({ userId: req.user.id }).sort({ createdAt: -1 }).toArray();
    res.json(subs.map(toSubscriptionResponse));
});
app.post('/push-subscriptions', authenticate, [(0, express_validator_1.body)('endpoint').isLength({ min: 1 }), (0, express_validator_1.body)('keys').isObject()], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const payload = req.body;
    const now = new Date();
    const subscription = {
        _id: crypto_1.default.randomUUID(),
        userId: req.user.id,
        endpoint: String(payload.endpoint || ''),
        keys: payload.keys || {},
        createdAt: now,
        updatedAt: now
    };
    await pushSubscriptionsCollection().updateOne({ userId: subscription.userId, endpoint: subscription.endpoint }, { $set: subscription }, { upsert: true });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'pushSubscriptions.upserted',
        version: 1,
        source: 'notifications-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { userId: subscription.userId, endpoint: subscription.endpoint }
    };
    await eventBus.publish('pushSubscriptions.upserted', event);
    res.status(201).json(toSubscriptionResponse(subscription));
});
app.delete('/push-subscriptions/:id', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const id = req.params.id;
    const existing = await pushSubscriptionsCollection().findOne({ _id: id, userId: req.user.id });
    if (!existing)
        return res.status(404).json({ error: 'Subscription not found' });
    await pushSubscriptionsCollection().deleteOne({ _id: id });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'pushSubscriptions.deleted',
        version: 1,
        source: 'notifications-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { userId: existing.userId, endpoint: existing.endpoint }
    };
    await eventBus.publish('pushSubscriptions.deleted', event);
    res.json({ status: 'OK' });
});
app.listen(PORT, '0.0.0.0', async () => {
    await mongo.connect();
    await eventBus.connect();
});
