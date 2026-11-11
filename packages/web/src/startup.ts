import { InvalidSettingError, readSettings } from './config';
import { writeLogLine, type LogOptions } from './log';

const commitPattern = /^[0-9a-f]{7,40}$/i;

/**
 * The website's startup line, once per server: the image's commit and the public URLs. Settings that
 * don't parse are logged with the variable's name, and each page then answers as it does today.
 */
export const logStartup = ({ env = process.env, write }: LogOptions = {}): void => {
  const options = { env, ...write ? { write } : {} };
  const commit = env['GIT_SHA']?.trim();
  const base = { app: 'web', commit: commit && commitPattern.test(commit) ? commit.toLowerCase() : null, logLevel: env['LOG_LEVEL']?.trim().toLowerCase() || 'info' };
  try {
    const settings = readSettings(env);
    writeLogLine('info', 'Started', {
      ...base, urls: { website: settings.siteUrl, console: settings.consoleUrl, api: settings.apiUrl, pay: settings.payUrl },
    }, options);
  }
  catch (error) {
    // InvalidSettingError names the variable and what it must be, never its value
    const type = error instanceof InvalidSettingError ? 'InvalidSettingError' : error instanceof Error ? error.name : typeof error;
    writeLogLine('error', 'The website\'s settings are invalid', { ...base, error: { type, message: error instanceof Error ? error.message : 'Invalid settings' } }, options);
  }
};
