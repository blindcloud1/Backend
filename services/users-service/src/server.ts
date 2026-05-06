import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type { BusinessDoc, UserDoc, UserRole } from '@blindscloud/models';
import https from 'https';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4002', 10);
const JWT_SECRET = process.env.JWT_SECRET || '';
const MONGO_URL = process.env.MONGO_URL || '';
const RABBITMQ_URL = process.env.RABBITMQ_URL || '';
const EVENT_EXCHANGE = process.env.EVENT_EXCHANGE || 'blindscloud.events';
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'noreply@blindscloud.co.uk';
const SENDGRID_FROM_NAME = process.env.SENDGRID_FROM_NAME || 'BlindsCloud';
const FRONTEND_URL = process.env.FRONTEND_URL || '';

if (!JWT_SECRET) throw new Error('JWT_SECRET is required');
if (!MONGO_URL) throw new Error('MONGO_URL is required');
if (!RABBITMQ_URL) throw new Error('RABBITMQ_URL is required');

type AuthUser = {
  id: string;
  email: string;
  role: UserRole | string;
};

type AuthRequest = Request & { user?: AuthUser };

const mongo = new MongoClient(MONGO_URL);
const eventBus = new EventBus({
  url: RABBITMQ_URL,
  exchange: EVENT_EXCHANGE,
  serviceName: 'users-service'
});

const usersCollection = () => mongo.db('blindscloud').collection<UserDoc>('users');
const businessesCollection = () => mongo.db('blindscloud').collection<BusinessDoc>('businesses');

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

class EmailConfigError extends Error {
  override name = 'EmailConfigError';
}

const sendSendGridMail = async (payload: { to: string; subject: string; html: string; text: string }) => {
  if (!SENDGRID_API_KEY) throw new EmailConfigError('SENDGRID_API_KEY is not configured');

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

  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.sendgrid.com',
        path: '/v3/mail/send',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SENDGRID_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': contentLength
        }
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += String(chunk);
        });
        res.on('end', () => {
          const code = res.statusCode || 0;
          if (code >= 200 && code < 300) return resolve();
          return reject(new Error(`SendGrid error ${code}: ${responseBody}`));
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('SendGrid request timeout'));
    });
    req.write(body);
    req.end();
  });
};

const sendVerificationEmail = async (opts: { to: string; token: string; setPassword?: boolean }) => {
  if (!FRONTEND_URL) throw new Error('FRONTEND_URL is not configured');
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

const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  const header = req.header('authorization') || req.header('Authorization');
  if (!header) return res.status(401).json({ error: 'Missing Authorization header' });

  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Invalid Authorization header' });

  try {
    const decoded = jwt.verify(match[1], JWT_SECRET) as any;
    req.user = {
      id: String(decoded.userId),
      email: String(decoded.email),
      role: String(decoded.role)
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const requireAdminOrBusiness = (req: AuthRequest, res: Response, next: NextFunction) => {
  const role = req.user?.role?.toLowerCase();
  if (role === 'admin' || role === 'business') return next();
  return res.status(403).json({ error: 'Insufficient permissions' });
};

const resolveTargetBusinessId = async (req: AuthRequest, explicitBusinessId?: string): Promise<string | null> => {
  const role = String(req.user?.role || '').toLowerCase();
  if (!req.user?.id) return null;

  const currentUser = await usersCollection().findOne({ _id: req.user.id } as any);
  if (!currentUser?.businessId) return null;

  if (role === 'admin') {
    return explicitBusinessId ? String(explicitBusinessId) : String(currentUser.businessId);
  }
  return String(currentUser.businessId);
};

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(helmet());

app.post(
  '/public-signup',
  [
    body('name').isLength({ min: 1 }),
    body('companyName').isLength({ min: 1 }),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }),
    body('phone').optional().isString()
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const payload = req.body as {
      name: string;
      companyName: string;
      email: string;
      password: string;
      phone?: string;
    };

    const email = String(payload.email || '').trim().toLowerCase();
    const emailRegex = new RegExp(`^${escapeRegExp(email)}$`, 'i');

    const [existingUser, existingBusiness] = await Promise.all([
      usersCollection().findOne({ email: emailRegex } as any),
      businessesCollection().findOne({ email: emailRegex } as any)
    ]);
    if (existingUser || existingBusiness) {
      return res.status(409).json({ error: 'Email already exists' });
    }

    const now = new Date();
    const businessId = crypto.randomUUID();
    const business: BusinessDoc = {
      _id: businessId,
      name: String(payload.companyName || ''),
      address: '',
      phone: payload.phone ? String(payload.phone) : undefined,
      email,
      adminId: undefined,
      features: ['job_management', 'calendar', 'reports', 'public_signup_pending'],
      subscription: 'basic' as any,
      vrViewEnabled: false,
      createdAt: now,
      updatedAt: now
    };

    const verificationToken = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(String(payload.password), 10);
    const userId = crypto.randomUUID();
    const newUser: UserDoc = {
      _id: userId,
      email,
      name: String(payload.name || ''),
      passwordHash: passwordHash as any,
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
      await businessesCollection().insertOne(business as any);
      await usersCollection().insertOne(newUser as any);
      await businessesCollection().updateOne({ _id: businessId } as any, { $set: { adminId: userId, updatedAt: new Date() } } as any);

      await sendVerificationEmail({ to: email, token: verificationToken, setPassword: false });

      const event: CloudEvent<{ userId: string; email: string; role: string; businessId: string }> = {
        id: crypto.randomUUID(),
        type: 'publicSignup.created',
        version: 1,
        source: 'users-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { userId, email, role: 'business', businessId }
      };
      await eventBus.publish('publicSignup.created', event);

      res.status(201).json({ status: 'OK', businessId, userId, verificationEmailSent: true });
    } catch (err: any) {
      try {
        await usersCollection().deleteOne({ _id: userId } as any);
        await businessesCollection().deleteOne({ _id: businessId } as any);
      } catch {
        void 0;
      }
      res.status(500).json({ error: err?.message || String(err) });
    }
  }
);

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'users-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

app.post(
  '/email/send',
  authenticate,
  requireAdminOrBusiness,
  [
    body('to').isEmail().normalizeEmail(),
    body('subject').isLength({ min: 1 }),
    body('html').optional().isString(),
    body('text').optional().isString(),
    body('htmlBody').optional().isString(),
    body('textBody').optional().isString(),
    body('from').optional().isString(),
    body('senderName').optional().isString(),
    body('replyTo').optional().isString(),
    body('cc').optional().isArray(),
    body('bcc').optional().isArray(),
    body('businessId').optional().isString()
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const payload = req.body as {
      to: string;
      subject: string;
      html?: string;
      text?: string;
      htmlBody?: string;
      textBody?: string;
      from?: string;
      senderName?: string;
      replyTo?: string;
      cc?: string[];
      bcc?: string[];
      businessId?: string;
    };
    const to = String(payload.to || '').toLowerCase();
    const subject = String(payload.subject || '');
    const rawHtml = typeof payload.html === 'string' ? payload.html : (typeof payload.htmlBody === 'string' ? payload.htmlBody : '');
    const rawText = typeof payload.text === 'string' ? payload.text : (typeof payload.textBody === 'string' ? payload.textBody : '');

    if (!rawHtml && !rawText) {
      return res.status(400).json({ error: 'Either html or text is required' });
    }

    const escapeHtml = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

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

      const parseFrom = (value?: string): { email?: string; name?: string } => {
        const raw = String(value || '').trim();
        if (!raw) return {};
        const match = raw.match(/^(.*)<(.+)>$/);
        if (match) {
          return { name: match[1].trim(), email: match[2].trim().toLowerCase() };
        }
        if (raw.includes('@')) return { email: raw.toLowerCase() };
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
          if (desiredFromName) fromName = desiredFromName;
        } else if (!isPublic && role === 'business') {
          const targetBusinessId = await resolveTargetBusinessId(req, payload.businessId);
          if (targetBusinessId) {
            const business: any = await businessesCollection().findOne({ _id: targetBusinessId } as any);
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

      const bodyJson: any = {
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

      await new Promise<void>((resolve, reject) => {
        if (!SENDGRID_API_KEY) return reject(new EmailConfigError('SENDGRID_API_KEY is not configured'));
        const raw = JSON.stringify(bodyJson);
        const contentLength = Buffer.byteLength(raw);
        const req2 = https.request(
          {
            hostname: 'api.sendgrid.com',
            path: '/v3/mail/send',
            method: 'POST',
            headers: {
              Authorization: `Bearer ${SENDGRID_API_KEY}`,
              'Content-Type': 'application/json',
              'Content-Length': contentLength
            }
          },
          (res2) => {
            let responseBody = '';
            res2.on('data', (chunk) => {
              responseBody += String(chunk);
            });
            res2.on('end', () => {
              const code = res2.statusCode || 0;
              if (code >= 200 && code < 300) return resolve();
              return reject(new Error(`SendGrid error ${code}: ${responseBody}`));
            });
          }
        );
        req2.on('error', reject);
        req2.setTimeout(10000, () => req2.destroy(new Error('SendGrid request timeout')));
        req2.write(raw);
        req2.end();
      });
      return res.json({ status: 'OK' });
    } catch (err: any) {
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
  }
);

app.post(
  '/email/verify-sender',
  authenticate,
  requireAdminOrBusiness,
  [
    body('from_email').isEmail().normalizeEmail(),
    body('from_name').optional().isString(),
    body('nickname').optional().isString(),
    body('reply_to').optional().isEmail().normalizeEmail(),
    body('businessId').optional().isString()
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const payload = req.body as {
      nickname?: string;
      from_email: string;
      from_name?: string;
      reply_to?: string;
      businessId?: string;
    };

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
            value:
              `Hi ${displayName},\n\n` +
              `You recently added ${fromEmail} as your sender address in BlindsCloud.\n\n` +
              `If you did not request this change, please contact support.\n`
          },
          {
            type: 'text/html',
            value:
              `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border-radius: 12px; border: 1px solid #e5e7eb;">` +
              `<h2 style="color: #111827; margin-bottom: 12px;">Verify your email for BlindsCloud</h2>` +
              `<p style="color: #374151; margin-bottom: 12px;">Hi ${displayName},</p>` +
              `<p style="color: #374151; margin-bottom: 12px;">You recently added <strong>${fromEmail}</strong> as your sender address in BlindsCloud.</p>` +
              `<p style="color: #6b7280; font-size: 12px; margin-top: 24px;">If you did not request this change, please contact our support team.</p>` +
              `</div>`
          }
        ]
      };

      await new Promise<void>((resolve, reject) => {
        const raw = JSON.stringify(bodyJson);
        const contentLength = Buffer.byteLength(raw);
        const req2 = https.request(
          {
            hostname: 'api.sendgrid.com',
            path: '/v3/mail/send',
            method: 'POST',
            headers: {
              Authorization: `Bearer ${SENDGRID_API_KEY}`,
              'Content-Type': 'application/json',
              'Content-Length': contentLength
            }
          },
          (res2) => {
            let responseBody = '';
            res2.on('data', (chunk) => {
              responseBody += String(chunk);
            });
            res2.on('end', () => {
              const code = res2.statusCode || 0;
              if (code >= 200 && code < 300) return resolve();
              return reject(new Error(`SendGrid error ${code}: ${responseBody}`));
            });
          }
        );
        req2.on('error', reject);
        req2.setTimeout(10000, () => req2.destroy(new Error('SendGrid request timeout')));
        req2.write(raw);
        req2.end();
      });

      const targetBusinessId = await resolveTargetBusinessId(req, payload.businessId);
      if (targetBusinessId) {
        const currentBusiness: any = await businessesCollection().findOne({ _id: targetBusinessId } as any);
        const previous = currentBusiness?.emailSettings || {};
        await businessesCollection().updateOne(
          { _id: targetBusinessId } as any,
          {
            $set: {
              emailSettings: {
                ...previous,
                senderEmail: fromEmail,
                senderName: displayName,
                updatedAt: new Date().toISOString()
              }
            }
          } as any
        );
      }

      return res.json({ success: true, message: 'Verification email sent. Please check your inbox.' });
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof EmailConfigError) {
        return res.status(500).json({ error: 'Email is not configured' });
      }
      return res.status(500).json({ error: 'Failed to send verification email', details: message });
    }
  }
);

app.post(
  '/email/authenticate-domain',
  authenticate,
  requireAdminOrBusiness,
  [body('domain').isLength({ min: 1 }), body('businessId').optional().isString()],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const payload = req.body as { domain: string; businessId?: string };
    const domain = String(payload.domain || '').trim().toLowerCase();
    if (!domain) return res.status(400).json({ error: 'domain is required' });

    try {
      const listRaw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req2 = https.request(
          {
            hostname: 'api.sendgrid.com',
            path: '/v3/whitelabel/domains?limit=50',
            method: 'GET',
            headers: { Authorization: `Bearer ${SENDGRID_API_KEY}` }
          },
          (res2) => {
            let bodyText = '';
            res2.on('data', (chunk) => (bodyText += String(chunk)));
            res2.on('end', () => resolve({ status: res2.statusCode || 0, body: bodyText }));
          }
        );
        req2.on('error', reject);
        req2.setTimeout(10000, () => req2.destroy(new Error('SendGrid request timeout')));
        req2.end();
      });

      if (listRaw.status >= 200 && listRaw.status < 300) {
        let listData: any = [];
        try {
          listData = JSON.parse(listRaw.body || '[]');
        } catch {
          listData = [];
        }
        const existingDomain = Array.isArray(listData) ? listData.find((d: any) => String(d?.domain || '').toLowerCase() === domain) : null;
        if (existingDomain) {
          const targetBusinessId = await resolveTargetBusinessId(req, payload.businessId);
          if (targetBusinessId) {
            const currentBusiness: any = await businessesCollection().findOne({ _id: targetBusinessId } as any);
            const previous = currentBusiness?.emailSettings || {};
            await businessesCollection().updateOne(
              { _id: targetBusinessId } as any,
              {
                $set: {
                  emailSettings: {
                    ...previous,
                    domainId: existingDomain.id,
                    authenticatedDomain: domain,
                    dns: existingDomain.dns,
                    updatedAt: new Date().toISOString()
                  }
                }
              } as any
            );
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

      const createRaw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const bodyText = JSON.stringify({ domain, automatic_security: true });
        const contentLength = Buffer.byteLength(bodyText);
        const req2 = https.request(
          {
            hostname: 'api.sendgrid.com',
            path: '/v3/whitelabel/domains',
            method: 'POST',
            headers: {
              Authorization: `Bearer ${SENDGRID_API_KEY}`,
              'Content-Type': 'application/json',
              'Content-Length': contentLength
            }
          },
          (res2) => {
            let responseBody = '';
            res2.on('data', (chunk) => (responseBody += String(chunk)));
            res2.on('end', () => resolve({ status: res2.statusCode || 0, body: responseBody }));
          }
        );
        req2.on('error', reject);
        req2.setTimeout(15000, () => req2.destroy(new Error('SendGrid request timeout')));
        req2.write(bodyText);
        req2.end();
      });

      let created: any = null;
      try {
        created = JSON.parse(createRaw.body || '{}');
      } catch {
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
        const currentBusiness: any = await businessesCollection().findOne({ _id: targetBusinessId } as any);
        const previous = currentBusiness?.emailSettings || {};
        await businessesCollection().updateOne(
          { _id: targetBusinessId } as any,
          {
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
          } as any
        );
      }

      return res.json({
        success: true,
        domainId: created.id,
        dns: created.dns,
        message: 'Domain authentication created. Please add DNS records.'
      });
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof EmailConfigError) {
        return res.status(500).json({ error: 'Email is not configured' });
      }
      return res.status(500).json({ error: 'Failed to authenticate domain', details: message });
    }
  }
);

app.post(
  '/email/validate-domain',
  authenticate,
  requireAdminOrBusiness,
  [body('domainId').isLength({ min: 1 }), body('businessId').optional().isString()],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const payload = req.body as { domainId: string; businessId?: string };
    const domainId = String(payload.domainId || '').trim();
    if (!domainId) return res.status(400).json({ error: 'domainId is required' });

    try {
      const validateRaw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req2 = https.request(
          {
            hostname: 'api.sendgrid.com',
            path: `/v3/whitelabel/domains/${encodeURIComponent(domainId)}/validate`,
            method: 'POST',
            headers: { Authorization: `Bearer ${SENDGRID_API_KEY}` }
          },
          (res2) => {
            let responseBody = '';
            res2.on('data', (chunk) => (responseBody += String(chunk)));
            res2.on('end', () => resolve({ status: res2.statusCode || 0, body: responseBody }));
          }
        );
        req2.on('error', reject);
        req2.setTimeout(15000, () => req2.destroy(new Error('SendGrid request timeout')));
        req2.end();
      });

      let parsed: any = null;
      try {
        parsed = JSON.parse(validateRaw.body || '{}');
      } catch {
        parsed = null;
      }

      if (!(validateRaw.status >= 200 && validateRaw.status < 300)) {
        return res.status(500).json({ error: 'Domain verification failed', message: validateRaw.body || 'SendGrid API error' });
      }

      const valid = Boolean(parsed?.valid);
      if (valid) {
        const targetBusinessId = await resolveTargetBusinessId(req, payload.businessId);
        if (targetBusinessId) {
          await businessesCollection().updateOne(
            { _id: targetBusinessId } as any,
            {
              $set: {
                'emailSettings.isVerified': true,
                'emailSettings.useSendGridSender': true,
                'emailSettings.verifiedAt': new Date().toISOString(),
                'emailSettings.updatedAt': new Date().toISOString()
              }
            } as any
          );
        }
        return res.json({ success: true, valid: true, message: 'Domain verified successfully' });
      }

      return res.json({
        success: false,
        valid: false,
        message: 'DNS records not yet propagated or incorrect',
        details: parsed?.validation_results
      });
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof EmailConfigError) {
        return res.status(500).json({ error: 'Email is not configured' });
      }
      return res.status(500).json({ error: 'Failed to validate domain', details: message });
    }
  }
);

app.get('/users', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.user!.role.toLowerCase();

  const currentUser = await usersCollection().findOne({ _id: req.user!.id });
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const query: any = {};
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

app.post(
  '/users',
  authenticate,
  requireAdminOrBusiness,
  [
    body('email').isEmail().normalizeEmail(),
    body('name').isLength({ min: 1 }),
    body('role').isString(),
    body('password').optional().isLength({ min: 8 })
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const currentUser = await usersCollection().findOne({ _id: req.user!.id });
    if (!currentUser) return res.status(401).json({ error: 'User not found' });

    const role = req.user!.role.toLowerCase();
    const payload = req.body as Partial<UserDoc> & { password?: string; verificationToken?: string };
    const createdRole = String(payload.role || 'employee').toLowerCase();
    const allowedRoles = new Set(['admin', 'business', 'employee', 'merchant']);
    if (!allowedRoles.has(createdRole)) return res.status(400).json({ error: 'Invalid role' });

    const password = typeof payload.password === 'string' ? payload.password : '';
    const passwordHash = password.length > 0 ? await bcrypt.hash(password, 10) : undefined;

    const now = new Date();
    const businessId = role === 'admin' ? payload.businessId : currentUser.businessId;
    if (createdRole !== 'admin' && (!businessId || typeof businessId !== 'string')) {
      return res.status(400).json({ error: 'businessId is required for this role' });
    }
    if ((createdRole === 'employee' || createdRole === 'merchant') && role === 'admin' && (!payload.parentId || typeof payload.parentId !== 'string')) {
      return res.status(400).json({ error: 'parentId is required for employee/merchant' });
    }

    const requiresEmailVerification = createdRole !== 'admin';
    const providedVerificationToken = typeof payload.verificationToken === 'string' ? payload.verificationToken : undefined;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (providedVerificationToken && !uuidRegex.test(providedVerificationToken)) {
      return res.status(400).json({ error: 'Invalid verificationToken' });
    }
    const verificationToken = requiresEmailVerification ? (providedVerificationToken || crypto.randomUUID()) : undefined;

    const newUser: UserDoc = {
      _id: crypto.randomUUID(),
      email: String(payload.email || '').toLowerCase(),
      name: String(payload.name || ''),
      passwordHash: passwordHash as any,
      role: createdRole as any,
      businessId: createdRole === 'admin' ? undefined : (businessId as any),
      parentId: role === 'admin' ? (payload.parentId || req.user!.id) : currentUser._id,
      permissions: Array.isArray(payload.permissions) ? payload.permissions : [],
      isActive: payload.isActive ?? true,
      emailVerified: requiresEmailVerification ? false : true,
      verificationToken,
      address: payload.address,
      createdBy: req.user!.id,
      createdAt: now,
      updatedAt: now
    };

    const existing = await usersCollection().findOne({ email: newUser.email });
    if (existing) return res.status(409).json({ error: 'Email already exists' });

    await usersCollection().insertOne(newUser);

    let verificationEmailSent = false;
    if (requiresEmailVerification && verificationToken && !providedVerificationToken) {
      try {
        const setPassword = !passwordHash;
        await sendVerificationEmail({ to: newUser.email, token: verificationToken, setPassword });
        verificationEmailSent = true;
      } catch (err) {
        console.error('Error sending verification email:', err);
      }
    }

    const event: CloudEvent<{ userId: string; email: string; role: string; businessId?: string }> = {
      id: crypto.randomUUID(),
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
  }
);

app.put('/users/:id', authenticate, requireAdminOrBusiness, async (req: AuthRequest, res: Response) => {
  const targetId = req.params.id;
  const currentUser = await usersCollection().findOne({ _id: req.user!.id });
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const role = req.user!.role.toLowerCase();
  const target = await usersCollection().findOne({ _id: targetId });
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (role !== 'admin' && currentUser.businessId && target.businessId !== currentUser.businessId) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  const updates = req.body as Partial<UserDoc> & { password?: string };
  delete (updates as any)._id;
  delete (updates as any).createdAt;
  delete (updates as any).createdBy;

  if (typeof updates.password === 'string' && updates.password.length >= 8) {
    (updates as any).passwordHash = await bcrypt.hash(updates.password, 10);
  }
  delete (updates as any).password;
  updates.updatedAt = new Date();

  await usersCollection().updateOne({ _id: targetId }, { $set: updates } as any);

  const event: CloudEvent<{ userId: string }> = {
    id: crypto.randomUUID(),
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

app.delete('/users/:id', authenticate, requireAdminOrBusiness, async (req: AuthRequest, res: Response) => {
  const targetId = req.params.id;
  const currentUser = await usersCollection().findOne({ _id: req.user!.id });
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const role = req.user!.role.toLowerCase();
  const target = await usersCollection().findOne({ _id: targetId });
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (role !== 'admin' && currentUser.businessId && target.businessId !== currentUser.businessId) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  await usersCollection().deleteOne({ _id: targetId });

  const event: CloudEvent<{ userId: string }> = {
    id: crypto.randomUUID(),
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
