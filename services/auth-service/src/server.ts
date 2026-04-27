import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import helmet from 'helmet';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type { UserDoc } from '@blindscloud/models';
import crypto from 'crypto';

dotenv.config();

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

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(helmet());

const mongo = new MongoClient(MONGO_URL);
const eventBus = new EventBus({
  url: RABBITMQ_URL,
  exchange: EVENT_EXCHANGE,
  serviceName: 'auth-service'
});

const getUsersCollection = () => mongo.db('blindscloud').collection<UserDoc>('users');

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'auth-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

const loginValidators = [body('email').isEmail().normalizeEmail(), body('password').isLength({ min: 1 })];

const handleLogin = async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body as { email: string; password: string };

  const users = getUsersCollection();
  const user = await users.findOne({ email: email.toLowerCase() });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.isActive && user.role !== 'admin') return res.status(403).json({ error: 'Account blocked' });
  if (!user.emailVerified && user.role !== 'admin') return res.status(403).json({ error: 'Email not verified' });
  if (!user.passwordHash) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { userId: String(user._id), email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '60m' }
  );

  const event: CloudEvent<{ userId: string; email: string; role: string }> = {
    id: crypto.randomUUID(),
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

app.post(
  '/auth/verify-email',
  [body('token').isLength({ min: 1 }), body('email').optional().isEmail().normalizeEmail(), body('clearToken').optional().isBoolean()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { token, email, clearToken } = req.body as { token: string; email?: string; clearToken?: boolean };
    const users = getUsersCollection();

    let user: UserDoc | null = null;
    if (email) {
      user = await users.findOne({ email: email.toLowerCase() });
    }
    if (!user) {
      user = await users.findOne({ verificationToken: token } as any);
    }

    if (!user) return res.status(400).json({ error: 'Invalid or expired verification token' });
    if (user.verificationToken && user.verificationToken !== token) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    const updates: Partial<UserDoc> = {
      emailVerified: true,
      updatedAt: new Date()
    };
    if (clearToken !== false) {
      (updates as any).verificationToken = undefined;
    }

    await users.updateOne({ _id: user._id }, { $set: updates } as any);

    const event: CloudEvent<{ userId: string; email: string }> = {
      id: crypto.randomUUID(),
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
  }
);

app.listen(PORT, '0.0.0.0', async () => {
  await mongo.connect();
  await eventBus.connect();

  if (SEED_DEMO) {
    const users = getUsersCollection();
    const existing = await users.countDocuments();
    if (existing === 0) {
      const passwordHash = await bcrypt.hash('password', 10);
      await users.insertOne({
        _id: crypto.randomUUID(),
        email: 'admin@blindscloud.co.uk',
        name: 'BlindsCloud Admin',
        passwordHash,
        role: 'admin',
        permissions: ['all'],
        isActive: true,
        emailVerified: true,
        createdAt: new Date()
      } as any);
    }
  }
});
