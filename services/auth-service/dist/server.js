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
const https_1 = __importDefault(require("https"));
dotenv_1.default.config();
const PORT = parseInt(process.env.PORT || '4001', 10);
const JWT_SECRET = process.env.JWT_SECRET || '';
const MONGO_URL = process.env.MONGO_URL || '';
const RABBITMQ_URL = process.env.RABBITMQ_URL || '';
const EVENT_EXCHANGE = process.env.EVENT_EXCHANGE || 'blindscloud.events';
const SEED_DEMO = (process.env.SEED_DEMO || '').toLowerCase() === 'true';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'support@blindscloud.co.uk';
const SENDGRID_FROM_NAME = process.env.SENDGRID_FROM_NAME || 'BlindsCloud';
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
class EmailConfigError extends Error {
    name = 'EmailConfigError';
}
const sendSendGridMail = async (opts) => {
    if (!SENDGRID_API_KEY) {
        throw new EmailConfigError('SENDGRID_API_KEY is not configured');
    }
    const bodyJson = {
        personalizations: [
            {
                to: [{ email: opts.to }],
                subject: opts.subject
            }
        ],
        from: { email: SENDGRID_FROM_EMAIL, name: SENDGRID_FROM_NAME },
        content: [
            { type: 'text/plain', value: opts.text },
            { type: 'text/html', value: opts.html }
        ]
    };
    await new Promise((resolve, reject) => {
        const raw = JSON.stringify(bodyJson);
        const contentLength = Buffer.byteLength(raw);
        const req2 = https_1.default.request({
            hostname: 'api.sendgrid.com',
            path: '/v3/mail/send',
            method: 'POST',
            headers: {
                Authorization: `Bearer ${SENDGRID_API_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': contentLength
            }
        }, (res2) => {
            let responseBody = '';
            res2.on('data', (chunk) => {
                responseBody += String(chunk);
            });
            res2.on('end', () => {
                const code = res2.statusCode || 0;
                if (code >= 200 && code < 300)
                    return resolve();
                return reject(new Error(`SendGrid error ${code}: ${responseBody}`));
            });
        });
        req2.on('error', reject);
        req2.setTimeout(10000, () => req2.destroy(new Error('SendGrid request timeout')));
        req2.write(raw);
        req2.end();
    });
};
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
    if (!user.emailVerified && user.role !== 'admin')
        return res.status(403).json({ error: 'Email not verified' });
    if (!user.isActive && user.role !== 'admin') {
        const createdBy = String(user.createdBy || '').toLowerCase();
        const isPublicSignup = createdBy === 'public_signup' || createdBy === 'public-signup' || createdBy === 'publicsignup';
        if (user.role === 'business' && isPublicSignup) {
            return res.status(403).json({ error: 'Account pending admin approval' });
        }
        return res.status(403).json({ error: 'Account blocked' });
    }
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
app.post('/auth/logout', (_req, res) => {
    res.json({ status: 'OK' });
});
app.post('/auth/forgot-password', [(0, express_validator_1.body)('email').isEmail().normalizeEmail()], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ error: 'Enter a valid email' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const users = getUsersCollection();
    const user = await users.findOne({ email });
    const responseMessage = 'If this email exists, a reset link has been sent';
    if (!user || !user.emailVerified) {
        return res.json({ message: responseMessage });
    }
    const token = crypto_1.default.randomUUID();
    await users.updateOne({ _id: user._id }, { $set: { verificationToken: token, updatedAt: new Date() } });
    const base = FRONTEND_URL.replace(/\/$/, '');
    const resetUrl = `${base}/reset-password?token=${encodeURIComponent(token)}`;
    const subject = 'Reset Your Password - BlindsCloud';
    const text = `Password Reset Request\n\n` +
        `Hello ${String(user.name || '').trim() || 'there'},\n\n` +
        `To reset your password, open this link:\n${resetUrl}\n\n` +
        `If you did not request this, you can ignore this email.\n`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 16px;">
        <h2 style="margin: 0 0 12px; color: #111827;">Password Reset Request</h2>
        <p style="margin: 0 0 12px; color: #374151;">Hello ${String(user.name || '').trim() || 'there'},</p>
        <p style="margin: 0 0 12px; color: #374151;">We received a request to reset your password. Click below to set a new password:</p>
        <p style="margin: 16px 0;">
          <a href="${resetUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;">
            Reset Password
          </a>
        </p>
        <p style="margin: 12px 0; color: #6b7280; font-size: 12px;">If you did not request this, you can ignore this email.</p>
        <p style="word-break: break-all; color:#111827; font-size: 12px; margin: 0;">${resetUrl}</p>
      </div>
    `.trim();
    try {
        await sendSendGridMail({ to: email, subject, html, text });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Password reset email error:', message);
        if (err instanceof EmailConfigError) {
            return res.status(500).json({ error: 'Password reset email is not configured' });
        }
        if (message === 'SendGrid request timeout') {
            return res.status(504).json({ error: 'Password reset email provider timeout' });
        }
        const statusMatch = message.match(/SendGrid error\s+(\d+)/i);
        if (statusMatch) {
            return res.status(502).json({
                error: 'Password reset email provider error',
                providerStatus: parseInt(statusMatch[1], 10)
            });
        }
        return res.status(502).json({ error: 'Failed to send password reset email' });
    }
    return res.json({ message: responseMessage });
});
app.post('/auth/verify-email', [(0, express_validator_1.body)('token').isLength({ min: 1 }), (0, express_validator_1.body)('email').optional().isEmail().normalizeEmail(), (0, express_validator_1.body)('clearToken').optional().isBoolean()], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const { token, email, clearToken } = req.body;
    const users = getUsersCollection();
    let user = null;
    if (email) {
        user = await users.findOne({ email: email.toLowerCase() });
    }
    const tokenUser = await users.findOne({ verificationToken: token });
    if (!user) {
        user = tokenUser;
    }
    else if (!user.emailVerified && user.verificationToken !== token && tokenUser) {
        user = tokenUser;
    }
    if (!user)
        return res.status(400).json({ error: 'Invalid or expired verification token' });
    if (user.emailVerified) {
        return res.json({
            status: 'OK',
            user: {
                id: String(user._id),
                email: user.email,
                name: user.name,
                role: user.role,
                businessId: user.businessId,
                permissions: user.permissions,
                isActive: user.isActive,
                emailVerified: true,
                createdAt: user.createdAt?.toISOString?.() || new Date().toISOString()
            }
        });
    }
    if (!user.verificationToken || user.verificationToken !== token) {
        return res.status(400).json({ error: 'Invalid or expired verification token' });
    }
    const updates = {
        emailVerified: true,
        updatedAt: new Date()
    };
    if (clearToken !== false) {
        updates.verificationToken = undefined;
    }
    await users.updateOne({ _id: user._id }, { $set: updates });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'auth.email.verified',
        version: 1,
        source: 'auth-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { userId: String(user._id), email: user.email }
    };
    await eventBus.publish('auth.email.verified', event);
    res.json({
        status: 'OK',
        user: {
            id: String(user._id),
            email: user.email,
            name: user.name,
            role: user.role,
            businessId: user.businessId,
            permissions: user.permissions,
            isActive: user.isActive,
            emailVerified: true,
            createdAt: user.createdAt?.toISOString?.() || new Date().toISOString()
        }
    });
});
app.post('/auth/reset-password', [(0, express_validator_1.body)('token').isLength({ min: 1 }), (0, express_validator_1.body)('password').isLength({ min: 8 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const { token, password } = req.body;
    const users = getUsersCollection();
    const user = await users.findOne({ verificationToken: token });
    if (!user)
        return res.status(400).json({ error: 'Invalid or expired token' });
    if (!user.emailVerified)
        return res.status(403).json({ error: 'Email not verified' });
    const passwordHash = await bcryptjs_1.default.hash(password, 10);
    await users.updateOne({ _id: user._id }, { $set: { passwordHash, verificationToken: undefined, updatedAt: new Date() } });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'auth.password.set',
        version: 1,
        source: 'auth-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { userId: String(user._id), email: user.email }
    };
    await eventBus.publish('auth.password.set', event);
    res.json({ status: 'OK' });
});
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
