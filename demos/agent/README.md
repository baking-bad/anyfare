# Agent demo

An AI agent pays APIs for you: from your NEAR wallet, or from Anyfare Credits.

It is one of the demos of Anyfare, a payment router for AI agents: see [the main README](../../README.md).

**Every payment is real money on mainnet.** Read "What protects your money" before you start.

## What it shows

- You ask an agent questions in plain words. It answers with live data from paid APIs.
- It pays from your NEAR wallet with the app [`x402-near-wallet`](../x402-near-wallet). It asks you before each payment.
- When an API doesn't take NEAR, it offers the same call through Anyfare.
- Without your wallet, it pays with Anyfare Credits, using the app [`cli-client`](../cli-client). It signs up, makes a payment key with a daily budget, and gives you a deposit address for a top-up.
- Terms used here:
  - **Agent**: an AI agent that can run shell commands, such as Claude Code or Codex. It follows `instructions.md`.
  - **Anyfare**: a proxy that takes your payment and pays the API the way the API takes.
  - **Credits**: a prepaid balance in US dollars, held by Anyfare.
  - **Payment key**: a key that pays calls from your Credits, within a daily budget. It starts with `af_live_`.
  - **Top-up**: you send a token to a deposit address. NEAR Intents swaps it to USDC on NEAR, and Anyfare adds it to your Credits.

## What is in this folder

| File | What it is |
|---|---|
| `instructions.md` | What the agent does: the commands, the APIs, when to ask, how to answer |
| `README.md` | This file |

## Start your agent

1. Open your agent in `demos/agent`. Start a new session for each run.
2. Send it this first: `Read instructions.md and follow it.`
3. Then type the lines of a scenario below.

- The agent runs only the two apps' commands. `instructions.md` lists them all.
- Your agent may ask before it runs a command. Say yes to the commands of `instructions.md`.
- Your agent's own settings and memory still apply. They can change what it does. A new session with no memory of earlier runs works best.

## Try it without a wallet

You need no wallet and no money. A new Anyfare account gets $0.10 of free Credits: about 10 calls at $0.01.

1. Install Node 24 or later, and an agent.
2. Run `npm ci` in `demos/x402-near-wallet` and in `demos/cli-client`. Put no keys anywhere.
3. Start your agent, as above, and type these lines:

| # | You type | The agent | Cost |
|---|---|---|---|
| 1 | Hi! I have no wallet. Can I try it? | Says no NEAR wallet is set up. Offers Credits, with $0.10 free for a new account | Free |
| 2 | Yes, sign me up. Let's try the free Credits first. | Signs up, and makes a payment key. Shows only the key's first 10 characters, such as `af_live_ab…`. Says how much free Credits the account got | Free |
| 3 | What's the ETH price now? | Pays with Credits. Gives the price, the receipt and the Credits left | $0.01 of free Credits |
| 4 | And anyfare.near's NEAR balance? | Pays with Credits. Anyfare pays the evidence API in USDC on NEAR | $0.001 of free Credits |
| 5 | What did I spend in this chat? | $0.011 of Credits in 2 calls, and what is left | Free |

- Anyfare gives free Credits to a limited number of new accounts each day. When the account gets none, the agent says so and offers a top-up.
- The app saves your Anyfare keys to `demos/cli-client/.env.local`. Keep that file: the keys are shown only once.
- To see your account on the web, sign in at `https://console.anyfare.agents.bakingbad.dev` with the master key from that file. It starts with `afm_live_`.

## The whole scenario: wallet and Credits

### Set up

1. Install Node 24 or later, and an agent.
2. Set up `x402-near-wallet`, as its README says: `npm ci`, then a NEAR account and its full-access key in `x402-near-wallet/.env.local`. The account needs about 0.05 USDC on NEAR. It needs no NEAR for gas.
3. In `demos/cli-client`, run `npm ci`.
   - For a new sign-up, its `.env.local` must not hold `ANYFARE_MASTER_KEY`.
   - If it holds your Anyfare keys, the agent skips the sign-up and uses your account.
4. For the top-up: a wallet of yours with at least 1 USDC on Base, or another token from the list below.

### The lines

Type these lines one by one. The costs are examples. The apps always show the live price.

| # | You type | The agent | Cost |
|---|---|---|---|
| 1 | Hi! Which wallet do you use, and how much is in it? | Reads the wallet: the account, the USDC, the NEAR and the cap | Free |
| 2 | How much NEAR does anyfare.near hold right now? I need it from a final block. | Runs a dry run, then asks: 0.001 USDC to `count.mike.near`, no gas. Pay? | Free |
| 3 | Yes. | Pays once. Gives the NEAR, the block, the NEAR transaction and the balance before and after | 0.001 USDC |
| 4 | Now, what's the Bitcoin price? | Tries CoinMarketCap. The app says "Not supported": it takes USDC on Base and 4 tokens on BNB Chain. The agent dry-runs the Anyfare link, then asks: 0.01 USDC to `pay.anyfare.near`. Pay through Anyfare? | Free |
| 5 | Yes, go through Anyfare. | Pays once. Gives the price, the NEAR transaction, Anyfare's receipt and the balance | 0.01 USDC |
| 6 | What if I don't give you a wallet? | Offers Credits. Asks: sign up, and top up now or try the free Credits first? | Free |
| 7 | Yes. Top up 1 USDC from Base. | Signs up. Makes a payment key of $1 a day, at most $0.02 a call. Shows only its first 10 characters, such as `af_live_ab…`. Gives the deposit address | Free |
| 8 | You send 1 USDC on Base to that address, from your wallet | Says when the top-up is credited, and gives the NEAR transaction of the delivery. The swap keeps a small part | 1 USDC and Base's network fee |
| 9 | What's the ETH price now? | Pays with Credits, without asking. Gives the price, the receipt and the Credits left | $0.01 of Credits |
| 10 | And anyfare.near's NEAR balance, with Credits? | Pays with Credits. Anyfare pays the evidence API in USDC on NEAR | $0.001 of Credits |
| 11 | What did I spend in this chat? | The wallet: 0.011 USDC in 2 calls. Credits: $0.011 in 2 calls | Free |

- One run costs 0.011 USDC from the wallet, plus the top-up. The Credits left after it stay in your Anyfare account.
- Top-ups: more than 100 tokens on 6 networks. The minimum is $1 on Base, Arbitrum, Solana and NEAR; $5 on Ethereum; $10 on Bitcoin.
- The agent may not hear about the top-up on its own. If it says nothing for a while, ask it: "Is my top-up credited?"
- The agent's words differ from run to run. The facts come from the apps' output.

## What protects your money

The apps enforce the first five. The agent follows the rest from `instructions.md`.

- **The app's cap.** `x402-near-wallet` pays at most $0.02 a call by default, and checks every payment before it signs. See its README, "What protects your money".
- **The price can't go up.** The agent pays with `--max` set to the price you saw. A higher price is refused.
- **The payment key's limits.** It allows $1 a day and at most $0.02 a call. Anyfare enforces them.
- **No key on screen.** The apps print only the first 10 characters of an Anyfare key, and never a wallet key.
- **No top-up is sent by the apps.** You send it from your own wallet.
- **Wallet payments are asked first.** The agent runs a dry run, tells you the price and the payee, and pays only after your yes.
- **Credits are paid without a question, within the key's limits.** Why: you agreed to that budget when the key was made.
- **One run for each yes.** The agent never runs a paid command again, even when it fails.
- **The agent leaves your secrets alone.** It never reads `.env` or `.env.local`, never puts a key in a flag, and never runs `key save`.

If your agent can block commands or files, block reading `.env` and `.env.local`. Then this last rule holds even if the agent errs.

## The commands the agent runs

All from `demos/agent`. Use this list to allow commands in your agent.

| Command | Cost |
|---|---|
| `npm --prefix ../x402-near-wallet run -s demo -- balance` | Free |
| `npm --prefix ../x402-near-wallet run -s demo -- --dry-run <request>` | Free |
| `npm --prefix ../x402-near-wallet run -s demo -- --yes --max <price> <request>` | The price, from your wallet |
| `npm --prefix ../cli-client run -s demo -- balance` | Free |
| `npm --prefix ../cli-client run -s demo -- signup --yes` | Free |
| `npm --prefix ../cli-client run -s demo -- key create --daily 1 --max-price 0.02 --yes` | Free |
| `npm --prefix ../cli-client run -s demo -- topup --network <n> --token <t> --amount <a> --yes` | Free. You send the top-up yourself |
| `npm --prefix ../cli-client run -s demo -- call --tool <tool> --pay credits … --yes` | The price, from your Credits |

## Not built, not run

- No settings for any one agent. Your agent's own permissions apply.
- The agent never sends a top-up. You send it from your own wallet.
- The agent waits for a top-up for at most 30 minutes.
- Receipts link to the hosted demo's site, `https://anyfare.agents.bakingbad.dev`.
