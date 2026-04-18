import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { body, param, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type { Model3DDoc, Model3DStatus, UserRole } from '@blindscloud/models';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4014', 10);
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
  serviceName: 'models3d-service'
});

const modelsCollection = () => mongo.db('blindscloud').collection<Model3DDoc>('models_3d');

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

const canManage = (req: AuthRequest, doc: Model3DDoc): boolean => {
  if (req.user!.role.toLowerCase() === 'admin') return true;
  return Boolean(doc.createdBy && doc.createdBy === req.user!.id);
};

const isStatus = (value: any): value is Model3DStatus => {
  return ['processing', 'completed', 'failed'].includes(String(value));
};

const toResponse = (m: Model3DDoc) => ({
  ...m,
  createdAt: m.createdAt.toISOString()
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(helmet());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'models3d-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

app.get('/models-3d', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.user!.role.toLowerCase();
  const filter: any = {};
  if (role !== 'admin') filter.createdBy = req.user!.id;
  const docs = await modelsCollection().find(filter).sort({ createdAt: -1 }).limit(200).toArray();
  res.json(docs.map(toResponse));
});

app.get('/models-3d/:id', authenticate, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const doc = await modelsCollection().findOne({ _id: req.params.id } as any);
  if (!doc) return res.status(404).json({ error: 'Model not found' });
  if (!canManage(req, doc) && req.user!.role.toLowerCase() !== 'admin') return res.status(403).json({ error: 'Insufficient permissions' });
  res.json(toResponse(doc));
});

app.post('/models-3d', authenticate, [body('name').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const payload = req.body as Partial<Model3DDoc>;
  const doc: Model3DDoc = {
    _id: crypto.randomUUID(),
    name: String(payload.name || ''),
    originalImage: payload.originalImage,
    modelUrl: payload.modelUrl,
    thumbnail: payload.thumbnail,
    status: isStatus(payload.status) ? payload.status : 'processing',
    settings: payload.settings || {},
    createdBy: req.user!.id,
    createdAt: new Date()
  };

  await modelsCollection().insertOne(doc as any);

  const event: CloudEvent<{ modelId: string; status: Model3DStatus }> = {
    id: crypto.randomUUID(),
    type: 'models3d.created',
    version: 1,
    source: 'models3d-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { modelId: doc._id, status: doc.status }
  };
  await eventBus.publish('models3d.created', event);

  res.status(201).json(toResponse(doc));
});

app.put('/models-3d/:id', authenticate, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const existing = await modelsCollection().findOne({ _id: req.params.id } as any);
  if (!existing) return res.status(404).json({ error: 'Model not found' });
  if (!canManage(req, existing)) return res.status(403).json({ error: 'Insufficient permissions' });

  const updates = req.body as Partial<Model3DDoc>;
  delete (updates as any)._id;
  delete (updates as any).createdAt;
  delete (updates as any).createdBy;
  if (updates.status && !isStatus(updates.status)) delete (updates as any).status;

  await modelsCollection().updateOne({ _id: existing._id } as any, { $set: updates } as any);
  const updated = await modelsCollection().findOne({ _id: existing._id } as any);
  if (!updated) return res.status(404).json({ error: 'Model not found' });

  const event: CloudEvent<{ modelId: string; status: Model3DStatus }> = {
    id: crypto.randomUUID(),
    type: 'models3d.updated',
    version: 1,
    source: 'models3d-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { modelId: updated._id, status: updated.status }
  };
  await eventBus.publish('models3d.updated', event);

  res.json(toResponse(updated));
});

app.delete('/models-3d/:id', authenticate, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const existing = await modelsCollection().findOne({ _id: req.params.id } as any);
  if (!existing) return res.status(404).json({ error: 'Model not found' });
  if (!canManage(req, existing)) return res.status(403).json({ error: 'Insufficient permissions' });

  await modelsCollection().deleteOne({ _id: existing._id } as any);

  const event: CloudEvent<{ modelId: string }> = {
    id: crypto.randomUUID(),
    type: 'models3d.deleted',
    version: 1,
    source: 'models3d-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { modelId: existing._id }
  };
  await eventBus.publish('models3d.deleted', event);

  res.json({ status: 'OK' });
});

app.listen(PORT, '0.0.0.0', async () => {
  await mongo.connect();
  await eventBus.connect();
});

