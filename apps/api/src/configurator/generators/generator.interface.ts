/**
 * Server-side generator contract.
 *
 * Every parametric product (nameplate, license-plate, graduation frame, Name
 * Designer…) implements this. PrintForge owns the secure pipeline around it;
 * the generator owns validation + geometry. Key invariants (spec §1/§6):
 *   - validate() is server-authoritative — the UI is never a security control.
 *   - preview methods (info/previewSvg) MUST NOT touch disk.
 *   - generate() produces the artifact bytes from validated params only.
 */

export interface GeneratedFile {
  /** Human-friendly download name, built ONLY from validated fields. Never a path. */
  filename: string;
  mime: string;
  body: Buffer;
}

/**
 * A customer-supplied file reaching a generator (spec §4 — the highest-risk
 * surface). The host has already enforced size limits and, for SVG, run the
 * sanitizer; `body` is what survived. Generators must still treat this as
 * untrusted input and parse it defensively.
 *
 * Note this never becomes the production artifact: the server re-runs its own
 * transformation and attaches *its* output (spec §1). An upload is an INPUT,
 * not a pass-through.
 */
export interface GeneratorUpload {
  /** Field name the generator declared in `uploads` (e.g. "project", "font"). */
  field: string;
  /** Original name, sanitised. Never used as a path. */
  filename: string;
  mime: string;
  body: Buffer;
}

/** Declares an upload slot a generator accepts. */
export interface UploadSlot {
  field: string;
  /** Accepted extensions, lowercase with the dot, e.g. ['.3mf'] */
  accept: string[];
  maxBytes: number;
  required?: boolean;
  /** Run the SVG sanitizer over this slot before the generator sees it. */
  sanitizeSvg?: boolean;
}

export interface GeneratorInfo {
  /** Bounding dimensions in mm, for the preview panel. */
  dimensions: { width: number; height: number; depth: number };
  /** Non-fatal advisories shown to the customer. */
  warnings: string[];
  /** Short human label for the order/artifact (e.g. "Tag 40×20"). */
  label: string;
  /** Estimated material grams (rough), for pricing/preview. */
  estimatedGrams: number;
}

export interface Generator<Spec = unknown> {
  readonly key: string;
  readonly name: string;
  readonly description: string;

  /**
   * Upload slots this generator accepts, if any. The host enforces these limits
   * before the generator runs. Omit entirely for parameter-only generators.
   */
  readonly uploads?: UploadSlot[];

  /** Field/slider/dropdown definitions for the configurator UI. Static, no I/O. */
  choices(): Record<string, unknown>;

  /**
   * Validate + normalise raw client input into a trusted spec.
   * MUST reject non-finite, zero, negative, and out-of-range values.
   * Throws BadRequestException on any invalid input.
   *
   * `uploads` carries any customer files that passed the host's size/type
   * checks and sanitizer. Validate them here too — a rejected upload is a 400,
   * never a 500.
   */
  validate(raw: unknown, uploads?: GeneratorUpload[]): Spec;

  /** Dimensions/warnings for the live preview. No disk writes. */
  info(spec: Spec): GeneratorInfo;

  /** Lightweight SVG preview string. No disk writes. */
  previewSvg(spec: Spec): string;

  /**
   * Produce the heavy artifact files. Called only at order-commit.
   * Uploads are passed through again so a generator can transform them —
   * but the returned bytes must be produced by THIS code, never echoed from
   * the upload (spec §1/§5).
   */
  generate(spec: Spec, uploads?: GeneratorUpload[]): Promise<GeneratedFile[]>;
}
