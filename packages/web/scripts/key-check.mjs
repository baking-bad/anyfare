// Checks in a real browser where the console's master key goes, and exits non-zero on any finding. It drives the
// `agent-browser` command line, so it runs by hand, or from the functional tests when that program is installed.
//
//   npm run check:key -w @anyfare/web -- <console url> <fake api url> [--session <name>]
//
// The site must run against the test suite's fake API (`node tests/support/fakeApi.ts full <port> 0 <console url>`): every
// key here is a sample key the fake issues, and the fake's record of requests (`GET /_test/requests`) says where a key
// arrived. The steps: sign up, tick the box, continue; look for the key everywhere but sessionStorage; read where the
// key travelled, in the fake's record and in the browser's own list of requests; sign out; sign in by pasting; rotate;
// rotate while the page turns into its Agent view, so the new key must still show; lose the tab's key while a rotation
// runs, so the new key must show once and be stored nowhere; rotate with an unreadable answer, and
// with none, so the console must find the old key refused and say so; sign up in a tab that blocks storage, and close the
// dialog; and open the console in a new browser, which must not know the key. The fake's `/_test/rotate` switch shapes
// the rotation's answers.
//
// Exit code: 0 nothing found, 1 findings, 2 wrong use or the site did not answer, 3 `agent-browser` is not installed.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const exits = { clean: 0, findings: 1, usage: 2, noTool: 3 };

// The one storage name of the key (src/console/session.ts)
const storageName = 'anyfare-console-master-key';
// The fake API's sample keys: no real key ever reaches this script
const sampleKey = /^afm_test_[0-9a-f]{32}$/;

const parseArguments = argv => {
  const options = { console: undefined, api: undefined, session: `key-check-${process.pid}` };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--session')
      options.session = argv[++index];
    else if (argument !== undefined && !argument.startsWith('--') && options.console === undefined)
      options.console = argument.replace(/\/$/, '');
    else if (argument !== undefined && !argument.startsWith('--') && options.api === undefined)
      options.api = argument.replace(/\/$/, '');
    else
      return undefined;
  }

  return options.console === undefined || options.api === undefined ? undefined : options;
};

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

/** Runs the check. Returns the exit code; `log` gets one line per step and finding. */
export const checkKey = async ({ console: consoleUrl, api, session }, log = line => process.stdout.write(`${line}\n`)) => {
  if (spawnSync('agent-browser', ['--version'], { encoding: 'utf8' }).error !== undefined) {
    log('agent-browser is not installed, so there is nothing to drive. Install it (npm i -g agent-browser && agent-browser install) and run this again.');

    return exits.noTool;
  }
  const consoleOrigin = new URL(consoleUrl).origin;
  const apiOrigin = new URL(api).origin;
  const findings = [];
  const fail = finding => {
    findings.push(finding);
    log(`  finding: ${finding}`);
  };
  const browser = (name = session) => (args, input) => spawnSync('agent-browser', ['--session', name, ...args], { encoding: 'utf8', timeout: 60_000, ...input === undefined ? {} : { input } });
  const run = browser();
  const must = (args, what) => {
    const result = run(args);
    if (result.status !== 0)
      throw new Error(`${what}: ${(result.stderr || result.stdout).trim().split('\n')[0]}`);

    return result.stdout;
  };
  const inPage = source => valueOf(run(['eval', '--stdin'], source).stdout);
  // A request to the fake, tried twice: a connection kept open while the browser works may have been closed by the fake
  const ask = async (url, init) => {
    try {
      return await fetch(url, init);
    }
    catch {
      return fetch(url, init);
    }
  };
  const record = async () => (await (await ask(`${api}/_test/requests`)).json()).requests;
  // This script's own question to the fake, marked so the record check passes over it
  const ownMark = 'x-key-check';
  const accountWith = async key => (await ask(`${api}/v1/account`, { headers: { authorization: `Bearer ${key}`, [ownMark]: '1' } })).status;
  const rotateAnswer = async (answer, ms = 0) => {
    await ask(`${api}/_test/rotate?answer=${answer}&ms=${ms}`, { method: 'POST' });
  };
  // Another tab of this browser chose a view: this tab hears it through the storage event
  const chooseView = view => inPage(`(() => { localStorage.setItem('anyfare-view', ${JSON.stringify(view)}); window.dispatchEvent(new StorageEvent('storage', { key: 'anyfare-view' })); return JSON.stringify(true); })()`);

  // Everywhere a page could keep the key but sessionStorage, and what sessionStorage holds
  const placesOf = key => inPage(`(() => {
    const key = ${JSON.stringify(key)};
    const stored = (() => { try { return sessionStorage.getItem(${JSON.stringify(storageName)}); } catch { return null; } })();
    const local = (() => { try { return JSON.stringify(Object.entries(localStorage)); } catch { return ''; } })();
    const names = (() => { try { return Object.keys(sessionStorage); } catch { return []; } })();
    return JSON.stringify({
      stored: stored === key, names, local: local.includes(key), cookie: document.cookie.includes(key), address: location.href.includes(key),
      history: JSON.stringify(history.state ?? null).includes(key), html: document.documentElement.outerHTML.includes(key),
      windowProperty: Object.keys(window).some(name => { try { return typeof window[name] === 'string' && window[name].includes(key); } catch { return false; } }),
    });
  })()`);
  const onlyInSession = (key, when) => {
    const places = placesOf(key);
    if (places === undefined) {
      fail(`${when}: the page's storage could not be read`);

      return;
    }
    if (!places.stored)
      fail(`${when}: the key is not in sessionStorage under ${storageName}`);
    if (places.names.length !== 1 || places.names[0] !== storageName)
      fail(`${when}: sessionStorage holds ${places.names.length} names, not just ${storageName}`);
    for (const place of ['local', 'cookie', 'address', 'history', 'html', 'windowProperty']) {
      if (places[place])
        fail(`${when}: the key is in ${place === 'local' ? 'localStorage' : place === 'html' ? 'the page\'s HTML' : place === 'windowProperty' ? 'a window property' : `the ${place}`}`);
    }
  };
  const nowhere = (keys, when) => {
    for (const key of keys) {
      const places = placesOf(key);
      if (places === undefined || places.stored || places.local || places.cookie || places.address || places.history || places.html)
        fail(`${when}: a key is still in the page`);
    }
  };
  // The key arrives at the API only as `Authorization: Bearer <key>`, from the console's origin
  const travelled = async (keys, when) => {
    for (const request of (await record()).filter(entry => entry.headers[ownMark] === undefined)) {
      for (const key of keys) {
        const { authorization, ...others } = request.headers;
        if (request.path.includes(key) || JSON.stringify(others).includes(key))
          fail(`${when}: the fake got ${request.method} ${request.path.split('?')[0]} with a key outside the Authorization header`);
        if (authorization !== undefined && authorization.includes(key)) {
          if (authorization !== `Bearer ${key}`)
            fail(`${when}: an Authorization header holds a key in another form`);
          if (request.headers.origin !== consoleOrigin)
            fail(`${when}: a keyed request came from ${request.headers.origin ?? 'no origin'}, not the console`);
        }
      }
    }
    const listed = valueOf(run(['network', 'requests', '--json']).stdout)?.data?.requests ?? [];
    if (listed.length === 0)
      fail(`${when}: the browser listed no request`);
    for (const request of listed) {
      let origin;
      try {
        origin = new URL(request.url).origin;
      }
      catch {
        continue;
      }
      for (const key of keys) {
        const headers = JSON.stringify(request.headers ?? {});
        if (!request.url.includes(key) && !headers.includes(key))
          continue;
        if (origin !== apiOrigin)
          fail(`${when}: the browser sent a key to ${origin}${origin === consoleOrigin ? ', the site\'s own server' : ''}`);
        else if (request.url.includes(key))
          fail(`${when}: the browser put a key in a URL`);
      }
    }
  };
  const keyInDialog = () => {
    const key = run(['get', 'text', '.key-once-value']).stdout.trim().split('\n').at(-1) ?? '';
    if (!sampleKey.test(key))
      throw new Error('The dialog shows no sample key of the fake API: is the site running against it?');

    return key;
  };

  log(`Checking ${consoleOrigin} against the fake API at ${apiOrigin}`);
  const reachable = await fetch(`${api}/_test/requests`).then(response => response.ok, () => false);
  if (!reachable) {
    log(`The fake API did not answer at ${api}`);

    return exits.usage;
  }
  try {
    must(['set', 'viewport', '1440', '900'], 'Setting the window');
    if (run(['open', `${consoleUrl}/`]).status !== 0) {
      log(`The console did not answer at ${consoleUrl}`);

      return exits.usage;
    }
    must(['eval', 'sessionStorage.clear(); "cleared"'], 'Clearing the tab');
    must(['network', 'requests', '--clear'], 'Clearing the request list');

    log('1. Sign up, tick the box, continue');
    must(['open', `${consoleUrl}/`], 'Opening the console');
    must(['wait', '--text', 'Sign in or create an account'], 'Waiting for the sign-in view');
    must(['find', 'role', 'button', 'click', '--name', 'Create an account'], 'Pressing Create an account');
    must(['wait', '--text', 'Your account is ready'], 'Waiting for the new key');
    const first = keyInDialog();
    if (placesOf(first)?.stored)
      fail('the key was stored before Continue');
    must(['find', 'role', 'checkbox', 'check', '--name', 'I saved it somewhere safe'], 'Ticking the box');
    must(['find', 'role', 'button', 'click', '--name', 'Continue'], 'Pressing Continue');
    must(['wait', '--text', 'Available'], 'Waiting for the Overview');
    must(['wait', '--load', 'networkidle'], 'Waiting for the reads');
    onlyInSession(first, 'after sign-up');
    if (inPage(`JSON.stringify(document.documentElement.outerHTML.includes('…${first.slice(-4)}'))`) !== true)
      fail('after sign-up: the masked key is not shown');
    await travelled([first], 'after sign-up');

    log('2. Sign out');
    must(['click', '.acct'], 'Opening the account menu');
    must(['find', 'role', 'menuitem', 'click', '--name', 'Sign out'], 'Signing out');
    must(['wait', '--text', 'Sign in or create an account'], 'Waiting for the sign-in view');
    if (inPage('JSON.stringify(sessionStorage.length)') !== 0)
      fail('after sign-out: sessionStorage is not empty');
    nowhere([first], 'after sign-out');

    log('3. Sign in by pasting the key');
    must(['find', 'role', 'textbox', 'fill', first, '--name', 'Master key'], 'Pasting the key');
    must(['press', 'Enter'], 'Signing in');
    must(['wait', '--text', 'Available'], 'Waiting for the Overview');
    onlyInSession(first, 'after sign-in');

    log('4. Rotate the master key');
    must(['find', 'role', 'link', 'click', '--name', 'Settings'], 'Opening Settings');
    must(['wait', '--text', 'Account id'], 'Waiting for Settings');
    must(['click', '.key-row .btn'], 'Pressing Rotate');
    must(['wait', '--text', 'Rotate the master key?'], 'Waiting for the question');
    must(['click', '.dialog .btn.danger'], 'Confirming');
    must(['wait', '--text', 'Your new master key'], 'Waiting for the new key');
    const second = keyInDialog();
    if (second === first)
      fail('after rotation: the dialog shows the old key');
    // Stored before it is shown
    if (!placesOf(second)?.stored)
      fail('after rotation: the new key is not in the session while its dialog is open');
    if (await accountWith(first) !== 401)
      fail('after rotation: the fake still takes the old key');
    if (await accountWith(second) !== 200)
      fail('after rotation: the fake doesn\'t take the new key');
    must(['find', 'role', 'checkbox', 'check', '--name', 'I saved it somewhere safe'], 'Ticking the box');
    must(['find', 'role', 'button', 'click', '--name', 'Continue'], 'Pressing Continue');
    must(['wait', '--text', 'New master key made'], 'Waiting for the toast');
    onlyInSession(second, 'after rotation');
    nowhere([first], 'after rotation, the old key');
    if (inPage('JSON.stringify(document.querySelectorAll(\'.dialog, .key-once-value\').length)') !== 0)
      fail('after rotation: the dialog is still open');
    await travelled([first, second], 'after rotation');

    log('5. Rotate while the page turns into its Agent view: the new key still shows');
    await rotateAnswer('late', 2_500);
    must(['wait', '--text', 'Account id'], 'Waiting for Settings');
    must(['click', '.key-row .btn'], 'Pressing Rotate');
    must(['wait', '--text', 'Rotate the master key?'], 'Waiting for the question');
    must(['click', '.dialog .btn.danger'], 'Confirming');
    must(['wait', '--text', 'Rotating the master key'], 'Waiting for the rotation to cover the console');
    chooseView('agent');
    must(['wait', '--text', 'This page, as an agent does it'], 'Waiting for the Agent view');
    must(['wait', '--text', 'Your new master key'], 'Waiting for the new key after Settings went');
    const third = keyInDialog();
    if (!placesOf(third)?.stored)
      fail('after a rotation that outlived Settings: the new key is not in the session');
    if (await accountWith(second) !== 401 || await accountWith(third) !== 200)
      fail('after a rotation that outlived Settings: the fake doesn\'t agree on which key works');
    must(['find', 'role', 'checkbox', 'check', '--name', 'I saved it somewhere safe'], 'Ticking the box');
    must(['find', 'role', 'button', 'click', '--name', 'Continue'], 'Pressing Continue');
    must(['wait', '--text', 'New master key made'], 'Waiting for the toast');
    onlyInSession(third, 'after a rotation that outlived Settings');
    chooseView('human');
    await travelled([first, second, third], 'after a rotation that outlived Settings');

    // The rotation happens, its answer doesn't arrive, and the console must find the key it holds refused
    const lostAfter = async (answer, held, when) => {
      await rotateAnswer(answer);
      must(['wait', '--text', 'Account id'], 'Waiting for Settings');
      must(['click', '.key-row .btn'], 'Pressing Rotate');
      must(['wait', '--text', 'Rotate the master key?'], 'Waiting for the question');
      must(['click', '.dialog .btn.danger'], 'Confirming');
      must(['wait', '--text', 'but the new one didn\'t reach this browser'], `${when}: waiting for the sign-in view to say why`);
      if (inPage('JSON.stringify(sessionStorage.length)') !== 0)
        fail(`${when}: sessionStorage is not empty`);
      nowhere([held], when);
      if (await accountWith(held) !== 401)
        fail(`${when}: the fake still takes the key the console had`);
      await rotateAnswer('normal');
    };

    log('6. The session\'s key goes while the rotation runs: the new key shows once, and is stored nowhere');
    await rotateAnswer('late', 2_500);
    must(['wait', '--text', 'Account id'], 'Waiting for Settings');
    must(['click', '.key-row .btn'], 'Pressing Rotate');
    must(['wait', '--text', 'Rotate the master key?'], 'Waiting for the question');
    must(['click', '.dialog .btn.danger'], 'Confirming');
    must(['wait', '--text', 'Rotating the master key'], 'Waiting for the rotation to cover the console');
    // The tab loses its key while the request runs, as a sign-out would take it
    must(['eval', 'sessionStorage.clear(); "cleared"'], 'Clearing the session');
    must(['wait', '--text', 'You signed out while the key was rotated'], 'Waiting for the new key, shown for a session that is gone');
    const elsewhere = keyInDialog();
    if (inPage('JSON.stringify(sessionStorage.length)') !== 0)
      fail('after a rotation that outlived the session: the new key was stored');
    if (await accountWith(third) !== 401 || await accountWith(elsewhere) !== 200)
      fail('after a rotation that outlived the session: the fake doesn\'t agree on which key works');
    must(['find', 'role', 'checkbox', 'check', '--name', 'I saved it somewhere safe'], 'Ticking the box');
    must(['find', 'role', 'button', 'click', '--name', 'Continue'], 'Pressing Continue');
    nowhere([third, elsewhere], 'after a rotation that outlived the session');
    await rotateAnswer('normal');
    must(['open', `${consoleUrl}/settings`], 'Opening Settings again');
    must(['wait', '--text', 'Sign in or create an account'], 'Waiting for the sign-in view');
    must(['find', 'role', 'textbox', 'fill', elsewhere, '--name', 'Master key'], 'Pasting the key the dialog showed');
    must(['press', 'Enter'], 'Signing in');

    log('7. Rotate with an answer no one can read: the console checks the key, finds it refused, and says so');
    await lostAfter('garble', elsewhere, 'after an unreadable rotation');

    log('8. Rotate with no answer at all: the browser may send it again, and the console says the same');
    const fourth = await (await ask(`${api}/v1/accounts`, { method: 'POST', headers: { [ownMark]: '1' } })).json().then(account => account.masterKey);
    if (!sampleKey.test(fourth))
      throw new Error('The fake API gave no sample key');
    must(['find', 'role', 'textbox', 'fill', fourth, '--name', 'Master key'], 'Pasting a key');
    must(['press', 'Enter'], 'Signing in');
    await lostAfter('drop', fourth, 'after a rotation with no answer');
    await travelled([first, second, third, elsewhere, fourth], 'after the rotations without an answer');

    log('9. Sign up in a tab that blocks storage, then close the dialog');
    must(['eval', 'Storage.prototype.setItem = function () { throw new DOMException("Blocked", "SecurityError"); }; "blocked"'], 'Blocking storage');
    must(['find', 'role', 'button', 'click', '--name', 'Create an account'], 'Pressing Create an account');
    must(['wait', '--text', 'Your account is ready'], 'Waiting for the new key');
    const unkept = keyInDialog();
    must(['find', 'role', 'checkbox', 'check', '--name', 'I saved it somewhere safe'], 'Ticking the box');
    must(['find', 'role', 'button', 'click', '--name', 'Continue'], 'Pressing Continue');
    must(['wait', '--text', 'blocks storage for this site'], 'Waiting for the browser\'s refusal');
    must(['find', 'role', 'button', 'click', '--name', 'Close'], 'Closing the dialog');
    if (inPage('JSON.stringify(document.querySelectorAll(\'.dialog\').length)') !== 0)
      fail('with storage blocked: the dialog didn\'t close');
    if (inPage('JSON.stringify(sessionStorage.length)') !== 0)
      fail('with storage blocked: sessionStorage is not empty');
    nowhere([unkept], 'with storage blocked, after Close');
    if (inPage('JSON.stringify(document.body.textContent.includes("Sign in or create an account"))') !== true)
      fail('with storage blocked: the sign-in view is gone');
    // A new page has storage again
    must(['open', `${consoleUrl}/`], 'Opening the console again');

    log('10. A new browser doesn\'t know the key');
    const fresh = browser(`${session}-fresh`);
    try {
      if (fresh(['open', `${consoleUrl}/`]).status !== 0 || fresh(['wait', '--text', 'Sign in or create an account']).status !== 0)
        fail('in a new browser: the sign-in view did not show');
      else if (valueOf(fresh(['eval', 'JSON.stringify(sessionStorage.length + localStorage.length)']).stdout) !== 0)
        fail('in a new browser: storage is not empty');
    }
    finally {
      fresh(['close']);
    }
  }
  catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
    fail(error instanceof Error ? `${error.message}${cause}` : String(error));
  }
  finally {
    await rotateAnswer('normal').catch(() => undefined);
    run(['close']);
  }
  log(findings.length === 0 ? 'The key went only where it should: nothing found' : `${findings.length} findings`);

  return findings.length === 0 ? exits.clean : exits.findings;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (options === undefined) {
    process.stderr.write('Usage: key-check.mjs <console url> <fake api url> [--session <name>]\n');
    process.exit(exits.usage);
  }
  process.exit(await checkKey(options));
}
