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
const PORT = parseInt(process.env.PORT || '4007', 10);
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
    serviceName: 'pricing-service'
});
const usersCollection = () => mongo.db('blindscloud').collection('users');
const pricingTablesCollection = () => mongo.db('blindscloud').collection('pricing_tables');
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
const requireAdminOrBusiness = (req, res, next) => {
    const role = req.user?.role?.toLowerCase();
    if (role === 'admin' || role === 'business')
        return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
};
const getCurrentUser = async (req) => {
    return usersCollection().findOne({ _id: req.user.id });
};
const canAccessBusiness = (role, currentUser, businessId) => {
    if (role === 'admin')
        return true;
    return Boolean(currentUser.businessId && currentUser.businessId === businessId);
};
const toPricingResponse = (t) => ({
    ...t,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt?.toISOString()
});
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '4mb' }));
app.use((0, helmet_1.default)());
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'pricing-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
app.get('/pricing-tables', authenticate, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const filter = {};
    if (role !== 'admin') {
        filter.businessId = currentUser.businessId;
    }
    else if (req.query.businessId && typeof req.query.businessId === 'string') {
        filter.businessId = req.query.businessId;
    }
    const tables = await pricingTablesCollection().find(filter).sort({ createdAt: -1 }).toArray();
    res.json(tables.map(toPricingResponse));
});
app.get('/pricing-tables/default', authenticate, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const businessId = role === 'admin' && typeof req.query.businessId === 'string' ? req.query.businessId : currentUser.businessId;
    if (!businessId)
        return res.json(null);
    const table = await pricingTablesCollection().findOne({ businessId, isDefault: true });
    if (!table)
        return res.json(null);
    res.json(toPricingResponse(table));
});
app.get('/pricing-tables/:id', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const table = await pricingTablesCollection().findOne({ _id: req.params.id });
    if (!table)
        return res.status(404).json({ error: 'Pricing table not found' });
    if (!canAccessBusiness(role, currentUser, table.businessId))
        return res.status(403).json({ error: 'Insufficient permissions' });
    res.json(toPricingResponse(table));
});
app.post('/pricing-tables', authenticate, requireAdminOrBusiness, [(0, express_validator_1.body)('name').isLength({ min: 1 }), (0, express_validator_1.body)('unitSystem').isString(), (0, express_validator_1.body)('businessId').optional().isString()], async (req, res) => {
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
    if (!canAccessBusiness(role, currentUser, businessId))
        return res.status(403).json({ error: 'Insufficient permissions' });
    const now = new Date();
    const table = {
        _id: crypto_1.default.randomUUID(),
        businessId,
        name: String(payload.name || ''),
        unitSystem: (payload.unitSystem || 'inches'),
        widthValues: Array.isArray(payload.widthValues) ? payload.widthValues : [],
        dropValues: Array.isArray(payload.dropValues) ? payload.dropValues : [],
        priceMatrix: Array.isArray(payload.priceMatrix) ? payload.priceMatrix : [],
        metadata: payload.metadata || {},
        isDefault: Boolean(payload.isDefault),
        createdAt: now,
        updatedAt: now
    };
    if (table.isDefault) {
        await pricingTablesCollection().updateMany({ businessId }, { $set: { isDefault: false } });
    }
    await pricingTablesCollection().insertOne(table);
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'pricingTables.created',
        version: 1,
        source: 'pricing-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { pricingTableId: table._id, businessId: table.businessId }
    };
    await eventBus.publish('pricingTables.created', event);
    res.status(201).json(toPricingResponse(table));
});
app.put('/pricing-tables/:id', authenticate, requireAdminOrBusiness, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const id = req.params.id;
    const existing = await pricingTablesCollection().findOne({ _id: id });
    if (!existing)
        return res.status(404).json({ error: 'Pricing table not found' });
    if (!canAccessBusiness(role, currentUser, existing.businessId))
        return res.status(403).json({ error: 'Insufficient permissions' });
    const updates = req.body;
    delete updates._id;
    delete updates.createdAt;
    delete updates.businessId;
    updates.updatedAt = new Date();
    if (updates.isDefault) {
        await pricingTablesCollection().updateMany({ businessId: existing.businessId }, { $set: { isDefault: false } });
    }
    const result = await pricingTablesCollection().updateOne({ _id: id }, { $set: updates });
    if (result.matchedCount === 0)
        return res.status(404).json({ error: 'Pricing table not found' });
    const updated = await pricingTablesCollection().findOne({ _id: id });
    if (!updated)
        return res.status(404).json({ error: 'Pricing table not found' });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'pricingTables.updated',
        version: 1,
        source: 'pricing-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { pricingTableId: id }
    };
    await eventBus.publish('pricingTables.updated', event);
    res.json(toPricingResponse(updated));
});
app.delete('/pricing-tables/:id', authenticate, requireAdminOrBusiness, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const id = req.params.id;
    const existing = await pricingTablesCollection().findOne({ _id: id });
    if (!existing)
        return res.status(404).json({ error: 'Pricing table not found' });
    if (!canAccessBusiness(role, currentUser, existing.businessId))
        return res.status(403).json({ error: 'Insufficient permissions' });
    await pricingTablesCollection().deleteOne({ _id: id });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'pricingTables.deleted',
        version: 1,
        source: 'pricing-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { pricingTableId: id, businessId: existing.businessId }
    };
    await eventBus.publish('pricingTables.deleted', event);
    res.json({ status: 'OK' });
});
app.listen(PORT, '0.0.0.0', async () => {
    await mongo.connect();
    await eventBus.connect();
});
