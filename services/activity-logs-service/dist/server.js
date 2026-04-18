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
const PORT = parseInt(process.env.PORT || '4016', 10);
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
    serviceName: 'activity-logs-service'
});
const usersCollection = () => mongo.db('blindscloud').collection('users');
const logsCollection = () => mongo.db('blindscloud').collection('activity_logs');
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
const getCurrentUser = async (req) => {
    return usersCollection().findOne({ _id: req.user.id });
};
const toResponse = (l) => ({
    ...l,
    createdAt: l.createdAt.toISOString()
});
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '1mb' }));
app.use((0, helmet_1.default)());
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'activity-logs-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
app.get('/activity-logs', authenticate, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const filter = {};
    if (role === 'admin') {
        if (typeof req.query.userId === 'string')
            filter.userId = req.query.userId;
    }
    else if (role === 'business') {
        if (!currentUser.businessId)
            return res.json([]);
        const users = await usersCollection().find({ businessId: currentUser.businessId }).project({ _id: 1 }).limit(2000).toArray();
        const ids = users.map(u => u._id);
        filter.userId = { $in: ids };
    }
    else {
        filter.userId = currentUser._id;
    }
    const limit = typeof req.query.limit === 'string' ? Math.min(parseInt(req.query.limit, 10) || 200, 500) : 200;
    const docs = await logsCollection().find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
    res.json(docs.map(toResponse));
});
app.post('/activity-logs', authenticate, [(0, express_validator_1.body)('action').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const payload = req.body;
    const doc = {
        _id: crypto_1.default.randomUUID(),
        userId: req.user.id,
        action: String(payload.action || ''),
        targetType: payload.targetType,
        targetId: payload.targetId,
        details: payload.details,
        description: payload.description,
        ipAddress: typeof req.ip === 'string' ? req.ip : undefined,
        userAgent: typeof req.header('user-agent') === 'string' ? String(req.header('user-agent')) : undefined,
        createdAt: new Date()
    };
    await logsCollection().insertOne(doc);
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'activityLogs.created',
        version: 1,
        source: 'activity-logs-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { logId: doc._id, userId: doc.userId, action: doc.action }
    };
    await eventBus.publish('activityLogs.created', event);
    res.status(201).json(toResponse(doc));
});
app.listen(PORT, '0.0.0.0', async () => {
    await mongo.connect();
    await eventBus.connect();
});
