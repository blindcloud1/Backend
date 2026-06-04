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
const requireAdmin = (req, res, next) => {
    const role = req.user?.role?.toLowerCase();
    if (role === 'admin')
        return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
};
const normalizeBusinessId = (value) => {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    if (trimmed.length > 128)
        return null;
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed))
        return null;
    return trimmed;
};
const getCurrentUser = async (req) => {
    return usersCollection().findOne({ _id: req.user.id });
};
const canAccessBusiness = (role, currentUser, businessId) => {
    if (role === 'admin')
        return true;
    return Boolean(currentUser.businessId && currentUser.businessId === businessId);
};
const canAccessBusinessOrChild = async (role, currentUser, businessId) => {
    if (role === 'admin')
        return true;
    if (currentUser.businessId && currentUser.businessId === businessId)
        return true;
    if (!currentUser.businessId)
        return false;
    const business = await businessesCollection().findOne({ _id: businessId }, { projection: { parentBusinessId: 1, isSubBusiness: 1 } });
    if (!business)
        return false;
    return Boolean(business.isSubBusiness && business.parentBusinessId && business.parentBusinessId === currentUser.businessId);
};
const escapeRegExp = (value) => {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    const items = await businessesCollection()
        .find({
        $or: [
            { _id: currentUser.businessId },
            { parentBusinessId: currentUser.businessId, isSubBusiness: true }
        ]
    })
        .sort({ createdAt: -1 })
        .toArray();
    return res.json(items.map(b => ({ ...b, createdAt: b.createdAt.toISOString(), updatedAt: b.updatedAt?.toISOString() })));
});
app.get('/businesses/:id', authenticate, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const businessId = req.params.id;
    if (!(await canAccessBusinessOrChild(role, currentUser, businessId)))
        return res.status(403).json({ error: 'Insufficient permissions' });
    const business = await businessesCollection().findOne({ _id: businessId });
    if (!business)
        return res.status(404).json({ error: 'Business not found' });
    return res.json({ ...business, createdAt: business.createdAt.toISOString(), updatedAt: business.updatedAt?.toISOString() });
});
app.post('/businesses', authenticate, requireAdminOrBusiness, [(0, express_validator_1.body)('name').isLength({ min: 1 }), (0, express_validator_1.body)('address').optional().isString(), (0, express_validator_1.body)('email').optional().isEmail().normalizeEmail()], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const payload = req.body;
    const normalizedEmail = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (normalizedEmail) {
        const emailRegex = new RegExp(`^${escapeRegExp(normalizedEmail)}$`, 'i');
        const [existingBusiness, existingUser] = await Promise.all([
            businessesCollection().findOne({ email: emailRegex }),
            usersCollection().findOne({ email: emailRegex })
        ]);
        if (existingBusiness || existingUser) {
            return res.status(409).json({ error: 'Email already exists' });
        }
    }
    let parentBusinessId = payload.parentBusinessId;
    let isSubBusiness = payload.isSubBusiness;
    if (role !== 'admin') {
        if (!currentUser.businessId)
            return res.status(400).json({ error: 'businessId is required' });
        parentBusinessId = currentUser.businessId;
        isSubBusiness = true;
    }
    let inherited = null;
    if (role !== 'admin' && parentBusinessId) {
        inherited = await businessesCollection().findOne({ _id: parentBusinessId });
    }
    const now = new Date();
    const requestedId = role === 'admin'
        ? normalizeBusinessId(payload._id) ||
            normalizeBusinessId(payload.id) ||
            normalizeBusinessId(payload.businessId)
        : null;
    const business = {
        _id: requestedId || crypto_1.default.randomUUID(),
        name: String(payload.name || ''),
        address: typeof payload.address === 'string' ? payload.address : '',
        phone: payload.phone,
        email: normalizedEmail || undefined,
        adminId: role === 'admin' ? payload.adminId : undefined,
        parentBusinessId: parentBusinessId || undefined,
        isSubBusiness: Boolean(isSubBusiness),
        features: role === 'admin' ? (Array.isArray(payload.features) ? payload.features : []) : (Array.isArray(inherited?.features) ? inherited.features : []),
        subscription: (role === 'admin' ? (payload.subscription || 'basic') : (inherited?.subscription || 'basic')),
        vrViewEnabled: role === 'admin' ? Boolean(payload.vrViewEnabled) : Boolean(inherited?.vrViewEnabled),
        logo: payload.logo,
        vatNumber: typeof payload.vatNumber === 'string' ? payload.vatNumber : inherited?.vatNumber,
        vatPercentage: typeof payload.vatPercentage === 'number' ? payload.vatPercentage : inherited?.vatPercentage,
        termsAndConditions: typeof payload.termsAndConditions === 'string' ? payload.termsAndConditions : inherited?.termsAndConditions,
        emailSettings: typeof payload.emailSettings === 'object' && payload.emailSettings ? payload.emailSettings : inherited?.emailSettings,
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
    if (!(await canAccessBusinessOrChild(role, currentUser, businessId)))
        return res.status(403).json({ error: 'Insufficient permissions' });
    const updates = req.body;
    delete updates._id;
    delete updates.createdAt;
    delete updates.adminId;
    if (role !== 'admin') {
        delete updates.parentBusinessId;
        delete updates.isSubBusiness;
        delete updates.features;
        delete updates.subscription;
    }
    updates.updatedAt = new Date();
    if (typeof updates.email === 'string') {
        const normalizedEmail = updates.email.trim().toLowerCase();
        if (normalizedEmail) {
            const emailRegex = new RegExp(`^${escapeRegExp(normalizedEmail)}$`, 'i');
            const [existingBusiness, existingUser] = await Promise.all([
                businessesCollection().findOne({ _id: { $ne: businessId }, email: emailRegex }),
                usersCollection().findOne({ email: emailRegex })
            ]);
            if (existingBusiness || existingUser) {
                return res.status(409).json({ error: 'Email already exists' });
            }
            updates.email = normalizedEmail;
        }
        else {
            delete updates.email;
        }
    }
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
app.delete('/businesses/:id', authenticate, requireAdmin, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const businessId = req.params.id;
    const existing = await businessesCollection().findOne({ _id: businessId });
    if (!existing)
        return res.status(404).json({ error: 'Business not found' });
    const userIds = (await usersCollection()
        .find({ businessId })
        .project({ _id: 1 })
        .toArray()).map(u => String(u._id));
    const deleted = {};
    const deleteMany = async (collectionName, filter) => {
        const result = await mongo.db('blindscloud').collection(collectionName).deleteMany(filter);
        deleted[collectionName] = result.deletedCount || 0;
    };
    try {
        if (userIds.length > 0) {
            await deleteMany('notifications', { userId: { $in: userIds } });
            await deleteMany('push_subscriptions', { userId: { $in: userIds } });
            await deleteMany('module_permissions', { userId: { $in: userIds } });
            await deleteMany('activity_logs', { userId: { $in: userIds } });
        }
        else {
            deleted['notifications'] = 0;
            deleted['push_subscriptions'] = 0;
            deleted['module_permissions'] = 0;
            deleted['activity_logs'] = 0;
        }
        const usersResult = await usersCollection().deleteMany({ businessId });
        deleted['users'] = usersResult.deletedCount || 0;
        await deleteMany('jobs', { businessId });
        await deleteMany('customers', { businessId });
        await deleteMany('products', { businessId });
        await deleteMany('pricing_tables', { businessId });
        await deleteMany('orders', { businessId });
        await deleteMany('business_settings', { businessId });
        await deleteMany('model_permissions', { businessId });
        const businessResult = await businessesCollection().deleteOne({ _id: businessId });
        deleted['businesses'] = businessResult.deletedCount || 0;
        const event = {
            id: crypto_1.default.randomUUID(),
            type: 'businesses.deleted',
            version: 1,
            source: 'businesses-service',
            occurredAt: new Date().toISOString(),
            correlationId: req.header('x-correlation-id') || undefined,
            payload: { businessId }
        };
        await eventBus.publish('businesses.deleted', event);
        res.json({ status: 'OK', deleted });
    }
    catch (err) {
        res.status(500).json({ error: err?.message || String(err) });
    }
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
            allowCardPayment: Boolean(payload.allowCardPayment),
            allowBankTransfer: Boolean(payload.allowBankTransfer),
            showEmailHistory: Boolean(payload.showEmailHistory),
            emailTemplates: payload.emailTemplates,
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
