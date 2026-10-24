import { describe, expect, it } from 'vitest';
import {
  LocalCredentialSource,
  loadLocalCredentials,
  parseEnvFile,
  type LocalCredentialDeps,
} from './local-credentials.js';
import { BrokerError } from './errors.js';

describe('parseEnvFile', () => {
  it('reads KEY=value lines, strips quotes and ignores comments and junk', () => {
    expect(parseEnvFile('# c\nA=1\n  B = "two words" \r\nC=\'x\'\nnot a line\n9X=1\nD=')).toEqual({ A: '1', B: 'two words', C: 'x', D: '' });
  });
});

describe('parseEnvFile edge cases', () => {
  it('trims whitespace around keys and values and keeps inner spaces', () => {
    expect(parseEnvFile('  K\t=  a b  \n_U1=\t')).toEqual({ K: 'a b', _U1: '' });
  });

  it('rejects values that contain a lone carriage return or unicode line separator', () => {
    expect(parseEnvFile('A=x\ry\nB=x\u2028y\nC=x\u2029\nD=ok\u2028')).toEqual({ C: 'x', D: 'ok' });
  });

  it('only unwraps matching quotes and does not backtrack on long input', () => {
    expect(parseEnvFile('A="x\'\nB=\'y\'')).toEqual({ A: '"x\'', B: 'y' });
    const started = Date.now();
    parseEnvFile(`K=${' '.repeat(50_000)}x${' '.repeat(50_000)}\n${' '.repeat(50_000)}=`);
    // Backtracking on this input would take minutes; the budget only has to be far above the noise of a shared CI runner.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('loadLocalCredentials', () => {
  const deps = (over: Partial<LocalCredentialDeps> & { file?: string } = {}): LocalCredentialDeps => ({
    env: {},
    cwd: '/repo/services/broker-sync',
    fileExists: (p) => p === '/repo/.env.trading212.local',
    readFile: () => over.file,
    ...over,
  });

  it('prefers the environment variables', () => {
    expect(loadLocalCredentials(deps({ env: { T212_API_KEY: ' k ', T212_API_SECRET: 's', T212_ENV: 'DEMO' } }))).toEqual({ apiKey: 'k', apiSecret: 's', environment: 'demo' });
  });

  it('finds .env.trading212.local in a parent directory and defaults to live', () => {
    expect(loadLocalCredentials(deps({ file: 'T212_API_KEY=k\nT212_API_SECRET=s\n' }))).toEqual({ apiKey: 'k', apiSecret: 's', environment: 'live' });
  });

  it('uses the file named by T212_ENV_FILE', () => {
    const read: string[] = [];
    const result = loadLocalCredentials({
      env: { T212_ENV_FILE: '/x/custom.env' },
      cwd: '/',
      fileExists: () => false,
      readFile: (p) => {
        read.push(p);
        return 'T212_API_KEY=k\nT212_API_SECRET=s\nT212_ENV=demo';
      },
    });
    expect(read).toEqual(['/x/custom.env']);
    expect(result.environment).toBe('demo');
  });

  it('says which value is empty and where, without printing values', () => {
    expect(() => loadLocalCredentials(deps({ file: 'T212_API_KEY=\nT212_API_SECRET=abc' }))).toThrow('T212_API_KEY is empty in .env.trading212.local');
    expect(() => loadLocalCredentials(deps({ file: 'T212_API_KEY=abc\nT212_API_SECRET=  ' }))).toThrow('T212_API_SECRET is empty in .env.trading212.local');
    expect(() => loadLocalCredentials(deps({ env: { T212_API_KEY: 'k' } }))).toThrow('T212_API_SECRET is empty in the environment');
  });

  it('explains missing files and invalid environments', () => {
    expect(() => loadLocalCredentials({ env: {}, cwd: '/nowhere', fileExists: () => false, readFile: () => undefined })).toThrow(/set T212_API_KEY\/T212_API_SECRET or point T212_ENV_FILE/);
    expect(() => loadLocalCredentials({ env: { T212_ENV_FILE: '/x/y.env' }, cwd: '/', fileExists: () => false, readFile: () => undefined })).toThrow('y.env does not exist');
    expect(() => loadLocalCredentials(deps({ file: 'T212_API_KEY=k\nT212_API_SECRET=s\nT212_ENV=moon' }))).toThrow('T212_ENV must be "live" or "demo"');
    expect(() => loadLocalCredentials(deps({ env: { T212_API_KEY: 'k', T212_API_SECRET: 's', T212_ENV: 'moon' } }))).toThrow(BrokerError);
  });

  it('source returns the credentials whatever the user and rejects errors', async () => {
    const source = new LocalCredentialSource(deps({ env: { T212_API_KEY: 'k', T212_API_SECRET: 's' } }));
    await expect(source.get()).resolves.toMatchObject({ apiKey: 'k' });
    await expect(new LocalCredentialSource(deps({ file: '' })).get()).rejects.toThrow('T212_API_KEY is empty');
  });
});
