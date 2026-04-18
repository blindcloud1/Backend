import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { body, param, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type { OrderDoc, OrderStatus, OrderUnit, UserDoc, UserRole } from '@blindscloud/models';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4011', 10);
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
  serviceName: 'orders-service'
});

const usersCollection = () => mongo.db('blindscloud').collection<UserDoc>('users');
const ordersCollection = () => mongo.db('blindscloud').collection<OrderDoc>('orders');

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

const isOrderUnit = (value: any): value is OrderUnit => {
  return ['cm', 'inch', 'mm'].includes(String(value));
};

const isOrderStatus = (value: any): value is OrderStatus => {
  return ['pending', 'accepted', 'ready', 'delivered', 'cancelled'].includes(String(value));
};

const canViewOrder = (role: string, currentUser: UserDoc, order: OrderDoc): boolean => {
  if (role === 'admin') return true;
  if (role === 'business') return Boolean(currentUser.businessId && currentUser.businessId === order.businessId);
  if (role === 'merchant') return order.merchantId === currentUser._id;
  return false;
};

const toOrderResponse = (o: OrderDoc) => ({
  ...o,
  createdAt: o.createdAt.toISOString(),
  updatedAt: o.updatedAt?.toISOString(),
  acceptedAt: o.acceptedAt?.toISOString(),
  readyAt: o.readyAt?.toISOString(),
  deliveredAt: o.deliveredAt?.toISOString(),
  editedAt: o.editedAt?.toISOString()
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(helmet());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'orders-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

app.get('/orders', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const filter: any = {};
  if (role === 'admin') {
    if (typeof req.query.businessId === 'string') filter.businessId = req.query.businessId;
    if (typeof req.query.merchantId === 'string') filter.merchantId = req.query.merchantId;
    if (typeof req.query.status === 'string' && isOrderStatus(req.query.status)) filter.status = req.query.status;
  } else if (role === 'business') {
    if (!currentUser.businessId) return res.json([]);
    filter.businessId = currentUser.businessId;
    if (typeof req.query.status === 'string' && isOrderStatus(req.query.status)) filter.status = req.query.status;
  } else if (role === 'merchant') {
    filter.merchantId = currentUser._id;
    if (typeof req.query.status === 'string' && isOrderStatus(req.query.status)) filter.status = req.query.status;
  } else {
    return res.json([]);
  }

  const orders = await ordersCollection().find(filter).sort({ createdAt: -1 }).limit(500).toArray();
  res.json(orders.map(toOrderResponse));
});

app.get('/orders/:id', authenticate, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const order = await ordersCollection().findOne({ _id: req.params.id } as any);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!canViewOrder(role, currentUser, order)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json(toOrderResponse(order));
});

app.post(
  '/orders',
  authenticate,
  [
    body('windowName').isLength({ min: 1 }),
    body('productName').isLength({ min: 1 }),
    body('width').isNumeric(),
    body('height').isNumeric(),
    body('unit').isString(),
    body('total').isNumeric()
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const role = req.user!.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser) return res.status(401).json({ error: 'User not found' });

    if (role !== 'merchant' && role !== 'admin') return res.status(403).json({ error: 'Insufficient permissions' });
    if (role !== 'admin' && !currentUser.businessId) return res.status(400).json({ error: 'Merchant must belong to a business' });

    const payload = req.body as Partial<OrderDoc>;
    if (!isOrderUnit(payload.unit)) return res.status(400).json({ error: 'Invalid unit' });

    const businessId = role === 'admin' ? String(payload.businessId || '') : String(currentUser.businessId || '');
    if (!businessId) return res.status(400).json({ error: 'businessId is required' });
    if (role !== 'admin' && businessId !== currentUser.businessId) return res.status(403).json({ error: 'Insufficient permissions' });

    const now = new Date();
    const order: OrderDoc = {
      _id: crypto.randomUUID(),
      businessId,
      merchantId: currentUser._id,
      createdByUserId: currentUser._id,
      windowName: String(payload.windowName || ''),
      productId: payload.productId,
      productName: String(payload.productName || ''),
      category: payload.category,
      width: Number(payload.width),
      height: Number(payload.height),
      unit: payload.unit,
      total: typeof payload.total === 'number' ? payload.total : Number(payload.total),
      currency: String(payload.currency || 'GBP'),
      manualPricing: Boolean(payload.manualPricing),
      status: 'pending',
      seenByBusiness: false,
      note: payload.note,
      createdAt: now,
      updatedAt: now
    };

    await ordersCollection().insertOne(order as any);

    const event: CloudEvent<{ orderId: string; businessId: string; merchantId: string }> = {
      id: crypto.randomUUID(),
      type: 'orders.created',
      version: 1,
      source: 'orders-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { orderId: order._id, businessId: order.businessId, merchantId: order.merchantId }
    };
    await eventBus.publish('orders.created', event);

    res.status(201).json(toOrderResponse(order));
  }
);

app.put('/orders/:id', authenticate, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const id = req.params.id;
  const order = await ordersCollection().findOne({ _id: id } as any);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!canViewOrder(role, currentUser, order)) return res.status(403).json({ error: 'Insufficient permissions' });

  const updates = req.body as Partial<OrderDoc>;
  delete (updates as any)._id;
  delete (updates as any).createdAt;
  delete (updates as any).businessId;
  delete (updates as any).merchantId;
  delete (updates as any).createdByUserId;

  const now = new Date();
  const set: any = { ...updates, updatedAt: now };

  if (role === 'merchant') {
    delete set.seenByBusiness;
    delete set.manualPricing;
    delete set.total;
    delete set.currency;
    delete set.windowName;
    delete set.productId;
    delete set.productName;
    delete set.category;
    delete set.width;
    delete set.height;
    delete set.unit;
    if (typeof set.status === 'string') {
      if (set.status !== 'cancelled') delete set.status;
      else set.editedAt = now;
    }
  }

  if (role === 'business') {
    if (typeof set.status === 'string') {
      if (!isOrderStatus(set.status)) delete set.status;
      else {
        if (set.status === 'accepted') set.acceptedAt = now;
        if (set.status === 'ready') set.readyAt = now;
        if (set.status === 'delivered') set.deliveredAt = now;
        if (set.status === 'cancelled') set.editedAt = now;
      }
    }
    if (typeof set.seenByBusiness === 'boolean') {
      void 0;
    }
  }

  if (role === 'admin') {
    if (typeof set.status === 'string' && isOrderStatus(set.status)) {
      if (set.status === 'accepted') set.acceptedAt = now;
      if (set.status === 'ready') set.readyAt = now;
      if (set.status === 'delivered') set.deliveredAt = now;
      if (set.status === 'cancelled') set.editedAt = now;
    } else {
      delete set.status;
    }
  }

  await ordersCollection().updateOne({ _id: id } as any, { $set: set } as any);
  const updated = await ordersCollection().findOne({ _id: id } as any);
  if (!updated) return res.status(404).json({ error: 'Order not found' });

  const event: CloudEvent<{ orderId: string }> = {
    id: crypto.randomUUID(),
    type: 'orders.updated',
    version: 1,
    source: 'orders-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { orderId: id }
  };
  await eventBus.publish('orders.updated', event);

  res.json(toOrderResponse(updated));
});

app.listen(PORT, '0.0.0.0', async () => {
  await mongo.connect();
  await eventBus.connect();
});

