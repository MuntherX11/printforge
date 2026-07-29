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

  /** Field/slider/dropdown definitions for the configurator UI. Static, no I/O. */
  choices(): Record<string, unknown>;

  /**
   * Validate + normalise raw client input into a trusted spec.
   * MUST reject non-finite, zero, negative, and out-of-range values.
   * Throws BadRequestException on any invalid input.
   */
  validate(raw: unknown): Spec;

  /** Dimensions/warnings for the live preview. No disk writes. */
  info(spec: Spec): GeneratorInfo;

  /** Lightweight SVG preview string. No disk writes. */
  previewSvg(spec: Spec): string;

  /** Produce the heavy artifact files. Called only at order-commit. */
  generate(spec: Spec): Promise<GeneratedFile[]>;
}
