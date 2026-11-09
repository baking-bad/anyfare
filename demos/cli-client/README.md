# Anyfare demo app

A console app that calls three paid APIs through Anyfare. It is for developers and for agents that want to see a paid call from start to end.

Anyfare is a payment router for AI agents. This README is the only document of the app. Where the README and the code differ, the code is right.

**Every paid call is real money on mainnet.** Read "What protects your money" before you pay.

## What it is

- One console app. Three paid APIs. Four ways to pay.
- You call an API through Anyfare. Anyfare pays the API in the way that API takes.
- Why pay through Anyfare: you pay from the wallet you have, and the API is paid in the way it takes.
- The app shows the price before it pays, checks it against a cap, and asks you first.
- Terms used in this README:
  - **Anyfare**: the payment router. The app talks to its two addresses (see "Which Anyfare it talks to").
  - **tool**: one of the three APIs.
  - **Credits**: a prepaid balance in US dollars, held by Anyfare.
  - **master key**: the key of your Anyfare account. It starts with `afm_live_`.
  - **payment key**: a key that pays calls from your Credits, with limits. It starts with `af_live_`.
  - **cap**: the most the app pays for one call. It is `MAX_PAYMENT_USD`.

## The three tools

| Tool | What it answers | What the API itself takes | How Anyfare pays it |
|---|---|---|---|
| `cmc`: CoinMarketCap | The latest price of a coin | x402 on Base and BNB Chain | USDC on Base |
| `3route`: 3Route | A swap quote | x402 on Base, Etherlink and Solana; MPP on Tempo | The cheapest `exact` option it can: today USDC on Base |
| `evidence`: the evidence API | A NEAR account's balance at a final block | Only USDC on NEAR | USDC on NEAR, from its NEAR wallet |

- 3Route: best-priced crypto token swaps, for agents, traders, and apps. Pay-per-call quote & swap API via x402/MPP. No API key or subscription.
- Data flags and their defaults:

| Tool | Flags | Defaults |
|---|---|---|
| `cmc` | `--pair` | `BTC/USD` |
| `3route` | `--chain`, `--from`, `--to`, `--amount` | `base`, `USDC`, `WETH`, `1` |
| `evidence` | `--account` | `anyfare.near` |

- `--chain` takes `base`, `ethereum`, `etherlink`, `monad`, or a chain ID.
- `--from` and `--to` take a token symbol or an address. `--amount` is in whole tokens, such as `1`.

## The four ways to pay

You choose one with `--pay`. Each way needs its own settings in `.env.local`.

| `--pay` value | What it is | What it needs in `.env.local` | What it signs | The proof it prints |
|---|---|---|---|---|
| `credits` | Prepaid Credits | `ANYFARE_PAYMENT_KEY` | Nothing | The `Anyfare-Receipt` |
| `near` | USDC on NEAR | `NEAR_ACCOUNT_ID`, `NEAR_PRIVATE_KEY` (a full-access key) | A delegate action. You need no NEAR for gas. | The NEAR transaction |
| `base` | USDC on Base | `BASE_PRIVATE_KEY` | An EIP-3009 authorization. You need no ETH. | The Base transaction |
| `tempo` | USDC.e on Tempo | `TEMPO_PRIVATE_KEY` | A Tempo transfer. The wallet pays its fee, at most $0.01, in USDC.e. | The Tempo transaction |

- With `near`, `base` and `tempo`, your own wallet pays. The app signs; Anyfare settles the payment on chain.
- With `credits`, nothing is signed. Anyfare spends your Credits.
- Anyfare may not offer a way for a call. Then the app stops and says so. Not charged.

## Set up

1. Install Node 24 or later.
2. In `demos/cli-client`, run `npm ci`.
3. Read `.env`. It is the committed example. It holds no secret.
4. Put secrets in `.env.local`. Git ignores that file. **Never commit `.env.local`.**
5. To fill `.env.local` by hand, run `touch .env.local && chmod 600 .env.local`.
6. The app writes Anyfare keys to `.env.local` itself, at mode 600, after you say yes.

- The app writes to `.env.local` and nowhere else.
- Node may print a short notice that `.env.local` is missing. This is harmless.
- Settings come from `.env`, then `.env.local`, then the shell. A later one wins: `.env.local` over `.env`, the shell over both.

## Which Anyfare it talks to

- The defaults are the hosted demo:
  - `https://api.anyfare.agents.bakingbad.dev` (the Platform API: accounts, keys, balance, top-ups)
  - `https://pay.anyfare.agents.bakingbad.dev` (the proxy: quotes and paid calls)
- **Not deployed yet on 2026-11-09.** Until it is, use a local Anyfare.
- To use a local Anyfare, set `ANYFARE_API_URL` and `ANYFARE_PAY_URL` in `.env.local` or in the shell.
- The app also reads each API's own unpaid answer, and the NEAR and Tempo RPCs when it signs. Reads send no payment.

## The variables

| Name | For | What to put | Required |
|---|---|---|---|
| `ANYFARE_API_URL` | The Platform API address | An `http://` or `https://` URL | Optional (hosted demo) |
| `ANYFARE_PAY_URL` | The proxy address | An `http://` or `https://` URL | Optional (hosted demo) |
| `MAX_PAYMENT_USD` | The cap on one call | A plain decimal above zero, such as `0.02` | Optional (`0.02`) |
| `ANYFARE_MASTER_KEY` | `key create`, `balance`, `topup` | `afm_live_…`; the app saves it after `signup` | For those commands |
| `ANYFARE_PAYMENT_KEY` | `--pay credits`; `balance` | `af_live_…`; the app saves it after `key create` | For `--pay credits` |
| `NEAR_ACCOUNT_ID` | `--pay near` | A NEAR account, such as `name.near` | For `--pay near` |
| `NEAR_PRIVATE_KEY` | `--pay near` | A full-access key of that account: `ed25519:` and base58 | For `--pay near` |
| `NEAR_RPC_URL` | `--pay near` | A NEAR RPC. `https://`, or `http://` to this machine only | Optional (the SDK's own) |
| `BASE_PRIVATE_KEY` | `--pay base` | `0x` and 64 hex digits | For `--pay base` |
| `TEMPO_PRIVATE_KEY` | `--pay tempo` | `0x` and 64 hex digits | For `--pay tempo` |
| `TEMPO_RPC_URL` | `--pay tempo` | A Tempo RPC. `https://`, or `http://` to this machine only | Optional (the chain's own) |

- Wallet keys go only in `.env.local`.
- The app never prints a key in full. It prints the first 10 characters, then `…`. A wallet private key is hidden whole.
- The app prints an RPC URL only by its host. Why: the URL may hold an API key.
- An RPC URL can't carry a user name or password. Put an API key in its path or query.

## Do X, see Y

Run every command from `demos/cli-client`. Add `--` after `npm run demo`, so npm passes the flags on.

### Interactive mode

- Command: `npm run demo`
- You see: questions. Pick a tool, give its data, pick a way to pay, then confirm.
- For Credits, it offers to run `signup`, `key create` and a top-up when something is missing.
- It needs a terminal. After each call it asks "Another call?".
- While it waits for a deposit, press Enter, or Ctrl-C once, to stop waiting. It goes back to "How do you pay?". A second Ctrl-C ends the app.
- Cost: free until you confirm a call. Then the cost is the call's.

### `explain`

- Command: `npm run demo -- explain --tool cmc`
- You see: what the API asks without Anyfare, what Anyfare asks for the same call, and the quote against your cap.
- Cost: free. It sends no payment. Exit code 1 if the API or Anyfare did not answer, or Anyfare can't pay the call.

### `signup`

- Command: `npm run demo -- signup`
- You see: a question, then the new account and the first 10 characters of its master key, saved to `.env.local`. It also shows your balance.
- Cost: free. It refuses if `ANYFARE_MASTER_KEY` is set already.
- Without a terminal, add `--yes`.

### `key create`

- Command: `npm run demo -- key create`
- Flags: `--label demo`, `--daily 1`, `--max-price 0.02` (US dollars; these are the defaults).
- You see: a question, then the key's limits and the first 10 characters of the key, saved to `.env.local`.
- Cost: free. It needs `ANYFARE_MASTER_KEY`. A new key replaces the saved one; the old key works until it is revoked.

### `balance`

- Command: `npm run demo -- balance`
- You see: your Credits with the master key; the payment key's limits with the payment key. It uses the keys that are set.
- Cost: free.

### `call`

- Command: `npm run demo -- call --tool <tool> --pay <way> [data flags] [--explain] [--yes]`
- You see: the plan and the price, a question, the signing, the call, then the result.
- The result stands apart, between two blank lines. A bold header names the tool. The answer is under a left bar. Under it, a `Proof` block shows the receipt, or the transaction with its link. The last line says who paid what.
- The result keeps its shape without colors, for piped output or `NO_COLOR`.
- `--explain` prints the full plan before the question. `--yes` skips the question.
- Without a terminal, `--yes` is required.
- Every `call` is paid. What it costs:

| Call | Price the API asked | Checked |
|---|---|---|
| CoinMarketCap, `BTC/USD` | $0.01 (10000 atomic USDC on Base) | 2026-11-09 |
| 3Route, 1 USDC to WETH on Base | $0.001 (1000 atomic USDC on Base). Its OpenAPI document gives a dynamic price, $0.00001 to $0.001 | 2026-11-09 |
| The evidence API | 0.001 USDC on NEAR | 2026-11-09 |

- Anyfare's fee: 0 on 2026-11-09 (its production config).
- Prices change. The app always prints the live ones, from the APIs' 402s and Anyfare's quote.
- With `--pay tempo`, add a network fee of at most $0.01 in USDC.e. The cap covers the price and that fee together.

#### `call` with `--pay credits`

- Command: `npm run demo -- call --tool cmc --pay credits`
- Needs `ANYFARE_PAYMENT_KEY` and enough Credits. Costs the quote, in Credits.
- Shows the `Anyfare-Receipt`. `balance` shows what was paid.

#### `call` with `--pay near`

- Command: `npm run demo -- call --tool evidence --pay near`
- Needs `NEAR_ACCOUNT_ID` and `NEAR_PRIVATE_KEY`. Costs the quote, in USDC on NEAR.
- Shows the NEAR transaction, with a link.

#### `call` with `--pay base`

- Command: `npm run demo -- call --tool cmc --pay base`
- Needs `BASE_PRIVATE_KEY`. Costs the quote, in USDC on Base.
- Shows the Base transaction, with a link.

#### `call` with `--pay tempo`

- Command: `npm run demo -- call --tool 3route --pay tempo`
- Needs `TEMPO_PRIVATE_KEY`. Costs the quote, in USDC.e on Tempo, and the network fee.
- Shows the Tempo transaction, with a link. Anyfare must offer a Tempo charge for the call.

### `topup`

- Command: `npm run demo -- topup --network <network> --token <token> --amount <amount>`
- You see: a deposit address and what to send. Then the app checks every 5 seconds, for at most 30 minutes, until the top-up is credited or ends.
- Send the transfer yourself, from a wallet of yours. The app sends nothing.
- Cost: what you send. The network's fee is yours. Needs `ANYFARE_MASTER_KEY`.
- Before it asks for an address, it checks the amount against the network's minimum. It does this for `USDC`, `USDT`, `USDT0` and `DAI` only. These are worth one US dollar each. For any other token, the app can't price it. It sends the request, and shows the API's own answer.
- Under the minimum, the app says so in one line and sends nothing. In the interactive mode it asks for the amount again, up to 3 times.
- If the swap service still says the amount is too low, the app adds a line: try a larger amount.
- On a terminal, the app prints "Press Enter to stop waiting." Press Enter to stop at once.
- There is no way to cancel a top-up. The address stays open until its `Pay by` time. A transfer sent before then is still credited, and `balance` shows it. After that time, don't send to it. The app says this when you stop.
- Exit code 0 if credited, 1 if not, also when you stop waiting. `Ctrl-C` ends the app. It is safe: `balance` shows the result later.
- If this Anyfare has no top-ups, the app says so in one line.

## What protects your money

- **The cap.** `MAX_PAYMENT_USD` (default `0.02`) is checked before anything is signed or sent. It is checked against the amount the app pays. Why: one wrong price can't cost more than the cap.
- **The payment key's own limits.** The demo's key: $1 a day, at most $0.02 a call. Why: Anyfare enforces them even if this app is wrong.
- **The app signs only the option it printed.** It is in the network's USDC. It stays valid for at most 300 seconds on Base, 300 blocks (about 3 minutes) on NEAR, or until the charge closes on Tempo (at most 10 minutes). Why: a signature that leaks pays only that option, and only for a short time.
- **One request per call, never retried.** Why: a retry could pay twice.
- **A question before each paid call, unless `--yes`.** Why: you see the price first.
- **The app checks what it signed** before it sends it: the amount, the recipient, the asset and the time limit. Why: the signing library could change what it signs.
- **"Not charged" only when nothing could have moved.** Why: when the line doesn't say it, you know to check.

## Exit codes and errors

| Code | Meaning |
|---|---|
| 0 | A paid answer, or a finished command |
| 1 | An expected failure. One line on stderr |
| 2 | Bad usage. One line on stderr |

- A failure line that ends in "Not charged." says nothing was paid. The app only says it when nothing could have moved.
- A failure line without "Not charged." means the outcome is not known. The line says where to look, such as `balance` or a block explorer.
- Check your wallet or your Credits before you try again.

## Limits

- One NEAR payment in flight per payer. A second gets a refusal until the first settles.
- A Tempo payment is valid for about 25 seconds. A slow API, such as the evidence API (about 15 seconds), may fail with Tempo. Not charged.
- Top-ups need an Anyfare that has them. Otherwise the app says so in one line.
- The app pays an API only in the ways of the table "The four ways to pay".

## Not built

- Solana as a way to pay. Anyfare takes x402 on Solana, and `@x402/svm` would add it to this app. Not built.
- 3Route's `batch-settlement` option. Anyfare pays `exact` options only.
- A top-up from the app's own wallet. The person sends a top-up from a wallet of theirs.

## How it works

| File | What it does |
|---|---|
| `src/main.ts` | Starts the app and sets the exit code |
| `src/cli.ts` | Reads the flags, holds the help text, runs one handler per command |
| `src/config.ts` | Reads the Anyfare addresses and the cap |
| `src/context.ts` | Output, questions and the confirmation for one run |
| `src/interactive.ts` | The interactive mode |
| `src/call.ts` | Picks the payer for `call` |
| `src/paid.ts` | The steps every paid call shares: plan, cap, one request, error lines |
| `src/credits.ts` | A call paid with Credits, and its receipt |
| `src/x402.ts` | A call paid with x402, on Base or NEAR |
| `src/tempo.ts` | A call paid with an MPP charge on Tempo |
| `src/explain.ts` | The free reads and the text of `explain` |
| `src/anyfare.ts` | The routing link, `GET /_/check` and the unpaid 402 |
| `src/offers.ts` | Reads a 402 into one list of payment options |
| `src/networks.ts` | Names of networks and assets |
| `src/platform.ts` | The Platform API: sign-up, keys, balance |
| `src/account.ts` | `signup`, `key create` and `balance` |
| `src/topup.ts` | `topup`: the deposit address and the wait |
| `src/wallets.ts` | Reads and checks the wallet settings; block explorer links |
| `src/envLocal.ts` | Saves keys to `.env.local` at mode 600 |
| `src/errors.ts` | One plain line for each Anyfare error; hides keys |
| `src/http.ts` | One request with a time limit; how far a failed request got |
| `src/prompt.ts` | The questions on a terminal |
| `src/style.ts` | Colors and line shapes |
| `src/util.ts` | Amounts as exact integers, the error types, small helpers |
| `src/exit.ts` | Ends the run once all output is written |
| `src/tools/index.ts` | The three tools and their default data |
| `src/tools/types.ts` | The shape of a tool |
| `src/tools/read.ts` | Helpers to read an answer with missing fields |
| `src/tools/cmc.ts` | CoinMarketCap: the request and the answer lines |
| `src/tools/threeRoute.ts` | 3Route: token lookup, the request and the answer lines |
| `src/tools/evidence.ts` | The evidence API: the request and the answer lines |

## Tests

- Command: `npm test`
- The tests are offline. They run against fakes of Anyfare, the NEAR RPC and the Tempo RPC.
- They use no network and no money.
- `npm run typecheck` checks the types.
