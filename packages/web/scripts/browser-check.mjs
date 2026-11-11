// Looks at every public page of a running site in a real browser, at five widths, in light and dark, and exits
// non-zero on any finding. By hand, never in `npm test` or CI: it drives the `agent-browser` command line, which
// is not installed there.
//
//   npm run check:browser -w @anyfare/web -- <site url> [--console <console url> [--api <fake api url>] [--console-only]] [--edge] [--session <name>]
//
// The site should run against the test suite's fake API (`node tests/support/fakeApi.ts full 4710 0 <console url>`),
// because the pages below name the fake's hosts and calls. `--edge` adds the pages that only the fake's `edge` mode has
// (a host with a port, a very long host). For each page, width and theme it runs three scripts in the page
// (`tests/support/overflow.js`, `tapTargets.js`, `tableFit.js`) and reads the page's errors.
//
// With `--console`, the console's pages are looked at signed out; with `--api` too, signed in as well: the script asks
// the fake for a new account and signs in by pasting its sample key, once for each width and theme. On the console's
// pages it also reads the browser's console (a refused style or script is an error there) and every failed request.
// Top up is looked at as the form, with a link's amount and with one that was not used, and in each status of a top-up:
// the fake's `/_test/topup` switch moves the newest top-up to it, and a final one is opened from its row.
//
// Exit code: 0 nothing found, 1 findings, 2 wrong use or the site did not answer, 3 `agent-browser` is not installed.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const support = fileURLToPath(new URL('../tests/support/', import.meta.url));

/** Exit codes. */
export const exits = { clean: 0, findings: 1, usage: 2, noTool: 3 };

// The statuses of a top-up that the page brings back when it opens
const openStatuses = ['quoting', 'waiting', 'incomplete', 'processing'];

/** The widths to look at, in px. */
export const widths = [360, 390, 768, 1024, 1440];

export const themes = ['light', 'dark'];

// The pages, in one place. `path` is on the site, or on the console host when `host` is `console`. `only: 'edge'`
// pages need the fake API's edge mode. `session` is how a console page is looked at: signed out or signed in, and
// `ready` is what shows once the browser filled it.
export const pages = [
  { name: 'Home', path: '/' },
  { name: 'Calls', path: '/calls' },
  { name: 'Calls, filtered', path: '/calls?paidWith=near&status=paid&page=2' },
  { name: 'Services', path: '/services' },
  { name: 'Services, searched', path: '/services?q=quote&sort=newest' },
  { name: 'Service', path: '/services/api.example.com' },
  { name: 'Service, 7 days', path: '/services/api.example.com?period=7d' },
  { name: 'For agents', path: '/agents' },
  { name: 'Check, empty', path: '/check' },
  { name: 'Check, payable', path: '/check?url=api.example.com%2Fv1%2Fsample%2Fquotes%2Flatest' },
  { name: 'Check, payable, POST', path: '/check?url=api.example.com%2Fv1%2Fsample%2Fquotes%2Flatest&method=POST&period=7d&page=2' },
  { name: 'Check, refused', path: '/check?url=refused.example.com%2Fv1%2Fx' },
  { name: 'Receipt', path: '/calls/pay_sample0000' },
  { name: 'Receipt, free Credits call', path: '/calls/pay_freecredits' },
  { name: '404', path: '/nothing-here' },
  { name: 'Receipt not found', path: '/calls/pay_nosuchcall' },
  { name: 'Service, host with a port', path: '/services/fake-api.test%3A8186', only: 'edge' },
  { name: 'Receipt, long path', path: '/calls/pay_longpath', only: 'edge' },
  { name: 'Console, sign in', path: '/', host: 'console', session: 'out', ready: '.auth-col' },
  { name: 'Console, sign in, top-up link', path: '/topup?amount=5', host: 'console', session: 'out', ready: '.auth-col' },
  { name: 'Console, Overview', path: '/', host: 'console', session: 'in', ready: '.overview-balance' },
  { name: 'Console, Keys', path: '/keys', host: 'console', session: 'in', ready: '.page-title' },
  // Top up: `topup` is the status the fake gives the newest top-up first (see `/_test/topup`); a final one is opened from its row
  { name: 'Console, Top up, form', path: '/topup', host: 'console', session: 'in', topup: 'credited', ready: '.amount-box' },
  { name: 'Console, Top up, link amount', path: '/topup?amount=5', host: 'console', session: 'in', ready: '.amount-box' },
  { name: 'Console, Top up, link amount not used', path: '/topup?amount=abc', host: 'console', session: 'in', ready: '.amount-box' },
  ...['quoting', 'waiting', 'incomplete', 'processing', 'credited', 'refunded', 'expired', 'failed', 'quote_failed', 'quote_unknown'].map(status => (
    { name: `Console, Top up, ${status.replace('_', ' ')}`, path: '/topup', host: 'console', session: 'in', topup: status, open: true, ready: '#topup-status' })),
  { name: 'Console, Top up, waiting with a memo', path: '/topup', host: 'console', session: 'in', topup: 'waiting', memo: true, open: true, ready: '#topup-status' },
  { name: 'Console, Payments', path: '/payments', host: 'console', session: 'in', ready: '.page-title' },
  { name: 'Console, Payments, filtered', path: '/payments?state=free&service=api.example.com&key=nothing&x=1', host: 'console', session: 'in', ready: '.page-title' },
  { name: 'Console, Settings', path: '/settings', host: 'console', session: 'in', ready: '.settings-kv' },
];

// What each script is run for: overflow at every width, tap areas where a finger is used, tables where they must fit
const scripts = [
  { id: 'overflow', file: 'overflow.js', at: () => true },
  { id: 'taps', file: 'tapTargets.js', at: width => width <= 390 },
  { id: 'tables', file: 'tableFit.js', at: width => width >= 1024 },
];

const parseArguments = argv => {
  const options = { site: undefined, console: undefined, api: undefined, consoleOnly: false, edge: false, session: `browser-check-${process.pid}` };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--console')
      options.console = argv[++index];
    else if (argument === '--console-only')
      options.consoleOnly = true;
    else if (argument === '--api')
      options.api = argv[++index];
    else if (argument === '--session')
      options.session = argv[++index];
    else if (argument === '--edge')
      options.edge = true;
    else if (argument !== undefined && !argument.startsWith('--') && options.site === undefined)
      options.site = argument;
    else
      return undefined;
  }

  return options.site === undefined ? undefined : options;
};

const run = (session, args, input) => spawnSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', ...input === undefined ? {} : { input } });

// A script's value comes back as a JSON string of JSON
const valueOf = output => {
  const text = output.trim().split('\n').at(-1) ?? '';
  try {
    const once = JSON.parse(text);

    return typeof once === 'string' ? JSON.parse(once) : once;
  }
  catch {
    return undefined;
  }
};

const findingsOf = (id, value) => {
  if (value === undefined)
    return [`${id}: the script gave no answer`];
  if (id === 'overflow')
    return [...value.page ? [`the page is wider than the window (${value.scrollWidth} > ${value.innerWidth})`] : [], ...value.offenders.map(offender => `${offender.el} ${offender.why}: ${offender.text}`)];
  if (id === 'taps')
    return value.map(target => `${target.tag ?? ''} ${target.text ?? ''} is ${target.area ?? target.own}: ${target.reason}`);

  return value.offenders.map(offender => `${offender.table}: ${offender.why}`);
};

// A sample master key from the fake API: a new account's
const sampleKey = async api => {
  const answer = await fetch(`${api}/v1/accounts`, { method: 'POST' }).then(response => response.json(), () => undefined);

  return typeof answer?.masterKey === 'string' && /^afm_test_[0-9a-f]{32}$/.test(answer.masterKey) ? answer.masterKey : undefined;
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if (options === undefined) {
    process.stderr.write('Usage: browser-check.mjs <site url> [--console <console url> [--api <fake api url>] [--console-only]] [--edge] [--session <name>]\n');

    return exits.usage;
  }
  if (spawnSync('agent-browser', ['--version'], { encoding: 'utf8' }).error !== undefined) {
    process.stderr.write('agent-browser is not installed, so there is nothing to drive. Install it (npm i -g agent-browser && agent-browser install) and run this again. This check is not part of npm test or CI.\n');

    return exits.noTool;
  }
  const site = options.site.replace(/\/$/, '');
  const consoleUrl = options.console?.replace(/\/$/, '');
  const key = consoleUrl === undefined || options.api === undefined ? undefined : await sampleKey(options.api.replace(/\/$/, ''));
  if (options.api !== undefined && key === undefined) {
    process.stderr.write(`The fake API gave no sample key at ${options.api}\n`);

    return exits.usage;
  }
  const list = pages.filter(page => (page.only !== 'edge' || options.edge) && (page.host !== 'console' || consoleUrl !== undefined) && (page.session !== 'in' || key !== undefined)
    && (!options.consoleOnly || page.host === 'console'));
  const sources = Object.fromEntries(scripts.map(script => [script.id, readFileSync(`${support}${script.file}`, 'utf8')]));
  const session = options.session;
  // name -> width -> theme -> findings
  const found = new Map(list.map(page => [page.name, new Map(widths.map(width => [width, new Map(themes.map(theme => [theme, []]))]))]));

  const first = run(session, ['open', `${site}/_/health`]);
  if (first.status !== 0) {
    process.stderr.write(`The site did not answer at ${site}: ${first.stderr || first.stdout}\n`);
    run(session, ['close']);

    return exits.usage;
  }
  // The console's session in this tab: signed in by pasting the sample key, signed out by forgetting it
  let signedIn = false;
  const signIn = () => {
    run(session, ['open', `${consoleUrl}/signin`]);
    run(session, ['wait', '--text', 'Sign in or create an account']);
    run(session, ['find', 'role', 'textbox', 'fill', key, '--name', 'Master key']);
    run(session, ['press', 'Enter']);
    signedIn = run(session, ['wait', '--text', 'Available']).status === 0;

    return signedIn;
  };
  // The fake's switch: the top-up `top_check` (added first, so the newest) in every account, at a status
  const setTopup = async (status, memo) => {
    if (options.api === undefined)
      return false;
    const url = `${options.api.replace(/\/$/, '')}/_test/topup?id=top_check&status=${status}${memo ? '&memo=1' : ''}`;
    // Tried twice: a connection kept open while the browser works may have been closed by the fake
    const answer = await fetch(url, { method: 'POST' }).catch(() => fetch(url, { method: 'POST' })).catch(() => undefined);

    return answer?.ok === true;
  };
  const signOut = () => {
    run(session, ['open', `${consoleUrl}/signin`]);
    run(session, ['eval', 'sessionStorage.clear(); "cleared"']);
    signedIn = false;
  };
  for (const theme of themes) {
    run(session, ['set', 'media', theme]);
    for (const width of widths) {
      run(session, ['set', 'viewport', String(width), '900']);
      for (const page of list) {
        const cell = found.get(page.name).get(width).get(theme);
        const url = `${page.host === 'console' ? consoleUrl : site}${page.path}`;
        if (page.session === 'out' && signedIn)
          signOut();
        if (page.session === 'in' && !signedIn && !signIn()) {
          cell.push('could not sign in with the sample key');
          continue;
        }
        // The top-up the page shows: the newest, moved to the page's status
        if (page.topup !== undefined && !await setTopup(page.topup, page.memo === true)) {
          cell.push('the fake API did not move the top-up');
          continue;
        }
        run(session, ['errors', '--clear']);
        if (page.host === 'console') {
          run(session, ['console', '--clear']);
          run(session, ['network', 'requests', '--clear']);
        }
        const opened = run(session, ['open', url]);
        if (opened.status !== 0) {
          cell.push(`could not open ${url}`);
          continue;
        }
        run(session, ['wait', '--load', 'load']);
        // A final top-up is not brought back on its own: its row opens it
        if (page.open === true && !openStatuses.includes(page.topup) && (run(session, ['wait', '.topup-open']).status !== 0 || run(session, ['click', '.topup-open']).status !== 0))
          cell.push('the row of the top-up did not open it');
        if (page.ready !== undefined && run(session, ['wait', page.ready]).status !== 0)
          cell.push(`${page.ready} did not show`);
        run(session, ['wait', '600']);
        for (const script of scripts.filter(entry => entry.at(width)))
          cell.push(...findingsOf(script.id, valueOf(run(session, ['eval', '--stdin'], sources[script.id]).stdout)).map(finding => `${script.id}: ${finding}`));
        const errors = JSON.parse(run(session, ['errors', '--json']).stdout || '{}').data?.errors ?? [];
        cell.push(...errors.map(error => `page error: ${String(error.text).split('\n')[0]}`));
        if (page.host === 'console') {
          // A style or a script the policy refused is an error in the browser's console
          const messages = valueOf(run(session, ['console', '--json']).stdout)?.data?.messages ?? [];
          cell.push(...messages.filter(message => message.type === 'error').map(message => `console error: ${String(message.text).split('\n')[0]}`));
          const requests = valueOf(run(session, ['network', 'requests', '--json']).stdout)?.data?.requests ?? [];
          cell.push(...requests.filter(request => request.status >= 400).map(request => `failed request: ${request.method} ${request.url.split('?')[0]} ${request.status}`));
        }
      }
    }
  }
  run(session, ['close']);

  // One table: a row for each page, a column for each width, `ok` or the number of findings in light (L) and dark (D)
  const cellText = (name, width) => {
    const themed = found.get(name).get(width);
    const [light, dark] = [themed.get('light').length, themed.get('dark').length];

    return light === 0 && dark === 0 ? 'ok' : `L${light} D${dark}`;
  };
  const rows = [['Page', ...widths.map(width => `${width} px`)], ...list.map(page => [page.name, ...widths.map(width => cellText(page.name, width))])];
  const sizes = rows[0].map((_cell, column) => Math.max(...rows.map(row => row[column].length)));
  const line = row => `| ${row.map((cell, column) => cell.padEnd(sizes[column])).join(' | ')} |`;
  process.stdout.write(`${[line(rows[0]), `|${sizes.map(size => '-'.repeat(size + 2)).join('|')}|`, ...rows.slice(1).map(line)].join('\n')}\n`);

  let total = 0;
  for (const page of list) {
    for (const width of widths) {
      for (const theme of themes) {
        const items = found.get(page.name).get(width).get(theme);
        total += items.length;
        for (const item of [...new Set(items)].slice(0, 8))
          process.stdout.write(`  ${page.name}, ${width} px, ${theme}: ${item}\n`);
      }
    }
  }
  process.stdout.write(`\n${list.length} pages, ${widths.length} widths, ${themes.length} themes: ${total === 0 ? 'nothing found' : `${total} findings`}\n`);

  return total === 0 ? exits.clean : exits.findings;
};

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exit(await main());
