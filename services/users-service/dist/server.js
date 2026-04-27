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
const crypto_1 = __importDefault(require("crypto"));
const event_bus_1 = require("@blindscloud/event-bus");
const https_1 = __importDefault(require("https"));
dotenv_1.default.config();
const PORT = parseInt(process.env.PORT || '4002', 10);
const JWT_SECRET = process.env.JWT_SECRET || '';
const MONGO_URL = process.env.MONGO_URL || '';
const RABBITMQ_URL = process.env.RABBITMQ_URL || '';
const EVENT_EXCHANGE = process.env.EVENT_EXCHANGE || 'blindscloud.events';
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'noreply@blindscloud.co.uk';
const SENDGRID_FROM_NAME = process.env.SENDGRID_FROM_NAME || 'BlindsCloud';
const FRONTEND_URL = process.env.FRONTEND_URL || '';
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
    serviceName: 'users-service'
});
const usersCollection = () => mongo.db('blindscloud').collection('users');
const sendSendGridMail = async (payload) => {
    if (!SENDGRID_API_KEY)
        throw new Error('SENDGRID_API_KEY is not configured');
    const body = JSON.stringify({
        personalizations: [{ to: [{ email: payload.to }] }],
        from: { email: SENDGRID_FROM_EMAIL, name: SENDGRID_FROM_NAME },
        subject: payload.subject,
        content: [
            { type: 'text/plain', value: payload.text },
            { type: 'text/html', value: payload.html }
        ]
    });
    const contentLength = Buffer.byteLength(body);
    await new Promise((resolve, reject) => {
        const req = https_1.default.request({
            hostname: 'api.sendgrid.com',
            path: '/v3/mail/send',
            method: 'POST',
            headers: {
                Authorization: `Bearer ${SENDGRID_API_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': contentLength
            }
        }, (res) => {
            let responseBody = '';
            res.on('data', (chunk) => {
                responseBody += String(chunk);
            });
            res.on('end', () => {
                const code = res.statusCode || 0;
                if (code >= 200 && code < 300)
                    return resolve();
                return reject(new Error(`SendGrid error ${code}: ${responseBody}`));
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
};
const sendVerificationEmail = async (opts) => {
    if (!FRONTEND_URL)
        throw new Error('FRONTEND_URL is not configured');
    const verifyUrl = `${FRONTEND_URL.replace(/\/$/, '')}/verify-email?token=${encodeURIComponent(opts.token)}&email=${encodeURIComponent(opts.to)}`;
    const subject = 'Verify your BlindsCloud account';
    const text = `Welcome to BlindsCloud!\n\nPlease verify your email address by opening this link:\n${verifyUrl}\n\nIf you did not request this account, you can ignore this email.\n`;
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 16px;">
      <h2 style="margin: 0 0 12px;">Verify your email</h2>
      <p style="margin: 0 0 12px;">Welcome to BlindsCloud. Please verify your email address to activate your account.</p>
      <p style="margin: 16px 0;">
        <a href="${verifyUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;">
          Verify Email
        </a>
      </p>
      <p style="margin: 12px 0; color: #4b5563; font-size: 14px;">Or copy and paste this link into your browser:</p>
      <p style="word-break: break-all; color:#111827; font-size: 14px; margin: 0 0 12px;">${verifyUrl}</p>
      <p style="color:#6b7280; font-size: 12px; margin: 24px 0 0;">If you did not request this account, you can ignore this email.</p>
    </div>
  `;
    await sendSendGridMail({ to: opts.to, subject, html, text });
};
const authenticate = (req, res, next) => {
    const header = req.header('authorization') || req.header('Authorization');
    if (!header)
        return res.status(401).json({ error: 'Missing Authorization header' });
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match)
        return res.status(401).json({ error: 'Invalid Authorization header' });
    try {
        const decoded = jsonwebtoken_1.default.verify(match[1], JWT_SECRET);
        req.user = {
            id: String(decoded.userId),
            email: String(decoded.email),
            role: String(decoded.role)
        };
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
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '2mb' }));
app.use((0, helmet_1.default)());
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'users-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
app.post('/email/send', authenticate, requireAdminOrBusiness, [
    (0, express_validator_1.body)('to').isEmail().normalizeEmail(),
    (0, express_validator_1.body)('subject').isLength({ min: 1 }),
    (0, express_validator_1.body)('html').optional().isString(),
    (0, express_validator_1.body)('text').optional().isString(),
    (0, express_validator_1.body)('htmlBody').optional().isString(),
    (0, express_validator_1.body)('textBody').optional().isString()
], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const payload = req.body;
    const to = String(payload.to || '').toLowerCase();
    const subject = String(payload.subject || '');
    const rawHtml = typeof payload.html === 'string' ? payload.html : (typeof payload.htmlBody === 'string' ? payload.htmlBody : '');
    const rawText = typeof payload.text === 'string' ? payload.text : (typeof payload.textBody === 'string' ? payload.textBody : '');
    if (!rawHtml && !rawText) {
        return res.status(400).json({ error: 'Either html or text is required' });
    }
    const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    const html = rawHtml || `<pre style="white-space: pre-wrap; font-family: Arial, sans-serif;">${escapeHtml(rawText)}</pre>`;
    const text = rawText || rawHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    await sendSendGridMail({ to, subject, html, text });
    res.json({ status: 'OK' });
});
app.get('/users', authenticate, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const currentUser = await usersCollection().findOne({ _id: req.user.id });
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const query = {};
    if (role !== 'admin') {
        query.businessId = currentUser.businessId;
    }
    const users = await usersCollection().find(query).sort({ createdAt: -1 }).toArray();
    res.json(users.map(u => ({
        id: u._id,
        email: u.email,
        name: u.name,
        role: u.role,
        businessId: u.businessId,
        parentId: u.parentId,
        permissions: u.permissions,
        isActive: u.isActive,
        emailVerified: u.emailVerified,
        createdAt: u.createdAt.toISOString()
    })));
});
app.post('/users', authenticate, requireAdminOrBusiness, [
    (0, express_validator_1.body)('email').isEmail().normalizeEmail(),
    (0, express_validator_1.body)('name').isLength({ min: 1 }),
    (0, express_validator_1.body)('role').isString(),
    (0, express_validator_1.body)('password').isLength({ min: 8 })
], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const currentUser = await usersCollection().findOne({ _id: req.user.id });
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const role = req.user.role.toLowerCase();
    const payload = req.body;
    const createdRole = String(payload.role || 'employee').toLowerCase();
    const allowedRoles = new Set(['admin', 'business', 'employee', 'merchant']);
    if (!allowedRoles.has(createdRole))
        return res.status(400).json({ error: 'Invalid role' });
    const password = String(payload.password || '');
    if (!password)
        return res.status(400).json({ error: 'Password is required' });
    const passwordHash = await bcryptjs_1.default.hash(password, 10);
    const now = new Date();
    const businessId = role === 'admin' ? payload.businessId : currentUser.businessId;
    if (createdRole !== 'admin' && (!businessId || typeof businessId !== 'string')) {
        return res.status(400).json({ error: 'businessId is required for this role' });
    }
    if ((createdRole === 'employee' || createdRole === 'merchant') && role === 'admin' && (!payload.parentId || typeof payload.parentId !== 'string')) {
        return res.status(400).json({ error: 'parentId is required for employee/merchant' });
    }
    const requiresEmailVerification = createdRole !== 'admin';
    const verificationToken = requiresEmailVerification ? crypto_1.default.randomUUID() : undefined;
    const newUser = {
        _id: crypto_1.default.randomUUID(),
        email: String(payload.email || '').toLowerCase(),
        name: String(payload.name || ''),
        passwordHash,
        role: createdRole,
        businessId: createdRole === 'admin' ? undefined : businessId,
        parentId: role === 'admin' ? (payload.parentId || req.user.id) : currentUser._id,
        permissions: Array.isArray(payload.permissions) ? payload.permissions : [],
        isActive: payload.isActive ?? true,
        emailVerified: requiresEmailVerification ? false : true,
        verificationToken,
        address: payload.address,
        createdBy: req.user.id,
        createdAt: now,
        updatedAt: now
    };
    const existing = await usersCollection().findOne({ email: newUser.email });
    if (existing)
        return res.status(409).json({ error: 'Email already exists' });
    await usersCollection().insertOne(newUser);
    let verificationEmailSent = false;
    if (requiresEmailVerification && verificationToken) {
        try {
            await sendVerificationEmail({ to: newUser.email, token: verificationToken });
            verificationEmailSent = true;
        }
        catch (err) {
            console.error('Error sending verification email:', err);
        }
    }
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'users.created',
        version: 1,
        source: 'users-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { userId: newUser._id, email: newUser.email, role: newUser.role, businessId: newUser.businessId }
    };
    await eventBus.publish('users.created', event);
    res.status(201).json({
        id: newUser._id,
        email: newUser.email,
        name: newUser.name,
        role: newUser.role,
        businessId: newUser.businessId,
        parentId: newUser.parentId,
        permissions: newUser.permissions,
        isActive: newUser.isActive,
        emailVerified: newUser.emailVerified,
        verificationEmailSent,
        createdAt: newUser.createdAt.toISOString()
    });
});
app.put('/users/:id', authenticate, requireAdminOrBusiness, async (req, res) => {
    const targetId = req.params.id;
    const currentUser = await usersCollection().findOne({ _id: req.user.id });
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const role = req.user.role.toLowerCase();
    const target = await usersCollection().findOne({ _id: targetId });
    if (!target)
        return res.status(404).json({ error: 'User not found' });
    if (role !== 'admin' && currentUser.businessId && target.businessId !== currentUser.businessId) {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const updates = req.body;
    delete updates._id;
    delete updates.createdAt;
    delete updates.createdBy;
    if (typeof updates.password === 'string' && updates.password.length >= 8) {
        updates.passwordHash = await bcryptjs_1.default.hash(updates.password, 10);
    }
    delete updates.password;
    updates.updatedAt = new Date();
    await usersCollection().updateOne({ _id: targetId }, { $set: updates });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'users.updated',
        version: 1,
        source: 'users-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { userId: targetId }
    };
    await eventBus.publish('users.updated', event);
    res.json({ status: 'OK' });
});
app.delete('/users/:id', authenticate, requireAdminOrBusiness, async (req, res) => {
    const targetId = req.params.id;
    const currentUser = await usersCollection().findOne({ _id: req.user.id });
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const role = req.user.role.toLowerCase();
    const target = await usersCollection().findOne({ _id: targetId });
    if (!target)
        return res.status(404).json({ error: 'User not found' });
    if (role !== 'admin' && currentUser.businessId && target.businessId !== currentUser.businessId) {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }
    await usersCollection().deleteOne({ _id: targetId });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'users.deleted',
        version: 1,
        source: 'users-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { userId: targetId }
    };
    await eventBus.publish('users.deleted', event);
    res.json({ status: 'OK' });
});
app.listen(PORT, '0.0.0.0', async () => {
    await mongo.connect();
    await eventBus.connect();
});
