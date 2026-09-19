import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.module.ts', '!src/main.ts'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  // Half the cores: with one worker per core the catalog-core timing budgets
  // (§7.1 item 43) measure scheduler contention instead of the code.
  maxWorkers: '50%',
  moduleNameMapper: {
    '^@printforge/types$': '<rootDir>/../../packages/types/src/index.ts',
  },
};

export default config;
