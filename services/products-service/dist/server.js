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
const PORT = parseInt(process.env.PORT || '4006', 10);
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
    serviceName: 'products-service'
});
const productsCollection = () => mongo.db('blindscloud').collection('products');
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
const toProductResponse = (p) => ({
    ...p,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt?.toISOString()
});
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '2mb' }));
app.use((0, helmet_1.default)());
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'products-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
app.get('/products', authenticate, async (_req, res) => {
    const products = await productsCollection().find({}).sort({ createdAt: -1 }).toArray();
    res.json(products.map(toProductResponse));
});
app.get('/products/:id', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const product = await productsCollection().findOne({ _id: req.params.id });
    if (!product)
        return res.status(404).json({ error: 'Product not found' });
    res.json(toProductResponse(product));
});
app.post('/products', authenticate, requireAdmin, [(0, express_validator_1.body)('name').isLength({ min: 1 }), (0, express_validator_1.body)('category').isLength({ min: 1 }), (0, express_validator_1.body)('price').isNumeric()], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const payload = req.body;
    const now = new Date();
    const product = {
        _id: crypto_1.default.randomUUID(),
        name: String(payload.name || ''),
        category: String(payload.category || ''),
        description: String(payload.description || ''),
        image: String(payload.image || ''),
        model3d: String(payload.model3d || payload.model3d || ''),
        arModel: String(payload.arModel || payload.arModel || ''),
        specifications: Array.isArray(payload.specifications) ? payload.specifications : [],
        price: typeof payload.price === 'number' ? payload.price : Number(payload.price),
        isActive: payload.isActive ?? true,
        createdAt: now,
        updatedAt: now
    };
    await productsCollection().insertOne(product);
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'products.created',
        version: 1,
        source: 'products-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { productId: product._id, name: product.name }
    };
    await eventBus.publish('products.created', event);
    res.status(201).json(toProductResponse(product));
});
app.put('/products/:id', authenticate, requireAdmin, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const productId = req.params.id;
    const existing = await productsCollection().findOne({ _id: productId });
    if (!existing)
        return res.status(404).json({ error: 'Product not found' });
    const updates = req.body;
    delete updates._id;
    delete updates.createdAt;
    updates.updatedAt = new Date();
    const result = await productsCollection().updateOne({ _id: productId }, { $set: updates });
    if (result.matchedCount === 0)
        return res.status(404).json({ error: 'Product not found' });
    const updated = await productsCollection().findOne({ _id: productId });
    if (!updated)
        return res.status(404).json({ error: 'Product not found' });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'products.updated',
        version: 1,
        source: 'products-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { productId }
    };
    await eventBus.publish('products.updated', event);
    res.json(toProductResponse(updated));
});
app.delete('/products/:id', authenticate, requireAdmin, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const productId = req.params.id;
    const existing = await productsCollection().findOne({ _id: productId });
    if (!existing)
        return res.status(404).json({ error: 'Product not found' });
    await productsCollection().deleteOne({ _id: productId });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'products.deleted',
        version: 1,
        source: 'products-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { productId }
    };
    await eventBus.publish('products.deleted', event);
    res.json({ status: 'OK' });
});
app.listen(PORT, '0.0.0.0', async () => {
    await mongo.connect();
    await eventBus.connect();
});
