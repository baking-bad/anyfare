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
// the rotation's answers. The last steps make payment keys on the Keys page: the key is on the page only while its
// dialog shows it, in no storage, cookie or address, and gone from the page's HTML after "I saved it" and on `pagehide`.
// Then Top up: a link's amount signed out and after sign-in, a link's other text never shown, a top-up through each
// status (the fake's `/_test/topup` switch) with the address checked against the API's, a reload that brings it back,
// a POST whose answer is dropped or lost (`/_test/create`) and never sent again, and the time to pay running out; one
// request at a time when the form is shown again, an address that comes late while another top-up is open, a double click
// and Enter with a click, and a slow answer for one top-up while another is open (`/_test/slow`).
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

  // A payment key is shown once: only the dialog that shows it may hold it, and the page's HTML holds it only then
  const paymentKeyPlaces = key => inPage(`(() => {
    const key = ${JSON.stringify(key)};
    const entries = store => { try { return JSON.stringify(Object.entries(store)); } catch { return ''; } };
    return JSON.stringify({
      session: entries(sessionStorage).includes(key), local: entries(localStorage).includes(key), cookie: document.cookie.includes(key), address: location.href.includes(key),
      history: JSON.stringify(history.state ?? null).includes(key), html: document.documentElement.outerHTML.includes(key),
      windowProperty: Object.keys(window).some(name => { try { return typeof window[name] === 'string' && window[name].includes(key); } catch { return false; } }),
    });
  })()`);
  const paymentKeyHeld = key => {
    const places = paymentKeyPlaces(key);
    if (places === undefined)
      return ['the page could not be read'];

    return ['session', 'local', 'cookie', 'address', 'history', 'windowProperty'].filter(place => places[place]).map(place => place === 'session' ? 'sessionStorage' : place === 'local' ? 'localStorage' : place === 'windowProperty' ? 'a window property' : `the ${place}`);
  };
  const paymentKeyInHtml = key => paymentKeyPlaces(key)?.html === true;
  const dialogsOpen = () => inPage('JSON.stringify(document.querySelectorAll(\'.dialog\').length)');
  const paymentKeyInDialog = () => {
    const key = run(['get', 'text', '.key-once-value']).stdout.trim().split('\n').at(-1) ?? '';
    if (!/^af_test_[0-9a-f]{32}$/.test(key))
      throw new Error('The dialog shows no sample payment key of the fake API: is the site running against it?');

    return key;
  };
  const makeKey = name => {
    must(['find', 'role', 'button', 'click', '--name', 'New key'], 'Pressing New key');
    must(['wait', '--text', 'New payment key'], 'Waiting for the form');
    must(['fill', '#key-label', name], 'Naming the key');
    must(['find', 'role', 'button', 'click', '--name', 'Make key'], 'Pressing Make key');
    must(['wait', '--text', 'Copy the key now'], 'Waiting for the new payment key');

    return paymentKeyInDialog();
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

    log('11. Make a payment key: it is on the page only while its dialog shows it, in no storage, cookie or address');
    must(['open', `${consoleUrl}/`], 'Opening the console');
    must(['wait', '--text', 'Sign in or create an account'], 'Waiting for the sign-in view');
    must(['find', 'role', 'button', 'click', '--name', 'Create an account'], 'Pressing Create an account');
    must(['wait', '--text', 'Your account is ready'], 'Waiting for the new key');
    const master = keyInDialog();
    must(['find', 'role', 'checkbox', 'check', '--name', 'I saved it somewhere safe'], 'Ticking the box');
    must(['find', 'role', 'button', 'click', '--name', 'Continue'], 'Pressing Continue');
    must(['wait', '--text', 'Available'], 'Waiting for the Overview');
    must(['find', 'role', 'link', 'click', '--name', 'Keys'], 'Opening Keys');
    must(['wait', '--text', 'An agent checks its own key'], 'Waiting for Keys');
    must(['network', 'requests', '--clear'], 'Clearing the request list');
    const payment = makeKey('check agent');
    for (const place of paymentKeyHeld(payment))
      fail(`a payment key is in ${place} while its dialog shows it`);
    if (!paymentKeyInHtml(payment))
      fail('the dialog doesn\'t show the payment key');
    if (inPage('JSON.stringify(document.body.textContent.includes("export ANYFARE_PAYMENT_KEY=" + ' + JSON.stringify(payment) + '))') !== true)
      fail('the dialog shows no export line with the key');
    must(['press', 'Escape'], 'Pressing Escape');
    if (dialogsOpen() !== 1)
      fail('Escape closed the dialog that shows the payment key');
    must(['find', 'role', 'button', 'click', '--name', 'I saved it'], 'Pressing I saved it');
    if (dialogsOpen() !== 0)
      fail('the dialog is still open after I saved it');
    if (paymentKeyInHtml(payment))
      fail('the payment key is still in the page\'s HTML after I saved it');
    for (const place of paymentKeyHeld(payment))
      fail(`a payment key is in ${place} after I saved it`);
    must(['wait', '--text', 'check agent'], 'Waiting for the list to read again');
    if (paymentKeyInHtml(payment))
      fail('the payment key is in the page\'s HTML after the list was read again');
    await travelled([master, payment], 'after a payment key was made');

    log('12. A page that is left while the key is shown: the key is gone from the page at once');
    const another = makeKey('second agent');
    if (!paymentKeyInHtml(another))
      fail('the dialog doesn\'t show the second payment key');
    must(['eval', 'window.dispatchEvent(new Event("pagehide")); "left"'], 'Leaving the page');
    if (paymentKeyInHtml(another))
      fail('the payment key is still in the page\'s HTML after pagehide');
    if (dialogsOpen() !== 0)
      fail('the dialog is still open after pagehide');
    for (const place of paymentKeyHeld(another))
      fail(`a payment key is in ${place} after pagehide`);
    await travelled([master, payment, another], 'after the payment keys');

    // The top-ups of the account, as the fake has them, read with the key outside the browser
    const topupsOf = async key => (await (await ask(`${api}/v1/topups?limit=20`, { headers: { authorization: `Bearer ${key}`, [ownMark]: '1' } })).json()).topups ?? [];
    const moveTopup = async (id, status, extra = '') => {
      await ask(`${api}/_test/topup?id=${encodeURIComponent(id)}&status=${status}${extra}`, { method: 'POST' });
    };
    const posts = async () => (await record()).filter(entry => entry.method === 'POST' && entry.path.split('?')[0] === '/v1/topups').length;
    const pageText = () => inPage('JSON.stringify(document.body.innerText)') ?? '';
    // The POSTs the page sent, in the browser's own list of requests: a browser may send a POST again by itself when its
    // connection drops, and the fake then counts two
    const pagePosts = () => (valueOf(run(['network', 'requests', '--json']).stdout)?.data?.requests ?? [])
      .filter(request => request.method === 'POST' && URL.canParse(request.url) && new URL(request.url).pathname === '/v1/topups').length;
    const unanswered = async (before, when) => {
      if (pagePosts() !== 1)
        fail(`${when}: the page sent the POST more than once`);
      const atFake = await posts() - before;
      if (atFake > 1)
        log(`  note: ${when}, the browser sent the POST again by itself when the connection dropped: the fake got ${atFake}`);
    };
    const shownAddress = () => inPage('JSON.stringify(document.querySelector(".addr-box")?.textContent ?? null)');
    // The page reads an open top-up again only while its tab is visible: a headless browser that runs other sessions may
    // report this one hidden, so the tab is brought to the front first
    const toFront = () => {
      const active = valueOf(run(['tab', 'list', '--json']).stdout)?.data?.tabs?.find(tab => tab.active)?.tabId;
      if (active !== undefined)
        run(['tab', active]);
      if (inPage('JSON.stringify(document.visibilityState)') !== 'visible')
        throw new Error('The tab is hidden, so the page reads nothing again: run this check alone');
    };

    log('13. A top-up link, signed out: only its amount shows, and after sign-in Top up opens with it');
    must(['eval', 'sessionStorage.clear(); "cleared"'], 'Signing out');
    must(['open', `${consoleUrl}/topup?amount=5`], 'Opening the top-up link');
    must(['wait', '--text', 'Sign in or create an account'], 'Waiting for the sign-in view');
    if (!pageText().includes('After you sign in, Top up opens with $5.00 from the link.'))
      fail('signed out: the sign-in view does not say the link\'s amount');
    must(['find', 'role', 'textbox', 'fill', master, '--name', 'Master key'], 'Pasting the key');
    must(['press', 'Enter'], 'Signing in');
    must(['wait', '--text', '$5.00 from the link'], 'Waiting for Top up with the link\'s amount');
    must(['wait', '#topup-amount'], 'Waiting for the amount field');
    if (inPage('JSON.stringify(document.querySelector("#topup-amount")?.value)') !== '5')
      fail('after sign-in: the amount field doesn\'t hold the link\'s 5');
    onlyInSession(master, 'on Top up');

    log('14. A link whose query holds markup and other text: none of it shows');
    must(['open', `${consoleUrl}/topup?amount=%3Cscript%3Ealert(1)%3C%2Fscript%3E&note=hello`], 'Opening a link with markup');
    must(['wait', '--text', 'The amount in the link was not used'], 'Waiting for the warning');
    const shown = pageText();
    for (const text of ['alert(1)', '<script', 'hello', 'note='])
      if (shown.includes(text))
        fail(`a link's query shows on Top up: ${text}`);
    if (inPage('JSON.stringify(document.documentElement.outerHTML.includes("alert(1)"))') !== false)
      fail('a link\'s markup is in the page\'s HTML');

    log('15. A top-up: the address is the API\'s, each status shows in turn, and a reload brings the open one back');
    must(['open', `${consoleUrl}/topup?amount=5`], 'Opening Top up');
    must(['wait', '--text', '$5.00 from the link'], 'Waiting for the form');
    const postsBefore = await posts();
    must(['find', 'role', 'button', 'click', '--name', 'Get a deposit address'], 'Asking for an address');
    must(['wait', '--text', 'Deposit address, USDC on Base'], 'Waiting for the address');
    toFront();
    const [newest] = await topupsOf(master);
    if (newest === undefined || newest.amount !== '5' || newest.token !== 'USDC' || newest.network !== 'base')
      fail('the fake has no top-up of 5 USDC on Base');
    else {
      if (shownAddress() !== newest.depositAddress)
        fail('the address on the page is not the API\'s');
      if (inPage('JSON.stringify(document.querySelectorAll(\'svg[aria-label="QR code of the deposit address"]\').length)') !== 1)
        fail('there is no QR code beside the address');
      if (await posts() !== postsBefore + 1)
        fail('one press sent more than one POST /v1/topups');
      const steps = [['incomplete', 'Send the rest before the time runs out', true], ['processing', 'Received. Converting.', false], ['credited', 'The transaction on NearBlocks', false]];
      for (const [status, text, address] of steps) {
        await moveTopup(newest.id, status);
        must(['wait', '--text', text], `Waiting for ${status}`);
        if ((shownAddress() !== null) !== address)
          fail(`${status}: the address ${address ? 'is gone' : 'still shows'}`);
        if (status === 'processing') {
          must(['open', `${consoleUrl}/topup`], 'Reloading Top up');
          toFront();
          must(['wait', '--text', 'Received. Converting.'], 'Waiting for the open top-up to come back');
          if (!pageText().includes(newest.id))
            fail('after a reload: the top-up on screen is not the open one');
        }
      }
      must(['find', 'role', 'button', 'click', '--name', 'New top-up'], 'Pressing New top-up');
      must(['wait', '--text', 'Get a deposit address'], 'Waiting for the form');
      must(['click', '.topup-open'], 'Opening the newest top-up from the list');
      must(['wait', '--text', 'The transaction on NearBlocks'], 'Waiting for the credited top-up');
      // The page scrolls up to the view it opened: a click while it moves would land elsewhere
      must(['wait', '1000'], 'Waiting for the scroll to end');
    }

    log('16. No answer to the POST: it is never sent again, and the top-up made is opened, or the page says none was made');
    await ask(`${api}/_test/create?answer=drop`, { method: 'POST' });
    must(['find', 'role', 'button', 'click', '--name', 'New top-up'], 'Pressing New top-up');
    must(['wait', '#topup-amount'], 'Waiting for the form');
    must(['fill', '#topup-amount', '7'], 'Typing 7');
    const beforeDrop = await posts();
    must(['network', 'requests', '--clear'], 'Clearing the request list');
    must(['find', 'role', 'button', 'click', '--name', 'Get a deposit address'], 'Asking for an address whose answer is dropped');
    must(['wait', '--text', 'Deposit address, USDC on Base'], 'Waiting for the top-up that was made');
    const [dropped] = await topupsOf(master);
    if (dropped?.amount !== '7' || shownAddress() !== dropped.depositAddress)
      fail('after a dropped answer: the page doesn\'t show the top-up that was made');
    await unanswered(beforeDrop, 'after a dropped answer');
    must(['wait', '1000'], 'Waiting for the scroll to end');
    await ask(`${api}/_test/create?answer=lost`, { method: 'POST' });
    must(['find', 'role', 'button', 'click', '--name', 'New top-up'], 'Pressing New top-up');
    must(['fill', '#topup-amount', '8'], 'Typing 8');
    const beforeLost = await posts();
    must(['network', 'requests', '--clear'], 'Clearing the request list');
    must(['find', 'role', 'button', 'click', '--name', 'Get a deposit address'], 'Asking for an address whose request is lost');
    must(['wait', '--text', 'The address was not made'], 'Waiting for the page to say so');
    await unanswered(beforeLost, 'after a lost request');
    if (shownAddress() !== null)
      fail('after a lost request: an address shows');
    await ask(`${api}/_test/create?answer=normal`, { method: 'POST' });

    log('17. The time to pay runs out: the address goes at once, before the API says expired');
    if (dropped !== undefined) {
      await moveTopup(dropped.id, 'waiting', '&seconds=10');
      must(['open', `${consoleUrl}/topup`], 'Reloading Top up');
      toFront();
      must(['wait', '.addr-box'], 'Waiting for the address');
      must(['wait', '--text', 'The time to pay ran out'], 'Waiting for the time to run out');
      if (shownAddress() !== null)
        fail('at zero: the address still shows');
    }

    // The newest top-up of the account whose amount is `amount`, as the fake has it
    const topupOfAmount = async amount => (await topupsOf(master)).find(topup => topup.amount === amount);
    const openRow = amount => inPage(`(() => { const row = [...document.querySelectorAll('tr.topup-row')].find(item => item.querySelector('.c-sent')?.textContent.startsWith(${JSON.stringify(`${amount} USDC`)})); row?.querySelector('.topup-open')?.click(); return JSON.stringify(row !== undefined); })()`);
    const shownId = () => inPage('JSON.stringify(document.querySelector(".topup-id code")?.textContent ?? null)');
    const settle = () => must(['wait', '1000'], 'Waiting for the scroll to end');
    const newForm = () => {
      must(['find', 'role', 'button', 'click', '--name', 'New top-up'], 'Pressing New top-up');
      must(['wait', '#topup-amount'], 'Waiting for the form');
    };

    log('18. One request at a time: a form shown again while the address is being made stays disabled and sends nothing');
    await ask(`${api}/_test/create?answer=late&ms=6000`, { method: 'POST' });
    must(['open', `${consoleUrl}/topup?amount=11`], 'Opening Top up');
    must(['wait', '#topup-amount'], 'Waiting for the form');
    must(['network', 'requests', '--clear'], 'Clearing the request list');
    must(['find', 'role', 'button', 'click', '--name', 'Get a deposit address'], 'Asking for an address that comes late');
    must(['wait', '.topup-sending'], 'Waiting for the form to say an address is being made');
    must(['click', '.topup-open'], 'Opening another top-up from the list');
    must(['wait', '#topup-status'], 'Waiting for that top-up');
    settle();
    newForm();
    if (inPage('JSON.stringify(document.querySelector(".topup-go")?.disabled === true && document.querySelector(".topup-sending") !== null)') !== true)
      fail('a form shown again while an address is being made is not disabled, or doesn\'t say so');
    inPage('(() => { const field = document.querySelector("#topup-amount"); field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); document.querySelector(".topup-go").click(); return JSON.stringify(true); })()');
    must(['wait', '--text', 'Deposit address, USDC on Base'], 'Waiting for the address that came late');
    if (pagePosts() !== 1)
      fail('a form shown again sent a second POST while the first ran');
    const late = await topupOfAmount('11');
    if (late === undefined || shownAddress() !== late.depositAddress)
      fail('the address that came late is not the API\'s for that top-up');
    settle();

    log('19. An address that is ready while another top-up is open: it is offered, and what the person opened stays');
    newForm();
    must(['fill', '#topup-amount', '13'], 'Typing 13');
    must(['find', 'role', 'button', 'click', '--name', 'Get a deposit address'], 'Asking for an address that comes late');
    must(['wait', '.topup-sending'], 'Waiting for the form to say an address is being made');
    must(['click', '.topup-open'], 'Opening another top-up from the list');
    must(['wait', '#topup-status'], 'Waiting for that top-up');
    const opened = shownId();
    must(['wait', '--text', 'Your new deposit address is ready'], 'Waiting for the offer of the new address');
    const offered = await topupOfAmount('13');
    if (shownId() !== opened || offered === undefined || shownId() === offered.id)
      fail('the answer that came late replaced the top-up the person opened');
    settle();
    must(['find', 'role', 'button', 'click', '--name', 'Open it'], 'Opening the new top-up');
    must(['wait', '.addr-box'], 'Waiting for its address, after its own read');
    if (offered !== undefined && (shownAddress() !== offered.depositAddress || shownId() !== offered.id))
      fail('the new top-up opened with an address that is not its own');
    await ask(`${api}/_test/create?answer=normal`, { method: 'POST' });
    settle();

    log('20. A double click, and Enter and a click, send one POST');
    for (const [amount, how] of [['9', 'a double click'], ['10', 'Enter and a click']]) {
      newForm();
      must(['fill', '#topup-amount', amount], `Typing ${amount}`);
      must(['network', 'requests', '--clear'], 'Clearing the request list');
      if (how === 'a double click')
        must(['dblclick', '.topup-go'], 'Double clicking the button');
      else
        inPage('(() => { const field = document.querySelector("#topup-amount"); field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); document.querySelector(".topup-go").click(); return JSON.stringify(true); })()');
      must(['wait', '--text', 'Deposit address, USDC on Base'], `Waiting for the address after ${how}`);
      if (pagePosts() !== 1)
        fail(`${how} sent ${pagePosts()} POSTs`);
      settle();
    }

    log('21. A slow answer for one top-up never puts its address on screen once another is open');
    const [slowOne, quickOne] = [await topupOfAmount('11'), await topupOfAmount('13')];
    if (slowOne === undefined || quickOne === undefined || slowOne.depositAddress === quickOne.depositAddress)
      fail('the fake did not give the two top-ups their own addresses');
    else {
      await ask(`${api}/_test/slow?id=${slowOne.id}&ms=4000`, { method: 'POST' });
      must(['open', `${consoleUrl}/topup?amount=5`], 'Opening Top up');
      toFront();
      must(['wait', '.topup-open'], 'Waiting for the list');
      if (openRow('11') !== true || openRow('13') !== true)
        fail('the rows of the two top-ups are not in the list');
      must(['wait', '.addr-box'], 'Waiting for the second top-up\'s address');
      must(['wait', '5000'], 'Waiting past the slow answer');
      if (shownId() !== quickOne.id || shownAddress() !== quickOne.depositAddress)
        fail('the top-up on screen is not the one opened last');
      if (inPage(`JSON.stringify(document.documentElement.outerHTML.includes(${JSON.stringify(slowOne.depositAddress)}))`) !== false)
        fail('the slow answer put the first top-up\'s address on the page');
      await ask(`${api}/_test/slow?id=${slowOne.id}&ms=0`, { method: 'POST' });
    }
    await travelled([master], 'after the top-ups');
  }
  catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
    fail(error instanceof Error ? `${error.message}${cause}` : String(error));
  }
  finally {
    await rotateAnswer('normal').catch(() => undefined);
    await ask(`${api}/_test/create?answer=normal`, { method: 'POST' }).catch(() => undefined);
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
