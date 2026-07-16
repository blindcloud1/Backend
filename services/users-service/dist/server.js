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
const businessesCollection = () => mongo.db('blindscloud').collection('businesses');
const plansCollection = () => mongo.db('blindscloud').collection('subscription_plans');
const subsCollection = () => mongo.db('blindscloud').collection('user_subscriptions');
const escapeRegExp = (value) => {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};
class EmailConfigError extends Error {
    name = 'EmailConfigError';
}
const sendSendGridMail = async (payload) => {
    if (!SENDGRID_API_KEY)
        throw new EmailConfigError('SENDGRID_API_KEY is not configured');
    const timeoutMs = 10000;
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
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error('SendGrid request timeout'));
        });
        req.write(body);
        req.end();
    });
};
const sendVerificationEmail = async (opts) => {
    if (!FRONTEND_URL)
        throw new Error('FRONTEND_URL is not configured');
    const base = `${FRONTEND_URL.replace(/\/$/, '')}/verify-email`;
    const params = new URLSearchParams({
        token: opts.token,
        email: opts.to
    });
    if (opts.setPassword) {
        params.set('setPassword', '1');
    }
    const verifyUrl = `${base}?${params.toString()}`;
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
const requireEmailSender = (req, res, next) => {
    const role = req.user?.role?.toLowerCase();
    if (role === 'admin' || role === 'business' || role === 'employee')
        return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
};
const resolveTargetBusinessId = async (req, explicitBusinessId) => {
    const role = String(req.user?.role || '').toLowerCase();
    if (!req.user?.id)
        return null;
    const currentUser = await usersCollection().findOne({ _id: req.user.id });
    if (!currentUser?.businessId)
        return null;
    if (role === 'admin') {
        return explicitBusinessId ? String(explicitBusinessId) : String(currentUser.businessId);
    }
    return String(currentUser.businessId);
};
const getActiveSubscriptionForBusiness = async (businessId) => {
    if (!businessId)
        return null;
    const businessUsers = await usersCollection()
        .find({ businessId, role: 'business' })
        .project({ _id: 1 })
        .toArray();
    const ids = businessUsers.map((u) => u._id).filter((id) => typeof id === 'string' && id.length > 0);
    if (ids.length === 0)
        return null;
    const activeStatuses = ['active', 'trial', 'past_due'];
    const subscription = await subsCollection().findOne({ userId: { $in: ids }, status: { $in: activeStatuses } }, { sort: { currentPeriodEnd: -1 } });
    if (!subscription)
        return null;
    const plan = await plansCollection().findOne({ _id: String(subscription.planId || '') });
    if (!plan)
        return null;
    return { subscription, plan };
};
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '2mb' }));
app.use((0, helmet_1.default)());
app.post('/public-signup', [
    (0, express_validator_1.body)('name').isLength({ min: 1, max: 50 }),
    (0, express_validator_1.body)('companyName').isLength({ min: 1 }),
    (0, express_validator_1.body)('email').isEmail().normalizeEmail(),
    (0, express_validator_1.body)('password').isLength({ min: 8 }),
    (0, express_validator_1.body)('phone').optional().isString()
], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const payload = req.body;
    const email = String(payload.email || '').trim().toLowerCase();
    const emailRegex = new RegExp(`^${escapeRegExp(email)}$`, 'i');
    const [existingUser, existingBusiness] = await Promise.all([
        usersCollection().findOne({ email: emailRegex }),
        businessesCollection().findOne({ email: emailRegex })
    ]);
    if (existingUser || existingBusiness) {
        return res.status(409).json({ error: 'Email already exists' });
    }
    const now = new Date();
    const businessId = crypto_1.default.randomUUID();
    const business = {
        _id: businessId,
        name: String(payload.companyName || ''),
        address: '',
        phone: payload.phone ? String(payload.phone) : undefined,
        email,
        adminId: undefined,
        features: ['job_management', 'calendar', 'reports', 'public_signup_pending'],
        subscription: 'basic',
        vrViewEnabled: false,
        createdAt: now,
        updatedAt: now
    };
    const verificationToken = crypto_1.default.randomUUID();
    const passwordHash = await bcryptjs_1.default.hash(String(payload.password), 10);
    const userId = crypto_1.default.randomUUID();
    const newUser = {
        _id: userId,
        email,
        name: String(payload.name || ''),
        passwordHash: passwordHash,
        role: 'business',
        businessId,
        permissions: ['manage_employees', 'view_dashboard', 'create_jobs', 'manage_products', 'view_reports'],
        isActive: false,
        emailVerified: false,
        verificationToken,
        createdBy: 'public_signup',
        createdAt: now,
        updatedAt: now
    };
    try {
        await businessesCollection().insertOne(business);
        await usersCollection().insertOne(newUser);
        await businessesCollection().updateOne({ _id: businessId }, { $set: { adminId: userId, updatedAt: new Date() } });
        await sendVerificationEmail({ to: email, token: verificationToken, setPassword: false });
        const event = {
            id: crypto_1.default.randomUUID(),
            type: 'publicSignup.created',
            version: 1,
            source: 'users-service',
            occurredAt: new Date().toISOString(),
            correlationId: req.header('x-correlation-id') || undefined,
            payload: { userId, email, role: 'business', businessId }
        };
        await eventBus.publish('publicSignup.created', event);
        res.status(201).json({ status: 'OK', businessId, userId, verificationEmailSent: true });
    }
    catch (err) {
        try {
            await usersCollection().deleteOne({ _id: userId });
            await businessesCollection().deleteOne({ _id: businessId });
        }
        catch {
            void 0;
        }
        res.status(500).json({ error: err?.message || String(err) });
    }
});
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'users-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
app.post('/email/send', authenticate, requireEmailSender, [
    (0, express_validator_1.body)('to').isEmail().normalizeEmail(),
    (0, express_validator_1.body)('subject').isLength({ min: 1 }),
    (0, express_validator_1.body)('html').optional().isString(),
    (0, express_validator_1.body)('text').optional().isString(),
    (0, express_validator_1.body)('htmlBody').optional().isString(),
    (0, express_validator_1.body)('textBody').optional().isString(),
    (0, express_validator_1.body)('from').optional().isString(),
    (0, express_validator_1.body)('senderName').optional().isString(),
    (0, express_validator_1.body)('replyTo').optional().isString(),
    (0, express_validator_1.body)('cc').optional().isArray(),
    (0, express_validator_1.body)('bcc').optional().isArray(),
    (0, express_validator_1.body)('businessId').optional().isString()
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
    try {
        const role = String(req.user?.role || '').toLowerCase();
        const publicDomains = new Set([
            'gmail.com',
            'yahoo.com',
            'hotmail.com',
            'outlook.com',
            'icloud.com',
            'aol.com',
            'protonmail.com',
            'zoho.com',
            'live.co.uk',
            'live.com',
            'msn.com'
        ]);
        const parseFrom = (value) => {
            const raw = String(value || '').trim();
            if (!raw)
                return {};
            const match = raw.match(/^(.*)<(.+)>$/);
            if (match) {
                return { name: match[1].trim(), email: match[2].trim().toLowerCase() };
            }
            if (raw.includes('@'))
                return { email: raw.toLowerCase() };
            return {};
        };
        const desiredFrom = parseFrom(payload.from);
        const desiredFromEmail = desiredFrom.email;
        const desiredFromName = String(desiredFrom.name || payload.senderName || '').trim();
        let fromEmail = SENDGRID_FROM_EMAIL;
        let fromName = SENDGRID_FROM_NAME;
        if (desiredFromEmail) {
            const domain = desiredFromEmail.split('@')[1]?.toLowerCase();
            const isPublic = !!domain && publicDomains.has(domain);
            if (!isPublic && role === 'admin') {
                fromEmail = desiredFromEmail;
                if (desiredFromName)
                    fromName = desiredFromName;
            }
            else if (!isPublic && role === 'business') {
                const targetBusinessId = await resolveTargetBusinessId(req, payload.businessId);
                if (targetBusinessId) {
                    const business = await businessesCollection().findOne({ _id: targetBusinessId });
                    const emailSettings = business?.emailSettings || {};
                    const verified = Boolean(emailSettings.isVerified);
                    const allowedSenderEmail = String(emailSettings.senderEmail || '').toLowerCase();
                    if (verified && allowedSenderEmail && allowedSenderEmail === desiredFromEmail) {
                        fromEmail = desiredFromEmail;
                        fromName = desiredFromName || String(emailSettings.senderName || fromName);
                    }
                }
            }
        }
        const replyTo = String(payload.replyTo || '').trim().toLowerCase();
        const replyToEmail = replyTo && replyTo.includes('@') ? replyTo : undefined;
        const cc = (Array.isArray(payload.cc) ? payload.cc : [])
            .map((e) => String(e || '').trim().toLowerCase())
            .filter((e) => e && e.includes('@'))
            .map((email) => ({ email }));
        const bcc = (Array.isArray(payload.bcc) ? payload.bcc : [])
            .map((e) => String(e || '').trim().toLowerCase())
            .filter((e) => e && e.includes('@'))
            .map((email) => ({ email }));
        const bodyJson = {
            personalizations: [
                {
                    to: [{ email: to }],
                    ...(cc.length ? { cc } : {}),
                    ...(bcc.length ? { bcc } : {}),
                    subject
                }
            ],
            from: { email: fromEmail, name: fromName },
            ...(replyToEmail ? { reply_to: { email: replyToEmail } } : {}),
            content: [
                { type: 'text/plain', value: text },
                { type: 'text/html', value: html }
            ]
        };
        await new Promise((resolve, reject) => {
            if (!SENDGRID_API_KEY)
                return reject(new EmailConfigError('SENDGRID_API_KEY is not configured'));
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
        return res.json({ status: 'OK' });
    }
    catch (err) {
        if (err instanceof EmailConfigError) {
            return res.status(500).json({ error: 'Email is not configured' });
        }
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'SendGrid request timeout') {
            return res.status(504).json({ error: 'Email provider timeout' });
        }
        const statusMatch = message.match(/SendGrid error\s+(\d+)/i);
        if (statusMatch) {
            return res.status(502).json({ error: 'Email provider error', providerStatus: parseInt(statusMatch[1], 10) });
        }
        return res.status(502).json({ error: 'Email provider error' });
    }
});
app.post('/email/verify-sender', authenticate, requireAdminOrBusiness, [
    (0, express_validator_1.body)('from_email').isEmail().normalizeEmail(),
    (0, express_validator_1.body)('from_name').optional().isString(),
    (0, express_validator_1.body)('nickname').optional().isString(),
    (0, express_validator_1.body)('reply_to').optional().isEmail().normalizeEmail(),
    (0, express_validator_1.body)('businessId').optional().isString()
], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const payload = req.body;
    const fromEmail = String(payload.from_email || '').toLowerCase();
    const displayName = String(payload.from_name || payload.nickname || 'Business Sender');
    const replyToAddress = String(payload.reply_to || fromEmail).toLowerCase();
    try {
        const bodyJson = {
            personalizations: [
                {
                    to: [{ email: fromEmail, name: displayName }],
                    subject: 'Verify your email for BlindsCloud'
                }
            ],
            from: { email: SENDGRID_FROM_EMAIL, name: SENDGRID_FROM_NAME },
            reply_to: { email: replyToAddress, name: displayName },
            content: [
                {
                    type: 'text/plain',
                    value: `Hi ${displayName},\n\n` +
                        `You recently added ${fromEmail} as your sender address in BlindsCloud.\n\n` +
                        `If you did not request this change, please contact support.\n`
                },
                {
                    type: 'text/html',
                    value: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border-radius: 12px; border: 1px solid #e5e7eb;">` +
                        `<h2 style="color: #111827; margin-bottom: 12px;">Verify your email for BlindsCloud</h2>` +
                        `<p style="color: #374151; margin-bottom: 12px;">Hi ${displayName},</p>` +
                        `<p style="color: #374151; margin-bottom: 12px;">You recently added <strong>${fromEmail}</strong> as your sender address in BlindsCloud.</p>` +
                        `<p style="color: #6b7280; font-size: 12px; margin-top: 24px;">If you did not request this change, please contact our support team.</p>` +
                        `</div>`
                }
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
        const targetBusinessId = await resolveTargetBusinessId(req, payload.businessId);
        if (targetBusinessId) {
            const currentBusiness = await businessesCollection().findOne({ _id: targetBusinessId });
            const previous = currentBusiness?.emailSettings || {};
            await businessesCollection().updateOne({ _id: targetBusinessId }, {
                $set: {
                    emailSettings: {
                        ...previous,
                        senderEmail: fromEmail,
                        senderName: displayName,
                        updatedAt: new Date().toISOString()
                    }
                }
            });
        }
        return res.json({ success: true, message: 'Verification email sent. Please check your inbox.' });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof EmailConfigError) {
            return res.status(500).json({ error: 'Email is not configured' });
        }
        return res.status(500).json({ error: 'Failed to send verification email', details: message });
    }
});
app.post('/email/authenticate-domain', authenticate, requireAdminOrBusiness, [(0, express_validator_1.body)('domain').isLength({ min: 1 }), (0, express_validator_1.body)('businessId').optional().isString()], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const payload = req.body;
    const domain = String(payload.domain || '').trim().toLowerCase();
    if (!domain)
        return res.status(400).json({ error: 'domain is required' });
    try {
        const listRaw = await new Promise((resolve, reject) => {
            const req2 = https_1.default.request({
                hostname: 'api.sendgrid.com',
                path: '/v3/whitelabel/domains?limit=50',
                method: 'GET',
                headers: { Authorization: `Bearer ${SENDGRID_API_KEY}` }
            }, (res2) => {
                let bodyText = '';
                res2.on('data', (chunk) => (bodyText += String(chunk)));
                res2.on('end', () => resolve({ status: res2.statusCode || 0, body: bodyText }));
            });
            req2.on('error', reject);
            req2.setTimeout(10000, () => req2.destroy(new Error('SendGrid request timeout')));
            req2.end();
        });
        if (listRaw.status >= 200 && listRaw.status < 300) {
            let listData = [];
            try {
                listData = JSON.parse(listRaw.body || '[]');
            }
            catch {
                listData = [];
            }
            const existingDomain = Array.isArray(listData) ? listData.find((d) => String(d?.domain || '').toLowerCase() === domain) : null;
            if (existingDomain) {
                const targetBusinessId = await resolveTargetBusinessId(req, payload.businessId);
                if (targetBusinessId) {
                    const currentBusiness = await businessesCollection().findOne({ _id: targetBusinessId });
                    const previous = currentBusiness?.emailSettings || {};
                    await businessesCollection().updateOne({ _id: targetBusinessId }, {
                        $set: {
                            emailSettings: {
                                ...previous,
                                domainId: existingDomain.id,
                                authenticatedDomain: domain,
                                dns: existingDomain.dns,
                                updatedAt: new Date().toISOString()
                            }
                        }
                    });
                }
                return res.json({
                    success: true,
                    domainId: existingDomain.id,
                    dns: existingDomain.dns,
                    message: 'Existing domain authentication found.',
                    isExisting: true
                });
            }
        }
        const createRaw = await new Promise((resolve, reject) => {
            const bodyText = JSON.stringify({ domain, automatic_security: true });
            const contentLength = Buffer.byteLength(bodyText);
            const req2 = https_1.default.request({
                hostname: 'api.sendgrid.com',
                path: '/v3/whitelabel/domains',
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${SENDGRID_API_KEY}`,
                    'Content-Type': 'application/json',
                    'Content-Length': contentLength
                }
            }, (res2) => {
                let responseBody = '';
                res2.on('data', (chunk) => (responseBody += String(chunk)));
                res2.on('end', () => resolve({ status: res2.statusCode || 0, body: responseBody }));
            });
            req2.on('error', reject);
            req2.setTimeout(15000, () => req2.destroy(new Error('SendGrid request timeout')));
            req2.write(bodyText);
            req2.end();
        });
        let created = null;
        try {
            created = JSON.parse(createRaw.body || '{}');
        }
        catch {
            created = null;
        }
        if (!(createRaw.status >= 200 && createRaw.status < 300) || !created?.id) {
            return res.status(500).json({
                error: 'Failed to generate records',
                details: createRaw.body || 'SendGrid API returned an error'
            });
        }
        const targetBusinessId = await resolveTargetBusinessId(req, payload.businessId);
        if (targetBusinessId) {
            const currentBusiness = await businessesCollection().findOne({ _id: targetBusinessId });
            const previous = currentBusiness?.emailSettings || {};
            await businessesCollection().updateOne({ _id: targetBusinessId }, {
                $set: {
                    emailSettings: {
                        ...previous,
                        domainId: created.id,
                        authenticatedDomain: domain,
                        dns: created.dns,
                        isVerified: false,
                        updatedAt: new Date().toISOString()
                    }
                }
            });
        }
        return res.json({
            success: true,
            domainId: created.id,
            dns: created.dns,
            message: 'Domain authentication created. Please add DNS records.'
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof EmailConfigError) {
            return res.status(500).json({ error: 'Email is not configured' });
        }
        return res.status(500).json({ error: 'Failed to authenticate domain', details: message });
    }
});
app.post('/email/validate-domain', authenticate, requireAdminOrBusiness, [(0, express_validator_1.body)('domainId').isLength({ min: 1 }), (0, express_validator_1.body)('businessId').optional().isString()], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const payload = req.body;
    const domainId = String(payload.domainId || '').trim();
    if (!domainId)
        return res.status(400).json({ error: 'domainId is required' });
    try {
        const validateRaw = await new Promise((resolve, reject) => {
            const req2 = https_1.default.request({
                hostname: 'api.sendgrid.com',
                path: `/v3/whitelabel/domains/${encodeURIComponent(domainId)}/validate`,
                method: 'POST',
                headers: { Authorization: `Bearer ${SENDGRID_API_KEY}` }
            }, (res2) => {
                let responseBody = '';
                res2.on('data', (chunk) => (responseBody += String(chunk)));
                res2.on('end', () => resolve({ status: res2.statusCode || 0, body: responseBody }));
            });
            req2.on('error', reject);
            req2.setTimeout(15000, () => req2.destroy(new Error('SendGrid request timeout')));
            req2.end();
        });
        let parsed = null;
        try {
            parsed = JSON.parse(validateRaw.body || '{}');
        }
        catch {
            parsed = null;
        }
        if (!(validateRaw.status >= 200 && validateRaw.status < 300)) {
            return res.status(500).json({ error: 'Domain verification failed', message: validateRaw.body || 'SendGrid API error' });
        }
        const valid = Boolean(parsed?.valid);
        if (valid) {
            const targetBusinessId = await resolveTargetBusinessId(req, payload.businessId);
            if (targetBusinessId) {
                await businessesCollection().updateOne({ _id: targetBusinessId }, {
                    $set: {
                        'emailSettings.isVerified': true,
                        'emailSettings.useSendGridSender': true,
                        'emailSettings.verifiedAt': new Date().toISOString(),
                        'emailSettings.updatedAt': new Date().toISOString()
                    }
                });
            }
            return res.json({ success: true, valid: true, message: 'Domain verified successfully' });
        }
        return res.json({
            success: false,
            valid: false,
            message: 'DNS records not yet propagated or incorrect',
            details: parsed?.validation_results
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof EmailConfigError) {
            return res.status(500).json({ error: 'Email is not configured' });
        }
        return res.status(500).json({ error: 'Failed to validate domain', details: message });
    }
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
        workingHours: u.workingHours,
        schedulingPreferences: u.schedulingPreferences,
        createdAt: u.createdAt.toISOString()
    })));
});
app.post('/users', authenticate, requireAdminOrBusiness, [
    (0, express_validator_1.body)('email').isEmail().normalizeEmail(),
    (0, express_validator_1.body)('name').isLength({ min: 1, max: 50 }),
    (0, express_validator_1.body)('role').isString(),
    (0, express_validator_1.body)('password').optional().isLength({ min: 8 })
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
    const password = typeof payload.password === 'string' ? payload.password : '';
    const passwordHash = password.length > 0 ? await bcryptjs_1.default.hash(password, 10) : undefined;
    const now = new Date();
    const businessId = role === 'admin' ? payload.businessId : currentUser.businessId;
    if (createdRole !== 'admin' && (!businessId || typeof businessId !== 'string')) {
        return res.status(400).json({ error: 'businessId is required for this role' });
    }
    if ((createdRole === 'employee' || createdRole === 'merchant') && role === 'admin' && (!payload.parentId || typeof payload.parentId !== 'string')) {
        return res.status(400).json({ error: 'parentId is required for employee/merchant' });
    }
    if (createdRole !== 'admin' && typeof businessId === 'string' && businessId.length > 0) {
        const current = await getActiveSubscriptionForBusiness(businessId);
        if (!current) {
            return res.status(403).json({ error: 'No active subscription. Please subscribe to add team members.' });
        }
        if (createdRole === 'employee') {
            const maxEmployees = current.plan.maxEmployees;
            if (maxEmployees !== null && maxEmployees !== undefined) {
                const allowed = typeof maxEmployees === 'number' ? maxEmployees : Number(maxEmployees);
                if (Number.isFinite(allowed)) {
                    const used = await usersCollection().countDocuments({ businessId, role: 'employee' });
                    if (used >= allowed) {
                        return res.status(403).json({
                            error: `Employee limit reached. Your plan allows ${Math.floor(allowed)} employees. You have ${used}.`
                        });
                    }
                }
            }
        }
        if (createdRole === 'business') {
            const maxSubBusinessUsers = current.plan.maxSubBusinessUsers;
            if (maxSubBusinessUsers !== null && maxSubBusinessUsers !== undefined) {
                const allowed = typeof maxSubBusinessUsers === 'number' ? maxSubBusinessUsers : Number(maxSubBusinessUsers);
                if (Number.isFinite(allowed)) {
                    const business = await businessesCollection().findOne({ _id: businessId });
                    const primaryId = typeof business?.adminId === 'string' ? String(business.adminId) : null;
                    const query = { businessId, role: 'business' };
                    if (primaryId)
                        query._id = { $ne: primaryId };
                    const used = await usersCollection().countDocuments(query);
                    if (used >= allowed) {
                        return res.status(403).json({
                            error: `Business user limit reached. Your plan allows ${Math.floor(allowed)} additional business users. You have ${used}.`
                        });
                    }
                }
            }
        }
    }
    const requiresEmailVerification = createdRole !== 'admin';
    const providedVerificationToken = typeof payload.verificationToken === 'string' ? payload.verificationToken : undefined;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (providedVerificationToken && !uuidRegex.test(providedVerificationToken)) {
        return res.status(400).json({ error: 'Invalid verificationToken' });
    }
    const verificationToken = requiresEmailVerification ? (providedVerificationToken || crypto_1.default.randomUUID()) : undefined;
    const newUser = {
        _id: crypto_1.default.randomUUID(),
        email: String(payload.email || '').toLowerCase(),
        name: String(payload.name || ''),
        passwordHash: passwordHash,
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
    if (requiresEmailVerification && verificationToken && !providedVerificationToken) {
        try {
            const setPassword = !passwordHash;
            await sendVerificationEmail({ to: newUser.email, token: verificationToken, setPassword });
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
    await eventBus.subscribe({
        queueName: 'users-service.subscriptions.paid',
        routingKeys: ['subscriptions.paid'],
        onMessage: async (event) => {
            const payload = event.payload;
            const userId = String(payload?.userId || '');
            if (!userId)
                return;
            const user = await usersCollection().findOne({ _id: userId });
            if (!user?.email)
                return;
            const planId = String(payload?.planId || '');
            const planName = String(payload?.planName || 'Subscription');
            let planDescription = String(payload?.planDescription || '');
            let planFeatures = Array.isArray(payload?.planFeatures)
                ? payload.planFeatures.map((f) => String(f || '').trim()).filter(Boolean)
                : [];
            const planPrice = typeof payload?.planPrice === 'number' ? payload.planPrice : Number(payload?.planPrice || 0);
            const billingCycleRaw = String(payload?.billingCycle || '');
            const billingCycle = billingCycleRaw === 'one_month' || billingCycleRaw === 'yearly' || billingCycleRaw === 'monthly'
                ? billingCycleRaw
                : 'monthly';
            const setupFeeAmount = typeof payload?.setupFeeAmount === 'number' ? payload.setupFeeAmount : Number(payload?.setupFeeAmount || 0);
            const setupFeeCharged = Boolean(payload?.setupFeeCharged);
            const amountPaidRaw = typeof payload?.amountPaid === 'number' ? payload.amountPaid : Number(payload?.amountPaid);
            const amountPaid = Number.isFinite(amountPaidRaw) ? amountPaidRaw : null;
            const currency = String(payload?.currency || 'GBP').toUpperCase();
            const termsUrl = String(payload?.termsUrl || FRONTEND_URL || '');
            if (planId && (!planDescription || planFeatures.length === 0)) {
                const plan = await plansCollection().findOne({ _id: planId });
                if (plan) {
                    if (!planDescription)
                        planDescription = String(plan.description || '');
                    if (planFeatures.length === 0 && Array.isArray(plan.features)) {
                        planFeatures = plan.features.map((f) => String(f || '').trim()).filter(Boolean);
                    }
                }
            }
            const start = new Date(String(payload?.periodStart || ''));
            const end = new Date(String(payload?.periodEnd || ''));
            const dateFmt = (d) => (Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB'));
            const totalFirstPayment = amountPaid !== null ? amountPaid : planPrice + (setupFeeCharged ? setupFeeAmount : 0);
            const currencySymbol = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '';
            const money = (n) => (currencySymbol ? `${currencySymbol}${n.toFixed(2)}` : `${currency} ${n.toFixed(2)}`);
            const subject = `Subscription Confirmed: ${planName}`;
            const startLine = dateFmt(start);
            const endLine = dateFmt(end);
            const periodLine = startLine && endLine ? `${startLine} - ${endLine}` : '';
            const billingLine = billingCycle === 'one_month'
                ? 'One-month (billed once)'
                : billingCycle === 'yearly'
                    ? 'Yearly (billed yearly)'
                    : 'Monthly (billed monthly)';
            const maxFeatures = 20;
            const trimmedFeatures = planFeatures.slice(0, maxFeatures);
            const extraFeaturesCount = Math.max(0, planFeatures.length - trimmedFeatures.length);
            const text = [
                `Hi ${user.name || 'there'},`,
                '',
                `Your subscription has been confirmed.`,
                '',
                `Plan: ${planName}`,
                planDescription ? `Description: ${planDescription}` : null,
                `Billing: ${billingLine}`,
                periodLine ? `Period: ${periodLine}` : null,
                startLine ? `Start date: ${startLine}` : null,
                endLine ? `End date: ${endLine}` : null,
                billingCycle === 'one_month'
                    ? `One-month price: ${money(planPrice)}`
                    : billingCycle === 'yearly'
                        ? `Yearly price: ${money(planPrice)}`
                        : `Monthly price: ${money(planPrice)}`,
                setupFeeCharged ? `Setup fee (one-time): ${money(setupFeeAmount)}` : null,
                `Total paid today: ${money(totalFirstPayment)}`,
                '',
                trimmedFeatures.length ? 'Included:' : null,
                ...trimmedFeatures.map((f) => `- ${f}`),
                extraFeaturesCount > 0 ? `- And ${extraFeaturesCount} more` : null,
                '',
                termsUrl ? `Terms & Conditions: ${termsUrl}` : null,
                '',
                'Thank you,',
                'BlindsCloud'
            ]
                .filter(Boolean)
                .join('\n');
            const html = `
        <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; line-height: 1.5; color: #111827;">
          <div style="max-width: 600px; margin: 0 auto; border: 1px solid #E5E7EB; border-radius: 16px; overflow: hidden;">
            <div style="background: linear-gradient(90deg,#2563EB,#4F46E5); padding: 20px 24px; color: white;">
              <div style="font-size: 18px; font-weight: 800;">Subscription Confirmed</div>
              <div style="opacity: 0.9; margin-top: 4px;">${planName}</div>
            </div>
            <div style="padding: 20px 24px;">
              <div style="font-size: 14px; color: #374151;">Hi ${user.name || 'there'},</div>
              <div style="margin-top: 10px; font-size: 14px; color: #374151;">
                Your subscription payment has been confirmed. Here are your details:
              </div>

              <div style="margin-top: 16px; border: 1px solid #E5E7EB; border-radius: 12px; padding: 14px 16px;">
                <div style="display:flex; justify-content: space-between; gap: 12px;">
                  <div style="font-weight: 700;">Plan</div>
                  <div>${planName}</div>
                </div>
                ${planDescription ? `<div style="margin-top: 8px; font-size: 13px; color: #374151;">${planDescription}</div>` : ''}
                <div style="display:flex; justify-content: space-between; gap: 12px; margin-top: 8px;">
                  <div style="font-weight: 700;">Billing</div>
                  <div>${billingLine}</div>
                </div>
                ${periodLine ? `<div style="display:flex; justify-content: space-between; gap: 12px; margin-top: 8px;"><div style="font-weight: 700;">Period</div><div>${periodLine}</div></div>` : ''}
                ${startLine ? `<div style="display:flex; justify-content: space-between; gap: 12px; margin-top: 8px;"><div style="font-weight: 700;">Start date</div><div>${startLine}</div></div>` : ''}
                ${endLine ? `<div style="display:flex; justify-content: space-between; gap: 12px; margin-top: 8px;"><div style="font-weight: 700;">End date</div><div>${endLine}</div></div>` : ''}
                <div style="display:flex; justify-content: space-between; gap: 12px; margin-top: 8px;">
                  <div style="font-weight: 700;">${billingCycle === 'one_month' ? 'One-month Price' : billingCycle === 'yearly' ? 'Yearly Price' : 'Monthly Price'}</div>
                  <div>${money(planPrice)}</div>
                </div>
                ${setupFeeCharged
                ? `<div style="display:flex; justify-content: space-between; gap: 12px; margin-top: 8px;">
                        <div style="font-weight: 700;">Setup Fee (one-time)</div>
                        <div>${money(setupFeeAmount)}</div>
                      </div>`
                : ''}
                <div style="display:flex; justify-content: space-between; gap: 12px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed #E5E7EB;">
                  <div style="font-weight: 800;">Total Paid Today</div>
                  <div style="font-weight: 800;">${money(totalFirstPayment)}</div>
                </div>
              </div>

              ${trimmedFeatures.length
                ? `<div style="margin-top: 14px; border: 1px solid #E5E7EB; border-radius: 12px; padding: 14px 16px;">
                      <div style="font-weight: 800; margin-bottom: 8px;">What’s included</div>
                      <ul style="margin: 0; padding-left: 18px; color: #374151; font-size: 13px;">
                        ${trimmedFeatures.map((f) => `<li style="margin: 4px 0;">${f}</li>`).join('')}
                        ${extraFeaturesCount > 0 ? `<li style="margin: 4px 0;">And ${extraFeaturesCount} more</li>` : ''}
                      </ul>
                    </div>`
                : ''}

              ${termsUrl
                ? `<div style="margin-top: 16px; font-size: 13px; color: #374151;">
                      Terms & Conditions: <a href="${termsUrl}" style="color:#2563EB; font-weight:700;">View terms</a>
                    </div>`
                : ''}

              <div style="margin-top: 18px; font-size: 13px; color: #6B7280;">
                If you have any questions, reply to this email.
              </div>
            </div>
          </div>
        </div>
      `.trim();
            await sendSendGridMail({
                to: user.email,
                subject,
                html,
                text
            });
        }
    });
});
