import { BadRequestException } from '@nestjs/common';
import { allowedBody, optionalNumber } from '../common/utils/validate-number';

/**
 * Allowlist parsers for every design-project body: the chat, the customer's
 * own writes, and the staff project update, revision and assign routes.
 * CreateDesignProjectDto, AddDesignCommentDto and UpdateDesignProjectDto are
 * interfaces the global ValidationPipe can't whitelist, so title, brief,
 * budget, comment content, attachmentIds, request-changes feedback, fees,
 * status and notes were stored with no type, length or range check (a
 * negative budget, a message of any size, any attachment id). Any other key
 * → 400, worded like the ValidationPipe.
 */

/** Longest text kept, in characters; longer is a 400, never cut silently. */
export const DESIGN_TEXT_MAX = { title: 200, brief: 5000, message: 5000 } as const;
/** OMR, the customer's budget for the design. */
export const DESIGN_BUDGET = { min: 0, max: 1_000_000 };
/** Attachments one chat message may reference. */
export const MAX_COMMENT_ATTACHMENTS = 10;

function text(raw: unknown, label: string, max: number, required: boolean): string | null {
  if (raw === undefined || raw === null) {
    if (required) throw new BadRequestException(`${label} is required`);
    return null;
  }
  if (typeof raw !== 'string') throw new BadRequestException(`${label} must be text`);
  const s = raw.trim();
  if (!s) {
    if (required) throw new BadRequestException(`${label} is required`);
    return null;
  }
  if (s.length > max) throw new BadRequestException(`${label} must be at most ${max} characters`);
  return s;
}

export interface DesignRequestInput {
  title: string;
  brief: string | null;
  budget: number | null;
}

/** POST /design-projects/customer/create: `{ title, brief?, budget? }`. A budget of 0 means none. */
export function parseDesignRequest(raw: unknown): DesignRequestInput {
  const b = allowedBody(raw, ['title', 'brief', 'budget']);
  return {
    title: text(b.title, 'Title', DESIGN_TEXT_MAX.title, true)!,
    brief: text(b.brief, 'Brief', DESIGN_TEXT_MAX.brief, false),
    budget: optionalNumber(b.budget, 'budget', DESIGN_BUDGET) || null,
  };
}

export interface DesignCommentInput {
  content: string;
  attachmentIds: string[];
}

/**
 * POST /design-projects/:id/comments: `{ content, attachmentIds? }`.
 * DesignService.addComment also checks every attachment id belongs to the project.
 */
export function parseDesignComment(raw: unknown): DesignCommentInput {
  const b = allowedBody(raw, ['content', 'attachmentIds']);
  const content = text(b.content, 'Message', DESIGN_TEXT_MAX.message, true)!;
  let attachmentIds: string[] = [];
  if (b.attachmentIds !== undefined && b.attachmentIds !== null) {
    if (!Array.isArray(b.attachmentIds) || b.attachmentIds.length > MAX_COMMENT_ATTACHMENTS) {
      throw new BadRequestException(`attachmentIds must be a list of at most ${MAX_COMMENT_ATTACHMENTS} ids`);
    }
    attachmentIds = b.attachmentIds.map((a, i) => {
      if (typeof a !== 'string' || !a.trim() || a.trim().length > 64) throw new BadRequestException(`attachmentIds[${i}] must be an id`);
      return a.trim();
    });
    if (new Set(attachmentIds).size !== attachmentIds.length) throw new BadRequestException('attachmentIds must not repeat');
  }
  return { content, attachmentIds };
}

/** POST /design-projects/customer/:id/request-changes: `{ feedback }`, also emailed to the shop. */
export function parseDesignFeedback(raw: unknown): string {
  const b = allowedBody(raw, ['feedback']);
  return text(b.feedback, 'Feedback', DESIGN_TEXT_MAX.message, true)!;
}

/** DesignStatus and DesignFeeType in schema.prisma. */
export const DESIGN_STATUSES = [
  'REQUESTED', 'ASSIGNED', 'IN_PROGRESS', 'REVIEW', 'REVISION', 'APPROVED', 'QUOTED', 'IN_PRODUCTION', 'COMPLETED', 'CANCELLED',
] as const;
export type DesignStatusValue = (typeof DESIGN_STATUSES)[number];
export const DESIGN_FEE_TYPES = ['FLAT', 'HOURLY'] as const;
export type DesignFeeTypeValue = (typeof DESIGN_FEE_TYPES)[number];

/** OMR: a flat fee, an hourly rate, and the total either comes to. */
export const DESIGN_FEE = { min: 0, max: 1_000_000 };
/** Hours billed on an hourly fee. */
export const DESIGN_FEE_HOURS = { min: 0, max: 10_000 };
/** Staff notes on a project, and a revision's description and internal notes. */
export const DESIGN_NOTES_MAX = 5000;

function oneOf<T extends string>(raw: unknown, field: string, allowed: readonly T[]): T {
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    throw new BadRequestException(`"${field}" must be one of: ${allowed.join(', ')}`);
  }
  return raw as T;
}

/** A number (or numeric text, as a form sends it) within `bounds`; undefined when absent. */
function fee(raw: unknown, field: string, bounds: { min: number; max: number }): number | undefined {
  if (raw !== undefined && raw !== null && raw !== '' && typeof raw !== 'number' && typeof raw !== 'string') {
    throw new BadRequestException(`"${field}" must be a number`);
  }
  return optionalNumber(raw, field, bounds);
}

export interface DesignPatchInput {
  status?: DesignStatusValue;
  designFeeType?: DesignFeeTypeValue;
  designFeeAmount?: number;
  designFeeHours?: number;
  /** null clears it. */
  estimatedDelivery?: Date | null;
  /** null clears them. */
  notes?: string | null;
}

/**
 * PATCH /design-projects/:id (ADMIN/OPERATOR): `{ status?, designFeeType?,
 * designFeeAmount?, designFeeHours?, estimatedDelivery?, notes? }`.
 * UpdateDesignProjectDto is an interface the ValidationPipe skips, so these
 * reached Prisma as sent: `{ designFeeAmount: { multiply: -1 } }` ran as an
 * atomic update, a negative or 1e300 fee showed on the customer's portal, a
 * bad status or date was a 500, and notes had no length limit. assignedToId is
 * not accepted: assigning a designer is POST /:id/assign, which is ADMIN-only.
 * An absent key leaves that column alone; any other key → 400.
 */
export function parseDesignPatch(raw: unknown): DesignPatchInput {
  const b = allowedBody(raw, ['status', 'designFeeType', 'designFeeAmount', 'designFeeHours', 'estimatedDelivery', 'notes']);
  const out: DesignPatchInput = {};
  if (b.status !== undefined && b.status !== null) out.status = oneOf(b.status, 'status', DESIGN_STATUSES);
  if (b.designFeeType !== undefined && b.designFeeType !== null) {
    out.designFeeType = oneOf(b.designFeeType, 'designFeeType', DESIGN_FEE_TYPES);
  }
  const amount = fee(b.designFeeAmount, 'designFeeAmount', DESIGN_FEE);
  if (amount !== undefined) out.designFeeAmount = amount;
  const hours = fee(b.designFeeHours, 'designFeeHours', DESIGN_FEE_HOURS);
  if (hours !== undefined) out.designFeeHours = hours;
  if (amount && hours && amount * hours > DESIGN_FEE.max) {
    throw new BadRequestException(`The design fee (rate × hours) must be at most ${DESIGN_FEE.max}`);
  }
  if (b.estimatedDelivery !== undefined) {
    if (b.estimatedDelivery === null || b.estimatedDelivery === '') {
      out.estimatedDelivery = null;
    } else {
      const d = typeof b.estimatedDelivery === 'string' ? new Date(b.estimatedDelivery) : null;
      if (!d || Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000 || d.getUTCFullYear() > 2100) {
        throw new BadRequestException('estimatedDelivery must be a date');
      }
      out.estimatedDelivery = d;
    }
  }
  if (b.notes !== undefined) out.notes = text(b.notes, 'Notes', DESIGN_NOTES_MAX, false);
  return out;
}

/**
 * POST /design-projects/:id/revisions (ADMIN/OPERATOR): `{ description?,
 * internalNotes? }`, both optional text of at most DESIGN_NOTES_MAX
 * characters. The body used to be typed inline and stored unchecked.
 */
export function parseDesignRevision(raw: unknown): { description: string | null; internalNotes: string | null } {
  const b = allowedBody(raw, ['description', 'internalNotes']);
  return {
    description: text(b.description, 'Description', DESIGN_NOTES_MAX, false),
    internalNotes: text(b.internalNotes, 'Internal notes', DESIGN_NOTES_MAX, false),
  };
}

/** POST /design-projects/:id/assign (ADMIN): `{ userId }`. DesignService.assign checks the user. */
export function parseDesignAssign(raw: unknown): string {
  const b = allowedBody(raw, ['userId']);
  const id = b.userId;
  if (typeof id !== 'string' || !id.trim() || id.trim().length > 64) throw new BadRequestException('"userId" must be an id');
  return id.trim();
}
