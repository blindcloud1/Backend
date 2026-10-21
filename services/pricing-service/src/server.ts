import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { body, param, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type { PricingTableDoc, UserDoc, UserRole } from '@blindscloud/models';
import {
  checkVisionRateLimit,
  extractPricingFromImage,
  extractProductsFromImage,
  extractSpecificationsFromImage,
  isVisionConfigured,
  visionUpload
} from './vision';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4007', 10);
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
  serviceName: 'pricing-service'
});

const usersCollection = () => mongo.db('blindscloud').collection<UserDoc>('users');
const pricingTablesCollection = () => mongo.db('blindscloud').collection<PricingTableDoc>('pricing_tables');

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

const getCurrentUser = async (req: AuthRequest): Promise<UserDoc | null> => {
  return usersCollection().findOne({ _id: req.user!.id } as any);
};

const canAccessBusiness = (role: string, currentUser: UserDoc, businessId: string): boolean => {
  if (role === 'admin') return true;
  return Boolean(currentUser.businessId && currentUser.businessId === businessId);
};

const toPricingResponse = (t: PricingTableDoc) => ({
  ...t,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt?.toISOString()
});

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(helmet());

/**
 * Wraps the multer upload so file errors (too large, wrong field name) come
 * back as a clean JSON error instead of Express's default HTML page.
 */
const visionUploadSingle = (req: AuthRequest, res: Response, next: NextFunction) => {
  visionUpload.single('file')(req, res, (err: any) => {
    if (!err) return next();
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Image is too large. The maximum size is 8 MB.' });
    }
    return res.status(400).json({ error: err?.message || 'Invalid image upload.' });
  });
};

/**
 * Shared checks for the /vision/* extraction endpoints: config check, file
 * check and per-user rate limit. Returns the uploaded file, or `undefined`
 * after having already sent the error response.
 */
const runVisionChecks = (req: AuthRequest, res: Response): any | undefined => {
  if (!isVisionConfigured()) {
    res.status(501).json({ error: 'AI extraction is not configured on this server' });
    return undefined;
  }

  const file = (req as any).file;
  if (!file) {
    res.status(400).json({ error: 'No image file provided' });
    return undefined;
  }

  const rate = checkVisionRateLimit(req.user!.id);
  if (!rate.ok) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    res.status(429).json({
      error: `Too many AI extractions. Please wait ${rate.retryAfterSeconds}s and try again.`
    });
    return undefined;
  }

  return file;
};

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'pricing-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

/**
 * AI pricing-table extraction.
 *
 * Accepts an image of a supplier price list, returns the extracted matrix in
 * two forms:
 *   text - the tab separated CSV block (one line per width) which pastes
 *          straight into the pricing table grid
 *   table - the fully structured table (name, unit, widths, drops, matrix)
 *          which the UI can apply to the grid in one click
 */
app.post(
  '/vision/pricing-extract',
  authenticate,
  requireAdminOrBusiness,
  visionUploadSingle,
  async (req: AuthRequest, res: Response) => {
    const file = runVisionChecks(req, res);
    if (!file) return;

    const result = await extractPricingFromImage(file.buffer, file.mimetype);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    const table = result.table;

    // Human readable summary - shown above the CSV block in the UI.
    const summary = [
      `Table: ${table.name || '(no name detected)'}`,
      `Unit: ${table.unitSystem}`,
      `Widths: ${table.widthValues.length}  Drops: ${table.dropValues.length}`,
      `Widths -> ${table.widthValues.join(', ')}`,
      `Drops  -> ${table.dropValues.join(', ')}`,
      '',
      'Copy the block below and paste it into the table grid (it starts at the top-left cell):',
      ''
    ].join('\n');

    return res.json({
      text: summary + table.csv,
      csv: table.csv,
      table: {
        name: table.name,
        unitSystem: table.unitSystem,
        widthValues: table.widthValues,
        dropValues: table.dropValues,
        priceMatrix: table.priceMatrix
      }
    });
  }
);

/**
 * AI product extraction (product page "Use AI"). Accepts a single image of a
 * product catalog/flyer and returns the extracted products as an editable row
 * list plus a properly quoted CSV block:
 *   products - [{ name, category, price, vatPercentage, description, specifications[] }]
 *   csv      - name,category,price,vat_percentage,description,specifications
 */
app.post(
  '/vision/product-extract',
  authenticate,
  requireAdminOrBusiness,
  visionUploadSingle,
  async (req: AuthRequest, res: Response) => {
    const file = runVisionChecks(req, res);
    if (!file) return;

    const result = await extractProductsFromImage(file.buffer, file.mimetype);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.json({ products: result.products, csv: result.csv });
  }
);

/**
 * AI specification extraction (product form "Use AI" next to + Add
 * Specification). Returns one entry per bullet/line found in the image:
 *   specifications - string[]
 *   csv            - one quoted field per line
 */
app.post(
  '/vision/specification-extract',
  authenticate,
  requireAdminOrBusiness,
  visionUploadSingle,
  async (req: AuthRequest, res: Response) => {
    const file = runVisionChecks(req, res);
    if (!file) return;

    const result = await extractSpecificationsFromImage(file.buffer, file.mimetype);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.json({ specifications: result.specifications, csv: result.csv });
  }
);

app.get('/pricing-tables', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const filter: any = {};
  if (role !== 'admin') {
    filter.businessId = currentUser.businessId;
  } else if (req.query.businessId && typeof req.query.businessId === 'string') {
    filter.businessId = req.query.businessId;
  }

  const tables = await pricingTablesCollection().find(filter).sort({ createdAt: -1 }).toArray();
  res.json(tables.map(toPricingResponse));
});

app.get('/pricing-tables/default', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const businessId = role === 'admin' && typeof req.query.businessId === 'string' ? req.query.businessId : currentUser.businessId;
  if (!businessId) return res.json(null);

  const table = await pricingTablesCollection().findOne({ businessId, isDefault: true } as any);
  if (!table) return res.json(null);
  res.json(toPricingResponse(table));
});

app.get('/pricing-tables/:id', authenticate, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const table = await pricingTablesCollection().findOne({ _id: req.params.id } as any);
  if (!table) return res.status(404).json({ error: 'Pricing table not found' });
  if (!canAccessBusiness(role, currentUser, table.businessId)) return res.status(403).json({ error: 'Insufficient permissions' });

  res.json(toPricingResponse(table));
});

app.post(
  '/pricing-tables',
  authenticate,
  requireAdminOrBusiness,
  [body('name').isLength({ min: 1 }), body('unitSystem').isString(), body('businessId').optional().isString()],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const role = req.user!.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser) return res.status(401).json({ error: 'User not found' });

    const payload = req.body as Partial<PricingTableDoc>;
    const businessId = role === 'admin' ? String(payload.businessId || '') : String(currentUser.businessId || '');
    if (!businessId) return res.status(400).json({ error: 'businessId is required' });
    if (!canAccessBusiness(role, currentUser, businessId)) return res.status(403).json({ error: 'Insufficient permissions' });

    const now = new Date();
    const table: PricingTableDoc = {
      _id: crypto.randomUUID(),
      businessId,
      productId: payload.productId,
      name: String(payload.name || ''),
      unitSystem: (payload.unitSystem || 'inches') as any,
      widthValues: Array.isArray(payload.widthValues) ? payload.widthValues : [],
      dropValues: Array.isArray(payload.dropValues) ? payload.dropValues : [],
      priceMatrix: Array.isArray(payload.priceMatrix) ? payload.priceMatrix : [],
      metadata: payload.metadata || {},
      isDefault: Boolean(payload.isDefault),
      createdAt: now,
      updatedAt: now
    };

    if (table.isDefault) {
      await pricingTablesCollection().updateMany({ businessId } as any, { $set: { isDefault: false } } as any);
    }

    await pricingTablesCollection().insertOne(table as any);

    const event: CloudEvent<{ pricingTableId: string; businessId: string }> = {
      id: crypto.randomUUID(),
      type: 'pricingTables.created',
      version: 1,
      source: 'pricing-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { pricingTableId: table._id, businessId: table.businessId }
    };
    await eventBus.publish('pricingTables.created', event);

    res.status(201).json(toPricingResponse(table));
  }
);

app.put('/pricing-tables/:id', authenticate, requireAdminOrBusiness, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const id = req.params.id;
  const existing = await pricingTablesCollection().findOne({ _id: id } as any);
  if (!existing) return res.status(404).json({ error: 'Pricing table not found' });
  if (!canAccessBusiness(role, currentUser, existing.businessId)) return res.status(403).json({ error: 'Insufficient permissions' });

  const updates = req.body as Partial<PricingTableDoc>;
  delete (updates as any)._id;
  delete (updates as any).createdAt;
  delete (updates as any).businessId;
  updates.updatedAt = new Date();

  if (updates.isDefault) {
    await pricingTablesCollection().updateMany({ businessId: existing.businessId } as any, { $set: { isDefault: false } } as any);
  }

  const result = await pricingTablesCollection().updateOne({ _id: id } as any, { $set: updates } as any);
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Pricing table not found' });
  const updated = await pricingTablesCollection().findOne({ _id: id } as any);
  if (!updated) return res.status(404).json({ error: 'Pricing table not found' });

  const event: CloudEvent<{ pricingTableId: string }> = {
    id: crypto.randomUUID(),
    type: 'pricingTables.updated',
    version: 1,
    source: 'pricing-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { pricingTableId: id }
  };
  await eventBus.publish('pricingTables.updated', event);

  res.json(toPricingResponse(updated));
});

app.delete('/pricing-tables/:id', authenticate, requireAdminOrBusiness, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const id = req.params.id;
  const existing = await pricingTablesCollection().findOne({ _id: id } as any);
  if (!existing) return res.status(404).json({ error: 'Pricing table not found' });
  if (!canAccessBusiness(role, currentUser, existing.businessId)) return res.status(403).json({ error: 'Insufficient permissions' });

  await pricingTablesCollection().deleteOne({ _id: id } as any);

  const event: CloudEvent<{ pricingTableId: string; businessId: string }> = {
    id: crypto.randomUUID(),
    type: 'pricingTables.deleted',
    version: 1,
    source: 'pricing-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { pricingTableId: id, businessId: existing.businessId }
  };
  await eventBus.publish('pricingTables.deleted', event);

  res.json({ status: 'OK' });
});

app.listen(PORT, '0.0.0.0', async () => {
  await mongo.connect();
  await eventBus.connect();
});
