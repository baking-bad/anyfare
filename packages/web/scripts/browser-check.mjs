// Looks at every public page of a running site in a real browser, at five widths, in light and dark, and exits
// non-zero on any finding. By hand, never in `npm test` or CI: it drives the `agent-browser` command line, which
// is not installed there.
//
//   npm run check:browser -w @anyfare/web -- <site url> [--console <console url>] [--edge] [--session <name>]
//
// The site should run against the test suite's fake API (`node tests/support/fakeApi.ts full 4710`), because
// the pages below name the fake's hosts and calls. `--edge` adds the pages that only the fake's `edge` mode has
// (a host with a port, a very long host). For each page, width and theme it runs three scripts in the page
// (`tests/support/overflow.js`, `tapTargets.js`, `tableFit.js`) and reads the page's errors.
//
// Exit code: 0 nothing found, 1 findings, 2 wrong use or the site did not answer, 3 `agent-browser` is not installed.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const support = fileURLToPath(new URL('../tests/support/', import.meta.url));

/** Exit codes. */
export const exits = { clean: 0, findings: 1, usage: 2, noTool: 3 };

/** The widths to look at, in px. */
export const widths = [360, 390, 768, 1024, 1440];

export const themes = ['light', 'dark'];

// The pages, in one place. `path` is on the site, or on the console host when `host` is `console`. `only: 'edge'`
// pages need the fake API's edge mode.
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
  { name: 'Console', path: '/', host: 'console' },
  { name: 'Service, host with a port', path: '/services/fake-api.test%3A8186', only: 'edge' },
  { name: 'Receipt, long path', path: '/calls/pay_longpath', only: 'edge' },
];

// What each script is run for: overflow at every width, tap areas where a finger is used, tables where they must fit
const scripts = [
  { id: 'overflow', file: 'overflow.js', at: () => true },
  { id: 'taps', file: 'tapTargets.js', at: width => width <= 390 },
  { id: 'tables', file: 'tableFit.js', at: width => width >= 1024 },
];

const parseArguments = argv => {
  const options = { site: undefined, console: undefined, edge: false, session: `browser-check-${process.pid}` };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--console')
      options.console = argv[++index];
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

const main = () => {
  const options = parseArguments(process.argv.slice(2));
  if (options === undefined) {
    process.stderr.write('Usage: browser-check.mjs <site url> [--console <console url>] [--edge] [--session <name>]\n');

    return exits.usage;
  }
  if (spawnSync('agent-browser', ['--version'], { encoding: 'utf8' }).error !== undefined) {
    process.stderr.write('agent-browser is not installed, so there is nothing to drive. Install it (npm i -g agent-browser && agent-browser install) and run this again. This check is not part of npm test or CI.\n');

    return exits.noTool;
  }
  const site = options.site.replace(/\/$/, '');
  const consoleUrl = options.console?.replace(/\/$/, '');
  const list = pages.filter(page => (page.only !== 'edge' || options.edge) && (page.host !== 'console' || consoleUrl !== undefined));
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
  for (const theme of themes) {
    run(session, ['set', 'media', theme]);
    for (const width of widths) {
      run(session, ['set', 'viewport', String(width), '900']);
      for (const page of list) {
        const cell = found.get(page.name).get(width).get(theme);
        const url = `${page.host === 'console' ? consoleUrl : site}${page.path}`;
        run(session, ['errors', '--clear']);
        const opened = run(session, ['open', url]);
        if (opened.status !== 0) {
          cell.push(`could not open ${url}`);
          continue;
        }
        run(session, ['wait', '--load', 'load']);
        run(session, ['wait', '600']);
        for (const script of scripts.filter(entry => entry.at(width)))
          cell.push(...findingsOf(script.id, valueOf(run(session, ['eval', '--stdin'], sources[script.id]).stdout)).map(finding => `${script.id}: ${finding}`));
        const errors = JSON.parse(run(session, ['errors', '--json']).stdout || '{}').data?.errors ?? [];
        cell.push(...errors.map(error => `page error: ${String(error.text).split('\n')[0]}`));
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
  process.exit(main());
