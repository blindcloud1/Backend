import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { body, param, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type { ProductDoc, UserRole } from '@blindscloud/models';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4006', 10);
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
  serviceName: 'products-service'
});

const productsCollection = () => mongo.db('blindscloud').collection<ProductDoc>('products');

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

const toProductResponse = (p: ProductDoc) => ({
  ...p,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt?.toISOString()
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(helmet());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'products-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

app.get('/products', authenticate, async (_req: AuthRequest, res: Response) => {
  const products = await productsCollection().find({}).sort({ createdAt: -1 }).toArray();
  res.json(products.map(toProductResponse));
});

app.get('/products/:id', authenticate, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const product = await productsCollection().findOne({ _id: req.params.id } as any);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(toProductResponse(product));
});

app.post(
  '/products',
  authenticate,
  requireAdmin,
  [body('name').isLength({ min: 1 }), body('category').isLength({ min: 1 }), body('price').isNumeric()],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const payload = req.body as Partial<ProductDoc>;
    const now = new Date();
    const product: ProductDoc = {
      _id: crypto.randomUUID(),
      name: String(payload.name || ''),
      category: String(payload.category || ''),
      description: String(payload.description || ''),
      image: String(payload.image || ''),
      model3d: String((payload as any).model3d || payload.model3d || ''),
      arModel: String((payload as any).arModel || payload.arModel || ''),
      specifications: Array.isArray(payload.specifications) ? payload.specifications : [],
      price: typeof payload.price === 'number' ? payload.price : Number(payload.price),
      isActive: payload.isActive ?? true,
      createdAt: now,
      updatedAt: now
    };

    await productsCollection().insertOne(product as any);

    const event: CloudEvent<{ productId: string; name: string }> = {
      id: crypto.randomUUID(),
      type: 'products.created',
      version: 1,
      source: 'products-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { productId: product._id, name: product.name }
    };
    await eventBus.publish('products.created', event);

    res.status(201).json(toProductResponse(product));
  }
);

app.put('/products/:id', authenticate, requireAdmin, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const productId = req.params.id;
  const existing = await productsCollection().findOne({ _id: productId } as any);
  if (!existing) return res.status(404).json({ error: 'Product not found' });

  const updates = req.body as Partial<ProductDoc>;
  delete (updates as any)._id;
  delete (updates as any).createdAt;
  updates.updatedAt = new Date();

  const result = await productsCollection().updateOne({ _id: productId } as any, { $set: updates } as any);
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Product not found' });
  const updated = await productsCollection().findOne({ _id: productId } as any);
  if (!updated) return res.status(404).json({ error: 'Product not found' });

  const event: CloudEvent<{ productId: string }> = {
    id: crypto.randomUUID(),
    type: 'products.updated',
    version: 1,
    source: 'products-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { productId }
  };
  await eventBus.publish('products.updated', event);

  res.json(toProductResponse(updated));
});

app.delete('/products/:id', authenticate, requireAdmin, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const productId = req.params.id;
  const existing = await productsCollection().findOne({ _id: productId } as any);
  if (!existing) return res.status(404).json({ error: 'Product not found' });

  await productsCollection().deleteOne({ _id: productId } as any);

  const event: CloudEvent<{ productId: string }> = {
    id: crypto.randomUUID(),
    type: 'products.deleted',
    version: 1,
    source: 'products-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { productId }
  };
  await eventBus.publish('products.deleted', event);

  res.json({ status: 'OK' });
});

app.listen(PORT, '0.0.0.0', async () => {
  await mongo.connect();
  await eventBus.connect();
});

