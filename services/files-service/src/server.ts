import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type { FileDoc, UserRole } from '@blindscloud/models';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4010', 10);
const JWT_SECRET = process.env.JWT_SECRET || '';
const MONGO_URL = process.env.MONGO_URL || '';
const RABBITMQ_URL = process.env.RABBITMQ_URL || '';
const EVENT_EXCHANGE = process.env.EVENT_EXCHANGE || 'blindscloud.events';
const FILES_BASE_URL = process.env.FILES_BASE_URL || '';
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';

if (!JWT_SECRET) throw new Error('JWT_SECRET is required');
if (!MONGO_URL) throw new Error('MONGO_URL is required');
if (!RABBITMQ_URL) throw new Error('RABBITMQ_URL is required');

type AuthUser = { id: string; email: string; role: UserRole | string };
type AuthRequest = Request & { user?: AuthUser };

const mongo = new MongoClient(MONGO_URL);
const eventBus = new EventBus({
  url: RABBITMQ_URL,
  exchange: EVENT_EXCHANGE,
  serviceName: 'files-service'
});

const filesCollection = () => mongo.db('blindscloud').collection<FileDoc>('files');

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

const ensureUploadDir = async () => {
  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
};

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await ensureUploadDir();
      cb(null, UPLOAD_DIR);
    } catch (err) {
      cb(err as any, UPLOAD_DIR);
    }
  },
  filename: (_req, file, cb) => {
    const id = crypto.randomUUID();
    const ext = path.extname(file.originalname || '');
    cb(null, `${id}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }
});

const toFileResponse = (doc: FileDoc) => {
  const base = FILES_BASE_URL || '';
  const url = base ? `${base.replace(/\/+$/, '')}/api/files/${doc._id}/content` : `/api/files/${doc._id}/content`;
  return {
    ...doc,
    createdAt: doc.createdAt.toISOString(),
    url
  };
};

const app = express();
app.use(helmet());
app.use(express.json({ limit: '2mb' }));

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'files-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

app.post('/files', authenticate, upload.single('file'), async (req: AuthRequest, res: Response) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) return res.status(400).json({ error: 'Missing file' });

  const now = new Date();
  const doc: FileDoc = {
    _id: crypto.randomUUID(),
    ownerId: req.user!.id,
    filename: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    storagePath: file.path,
    jobId: typeof req.body.jobId === 'string' ? req.body.jobId : undefined,
    productId: typeof req.body.productId === 'string' ? req.body.productId : undefined,
    createdAt: now
  };

  await filesCollection().insertOne(doc as any);

  const event: CloudEvent<{ fileId: string; ownerId: string; jobId?: string; productId?: string }> = {
    id: crypto.randomUUID(),
    type: 'files.uploaded',
    version: 1,
    source: 'files-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { fileId: doc._id, ownerId: doc.ownerId, jobId: doc.jobId, productId: doc.productId }
  };
  await eventBus.publish('files.uploaded', event);

  res.status(201).json(toFileResponse(doc));
});

app.get('/files', authenticate, async (req: AuthRequest, res: Response) => {
  const filter: any = { ownerId: req.user!.id };
  if (typeof req.query.jobId === 'string') filter.jobId = req.query.jobId;
  if (typeof req.query.productId === 'string') filter.productId = req.query.productId;

  const docs = await filesCollection().find(filter).sort({ createdAt: -1 }).limit(200).toArray();
  res.json(docs.map(toFileResponse));
});

app.get('/files/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const doc = await filesCollection().findOne({ _id: req.params.id } as any);
  if (!doc) return res.status(404).json({ error: 'File not found' });
  if (doc.ownerId !== req.user!.id && req.user!.role.toLowerCase() !== 'admin') return res.status(403).json({ error: 'Insufficient permissions' });
  res.json(toFileResponse(doc));
});

app.get('/files/:id/content', authenticate, async (req: AuthRequest, res: Response) => {
  const doc = await filesCollection().findOne({ _id: req.params.id } as any);
  if (!doc) return res.status(404).json({ error: 'File not found' });
  if (doc.ownerId !== req.user!.id && req.user!.role.toLowerCase() !== 'admin') return res.status(403).json({ error: 'Insufficient permissions' });

  try {
    await fs.promises.access(doc.storagePath, fs.constants.R_OK);
  } catch {
    return res.status(404).json({ error: 'File missing on disk' });
  }

  res.setHeader('Content-Type', doc.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.filename)}"`);
  fs.createReadStream(doc.storagePath).pipe(res);
});

app.delete('/files/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const doc = await filesCollection().findOne({ _id: req.params.id } as any);
  if (!doc) return res.status(404).json({ error: 'File not found' });
  if (doc.ownerId !== req.user!.id && req.user!.role.toLowerCase() !== 'admin') return res.status(403).json({ error: 'Insufficient permissions' });

  await filesCollection().deleteOne({ _id: doc._id } as any);
  await fs.promises.unlink(doc.storagePath).catch(() => void 0);

  const event: CloudEvent<{ fileId: string; ownerId: string }> = {
    id: crypto.randomUUID(),
    type: 'files.deleted',
    version: 1,
    source: 'files-service',
    occurredAt: new Date().toISOString(),
    correlationId: req.header('x-correlation-id') || undefined,
    payload: { fileId: doc._id, ownerId: doc.ownerId }
  };
  await eventBus.publish('files.deleted', event);

  res.json({ status: 'OK' });
});

app.listen(PORT, '0.0.0.0', async () => {
  await mongo.connect();
  await eventBus.connect();
  await ensureUploadDir();
});

