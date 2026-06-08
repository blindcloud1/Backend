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
const PORT = parseInt(process.env.PORT || '4004', 10);
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
    serviceName: 'customers-service'
});
const usersCollection = () => mongo.db('blindscloud').collection('users');
const customersCollection = () => mongo.db('blindscloud').collection('customers');
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
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const POSTCODE_REGEX = /^[A-Za-z0-9 -]{3,20}$/;
const countDigits = (value) => (String(value || '').match(/\d/g) || []).length;
const isValidPhone = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed)
        return true;
    return /^[\d\s()+-]+$/.test(trimmed) && countDigits(trimmed) >= 7 && countDigits(trimmed) <= 15;
};
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '2mb' }));
app.use((0, helmet_1.default)());
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'customers-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
app.get('/customers', authenticate, async (req, res) => {
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
    const customers = await customersCollection().find(filter).sort({ createdAt: -1 }).toArray();
    res.json(customers.map(c => ({ ...c, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt?.toISOString() })));
});
app.get('/customers/:id', authenticate, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const customer = await customersCollection().findOne({ _id: req.params.id });
    if (!customer)
        return res.status(404).json({ error: 'Customer not found' });
    if (role !== 'admin' && currentUser.businessId && customer.businessId !== currentUser.businessId) {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }
    res.json({ ...customer, createdAt: customer.createdAt.toISOString(), updatedAt: customer.updatedAt?.toISOString() });
});
app.post('/customers', authenticate, requireAdminOrBusiness, [
    (0, express_validator_1.body)('name').isLength({ min: 1, max: 50 }),
    (0, express_validator_1.body)('address').isLength({ min: 1 }),
    (0, express_validator_1.body)('email')
        .optional({ checkFalsy: true })
        .custom((value) => EMAIL_REGEX.test(String(value || '').trim()))
        .withMessage('Please enter a valid email address'),
    (0, express_validator_1.body)('phone')
        .optional({ checkFalsy: true })
        .custom((value) => isValidPhone(String(value || '')))
        .withMessage('Please enter a valid phone number'),
    (0, express_validator_1.body)('mobile')
        .optional({ checkFalsy: true })
        .custom((value) => isValidPhone(String(value || '')))
        .withMessage('Please enter a valid phone number'),
    (0, express_validator_1.body)('postcode')
        .optional({ checkFalsy: true })
        .custom((value) => POSTCODE_REGEX.test(String(value || '').trim()))
        .withMessage('Please enter a valid postcode')
], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const payload = req.body;
    const now = new Date();
    const businessId = role === 'admin' ? String(payload.businessId || '') : String(currentUser.businessId || '');
    if (!businessId)
        return res.status(400).json({ error: 'businessId is required' });
    let email;
    if (typeof payload.email === 'string') {
        const normalized = payload.email.trim().toLowerCase();
        if (normalized)
            email = normalized;
    }
    const phone = typeof payload.phone === 'string' ? payload.phone.trim() : undefined;
    const mobile = typeof payload.mobile === 'string' ? payload.mobile.trim() : undefined;
    const postcode = typeof payload.postcode === 'string' ? payload.postcode.trim() : undefined;
    const customer = {
        _id: crypto_1.default.randomUUID(),
        businessId,
        name: String(payload.name || '').trim(),
        email,
        phone,
        mobile,
        address: String(payload.address || ''),
        postcode,
        createdAt: now,
        updatedAt: now
    };
    await customersCollection().insertOne(customer);
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'customers.created',
        version: 1,
        source: 'customers-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { customerId: customer._id, businessId: customer.businessId }
    };
    await eventBus.publish('customers.created', event);
    res.status(201).json({ ...customer, createdAt: customer.createdAt.toISOString(), updatedAt: customer.updatedAt?.toISOString() });
});
app.put('/customers/:id', authenticate, requireAdminOrBusiness, [
    (0, express_validator_1.body)('name').optional().isLength({ min: 1, max: 50 }).withMessage('Name is too long'),
    (0, express_validator_1.body)('email')
        .optional({ checkFalsy: true })
        .custom((value) => EMAIL_REGEX.test(String(value || '').trim()))
        .withMessage('Please enter a valid email address'),
    (0, express_validator_1.body)('phone')
        .optional({ checkFalsy: true })
        .custom((value) => isValidPhone(String(value || '')))
        .withMessage('Please enter a valid phone number'),
    (0, express_validator_1.body)('mobile')
        .optional({ checkFalsy: true })
        .custom((value) => isValidPhone(String(value || '')))
        .withMessage('Please enter a valid phone number'),
    (0, express_validator_1.body)('postcode')
        .optional({ checkFalsy: true })
        .custom((value) => POSTCODE_REGEX.test(String(value || '').trim()))
        .withMessage('Please enter a valid postcode')
], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const customerId = req.params.id;
    const existing = await customersCollection().findOne({ _id: customerId });
    if (!existing)
        return res.status(404).json({ error: 'Customer not found' });
    if (role !== 'admin' && currentUser.businessId && existing.businessId !== currentUser.businessId) {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const updates = req.body;
    if (typeof updates.name === 'string') {
        updates.name = String(updates.name || '').trim();
    }
    if (typeof updates.email === 'string') {
        const normalized = String(updates.email || '').trim().toLowerCase();
        if (!normalized) {
            delete updates.email;
        }
        else {
            updates.email = normalized;
        }
    }
    if (typeof updates.postcode === 'string') {
        const normalized = String(updates.postcode || '').trim();
        if (!normalized) {
            delete updates.postcode;
        }
        else {
            updates.postcode = normalized;
        }
    }
    if (typeof updates.phone === 'string') {
        const normalized = String(updates.phone || '').trim();
        if (!normalized) {
            delete updates.phone;
        }
        else {
            updates.phone = normalized;
        }
    }
    if (typeof updates.mobile === 'string') {
        const normalized = String(updates.mobile || '').trim();
        if (!normalized) {
            delete updates.mobile;
        }
        else {
            updates.mobile = normalized;
        }
    }
    delete updates._id;
    delete updates.businessId;
    delete updates.createdAt;
    updates.updatedAt = new Date();
    const result = await customersCollection().updateOne({ _id: customerId }, { $set: updates });
    if (result.matchedCount === 0)
        return res.status(404).json({ error: 'Customer not found' });
    const updated = await customersCollection().findOne({ _id: customerId });
    if (!updated)
        return res.status(404).json({ error: 'Customer not found' });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'customers.updated',
        version: 1,
        source: 'customers-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { customerId }
    };
    await eventBus.publish('customers.updated', event);
    res.json({ ...updated, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt?.toISOString() });
});
app.delete('/customers/:id', authenticate, requireAdminOrBusiness, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const customerId = req.params.id;
    const existing = await customersCollection().findOne({ _id: customerId });
    if (!existing)
        return res.status(404).json({ error: 'Customer not found' });
    if (role !== 'admin' && currentUser.businessId && existing.businessId !== currentUser.businessId) {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }
    await customersCollection().deleteOne({ _id: customerId });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'customers.deleted',
        version: 1,
        source: 'customers-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { customerId }
    };
    await eventBus.publish('customers.deleted', event);
    res.json({ status: 'OK' });
});
app.listen(PORT, '0.0.0.0', async () => {
    await mongo.connect();
    await eventBus.connect();
});
