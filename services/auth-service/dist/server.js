"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const express_validator_1 = require("express-validator");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const mongodb_1 = require("mongodb");
const event_bus_1 = require("@blindscloud/event-bus");
const crypto_1 = __importDefault(require("crypto"));
dotenv_1.default.config();
const PORT = parseInt(process.env.PORT || '4001', 10);
const JWT_SECRET = process.env.JWT_SECRET || '';
const MONGO_URL = process.env.MONGO_URL || '';
const RABBITMQ_URL = process.env.RABBITMQ_URL || '';
const EVENT_EXCHANGE = process.env.EVENT_EXCHANGE || 'blindscloud.events';
const SEED_DEMO = (process.env.SEED_DEMO || '').toLowerCase() === 'true';
if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is required');
}
if (!MONGO_URL) {
    throw new Error('MONGO_URL is required');
}
if (!RABBITMQ_URL) {
    throw new Error('RABBITMQ_URL is required');
}
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '2mb' }));
app.use((0, helmet_1.default)());
const mongo = new mongodb_1.MongoClient(MONGO_URL);
const eventBus = new event_bus_1.EventBus({
    url: RABBITMQ_URL,
    exchange: EVENT_EXCHANGE,
    serviceName: 'auth-service'
});
const getUsersCollection = () => mongo.db('blindscloud').collection('users');
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'auth-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
const loginValidators = [(0, express_validator_1.body)('email').isEmail().normalizeEmail(), (0, express_validator_1.body)('password').isLength({ min: 1 })];
const handleLogin = async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const { email, password } = req.body;
    const users = getUsersCollection();
    const user = await users.findOne({ email: email.toLowerCase() });
    if (!user)
        return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.isActive && user.role !== 'admin')
        return res.status(403).json({ error: 'Account blocked' });
    if (!user.emailVerified && user.role !== 'admin')
        return res.status(403).json({ error: 'Email not verified' });
    if (!user.passwordHash)
        return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcryptjs_1.default.compare(password, user.passwordHash);
    if (!ok)
        return res.status(401).json({ error: 'Invalid credentials' });
    const token = jsonwebtoken_1.default.sign({ userId: String(user._id), email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '60m' });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'auth.login.succeeded',
        version: 1,
        source: 'auth-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: {
            userId: String(user._id),
            email: user.email,
            role: user.role
        }
    };
    await eventBus.publish('auth.login.succeeded', event);
    res.json({
        user: {
            id: String(user._id),
            email: user.email,
            name: user.name,
            role: user.role,
            businessId: user.businessId,
            permissions: user.permissions,
            isActive: user.isActive,
            emailVerified: user.emailVerified,
            createdAt: user.createdAt.toISOString()
        },
        token
    });
};
app.post('/auth/login', loginValidators, handleLogin);
app.post('/login', loginValidators, handleLogin);
app.listen(PORT, '0.0.0.0', async () => {
    await mongo.connect();
    await eventBus.connect();
    if (SEED_DEMO) {
        const users = getUsersCollection();
        const existing = await users.countDocuments();
        if (existing === 0) {
            const passwordHash = await bcryptjs_1.default.hash('password', 10);
            await users.insertOne({
                _id: crypto_1.default.randomUUID(),
                email: 'admin@blindscloud.co.uk',
                name: 'BlindsCloud Admin',
                passwordHash,
                role: 'admin',
                permissions: ['all'],
                isActive: true,
                emailVerified: true,
                createdAt: new Date()
            });
        }
    }
});
