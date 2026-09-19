/**
 * Does an option name look like a colour? (spec §3.1 rule 5, WP11 report,
 * ProductDetail.sizes[].likelyColour). Used to suggest reclassifying legacy
 * options as colours; it never changes anything by itself.
 */

const WORDS = [
  'red', 'blue', 'green', 'black', 'white', 'yellow', 'orange', 'purple', 'pink',
  'grey', 'gray', 'gold', 'silver', 'brown', 'beige', 'navy', 'teal',
  'أحمر', 'أزرق', 'أخضر', 'أسود', 'أبيض', 'أصفر', 'برتقالي', 'بنفسجي', 'وردي', 'رمادي', 'ذهبي', 'فضي', 'بني',
];

/** Material type tokens stripped from a material name to leave its colour part. */
const TYPE_TOKEN = /^(pla|petg|pet|abs|asa|tpu|tpe|pc|pa\d*|paht|nylon|hips|pva|pp|cf|gf|other)([+\-].*)?$/i;

const normalise = (s: string) => s.toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();
const tokens = (s: string) => normalise(s).split(/[\s\-_/·,()]+/).filter(Boolean);

/** The colour part of a material name: "PLA Red" -> "red", "PLA+ Silk Orange" -> "silk orange". */
export function colourPartOfMaterialName(name: string): string {
  return tokens(name).filter((t) => !TYPE_TOKEN.test(t)).join(' ');
}

export function likelyColour(
  name: string,
  materials: ReadonlyArray<{ name?: string | null; color?: string | null }> = [],
): boolean {
  const n = normalise(name ?? '');
  if (!n) return false;
  const words = new Set(WORDS);
  const phrases = new Set<string>();
  for (const m of materials) {
    if (m.color) phrases.add(normalise(m.color));
    if (m.name) {
      const part = colourPartOfMaterialName(m.name);
      if (part) phrases.add(part);
    }
  }
  if (words.has(n) || phrases.has(n)) return true;
  return tokens(n).some((t) => words.has(t));
}
