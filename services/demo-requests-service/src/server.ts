import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { body, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type { BusinessSize, DemoRequestDoc, UserRole } from '@blindscloud/models';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4012', 10);
const JWT_SECRET = process.env.JWT_SECRET || '';
const MONGO_URL = process.env.MONGO_URL || '';
const RABBITMQ_URL = process.env.RABBITMQ_URL || '';
const EVENT_EXCHANGE = process.env.EVENT_EXCHANGE || 'blindscloud.events';

if (!JWT_SECRET) throw new Error('JWT_SECRET is required');
if (!MONGO_URL) throw new Error('MONGO_URL is required');
if (!RABBITMQ_URL) throw new Error('RABBITMQ_URL is required');

type AuthUser = { id: string; email: string; role: UserRole | string };
type AuthRequest = Request & { user?: AuthUser };

const mongo = new MongoClient(MONGO_URL);
const eventBus = new EventBus({
  url: RABBITMQ_URL,
  exchange: EVENT_EXCHANGE,
  serviceName: 'demo-requests-service'
});

const demoRequestsCollection = () => mongo.db('blindscloud').collection<DemoRequestDoc>('demo_requests');

const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  const header = req.header('authorization') || req.header('Authorization');
  if (!header) return res.status(401).json({ error: 'Missing Authorization header' });

  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Invalid Authorization header' });

  try {
    const decoded = jwt.verify(match[1], JWT_SECRET) as any;
    req.user = { id: String(decoded.userId), email: String(decoded.email), role: String(decoded.role) };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  const role = req.user?.role?.toLowerCase();
  if (role === 'admin') return next();
  return res.status(403).json({ error: 'Insufficient permissions' });
};

const isBusinessSize = (value: any): value is BusinessSize => {
  return ['small', 'medium', 'large'].includes(String(value));
};

const toResponse = (d: DemoRequestDoc) => ({ ...d, createdAt: d.createdAt.toISOString() });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(helmet());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'demo-requests-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

app.post(
  '/demo-requests',
  [body('name').isLength({ min: 1 }), body('businessSize').isString(), body('email').isEmail().normalizeEmail()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const payload = req.body as Partial<DemoRequestDoc>;
    if (!isBusinessSize(payload.businessSize)) return res.status(400).json({ error: 'Invalid businessSize' });

    const doc: DemoRequestDoc = {
      _id: crypto.randomUUID(),
      name: String(payload.name || ''),
      companyName: payload.companyName,
      businessSize: payload.businessSize,
      phone: payload.phone,
      email: String(payload.email || '').toLowerCase(),
      createdAt: new Date()
    };

    await demoRequestsCollection().insertOne(doc as any);

    const event: CloudEvent<{ demoRequestId: string; email: string }> = {
      id: crypto.randomUUID(),
      type: 'demoRequests.created',
      version: 1,
      source: 'demo-requests-service',
      occurredAt: new Date().toISOString(),
      payload: { demoRequestId: doc._id, email: doc.email }
    };
    await eventBus.publish('demoRequests.created', event);

    res.status(201).json(toResponse(doc));
  }
);

app.get('/demo-requests', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
  const docs = await demoRequestsCollection().find({}).sort({ createdAt: -1 }).limit(500).toArray();
  res.json(docs.map(toResponse));
});

app.listen(PORT, '0.0.0.0', async () => {
  await mongo.connect();
  await eventBus.connect();
});

