// ============ ENUMS ============

export enum Role {
  ADMIN = 'ADMIN',
  OPERATOR = 'OPERATOR',
  VIEWER = 'VIEWER',
}

export enum MaterialType {
  PLA = 'PLA',
  PETG = 'PETG',
  ABS = 'ABS',
  TPU = 'TPU',
  ASA = 'ASA',
  NYLON = 'NYLON',
  RESIN = 'RESIN',
  OTHER = 'OTHER',
}

export enum PrinterConnectionType {
  MOONRAKER = 'MOONRAKER',
  CREALITY_CLOUD = 'CREALITY_CLOUD',
  MANUAL = 'MANUAL',
}

export enum PrinterStatus {
  IDLE = 'IDLE',
  PRINTING = 'PRINTING',
  PAUSED = 'PAUSED',
  ERROR = 'ERROR',
  OFFLINE = 'OFFLINE',
  MAINTENANCE = 'MAINTENANCE',
}

export enum JobStatus {
  QUEUED = 'QUEUED',
  IN_PROGRESS = 'IN_PROGRESS',
  PAUSED = 'PAUSED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export enum QuoteStatus {
  DRAFT = 'DRAFT',
  SENT = 'SENT',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

export enum OrderStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  IN_PRODUCTION = 'IN_PRODUCTION',
  READY = 'READY',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
}

export enum InvoiceStatus {
  DRAFT = 'DRAFT',
  ISSUED = 'ISSUED',
  PAID = 'PAID',
  OVERDUE = 'OVERDUE',
  CANCELLED = 'CANCELLED',
}

export enum DesignStatus {
  REQUESTED = 'REQUESTED',
  REVIEWING = 'REVIEWING',
  QUOTED = 'QUOTED',
  IN_PROGRESS = 'IN_PROGRESS',
  REVISION_PENDING = 'REVISION_PENDING',
  CHANGES_REQUESTED = 'CHANGES_REQUESTED',
  APPROVED = 'APPROVED',
  CANCELLED = 'CANCELLED',
  ARCHIVED = 'ARCHIVED',
}

export enum NotificationType {
  LOW_STOCK = 'LOW_STOCK',
  ORDER_CREATED = 'ORDER_CREATED',
  ORDER_STATUS_CHANGED = 'ORDER_STATUS_CHANGED',
  JOB_COMPLETED = 'JOB_COMPLETED',
  JOB_FAILED = 'JOB_FAILED',
  INVOICE_OVERDUE = 'INVOICE_OVERDUE',
  DESIGN_REVISION_UPLOADED = 'DESIGN_REVISION_UPLOADED',
  DESIGN_APPROVED = 'DESIGN_APPROVED',
  DESIGN_CHANGES_REQUESTED = 'DESIGN_CHANGES_REQUESTED',
  SYSTEM = 'SYSTEM',
}

// ============ DTOs ============

export interface PaginationQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// ============ AUTH ============

export interface LoginDto {
  email: string;
  password: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
}

// ============ CUSTOMERS ============

export interface CreateCustomerDto {
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
}

export interface UpdateCustomerDto extends Partial<CreateCustomerDto> {}

// ============ INVENTORY ============

export interface CreateMaterialDto {
  name: string;
  type: MaterialType;
  color?: string;
  brand?: string;
  costPerGram: number;
  density?: number;
  reorderPoint?: number;
}

export interface UpdateMaterialDto extends Partial<CreateMaterialDto> {}

export interface CreateStorageLocationDto {
  name: string;
  description?: string;
}

export interface UpdateStorageLocationDto {
  name?: string;
  description?: string;
}

export interface CreateSpoolDto {
  materialId: string;
  initialWeight: number;
  spoolWeight?: number;
  lotNumber?: string;
  purchasePrice?: number;
  purchaseDate?: string;
  locationId?: string;
}

export interface UpdateSpoolDto {
  currentWeight?: number;
  isActive?: boolean;
  locationId?: string | null;
}

export interface BulkMaterialUploadRow {
  name: string;
  type: string;
  color?: string;
  brand?: string;
  costPerGram: number;
  density?: number;
  reorderPoint?: number;
}

export interface AdjustSpoolWeightDto {
  adjustment: number; // negative to deduct, positive to add
  reason?: string;
}

// ============ PRODUCTS ============

export interface CreateProductDto {
  name: string;
  description?: string;
  sku?: string;
  colorChanges?: number;
}

export interface UpdateProductDto {
  name?: string;
  description?: string;
  sku?: string;
  colorChanges?: number;
  isActive?: boolean;
}

export interface AddProductComponentDto {
  materialId: string;
  description: string;
  gramsUsed: number;
  printMinutes?: number;
  quantity?: number;
  sortOrder?: number;
}

export interface UpdateProductComponentDto {
  description?: string;
  materialId?: string;
  gramsUsed?: number;
  printMinutes?: number;
  quantity?: number;
  sortOrder?: number;
}

export interface ProductCostResult extends CostBreakdown {
  suggestedPrice: number;
  markupMultiplier: number;
  components: Array<{
    description: string;
    materialName: string;
    gramsUsed: number;
    printMinutes: number;
    quantity: number;
    componentCost: number;
  }>;
}

// ============ PRINTERS ============

export interface CreatePrinterDto {
  name: string;
  model?: string;
  connectionType: PrinterConnectionType;
  moonrakerUrl?: string;
  hourlyRate?: number;
  wattage?: number;
  markupMultiplier?: number;
}

export interface UpdatePrinterDto extends Partial<CreatePrinterDto> {
  isActive?: boolean;
  status?: PrinterStatus;
}

// ============ PRODUCTION ============

export interface CreateProductionJobDto {
  name: string;
  printerId?: string;
  assignedToId?: string;
  orderId?: string;
  orderItemId?: string;
  gcodeFilename?: string;
  colorChanges?: number;
}

export interface UpdateProductionJobDto {
  status?: JobStatus;
  printerId?: string;
  assignedToId?: string;
  printDuration?: number;
  filamentUsedMm?: number;
  colorChanges?: number;
  purgeWasteGrams?: number;
  materialCost?: number;
  machineCost?: number;
  wasteCost?: number;
  overheadCost?: number;
  totalCost?: number;
}

export interface AddJobMaterialDto {
  materialId: string;
  spoolId?: string;
  gramsUsed: number;
  colorIndex?: number;
}

// ============ COSTING ============

export interface CostBreakdown {
  materialCost: number;
  machineCost: number;
  electricityCost: number;
  wasteCost: number;
  overheadCost: number;
  totalCost: number;
}

export interface ColorMaterialInput {
  colorIndex: number;
  materialId: string;
  gramsUsed: number;
  colorHex?: string;  // e.g. "#FF0000" — used for purge waste calculation
  colorName?: string; // e.g. "Red"
}

export interface ColorCostDetail {
  colorIndex: number;
  materialId: string;
  materialName: string;
  colorName: string;
  gramsUsed: number;
  costPerGram: number;
  materialCost: number;
}

export interface PurgeTransition {
  fromColorIndex: number;
  toColorIndex: number;
  purgeGrams: number;
  purgeCost: number;
}

export interface MultiColorCostBreakdown extends CostBreakdown {
  colorDetails: ColorCostDetail[];
  purgeTransitions: PurgeTransition[];
  totalPurgeGrams: number;
  suggestedPrice: number;
  markupMultiplier: number;
}

export interface MultiColorEstimateInput {
  colors: ColorMaterialInput[];
  printMinutes: number;
  printerId?: string;
}

export interface QuoteEstimate extends CostBreakdown {
  suggestedPrice: number;
  markupMultiplier: number;
  confidence: 'high' | 'estimated';
  estimatedGrams?: number;
  estimatedMinutes?: number;
  estimatedColors?: number;
}

// ============ ORDERS ============

export interface CreateOrderDto {
  customerId: string;
  quoteId?: string;
  notes?: string;
  dueDate?: string;
  items: CreateOrderItemDto[];
}

export interface CreateOrderItemDto {
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface UpdateOrderDto {
  status?: OrderStatus;
  notes?: string;
  dueDate?: string;
}

// ============ QUOTES ============

export interface CreateQuoteDto {
  customerId: string;
  notes?: string;
  validUntil?: string;
  items: CreateQuoteItemDto[];
}

export interface CreateQuoteItemDto {
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  estimatedGrams?: number;
  estimatedMinutes?: number;
  estimatedColors?: number;
  estimatedCost?: number;
  marginPercent?: number;
}

export interface UpdateQuoteDto {
  status?: QuoteStatus;
  notes?: string;
  validUntil?: string;
}

// ============ INVOICES ============

export interface CreateInvoiceDto {
  orderId: string;
  dueDate?: string;
}

export interface UpdateInvoiceDto {
  status?: InvoiceStatus;
  paidAmount?: number;
  paidAt?: string;
}

// ============ EXPENSES ============

export interface CreateExpenseCategoryDto {
  name: string;
  description?: string;
}

export interface CreateExpenseDto {
  categoryId: string;
  description: string;
  amount: number;
  date: string;
  recurring?: boolean;
  notes?: string;
}

// ============ SETTINGS ============

export interface UpdateSettingDto {
  key: string;
  value: string;
}

// ============ USERS ============

export interface CreateUserDto {
  email: string;
  password: string;
  name: string;
  role?: Role;
}

export interface UpdateUserDto {
  name?: string;
  role?: Role;
  isActive?: boolean;
}

// ============ NOTIFICATIONS ============

export interface NotificationDto {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  isRead: boolean;
  createdAt: string;
}

// ============ DASHBOARD ============

export interface DashboardKPIs {
  activeJobs: number;
  pendingOrders: number;
  lowStockMaterials: number;
  monthlyRevenue: number;
  monthlyProfit: number;
  printerUtilization: number;
  recentJobs: DashboardJob[];
  recentOrders: DashboardOrder[];
}

export interface DashboardJob {
  id: string;
  name: string;
  status: JobStatus;
  printerName?: string;
  progress?: number;
}

export interface DashboardOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  status: OrderStatus;
  total: number;
}
