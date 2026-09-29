import { BadRequestException } from '@nestjs/common';
import { allowedBody, optionalNumber } from '../common/utils/validate-number';

/**
 * Allowlist parsers for the design-project chat and the customer's own design
 * writes. CreateDesignProjectDto and AddDesignCommentDto are interfaces the
 * global ValidationPipe can't whitelist, so title, brief, budget, comment
 * content, attachmentIds and request-changes feedback were stored with no
 * type, length or range check (a negative budget, a message of any size, any
 * attachment id). Any other key → 400, worded like the ValidationPipe.
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
