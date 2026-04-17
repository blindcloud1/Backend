export type Uuid = string;
export type IsoDateString = string;

export type UserRole = 'admin' | 'business' | 'employee' | 'merchant';
export type BusinessSubscriptionTier = 'basic' | 'premium' | 'enterprise';
export type JobStatus =
  | 'pending'
  | 'confirmed'
  | 'in-progress'
  | 'completed'
  | 'cancelled'
  | 'tbd'
  | 'awaiting-deposit'
  | 'awaiting-payment';
export type NotificationType =
  | 'reminder'
  | 'job'
  | 'system'
  | 'job_assigned'
  | 'job_accepted'
  | 'job_cancelled'
  | 'job_completed'
  | 'quotation_sent'
  | 'receipt_sent'
  | 'followup_sent';
export type Model3DStatus = 'processing' | 'completed' | 'failed';
export type BookingMode = 'automated' | 'manual';
export type UnitSystem = 'inches' | 'centimeters';
export type SubscriptionStatus = 'active' | 'cancelled' | 'expired' | 'trial' | 'past_due';
export type PaymentStatus = 'succeeded' | 'failed' | 'pending' | 'refunded';

export type DbDocBase = {
  _id: string;
};

export type DbTimestamps = {
  createdAt: Date;
  updatedAt?: Date;
};

export type UserDoc = DbDocBase &
  DbTimestamps & {
    email: string;
    name: string;
    passwordHash?: string;
    role: UserRole;
    businessId?: string;
    parentId?: string;
    permissions: string[];
    isActive: boolean;
    emailVerified: boolean;
    verificationToken?: string;
    createdBy?: string;
    lastLoginAt?: Date;
    lastLogoutAt?: Date;
  };

export type BusinessDoc = DbDocBase &
  DbTimestamps & {
    name: string;
    address: string;
    phone?: string;
    email?: string;
    adminId?: string;
    features: string[];
    subscription: BusinessSubscriptionTier;
    vrViewEnabled: boolean;
    logo?: string;
  };

export type CustomerDoc = DbDocBase &
  DbTimestamps & {
    businessId: string;
    name: string;
    email?: string;
    phone?: string;
    mobile?: string;
    address: string;
    postcode?: string;
  };

export type JobChecklistItem = Record<string, unknown>;

export type JobDoc = DbDocBase &
  DbTimestamps & {
    title: string;
    description?: string;
    status: JobStatus;
    customerId: string;
    employeeId?: string;
    businessId: string;
    scheduledDate: Date;
    completedDate?: Date;
    quotation: number;
    invoice: number;
    signature?: string;
    images: string[];
    documents: string[];
    checklist: JobChecklistItem[];
  };

export type ProductDoc = DbDocBase &
  DbTimestamps & {
    name: string;
    category: string;
    description: string;
    image: string;
    model3d: string;
    arModel: string;
    specifications: string[];
    price: number;
    isActive: boolean;
  };

export type NotificationDoc = DbDocBase & {
  userId: string;
  title: string;
  message: string;
  type: NotificationType;
  read: boolean;
  metadata?: Record<string, unknown>;
  createdAt: Date;
};

export type ModulePermissionDoc = DbDocBase & {
  userId: string;
  moduleId: string;
  canAccess: boolean;
  canGrantAccess: boolean;
  grantedBy?: string;
  grantedAt: Date;
};

export type Model3DDoc = DbDocBase & {
  name: string;
  originalImage?: string;
  modelUrl?: string;
  thumbnail?: string;
  status: Model3DStatus;
  settings: Record<string, unknown>;
  createdBy?: string;
  createdAt: Date;
};

export type ModelPermissionDoc = DbDocBase & {
  businessId: string;
  canView3dModels: boolean;
  canUseInAr: boolean;
  grantedBy?: string;
  grantedAt: Date;
};

export type ActivityLogDoc = DbDocBase & {
  userId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  description?: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
};

export type UserSessionDoc = DbDocBase & {
  userId: string;
  sessionToken: string;
  expiresAt: Date;
  createdAt: Date;
};

export type BusinessSettingsDoc = DbDocBase &
  DbTimestamps & {
    businessId: string;
    bookingMode: BookingMode;
    paymentGatewayEnabled: boolean;
    depositPercentage: number;
    quotationTemplates: Record<string, unknown>[];
    invoiceTemplates: Record<string, unknown>[];
  };

export type SubscriptionPlanDoc = DbDocBase &
  DbTimestamps & {
    name: string;
    description: string;
    price: number;
    features: string[];
    maxEmployees: number;
    maxJobs: number;
    stripePriceId?: string;
    active: boolean;
  };

export type UserSubscriptionDoc = DbDocBase &
  DbTimestamps & {
    userId: string;
    planId: string;
    status: SubscriptionStatus;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    grantedByAdmin: boolean;
    grantedBy?: string;
  };

export type PaymentHistoryDoc = DbDocBase & {
  userId: string;
  subscriptionId?: string;
  amount: number;
  currency: string;
  stripePaymentIntentId?: string;
  stripeInvoiceId?: string;
  status: PaymentStatus;
  paymentDate: Date;
  createdAt: Date;
};

export type PricingTableDoc = DbDocBase &
  DbTimestamps & {
    businessId: string;
    name: string;
    unitSystem: UnitSystem;
    widthValues: number[];
    dropValues: number[];
    priceMatrix: number[][];
    metadata: Record<string, unknown>;
    isDefault: boolean;
  };

export type MeasurementDoc = DbDocBase &
  DbTimestamps & {
    jobId: string;
    productId?: string;
    windowId: string;
    width: number;
    height: number;
    notes?: string;
    location?: string;
    controlType?: string;
    bracketType?: string;
  };

export type JobImageDoc = DbDocBase &
  DbTimestamps & {
    jobId: string;
    imageUrl: string;
    imageType: string;
    displayOrder: number;
  };

export type PushSubscriptionKeys = Record<string, unknown>;

export type PushSubscriptionDoc = DbDocBase &
  DbTimestamps & {
    userId: string;
    endpoint: string;
    keys: PushSubscriptionKeys;
  };

export type CustomPlanConfigDoc = DbDocBase &
  DbTimestamps & {
    jobPrice: number;
    productPrice: number;
    emailPrice: number;
    userPrice: number;
    storagePrice: number;
  };

export type FileDoc = DbDocBase & {
  ownerId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  jobId?: string;
  productId?: string;
  createdAt: Date;
};
