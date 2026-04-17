import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import helmet from 'helmet';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
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

type UserDoc = {
  _id: unknown;
  email: string;
  name: string;
  passwordHash: string;
  role: 'admin' | 'business' | 'employee' | 'merchant';
  businessId?: string;
  permissions: string[];
  isActive: boolean;
  emailVerified: boolean;
  verificationToken?: string;
  createdAt: Date;
};

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
