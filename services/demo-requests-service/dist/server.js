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
const PORT = parseInt(process.env.PORT || '4012', 10);
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
    serviceName: 'demo-requests-service'
});
const demoRequestsCollection = () => mongo.db('blindscloud').collection('demo_requests');
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
const isBusinessSize = (value) => {
    return ['small', 'medium', 'large'].includes(String(value));
};
const toResponse = (d) => ({ ...d, createdAt: d.createdAt.toISOString() });
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '1mb' }));
app.use((0, helmet_1.default)());
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'demo-requests-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
app.post('/demo-requests', [(0, express_validator_1.body)('name').isLength({ min: 1 }), (0, express_validator_1.body)('businessSize').isString(), (0, express_validator_1.body)('email').isEmail().normalizeEmail()], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const payload = req.body;
    if (!isBusinessSize(payload.businessSize))
        return res.status(400).json({ error: 'Invalid businessSize' });
    const doc = {
        _id: crypto_1.default.randomUUID(),
        name: String(payload.name || ''),
        companyName: payload.companyName,
        businessSize: payload.businessSize,
        phone: payload.phone,
        email: String(payload.email || '').toLowerCase(),
        createdAt: new Date()
    };
    await demoRequestsCollection().insertOne(doc);
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'demoRequests.created',
        version: 1,
        source: 'demo-requests-service',
        occurredAt: new Date().toISOString(),
        payload: { demoRequestId: doc._id, email: doc.email }
    };
    await eventBus.publish('demoRequests.created', event);
    res.status(201).json(toResponse(doc));
});
app.get('/demo-requests', authenticate, requireAdmin, async (_req, res) => {
    const docs = await demoRequestsCollection().find({}).sort({ createdAt: -1 }).limit(500).toArray();
    res.json(docs.map(toResponse));
});
app.listen(PORT, '0.0.0.0', async () => {
    await mongo.connect();
    await eventBus.connect();
});
