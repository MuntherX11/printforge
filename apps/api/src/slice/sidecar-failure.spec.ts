import { ERROR_DETAIL_MAX, orcaFailureSentence, sidecarFailure, type SidecarSliceError } from './sidecar-slice.client';

/** A failed slice reads as one plain sentence; the slicer's raw output is kept apart as the detail. */
describe('orcaFailureSentence', () => {
  // The process exit code is the 8-bit form of OrcaSlicer's negative CLI code.
  const exit = (cli: number) => 256 + cli;

  it.each([
    [-3, 'The model file could not be read'],
    [-5, 'A slicer preset could not be loaded'],
    [-14, 'The slicer ran out of memory; try fewer units'],
    [-15, 'This project is for a printer the slicer does not support'],
    [-16, 'This project is for a printer the slicer does not support'],
    [-17, 'The process preset does not match this printer; set a default process for it in Settings › Slicer'],
    [-18, 'This project has settings the slicer cannot use; re-save it in your current OrcaSlicer'],
    [-21, 'The slicer could not arrange the units on the plate; try fewer units'],
    [-50, 'Nothing fits on the plate; the model may be larger than the bed'],
    [-51, "The model does not pass the slicer's checks (it may sit outside the bed)"],
    [-52, "The model does not pass the slicer's checks (it may sit outside the bed)"],
    [-100, 'The slicer failed while slicing this model'],
    [-102, 'The slicer failed while slicing this model'],
    [-104, 'The slicer failed while slicing this model'],
  ])('CLI code %i', (cli, sentence) => {
    expect(orcaFailureSentence(exit(cli), '')).toBe(sentence);
    // The signed form reads the same.
    expect(orcaFailureSentence(cli, '')).toBe(sentence);
  });

  it('239 is -17, the code seen live', () => {
    expect(orcaFailureSentence(239, 'record_exit_reson:459, saved config to /scratch/job-EsX382/out/result.json')).toContain('process preset does not match this printer');
  });

  it('no exit code: it was stopped for taking too long', () => {
    expect(orcaFailureSentence(null, '')).toBe('The slicer took too long and was stopped; try fewer units');
  });

  it('anything else names the signed code', () => {
    expect(orcaFailureSentence(1, '')).toBe('The slicer stopped with an error (code 1)');
    expect(orcaFailureSentence(exit(-105), '')).toBe('The slicer stopped with an error (code -105)');
    expect(orcaFailureSentence(exit(-99), '')).toBe('The slicer stopped with an error (code -99)');
    expect(orcaFailureSentence(137, '')).toBe('The slicer stopped with an error (code -119)');
  });

  it('never an em dash, never the raw log', () => {
    for (let code = 0; code < 256; code++) {
      const s = orcaFailureSentence(code, 'cli_callback_mgr_t::stop enter.');
      expect(s).not.toMatch(/—|cli_callback/);
    }
  });
});

describe('sidecarFailure', () => {
  const failed = (o: Partial<SidecarSliceError>): SidecarSliceError => ({ ok: false, code: 'SLICER_FAILED', message: 'orca-slicer exited with code 239', exitCode: 239, logTail: '', ...o });

  it('an OrcaSlicer exit: the sentence as the error, the message and the whole log tail as the detail', () => {
    const logTail = 'record_exit_reson:459, saved config to /scratch/job-EsX382/out/result.json\ncli_callback_mgr_t::stop enter.';
    expect(sidecarFailure(failed({ logTail }))).toEqual({
      error: 'The process preset does not match this printer; set a default process for it in Settings › Slicer',
      detail: `orca-slicer exited with code 239\n${logTail}`,
    });
  });

  it('a timeout (504): the too-long sentence; the detail only when there is a log', () => {
    expect(sidecarFailure(failed({ code: 'TIMED_OUT', message: 'orca-slicer exceeded 300000 ms', exitCode: null }))).toEqual({
      error: 'The slicer took too long and was stopped; try fewer units', detail: null,
    });
    expect(sidecarFailure(failed({ code: 'TIMED_OUT', message: 'orca-slicer exceeded 300000 ms', exitCode: null, logTail: 'arranging' })).detail).toBe('orca-slicer exceeded 300000 ms\narranging');
  });

  it('a 500 without an exit code is not called a timeout', () => {
    expect(sidecarFailure(failed({ message: 'internal error', exitCode: null }))).toEqual({ error: 'The slicer stopped with an error', detail: 'internal error' });
  });

  it('unreachable, busy and bad input keep their code and their own sentence', () => {
    expect(sidecarFailure(failed({ code: 'SLICER_UNAVAILABLE', message: 'The slicer container is unreachable', exitCode: null }))).toEqual({
      error: 'SLICER_UNAVAILABLE: The slicer container is unreachable', detail: null,
    });
    expect(sidecarFailure(failed({ code: 'BAD_SLICE_INPUT', message: 'preset "X" inherits "Y", which is unknown', exitCode: null, logTail: 'chain' }))).toEqual({
      error: 'BAD_SLICE_INPUT: preset "X" inherits "Y", which is unknown', detail: 'preset "X" inherits "Y", which is unknown\nchain',
    });
  });

  it('a very long log keeps its end', () => {
    const logTail = `${'x'.repeat(ERROR_DETAIL_MAX * 2)}THE END`;
    const { detail } = sidecarFailure(failed({ logTail }));
    expect(detail).toHaveLength(ERROR_DETAIL_MAX);
    expect(detail!.endsWith('THE END')).toBe(true);
  });
});
