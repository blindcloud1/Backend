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
const PORT = parseInt(process.env.PORT || '4013', 10);
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
    serviceName: 'module-permissions-service'
});
const usersCollection = () => mongo.db('blindscloud').collection('users');
const modulePermissionsCollection = () => mongo.db('blindscloud').collection('module_permissions');
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
const canManageUser = async (req, targetUserId) => {
    const role = req.user.role.toLowerCase();
    if (role === 'admin')
        return true;
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return false;
    if (role !== 'business')
        return false;
    const target = await usersCollection().findOne({ _id: targetUserId });
    if (!target)
        return false;
    if (!currentUser.businessId || !target.businessId)
        return false;
    return currentUser.businessId === target.businessId;
};
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '2mb' }));
app.use((0, helmet_1.default)());
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'module-permissions-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
app.get('/module-permissions', authenticate, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const filter = {};
    if (role === 'admin') {
        if (typeof req.query.userId === 'string')
            filter.userId = req.query.userId;
    }
    else {
        filter.userId = req.user.id;
    }
    const docs = await modulePermissionsCollection().find(filter).sort({ grantedAt: -1 }).toArray();
    res.json(docs.map(d => ({ ...d, grantedAt: d.grantedAt.toISOString() })));
});
app.post('/module-permissions', authenticate, [
    (0, express_validator_1.body)('userId').isLength({ min: 1 }),
    (0, express_validator_1.body)('moduleId').isLength({ min: 1 }),
    (0, express_validator_1.body)('canAccess').isBoolean(),
    (0, express_validator_1.body)('canGrantAccess').isBoolean()
], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const payload = req.body;
    const allowed = await canManageUser(req, payload.userId);
    if (!allowed)
        return res.status(403).json({ error: 'Insufficient permissions' });
    const now = new Date();
    const base = {
        _id: crypto_1.default.randomUUID(),
        userId: payload.userId,
        moduleId: payload.moduleId,
        canAccess: payload.canAccess,
        canGrantAccess: payload.canGrantAccess,
        grantedBy: req.user.id,
        grantedAt: now
    };
    await modulePermissionsCollection().updateOne({ userId: base.userId, moduleId: base.moduleId }, { $set: base }, { upsert: true });
    const updated = await modulePermissionsCollection().findOne({ userId: base.userId, moduleId: base.moduleId });
    if (!updated)
        return res.status(500).json({ error: 'Failed to persist permission' });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'modulePermissions.upserted',
        version: 1,
        source: 'module-permissions-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: {
            userId: updated.userId,
            moduleId: updated.moduleId,
            canAccess: updated.canAccess,
            canGrantAccess: updated.canGrantAccess
        }
    };
    await eventBus.publish('modulePermissions.upserted', event);
    res.status(201).json({ ...updated, grantedAt: updated.grantedAt.toISOString() });
});
app.delete('/module-permissions/:id', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    if (role !== 'admin')
        return res.status(403).json({ error: 'Insufficient permissions' });
    const existing = await modulePermissionsCollection().findOne({ _id: req.params.id });
    if (!existing)
        return res.status(404).json({ error: 'Permission not found' });
    await modulePermissionsCollection().deleteOne({ _id: req.params.id });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'modulePermissions.deleted',
        version: 1,
        source: 'module-permissions-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { permissionId: existing._id }
    };
    await eventBus.publish('modulePermissions.deleted', event);
    res.json({ status: 'OK' });
});
app.listen(PORT, '0.0.0.0', async () => {
    await mongo.connect();
    await eventBus.connect();
});
