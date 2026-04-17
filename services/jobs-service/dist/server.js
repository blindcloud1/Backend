"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const express_validator_1 = require("express-validator");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const mongodb_1 = require("mongodb");
const crypto_1 = __importDefault(require("crypto"));
const event_bus_1 = require("@blindscloud/event-bus");
dotenv_1.default.config();
const PORT = parseInt(process.env.PORT || '4005', 10);
const JWT_SECRET = process.env.JWT_SECRET || '';
const MONGO_URL = process.env.MONGO_URL || '';
const RABBITMQ_URL = process.env.RABBITMQ_URL || '';
const EVENT_EXCHANGE = process.env.EVENT_EXCHANGE || 'blindscloud.events';
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
    serviceName: 'jobs-service'
});
const usersCollection = () => mongo.db('blindscloud').collection('users');
const customersCollection = () => mongo.db('blindscloud').collection('customers');
const jobsCollection = () => mongo.db('blindscloud').collection('jobs');
const measurementsCollection = () => mongo.db('blindscloud').collection('measurements');
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
const getCurrentUser = async (req) => {
    return usersCollection().findOne({ _id: req.user.id });
};
const canAccessBusiness = (role, currentUser, businessId) => {
    if (role === 'admin')
        return true;
    return Boolean(currentUser.businessId && currentUser.businessId === businessId);
};
const canAccessJob = (role, currentUser, job) => {
    if (role === 'admin')
        return true;
    if (!currentUser.businessId || job.businessId !== currentUser.businessId)
        return false;
    if (role === 'business')
        return true;
    return job.employeeId ? job.employeeId === currentUser._id : true;
};
const toJobResponse = (job) => ({
    ...job,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt?.toISOString(),
    scheduledDate: job.scheduledDate.toISOString(),
    completedDate: job.completedDate?.toISOString()
});
const toMeasurementResponse = (m) => ({
    ...m,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt?.toISOString()
});
const toImageResponse = (img) => ({
    ...img,
    createdAt: img.createdAt.toISOString(),
    updatedAt: img.updatedAt?.toISOString()
});
const parseDate = (value) => {
    if (typeof value !== 'string')
        return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime()))
        return null;
    return d;
};
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '4mb' }));
app.use((0, helmet_1.default)());
app.get('/health', async (_req, res) => {
    try {
        await mongo.db('admin').command({ ping: 1 });
        res.json({ status: 'OK', service: 'jobs-service' });
    }
    catch (err) {
        res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
    }
});
app.get('/jobs', authenticate, async (req, res) => {
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const filter = {};
    if (role !== 'admin') {
        filter.businessId = currentUser.businessId;
        if (role === 'employee') {
            filter.$or = [{ employeeId: currentUser._id }, { employeeId: { $exists: false } }, { employeeId: null }];
        }
    }
    else if (req.query.businessId && typeof req.query.businessId === 'string') {
        filter.businessId = req.query.businessId;
    }
    const jobs = await jobsCollection().find(filter).sort({ scheduledDate: -1 }).toArray();
    res.json(jobs.map(toJobResponse));
});
app.get('/jobs/:id', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const job = await jobsCollection().findOne({ _id: req.params.id });
    if (!job)
        return res.status(404).json({ error: 'Job not found' });
    if (!canAccessJob(role, currentUser, job))
        return res.status(403).json({ error: 'Insufficient permissions' });
    res.json(toJobResponse(job));
});
app.post('/jobs', authenticate, [(0, express_validator_1.body)('title').isLength({ min: 1 }), (0, express_validator_1.body)('customerId').isLength({ min: 1 }), (0, express_validator_1.body)('scheduledDate').isString()], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const payload = req.body;
    const scheduledDate = parseDate(payload.scheduledDate);
    if (!scheduledDate)
        return res.status(400).json({ error: 'Invalid scheduledDate' });
    const customer = await customersCollection().findOne({ _id: String(payload.customerId || '') });
    if (!customer)
        return res.status(400).json({ error: 'Invalid customerId' });
    const businessId = role === 'admin' ? String(payload.businessId || customer.businessId || '') : String(currentUser.businessId || '');
    if (!businessId)
        return res.status(400).json({ error: 'businessId is required' });
    if (!canAccessBusiness(role, currentUser, businessId))
        return res.status(403).json({ error: 'Insufficient permissions' });
    if (customer.businessId !== businessId)
        return res.status(400).json({ error: 'Customer business mismatch' });
    const now = new Date();
    const job = {
        _id: crypto_1.default.randomUUID(),
        title: String(payload.title || ''),
        description: payload.description,
        status: (payload.status || 'pending'),
        customerId: String(payload.customerId || ''),
        employeeId: payload.employeeId,
        businessId,
        scheduledDate,
        completedDate: payload.completedDate,
        quotation: typeof payload.quotation === 'number' ? payload.quotation : 0,
        invoice: typeof payload.invoice === 'number' ? payload.invoice : 0,
        signature: payload.signature,
        images: Array.isArray(payload.images) ? payload.images : [],
        documents: Array.isArray(payload.documents) ? payload.documents : [],
        checklist: Array.isArray(payload.checklist) ? payload.checklist : [],
        createdAt: now,
        updatedAt: now
    };
    await jobsCollection().insertOne(job);
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'jobs.created',
        version: 1,
        source: 'jobs-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { jobId: job._id, businessId: job.businessId, customerId: job.customerId }
    };
    await eventBus.publish('jobs.created', event);
    res.status(201).json(toJobResponse(job));
});
app.put('/jobs/:id', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const jobId = req.params.id;
    const existing = await jobsCollection().findOne({ _id: jobId });
    if (!existing)
        return res.status(404).json({ error: 'Job not found' });
    if (!canAccessJob(role, currentUser, existing))
        return res.status(403).json({ error: 'Insufficient permissions' });
    const updates = req.body;
    delete updates._id;
    delete updates.createdAt;
    delete updates.businessId;
    delete updates.customerId;
    if (typeof updates.scheduledDate === 'string') {
        const d = parseDate(updates.scheduledDate);
        if (!d)
            return res.status(400).json({ error: 'Invalid scheduledDate' });
        updates.scheduledDate = d;
    }
    if (typeof updates.completedDate === 'string') {
        const d = parseDate(updates.completedDate);
        if (!d)
            return res.status(400).json({ error: 'Invalid completedDate' });
        updates.completedDate = d;
    }
    updates.updatedAt = new Date();
    const result = await jobsCollection().updateOne({ _id: jobId }, { $set: updates });
    if (result.matchedCount === 0)
        return res.status(404).json({ error: 'Job not found' });
    const updated = await jobsCollection().findOne({ _id: jobId });
    if (!updated)
        return res.status(404).json({ error: 'Job not found' });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'jobs.updated',
        version: 1,
        source: 'jobs-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { jobId }
    };
    await eventBus.publish('jobs.updated', event);
    res.json(toJobResponse(updated));
});
app.delete('/jobs/:id', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const jobId = req.params.id;
    const existing = await jobsCollection().findOne({ _id: jobId });
    if (!existing)
        return res.status(404).json({ error: 'Job not found' });
    if (!canAccessJob(role, currentUser, existing))
        return res.status(403).json({ error: 'Insufficient permissions' });
    await measurementsCollection().deleteMany({ jobId });
    await imagesCollection().deleteMany({ jobId });
    await jobsCollection().deleteOne({ _id: jobId });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'jobs.deleted',
        version: 1,
        source: 'jobs-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { jobId }
    };
    await eventBus.publish('jobs.deleted', event);
    res.json({ status: 'OK' });
});
app.get('/jobs/:id/measurements', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const job = await jobsCollection().findOne({ _id: req.params.id });
    if (!job)
        return res.status(404).json({ error: 'Job not found' });
    if (!canAccessJob(role, currentUser, job))
        return res.status(403).json({ error: 'Insufficient permissions' });
    const measurements = await measurementsCollection().find({ jobId: job._id }).sort({ createdAt: -1 }).toArray();
    res.json(measurements.map(toMeasurementResponse));
});
app.post('/jobs/:id/measurements', authenticate, [
    (0, express_validator_1.param)('id').isLength({ min: 1 }),
    (0, express_validator_1.body)('windowId').isLength({ min: 1 }),
    (0, express_validator_1.body)('width').isNumeric(),
    (0, express_validator_1.body)('height').isNumeric()
], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const job = await jobsCollection().findOne({ _id: req.params.id });
    if (!job)
        return res.status(404).json({ error: 'Job not found' });
    if (!canAccessJob(role, currentUser, job))
        return res.status(403).json({ error: 'Insufficient permissions' });
    const payload = req.body;
    const now = new Date();
    const measurement = {
        _id: crypto_1.default.randomUUID(),
        jobId: job._id,
        productId: payload.productId,
        windowId: String(payload.windowId || ''),
        width: Number(payload.width),
        height: Number(payload.height),
        notes: payload.notes,
        location: payload.location,
        controlType: payload.controlType,
        bracketType: payload.bracketType,
        createdAt: now,
        updatedAt: now
    };
    await measurementsCollection().insertOne(measurement);
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'measurements.created',
        version: 1,
        source: 'jobs-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { jobId: job._id, measurementId: measurement._id }
    };
    await eventBus.publish('measurements.created', event);
    res.status(201).json(toMeasurementResponse(measurement));
});
app.delete('/jobs/:id/measurements/:measurementId', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 }), (0, express_validator_1.param)('measurementId').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const job = await jobsCollection().findOne({ _id: req.params.id });
    if (!job)
        return res.status(404).json({ error: 'Job not found' });
    if (!canAccessJob(role, currentUser, job))
        return res.status(403).json({ error: 'Insufficient permissions' });
    await measurementsCollection().deleteOne({ _id: req.params.measurementId, jobId: job._id });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'measurements.deleted',
        version: 1,
        source: 'jobs-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { jobId: job._id, measurementId: req.params.measurementId }
    };
    await eventBus.publish('measurements.deleted', event);
    res.json({ status: 'OK' });
});
app.get('/jobs/:id/images', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const job = await jobsCollection().findOne({ _id: req.params.id });
    if (!job)
        return res.status(404).json({ error: 'Job not found' });
    if (!canAccessJob(role, currentUser, job))
        return res.status(403).json({ error: 'Insufficient permissions' });
    const images = await imagesCollection().find({ jobId: job._id }).sort({ displayOrder: 1, createdAt: 1 }).toArray();
    res.json(images.map(toImageResponse));
});
app.post('/jobs/:id/images', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 }), (0, express_validator_1.body)('imageUrl').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const job = await jobsCollection().findOne({ _id: req.params.id });
    if (!job)
        return res.status(404).json({ error: 'Job not found' });
    if (!canAccessJob(role, currentUser, job))
        return res.status(403).json({ error: 'Insufficient permissions' });
    const payload = req.body;
    const now = new Date();
    const image = {
        _id: crypto_1.default.randomUUID(),
        jobId: job._id,
        imageUrl: String(payload.imageUrl || ''),
        imageType: String(payload.imageType || 'installation_photo'),
        displayOrder: typeof payload.displayOrder === 'number' ? payload.displayOrder : 0,
        createdAt: now,
        updatedAt: now
    };
    await imagesCollection().insertOne(image);
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'images.created',
        version: 1,
        source: 'jobs-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { jobId: job._id, imageId: image._id }
    };
    await eventBus.publish('images.created', event);
    res.status(201).json(toImageResponse(image));
});
app.delete('/jobs/:id/images/:imageId', authenticate, [(0, express_validator_1.param)('id').isLength({ min: 1 }), (0, express_validator_1.param)('imageId').isLength({ min: 1 })], async (req, res) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
    const role = req.user.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser)
        return res.status(401).json({ error: 'User not found' });
    const job = await jobsCollection().findOne({ _id: req.params.id });
    if (!job)
        return res.status(404).json({ error: 'Job not found' });
    if (!canAccessJob(role, currentUser, job))
        return res.status(403).json({ error: 'Insufficient permissions' });
    await imagesCollection().deleteOne({ _id: req.params.imageId, jobId: job._id });
    const event = {
        id: crypto_1.default.randomUUID(),
        type: 'images.deleted',
        version: 1,
        source: 'jobs-service',
        occurredAt: new Date().toISOString(),
        correlationId: req.header('x-correlation-id') || undefined,
        payload: { jobId: job._id, imageId: req.params.imageId }
    };
    await eventBus.publish('images.deleted', event);
    res.json({ status: 'OK' });
});
app.listen(PORT, '0.0.0.0', async () => {
    await mongo.connect();
    await eventBus.connect();
});
