export type Uuid = string;
export type IsoDateString = string;

export type UserRole = 'admin' | 'business' | 'employee' | 'merchant';
export type BusinessSubscriptionTier = 'basic' | 'premium' | 'enterprise';
export type BusinessSize = 'small' | 'medium' | 'large';
export type JobStatus =
  | 'pending'
  | 'confirmed'
  | 'in-progress'
  | 'completed'
  | 'cancelled'
  | 'tbd'
  | 'awaiting-deposit'
  | 'awaiting-payment';
export type OrderUnit = 'cm' | 'inch' | 'mm';
export type OrderStatus = 'pending' | 'accepted' | 'ready' | 'delivered' | 'cancelled';
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
    passwordHash: string;
    role: UserRole;
    businessId?: string;
    parentId?: string;
    permissions: string[];
    isActive: boolean;
    emailVerified: boolean;
    verificationToken?: string;
    address?: string;
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
    vatNumber?: string;
    vatPercentage?: number;
    termsAndConditions?: string;
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
    jobType?: string;
    customerId: string;
    employeeId?: string;
    businessId: string;
    scheduledDate: Date;
    scheduledTime?: string;
    completedDate?: Date;
    quotation: number;
    invoice: number;
    currency?: string;
    notes?: string;
    deposit?: number;
    depositPaid?: boolean;
    paymentMethod?: string;
    customerReference?: string;
    quotationSent?: boolean;
    startTime?: Date;
    endTime?: Date;
    measurements?: Record<string, unknown>;
    selectedProducts?: Record<string, unknown>;
    jobHistory?: Record<string, unknown>[];
    parentJobId?: string;
    currentStep?: string;
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
    images?: string[];
    model3d: string;
    arModel: string;
    specifications: string[];
    price: number;
    isActive: boolean;
    businessId?: string;
    pricingTableId?: string;
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
    maxEmployees: number | null;
    maxSubBusinessUsers?: number | null;
    maxProducts?: number | null;
    maxEmailsPerMonth?: number | null;
    maxJobs: number | null;
    stripePriceId?: string | null;
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
    productId?: string;
  };

export type MeasurementDoc = DbDocBase &
  DbTimestamps & {
    jobId: string;
    productId?: string;
    pricingTableId?: string;
    windowId: string;
    width: number;
    height: number;
    originalWidth?: number;
    originalHeight?: number;
    originalUnit?: string;
    notes?: string;
    location?: string;
    controlType?: string;
    bracketType?: string;
    tiltControlType?: string;
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
    bannerDaysBeforeExpiry?: number | null;
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

export type OrderDoc = DbDocBase &
  DbTimestamps & {
    businessId: string;
    merchantId: string;
    createdByUserId: string;
    windowName: string;
    productId?: string;
    productName: string;
    category?: string;
    width: number;
    height: number;
    unit: OrderUnit;
    total: number;
    currency: string;
    manualPricing: boolean;
    status: OrderStatus;
    seenByBusiness: boolean;
    note?: string;
    acceptedAt?: Date;
    readyAt?: Date;
    deliveredAt?: Date;
    editedAt?: Date;
  };

export type DemoRequestDoc = DbDocBase & {
  name: string;
  companyName?: string;
  businessSize: BusinessSize;
  phone?: string;
  email: string;
  createdAt: Date;
};
