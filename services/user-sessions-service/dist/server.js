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
const PORT = parseInt(process.env.PORT || '4017', 10);
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
    serviceName: 'user-sessions-service'
});
const sessionsCollection = () => mongo.db('blindscloud').collection('user_sessions');
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
    if (req.user?.role?.toLowerCase() === 'admin')
        return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
};
const toResponse = (s) => ({
    ...s,
    expiresAt: s.expiresAt.toISOString(),
    createdAt: s.createdAt.toISOString()
});
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '1mb' }));
app.use((0, helmet_1.default)());
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'user-sessions-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
app.get('/sessions/me', authenticate, async (req, res) => {
    const docs = await sessionsCollection().find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50).toArray();
    res.json(docs.map(toResponse));
});
app.get('/sessions', authenticate, requireAdmin, async (req, res) => {
    const filter = {};
    if (typeof req.query.userId === 'string')
        filter.userId = req.query.userId;
    const docs = await sessionsCollection().find(filter).sort({ createdAt: -1 }).limit(200).toArray();
    res.json(docs.map(toResponse));
});
app.post('/sessions', authenticate, [(0, express_validator_1.body)('ttlHours').optional().isNumeric()], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const ttlHours = typeof req.body.ttlHours === 'number' ? req.body.ttlHours : Number(req.body.ttlHours);
    const ttl = Number.isFinite(ttlHours) ? Math.min(Math.max(ttlHours, 1), 24 * 30) : 24 * 7;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 60 * 60 * 1000);
    const session = {
        _id: crypto_1.default.randomUUID(),
        userId: req.user.id,
        sessionToken: crypto_1.default.randomBytes(32).toString('hex'),
        expiresAt,
        createdAt: now
    };
    await sessionsCollection().insertOne(session);
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'userSessions.created',
        version: 1,
        source: 'user-sessions-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { sessionId: session._id, userId: session.userId }
    };
    await eventBus.publish('userSessions.created', event);
    res.status(201).json(toResponse(session));
});
app.delete('/sessions/me', authenticate, async (req, res) => {
    const docs = await sessionsCollection().find({ userId: req.user.id }).project({ _id: 1 }).toArray();
    await sessionsCollection().deleteMany({ userId: req.user.id });
    for (const doc of docs) {
        const event = {
            id: crypto_1.default.randomUUID(),
            type: 'userSessions.deleted',
            version: 1,
            source: 'user-sessions-service',
            occurredAt: new Date().toISOString(),
            correlationId: req.header('x-correlation-id') || undefined,
            payload: { sessionId: doc._id, userId: req.user.id }
        };
        await eventBus.publish('userSessions.deleted', event);
    }
    res.json({ status: 'OK' });
});
app.delete('/sessions/:id', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const existing = await sessionsCollection().findOne({ _id: req.params.id });
    if (!existing)
        return res.status(404).json({ error: 'Session not found' });
    if (role !== 'admin' && existing.userId !== req.user.id)
        return res.status(403).json({ error: 'Insufficient permissions' });
    await sessionsCollection().deleteOne({ _id: existing._id });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'userSessions.deleted',
        version: 1,
        source: 'user-sessions-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { sessionId: existing._id, userId: existing.userId }
    };
    await eventBus.publish('userSessions.deleted', event);
    res.json({ status: 'OK' });
});
app.listen(PORT, '0.0.0.0', async () => {
    await mongo.connect();
    await eventBus.connect();
});
