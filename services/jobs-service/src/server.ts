import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { body, param, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import { EventBus, type CloudEvent } from '@blindscloud/event-bus';
import type {
  CustomerDoc,
  JobDoc,
  JobImageDoc,
  JobStatus,
  MeasurementDoc,
  SubscriptionPlanDoc,
  UserDoc,
  UserRole,
  UserSubscriptionDoc
} from '@blindscloud/models';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4005', 10);
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
  serviceName: 'jobs-service'
});

const usersCollection = () => mongo.db('blindscloud').collection<UserDoc>('users');
const customersCollection = () => mongo.db('blindscloud').collection<CustomerDoc>('customers');
const jobsCollection = () => mongo.db('blindscloud').collection<JobDoc>('jobs');
const measurementsCollection = () => mongo.db('blindscloud').collection<MeasurementDoc>('measurements');
const imagesCollection = () => mongo.db('blindscloud').collection<JobImageDoc>('images');
const plansCollection = () => mongo.db('blindscloud').collection<SubscriptionPlanDoc>('subscription_plans');
const subsCollection = () => mongo.db('blindscloud').collection<UserSubscriptionDoc>('user_subscriptions');

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

const canAccessBusiness = (role: string, currentUser: UserDoc, businessId: string): boolean => {
  if (role === 'admin') return true;
  return Boolean(currentUser.businessId && currentUser.businessId === businessId);
};

const canAccessJob = (role: string, currentUser: UserDoc, job: JobDoc): boolean => {
  if (role === 'admin') return true;
  if (!currentUser.businessId || job.businessId !== currentUser.businessId) return false;
  if (role === 'business') return true;
  return job.employeeId ? job.employeeId === currentUser._id : true;
};

const toJobResponse = (job: JobDoc) => ({
  ...job,
  createdAt: job.createdAt.toISOString(),
  updatedAt: job.updatedAt?.toISOString(),
  scheduledDate: job.scheduledDate.toISOString(),
  completedDate: job.completedDate?.toISOString()
});

const toMeasurementResponse = (m: MeasurementDoc) => ({
  ...m,
  createdAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt?.toISOString()
});

const toImageResponse = (img: JobImageDoc) => ({
  ...img,
  createdAt: img.createdAt.toISOString(),
  updatedAt: img.updatedAt?.toISOString()
});

const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
};

const getActiveSubscriptionForBusiness = async (
  businessId: string
): Promise<{ subscription: UserSubscriptionDoc; plan: SubscriptionPlanDoc } | null> => {
  if (!businessId) return null;
  const businessUsers = await usersCollection()
    .find({ businessId, role: 'business' } as any)
    .project({ _id: 1 } as any)
    .toArray();

  const ids = businessUsers.map((u) => u._id).filter((id) => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return null;

  const activeStatuses = ['active', 'trial', 'past_due'];
  const subscription = await subsCollection().findOne(
    { userId: { $in: ids }, status: { $in: activeStatuses } } as any,
    { sort: { currentPeriodEnd: -1 } } as any
  );
  if (!subscription) return null;

  const plan = await plansCollection().findOne({ _id: String(subscription.planId || '') } as any);
  if (!plan) return null;

  return { subscription, plan };
};

const inferBillingCycle = (sub: UserSubscriptionDoc): 'one_month' | 'monthly' | 'yearly' => {
  const raw = String((sub as any).billingCycle || '').toLowerCase();
  if (raw === 'one_month' || raw === 'monthly' || raw === 'yearly') return raw;

  const startMs = sub.currentPeriodStart?.getTime?.() ?? NaN;
  const endMs = sub.currentPeriodEnd?.getTime?.() ?? NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 'monthly';

  const days = (endMs - startMs) / (1000 * 60 * 60 * 24);
  if (days >= 300) return 'yearly';
  return 'monthly';
};

const getMaxJobsForPeriod = (plan: SubscriptionPlanDoc, sub: UserSubscriptionDoc): number | null => {
  const maxJobs = (plan as any).maxJobs;
  if (maxJobs === null) return null;
  const n = typeof maxJobs === 'number' ? maxJobs : Number(maxJobs);
  if (!Number.isFinite(n)) return null;

  const cycle = inferBillingCycle(sub);
  const multiplier = cycle === 'yearly' ? 12 : 1;
  return Math.max(0, Math.floor(n * multiplier));
};

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(helmet());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: 'OK', service: 'jobs-service' });
  } catch (err: any) {
    res.status(500).json({ status: 'ERROR', error: err?.message || String(err) });
  }
});

app.get('/jobs', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const filter: any = {};
  if (role !== 'admin') {
    filter.businessId = currentUser.businessId;
    if (role === 'employee') {
      filter.$or = [{ employeeId: currentUser._id }, { employeeId: { $exists: false } }, { employeeId: null }];
    }
  } else if (req.query.businessId && typeof req.query.businessId === 'string') {
    filter.businessId = req.query.businessId;
  }

  const jobs = await jobsCollection().find(filter).sort({ scheduledDate: -1 }).toArray();
  res.json(jobs.map(toJobResponse));
});

app.get('/jobs/:id', authenticate, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const job = await jobsCollection().findOne({ _id: req.params.id } as any);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!canAccessJob(role, currentUser, job)) return res.status(403).json({ error: 'Insufficient permissions' });

  res.json(toJobResponse(job));
});

app.post(
  '/jobs',
  authenticate,
  [body('title').isLength({ min: 1 }), body('customerId').isLength({ min: 1 }), body('scheduledDate').isString()],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const role = req.user!.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser) return res.status(401).json({ error: 'User not found' });

    const payload = req.body as Partial<JobDoc> & { scheduledDate: string };
    const scheduledDate = parseDate(payload.scheduledDate);
    if (!scheduledDate) return res.status(400).json({ error: 'Invalid scheduledDate' });

    const customer = await customersCollection().findOne({ _id: String(payload.customerId || '') } as any);
    if (!customer) return res.status(400).json({ error: 'Invalid customerId' });

    const businessId = role === 'admin' ? String(payload.businessId || customer.businessId || '') : String(currentUser.businessId || '');
    if (!businessId) return res.status(400).json({ error: 'businessId is required' });
    if (!canAccessBusiness(role, currentUser, businessId)) return res.status(403).json({ error: 'Insufficient permissions' });
    if (customer.businessId !== businessId) return res.status(400).json({ error: 'Customer business mismatch' });

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
        } as any);

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
    const job: JobDoc = {
      _id: crypto.randomUUID(),
      title: String(payload.title || ''),
      description: payload.description,
      status: (payload.status || 'pending') as JobStatus,
      jobType: typeof (payload as any).jobType === 'string' ? (payload as any).jobType : undefined,
      customerId: String(payload.customerId || ''),
      employeeId: payload.employeeId,
      businessId,
      scheduledDate,
      scheduledTime: typeof (payload as any).scheduledTime === 'string' ? (payload as any).scheduledTime : undefined,
      completedDate: payload.completedDate,
      quotation: typeof payload.quotation === 'number' ? payload.quotation : 0,
      invoice: typeof payload.invoice === 'number' ? payload.invoice : 0,
      currency: typeof (payload as any).currency === 'string' ? (payload as any).currency : undefined,
      notes: typeof (payload as any).notes === 'string' ? (payload as any).notes : undefined,
      deposit: typeof (payload as any).deposit === 'number' ? (payload as any).deposit : undefined,
      depositPaid: typeof (payload as any).depositPaid === 'boolean' ? (payload as any).depositPaid : undefined,
      paymentMethod: typeof (payload as any).paymentMethod === 'string' ? (payload as any).paymentMethod : undefined,
      customerReference: typeof (payload as any).customerReference === 'string' ? (payload as any).customerReference : undefined,
      quotationSent: typeof (payload as any).quotationSent === 'boolean' ? (payload as any).quotationSent : undefined,
      startTime: typeof (payload as any).startTime === 'string' ? parseDate((payload as any).startTime) || undefined : undefined,
      endTime: typeof (payload as any).endTime === 'string' ? parseDate((payload as any).endTime) || undefined : undefined,
      measurements: (payload as any).measurements,
      selectedProducts: (payload as any).selectedProducts,
      jobHistory: Array.isArray((payload as any).jobHistory) ? (payload as any).jobHistory : undefined,
      parentJobId: typeof (payload as any).parentJobId === 'string' ? (payload as any).parentJobId : undefined,
      currentStep: typeof (payload as any).currentStep === 'string' ? (payload as any).currentStep : undefined,
      signature: payload.signature,
      images: Array.isArray(payload.images) ? payload.images : [],
      documents: Array.isArray(payload.documents) ? payload.documents : [],
      checklist: Array.isArray(payload.checklist) ? payload.checklist : [],
      createdAt: now,
      updatedAt: now
    };

    await jobsCollection().insertOne(job as any);

    const event: CloudEvent<{ jobId: string; businessId: string; customerId: string }> = {
      id: crypto.randomUUID(),
      type: 'jobs.created',
      version: 1,
      source: 'jobs-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { jobId: job._id, businessId: job.businessId, customerId: job.customerId }
    };
    await eventBus.publish('jobs.created', event);

    res.status(201).json(toJobResponse(job));
  }
);

app.put('/jobs/:id', authenticate, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const jobId = req.params.id;
  const existing = await jobsCollection().findOne({ _id: jobId } as any);
  if (!existing) return res.status(404).json({ error: 'Job not found' });
  if (!canAccessJob(role, currentUser, existing)) return res.status(403).json({ error: 'Insufficient permissions' });

  const updates = req.body as Partial<JobDoc> & { scheduledDate?: string; completedDate?: string };
  delete (updates as any)._id;
  delete (updates as any).createdAt;
  delete (updates as any).businessId;
  delete (updates as any).customerId;

  if (typeof updates.scheduledDate === 'string') {
    const d = parseDate(updates.scheduledDate);
    if (!d) return res.status(400).json({ error: 'Invalid scheduledDate' });
    (updates as any).scheduledDate = d;
  }
  if (typeof updates.completedDate === 'string') {
    const d = parseDate(updates.completedDate);
    if (!d) return res.status(400).json({ error: 'Invalid completedDate' });
    (updates as any).completedDate = d;
  }

  updates.updatedAt = new Date();

  const result = await jobsCollection().updateOne({ _id: jobId } as any, { $set: updates } as any);
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Job not found' });

  const updated = await jobsCollection().findOne({ _id: jobId } as any);
  if (!updated) return res.status(404).json({ error: 'Job not found' });

  const event: CloudEvent<{ jobId: string }> = {
    id: crypto.randomUUID(),
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

app.delete('/jobs/:id', authenticate, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const jobId = req.params.id;
  const existing = await jobsCollection().findOne({ _id: jobId } as any);
  if (!existing) return res.status(404).json({ error: 'Job not found' });
  if (!canAccessJob(role, currentUser, existing)) return res.status(403).json({ error: 'Insufficient permissions' });

  await measurementsCollection().deleteMany({ jobId } as any);
  await imagesCollection().deleteMany({ jobId } as any);
  await jobsCollection().deleteOne({ _id: jobId } as any);

  const event: CloudEvent<{ jobId: string }> = {
    id: crypto.randomUUID(),
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

app.get('/jobs/:id/measurements', authenticate, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const job = await jobsCollection().findOne({ _id: req.params.id } as any);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!canAccessJob(role, currentUser, job)) return res.status(403).json({ error: 'Insufficient permissions' });

  const measurements = await measurementsCollection().find({ jobId: job._id } as any).sort({ createdAt: -1 }).toArray();
  res.json(measurements.map(toMeasurementResponse));
});

app.post(
  '/jobs/:id/measurements',
  authenticate,
  [
    param('id').isLength({ min: 1 }),
    body('windowId').isLength({ min: 1 }),
    body('width').isNumeric(),
    body('height').isNumeric()
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const role = req.user!.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser) return res.status(401).json({ error: 'User not found' });

    const job = await jobsCollection().findOne({ _id: req.params.id } as any);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!canAccessJob(role, currentUser, job)) return res.status(403).json({ error: 'Insufficient permissions' });

    const payload = req.body as Partial<MeasurementDoc>;
    const now = new Date();
    const measurement: MeasurementDoc = {
      _id: crypto.randomUUID(),
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

    await measurementsCollection().insertOne(measurement as any);

    const event: CloudEvent<{ jobId: string; measurementId: string }> = {
      id: crypto.randomUUID(),
      type: 'measurements.created',
      version: 1,
      source: 'jobs-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { jobId: job._id, measurementId: measurement._id }
    };
    await eventBus.publish('measurements.created', event);

    res.status(201).json(toMeasurementResponse(measurement));
  }
);

app.delete(
  '/jobs/:id/measurements/:measurementId',
  authenticate,
  [param('id').isLength({ min: 1 }), param('measurementId').isLength({ min: 1 })],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const role = req.user!.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser) return res.status(401).json({ error: 'User not found' });

    const job = await jobsCollection().findOne({ _id: req.params.id } as any);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!canAccessJob(role, currentUser, job)) return res.status(403).json({ error: 'Insufficient permissions' });

    await measurementsCollection().deleteOne({ _id: req.params.measurementId, jobId: job._id } as any);

    const event: CloudEvent<{ jobId: string; measurementId: string }> = {
      id: crypto.randomUUID(),
      type: 'measurements.deleted',
      version: 1,
      source: 'jobs-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { jobId: job._id, measurementId: req.params.measurementId }
    };
    await eventBus.publish('measurements.deleted', event);

    res.json({ status: 'OK' });
  }
);

app.get('/jobs/:id/images', authenticate, [param('id').isLength({ min: 1 })], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const role = req.user!.role.toLowerCase();
  const currentUser = await getCurrentUser(req);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const job = await jobsCollection().findOne({ _id: req.params.id } as any);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!canAccessJob(role, currentUser, job)) return res.status(403).json({ error: 'Insufficient permissions' });

  const images = await imagesCollection().find({ jobId: job._id } as any).sort({ displayOrder: 1, createdAt: 1 }).toArray();
  res.json(images.map(toImageResponse));
});

app.post(
  '/jobs/:id/images',
  authenticate,
  [param('id').isLength({ min: 1 }), body('imageUrl').isLength({ min: 1 })],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const role = req.user!.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser) return res.status(401).json({ error: 'User not found' });

    const job = await jobsCollection().findOne({ _id: req.params.id } as any);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!canAccessJob(role, currentUser, job)) return res.status(403).json({ error: 'Insufficient permissions' });

    const payload = req.body as Partial<JobImageDoc>;
    const now = new Date();
    const image: JobImageDoc = {
      _id: crypto.randomUUID(),
      jobId: job._id,
      imageUrl: String(payload.imageUrl || ''),
      imageType: String(payload.imageType || 'installation_photo'),
      displayOrder: typeof payload.displayOrder === 'number' ? payload.displayOrder : 0,
      createdAt: now,
      updatedAt: now
    };

    await imagesCollection().insertOne(image as any);

    const event: CloudEvent<{ jobId: string; imageId: string }> = {
      id: crypto.randomUUID(),
      type: 'images.created',
      version: 1,
      source: 'jobs-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { jobId: job._id, imageId: image._id }
    };
    await eventBus.publish('images.created', event);

    res.status(201).json(toImageResponse(image));
  }
);

app.delete(
  '/jobs/:id/images/:imageId',
  authenticate,
  [param('id').isLength({ min: 1 }), param('imageId').isLength({ min: 1 })],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const role = req.user!.role.toLowerCase();
    const currentUser = await getCurrentUser(req);
    if (!currentUser) return res.status(401).json({ error: 'User not found' });

    const job = await jobsCollection().findOne({ _id: req.params.id } as any);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!canAccessJob(role, currentUser, job)) return res.status(403).json({ error: 'Insufficient permissions' });

    await imagesCollection().deleteOne({ _id: req.params.imageId, jobId: job._id } as any);

    const event: CloudEvent<{ jobId: string; imageId: string }> = {
      id: crypto.randomUUID(),
      type: 'images.deleted',
      version: 1,
      source: 'jobs-service',
      occurredAt: new Date().toISOString(),
      correlationId: req.header('x-correlation-id') || undefined,
      payload: { jobId: job._id, imageId: req.params.imageId }
    };
    await eventBus.publish('images.deleted', event);

    res.json({ status: 'OK' });
  }
);

app.listen(PORT, '0.0.0.0', async () => {
  await mongo.connect();
  await eventBus.connect();
});
