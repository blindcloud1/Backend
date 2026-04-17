import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { body, param, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type { NotificationDoc, NotificationType, PushSubscriptionDoc, UserRole } from '@blindscloud/models';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4009', 10);
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
  serviceName: 'notifications-service'
});

const notificationsCollection = () => mongo.db('blindscloud').collection<NotificationDoc>('notifications');
const pushSubscriptionsCollection = () => mongo.db('blindscloud').collection<PushSubscriptionDoc>('push_subscriptions');

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

const toNotificationResponse = (n: NotificationDoc) => ({
  ...n,
  createdAt: n.createdAt.toISOString()
});

const toSubscriptionResponse = (s: PushSubscriptionDoc) => ({
  ...s,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt?.toISOString()
});

const isValidNotificationType = (value: any): value is NotificationType => {
  return [
    'reminder',
    'job',
    'system',
    'job_assigned',
    'job_accepted',
    'job_cancelled',
    'job_completed',
    'quotation_sent',
    'receipt_sent',
    'followup_sent'
  ].includes(String(value));
};

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(helmet());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'notifications-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

app.get('/notifications', authenticate, async (req: AuthRequest, res: Response) => {
  const onlyUnread = req.query.unread === 'true';
  const filter: any = { userId: req.user!.id };
  if (onlyUnread) filter.read = false;

  const notifications = await notificationsCollection().find(filter).sort({ createdAt: -1 }).limit(200).toArray();
  res.json(notifications.map(toNotificationResponse));
});

app.post(
  '/notifications',
  authenticate,
  requireAdmin,
  [body('userId').isLength({ min: 1 }), body('title').isLength({ min: 1 }), body('message').isLength({ min: 1 })],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const payload = req.body as Partial<NotificationDoc> & { userId: string; title: string; message: string; type?: string };
    const type = payload.type && isValidNotificationType(payload.type) ? (payload.type as NotificationType) : 'system';

    const notification: NotificationDoc = {
      _id: crypto.randomUUID(),
      userId: payload.userId,
      title: payload.title,
      message: payload.message,
      type,
      read: false,
      metadata: payload.metadata || {},
      createdAt: new Date()
    };

    await notificationsCollection().insertOne(notification as any);

    const event: CloudEvent<{ notificationId: string; userId: string; type: NotificationType }> = {
      id: crypto.randomUUID(),
      type: 'notifications.created',
      version: 1,
      source: 'notifications-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { notificationId: notification._id, userId: notification.userId, type: notification.type }
    };
    await eventBus.publish('notifications.created', event);

    res.status(201).json(toNotificationResponse(notification));
  }
);

app.post(
  '/notifications/:id/read',
  authenticate,
  [param('id').isLength({ min: 1 })],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const id = req.params.id;
    const existing = await notificationsCollection().findOne({ _id: id, userId: req.user!.id } as any);
    if (!existing) return res.status(404).json({ error: 'Notification not found' });

    await notificationsCollection().updateOne({ _id: id } as any, { $set: { read: true } } as any);

    const event: CloudEvent<{ notificationId: string; userId: string }> = {
      id: crypto.randomUUID(),
      type: 'notifications.read',
      version: 1,
      source: 'notifications-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { notificationId: id, userId: req.user!.id }
    };
    await eventBus.publish('notifications.read', event);

    res.json({ status: 'OK' });
  }
);

app.delete('/notifications/:id', authenticate, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const id = req.params.id;
  const existing = await notificationsCollection().findOne({ _id: id, userId: req.user!.id } as any);
  if (!existing) return res.status(404).json({ error: 'Notification not found' });

  await notificationsCollection().deleteOne({ _id: id } as any);

  const event: CloudEvent<{ notificationId: string; userId: string }> = {
    id: crypto.randomUUID(),
    type: 'notifications.deleted',
    version: 1,
    source: 'notifications-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { notificationId: id, userId: req.user!.id }
  };
  await eventBus.publish('notifications.deleted', event);

  res.json({ status: 'OK' });
});

app.get('/push-subscriptions', authenticate, async (req: AuthRequest, res: Response) => {
  const subs = await pushSubscriptionsCollection().find({ userId: req.user!.id } as any).sort({ createdAt: -1 }).toArray();
  res.json(subs.map(toSubscriptionResponse));
});

app.post(
  '/push-subscriptions',
  authenticate,
  [body('endpoint').isLength({ min: 1 }), body('keys').isObject()],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const payload = req.body as Partial<PushSubscriptionDoc>;
    const now = new Date();
    const subscription: PushSubscriptionDoc = {
      _id: crypto.randomUUID(),
      userId: req.user!.id,
      endpoint: String(payload.endpoint || ''),
      keys: payload.keys || {},
      createdAt: now,
      updatedAt: now
    };

    await pushSubscriptionsCollection().updateOne(
      { userId: subscription.userId, endpoint: subscription.endpoint } as any,
      { $set: subscription } as any,
      { upsert: true }
    );

    const event: CloudEvent<{ userId: string; endpoint: string }> = {
      id: crypto.randomUUID(),
      type: 'pushSubscriptions.upserted',
      version: 1,
      source: 'notifications-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { userId: subscription.userId, endpoint: subscription.endpoint }
    };
    await eventBus.publish('pushSubscriptions.upserted', event);

    res.status(201).json(toSubscriptionResponse(subscription));
  }
);

app.delete(
  '/push-subscriptions/:id',
  authenticate,
  [param('id').isLength({ min: 1 })],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const id = req.params.id;
    const existing = await pushSubscriptionsCollection().findOne({ _id: id, userId: req.user!.id } as any);
    if (!existing) return res.status(404).json({ error: 'Subscription not found' });

    await pushSubscriptionsCollection().deleteOne({ _id: id } as any);

    const event: CloudEvent<{ userId: string; endpoint: string }> = {
      id: crypto.randomUUID(),
      type: 'pushSubscriptions.deleted',
      version: 1,
      source: 'notifications-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { userId: existing.userId, endpoint: existing.endpoint }
    };
    await eventBus.publish('pushSubscriptions.deleted', event);

    res.json({ status: 'OK' });
  }
);

app.listen(PORT, '0.0.0.0', async () => {
  await mongo.connect();
  await eventBus.connect();
});

