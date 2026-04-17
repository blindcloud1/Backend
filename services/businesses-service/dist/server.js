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
const PORT = parseInt(process.env.PORT || '4003', 10);
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
    serviceName: 'businesses-service'
});
const usersCollection = () => mongo.db('blindscloud').collection('users');
const businessesCollection = () => mongo.db('blindscloud').collection('businesses');
const businessSettingsCollection = () => mongo.db('blindscloud').collection('business_settings');
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
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '2mb' }));
app.use((0, helmet_1.default)());
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'businesses-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
app.get('/businesses', authenticate, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    if (role === 'admin') {
        const all = await businessesCollection().find({}).sort({ createdAt: -1 }).toArray();
        return res.json(all.map(b => ({ ...b, createdAt: b.createdAt.toISOString(), updatedAt: b.updatedAt?.toISOString() })));
    }
    if (!currentUser.businessId)
        return res.json([]);
    const business = await businessesCollection().findOne({ _id: currentUser.businessId });
    if (!business)
        return res.json([]);
    return res.json([{ ...business, createdAt: business.createdAt.toISOString(), updatedAt: business.updatedAt?.toISOString() }]);
});
app.get('/businesses/:id', authenticate, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const businessId = req.params.id;
    if (!canAccessBusiness(role, currentUser, businessId))
        return res.status(403).json({ error: 'Insufficient permissions' });
    const business = await businessesCollection().findOne({ _id: businessId });
    if (!business)
        return res.status(404).json({ error: 'Business not found' });
    return res.json({ ...business, createdAt: business.createdAt.toISOString(), updatedAt: business.updatedAt?.toISOString() });
});
app.post('/businesses', authenticate, requireAdminOrBusiness, [(0, express_validator_1.body)('name').isLength({ min: 1 }), (0, express_validator_1.body)('address').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    if (role !== 'admin')
        return res.status(403).json({ error: 'Insufficient permissions' });
    const payload = req.body;
    const now = new Date();
    const business = {
        _id: crypto_1.default.randomUUID(),
        name: String(payload.name || ''),
        address: String(payload.address || ''),
        phone: payload.phone,
        email: payload.email,
        adminId: payload.adminId,
        features: Array.isArray(payload.features) ? payload.features : [],
        subscription: (payload.subscription || 'basic'),
        vrViewEnabled: Boolean(payload.vrViewEnabled),
        logo: payload.logo,
        createdAt: now,
        updatedAt: now
    };
    await businessesCollection().insertOne(business);
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'businesses.created',
        version: 1,
        source: 'businesses-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { businessId: business._id, name: business.name }
    };
    await eventBus.publish('businesses.created', event);
    res.status(201).json({ ...business, createdAt: business.createdAt.toISOString(), updatedAt: business.updatedAt?.toISOString() });
});
app.put('/businesses/:id', authenticate, requireAdminOrBusiness, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const businessId = req.params.id;
    if (!canAccessBusiness(role, currentUser, businessId))
        return res.status(403).json({ error: 'Insufficient permissions' });
    const updates = req.body;
    delete updates._id;
    delete updates.createdAt;
    updates.updatedAt = new Date();
    const result = await businessesCollection().updateOne({ _id: businessId }, { $set: updates });
    if (result.matchedCount === 0)
        return res.status(404).json({ error: 'Business not found' });
    const updated = await businessesCollection().findOne({ _id: businessId });
    if (!updated)
        return res.status(404).json({ error: 'Business not found' });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'businesses.updated',
        version: 1,
        source: 'businesses-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { businessId }
    };
    await eventBus.publish('businesses.updated', event);
    res.json({ ...updated, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt?.toISOString() });
});
app.get('/businesses/:id/settings', authenticate, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const businessId = req.params.id;
    if (!canAccessBusiness(role, currentUser, businessId))
        return res.status(403).json({ error: 'Insufficient permissions' });
    const settings = await businessSettingsCollection().findOne({ businessId });
    if (!settings)
        return res.json(null);
    res.json({ ...settings, createdAt: settings.createdAt.toISOString(), updatedAt: settings.updatedAt?.toISOString() });
});
app.put('/businesses/:id/settings', authenticate, requireAdminOrBusiness, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const businessId = req.params.id;
    if (!canAccessBusiness(role, currentUser, businessId))
        return res.status(403).json({ error: 'Insufficient permissions' });
    const payload = req.body;
    const now = new Date();
    const existing = await businessSettingsCollection().findOne({ businessId });
    const base = existing
        ? { ...existing, ...payload, updatedAt: now }
        : {
            _id: crypto_1.default.randomUUID(),
            businessId,
            bookingMode: (payload.bookingMode || 'manual'),
            paymentGatewayEnabled: Boolean(payload.paymentGatewayEnabled),
            depositPercentage: typeof payload.depositPercentage === 'number' ? payload.depositPercentage : 30,
            quotationTemplates: Array.isArray(payload.quotationTemplates) ? payload.quotationTemplates : [],
            invoiceTemplates: Array.isArray(payload.invoiceTemplates) ? payload.invoiceTemplates : [],
            createdAt: now,
            updatedAt: now
        };
    await businessSettingsCollection().updateOne({ businessId }, { $set: base }, { upsert: true });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'businessSettings.updated',
        version: 1,
        source: 'businesses-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { businessId }
    };
    await eventBus.publish('businessSettings.updated', event);
    res.json({ ...base, createdAt: base.createdAt.toISOString(), updatedAt: base.updatedAt?.toISOString() });
});
app.listen(PORT, '0.0.0.0', async () => {
    await mongo.connect();
    await eventBus.connect();
});
