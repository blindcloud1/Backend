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
const PORT = parseInt(process.env.PORT || '4015', 10);
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
    serviceName: 'model-permissions-service'
});
const usersCollection = () => mongo.db('blindscloud').collection('users');
const modelPermissionsCollection = () => mongo.db('blindscloud').collection('model_permissions');
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
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '1mb' }));
app.use((0, helmet_1.default)());
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'model-permissions-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
app.get('/model-permissions', authenticate, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const filter = {};
    if (role === 'admin') {
        if (typeof req.query.businessId === 'string')
            filter.businessId = req.query.businessId;
    }
    else {
        if (!currentUser.businessId)
            return res.json([]);
        filter.businessId = currentUser.businessId;
    }
    const docs = await modelPermissionsCollection().find(filter).sort({ grantedAt: -1 }).toArray();
    res.json(docs.map(d => ({ ...d, grantedAt: d.grantedAt.toISOString() })));
});
app.put('/model-permissions', authenticate, [(0, express_validator_1.body)('businessId').optional().isString(), (0, express_validator_1.body)('canView3dModels').isBoolean(), (0, express_validator_1.body)('canUseInAr').isBoolean()], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const payload = req.body;
    const businessId = role === 'admin' ? String(payload.businessId || '') : String(currentUser.businessId || '');
    if (!businessId)
        return res.status(400).json({ error: 'businessId is required' });
    if (role !== 'admin' && businessId !== currentUser.businessId)
        return res.status(403).json({ error: 'Insufficient permissions' });
    if (role !== 'admin' && role !== 'business')
        return res.status(403).json({ error: 'Insufficient permissions' });
    const now = new Date();
    const doc = {
        _id: crypto_1.default.randomUUID(),
        businessId,
        canView3dModels: Boolean(payload.canView3dModels),
        canUseInAr: Boolean(payload.canUseInAr),
        grantedBy: req.user.id,
        grantedAt: now
    };
    await modelPermissionsCollection().updateOne({ businessId }, { $set: doc }, { upsert: true });
    const updated = await modelPermissionsCollection().findOne({ businessId });
    if (!updated)
        return res.status(500).json({ error: 'Failed to persist permission' });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'modelPermissions.updated',
        version: 1,
        source: 'model-permissions-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { businessId: updated.businessId, canView3dModels: updated.canView3dModels, canUseInAr: updated.canUseInAr }
    };
    await eventBus.publish('modelPermissions.updated', event);
    res.json({ ...updated, grantedAt: updated.grantedAt.toISOString() });
});
app.listen(PORT, '0.0.0.0', async () => {
    await mongo.connect();
    await eventBus.connect();
});
