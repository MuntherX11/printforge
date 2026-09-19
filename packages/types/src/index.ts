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
  CREALITY_WS = 'CREALITY_WS',
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

export enum QuoteSource {
  MANUAL = 'MANUAL',
  QUICK_QUOTE = 'QUICK_QUOTE',
  CUSTOMER = 'CUSTOMER',
  DESIGN = 'DESIGN',
  LINK = 'LINK',
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

export enum DesignFeeType {
  FLAT = 'FLAT',
  HOURLY = 'HOURLY',
}

export enum DesignStatus {
  REQUESTED = 'REQUESTED',
  ASSIGNED = 'ASSIGNED',
  IN_PROGRESS = 'IN_PROGRESS',
  REVIEW = 'REVIEW',
  REVISION = 'REVISION',
  APPROVED = 'APPROVED',
  QUOTED = 'QUOTED',
  IN_PRODUCTION = 'IN_PRODUCTION',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

// ============ DESIGN CENTER ============

export interface CreateDesignProjectDto {
  title: string;
  brief?: string;
  budget?: number;
}

export interface UpdateDesignProjectDto {
  status?: DesignStatus;
  assignedToId?: string;
  designFeeType?: DesignFeeType;
  designFeeAmount?: number;
  designFeeHours?: number;
  estimatedDelivery?: string;
  notes?: string;
}

export interface AddDesignCommentDto {
  content: string;
  attachmentIds?: string[];
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
  MAINTENANCE_DUE = 'MAINTENANCE_DUE',
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

// ============ 3MF PARSER ============

export interface ThreeMfToolInfo {
  index: number;
  filamentGrams: number;
  colorHex?: string;
  materialType?: string;
}

export interface ThreeMfPlateInfo {
  plateIndex: number;
  name: string;
  printSeconds: number;
  weightGrams: number;
  toolChanges: number;
  tools: ThreeMfToolInfo[];
  thumbnailBase64?: string; // 'data:image/png;base64,...'
  /** Object labels of the embedded Metadata/plate_N.gcode (spec §4.3 M7); null/empty when unsliced or unlabelled. */
  objectCount?: number | null;
  objectModels?: Array<{ model: string; count: number }>;
  ignoredLabels?: string[];
}

export interface ThreeMfAnalysis {
  slicer: string | null;
  totalPlates: number;
  plates: ThreeMfPlateInfo[];
}

export interface OnboardThreeMfDto {
  selectedPlates: number[];
  plateNames?: Record<string, string>; // key = plateIndex as string
}

/** Response of M1/M2 slicer imports (spec §3.12). `product` is the refreshed ProductDetail. */
export interface SlicerImportResult<TProduct = unknown> {
  slicer?: string | null;
  results: Array<{ fileName?: string; plateIndex?: number; name: string; componentsCreated: number; componentId?: string; layoutId?: string }>;
  layoutsCreated: Array<{ componentId: string; layoutId: string; unitsPerPlate: number }>;
  skipped: Array<{ fileName?: string; plateIndex?: number; reason: string }>;
  warnings: Array<{ code: string; message: string; componentId?: string; materialId?: string; colourSlotId?: string }>;
  createdMaterials: Array<{ id: string; name: string; colorHex: string | null }>;
  defaultPrinterAssigned: { id: string; name: string } | null;
  product: TProduct;
}

// ============ PLATE COSTING ============

export interface PlateEstimateToolInput {
  filamentGrams: number;
  materialType?: string;
  colorHex?: string;
}

export interface PlateEstimateInput {
  plateIndex: number;
  name: string;
  printSeconds: number;
  weightGrams: number;
  toolChanges: number;
  tools: PlateEstimateToolInput[];
}

export interface EstimatePlatesDto {
  plates: PlateEstimateInput[];
  defaultMaterialId: string;
  printerId?: string;
}

export interface PlateCostResult {
  plateIndex: number;
  name: string;
  printSeconds: number;
  weightGrams: number;
  isMultiColor: boolean;
  breakdown: CostBreakdown & { suggestedPrice: number; markupMultiplier: number };
}

export interface EstimatePlatesResult {
  plates: PlateCostResult[];
  grandTotalCost: number;
  grandSuggestedPrice: number;
  markupMultiplier: number;
}

// ============ AUTH ============

export type UserType = 'staff' | 'customer';

export interface LoginDto {
  email: string;
  password: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  userType: UserType;
}

export interface AuthCustomer {
  id: string;
  email: string;
  name: string;
  phone?: string;
  isApproved: boolean;
  userType: 'customer';
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  type: UserType;
  jti?: string;
}

export interface CustomerSignupDto {
  name: string;
  email: string;
  phone?: string;
  password: string;
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
  /** Six hex digits, no leading hash — drives perceptual colour matching. */
  colorHex?: string | null;
  brand?: string;
  /** Cost per gram — can be supplied directly or derived from spoolPrice / spoolWeightGrams. */
  costPerGram?: number;
  /** Price paid for one full spool (user-facing input). */
  spoolPrice?: number;
  /** Net weight of filament in the spool in grams (user-facing input). Defaults to 1000. */
  spoolWeightGrams?: number;
  density?: number;
  reorderPoint?: number;
}

export interface UpdateMaterialDto extends Partial<CreateMaterialDto> {}

// ---- Non-printed parts (per-unit hardware: NFC tags, inserts, keyrings…) ----

export type PartCategory =
  | 'FASTENER'
  | 'ELECTRONICS'
  | 'HARDWARE'
  | 'SWITCH'
  | 'PACKAGING'
  | 'ADHESIVE'
  | 'OTHER';

export const PART_CATEGORIES: PartCategory[] = [
  'FASTENER', 'ELECTRONICS', 'HARDWARE', 'SWITCH', 'PACKAGING', 'ADHESIVE', 'OTHER',
];

export interface CreatePartDto {
  name: string;
  sku?: string;
  category?: PartCategory;
  description?: string;
  /** Cost per single piece. */
  unitCost?: number;
  stockQty?: number;
  reorderPoint?: number;
  supplier?: string;
  locationId?: string;
  isActive?: boolean;
}

export interface UpdatePartDto extends Partial<CreatePartDto> {}

/** Relative stock change, e.g. +50 on restock or -3 to correct a miscount. */
export interface AdjustPartStockDto {
  delta: number;
  note?: string;
}

/** Attach a part to a product's BOM (or change its per-unit quantity). */
export interface SetProductPartDto {
  partId: string;
  quantity: number;
}

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
  currentWeight?: number;
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
  /** Direct cost per gram — used when spoolPrice/spoolWeightGrams are not provided. */
  costPerGram?: number;
  /** Price of one spool. Takes precedence over costPerGram when both are present. */
  spoolPrice?: number;
  /** Net filament weight in the spool (g). Defaults to 1000 when spoolPrice is given. */
  spoolWeightGrams?: number;
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
  defaultPrinterId?: string;
}

export interface UpdateProductDto {
  name?: string;
  description?: string;
  sku?: string;
  colorChanges?: number;
  isActive?: boolean;
  defaultPrinterId?: string | null;
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
  stockOnHand?: number;
  /** Plate calibration: units on a full plate of this component, and that
   *  plate's total minutes/grams from the slicer. Drives bulk cost floors. */
  platedUnits?: number | null;
  platedMinutes?: number | null;
  platedGrams?: number | null;
}

export interface PriceTierDto {
  minQty: number;
  unitPrice: number;
}

export interface CreateProductVariantDto {
  name: string;
  sku?: string;
  basePrice?: number;
  estimatedMinutes?: number;
  estimatedGrams?: number;
  sortOrder?: number;
}

export interface UpdateProductVariantDto {
  name?: string;
  sku?: string;
  basePrice?: number | null;
  estimatedMinutes?: number | null;
  estimatedGrams?: number | null;
  isActive?: boolean;
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
  /** Total cost of non-printed parts (NFC tags, inserts, keyrings…) per unit. */
  partsCost: number;
  parts: Array<{
    partId: string;
    name: string;
    category: PartCategory;
    quantity: number;
    unitCost: number;
    lineCost: number;
  }>;
}

// ============ PRINTERS ============

export interface CreatePrinterDto {
  name: string;
  model?: string;
  connectionType: PrinterConnectionType;
  moonrakerUrl?: string;
  cameraUrl?: string;
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
  productId?: string;
  variantId?: string;
  componentId?: string;
  printerId?: string;
  assignedToId?: string;
  orderId?: string;
  orderItemId?: string;
  gcodeFilename?: string;
  colorChanges?: number;
  /**
   * How many units this job produces. Drives part consumption and component
   * stock on completion, so it must be persisted — it previously wasn't, and
   * every job silently recorded 1.
   */
  quantityToProduce?: number;
  /**
   * Defaults to CUSTOMER. Anything else is an internal print: it may skip the
   * order/product link, and is excluded from cost-of-sales reporting.
   */
  purpose?: JobPurpose;
  /** Filament consumed directly — how a test print declares what it burns. */
  materials?: Array<{ spoolId: string; gramsUsed: number }>;
}

export type JobPurpose = 'CUSTOMER' | 'TEST' | 'SAMPLE' | 'WASTE';

export const JOB_PURPOSES: Array<{ value: JobPurpose; label: string }> = [
  { value: 'TEST', label: 'Test / calibration print' },
  { value: 'SAMPLE', label: 'Sample or giveaway' },
  { value: 'WASTE', label: 'Waste / failed reprint' },
];

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

export interface PlanSubMaterial {
  componentMaterialId: string | null;
  materialId: string;
  materialName: string;
  materialColor: string | null;
  colorIndex: number;
  gramsPerUnit: number;
  totalGrams: number;
  suggestedSpool: {
    id: string;
    pfid: string | null;
    currentWeight: number;
    hasEnough: boolean;
  } | null;
}

export interface ProductionPlanItem {
  orderItemId: string;
  productId: string;
  productName: string;
  componentId: string;
  componentDescription: string;
  isMultiColor: boolean;
  needed: number;
  onHand: number;
  toProduce: number;
  gramsPerUnit: number;
  totalGrams: number;
  printMinutes: number;
  printerId: string | null;
  printerName: string | null;
  subMaterials: PlanSubMaterial[];
}

export interface ProductionPlanOverride {
  componentId: string;
  toProduce: number;
  printerId?: string;
  spoolId?: string;
}

// ============ FAILED PRINT TRACKING ============

export interface FailJobDto {
  failureReason: string;
  wasteGrams?: number;
}

export interface JobFailureStats {
  totalJobs: number;
  failedJobs: number;
  failureRate: number;
  totalWasteGrams: number;
  reprintCount: number;
}

// ============ MAINTENANCE ============

export enum MaintenanceType {
  SCHEDULED = 'SCHEDULED',
  UNSCHEDULED = 'UNSCHEDULED',
  CALIBRATION = 'CALIBRATION',
}

export interface CreateMaintenanceLogDto {
  type: MaintenanceType;
  description: string;
  scheduledDate?: string;
  cost?: number;
  notes?: string;
}

export interface CompleteMaintenanceDto {
  downtimeMinutes?: number;
  cost?: number;
  notes?: string;
}

export interface UpdatePrinterMaintenanceDto {
  maintenanceIntervalHours?: number;
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

/**
 * S2/S6 line (spec §3.9, §4.5). The server prices product lines itself: a
 * client `unitPrice` counts only for a custom line or with `priceOverride`.
 * `variantId` is the one-release legacy shape (§3.1 rule 13).
 */
export interface CreateOrderItemDto {
  productId?: string;
  sizeOptionId?: string | null;
  colourOptionId?: string | null;
  /** @deprecated legacy request shape; send sizeOptionId / colourOptionId */
  variantId?: string;
  description: string;
  quantity: number;
  unitPrice?: number;
  priceOverride?: boolean;
  overrideReason?: string | null;
}

/** S5 line: no price, no description. */
export interface CustomerCreateOrderItemDto {
  productId?: string;
  sizeOptionId?: string | null;
  colourOptionId?: string | null;
  /** @deprecated legacy request shape */
  variantId?: string;
  quantity: number;
}

export interface CustomerCreateOrderDto {
  notes?: string;
  items: CustomerCreateOrderItemDto[];
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
  sizeOptionId?: string | null;
  colourOptionId?: string | null;
  description: string;
  quantity: number;
  /** Custom lines and overrides only (as CreateOrderItemDto). */
  unitPrice?: number;
  priceOverride?: boolean;
  overrideReason?: string | null;
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

export interface SaveQuoteFromAnalysisDto {
  customerId: string;
  description: string;
  analysis: any;
  costEstimate: any;
  source?: QuoteSource;
  notes?: string;
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

// ============ SCRAPER ============

export interface ScrapedModelData {
  url: string;
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  siteName: string | null;
  isPaid?: boolean;
}

// ============ PRODUCT REWORK: SIZES & COLOURS, PRICING, READINESS ============
//
// Enums mirror the Prisma enums. They are const objects plus a string-literal
// union type, so values coming straight from Prisma ("SIZE") type-check against
// them, and code can still write VariantKind.SIZE.

export const VariantKind = { SIZE: 'SIZE', COLOUR: 'COLOUR' } as const;
export type VariantKind = (typeof VariantKind)[keyof typeof VariantKind];

export const SurplusPolicy = {
  CANCEL_ON_PRINTER: 'CANCEL_ON_PRINTER',
  KEEP_FOR_STOCK: 'KEEP_FOR_STOCK',
} as const;
export type SurplusPolicy = (typeof SurplusPolicy)[keyof typeof SurplusPolicy];

/** Where an order/quote line's unit price came from. null on a line = pre-release. */
export const PriceSource = { BASE: 'BASE', SIZE: 'SIZE', TIER: 'TIER', MANUAL: 'MANUAL' } as const;
export type PriceSource = (typeof PriceSource)[keyof typeof PriceSource];

export const JobStockMode = { BUILD_STOCK: 'BUILD_STOCK', DIRECT_SALE: 'DIRECT_SALE' } as const;
export type JobStockMode = (typeof JobStockMode)[keyof typeof JobStockMode];

export const StockMovementReason = {
  MANUAL_ADJUST: 'MANUAL_ADJUST',
  PLAN_ALLOCATE: 'PLAN_ALLOCATE',
  PLAN_RELEASE: 'PLAN_RELEASE',
  JOB_COMPLETE_STOCK: 'JOB_COMPLETE_STOCK',
  JOB_COMPLETE_SURPLUS: 'JOB_COMPLETE_SURPLUS',
  FILAMENT_REKEY: 'FILAMENT_REKEY',
} as const;
export type StockMovementReason = (typeof StockMovementReason)[keyof typeof StockMovementReason];

export const PlateLayoutSource = { GCODE: 'GCODE', MANUAL: 'MANUAL', CALIBRATION: 'CALIBRATION' } as const;
export type PlateLayoutSource = (typeof PlateLayoutSource)[keyof typeof PlateLayoutSource];

/** A blocking problem or non-blocking warning. Codes and messages are exact (spec §3.2). */
export interface Problem {
  code: string;
  message: string;
  componentId?: string;
  materialId?: string;
  colourSlotId?: string;
}

/** The sellable item of a line: (standard size | size) x (standard colour | colour). null = standard. */
export interface OptionPair {
  sizeOptionId: string | null;
  colourOptionId: string | null;
}

export interface MaterialLite {
  id: string;
  name: string;
  type: MaterialType | string;
  color: string | null;
  colorHex: string | null;
  brand: string | null;
  costPerGram: number;
}

export interface FileRef {
  attachmentId: string;
  filename: string;
  sizeBytes: number;
  /** /api/attachments/<id>/download */
  downloadUrl: string;
}

export interface ComponentPlateLayout {
  id: string;
  name: string;
  unitsPerPlate: number;
  plateMinutes: number;
  plateGrams: number;
  colorChanges: number;
  source: PlateLayoutSource;
  objectCount: number | null;
  isActive: boolean;
  sortOrder: number;
  minutesPerUnit: number;
  gramsPerUnit: number;
  file: FileRef | null;
  slots: Array<{ colorIndex: number; gramsUsed: number }>;
}

/** One printed component as the product page sees it (spec §4.1.1). */
export interface ComponentDetail {
  id: string;
  /** Owning size; null = standard size. */
  variantId: string | null;
  description: string;
  quantity: number;
  gramsUsed: number;
  printMinutes: number;
  sortOrder: number;
  isMultiColor: boolean;
  colorChanges: number;
  materialId: string | null;
  material: MaterialLite | null;
  /** Single-material colour link. */
  colourSlotId: string | null;
  /** Single-material: true = Fixed; false with colourSlotId null = unlinked. */
  colourFixed: boolean;
  materials: Array<{
    id: string;
    colorIndex: number;
    materialId: string;
    material: MaterialLite;
    gramsUsed: number;
    colourSlotId: string | null;
    colourFixed: boolean;
  }>;
  /** Base column (base colour key). */
  stockOnHand: number;
  /** stockConfirmedAt != null || stockOnHand === 0 */
  stockConfirmed: boolean;
  baseColourKey: string;
  /** Non-base keys: rows with a balance other than 0, plus keys active colours resolve to (0 when absent). */
  colourStock: Array<{ colourKey: string; label: string; stockOnHand: number; usedBy: string[] }>;
  perUnitEstimatedFrom: { layoutId: string; unitsPerPlate: number } | null;
  file: FileRef | null;
  thumbnailUrl: string | null;
  plateLayouts: ComponentPlateLayout[];
  problems: Problem[];
}

export interface PriceTierRow {
  id: string;
  minQty: number;
  unitPrice: number;
}

export interface UnlinkedSlot {
  componentId: string;
  description: string;
  colorIndex: number;
}

export interface SizeOptionDetail {
  id: string;
  name: string;
  sku: string | null;
  isActive: boolean;
  sortOrder: number;
  basePrice: number | null;
  estimatedGrams: number | null;
  estimatedMinutes: number | null;
  unlinkedSlots: UnlinkedSlot[];
  /** No components and no tiers (every legacy option at deploy). */
  notSetUp: boolean;
  /** Name looks like a colour; shown only while notSetUp. */
  likelyColour: boolean;
  components: ComponentDetail[];
  priceTiers: PriceTierRow[];
  setup: { complete: boolean; problems: Problem[] };
  kindChange: { allowed: boolean; blockers: string[] };
}

export interface ColourOptionDetail {
  id: string;
  name: string;
  sku: string | null;
  isActive: boolean;
  sortOrder: number;
  /** Stored basePrice, never used for pricing. */
  legacyPrice: number | null;
  assignments: Array<{ colourSlotId: string; materialId: string; material: MaterialLite }>;
  /** "Made in" unticked; 'standard' = standard size. */
  excludedSizeKeys: string[];
  /** Sizes where customers are offered this colour. */
  customerSizeKeys: string[];
  setup: { warnings: Problem[] };
  /** rewrites = rows a kind change would move to the colour axis. */
  kindChange: { allowed: boolean; blockers: string[]; rewrites: number };
}

export interface ColourSlotDetail {
  id: string;
  name: string;
  sortOrder: number;
  links: Array<{ componentId: string; componentDescription: string; sizeOptionId: string | null; colorIndex: number }>;
  /** Distinct own filaments of its linked slots. */
  standardMaterials: MaterialLite[];
}

/** GET /products/:id (spec §4.1.1). */
export interface ProductDetail {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  isActive: boolean;
  basePrice: number;
  estimatedGrams: number;
  estimatedMinutes: number;
  colorChanges: number;
  baseOptionLabel: string | null;
  baseOptionSellable: boolean | null;
  standardColourLabel: string | null;
  standardColourSellable: boolean | null;
  surplusPolicy: SurplusPolicy;
  defaultPrinterId: string | null;
  defaultPrinter: { id: string; name: string; hourlyRate: number; wattage: number; markupMultiplier: number } | null;
  createdAt: string;
  updatedAt: string;
  coverImageUrl: string | null;
  hasSlicerComponent: boolean;
  /** Staff rule, standard size. */
  baseSellable: boolean;
  /** Customer rule, standard size. */
  baseSellableToCustomers: boolean;
  /** Customer rule, standard colour. */
  standardColourSellableToCustomers: boolean;
  /** Standard size only. */
  components: ComponentDetail[];
  /** Standard size. */
  priceTiers: PriceTierRow[];
  colourSlots: ColourSlotDetail[];
  /** SLOT_STANDARD_MIXED present. */
  standardColourMixed: boolean;
  sizes: SizeOptionDetail[];
  colours: ColourOptionDetail[];
  /** Standard size. */
  unlinkedSlots: UnlinkedSlot[];
  warnings: Problem[];
}

/** Cost of one pair (spec §4.1.2). */
export interface OptionCost extends OptionPair {
  label: string;
  complete: boolean;
  fallbackToBase: boolean;
  problems: Problem[];
  warnings: Problem[];
  /** null when incomplete. */
  perUnit: {
    material: number;
    machine: number;
    electricity: number;
    waste: number;
    overhead: number;
    parts: number;
    total: number;
  } | null;
  materials: Array<{
    materialId: string;
    name: string;
    type: MaterialType | string;
    colorHex: string | null;
    grams: number;
    costPerGram: number;
    cost: number;
  }>;
  components: Array<{
    componentId: string;
    description: string;
    quantity: number;
    gramsPerUnit: number;
    minutesPerUnit: number;
    cost: number;
  }>;
  parts: Array<{ partId: string; name: string; quantity: number; unitCost: number; lineCost: number }>;
  purge: {
    basis: 'SLICER_INCLUDED' | 'COLOUR_CHANGES' | 'NONE';
    changesPerUnit: number;
    gramsPerChange: number;
    grams: number;
  };
  machine: {
    minutesPerUnit: number;
    hourlyRate: number;
    rateSource: 'PRINTER' | 'SETTING';
    wattage: number;
    electricityRatePerKwh: number;
  };
  overheadPercent: number;
  markup: { multiplier: number; source: 'PRINTER' | 'SETTING'; printerName: string | null };
  /** The SIZE's stored price (a colour never has one). */
  storedPrice: number | null;
  /** Size on the standard colour x markup; null for a non-standard colour pair. */
  computedPrice: number | null;
  priceUpToDate: boolean;
  marginPct: number | null;
}

/** One size x colour cell of the cost grid (spec §4.1.2). */
export interface CellCost extends OptionPair {
  sizeLabel: string;
  colourLabel: string;
  active: boolean;
  excluded: boolean;
  offeredToCustomers: boolean;
  complete: boolean;
  costPerUnit: number | null;
  price: number | null;
  marginPct: number | null;
  deltaVsStandardPct: number | null;
  problems: Problem[];
  warnings: Problem[];
}

/** GET /products/:id/cost without parameters. */
export interface ProductCostPayload {
  costVersion: string;
  sizes: OptionCost[];
  cells: CellCost[];
}

/** GET /products/customer/catalog row (spec §4.1 P3). */
export interface CatalogProduct {
  id: string;
  name: string;
  description: string | null;
  coverImageUrl: string | null;
  fromPrice: number;
  optionCount: number;
  estimatedMinutes: number;
}

/** GET /products/customer/:id (spec §4.1 P4). */
export interface CatalogProductDetail {
  id: string;
  name: string;
  description: string | null;
  images: Array<{ id: string; url: string }>;
  hasSizes: boolean;
  sizes: Array<{
    sizeOptionId: string | null;
    label: string;
    price: number;
    estimatedMinutes: number | null;
    estimatedGrams: number | null;
  }>;
  colours: Array<{
    colourOptionId: string | null;
    label: string;
    /** colorHex of each assigned filament, at most 4. */
    swatches: string[];
    /** Offered sizes on which this colour is offered to customers; null = standard size. */
    sizeOptionIds: Array<string | null>;
  }>;
}

/** GET /products/:id/bulk-floor (spec §4.1 P18, §3.9). */
export interface BulkFloor {
  size: { sizeOptionId: string | null; label: string; listPrice: number | null };
  available: boolean;
  problems: Problem[];
  thinMarginPct: number;
  unitCostAtOne: number | null;
  colours: Array<{ colourOptionId: string | null; label: string; unitCostAtOne: number | null }>;
  bands: Array<{
    minQty: number;
    maxQty: number | null;
    worstUnitCost: number;
    worstAtQty: number;
    worstColour: { colourOptionId: string | null; label: string };
    standardWorstUnitCost: number;
    unitCostAtMin: number;
    basis: Array<{ componentId: string; description: string; layoutsUsed: string[] }>;
  }>;
}

export interface ReadinessPlate {
  layoutId: string | null;
  label: string;
  unitsPerPlate: number;
  plateCount: number;
}

/** GET /products/:id/readiness and POST /jobs/preview (spec §4.1 P20, §4.4 J2). */
export interface Readiness {
  option: OptionPair & { label: string; fallbackToBase: boolean };
  qty: number;
  surplusPolicy: SurplusPolicy;
  productionReady: boolean;
  components: Array<{
    componentId: string;
    description: string;
    colourKey: string;
    colourLabel: string;
    unitsRequired: number;
    stockOnHand: number;
    plates: ReadinessPlate[];
    unitsPrinted: number;
    surplus: number;
    printMinutes: number;
    /** null on P20; filled by J2. */
    creditOnComplete: number | null;
  }>;
  filament: Array<{
    materialId: string;
    label: string;
    colorHex: string | null;
    slicedMaterialId: string | null;
    gramsNeeded: number;
    totalStock: number;
    reserved: number;
    free: number;
    /** "after open orders" */
    hasEnough: boolean;
    suggestedSpool: { id: string; pfid: string | null; location: string | null; effectiveRemaining: number } | null;
    /** "spool to use" */
    spoolHasEnough: boolean;
  }>;
  parts: Array<{
    partId: string;
    name: string;
    needed: number;
    stockQty: number;
    reserved: number;
    free: number;
    hasEnough: boolean;
  }>;
  ready: boolean;
  problems: Problem[];
  warnings: Problem[];
}

/** One row of GET /jobs/plan/:orderId (spec §4.4.1). rowKey = `${orderItemId}:${componentId}`. */
export interface PlanRow extends OptionPair {
  rowKey: string;
  orderItemId: string;
  productId: string;
  productName: string;
  /** Pair label. */
  optionLabel: string;
  fallbackToBase: boolean;
  componentId: string;
  componentDescription: string;
  isMultiColor: boolean;
  colourKey: string;
  colourLabel: string;
  needed: number;
  alreadyPlanned: number;
  allocatedFromStock: number;
  remaining: number;
  onHand: number;
  fromStock: number;
  toProduce: number;
  surplusPolicy: SurplusPolicy;
  layouts: Array<{
    layoutId: string | null;
    label: string;
    unitsPerPlate: number;
    plateMinutes: number;
    plateGrams: number;
    minutesPerUnit: number;
    gramsPerUnit: number;
    hasFile: boolean;
  }>;
  suggestedPlates: ReadinessPlate[];
  unitsPrinted: number;
  surplus: number;
  printMinutes: number;
  filament: Array<{
    materialId: string;
    label: string;
    colorHex: string | null;
    slicedMaterialId: string | null;
    grams: number;
    suggestedSpool: {
      id: string;
      pfid: string | null;
      currentWeight: number;
      effectiveRemaining: number;
      hasEnough: boolean;
    } | null;
  }>;
  printerId: string | null;
  printerName: string | null;
  warnings: Problem[];
}

// ============ PRODUCTION: J1 / J2 / J6 / J7 (spec §4.4) ============

/** One entry of a job's plate plan (J1/J2 `plates`, §3.5). layoutId null = the implicit single unit. */
export interface JobPlateInput {
  componentId: string;
  layoutId: string | null;
  plateCount: number;
}

/** A layout the planner may use for one component (J2 `layoutsByComponent`; same fields as PlanRow.layouts). */
export interface ResolvedLayout {
  layoutId: string | null;
  label: string;
  unitsPerPlate: number;
  plateMinutes: number;
  plateGrams: number;
  minutesPerUnit: number;
  gramsPerUnit: number;
  hasFile: boolean;
}

/** POST /jobs/preview (J2): the P20 shape with creditOnComplete filled, plus each component's layouts. */
export interface JobPreview extends Readiness {
  layoutsByComponent: Record<string, ResolvedLayout[]>;
}

/** POST /jobs (J1) body fields this release adds (the rest are as before). */
export interface CreateJobPairInput {
  productId: string;
  sizeOptionId: string | null;
  colourOptionId: string | null;
  quantityToProduce: number;
  purpose: JobPurpose;
  surplusPolicy?: SurplusPolicy;
  stockMode?: JobStockMode;
  printerId?: string;
  plates?: JobPlateInput[];
}

/** J1 response addition: how the job's filament lines got spools. */
export interface JobReservation {
  lines: number;
  withSpool: number;
  short: Array<{ label: string; gramsShort: number }>;
}

/** J6 response additions. */
export interface JobStockCredit {
  componentId: string;
  colourKey: string | null;
  delta: number;
  balanceAfter: number;
}

export interface JobCompletionExtras {
  stockCredits: JobStockCredit[];
  warnings: Problem[];
}

/** J7 body: plates to reprint (default all at their original counts). */
export interface ReprintJobInput {
  plates?: Array<{ jobPlateId: string; plateCount: number }>;
}

/** M3 response. */
export interface PlateLayoutCreateResult {
  layout: ComponentPlateLayout;
  warnings: Problem[];
}

// ============ ORDERS, QUOTES, PRICING PREVIEW (spec §4.5, WP10) ============

/** S1 request line. */
export interface PricingLineInput {
  productId?: string | null;
  sizeOptionId?: string | null;
  colourOptionId?: string | null;
  quantity: number;
  unitPrice?: number;
  priceOverride?: boolean;
}

/** S1 response line (`POST /pricing/lines`). Staff only: tiers, costs and margins. */
export interface PricingLinePreview {
  listUnitPrice: number | null;
  tierMinQty: number | null;
  tierUnitPrice: number | null;
  tierQuantity: number | null;
  tierLineCount: number | null;
  tierSizeLabel: string | null;
  autoUnitPrice: number | null;
  effectiveUnitPrice: number | null;
  priceSource: PriceSource | null;
  unitCostFloor: number | null;
  marginPct: number | null;
  pairLabel: string | null;
  /** Messages, in the order of warningCodes. */
  warnings: string[];
  warningCodes: string[];
  /** Per-line error (e.g. every validatePair message); the line is then unpriced. */
  error: string | null;
}

/** S2/S6 `priceWarnings`. */
export interface LinePriceWarning {
  line: number;
  codes: string[];
}

/** `{ id, name }` of a line's size or colour (S4/S8, via effectiveOptions). */
export interface NamedOption {
  id: string;
  name: string;
}

/** Fields S4/S8 add to every order/quote line. */
export interface LineOptionFields {
  size: NamedOption | null;
  colour: NamedOption | null;
  /** Pair label (§3.1 rule 11), null for custom lines. */
  optionLabel: string | null;
}

/** Stored pricing fields of an order/quote line (staff views only). */
export interface LinePricingFields {
  sizeOptionId: string | null;
  colourOptionId: string | null;
  listUnitPrice: number | null;
  priceSource: PriceSource | null;
  tierMinQty: number | null;
  priceOverrideReason: string | null;
}

/** S4 `printFiles[]`. */
export interface OrderPrintFile {
  orderItemId: string;
  productName: string;
  optionLabel: string;
  component: string;
  kind: 'COMPONENT' | 'PLATE_LAYOUT';
  unitsPerPlate: number | null;
  quantity: number;
  attachmentId: string;
  filename: string;
  sizeBytes: number;
  colorChanges: number;
  printIn: Array<{ colorIndex: number; materialLabel: string; slicedFor: string | null }>;
}

/** S4 `stockAllocations[]`. */
export interface OrderStockAllocation {
  orderItemId: string;
  componentId: string;
  componentDescription: string;
  colourLabel: string;
  units: number;
}

/** S9 / S11 `stockReleased[]`. */
export interface StockReleasedRow {
  componentDescription: string;
  colourLabel: string;
  units: number;
}

/** S11 body: split a product line into same-size colour lines. */
export interface ChangeLineColourInput {
  colours: Array<{ colourOptionId: string | null; quantity: number }>;
  confirm?: boolean;
}

/** S11 `?dryRun=1` response. */
export interface ChangeLineColourPreview {
  dryRun: true;
  lines: Array<{ colourOptionId: string | null; quantity: number; totalPrice: number; description: string }>;
  cancelledJobs: Array<{ id: string; name: string }>;
  stockReleased: StockReleasedRow[];
  warnings: Problem[];
}

/** S7 response addition. */
export interface QuoteConversionPlanning {
  jobsCreated: number;
  warnings: Problem[];
}

// ============ PRODUCTION: J4 / J5 / J3 (spec §4.4, WP10) ============

/** GET /jobs/plan/:orderId (J4). */
export interface ProductionPlan {
  order: { id: string; orderNumber: string; status: string };
  planVersion: string;
  rows: PlanRow[];
  warnings: Problem[];
}

/** One J5 row sent back (rows not sent use the suggestions). */
export interface PlanSubmitRow {
  rowKey: string;
  fromStock?: number;
  toProduce?: number;
  plates?: Array<{ layoutId: string | null; plateCount: number }>;
  surplusPolicy?: SurplusPolicy;
  printerId?: string | null;
  spools?: Array<{ materialId: string; spoolId: string }>;
}

/** POST /jobs/plan/:orderId (J5) body. */
export interface PlanSubmitInput {
  planVersion: string;
  rows?: PlanSubmitRow[];
}

/** J5 response. */
export interface PlanSubmitResult {
  jobsCreated: number;
  allocations: Array<{ rowKey: string; fromStock: number }>;
  warnings: Problem[];
}

/** J3 `plates[]`. */
export interface JobPlateDetail {
  id: string;
  componentId: string | null;
  componentDescription: string;
  label: string;
  unitsPerPlate: number;
  plateCount: number;
  unitsRequired: number;
  plateMinutes: number;
  plateGrams: number;
  gcodeFilename: string | null;
  downloadUrl: string | null;
}

/** J3 `surplusByComponent[]`. */
export interface JobSurplusRow {
  componentId: string | null;
  description: string;
  unitsRequired: number;
  unitsPrinted: number;
  surplus: number;
  creditOnComplete: number;
}

