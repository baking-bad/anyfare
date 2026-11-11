import { describe, expect, it } from 'vitest';

import { endpointGroups, startSteps } from '../src/agents/content';
import { endpoints, endpointUrl, groupOrder } from '../src/agents/endpoints';
import { errorDocs } from '../src/agents/errors';
import { curlExamples, curlOf, type CurlExample } from '../src/agents/examples';
import { fullGuide } from '../src/agents/full';
import { platformGuide } from '../src/agents/guide';
import { findSkill, skillDocument } from '../src/agents/skill';
import { readSettings } from '../src/config';
import { agentsMarkdown } from '../src/markdown/agents';
import { markdownPageFor } from '../src/markdown/pages';
import { curlCommands } from './support/curl';
import { printedAnswers } from './support/printed';

const settings = readSettings({ SITE_URL: 'https://site.example.net', API_URL: 'https://api.example.net', PAY_URL: 'https://pay.example.net', CONSOLE_URL: 'https://console.example.net' });
const hosts = ['https://site.example.net', 'https://api.example.net', 'https://pay.example.net', 'https://console.example.net'];

const skill = skillDocument(findSkill('anyfare-buyer')!, settings);
const files = { 'llms.txt': platformGuide(settings), 'llms-full.txt': fullGuide(settings), 'SKILL.md': skill, 'agents.md': agentsMarkdown(settings) };

describe('the files an agent reads', () => {
  it.each(Object.entries(files))('%s is built for the hosts it is given and holds no default host', (_name, text) => {
    expect(text).not.toMatch(/bakingbad\.dev/);
    expect(text).toContain(settings.apiUrl);
    expect(text).toContain(settings.payUrl);
    // Every absolute URL starts with one of the four hosts, or is the example API's own link
    const urls = [...text.matchAll(/https?:\/\/[^\s)"'`<>,]+/g)].map(match => match[0].replace(/[.:;]+$/, '')).filter(url => url !== 'https://');
    const allowed = [...hosts, 'https://pro-api.coinmarketcap.com'];
    const foreign = urls.filter(url => !allowed.some(host => url === host || url.startsWith(`${host}/`) || url.startsWith(`${host}?`)));
    expect(foreign).toEqual([]);
  });

  it.each(Object.entries(files))('%s names no unbuilt thing, no internal address and no made-up value', (_name, text) => {
    expect(text).not.toMatch(/Proposal|Designed|topup-link|topupLink|topup_link|\/t\/:id|\/internal\/|localhost|127\.0\.0\.1/i);
    expect(text).not.toMatch(new RegExp(`${['service', 'router'].join('.?')}|/${['Us', 'ers'].join('')}/`, 'i'));
    // A key in an example is a placeholder, never a value
    expect(text).not.toMatch(/af(?:m)?_(?:live|test)_[A-Za-z0-9]{6,}/);
    expect(text).not.toMatch(/\b(?:19\d\d|20[01]\d|202[0-5])-\d\d-\d\d\b|\b2026-(?:0\d|10)-\d\d\b/);
  });

  it('says a new account may get free Credits and never how many accounts or which addresses', () => {
    for (const text of Object.values(files)) {
      expect(text).not.toMatch(/per address.*free|free credits.*(?:ip|address)/i);
      expect(text).not.toMatch(/\b\d+ (?:accounts|sign-ups|signups) /i);
    }
    expect(files['llms.txt']).toContain('may get free Credits');
    expect(files['SKILL.md']).toContain('may get free Credits');
    expect(files['llms-full.txt']).toContain('may get free Credits');
  });

  it('names no rate limit number', () => {
    for (const text of Object.values(files))
      expect(text).not.toMatch(/\b\d+ (?:requests?|calls|sign-ups) (?:per|a|\/) ?(?:second|minute|hour|day|address|ip)/i);
  });

  it('links both OpenAPI files, built from the settings', () => {
    for (const name of ['llms.txt', 'llms-full.txt', 'SKILL.md'] as const) {
      expect(files[name]).toContain(`${settings.apiUrl}/openapi.json`);
      expect(files[name]).toContain(`${settings.payUrl}/openapi.json`);
    }
  });

  it('is plain: llms.txt is short, with a title, a quote line and sections', () => {
    const lines = files['llms.txt'].trimEnd().split('\n');
    expect(lines[0]).toBe('# Anyfare');
    expect(lines[2]).toMatch(/^> /);
    expect(lines.length).toBeLessThan(90);
    expect(lines.filter(line => line.startsWith('## ')).length).toBeGreaterThanOrEqual(4);
  });

  it('gives the skill the front matter a skill needs, and the names it uses', () => {
    expect(skill.startsWith('---\nname: anyfare-buyer\ndescription: ')).toBe(true);
    expect(skill.split('\n---\n')[0]).not.toContain('\n\n');
    for (const name of ['ANYFARE_MASTER_KEY', 'ANYFARE_PAYMENT_KEY', 'anyfare-account.json'])
      expect(skill).toContain(name);
    expect(skill).toMatch(/Ask the user before you sign up/);
    expect(findSkill('nothing')).toBeUndefined();
  });

  it('keeps the master key off the screen in every command', () => {
    for (const text of Object.values(files)) {
      expect(text).not.toMatch(/echo \$ANYFARE_MASTER_KEY|cat anyfare-account\.json|print.*masterKey\)/);
    }
  });
});

describe('the endpoint list', () => {
  it('appears in full in llms-full.txt, with its address', () => {
    for (const endpoint of endpoints) {
      expect(files['llms-full.txt']).toContain(`### ${endpoint.method === 'ANY' ? 'ANY' : endpoint.method === 'SSE' ? 'GET' : endpoint.method} ${endpoint.path} (${endpoint.host === 'pay' ? 'pay host' : 'API host'})`);
      expect(files['llms-full.txt']).toContain(endpointUrl(settings, endpoint));
    }
  });

  it('appears in full in the Markdown twin of the page', () => {
    for (const endpoint of endpoints)
      expect(files['agents.md']).toContain(`\`${endpointUrl(settings, endpoint)}\``);
  });

  it('has each endpoint once, in the groups the page shows, and every group has one', () => {
    const keys = endpoints.map(endpoint => `${endpoint.method} ${endpoint.host} ${endpoint.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(endpointGroups().map(group => group.group)).toEqual(groupOrder);
    expect(endpointGroups().flatMap(group => group.endpoints)).toHaveLength(endpoints.length);
    expect(endpointGroups().every(group => group.endpoints.length > 0)).toBe(true);
  });

  it('has no top-up link and no list of top-ups', () => {
    expect(endpoints.some(endpoint => /topup-links|\/t\/:id/.test(endpoint.path))).toBe(false);
    expect(endpoints.some(endpoint => endpoint.method === 'GET' && endpoint.path === '/v1/topups')).toBe(false);
  });

  it('gives every answer a status, every endpoint an error list, and every example a place', () => {
    const ids = new Set(curlExamples(settings).map(example => example.id));
    for (const endpoint of endpoints) {
      expect(endpoint.answer.status).toBeGreaterThanOrEqual(200);
      expect(endpoint.errors.every(error => /^\d{3} [a-z_]+$/.test(error))).toBe(true);
      if (endpoint.example !== undefined)
        expect(ids.has(endpoint.example)).toBe(true);
    }
  });

  it('lists only error codes the error list knows, with the status it gives', () => {
    const known = new Map(errorDocs.map(error => [error.code, error.status]));
    for (const endpoint of endpoints) {
      for (const error of endpoint.errors) {
        const [status, code] = error.split(' ') as [string, string];
        expect(known.get(code), `${endpoint.path}: ${error}`).toBe(Number(status));
      }
    }
  });

  it('has its Markdown twin registered', () => {
    expect(markdownPageFor('/agents')).toBeDefined();
  });
});

describe('the curl examples', () => {
  const examples = curlExamples(settings);
  const commands = new Map<CurlExample, string>(examples.map(example => [example, curlOf(example)]));
  const all = new Set(commands.values());

  it('are one list with an id, a status and the fields each answer holds', () => {
    expect(new Set(examples.map(example => example.id)).size).toBe(examples.length);
    for (const example of examples) {
      expect(example.expect.status).toBeGreaterThanOrEqual(200);
      expect(example.url.startsWith(settings.apiUrl) || example.url.startsWith(settings.payUrl)).toBe(true);
      // Every variable an example reads is declared
      const used = [...`${example.url} ${JSON.stringify(example.headers)}`.matchAll(/\$([A-Z_]+)/g)].map(match => match[1]!);
      expect(used.every(name => example.needs.includes(name)), example.id).toBe(true);
    }
  });

  it('are the only commands in the files: every curl is one of them', () => {
    for (const [name, text] of Object.entries(files)) {
      const found = curlCommands(text);
      expect(found.length, name).toBeGreaterThan(0);
      for (const command of found)
        expect(all.has(command), `${name}: ${command}`).toBe(true);
    }
  });

  it('are all in llms-full.txt, which holds the whole list', () => {
    const found = new Set(curlCommands(files['llms-full.txt']));
    // The sign-up that saves to a file is the skill's
    for (const example of examples.filter(candidate => candidate.id !== 'signup-to-file'))
      expect(found.has(curlOf(example)), example.id).toBe(true);
  });

  it('are all in the files together, and the skill holds its own', () => {
    const found = new Set(Object.values(files).flatMap(curlCommands));
    for (const example of examples)
      expect(found.has(curlOf(example)), example.id).toBe(true);
    expect(curlCommands(skill).some(command => command.endsWith('> anyfare-account.json'))).toBe(true);
  });

  it('write a body as it is sent, and a secret as a variable', () => {
    for (const example of examples) {
      if (example.body !== undefined)
        expect(() => JSON.parse(example.body!)).not.toThrow();
      expect(curlOf(example)).not.toMatch(/Bearer (?:af|afm)_/);
    }
    expect(curlOf(examples.find(example => example.id === 'make-key')!)).toContain('-H "Authorization: Bearer $ANYFARE_MASTER_KEY"');
    expect(curlOf(examples.find(example => example.id === 'paid-call')!)).toContain('Bearer $ANYFARE_PAYMENT_KEY');
  });
});

describe('the answers the text prints', () => {
  const printed = printedAnswers(files['llms-full.txt']);
  const examples = curlExamples(settings);
  const endpointOf = (heading: string) => endpoints.find(endpoint => heading.startsWith(`${endpoint.method === 'SSE' ? 'GET' : endpoint.method} ${endpoint.path} `));

  it('are in llms-full.txt for every JSON answer of the list, and are its JSON', () => {
    expect(printed.map(answer => endpointOf(answer.heading)?.id)).toEqual(endpoints.filter(endpoint => endpoint.answer.json !== undefined).map(endpoint => endpoint.id));
    for (const answer of printed)
      expect(JSON.parse(JSON.stringify(endpointOf(answer.heading)!.answer.json).replaceAll('<pay host>', settings.payUrl)), answer.heading).toEqual(answer.json);
  });

  it('show every field their example promises, at the top level', () => {
    for (const answer of printed) {
      const endpoint = endpointOf(answer.heading)!;
      for (const example of examples.filter(candidate => candidate.id === endpoint.example || endpoint.alsoExamples?.includes(candidate.id) === true)) {
        for (const field of example.expect.fields)
          expect(Object.keys(answer.json as object), `${example.id}: ${field}`).toContain(field);
      }
    }
  });

  it('show on the For agents page only fields their example promises', () => {
    for (const step of startSteps(settings)) {
      const example = examples.find(candidate => candidate.id === step.example)!;
      for (const match of step.answer.matchAll(/"(\w+)":/g))
        expect(example.expect.fields, `step ${step.number}: ${match[1]}`).toContain(match[1]);
    }
  });
});

