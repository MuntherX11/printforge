/**
 * Order cancel (S9, PATCH /orders/:id with status CANCELLED): what the cancel
 * did to the order's production jobs, next to the printed stock it returned.
 *
 * Pure: the api returns these lists, and the order page's toast and job notes
 * read them.
 */
import type { StockReleasedRow } from './index';

/** S9 jobsCancelled[]: QUEUED jobs this cancel moved to CANCELLED. */
export interface OrderCancelledJob {
  id: string;
  name: string;
  printerName: string | null;
}

/** S9 jobsStillRunning[]: started jobs this cancel left alone. */
export interface OrderRunningJob extends OrderCancelledJob {
  status: 'IN_PROGRESS' | 'PAUSED';
}

/** S9 response additions, always present. */
export interface OrderCancelResult {
  stockReleased: StockReleasedRow[];
  jobsCancelled: OrderCancelledJob[];
  jobsStillRunning: OrderRunningJob[];
}
