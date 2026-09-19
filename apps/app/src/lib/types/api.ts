/**
 * API response types derived from the Prisma schema and API service shapes.
 * These represent the shapes returned by the NestJS API — not the full Prisma
 * models, since the API selects/includes specific fields per endpoint.
 */

import type {
  ComponentDetail as SharedComponentDetail,
  MaterialLite as SharedMaterialLite,
  OptionCost as SharedOptionCost,
  Problem as SharedProblem,
  ProductCostPayload as CostPayloadForCalculate,
  ProductDetail as SharedProductDetail,
  ThreeMfAnalysis as SharedThreeMfAnalysis,
  VariantKind as SharedVariantKind,
} from '@printforge/types';

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

// ============ PRODUCT REWORK (shared contracts) ============
// Mirrors of the (T) types in @printforge/types — re-exported rather than
// copied so the app and the API cannot drift apart.

export type {
  VariantKind,
  SurplusPolicy,
  PriceSource,
  JobStockMode,
  StockMovementReason,
  PlateLayoutSource,
  Problem,
  OptionPair,
  MaterialLite,
  FileRef,
  ComponentPlateLayout,
  ComponentDetail,
  PriceTierRow,
  UnlinkedSlot,
  SizeOptionDetail,
  ColourOptionDetail,
  ColourSlotDetail,
  ProductDetail,
  OptionCost,
  CellCost,
  ProductCostPayload,
  CatalogProduct,
  CatalogProductDetail,
  BulkFloor,
  ReadinessPlate,
  Readiness,
  PlanRow,
  JobPlateInput,
  ResolvedLayout,
  JobPreview,
  CreateJobPairInput,
  JobReservation,
  JobStockCredit,
  JobCompletionExtras,
  ReprintJobInput,
  PlateLayoutCreateResult,
  SlicerImportResult,
  ThreeMfAnalysis,
  ThreeMfPlateInfo,
  PricingLineInput,
  PricingLinePreview,
  LinePriceWarning,
  NamedOption,
  LineOptionFields,
  LinePricingFields,
  OrderPrintFile,
  OrderStockAllocation,
  StockReleasedRow,
  ChangeLineColourInput,
  ChangeLineColourPreview,
  QuoteConversionPlanning,
  ProductionPlan,
  PlanSubmitRow,
  PlanSubmitInput,
  PlanSubmitResult,
  JobPlateDetail,
  JobSurplusRow,
} from '@printforge/types';

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
  /** Present on detail endpoint — slim order list. */
  orders?: Array<{ id: string; orderNumber: string; total: number; status: OrderStatus; createdAt: string }>;
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
  /** Swatch colour (e.g. "#d32f2f"); returned by /materials, absent on some older shapes. */
  colorHex?: string | null;
  brand: string | null;
  costPerGram: number;
  density: number;
  reorderPoint: number;
  createdAt: string;
  updatedAt: string;
  /** Active spools — slim shape on list endpoint (see ApiMaterialDetail for full shape). */
  spools?: ApiSpoolSlim[];
  /** Count of all spools on list endpoint. */
  _count?: {
    spools: number;
    jobMaterials?: number;
  };
}

/** Material as returned by the detail endpoint — includes full spool objects. */
export interface ApiMaterialDetail extends Omit<ApiMaterial, 'spools'> {
  spools?: ApiSpool[];
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
  /** Computed fields present on detail endpoint. */
  hasEnoughStock?: boolean;
  totalStock?: number;
  gramsNeeded?: number;
}

export interface ApiProductComponent {
  id: string;
  productId: string;
  materialId: string | null;
  material?: ApiMaterial | null;
  description: string;
  platedUnits?: number | null;
  platedMinutes?: number | null;
  platedGrams?: number | null;
  gramsUsed: number;
  printMinutes: number;
  quantity: number;
  sortOrder: number;
  stockOnHand: number;
  isMultiColor: boolean;
  createdAt: string;
  materials?: ApiComponentMaterial[];
  /** Computed fields present on detail endpoint. */
  hasEnoughStock?: boolean;
  totalStock?: number;
  gramsNeeded?: number;
  /** Slicer file this component was onboarded from (stored bytes + original name). */
  attachmentId?: string | null;
  gcodeFilename?: string | null;
  colorChanges?: number;
  /** 3MF plate render (staff-only, never a customer photo). */
  thumbnailAttachmentId?: string | null;
  /** Single-material colour link (product colour slot this filament follows). */
  colourSlotId?: string | null;
}

/** A customer-visible product photo (GET /products/:id/images). */
export interface ApiProductImage {
  id: string;
  url: string;
  originalName: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  /** Lowest = cover. */
  sortOrder: number;
  isCover: boolean;
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
  /** Staff-side bulk pricing tiers, ordered by minQty. */
  priceTiers?: Array<{ id?: string; minQty: number; unitPrice: number }>;
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

// ============ DESIGN PROJECTS ============

export interface ApiDesignComment {
  id: string;
  content: string;
  authorName: string;
  isCustomer: boolean;
  createdAt: string;
}

export interface ApiDesignRevision {
  id: string;
  versionNumber: number;
  description: string;
  createdAt: string;
}

export interface ApiDesignProject {
  id: string;
  projectNumber: string;
  title: string;
  status: string;
  brief: string | null;
  customerId: string;
  customer?: ApiCustomerRef | null;
  assignedToId: string | null;
  assignedTo?: { id: string; name: string } | null;
  designFeeType: string | null;
  designFeeAmount: number | null;
  designFeeHours: number | null;
  totalDesignFee: number | null;
  estimatedDelivery: string | null;
  quote?: { id: string; quoteNumber: string; total: number; status: string } | null;
  comments?: ApiDesignComment[];
  revisions?: ApiDesignRevision[];
  createdAt: string;
  updatedAt: string;
}

// ============ ACCOUNTING REPORTS ============

export interface ApiPnlReport {
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMargin: number;
  expenses: number;
  netProfit: number;
  netMargin: number;
  orderCount: number;
  jobCount: number;
  expensesByCategory?: Record<string, number>;
}

export interface ApiMonthlyTrend {
  month: string;
  revenue: number;
  cogs: number;
  grossProfit: number;
}

export interface ApiProductMargin {
  productId: string;
  productName: string;
  jobCount: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  margin: number;
}

// ============ PRODUCT PAGE (frontend-only shapes) ============

/** GET /parts row (flat array when no page is requested). */
export interface ApiPart {
  id: string;
  name: string;
  sku: string | null;
  category: string;
  description: string | null;
  unitCost: number;
  stockQty: number;
  reorderPoint: number;
  isActive: boolean;
}

/** GET /products/:id/parts row (P21). */
export interface ApiProductPartLine {
  id: string;
  productId: string;
  partId: string;
  quantity: number;
  sortOrder: number;
  part: ApiPart;
}

/** GET /products/:id/history (P7). */
export interface ApiProductHistory {
  orderLines: number;
  quoteLines: number;
  jobs: number;
  canDelete: boolean;
}

/** POST /products/:id/calculate (P17): the P16 payload plus what was applied per size. */
export interface ApiCalculateResult extends CostPayloadForCalculate {
  applied: Array<{ sizeOptionId: string | null; applied: boolean; price: number | null }>;
}

// ============ SIZES & COLOURS (WP9b, frontend-only shapes) ============

/** One open order/quote line whose printed filament a configuration change would alter (spec §3.3). */
export interface ApiOpenLineImpact {
  kind: 'ORDER' | 'QUOTE';
  lineId: string;
  number: string;
  description: string;
  quantity: number;
  changes: string[];
  partlyPlanned: boolean;
}

/** `?dryRun=1` of O5 / C4 (and C3, which adds links and assignments). */
export interface ApiImpactPreview {
  impact: ApiOpenLineImpact[];
}

/** GET /products/:id/variants/:variantId/history (O3). */
export interface ApiOptionHistory {
  orderLines: number;
  quoteLines: number;
  jobs: number;
  stockRecords: number;
  canDelete: boolean;
}

/** Body of the `Keep selling …` step (O1 `keepStandard`, O7 `keepStandard.colour|size`). */
export interface ApiKeepStandard {
  label: string;
  sellInShop: boolean;
}

/** Response of O1 / O2: the option row (plus O1 warnings). */
export interface ApiOptionRow {
  id: string;
  name: string;
  sku: string | null;
  kind: SharedVariantKind;
  isActive: boolean;
  sortOrder: number;
  warnings?: SharedProblem[];
}

/** PUT /products/:id/option-kinds (O7). */
export type ApiOptionKindsResult = SharedProductDetail & {
  rewritten: { orderLines: number; quoteLines: number; jobs: number };
};

/** PUT /products/:id/variants/:variantId/colour-slots (O5), written. */
export interface ApiAssignmentsResult {
  assignments: Array<{ colourSlotId: string; materialId: string; material: SharedMaterialLite }>;
  excludedSizeKeys: string[];
  warnings: SharedProblem[];
  impact: ApiOpenLineImpact[];
}

/** DELETE /products/:id/colour-slots/:slotId?dryRun=1 (C3 preview). */
export interface ApiSlotRemovalPreview extends ApiImpactPreview {
  links: Array<{ componentId: string; description: string; sizeOptionId: string | null; colorIndex: number }>;
  assignments: Array<{ colourOptionId: string; name: string; materialId: string; materialName: string | null }>;
}

/** GET /products/:id/colour-links/proposal (C5). */
export interface ApiColourLinkProposal {
  newSlots: Array<{ ref: string; name: string }>;
  links: Array<{ componentId: string; colorIndex: number; colourSlotId: string | null; slotRef: string | null; fixed: boolean }>;
}

/** One entry of the C4 body. Exactly one of colourSlotId / slotRef / fixed; colourSlotId null alone = unlinked. */
export interface ApiColourLinkInput {
  componentId: string;
  colorIndex: number;
  colourSlotId?: string | null;
  slotRef?: string;
  fixed?: boolean;
}

/** PUT /products/:id/colour-links (C4), written. */
export interface ApiColourLinksResult {
  slots: Array<{ id: string; name: string; sortOrder: number }>;
  warnings: SharedProblem[];
  impact: ApiOpenLineImpact[];
}

/** GET /products/:id/cost?sizeOptionId=&colourOptionId= (P16 for one pair). */
export interface ApiPairCost {
  costVersion: string;
  pair: SharedOptionCost;
}

// ============ BILL OF MATERIALS (WP9, frontend-only shapes) ============

/** P10 / P11 written: the component plus warnings (STOCK_REKEYED, OPEN_LINES_AFFECTED) and the impact. */
export type ApiComponentWriteResult = SharedComponentDetail & {
  warnings: SharedProblem[];
  impact: ApiOpenLineImpact[];
};

/** PUT /products/:id/components/:componentId/stock (P13). */
export interface ApiStockSetResult {
  stockOnHand: number;
  movementId: string | null;
}

/** POST /file-parser/parse-gcode (M6): the fields the plate-layout dialog reads. */
export interface ApiGcodeAnalysis {
  slicer: string | null;
  estimatedTimeSeconds: number | null;
  filamentUsedGrams: number | null;
  totalFilamentChanges: number | null;
  tools: Array<{ index: number; filamentGrams?: number; colorHex?: string; materialType?: string }>;
  /** null = the file has no object labels (count unknown, not zero). */
  objectCount: number | null;
  objectModels: Array<{ model: string; count: number }>;
  ignoredLabels: string[];
}

/** POST /file-parser/analyze for a .3mf. */
export interface ApiThreeMfAnalyzeResult {
  filename: string;
  fileSize: number;
  analysis: SharedThreeMfAnalysis & { type: '3mf' };
}

/**
 * GET /products/active row (P2), the fields the size and colour pickers read
 * (spec §4.1 P2). WP10's order/quote forms adapt it with
 * `pickerOptionsFromActive` (components/products/option-picker-model.ts).
 */
export interface ApiActiveProduct {
  id: string;
  name: string;
  sku: string | null;
  basePrice: number;
  baseOptionLabel: string | null;
  standardColourLabel: string | null;
  standardColourLabelBySize: Record<string, string> | null;
  baseSellable: boolean;
  baseSellableToCustomers: boolean;
  sizes: Array<{ id: string; name: string; sku: string | null; basePrice: number | null; sortOrder: number; sellableToCustomers: boolean }>;
  colours: Array<{
    id: string;
    name: string;
    sku: string | null;
    sortOrder: number;
    filamentNames: string[];
    sizeKeys: string[];
    customerSizeKeys: string[];
    notSetUp: boolean;
  }>;
}
