import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const PROFILES_DIR = path.join(FIXTURES, 'profiles');

export function readFixture(...segments) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, ...segments), 'utf8'));
}

export const userMachine = () => readFixture('user', 'machine Creality Hi.json');
export const userProcess = () => readFixture('user', 'process 0.20mm Standard @Creality Hi - Copy.json');
export const userFilament = () => readFixture('user', 'filament eSUN PLA+ Multi.json');
