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
const PORT = parseInt(process.env.PORT || '4014', 10);
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
    serviceName: 'models3d-service'
});
const modelsCollection = () => mongo.db('blindscloud').collection('models_3d');
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
const canManage = (req, doc) => {
    if (req.user.role.toLowerCase() === 'admin')
        return true;
    return Boolean(doc.createdBy && doc.createdBy === req.user.id);
};
const isStatus = (value) => {
    return ['processing', 'completed', 'failed'].includes(String(value));
};
const toResponse = (m) => ({
    ...m,
    createdAt: m.createdAt.toISOString()
});
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '2mb' }));
app.use((0, helmet_1.default)());
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'models3d-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
app.get('/models-3d', authenticate, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const filter = {};
    if (role !== 'admin')
        filter.createdBy = req.user.id;
    const docs = await modelsCollection().find(filter).sort({ createdAt: -1 }).limit(200).toArray();
    res.json(docs.map(toResponse));
});
app.get('/models-3d/:id', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const doc = await modelsCollection().findOne({ _id: req.params.id });
    if (!doc)
        return res.status(404).json({ error: 'Model not found' });
    if (!canManage(req, doc) && req.user.role.toLowerCase() !== 'admin')
        return res.status(403).json({ error: 'Insufficient permissions' });
    res.json(toResponse(doc));
});
app.post('/models-3d', authenticate, [(0, express_validator_1.body)('name').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const payload = req.body;
    const doc = {
        _id: crypto_1.default.randomUUID(),
        name: String(payload.name || ''),
        originalImage: payload.originalImage,
        modelUrl: payload.modelUrl,
        thumbnail: payload.thumbnail,
        status: isStatus(payload.status) ? payload.status : 'processing',
        settings: payload.settings || {},
        createdBy: req.user.id,
        createdAt: new Date()
    };
    await modelsCollection().insertOne(doc);
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'models3d.created',
        version: 1,
        source: 'models3d-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { modelId: doc._id, status: doc.status }
    };
    await eventBus.publish('models3d.created', event);
    res.status(201).json(toResponse(doc));
});
app.put('/models-3d/:id', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const existing = await modelsCollection().findOne({ _id: req.params.id });
    if (!existing)
        return res.status(404).json({ error: 'Model not found' });
    if (!canManage(req, existing))
        return res.status(403).json({ error: 'Insufficient permissions' });
    const updates = req.body;
    delete updates._id;
    delete updates.createdAt;
    delete updates.createdBy;
    if (updates.status && !isStatus(updates.status))
        delete updates.status;
    await modelsCollection().updateOne({ _id: existing._id }, { $set: updates });
    const updated = await modelsCollection().findOne({ _id: existing._id });
    if (!updated)
        return res.status(404).json({ error: 'Model not found' });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'models3d.updated',
        version: 1,
        source: 'models3d-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { modelId: updated._id, status: updated.status }
    };
    await eventBus.publish('models3d.updated', event);
    res.json(toResponse(updated));
});
app.delete('/models-3d/:id', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const existing = await modelsCollection().findOne({ _id: req.params.id });
    if (!existing)
        return res.status(404).json({ error: 'Model not found' });
    if (!canManage(req, existing))
        return res.status(403).json({ error: 'Insufficient permissions' });
    await modelsCollection().deleteOne({ _id: existing._id });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'models3d.deleted',
        version: 1,
        source: 'models3d-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { modelId: existing._id }
    };
    await eventBus.publish('models3d.deleted', event);
    res.json({ status: 'OK' });
});
app.listen(PORT, '0.0.0.0', async () => {
    await mongo.connect();
    await eventBus.connect();
});
