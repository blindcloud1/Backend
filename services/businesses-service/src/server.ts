import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { body, param, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type { BusinessDoc, BusinessSettingsDoc, UserDoc, UserRole } from '@blindscloud/models';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4003', 10);
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
  serviceName: 'businesses-service'
});

const usersCollection = () => mongo.db('blindscloud').collection<UserDoc>('users');
const businessesCollection = () => mongo.db('blindscloud').collection<BusinessDoc>('businesses');
const businessSettingsCollection = () => mongo.db('blindscloud').collection<BusinessSettingsDoc>('business_settings');

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

const requireAdminOrBusiness = (req: AuthRequest, res: Response, next: NextFunction) => {
  const role = req.user?.role?.toLowerCase();
  if (role === 'admin' || role === 'business') return next();
  return res.status(403).json({ error: 'Insufficient permissions' });
};

const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  const role = req.user?.role?.toLowerCase();
  if (role === 'admin') return next();
  return res.status(403).json({ error: 'Insufficient permissions' });
};

const normalizeBusinessId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 128) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
};

const getCurrentUser = async (req: AuthRequest): Promise<UserDoc | null> => {
  return usersCollection().findOne({ _id: req.user!.id } as any);
};

const canAccessBusiness = (role: string, currentUser: UserDoc, businessId: string): boolean => {
  if (role === 'admin') return true;
  return Boolean(currentUser.businessId && currentUser.businessId === businessId);
};

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(helmet());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'businesses-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

app.get('/businesses', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  if (role === 'admin') {
    const all = await businessesCollection().find({}).sort({ createdAt: -1 }).toArray();
    return res.json(all.map(b => ({ ...b, createdAt: b.createdAt.toISOString(), updatedAt: b.updatedAt?.toISOString() })));
  }

  if (!currentUser.businessId) return res.json([]);
  const business = await businessesCollection().findOne({ _id: currentUser.businessId } as any);
  if (!business) return res.json([]);
  return res.json([{ ...business, createdAt: business.createdAt.toISOString(), updatedAt: business.updatedAt?.toISOString() }]);
});

app.get('/businesses/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const businessId = req.params.id;
  if (!canAccessBusiness(role, currentUser, businessId)) return res.status(403).json({ error: 'Insufficient permissions' });

  const business = await businessesCollection().findOne({ _id: businessId } as any);
  if (!business) return res.status(404).json({ error: 'Business not found' });
  return res.json({ ...business, createdAt: business.createdAt.toISOString(), updatedAt: business.updatedAt?.toISOString() });
});

app.post(
  '/businesses',
  authenticate,
  requireAdmin,
  [body('name').isLength({ min: 1 }), body('address').optional().isString(), body('email').optional().isEmail().normalizeEmail()],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const payload = req.body as Partial<BusinessDoc>;
    const normalizedEmail = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (normalizedEmail) {
      const emailRegex = new RegExp(`^${escapeRegExp(normalizedEmail)}$`, 'i');
      const [existingBusiness, existingUser] = await Promise.all([
        businessesCollection().findOne({ email: emailRegex } as any),
        usersCollection().findOne({ email: emailRegex } as any)
      ]);
      if (existingBusiness || existingUser) {
        return res.status(409).json({ error: 'Email already exists' });
      }
    }

    const now = new Date();
    const requestedId =
      normalizeBusinessId((payload as any)._id) ||
      normalizeBusinessId((payload as any).id) ||
      normalizeBusinessId((payload as any).businessId);
    const business: BusinessDoc = {
      _id: requestedId || crypto.randomUUID(),
      name: String(payload.name || ''),
      address: typeof payload.address === 'string' ? payload.address : '',
      phone: payload.phone,
      email: normalizedEmail || undefined,
      adminId: payload.adminId,
      features: Array.isArray(payload.features) ? payload.features : [],
      subscription: (payload.subscription || 'basic') as any,
      vrViewEnabled: Boolean(payload.vrViewEnabled),
      logo: payload.logo,
      createdAt: now,
      updatedAt: now
    };

    await businessesCollection().insertOne(business as any);

    const event: CloudEvent<{ businessId: string; name: string }> = {
      id: crypto.randomUUID(),
      type: 'businesses.created',
      version: 1,
      source: 'businesses-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { businessId: business._id, name: business.name }
    };
    await eventBus.publish('businesses.created', event);

    res.status(201).json({ ...business, createdAt: business.createdAt.toISOString(), updatedAt: business.updatedAt?.toISOString() });
  }
);

app.put('/businesses/:id', authenticate, requireAdminOrBusiness, async (req: AuthRequest, res: Response) => {
  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const businessId = req.params.id;
  if (!canAccessBusiness(role, currentUser, businessId)) return res.status(403).json({ error: 'Insufficient permissions' });

  const updates = req.body as Partial<BusinessDoc>;
  delete (updates as any)._id;
  delete (updates as any).createdAt;
  delete (updates as any).adminId;
  updates.updatedAt = new Date();

  if (typeof updates.email === 'string') {
    const normalizedEmail = updates.email.trim().toLowerCase();
    if (normalizedEmail) {
      const emailRegex = new RegExp(`^${escapeRegExp(normalizedEmail)}$`, 'i');
      const [existingBusiness, existingUser] = await Promise.all([
        businessesCollection().findOne({ _id: { $ne: businessId } as any, email: emailRegex } as any),
        usersCollection().findOne({ email: emailRegex } as any)
      ]);
      if (existingBusiness || existingUser) {
        return res.status(409).json({ error: 'Email already exists' });
      }
      updates.email = normalizedEmail as any;
    } else {
      delete (updates as any).email;
    }
  }

  const result = await businessesCollection().updateOne({ _id: businessId } as any, { $set: updates } as any);
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Business not found' });
  const updated = await businessesCollection().findOne({ _id: businessId } as any);
  if (!updated) return res.status(404).json({ error: 'Business not found' });

  const event: CloudEvent<{ businessId: string }> = {
    id: crypto.randomUUID(),
    type: 'businesses.updated',
    version: 1,
    source: 'businesses-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { businessId }
  };
  await eventBus.publish('businesses.updated', event);

  res.json({ ...updated, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt?.toISOString() });
});

app.delete(
  '/businesses/:id',
  authenticate,
  requireAdmin,
  [param('id').isLength({ min: 1 })],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const businessId = req.params.id;
    const existing = await businessesCollection().findOne({ _id: businessId } as any);
    if (!existing) return res.status(404).json({ error: 'Business not found' });

    const userIds = (await usersCollection()
      .find({ businessId } as any)
      .project({ _id: 1 } as any)
      .toArray()
    ).map(u => String((u as any)._id));

    const deleted: Record<string, number> = {};

    const deleteMany = async (collectionName: string, filter: any) => {
      const result = await mongo.db('blindscloud').collection(collectionName).deleteMany(filter);
      deleted[collectionName] = result.deletedCount || 0;
    };

    try {
      if (userIds.length > 0) {
        await deleteMany('notifications', { userId: { $in: userIds } });
        await deleteMany('push_subscriptions', { userId: { $in: userIds } });
        await deleteMany('module_permissions', { userId: { $in: userIds } });
        await deleteMany('activity_logs', { userId: { $in: userIds } });
      } else {
        deleted['notifications'] = 0;
        deleted['push_subscriptions'] = 0;
        deleted['module_permissions'] = 0;
        deleted['activity_logs'] = 0;
      }

      const usersResult = await usersCollection().deleteMany({ businessId } as any);
      deleted['users'] = usersResult.deletedCount || 0;

      await deleteMany('jobs', { businessId });
      await deleteMany('customers', { businessId });
      await deleteMany('products', { businessId });
      await deleteMany('pricing_tables', { businessId });
      await deleteMany('orders', { businessId });
      await deleteMany('business_settings', { businessId });
      await deleteMany('model_permissions', { businessId });

      const businessResult = await businessesCollection().deleteOne({ _id: businessId } as any);
      deleted['businesses'] = businessResult.deletedCount || 0;

      const event: CloudEvent<{ businessId: string }> = {
        id: crypto.randomUUID(),
        type: 'businesses.deleted',
        version: 1,
        source: 'businesses-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { businessId }
      };
      await eventBus.publish('businesses.deleted', event);

      res.json({ status: 'OK', deleted });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  }
);

app.get('/businesses/:id/settings', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const businessId = req.params.id;
  if (!canAccessBusiness(role, currentUser, businessId)) return res.status(403).json({ error: 'Insufficient permissions' });

  const settings = await businessSettingsCollection().findOne({ businessId } as any);
  if (!settings) return res.json(null);

  res.json({ ...settings, createdAt: settings.createdAt.toISOString(), updatedAt: settings.updatedAt?.toISOString() });
});

app.put('/businesses/:id/settings', authenticate, requireAdminOrBusiness, async (req: AuthRequest, res: Response) => {
  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const businessId = req.params.id;
  if (!canAccessBusiness(role, currentUser, businessId)) return res.status(403).json({ error: 'Insufficient permissions' });

  const payload = req.body as Partial<BusinessSettingsDoc>;
  const now = new Date();
  const existing = await businessSettingsCollection().findOne({ businessId } as any);

  const base: BusinessSettingsDoc = existing
    ? { ...existing, ...payload, updatedAt: now }
    : {
        _id: crypto.randomUUID(),
        businessId,
        bookingMode: (payload.bookingMode || 'manual') as any,
        paymentGatewayEnabled: Boolean(payload.paymentGatewayEnabled),
        depositPercentage: typeof payload.depositPercentage === 'number' ? payload.depositPercentage : 30,
        quotationTemplates: Array.isArray(payload.quotationTemplates) ? payload.quotationTemplates : [],
        invoiceTemplates: Array.isArray(payload.invoiceTemplates) ? payload.invoiceTemplates : [],
        allowCardPayment: Boolean((payload as any).allowCardPayment),
        allowBankTransfer: Boolean((payload as any).allowBankTransfer),
        showEmailHistory: Boolean((payload as any).showEmailHistory),
        emailTemplates: (payload as any).emailTemplates,
        createdAt: now,
        updatedAt: now
      };

  await businessSettingsCollection().updateOne({ businessId } as any, { $set: base } as any, { upsert: true });

  const event: CloudEvent<{ businessId: string }> = {
    id: crypto.randomUUID(),
    type: 'businessSettings.updated',
    version: 1,
    source: 'businesses-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { businessId }
  };
  await eventBus.publish('businessSettings.updated', event);

  res.json({ ...base, createdAt: base.createdAt.toISOString(), updatedAt: base.updatedAt?.toISOString() });
});

app.listen(PORT, '0.0.0.0', async () => {
  await mongo.connect();
  await eventBus.connect();
});

