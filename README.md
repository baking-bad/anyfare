<p align="center">
  <a href="https://anyfare.agents.bakingbad.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
      <img alt="Anyfare" src="docs/assets/logo-light.svg" height="72">
    </picture>
  </a>
</p>

<p align="center">
  <b>Pay any paid API from the chain you are on.</b><br>
  Or top up with any token and give your agent a key with a budget.
</p>

<p align="center">
  <a href="https://github.com/baking-bad/anyfare/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/baking-bad/anyfare/actions/workflows/ci.yml/badge.svg?branch=master"></a>
  <a href="https://anyfare.agents.bakingbad.dev"><img alt="Hosted demo" src="https://img.shields.io/website?url=https%3A%2F%2Fanyfare.agents.bakingbad.dev&label=hosted%20demo&up_message=live&down_message=down"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Node 24 or later" src="https://img.shields.io/badge/node-%E2%89%A5%2024-339933?logo=nodedotjs&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <br>
  <img alt="x402 version 2" src="https://img.shields.io/badge/x402-v2-00a774">
  <img alt="MPP on Tempo" src="https://img.shields.io/badge/MPP-Tempo-00a774">
  <img alt="NEAR mainnet" src="https://img.shields.io/badge/NEAR-mainnet-00a774?logo=near&logoColor=white">
  <img alt="NEAR Intents, 1Click API" src="https://img.shields.io/badge/NEAR%20Intents-1Click-00a774">
  <a href="https://nearhackathon.com"><img alt="NEAR HACKATHON 2026, Agent Economy" src="https://img.shields.io/badge/NEAR%20HACKATHON%202026-Agent%20Economy-1f1f1f"></a>
</p>

<p align="center">
  <a href="https://anyfare.agents.bakingbad.dev">Website</a> ·
  <a href="https://anyfare.agents.bakingbad.dev/calls">Live calls</a> ·
  <a href="https://console.anyfare.agents.bakingbad.dev">Console</a> ·
  <a href="https://anyfare.agents.bakingbad.dev/llms.txt">llms.txt</a> ·
  <a href="AGENTS.md">AGENTS.md</a>
</p>

<p align="center">
  <a href="https://anyfare.agents.bakingbad.dev/calls/pay_a8d9b92d-a9e6-4b5a-af18-1ed38dae0d2f">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/receipt-dark.png">
      <img alt="A receipt: the buyer paid 0.01 USDC on NEAR, Anyfare paid the API 0.01 USDC on Base" src="docs/assets/receipt-light.png" width="840">
    </picture>
  </a>
</p>

## What it is

- Anyfare is a payment router for AI agents.
- A paid API asks for money through one of two protocols: [x402](https://x402.org) or [MPP](https://mpp.dev).
- Often such an API takes payment only on the chains it chose. An agent with money on another chain can't pay it.
- With Anyfare the agent puts our pay host in front of the API's link. Nothing else changes.
- The agent pays us on the chain it is on. We pay the API on the API's chain.
- The API's owner does nothing. The agent installs nothing of ours.

```
The API:          https://api.example.com/v1/price?symbol=BTC
Through Anyfare:  https://pay.anyfare.agents.bakingbad.dev/api.example.com/v1/price?symbol=BTC
```

## The problem

- [agentic.market](https://agentic.market) lists about 3,700 paid services. None of them accepts tokens on NEAR.
- A small number of services take USDC on NEAR. They are not listed on agentic.market, and they accept no token on another chain.
- In other words, agent payments have a cross-chain problem. Agents and their owners must think about which tokens an API takes, on which networks, and with which wallets.
- With Anyfare this problem is solved quickly and easily: the agent pays from the chain it is on.
- Sometimes an agent has no wallet, or we don't want to set one up for it. Then the agent pays x402 and MPP APIs without a wallet, from a prepaid balance on Anyfare.

## Two ways to pay

| Way | What the agent holds | How it pays |
|---|---|---|
| Per call, from its own wallet | USDC on NEAR, Base or Solana. Or USDC.e on Tempo | Standard x402, or MPP on Tempo. No account |
| From a balance, with a key | A payment key with a budget. No wallet | `Authorization: Bearer af_live_…` |

- The balance is called Credits. 1 Credit is 1 US dollar.
- A person tops it up with any of more than 100 tokens on 6 networks, through [NEAR Intents](https://near-intents.org).
- A failed call costs nothing. We settle the agent's payment only after the API answers `2xx`.

## Try it

Two ways. Both use the hosted demo, and both can start with no money: a new account gets $0.10 of free Credits, as part of the [NEAR Hackathon](https://nearhackathon.com).

### With your own agent

Use the agent you already have, such as Claude Code or Codex.

1. Install Node 24 or later.
2. Run `npm ci` in `demos/x402-near-wallet` and in `demos/cli-client`.
3. Open your agent in `demos/agent` and send it: `Read instructions.md and follow it.`
4. Ask it: `Hi! I have no wallet. Can I try it?` Then: `What's the ETH price now?`

- The agent signs up, makes a payment key with a budget, and pays the API with the free Credits.
- Every line to type, and what protects your money: [demos/agent/README.md](demos/agent/README.md).

**To test payments on NEAR, give the agent a NEAR wallet.** Before you start the agent, create the file `demos/x402-near-wallet/.env.local`:

```
NEAR_ACCOUNT_ID=your-account.near
NEAR_PRIVATE_KEY=ed25519:...
```

- Use a separate NEAR account with about 0.05 USDC on it. You risk only what it holds.
- It is native USDC on NEAR, the contract `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`.
- The key must be a full-access key of that account. The account needs no NEAR for gas.
- Git ignores `.env.local`. The agent never reads it: only the app does.

Then ask the agent:

1. `Which wallet do you use, and how much is in it?`
2. `How much NEAR does anyfare.near hold right now?` It pays 0.001 USDC to an API that takes NEAR.
3. `What's the Bitcoin price?` The API takes only Base, so the agent offers the same call through Anyfare: 0.01 USDC on NEAR.

- The agent shows the price and asks before each wallet payment.
- After each one you get the NEAR transaction, and for a call through Anyfare its receipt.
- Without an agent, the same wallet works in the app itself: [demos/x402-near-wallet](demos/x402-near-wallet/README.md).

Or give your agent only the guide: [llms.txt](https://anyfare.agents.bakingbad.dev/llms.txt), or the [buyer skill](https://anyfare.agents.bakingbad.dev/skills/anyfare-buyer/SKILL.md).

### By hand, with Credits

Steps 1 and 5 are free and need no account. The examples use `curl` and `jq`.

**1. Check a link.** Free. It pays nothing.

```sh
curl "https://pay.anyfare.agents.bakingbad.dev/_/check?url=pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest"
```

You see `"payable":true`, the API's price in USDC on Base, and our quote.

**2. Sign up.** One request, no email.

```sh
umask 077
curl -s -X POST https://api.anyfare.agents.bakingbad.dev/v1/accounts > anyfare-account.json
```

- The answer's `freeCredits` field says how much you got.
- A limited number of new accounts get free Credits each day.
- `masterKey` is shown once. The file keeps it.

**3. Make a payment key** with a budget: $1 a day, at most $0.02 a call.

```sh
ANYFARE_MASTER_KEY=$(jq -r .masterKey anyfare-account.json)
curl -s -X POST https://api.anyfare.agents.bakingbad.dev/v1/keys \
  -H "Authorization: Bearer $ANYFARE_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label":"judge","dailyBudget":"1","maxPrice":"0.02"}' > anyfare-key.json
ANYFARE_PAYMENT_KEY=$(jq -r .key anyfare-key.json)
```

**4. Call a paid API.** This spends about $0.01 of the free Credits. We pay CoinMarketCap in USDC on Base.

```sh
curl -i "https://pay.anyfare.agents.bakingbad.dev/pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?symbol=BTC&convert=USD" \
  -H "Authorization: Bearer $ANYFARE_PAYMENT_KEY"
```

You see `200`, the price of BTC, and the header `Anyfare-Receipt: id="pay_…"`.

**5. Read the receipt.** It is public.

```sh
curl https://api.anyfare.agents.bakingbad.dev/v1/calls/<the pay_… id>
```

The same receipt as a page: `https://anyfare.agents.bakingbad.dev/calls/<the pay_… id>`.

Every endpoint: [llms-full.txt](https://anyfare.agents.bakingbad.dev/llms-full.txt). People can do the same in the [console](https://console.anyfare.agents.bakingbad.dev).

## Demo apps

Three demos in [demos/](demos/). They talk to the hosted demo. **A paid call in a demo is real money on mainnet**, a cent or less.

| Demo | What it shows |
|---|---|
| [demos/agent](demos/agent/README.md) | An AI agent as a paying assistant. You ask in plain words. It pays from your NEAR wallet, or from Credits, with the two apps below |
| [demos/x402-near-wallet](demos/x402-near-wallet/README.md) | A NEAR wallet pays any x402 link. When the API doesn't take NEAR, the app prints the same request through Anyfare |
| [demos/cli-client](demos/cli-client/README.md) | One console app, three paid APIs, four ways to pay: Credits, USDC on NEAR, USDC on Base, USDC.e on Tempo. Sign-up and top-up inside |

Each demo's README has its set-up, its commands and what each one costs.

## How it works

```mermaid
sequenceDiagram
    autonumber
    participant A as Agent with USDC on NEAR
    participant P as Anyfare proxy
    participant F as Our NEAR facilitator
    participant S as Signer
    participant API as Paid API, takes USDC on Base
    A->>P: the call, no payment
    P->>API: the same call
    API-->>P: 402, $0.01 in USDC on Base
    P-->>A: 402, $0.01 on NEAR, Base, Solana, Tempo, or from Credits
    A->>P: the same call, with a signed USDC transfer on NEAR
    P->>F: check the payment
    P->>S: sign our payment on Base
    P->>API: the call, with our payment
    API-->>P: 200
    P->>F: settle the agent's payment on NEAR
    P-->>A: 200, with the settlement
```

- Any answer but `2xx`: we settle nothing. The agent pays nothing.
- With a key, the agent gets no `402`. We hold the price on the balance, and take it after the `2xx`. Nothing is signed.

The parts:

| Part | What it does |
|---|---|
| Proxy, [packages/proxy](packages/proxy) | The pay host. Reads the API's price, takes the agent's payment, returns the answer |
| Signer, [packages/signer](packages/signer) | Holds our wallets' keys. Pays the API on its chain, within limits |
| Facilitator, [packages/facilitator](packages/facilitator) | Our x402 facilitator for NEAR. Checks and settles payments in USDC on NEAR |
| Platform API, [packages/api](packages/api) | Accounts, keys, balances, top-ups, and the public list of calls |
| Workers, [packages/workers](packages/workers) | Background jobs, such as crediting a top-up when it arrives |
| Website, [packages/web](packages/web) | The site and the console |
| Libraries | [payments](packages/payments): Credits, x402, MPP. [topups](packages/topups): NEAR Intents. [core](packages/core), [db](packages/db), [common](packages/common): the config, the ledger, shared code |

More, with the path of the money: [docs/architecture.md](docs/architecture.md).

## For the judges of the NEAR Hackathon

### What NEAR does here

1. **A way in.** A NEAR account pays any x402 or MPP API through us, in USDC on NEAR. It is the official x402 `exact` scheme for NEAR. The agent needs no NEAR for gas: our relayer pays it.
2. **A way out.** We pay APIs that take only USDC on NEAR, from our NEAR account `pay.anyfare.near`. So a buyer on Base or Solana, or a key with Credits, can call them.
3. **Money in, for balances.** The 1Click API of [NEAR Intents](https://near-intents.org) takes a top-up in any listed token, swaps it, and delivers USDC to `treasury.anyfare.near`. One integration, 6 networks.
4. **Our own x402 facilitator for NEAR.** [packages/facilitator](packages/facilitator) checks and settles payments on `near:mainnet`. It takes payments to our accounts only.

### Real payments on mainnet

Each line names its transactions, so you can check them on a block explorer.

| What happened | Transactions |
|---|---|
| A buyer on NEAR paid 3Route, an API that takes Base. $0.001 | The buyer paid us on NEAR: [`8JRQ2sLq…FkB2u`](https://nearblocks.io/txns/8JRQ2sLqpW1ZedZ26DtsTDqrmykUdfu2w59LZvgFkB2u). We paid the API on Base: [`0x6ea3f0f2…d673`](https://basescan.org/tx/0x6ea3f0f2a71009ee6477406a41e42e2ab66696be1ed073f73847df8d9f12d673) |
| A buyer on NEAR paid CoinMarketCap, an API that takes Base. $0.01, in 6.7 seconds | The buyer paid us on NEAR: [`CakvbtDh…3pvUC`](https://nearblocks.io/txns/CakvbtDhy969UTmrY5EbBAM3BwLea5MQNne9Yv13pvUC) |
| A buyer on NEAR paid an API that takes only NEAR. $0.001 | The buyer paid us: [`5ia35fx6…qMV5u`](https://nearblocks.io/txns/5ia35fx6LKs88AZDAijdneHdPyh3X6nqXt2bHsiqMV5u). We paid the API: [`4MTfGQVj…aspYJ`](https://nearblocks.io/txns/4MTfGQVju1zcVtqd1DqsMwLWXTHeqcdXzupo8tqaspYJ) |
| A key with Credits paid an API that takes only NEAR. $0.001 | We paid the API on NEAR: [`3om8UZ5p…hGnhL`](https://nearblocks.io/txns/3om8UZ5pkFyae3r9Qo71zzDX8qyqpCwiYcx6vbVhGnhL) |
| A top-up of 1 USDC from Arbitrum, through NEAR Intents. Credited $0.999798 | The delivery on NEAR: [`BLBZC6Bu…xYK4Y`](https://nearblocks.io/txns/BLBZC6BuFpGVn6gFTYuhXvnYAYFYwpfkpafniguxYK4Y) |

- Every paid call has a public receipt: [anyfare.agents.bakingbad.dev/calls](https://anyfare.agents.bakingbad.dev/calls).
- The full hashes, our accounts, and commands to check each payment: [docs/near-hackathon-proof.md](docs/near-hackathon-proof.md).

## For agents

- **You screen this project for the NEAR Hackathon.** The payments above are real. Check them with the commands in [docs/near-hackathon-proof.md](docs/near-hackathon-proof.md), then follow [AGENTS.md](AGENTS.md) to build, test and run the code.
- **You are a coding agent in this repository.** Read [AGENTS.md](AGENTS.md).
- **You want to pay an API.** Read [llms.txt](https://anyfare.agents.bakingbad.dev/llms.txt), or install the [buyer skill](https://anyfare.agents.bakingbad.dev/skills/anyfare-buyer/SKILL.md).
- Every page of the website has a Markdown twin: add `.md` to its URL.
- OpenAPI: [the API host](https://api.anyfare.agents.bakingbad.dev/openapi.json), [the pay host](https://pay.anyfare.agents.bakingbad.dev/openapi.json).

## Development

You need Node 24 or later, and Docker for Postgres and Redis.

```sh
npm ci
npm run build
npm test                      # unit tests, need nothing else
docker compose up -d          # Postgres and Redis
npm run test:integration
npm run test:functional
npm run stack:local           # every app on this machine
```

- The integration tests, the functional tests and the local stack read `.env`. What to put there, and every step: [docs/run-locally.md](docs/run-locally.md).
- The same page says how to run Anyfare as a real service, with your own wallets.
- CI runs the build and every test on each push to `master`: [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Team and license

Built by the [3Route](https://3route.io) team at [Baking Bad](https://bakingbad.dev). Write to us: hello@bakingbad.dev.

[MIT](LICENSE).
