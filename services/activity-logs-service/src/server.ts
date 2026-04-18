import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { body, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type { ActivityLogDoc, UserDoc, UserRole } from '@blindscloud/models';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4016', 10);
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
  serviceName: 'activity-logs-service'
});

const usersCollection = () => mongo.db('blindscloud').collection<UserDoc>('users');
const logsCollection = () => mongo.db('blindscloud').collection<ActivityLogDoc>('activity_logs');

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

const getCurrentUser = async (req: AuthRequest): Promise<UserDoc | null> => {
  return usersCollection().findOne({ _id: req.user!.id } as any);
};

const toResponse = (l: ActivityLogDoc) => ({
  ...l,
  createdAt: l.createdAt.toISOString()
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(helmet());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'activity-logs-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

app.get('/activity-logs', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const filter: any = {};
  if (role === 'admin') {
    if (typeof req.query.userId === 'string') filter.userId = req.query.userId;
  } else if (role === 'business') {
    if (!currentUser.businessId) return res.json([]);
    const users = await usersCollection().find({ businessId: currentUser.businessId } as any).project({ _id: 1 }).limit(2000).toArray();
    const ids = users.map(u => u._id);
    filter.userId = { $in: ids };
  } else {
    filter.userId = currentUser._id;
  }

  const limit = typeof req.query.limit === 'string' ? Math.min(parseInt(req.query.limit, 10) || 200, 500) : 200;
  const docs = await logsCollection().find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
  res.json(docs.map(toResponse));
});

app.post(
  '/activity-logs',
  authenticate,
  [body('action').isLength({ min: 1 })],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const payload = req.body as Partial<ActivityLogDoc>;
    const doc: ActivityLogDoc = {
      _id: crypto.randomUUID(),
      userId: req.user!.id,
      action: String(payload.action || ''),
      targetType: payload.targetType,
      targetId: payload.targetId,
      details: payload.details,
      description: payload.description,
      ipAddress: typeof req.ip === 'string' ? req.ip : undefined,
      userAgent: typeof req.header('user-agent') === 'string' ? String(req.header('user-agent')) : undefined,
      createdAt: new Date()
    };

    await logsCollection().insertOne(doc as any);

    const event: CloudEvent<{ logId: string; userId: string; action: string }> = {
      id: crypto.randomUUID(),
      type: 'activityLogs.created',
      version: 1,
      source: 'activity-logs-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { logId: doc._id, userId: doc.userId, action: doc.action }
    };
    await eventBus.publish('activityLogs.created', event);

    res.status(201).json(toResponse(doc));
  }
);

app.listen(PORT, '0.0.0.0', async () => {
  await mongo.connect();
  await eventBus.connect();
});

