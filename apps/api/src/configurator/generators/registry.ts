import { NotFoundException } from '@nestjs/common';
import { Generator } from './generator.interface';
import { NameplateGenerator } from './nameplate.generator';

/**
 * Registry of server-side generators. Adding a real addon generator (license
 * plate, graduation frame, Name Designer) = implement the Generator contract
 * and register it here; it inherits the whole secure pipeline for free.
 */
const GENERATORS: Record<string, Generator> = {};

function register(gen: Generator) {
  GENERATORS[gen.key] = gen;
}

register(new NameplateGenerator());

export function getGenerator(key: string): Generator {
  const gen = GENERATORS[key];
  if (!gen) throw new NotFoundException(`Unknown generator "${key}"`);
  return gen;
}

export function listGenerators() {
  return Object.values(GENERATORS).map((g) => ({
    key: g.key,
    name: g.name,
    description: g.description,
  }));
}
