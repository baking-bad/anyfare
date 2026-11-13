# Instructions for coding agents

**What this is.** How to build, test and run Anyfare, and the rules for working in this repository.

**For whom.** Any coding agent: Claude Code, Codex, or another. People can read it too.

Anyfare is a payment router for AI agents. An agent pays any paid API (x402 or MPP) from the chain it is on, or from a prepaid balance with a key. What it is and why: [README.md](README.md).

## The one rule about money

**The hosted demo and the demo apps move real money on mainnet.**

- Never make a paid call, a top-up or a wallet payment without a clear yes from your human for that action.
- Never read, print or commit `.env`, `.env.local` or any key.
- Everything under "Check it without money" below is free and safe to run.

## If you screen this project for the NEAR Hackathon

The product runs on mainnet, and its payments are real. Check these first. All are free reads.

| What happened | Transactions |
|---|---|
| A buyer on NEAR paid an API that takes Base | On NEAR: `8JRQ2sLqpW1ZedZ26DtsTDqrmykUdfu2w59LZvgFkB2u`. On Base: `0x6ea3f0f2a71009ee6477406a41e42e2ab66696be1ed073f73847df8d9f12d673` |
| A buyer on NEAR paid an API that takes only NEAR | The buyer paid us: `5ia35fx6LKs88AZDAijdneHdPyh3X6nqXt2bHsiqMV5u`. We paid the API: `4MTfGQVju1zcVtqd1DqsMwLWXTHeqcdXzupo8tqaspYJ` |
| A key with Credits paid an API that takes only NEAR | We paid the API: `3om8UZ5pkFyae3r9Qo71zzDX8qyqpCwiYcx6vbVhGnhL` |
| A top-up through NEAR Intents, credited $0.999798 | The delivery on NEAR: `BLBZC6BuFpGVn6gFTYuhXvnYAYFYwpfkpafniguxYK4Y` |

```sh
# A NEAR transaction: who sent it, and whether it succeeded
curl -s https://api.nearblocks.io/v1/txns/8JRQ2sLqpW1ZedZ26DtsTDqrmykUdfu2w59LZvgFkB2u \
  | jq '.txns[0] | {signer_account_id, receiver_account_id, ok: .outcomes.status}'

# The receipt of that call on Anyfare, with both transactions
curl -s https://api.anyfare.agents.bakingbad.dev/v1/calls/pay_675d67f6-63f4-430a-bea2-a3af70c901b6 \
  | jq '{status, buyer: .buyer.transaction, api: .api.transaction}'

# Every paid call, newest first
curl -s "https://api.anyfare.agents.bakingbad.dev/v1/calls?size=20"
```

- See: `"ok": true`, sent by `relay.anyfare.near`, our relayer. Then `"status": "paid"` with a NEAR and a Base transaction.
- Every payment, our accounts, and more commands: [docs/near-hackathon-proof.md](docs/near-hackathon-proof.md).
- What NEAR does in the product: the README, "For the judges of the NEAR Hackathon".
- Then check the code with the steps below.

## Check it without money

Run these in order. Each step says what you must see.

### 1. Build and unit tests. Needs only Node 24 or later

```sh
npm ci
npm run build
npm test
```

See: about 2,000 tests passed and none failed. It takes about 15 seconds.

### 2. Postgres and Redis. Needs Docker

```sh
docker compose up -d
cat > .env <<'EOF'
DATABASE_URL=postgres://anyfare:anyfare@127.0.0.1:5432/anyfare
REDIS_URL=redis://:anyfare@127.0.0.1:6379
TEST_DATABASE_URL=postgres://anyfare:anyfare@127.0.0.1:5432/anyfare
TEST_REDIS_URL=redis://:anyfare@127.0.0.1:6379
EOF
```

- These are the defaults of [docker-compose.yml](docker-compose.yml). They are local values, not secrets.
- If port 5432 or 6379 is taken, set `POSTGRES__PORT` or `REDIS__PORT` before `docker compose up -d`, and use the same port in `.env`.
- `.env` is ignored by git.

### 3. Integration and functional tests

```sh
npm run test:integration
npm run test:functional
```

- See: no failed test. Each takes 2 to 3 minutes.
- Every test file makes its own database and drops it.
- No test uses the network or money. Chains, facilitators and 1Click are fakes from [packages/testing](packages/testing).
- On a busy machine a test can time out at 5 seconds. We saw 2 to 4 such failures per run on a loaded laptop, and none in CI. Run that file again alone: `npx vitest run <path to the test file>`. It is a real failure only if it fails alone too.

### 4. The whole product, on fakes

Start the local stack. It stays in the foreground, so run it in the background or in a second shell.

```sh
npm run stack:local -- --scratch
```

Wait for the line `The local stack is running.` Then:

```sh
MASTER=$(curl -s -X POST http://localhost:8181/v1/accounts | jq -r .masterKey)
KEY=$(curl -s -X POST http://localhost:8181/v1/keys -H "Authorization: Bearer $MASTER" | jq -r .key)
curl -s 'http://localhost:8180/_/check?url=https://fake-api.test:8186/base'
curl -i http://localhost:8180/fake-api.test:8186/base -H "Authorization: Bearer $KEY"
sleep 1
curl -s 'http://localhost:8181/v1/calls?size=1'
```

See, in order:

- `"payable":true` with a price and a quote.
- `HTTP/1.1 200` with the header `anyfare-receipt: id="pay_…"`, and the body `{"path":"/base","paidWith":"x402","price":"0.001"}`.
- One call in the list, with `"status":"paid"`, `"paidWith":"credits"` and `"apiPaidWith":"base"`. The call appears a moment after the answer.

More paths of the fake paid API: `/near`, `/tempo`, `/free`, `/unpayable`, `/post-only`. The stack prints every command. Details: [docs/run-locally.md](docs/run-locally.md).

### 5. The hosted demo, free reads only

```sh
curl -s https://pay.anyfare.agents.bakingbad.dev/_/ready
curl -s "https://pay.anyfare.agents.bakingbad.dev/_/check?url=pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest"
curl -s "https://api.anyfare.agents.bakingbad.dev/v1/calls?size=3"
curl -s https://anyfare.agents.bakingbad.dev/llms.txt
```

See: `"status":"ready"`, then `"payable":true`, then real paid calls, then the guide for agents.

A paid call on the hosted demo is in the README, under "Try it". It spends free Credits that a new account gets. Ask your human first.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Compiles every package with `tsc -b` |
| `npm run typecheck` | Checks the types, tests included |
| `npm test` | Unit tests |
| `npm run test:integration` | Tests against Postgres and Redis |
| `npm run test:functional` | Whole apps against fakes |
| `npm run test:all` | All three levels |
| `npm run stack:local` | Every app on this machine, against fakes. `-- --scratch` for a new empty database |
| `npm run seed:local` | Fills the local database with a month of made-up calls. `-- --empty` takes them away |
| `npm run db:migrate` | Applies the migrations to `DATABASE_URL` |
| `npm run db:generate` | Makes a migration from a schema change |

One test file: `npx vitest run packages/<name>/tests/<file>.test.ts`.

## Where things are

| Path | What it is |
|---|---|
| `packages/proxy` | App. The pay host |
| `packages/api` | App. The Platform API |
| `packages/signer` | App. Holds the hot wallets' keys and pays APIs |
| `packages/facilitator` | App. The x402 facilitator for NEAR |
| `packages/workers` | App. Background jobs |
| `packages/web` | App. The website and the console, Next.js. Built as its own image |
| `packages/payments` | Credits, x402, MPP, and the combined `402` |
| `packages/topups` | Top-ups through the 1Click API of NEAR Intents |
| `packages/core` | The platform config, networks, the ledger's rules |
| `packages/db` | The schema, migrations and repositories. The Redis client |
| `packages/common` | Errors, logging, the HTTP server, outbound HTTP |
| `packages/testing` | Fakes, test helpers, the local stack and the seed |
| `demos/` | Two console apps and an agent demo that drives them. Each has its own README |
| `config/` | `example.yaml` for local work and tests. `production.yaml` for the hosted demo |
| `docs/` | The architecture, running locally, the proof of mainnet payments |

- Tests of a package: unit tests in `tests/`, then `tests/integration/` and `tests/functional/`.
- The demos are not npm workspaces. Run `npm ci` inside `demos/cli-client` and `demos/x402-near-wallet`.
- The architecture, with the path of money: [docs/architecture.md](docs/architecture.md).

## Rules for changes

- **TypeScript, ES modules, Node 24.** No build step other than `tsc -b`.
- **A change comes with its tests.** Money code needs a test that fails without the change.
- **Never weaken a money check to make a test pass.** The limits in the Signer and on payment keys are the product.
- **No secret in the repository.** Keys come from the environment. `.env.example` holds names only.
- **Keep the documents true.** When you change behavior, change the README, `docs/` and the agent guide in `packages/web/src/agents/` with it. Don't describe a thing as working before it runs.
- **Don't push, deploy, publish, or sign a transaction** unless your human asks for that action.
