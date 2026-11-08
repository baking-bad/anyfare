import { describe, expect, it } from 'vitest';

import { AnyfareError, formatIssue, getSafeErrorMessage, ValidationError } from '../src/index.js';

class SampleError extends AnyfareError {
  readonly code = 'sample_failed';
}

describe('errors', () => {
  it('carry a stable code and serialize without a stack', () => {
    const error = new SampleError('bad sample');

    expect(error.code).toBe('sample_failed');
    expect(error.name).toBe('SampleError');
    expect(error.toJSON()).toEqual({ name: 'SampleError', code: 'sample_failed', message: 'bad sample' });
    expect(JSON.stringify(error)).not.toContain('at ');
  });

  it('list validation issues in the message and in JSON', () => {
    const issues = [
      { path: '/service/id', message: 'has an invalid format', line: 5, column: 7 },
      { path: '', message: 'missing required field "payments"', source: 'a.yaml', line: 1, column: 1 },
    ];
    const error = new ValidationError('Invalid service config', issues);

    expect(error.code).toBe('validation_failed');
    expect(error.message).toBe('Invalid service config\n\t1. /service/id: has an invalid format (5:7)\n\t2. /: missing required field "payments" (a.yaml:1:1)');
    expect(error.toJSON()).toMatchObject({ code: 'validation_failed', issues });
  });

  it('formats an issue without a position', () => {
    expect(formatIssue({ path: '/a', message: 'is invalid' })).toBe('/a: is invalid');
  });

  it('reads a safe message from any thrown value', () => {
    expect(getSafeErrorMessage(new SampleError('oops'))).toBe('oops');
    expect(getSafeErrorMessage('oops')).toBe('An unknown error occurred');
  });
});
