import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { body, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type { ModelPermissionDoc, UserDoc, UserRole } from '@blindscloud/models';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4015', 10);
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
  serviceName: 'model-permissions-service'
});

const usersCollection = () => mongo.db('blindscloud').collection<UserDoc>('users');
const modelPermissionsCollection = () => mongo.db('blindscloud').collection<ModelPermissionDoc>('model_permissions');

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

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(helmet());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'model-permissions-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

app.get('/model-permissions', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const filter: any = {};
  if (role === 'admin') {
    if (typeof req.query.businessId === 'string') filter.businessId = req.query.businessId;
  } else {
    if (!currentUser.businessId) return res.json([]);
    filter.businessId = currentUser.businessId;
  }

  const docs = await modelPermissionsCollection().find(filter).sort({ grantedAt: -1 }).toArray();
  res.json(docs.map(d => ({ ...d, grantedAt: d.grantedAt.toISOString() })));
});

app.put(
  '/model-permissions',
  authenticate,
  [body('businessId').optional().isString(), body('canView3dModels').isBoolean(), body('canUseInAr').isBoolean()],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const role = req.user!.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser) return res.status(401).json({ error: 'User not found' });

    const payload = req.body as Partial<ModelPermissionDoc>;
    const businessId = role === 'admin' ? String(payload.businessId || '') : String(currentUser.businessId || '');
    if (!businessId) return res.status(400).json({ error: 'businessId is required' });
    if (role !== 'admin' && businessId !== currentUser.businessId) return res.status(403).json({ error: 'Insufficient permissions' });
    if (role !== 'admin' && role !== 'business') return res.status(403).json({ error: 'Insufficient permissions' });

    const now = new Date();
    const doc: ModelPermissionDoc = {
      _id: crypto.randomUUID(),
      businessId,
      canView3dModels: Boolean(payload.canView3dModels),
      canUseInAr: Boolean(payload.canUseInAr),
      grantedBy: req.user!.id,
      grantedAt: now
    };

    await modelPermissionsCollection().updateOne({ businessId } as any, { $set: doc } as any, { upsert: true });
    const updated = await modelPermissionsCollection().findOne({ businessId } as any);
    if (!updated) return res.status(500).json({ error: 'Failed to persist permission' });

    const event: CloudEvent<{ businessId: string; canView3dModels: boolean; canUseInAr: boolean }> = {
      id: crypto.randomUUID(),
      type: 'modelPermissions.updated',
      version: 1,
      source: 'model-permissions-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { businessId: updated.businessId, canView3dModels: updated.canView3dModels, canUseInAr: updated.canUseInAr }
    };
    await eventBus.publish('modelPermissions.updated', event);

    res.json({ ...updated, grantedAt: updated.grantedAt.toISOString() });
  }
);

app.listen(PORT, '0.0.0.0', async () => {
  await mongo.connect();
  await eventBus.connect();
});

