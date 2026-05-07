/**
 * API response types derived from the Prisma schema and API service shapes.
 * These represent the shapes returned by the NestJS API — not the full Prisma
 * models, since the API selects/includes specific fields per endpoint.
 */

// ============ ENUMS ============

export type Role = 'ADMIN' | 'ACCOUNTING' | 'OPERATOR' | 'VIEWER';

export type MaterialType = 'PLA' | 'PETG' | 'ABS' | 'TPU' | 'ASA' | 'NYLON' | 'RESIN' | 'OTHER';

export type PrinterConnectionType = 'MOONRAKER' | 'CREALITY_WS' | 'CREALITY_CLOUD' | 'MANUAL';

export type PrinterStatus = 'IDLE' | 'PRINTING' | 'PAUSED' | 'ERROR' | 'OFFLINE' | 'MAINTENANCE';

export type JobStatus = 'QUEUED' | 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type OrderStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'IN_PRODUCTION'
  | 'READY'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED';

export type QuoteStatus = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';

export type QuoteSource = 'MANUAL' | 'QUICK_QUOTE' | 'CUSTOMER' | 'DESIGN' | 'LINK';

export type NotificationType =
  | 'LOW_STOCK'
  | 'ORDER_CREATED'
  | 'ORDER_STATUS_CHANGED'
  | 'JOB_COMPLETED'
  | 'JOB_FAILED'
  | 'INVOICE_OVERDUE'
  | 'DESIGN_REVISION_UPLOADED'
  | 'DESIGN_APPROVED'
  | 'DESIGN_CHANGES_REQUESTED'
  | 'MAINTENANCE_DUE'
  | 'SYSTEM';

// ============ SHARED PRIMITIVES ============

/** Slim reference used in nested includes (e.g. job.printer, job.order). */
export interface ApiRef {
  id: string;
  name: string;
}

/** Slim customer ref used in order lists. */
export interface ApiCustomerRef {
  id: string;
  name: string;
}

// ============ USERS ============

export interface ApiUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============ CUSTOMERS ============

export interface ApiCustomer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  portalAccess: boolean;
  isApproved: boolean;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present on list endpoint via _count select. */
  _count?: {
    orders: number;
  };
}

// ============ INVENTORY ============

export interface ApiLocation {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
}

export interface ApiSpool {
  id: string;
  printforgeId: string | null;
  materialId: string;
  initialWeight: number;
  currentWeight: number;
  spoolWeight: number;
  lotNumber: string | null;
  purchasePrice: number | null;
  purchaseDate: string | null;
  locationId: string | null;
  location?: ApiLocation | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Slim spool shape returned in material list (only id + currentWeight). */
export interface ApiSpoolSlim {
  id: string;
  currentWeight: number;
}

export interface ApiMaterial {
  id: string;
  name: string;
  type: MaterialType;
  color: string | null;
  brand: string | null;
  costPerGram: number;
  density: number;
  reorderPoint: number;
  createdAt: string;
  updatedAt: string;
  /** Active spools included on list endpoint (slim shape). */
  spools?: ApiSpoolSlim[];
  /** Count of all spools on list endpoint. */
  _count?: {
    spools: number;
    jobMaterials?: number;
  };
}

// ============ PRODUCTS ============

export interface ApiComponentMaterial {
  id: string;
  componentId: string;
  materialId: string;
  material?: ApiMaterial;
  gramsUsed: number;
  colorIndex: number;
  sortOrder: number;
}

export interface ApiProductComponent {
  id: string;
  productId: string;
  materialId: string | null;
  material?: ApiMaterial | null;
  description: string;
  gramsUsed: number;
  printMinutes: number;
  quantity: number;
  sortOrder: number;
  stockOnHand: number;
  isMultiColor: boolean;
  createdAt: string;
  materials?: ApiComponentMaterial[];
}

export interface ApiProductVariant {
  id: string;
  productId: string;
  name: string;
  sku: string | null;
  basePrice: number | null;
  estimatedMinutes: number | null;
  estimatedGrams: number | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiProduct {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  estimatedMinutes: number;
  estimatedGrams: number;
  colorChanges: number;
  basePrice: number;
  imageUrl: string | null;
  isActive: boolean;
  defaultPrinterId: string | null;
  createdAt: string;
  updatedAt: string;
  components?: ApiProductComponent[];
  variants?: ApiProductVariant[];
  /** Present on list endpoint via _count select. */
  _count?: {
    components: number;
  };
}

// ============ PRINTERS ============

export interface ApiPrinter {
  id: string;
  name: string;
  model: string | null;
  connectionType: PrinterConnectionType;
  moonrakerUrl: string | null;
  cameraUrl: string | null;
  hourlyRate: number;
  wattage: number;
  markupMultiplier: number;
  isActive: boolean;
  status: PrinterStatus;
  lastSeen: string | null;
  totalPrintHours: number;
  maintenanceIntervalHours: number | null;
  nextMaintenanceDue: string | null;
  lastMaintenancePrintHours: number;
  createdAt: string;
  updatedAt: string;
  /** Present on list endpoint via _count select. */
  _count?: {
    productionJobs: number;
    maintenanceLogs: number;
  };
}

// ============ PRODUCTION ============

export interface ApiJobMaterial {
  id: string;
  jobId: string;
  materialId: string;
  material?: ApiMaterial;
  spoolId: string | null;
  spool?: ApiSpool | null;
  gramsUsed: number;
  costPerGram: number;
  colorIndex: number;
  createdAt: string;
}

export interface ApiProductionJob {
  id: string;
  name: string;
  status: JobStatus;
  printerId: string | null;
  /** Slim printer ref (id + name) from list endpoint. */
  printer?: Pick<ApiPrinter, 'id' | 'name'> | null;
  assignedToId: string | null;
  /** Slim user ref from list/detail endpoints. */
  assignedTo?: Pick<ApiUser, 'id' | 'name'> | null;
  orderId: string | null;
  /** Slim order ref from list endpoint. */
  order?: { id: string; orderNumber: string } | null;
  orderItemId: string | null;
  productId: string | null;
  variantId: string | null;
  componentId: string | null;
  quantityToProduce: number;
  printDuration: number | null;
  filamentUsedMm: number | null;
  colorChanges: number;
  purgeWasteGrams: number;
  materialCost: number | null;
  machineCost: number | null;
  wasteCost: number | null;
  overheadCost: number | null;
  totalCost: number | null;
  moonrakerJobId: string | null;
  gcodeFilename: string | null;
  failureReason: string | null;
  failedAt: string | null;
  wasteGrams: number;
  reprintOfId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  materials?: ApiJobMaterial[];
}

// ============ ORDERS ============

export interface ApiOrderItem {
  id: string;
  orderId: string;
  productId: string | null;
  variantId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  materialCost: number | null;
  createdAt: string;
}

export interface ApiOrder {
  id: string;
  orderNumber: string;
  customerId: string;
  /** Slim customer ref (id + name) from list endpoint. */
  customer?: ApiCustomerRef | null;
  quoteId: string | null;
  status: OrderStatus;
  subtotal: number;
  tax: number;
  total: number;
  paidAmount: number;
  notes: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  items?: ApiOrderItem[];
  /** Present on list endpoint via _count select. */
  _count?: {
    items: number;
    productionJobs: number;
  };
}

// ============ QUOTES ============

export interface ApiQuoteItem {
  id: string;
  quoteId: string;
  productId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  estimatedGrams: number | null;
  estimatedMinutes: number | null;
  estimatedColors: number | null;
  estimatedCost: number | null;
  marginPercent: number | null;
  createdAt: string;
}

export interface ApiQuote {
  id: string;
  quoteNumber: string;
  customerId: string;
  customer?: ApiCustomerRef | null;
  status: QuoteStatus;
  source: QuoteSource;
  subtotal: number;
  tax: number;
  total: number;
  notes: string | null;
  validUntil: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  items?: ApiQuoteItem[];
}

// ============ NOTIFICATIONS ============

export interface ApiNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  isRead: boolean;
  userId: string | null;
  createdAt: string;
}

// ============ PAGINATED RESPONSES ============

export interface ApiPaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ============ DASHBOARD ============

export interface ApiDashboardKpis {
  revenue: number;
  activeJobs: number;
  pendingOrders: number;
  lowStockMaterials: number;
  revenueChange?: number;
  activeJobsChange?: number;
  pendingOrdersChange?: number;
}

// ============ PRODUCTION QUEUE ============

/** Shape returned by GET /jobs/queue */
export interface ApiPrinterQueue extends Pick<ApiPrinter, 'id' | 'name' | 'model' | 'status' | 'cameraUrl'> {
  productionJobs: Array<Pick<ApiProductionJob, 'id' | 'name' | 'status' | 'quantityToProduce' | 'createdAt'> & {
    order?: { id: string; orderNumber: string } | null;
  }>;
}

export interface ApiJobQueue {
  unassigned: Array<Pick<ApiProductionJob, 'id' | 'name' | 'quantityToProduce' | 'createdAt'> & {
    order?: { id: string; orderNumber: string } | null;
  }>;
  printers: ApiPrinterQueue[];
}

// ============ JOB FAILURE STATS ============

export interface ApiJobFailureStats {
  totalJobs: number;
  failedJobs: number;
  failureRate: number;
  totalWasteGrams: number;
}
