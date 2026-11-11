# x402-near-wallet

Pays x402 APIs in USDC from a NEAR wallet.

**Every payment is real money on NEAR mainnet.** Read "What protects your money" before you pay. No paid call has run yet: see "Not built, not run".

## What it does

- You give the app a link, or a request with curl's options.
- The app asks the API once, with no payment.
- If the API takes USDC on NEAR, the app shows the cost and asks you. It pays once. It shows the answer, the proof and the new balance.
- If the API does not take USDC on NEAR, the app says so and pays nothing. When the API takes another network or token, the app also prints the same request through Anyfare.

Terms used in this README:

- **x402**: a way for an API to ask for a payment with HTTP status 402.
- **the 402**: the answer of an API that asks for a payment. It lists what the API takes.
- **cap**: the most the app pays for one call. Default: 0.02 US dollars.
- **Anyfare**: a proxy that takes USDC on NEAR. It pays the API the way the API takes.
- **Anyfare link**: your request, sent to Anyfare instead of the API. See "How the Anyfare link works".

## Set up

1. Install Node 24 or later.
2. Install the packages, in this folder:

```
npm install
```

3. Make a separate NEAR account for this app. Put about 0.05 USDC on it: native USDC on NEAR, the contract `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`. Why a separate account: you risk only what it holds.
4. Create the file `.env.local` in this folder. Put the secrets there:

```
NEAR_ACCOUNT_ID=your-account.near
NEAR_PRIVATE_KEY=ed25519:...
```

- The key must be a full-access key. Why: a USDC transfer attaches 1 yoctoNEAR, and a function-call key cannot do that.
- The wallet needs no NEAR for gas. The API's facilitator pays it.
- Put the key in `.env.local` only. Never in `.env`, the shell or a flag. Git ignores `.env.local`.
- When `.env.local` is missing, Node prints ".env.local not found. Continuing without it." That is harmless.

## The settings

Settings come from `.env`, then `.env.local`, then the shell. The last one wins. `.env` is a committed example with no secret.

| Variable | What it is | Default | Needed |
|---|---|---|---|
| `NEAR_ACCOUNT_ID` | The wallet, such as `alice.near` | none | `balance`, interactive, paying; a dry run may go without it |
| `NEAR_PRIVATE_KEY` | A full-access key of that account | none | Paying only |
| `NEAR_RPC_URL` | The NEAR RPC to read and sign with | `https://rpc.mainnet.fastnear.com`, the SDK's own | Optional |
| `MAX_PAYMENT_USD` | The cap, in dollars | `0.02` | Optional |
| `ANYFARE_PAY_URL` | Where the Anyfare link points | `https://pay.anyfare.agents.bakingbad.dev` | Optional |

- `NEAR_RPC_URL` must be https. Plain http is allowed for `localhost` and `127.0.0.1` only. It must be a mainnet RPC.
- `MAX_PAYMENT_USD` is a plain amount above zero, with at most 6 decimals.
- `ANYFARE_PAY_URL` has no path, query or fragment.

## Commands

Every command runs from this folder. After `--`, `npm run demo` passes the words to the app.

The app always shows the live price from the API's 402. It never uses a price from its code. Costs below were checked on 2026-11-11, unpaid.

### Interactive mode

```
npm run demo
```

- Do: run it in a terminal, with `NEAR_ACCOUNT_ID` set.
- See: a title line, then your wallet, its balance and the cap.
- If `NEAR_PRIVATE_KEY` is not set, a warning says the app can show costs but cannot pay.
- Then the prompt `Link or request (Enter to quit):`.
- A line can be:
  - a link, or a request with curl's options;
  - `balance`;
  - `--help`;
  - the options `--dry-run`, `--full` and `--max <usd>` before a link. They apply to that line only.
- `--yes` is refused here: this mode always asks.
- After each line, the result, then the prompt again. A failed line prints its error and the prompt returns.
- Enter on an empty line quits. So does Ctrl-C at the prompt.
- Ctrl-C while a request runs:
  - The app prints "Stopping after this request. A payment that was sent can't be called back."
  - A payment question that is still open is answered "no". Nothing is paid for it.
  - A request past its question finishes, and its outcome is shown. The app then quits.
  - A second Ctrl-C ends the app at once, with exit code 130.
- This mode needs a terminal.

### Balance

```
NEAR_ACCOUNT_ID=pay.anyfare.near npm run demo -- balance
```

- Do: run it. It needs the account only, never the key. It is free.
- See: the wallet, its USDC and NEAR, and the cap.

### One request, with a question

```
npm run demo -- 'https://pay.anyfare.agents.bakingbad.dev/pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?symbol=BTC&convert=USD'
```

- Do: run it in a terminal with the key set.
- See: the cost, the payee, how long the payment is valid, your cap and your balance.
- Then the question `Pay 0.01 USDC on NEAR? [y/N]`. The answer is "no" unless you type `y` or `yes`.
- The cost was 0.01 USDC on NEAR on 2026-11-11. It is paid to `pay.anyfare.near`. It is valid for 300 blocks, about 3 minutes.
- After `y`: the answer, the proof, `You paid 0.01 USDC on NEAR.` and the new balance.
- Without a terminal and without `--yes`, the app stops and pays nothing.

### `--dry-run`

```
npm run demo -- --dry-run 'https://pay.anyfare.agents.bakingbad.dev/pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?symbol=BTC&convert=USD'
```

- Do: run it. It needs no key. It needs no account, but with `NEAR_ACCOUNT_ID` it also shows your balance.
- See: the cost, the payee and your cap, then `Would pay 0.01 USDC on NEAR to pay.anyfare.near. Not paid.`
- Exit code 0.

### `--yes`

```
npm run demo -- --yes -X POST --json '{"accountId":"anyfare.near"}' https://pay.anyfare.agents.bakingbad.dev/merchant-near.mikedotexe.com/v1/evidence/account
```

- Do: run it with the key set. **This pays.** It does not ask.
- See: the plan, then the signing, the call, the answer, the proof and the new balance.
- The cost was 0.001 USDC on NEAR on 2026-11-11, paid to `pay.anyfare.near`. The answer is a NEAR account's balance at a final block.
- `--yes` and `--dry-run` together are refused.
- The same request sent straight to `https://merchant-near.mikedotexe.com/v1/evidence/account`, without Anyfare, asks 0.001 USDC on NEAR to `count.mike.near` (2026-11-11). The app can pay it, but no such payment has run yet: not verified.

### `--max`

```
npm run demo -- --max 0.05 --dry-run 'https://pay.anyfare.agents.bakingbad.dev/pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?symbol=BTC&convert=USD'
```

- Do: run it. `--max` sets the cap for this run. It wins over `MAX_PAYMENT_USD`.
- See: `Your cap` with `$0.05`.
- When the cost is above the cap, you see `Costs ... above your cap of ... Nothing paid.` and exit code 1.

### `--full`

```
npm run demo -- --full https://api.github.com/zen
```

- Do: run it. `--full` shows the whole answer.
- Without it, the app shows at most 40 lines of at most 200 characters.
- See: the answer, then `Free: nothing paid.` Exit code 0. A free API is never paid.

### `--help`

```
npm run demo -- --help
```

- See: the usage, the options, the settings and the exit codes. Exit code 0.

## Requests with curl's options

A request is a URL with curl's options. A leading `curl` is dropped. The paid request sends the same method, headers and body, once.

| Option | What it does |
|---|---|
| `-X`, `--request` | Sets the method |
| `-H`, `--header` | Adds a header, as `'Name: value'` |
| `-d`, `--data`, `--data-raw` | Sets the body; several are joined with `&` |
| `--json` | Sets the body, and `Content-Type` and `Accept` to JSON |
| `-s`, `--silent`, `-S`, `--show-error` | Accepted and ignored |

- The URL must be https. Plain http is allowed for `localhost` and `127.0.0.1` only. It has no user name or password.
- One URL per request.
- Refused: `@file` in `-d`, `--json` or `-H`. Why: the app never sends a local file.
- Refused: the headers `PAYMENT-SIGNATURE` and `X-PAYMENT`. The app sets them. Also `Authorization: Payment`: it is a second payment.
- Refused: any other option. The app names it and lists what it takes.
- Refused: a body on GET or HEAD. Use `-X POST`, or put the data in the URL.
- Refused: the methods CONNECT, TRACE and TRACK.
- `-d` and `--json` together are refused.

## When an API is not supported

The app pays nothing and exits with code 3. It says `Not supported:` and why.

| Case | The line says |
|---|---|
| No x402 payment request in the 402 | `no x402 payment request` |
| An x402 version other than 2 | `it asks for x402 version N. This app pays version 2` |
| No NEAR option | `this API doesn't take NEAR. It takes ...` and the list of networks |
| NEAR, but not the `exact` scheme | `it asks for the ... scheme on NEAR. This app pays exact only` |
| NEAR, but not USDC | `it asks for ... on NEAR. This app pays USDC only` |
| A NEAR USDC option the app will not sign | `the API's NEAR option ... so the app won't sign it` |

- A USDC option on NEAR is not signed when: it has no amount above zero, its recipient is not a NEAR account, it has no time limit or one above 300 seconds, or its payment flow is not `authorization`.
- The first five cases also print the Anyfare link. The last case does not: the fault is in the option, so another route would not help.
- No link is printed for a link that is already on the Anyfare host, nor for plain http.
- Checked on 2026-11-11: CoinMarketCap's own link, `https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?symbol=BTC&convert=USD`, takes USDC on Base and 4 tokens on BNB Chain. It takes no NEAR. The app says "Not supported", prints the Anyfare link and exits with code 3.

```
npm run demo -- 'https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?symbol=BTC&convert=USD'
```

## How the Anyfare link works

The link is the pay host, then `/`, then your URL without `https://`.

- Your URL: `https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?symbol=BTC&convert=USD`
- The Anyfare link: `https://pay.anyfare.agents.bakingbad.dev/pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?symbol=BTC&convert=USD`
- For a request with options, the app prints the whole request with only the URL changed. You can paste it back.
- Why Anyfare: it is the same request. You pay in USDC on NEAR. Anyfare pays the API the way the API takes.
- Checked on 2026-11-11: the Anyfare link above takes 0.01 USDC on NEAR, paid to `pay.anyfare.near`.

## What protects your money

- The cap, 0.02 dollars by default, is checked before anything is signed. `--max` changes it for one run.
- The balance is read first. When the wallet holds less than the cost, the app stops: `Costs 0.01 USDC. The wallet holds 0. Nothing paid.` Exit code 1.
- The app asks before it pays, unless you give `--yes`. Without a terminal and without `--yes`, it does not ask and does not pay.
- A line typed before the question does not answer it. Ctrl-C at the question pays nothing.
- It signs only:
  - the `exact` scheme, on NEAR mainnet;
  - the known USDC contract;
  - a payment valid for at most 300 blocks;
  - the `authorization` payment flow.
- The SDK's own spend limits are set to the cap.
- The RPC must be a mainnet RPC. The app checks its chain ID.
- The signed transfer is checked before it is sent: sender, contract, one transfer, amount, recipient, 1 yoctoNEAR, validity.
- The paid request is sent once. It is never retried and never redirected.
- Each line says only what is true:
  - "Nothing paid" is said only before a signature exists.
  - "Not charged" is said only when it is proved.
  - Otherwise the app says "not known" and shows where to check.
- The key is never printed, in whole or in part.

## The proof

After a payment, the app shows a `Proof` block from the `PAYMENT-RESPONSE` header:

- the transaction;
- the NEAR explorer link;
- the network;
- the payer;
- then `You paid ...` and the balance after.

More:

- Without a proof that the payment settled, the app says `Whether you paid ... is not known` and warns.
- Check your payments at `https://nearblocks.io/address/<your account>`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Answered, paid or free; also a dry run that would pay |
| 1 | Failed |
| 2 | Bad usage |
| 3 | Not supported, nothing paid |

## Tests

```
npm test
npm run typecheck
```

- The tests run offline. They use a fake API and a fake NEAR RPC, and keys made in memory.
- They pay nothing and need no `.env.local`.

## Not built, not run

- No paid call has run yet. Example output of a payment comes after a live run, with its date and time.
- It pays only USDC on NEAR. No Base, no Solana, no other network. No MPP.
- It signs only the `exact` scheme and the `authorization` payment flow.
- No agent part: it is a console app.
- The interactive mode keeps no line history.
