import { GENERIC_SLICER_FAILURE, runFailureParts, visibleRuns, type SliceRunStatus } from '@printforge/types';

/** The run list of a part on the product page: what a failure reads as, and which runs are still worth showing. */

const HI = 'pr-hi';
const ENDER = 'pr-ender';
let n = 0;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 12, 9, minute)).toISOString();
const run = (status: SliceRunStatus, minute: number, o: { printerId?: string | null; componentId?: string } = {}) => ({
  id: `r${++n}`, componentId: 'c1', printerId: HI as string | null, status, createdAt: at(minute), ...o,
});
const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe('visibleRuns', () => {
  it('a failed run older than a DONE run on the same printer is hidden; the newest failure stays', () => {
    const old = run('FAILED', 1);
    const done = run('DONE', 2);
    const fresh = run('FAILED', 3);
    expect(idsOf(visibleRuns([fresh, done, old]))).toEqual([fresh.id, done.id]);
  });

  it('a DONE run on another printer, or of another part, hides nothing', () => {
    const failedHi = run('FAILED', 1);
    const doneEnder = run('DONE', 2, { printerId: ENDER });
    const doneOther = run('DONE', 3, { componentId: 'c2' });
    expect(idsOf(visibleRuns([doneOther, doneEnder, failedHi]))).toEqual([doneOther.id, doneEnder.id, failedHi.id]);
  });

  it('a DONE run before the failure does not hide it; queued and running runs never hide anything', () => {
    const done = run('DONE', 1);
    const failed = run('FAILED', 2);
    const queued = run('QUEUED', 3);
    const running = run('RUNNING', 4);
    expect(idsOf(visibleRuns([running, queued, failed, done]))).toEqual([running.id, queued.id, failed.id, done.id]);
  });

  it('runs without a printer are one group', () => {
    const failed = run('FAILED', 1, { printerId: null });
    const done = run('DONE', 2, { printerId: null });
    expect(idsOf(visibleRuns([done, failed]))).toEqual([done.id]);
  });

  it('at most the 5 newest stay, counted after the hidden ones are gone, newest first whatever the input order', () => {
    const hidden = [run('FAILED', 1), run('FAILED', 2)];
    const kept = [3, 4, 5, 6, 7, 8].map((m) => run('DONE', m));
    const out = visibleRuns([...hidden, ...kept]);
    expect(idsOf(out)).toEqual(kept.slice(1).reverse().map((r) => r.id));
    expect(visibleRuns([...hidden, ...kept], 2)).toHaveLength(2);
    expect(visibleRuns([])).toEqual([]);
  });

  it('a dismissed failure is simply gone from the list, so nothing of it shows', () => {
    const done = run('DONE', 1);
    expect(visibleRuns([done]).some((r) => r.status === 'FAILED')).toBe(false);
  });
});

describe('runFailureParts', () => {
  it('a new row: the error is already a sentence, the raw output is the detail', () => {
    expect(runFailureParts({ error: 'The slicer could not arrange the units on the plate; try fewer units', errorDetail: 'orca-slicer exited with code 235\nlog' })).toEqual({
      sentence: null, detail: 'orca-slicer exited with code 235\nlog',
    });
  });

  it('a row from before: raw output in `error` reads as the generic sentence, with the raw text as the detail', () => {
    const raw = 'orca-slicer exited with code 239 — record_exit_reson:459, saved config to /scratch/job-EsX382/out/result.json | cli_callback_mgr_t::stop enter.';
    expect(runFailureParts({ error: `SLICER_FAILED: ${raw}`, errorDetail: null })).toEqual({ sentence: GENERIC_SLICER_FAILURE, detail: raw });
    expect(GENERIC_SLICER_FAILURE).toBe('The slicer stopped with an error');
    expect(runFailureParts({ error: 'SLICER_FAILED:', errorDetail: null })).toEqual({ sentence: GENERIC_SLICER_FAILURE, detail: null });
  });

  it('other codes are left to the page; no detail when there is none', () => {
    expect(runFailureParts({ error: 'SLOT_UNMAPPED: Slot 1: "PLA Black" no longer exists (merged or deleted)', errorDetail: null })).toEqual({ sentence: null, detail: null });
    expect(runFailureParts({ error: null, errorDetail: '  ' })).toEqual({ sentence: null, detail: null });
  });
});
