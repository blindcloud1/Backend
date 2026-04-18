import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { body, param, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type { UserRole, UserSessionDoc } from '@blindscloud/models';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4017', 10);
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
  serviceName: 'user-sessions-service'
});

const sessionsCollection = () => mongo.db('blindscloud').collection<UserSessionDoc>('user_sessions');

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
  if (req.user?.role?.toLowerCase() === 'admin') return next();
  return res.status(403).json({ error: 'Insufficient permissions' });
};

const toResponse = (s: UserSessionDoc) => ({
  ...s,
  expiresAt: s.expiresAt.toISOString(),
  createdAt: s.createdAt.toISOString()
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(helmet());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'user-sessions-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

app.get('/sessions/me', authenticate, async (req: AuthRequest, res: Response) => {
  const docs = await sessionsCollection().find({ userId: req.user!.id } as any).sort({ createdAt: -1 }).limit(50).toArray();
  res.json(docs.map(toResponse));
});

app.get('/sessions', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const filter: any = {};
  if (typeof req.query.userId === 'string') filter.userId = req.query.userId;
  const docs = await sessionsCollection().find(filter).sort({ createdAt: -1 }).limit(200).toArray();
  res.json(docs.map(toResponse));
});

app.post(
  '/sessions',
  authenticate,
  [body('ttlHours').optional().isNumeric()],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const ttlHours = typeof req.body.ttlHours === 'number' ? req.body.ttlHours : Number(req.body.ttlHours);
    const ttl = Number.isFinite(ttlHours) ? Math.min(Math.max(ttlHours, 1), 24 * 30) : 24 * 7;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 60 * 60 * 1000);
    const session: UserSessionDoc = {
      _id: crypto.randomUUID(),
      userId: req.user!.id,
      sessionToken: crypto.randomBytes(32).toString('hex'),
      expiresAt,
      createdAt: now
    };

    await sessionsCollection().insertOne(session as any);

    const event: CloudEvent<{ sessionId: string; userId: string }> = {
      id: crypto.randomUUID(),
      type: 'userSessions.created',
      version: 1,
      source: 'user-sessions-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { sessionId: session._id, userId: session.userId }
    };
    await eventBus.publish('userSessions.created', event);

    res.status(201).json(toResponse(session));
  }
);

app.delete('/sessions/me', authenticate, async (req: AuthRequest, res: Response) => {
  const docs = await sessionsCollection().find({ userId: req.user!.id } as any).project({ _id: 1 }).toArray();
  await sessionsCollection().deleteMany({ userId: req.user!.id } as any);

  for (const doc of docs) {
    const event: CloudEvent<{ sessionId: string; userId: string }> = {
      id: crypto.randomUUID(),
      type: 'userSessions.deleted',
      version: 1,
      source: 'user-sessions-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { sessionId: (doc as any)._id, userId: req.user!.id }
    };
    await eventBus.publish('userSessions.deleted', event);
  }

  res.json({ status: 'OK' });
});

app.delete('/sessions/:id', authenticate, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const role = req.user!.role.toLowerCase();
  const existing = await sessionsCollection().findOne({ _id: req.params.id } as any);
  if (!existing) return res.status(404).json({ error: 'Session not found' });
  if (role !== 'admin' && existing.userId !== req.user!.id) return res.status(403).json({ error: 'Insufficient permissions' });

  await sessionsCollection().deleteOne({ _id: existing._id } as any);

  const event: CloudEvent<{ sessionId: string; userId: string }> = {
    id: crypto.randomUUID(),
    type: 'userSessions.deleted',
    version: 1,
    source: 'user-sessions-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { sessionId: existing._id, userId: existing.userId }
  };
  await eventBus.publish('userSessions.deleted', event);

  res.json({ status: 'OK' });
});

app.listen(PORT, '0.0.0.0', async () => {
  await mongo.connect();
  await eventBus.connect();
});

