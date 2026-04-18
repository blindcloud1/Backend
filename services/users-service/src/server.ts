import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type { UserDoc, UserRole } from '@blindscloud/models';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4002', 10);
const JWT_SECRET = process.env.JWT_SECRET || '';
const MONGO_URL = process.env.MONGO_URL || '';
const RABBITMQ_URL = process.env.RABBITMQ_URL || '';
const EVENT_EXCHANGE = process.env.EVENT_EXCHANGE || 'blindscloud.events';

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

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(helmet());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'users-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

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
    body('password').isLength({ min: 8 })
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const currentUser = await usersCollection().findOne({ _id: req.user!.id });
    if (!currentUser) return res.status(401).json({ error: 'User not found' });

    const role = req.user!.role.toLowerCase();
    const payload = req.body as Partial<UserDoc> & { password?: string };
    const createdRole = String(payload.role || 'employee').toLowerCase();
    const allowedRoles = new Set(['admin', 'business', 'employee', 'merchant']);
    if (!allowedRoles.has(createdRole)) return res.status(400).json({ error: 'Invalid role' });

    const password = String(payload.password || '');
    if (!password) return res.status(400).json({ error: 'Password is required' });
    const passwordHash = await bcrypt.hash(password, 10);

    const now = new Date();
    const businessId = role === 'admin' ? payload.businessId : currentUser.businessId;
    if (createdRole !== 'admin' && (!businessId || typeof businessId !== 'string')) {
      return res.status(400).json({ error: 'businessId is required for this role' });
    }
    if ((createdRole === 'employee' || createdRole === 'merchant') && role === 'admin' && (!payload.parentId || typeof payload.parentId !== 'string')) {
      return res.status(400).json({ error: 'parentId is required for employee/merchant' });
    }

    const newUser: UserDoc = {
      _id: crypto.randomUUID(),
      email: String(payload.email || '').toLowerCase(),
      name: String(payload.name || ''),
      passwordHash,
      role: createdRole as any,
      businessId: createdRole === 'admin' ? undefined : (businessId as any),
      parentId: role === 'admin' ? (payload.parentId || req.user!.id) : currentUser._id,
      permissions: Array.isArray(payload.permissions) ? payload.permissions : [],
      isActive: payload.isActive ?? true,
      emailVerified: payload.emailVerified ?? false,
      address: payload.address,
      createdBy: req.user!.id,
      createdAt: now,
      updatedAt: now
    };

    const existing = await usersCollection().findOne({ email: newUser.email });
    if (existing) return res.status(409).json({ error: 'Email already exists' });

    await usersCollection().insertOne(newUser);

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
