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
const fs_1 = __importDefault(require("fs"));
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
const EMPLOYEE_ACCEPT_JOBS_PERMISSION = 'employee_accept_jobs';
const EMPLOYEE_ASSIGNMENT_PERMISSION = 'employee_be_assigned_jobs';
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
const plansCollection = () => mongo.db('blindscloud').collection('subscription_plans');
const subsCollection = () => mongo.db('blindscloud').collection('user_subscriptions');
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
    if (job.employeeId) {
        const canBeAssigned = Array.isArray(currentUser.permissions) && currentUser.permissions.includes(EMPLOYEE_ASSIGNMENT_PERMISSION);
        return job.employeeId === currentUser._id && canBeAssigned;
    }
    return true;
};
const toIsoDateString = (value) => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString();
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
    }
    return '';
};
const toJobResponse = (job) => ({
    ...job,
    createdAt: toIsoDateString(job.createdAt),
    updatedAt: toIsoDateString(job.updatedAt),
    scheduledDate: toIsoDateString(job.scheduledDate),
    completedDate: toIsoDateString(job.completedDate)
});
const toMeasurementResponse = (m) => ({
    ...m,
    createdAt: toIsoDateString(m.createdAt),
    updatedAt: toIsoDateString(m.updatedAt)
});
const toImageResponse = (img) => ({
    ...img,
    createdAt: toIsoDateString(img.createdAt),
    updatedAt: toIsoDateString(img.updatedAt)
});
const parseDate = (value) => {
    if (typeof value !== 'string')
        return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime()))
        return null;
    return d;
};
const getActiveSubscriptionForBusiness = async (businessId) => {
    if (!businessId)
        return null;
    const businessUsers = await usersCollection()
        .find({ businessId, role: 'business' })
        .project({ _id: 1 })
        .toArray();
    const ids = businessUsers.map((u) => u._id).filter((id) => typeof id === 'string' && id.length > 0);
    if (ids.length === 0)
        return null;
    const activeStatuses = ['active', 'trial', 'past_due'];
    const subscription = await subsCollection().findOne({ userId: { $in: ids }, status: { $in: activeStatuses } }, { sort: { currentPeriodEnd: -1 } });
    if (!subscription)
        return null;
    const plan = await plansCollection().findOne({ _id: String(subscription.planId || '') });
    if (!plan)
        return null;
    return { subscription, plan };
};
const inferBillingCycle = (sub) => {
    const raw = String(sub.billingCycle || '').toLowerCase();
    if (raw === 'one_month' || raw === 'monthly' || raw === 'yearly')
        return raw;
    const startMs = sub.currentPeriodStart?.getTime?.() ?? NaN;
    const endMs = sub.currentPeriodEnd?.getTime?.() ?? NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs)
        return 'monthly';
    const days = (endMs - startMs) / (1000 * 60 * 60 * 24);
    if (days >= 300)
        return 'yearly';
    return 'monthly';
};
const getMaxJobsForPeriod = (plan, sub) => {
    const maxJobs = plan.maxJobs;
    if (maxJobs === null)
        return null;
    const n = typeof maxJobs === 'number' ? maxJobs : Number(maxJobs);
    if (!Number.isFinite(n))
        return null;
    const cycle = inferBillingCycle(sub);
    const multiplier = cycle === 'yearly' ? 12 : 1;
    return Math.max(0, Math.floor(n * multiplier));
};
const DEBUG_ENV_PATH = '.dbg/jobs-504-timeout.env';
const DEBUG_DEFAULT_URL = 'http://127.0.0.1:7777/event';
const DEBUG_DEFAULT_SESSION_ID = 'jobs-504-timeout';
const readDebugConfig = () => {
    let url = process.env.DEBUG_SERVER_URL || DEBUG_DEFAULT_URL;
    let sessionId = process.env.DEBUG_SESSION_ID || DEBUG_DEFAULT_SESSION_ID;
    try {
        const raw = fs_1.default.readFileSync(DEBUG_ENV_PATH, 'utf8');
        const envUrl = raw.match(/^DEBUG_SERVER_URL=(.+)$/m)?.[1]?.trim();
        const envSessionId = raw.match(/^DEBUG_SESSION_ID=(.+)$/m)?.[1]?.trim();
        if (envUrl)
            url = envUrl;
        if (envSessionId)
            sessionId = envSessionId;
    }
    catch {
        void 0;
    }
    return { url, sessionId };
};
const reportDebug = async (hypothesisId, location, msg, data) => {
    const { url, sessionId } = readDebugConfig();
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId,
                runId: 'pre-fix',
                hypothesisId,
                location,
                msg,
                data,
                ts: Date.now()
            })
        });
    }
    catch {
        void 0;
    }
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
    const traceId = crypto_1.default.randomUUID();
    try {
        const role = req.user.role.toLowerCase();
        // #region debug-point A:jobs-entry
        await reportDebug('A', 'jobs-service:/jobs:entry', '[DEBUG] /jobs request started', {
            traceId,
            userId: req.user?.id,
            role,
            queryBusinessId: typeof req.query.businessId === 'string' ? req.query.businessId : null
        });
        // #endregion
        const currentUser = await getCurrentUser(req);
        // #region debug-point D:user-lookup
        await reportDebug('D', 'jobs-service:/jobs:user-lookup', '[DEBUG] /jobs current user lookup finished', {
            traceId,
            foundUser: Boolean(currentUser),
            currentUserId: currentUser?._id || null,
            currentUserBusinessId: currentUser?.businessId || null
        });
        // #endregion
        if (!currentUser)
            return res.status(401).json({ error: 'User not found', traceId });
        const filter = {};
        if (role !== 'admin') {
            filter.businessId = currentUser.businessId;
            if (role === 'employee') {
                const canBeAssigned = Array.isArray(currentUser.permissions) && currentUser.permissions.includes(EMPLOYEE_ASSIGNMENT_PERMISSION);
                filter.$or = [
                    { employeeId: { $exists: false } },
                    { employeeId: null }
                ];
                if (canBeAssigned) {
                    filter.$or.unshift({ employeeId: currentUser._id });
                }
            }
        }
        else if (req.query.businessId && typeof req.query.businessId === 'string') {
            filter.businessId = req.query.businessId;
        }
        const jobs = await jobsCollection().find(filter).sort({ scheduledDate: -1 }).toArray();
        const suspiciousJobs = jobs
            .filter((job) => !(job.createdAt instanceof Date) ||
            !(job.scheduledDate instanceof Date) ||
            (job.completedDate != null && !(job.completedDate instanceof Date)))
            .slice(0, 10)
            .map((job) => ({
            id: job._id,
            createdAtType: job.createdAt == null ? 'nullish' : typeof job.createdAt,
            scheduledDateType: job.scheduledDate == null ? 'nullish' : typeof job.scheduledDate,
            completedDateType: job.completedDate == null ? 'nullish' : typeof job.completedDate
        }));
        // #region debug-point B:jobs-query
        await reportDebug('B', 'jobs-service:/jobs:query', '[DEBUG] /jobs query completed', {
            traceId,
            filter,
            jobCount: jobs.length,
            suspiciousJobs
        });
        // #endregion
        const response = jobs.map((job, index) => {
            try {
                return toJobResponse(job);
            }
            catch (err) {
                throw new Error(`Failed to serialize job at index ${index} with id ${job?._id || 'unknown'}: ${err?.message || String(err)}`);
            }
        });
        // #region debug-point A:jobs-success
        await reportDebug('A', 'jobs-service:/jobs:success', '[DEBUG] /jobs response serialized', {
            traceId,
            responseCount: response.length
        });
        // #endregion
        return res.json(response);
    }
    catch (err) {
        // #region debug-point A:jobs-error
        await reportDebug('A', 'jobs-service:/jobs:error', '[DEBUG] /jobs request failed', {
            traceId,
            errorName: err?.name || null,
            errorMessage: err?.message || String(err),
            errorStack: err?.stack || null
        });
        // #endregion
        return res.status(500).json({
            error: 'Jobs endpoint failed',
            traceId,
            details: err?.message || String(err)
        });
    }
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
    const todayKey = new Date().toISOString().slice(0, 10);
    const scheduledKey = scheduledDate.toISOString().slice(0, 10);
    if (scheduledKey < todayKey)
        return res.status(400).json({ error: 'Scheduled date cannot be in the past' });
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
    if (role !== 'admin') {
        const current = await getActiveSubscriptionForBusiness(businessId);
        if (!current) {
            return res.status(403).json({ error: 'No active subscription. Please subscribe to create jobs.' });
        }
        const allowed = getMaxJobsForPeriod(current.plan, current.subscription);
        if (typeof allowed === 'number') {
            const used = await jobsCollection().countDocuments({
                businessId,
                createdAt: { $gte: current.subscription.currentPeriodStart, $lt: current.subscription.currentPeriodEnd }
            });
            if (used >= allowed) {
                const cycle = inferBillingCycle(current.subscription);
                const unit = cycle === 'yearly' ? 'year' : 'month';
                return res.status(403).json({
                    error: `Job limit reached. Your plan allows ${allowed} jobs per ${unit}. You have used ${used}.`
                });
            }
        }
    }
    const now = new Date();
    const job = {
        _id: crypto_1.default.randomUUID(),
        title: String(payload.title || ''),
        description: payload.description,
        status: (payload.status || 'pending'),
        jobType: typeof payload.jobType === 'string' ? payload.jobType : undefined,
        customerId: String(payload.customerId || ''),
        employeeId: payload.employeeId,
        businessId,
        scheduledDate,
        scheduledTime: typeof payload.scheduledTime === 'string' ? payload.scheduledTime : undefined,
        completedDate: payload.completedDate,
        quotation: typeof payload.quotation === 'number' ? payload.quotation : 0,
        invoice: typeof payload.invoice === 'number' ? payload.invoice : 0,
        currency: typeof payload.currency === 'string' ? payload.currency : undefined,
        notes: typeof payload.notes === 'string' ? payload.notes : undefined,
        deposit: typeof payload.deposit === 'number' ? payload.deposit : undefined,
        depositPaid: typeof payload.depositPaid === 'boolean' ? payload.depositPaid : undefined,
        paymentMethod: typeof payload.paymentMethod === 'string' ? payload.paymentMethod : undefined,
        customerReference: typeof payload.customerReference === 'string' ? payload.customerReference : undefined,
        quotationSent: typeof payload.quotationSent === 'boolean' ? payload.quotationSent : undefined,
        startTime: typeof payload.startTime === 'string' ? parseDate(payload.startTime) || undefined : undefined,
        endTime: typeof payload.endTime === 'string' ? parseDate(payload.endTime) || undefined : undefined,
        measurements: payload.measurements,
        selectedProducts: payload.selectedProducts,
        jobHistory: Array.isArray(payload.jobHistory) ? payload.jobHistory : undefined,
        parentJobId: typeof payload.parentJobId === 'string' ? payload.parentJobId : undefined,
        currentStep: typeof payload.currentStep === 'string' ? payload.currentStep : undefined,
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
    if (role === 'employee') {
        const canAcceptJobs = Array.isArray(currentUser.permissions) && currentUser.permissions.includes(EMPLOYEE_ACCEPT_JOBS_PERMISSION);
        const nextStatus = typeof updates.status === 'string' ? updates.status.toLowerCase() : '';
        const isAssignmentResponse = nextStatus === 'confirmed' ||
            nextStatus === 'pending' ||
            nextStatus === 'cancelled' ||
            Object.prototype.hasOwnProperty.call(updates, 'employeeId');
        if (isAssignmentResponse && !canAcceptJobs) {
            return res.status(403).json({ error: 'This employee is not allowed to accept or cancel jobs' });
        }
    }
    if ((role === 'admin' || role === 'business') && typeof updates.employeeId === 'string' && updates.employeeId.trim()) {
        const targetEmployee = await usersCollection().findOne({ _id: updates.employeeId.trim() });
        if (!targetEmployee) {
            return res.status(400).json({ error: 'Assigned employee not found' });
        }
        if (String(targetEmployee.role || '').toLowerCase() !== 'employee' || targetEmployee.businessId !== existing.businessId) {
            return res.status(400).json({ error: 'Assigned user must be an employee in this business' });
        }
        const canReceiveAssignments = Array.isArray(targetEmployee.permissions) && targetEmployee.permissions.includes(EMPLOYEE_ASSIGNMENT_PERMISSION);
        if (!canReceiveAssignments) {
            return res.status(403).json({ error: 'This employee is not available for assignment' });
        }
    }
    if (typeof updates.scheduledDate === 'string') {
        const d = parseDate(updates.scheduledDate);
        if (!d)
            return res.status(400).json({ error: 'Invalid scheduledDate' });
        const todayKey = new Date().toISOString().slice(0, 10);
        const scheduledKey = d.toISOString().slice(0, 10);
        if (scheduledKey < todayKey)
            return res.status(400).json({ error: 'Scheduled date cannot be in the past' });
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
