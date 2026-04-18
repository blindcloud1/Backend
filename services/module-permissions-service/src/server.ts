import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { body, param, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type { ModulePermissionDoc, UserDoc, UserRole } from '@blindscloud/models';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4013', 10);
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
  serviceName: 'module-permissions-service'
});

const usersCollection = () => mongo.db('blindscloud').collection<UserDoc>('users');
const modulePermissionsCollection = () => mongo.db('blindscloud').collection<ModulePermissionDoc>('module_permissions');

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

const canManageUser = async (req: AuthRequest, targetUserId: string): Promise<boolean> => {
  const role = req.user!.role.toLowerCase();
  if (role === 'admin') return true;

  const currentUser = await getCurrentUser(req);
  if (!currentUser) return false;
  if (role !== 'business') return false;

  const target = await usersCollection().findOne({ _id: targetUserId } as any);
  if (!target) return false;
  if (!currentUser.businessId || !target.businessId) return false;
  return currentUser.businessId === target.businessId;
};

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(helmet());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'module-permissions-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

app.get('/module-permissions', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.user!.role.toLowerCase();
  const filter: any = {};

  if (role === 'admin') {
    if (typeof req.query.userId === 'string') filter.userId = req.query.userId;
  } else {
    filter.userId = req.user!.id;
  }

  const docs = await modulePermissionsCollection().find(filter).sort({ grantedAt: -1 }).toArray();
  res.json(docs.map(d => ({ ...d, grantedAt: d.grantedAt.toISOString() })));
});

app.post(
  '/module-permissions',
  authenticate,
  [
    body('userId').isLength({ min: 1 }),
    body('moduleId').isLength({ min: 1 }),
    body('canAccess').isBoolean(),
    body('canGrantAccess').isBoolean()
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const payload = req.body as { userId: string; moduleId: string; canAccess: boolean; canGrantAccess: boolean };
    const allowed = await canManageUser(req, payload.userId);
    if (!allowed) return res.status(403).json({ error: 'Insufficient permissions' });

    const now = new Date();
    const base: ModulePermissionDoc = {
      _id: crypto.randomUUID(),
      userId: payload.userId,
      moduleId: payload.moduleId,
      canAccess: payload.canAccess,
      canGrantAccess: payload.canGrantAccess,
      grantedBy: req.user!.id,
      grantedAt: now
    };

    await modulePermissionsCollection().updateOne(
      { userId: base.userId, moduleId: base.moduleId } as any,
      { $set: base } as any,
      { upsert: true }
    );

    const updated = await modulePermissionsCollection().findOne({ userId: base.userId, moduleId: base.moduleId } as any);
    if (!updated) return res.status(500).json({ error: 'Failed to persist permission' });

    const event: CloudEvent<{ userId: string; moduleId: string; canAccess: boolean; canGrantAccess: boolean }> = {
      id: crypto.randomUUID(),
      type: 'modulePermissions.upserted',
      version: 1,
      source: 'module-permissions-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: {
        userId: updated.userId,
        moduleId: updated.moduleId,
        canAccess: updated.canAccess,
        canGrantAccess: updated.canGrantAccess
      }
    };
    await eventBus.publish('modulePermissions.upserted', event);

    res.status(201).json({ ...updated, grantedAt: updated.grantedAt.toISOString() });
  }
);

app.delete('/module-permissions/:id', authenticate, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const role = req.user!.role.toLowerCase();
  if (role !== 'admin') return res.status(403).json({ error: 'Insufficient permissions' });

  const existing = await modulePermissionsCollection().findOne({ _id: req.params.id } as any);
  if (!existing) return res.status(404).json({ error: 'Permission not found' });

  await modulePermissionsCollection().deleteOne({ _id: req.params.id } as any);

  const event: CloudEvent<{ permissionId: string }> = {
    id: crypto.randomUUID(),
    type: 'modulePermissions.deleted',
    version: 1,
    source: 'module-permissions-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { permissionId: existing._id }
  };
  await eventBus.publish('modulePermissions.deleted', event);

  res.json({ status: 'OK' });
});

app.listen(PORT, '0.0.0.0', async () => {
  await mongo.connect();
  await eventBus.connect();
});

