"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const mongodb_1 = require("mongodb");
const crypto_1 = __importDefault(require("crypto"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const multer_1 = __importDefault(require("multer"));
const event_bus_1 = require("@blindscloud/event-bus");
dotenv_1.default.config();
const PORT = parseInt(process.env.PORT || '4010', 10);
const JWT_SECRET = process.env.JWT_SECRET || '';
const MONGO_URL = process.env.MONGO_URL || '';
const RABBITMQ_URL = process.env.RABBITMQ_URL || '';
const EVENT_EXCHANGE = process.env.EVENT_EXCHANGE || 'blindscloud.events';
const FILES_BASE_URL = process.env.FILES_BASE_URL || '';
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
if (!JWT_SECRET)
    throw new Error('JWT_SECRET is required');
if (!MONGO_URL)
    throw new Error('MONGO_URL is required');
if (!RABBITMQ_URL)
    throw new Error('RABBITMQ_URL is required');
const mongo = new mongodb_1.MongoClient(MONGO_URL);
const eventBus = new event_bus_1.EventBus({
    url: RABBITMQ_URL,
    exchange: EVENT_EXCHANGE,
    serviceName: 'files-service'
});
const filesCollection = () => mongo.db('blindscloud').collection('files');
const usersCollection = () => mongo.db('blindscloud').collection('users');
const jobsCollection = () => mongo.db('blindscloud').collection('jobs');
const imagesCollection = () => mongo.db('blindscloud').collection('images');
const authenticate = (req, res, next) => {
    const header = req.header('authorization') || req.header('Authorization');
    if (!header)
        return res.status(401).json({ error: 'Missing Authorization header' });
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match)
        return res.status(401).json({ error: 'Invalid Authorization header' });
    try {
        const decoded = jsonwebtoken_1.default.verify(match[1], JWT_SECRET);
        req.user = { id: String(decoded.userId), email: String(decoded.email), role: String(decoded.role) };
        next();
    }
    catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
};
const ensureUploadDir = async () => {
    await fs_1.default.promises.mkdir(UPLOAD_DIR, { recursive: true });
};
const storage = multer_1.default.diskStorage({
    destination: async (_req, _file, cb) => {
        try {
            await ensureUploadDir();
            cb(null, UPLOAD_DIR);
        }
        catch (err) {
            cb(err, UPLOAD_DIR);
        }
    },
    filename: (_req, file, cb) => {
        const id = crypto_1.default.randomUUID();
        const ext = path_1.default.extname(file.originalname || '');
        cb(null, `${id}${ext}`);
    }
});
const upload = (0, multer_1.default)({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 }
});
const toFileResponse = (doc) => {
    const base = FILES_BASE_URL || '';
    const url = base ? `${base.replace(/\/+$/, '')}/api/files/${doc._id}/content` : `/api/files/${doc._id}/content`;
    return {
        ...doc,
        createdAt: doc.createdAt.toISOString(),
        url
    };
};
const app = (0, express_1.default)();
app.use((0, helmet_1.default)());
app.use(express_1.default.json({ limit: '2mb' }));
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'files-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
app.post('/files', authenticate, upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file)
        return res.status(400).json({ error: 'Missing file' });
    const jobId = typeof req.body.jobId === 'string' ? req.body.jobId : undefined;
    const productId = typeof req.body.productId === 'string' ? req.body.productId : undefined;
    const isAdmin = req.user.role.toLowerCase() === 'admin';
    let job = null;
    let currentUser = null;
    if (jobId) {
        job = await jobsCollection().findOne({ _id: jobId });
        if (!job)
            return res.status(400).json({ error: 'Invalid jobId' });
        if (!isAdmin) {
            currentUser = await usersCollection().findOne({ _id: req.user.id });
            if (!currentUser)
                return res.status(401).json({ error: 'User not found' });
            if (!currentUser.businessId || currentUser.businessId !== job.businessId) {
                return res.status(403).json({ error: 'Insufficient permissions' });
            }
        }
    }
    const now = new Date();
    const doc = {
        _id: crypto_1.default.randomUUID(),
        ownerId: req.user.id,
        filename: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storagePath: file.path,
        jobId,
        productId,
        createdAt: now
    };
    await filesCollection().insertOne(doc);
    const fileResponse = toFileResponse(doc);
    if (job) {
        const imageType = typeof req.body.imageType === 'string' ? req.body.imageType : 'upload';
        const displayOrder = typeof req.body.displayOrder === 'string' ? Number(req.body.displayOrder) : 0;
        const image = {
            _id: crypto_1.default.randomUUID(),
            jobId: job._id,
            imageUrl: fileResponse.url,
            imageType,
            displayOrder: Number.isFinite(displayOrder) ? displayOrder : 0,
            createdAt: now,
            updatedAt: now
        };
        await imagesCollection().insertOne(image);
    }
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'files.uploaded',
        version: 1,
        source: 'files-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { fileId: doc._id, ownerId: doc.ownerId, jobId: doc.jobId, productId: doc.productId }
    };
    await eventBus.publish('files.uploaded', event);
    res.status(201).json(fileResponse);
});
app.get('/files', authenticate, async (req, res) => {
    const filter = { ownerId: req.user.id };
    if (typeof req.query.jobId === 'string')
        filter.jobId = req.query.jobId;
    if (typeof req.query.productId === 'string')
        filter.productId = req.query.productId;
    const docs = await filesCollection().find(filter).sort({ createdAt: -1 }).limit(200).toArray();
    res.json(docs.map(toFileResponse));
});
app.get('/files/:id', authenticate, async (req, res) => {
    const doc = await filesCollection().findOne({ _id: req.params.id });
    if (!doc)
        return res.status(404).json({ error: 'File not found' });
    if (doc.ownerId !== req.user.id && req.user.role.toLowerCase() !== 'admin')
        return res.status(403).json({ error: 'Insufficient permissions' });
    res.json(toFileResponse(doc));
});
app.get('/files/:id/content', authenticate, async (req, res) => {
    const doc = await filesCollection().findOne({ _id: req.params.id });
    if (!doc)
        return res.status(404).json({ error: 'File not found' });
    if (doc.ownerId !== req.user.id && req.user.role.toLowerCase() !== 'admin')
        return res.status(403).json({ error: 'Insufficient permissions' });
    try {
        await fs_1.default.promises.access(doc.storagePath, fs_1.default.constants.R_OK);
    }
    catch {
        return res.status(404).json({ error: 'File missing on disk' });
    }
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.filename)}"`);
    fs_1.default.createReadStream(doc.storagePath).pipe(res);
});
app.delete('/files/:id', authenticate, async (req, res) => {
    const doc = await filesCollection().findOne({ _id: req.params.id });
    if (!doc)
        return res.status(404).json({ error: 'File not found' });
    if (doc.ownerId !== req.user.id && req.user.role.toLowerCase() !== 'admin')
        return res.status(403).json({ error: 'Insufficient permissions' });
    await filesCollection().deleteOne({ _id: doc._id });
    await fs_1.default.promises.unlink(doc.storagePath).catch(() => void 0);
    const event = {
        id: crypto_1.default.randomUUID(),
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
