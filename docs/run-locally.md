# Run it locally

**What this is.** How to run Anyfare on your machine, in two ways, and how to run its tests.

**For whom.** A developer or a coding agent with a fresh checkout.

| Way | What it is | Money |
|---|---|---|
| [Test mode](#test-mode) | Every app, with test doubles in place of the chains, the facilitators and NEAR Intents | None. No keys, no accounts |
| [As a real service](#as-a-real-service) | The same apps with your own wallets, on mainnet. This is how the hosted demo runs | Real money |

We ran every test-mode command on a fresh checkout, on macOS with Node 24 and Docker.

## What you need

- Node 24 or later, with npm.
- Docker, for Postgres and Redis.
- `curl` and `jq`, for the examples.

## Test mode

### 1. Install and build

```sh
npm ci
npm run build
```

It took about 10 seconds here.

### 2. Start Postgres and Redis

```sh
docker compose up -d
```

- It starts Postgres 18 on port 5432, Redis 8 on 6379, and the Signer's own Redis on 6381. All on `127.0.0.1`.
- A port is taken? Set `POSTGRES__PORT`, `REDIS__PORT` or `SIGNER_REDIS__PORT` first, and use the same port in `.env` below.
- The data is kept in `.tmp/`, which git ignores.

### 3. Write `.env`

```sh
cat > .env <<'EOF'
DATABASE_URL=postgres://anyfare:anyfare@127.0.0.1:5432/anyfare
REDIS_URL=redis://:anyfare@127.0.0.1:6379
TEST_DATABASE_URL=postgres://anyfare:anyfare@127.0.0.1:5432/anyfare
TEST_REDIS_URL=redis://:anyfare@127.0.0.1:6379
EOF
```

- These are the defaults of `docker-compose.yml`. They are local values, not secrets.
- Every other variable is in [.env.example](../.env.example). The local stack needs none of them.

### 4. Start the local stack

```sh
npm run stack:local -- --scratch
```

- It starts the Platform API, the proxy, the Signer and the workers, and the fakes.
- It prints every address and a list of commands. Wait for `The local stack is running.`
- `--scratch` makes a new empty database and drops it when the stack stops. Without it, the stack uses the `anyfare` database and keeps what you did.
- Stop it with Ctrl-C.
- The tool refuses a database that is not on this machine, and a production config.

| What | Address |
|---|---|
| The pay host (the proxy) | `http://localhost:8180` |
| The Platform API | `http://localhost:8181` |
| The fake paid API | `https://fake-api.test:8186`. Only the proxy knows this name |
| The fake facilitator | `http://127.0.0.1:8185` |
| The fake 1Click | `http://127.0.0.1:8187` |
| The fake NEAR node, the fake Tempo node | `http://127.0.0.1:8188`, `http://127.0.0.1:8189` |

The fake paid API has these paths:

| Path | What it asks |
|---|---|
| `/base` | x402 on Base, $0.001 |
| `/near` | x402 on NEAR, $0.001 |
| `/tempo` | MPP on Tempo, $0.001 |
| `/free` | Nothing. It answers `200` |
| `/unpayable` | x402 on a network we don't pay |
| `/post-only` | x402 on Base, $0.001, only on POST |

### 5. Make a paid call

In a second shell:

```sh
# An account. Locally a new account gets $0.50 of free Credits
MASTER=$(curl -s -X POST http://localhost:8181/v1/accounts | jq -r .masterKey)

# A payment key
KEY=$(curl -s -X POST http://localhost:8181/v1/keys -H "Authorization: Bearer $MASTER" | jq -r .key)

# Is the link payable, and at what price? Free
curl -s 'http://localhost:8180/_/check?url=https://fake-api.test:8186/base'

# The paid call
curl -i http://localhost:8180/fake-api.test:8186/base -H "Authorization: Bearer $KEY"

# A second later: the call in the public list, and the balance
curl -s 'http://localhost:8181/v1/calls?size=1'
curl -s http://localhost:8181/v1/balance -H "Authorization: Bearer $MASTER"
```

You see:

- The check: `"payable":true`, the price `0.001`, and our quote `0.0011`. The local config adds a 10% fee so that a fee shows. The hosted demo's fee is 0.
- The call: `HTTP/1.1 200`, the header `anyfare-receipt: id="pay_…", amount="0.0011", currency="USD"`, and the fake API's answer.
- The list: one call, `"status":"paid"`, `"paidWith":"credits"`, `"apiPaidWith":"base"`.
- The balance: `{"available":"0.4989","held":"0"}`. That is $0.50 less $0.0011.

The same call to an API on NEAR and on Tempo:

```sh
curl -s http://localhost:8180/fake-api.test:8186/near -H "Authorization: Bearer $KEY"
curl -s http://localhost:8180/fake-api.test:8186/tempo -H "Authorization: Bearer $KEY"
```

The `402` an agent with a wallet sees, with every way to pay:

```sh
curl -s http://localhost:8180/fake-api.test:8186/base | jq .
```

### 6. A top-up, moved by hand

The fake 1Click has a control: you move a swap to a status yourself.

```sh
curl -s -X POST http://localhost:8181/v1/topups -H "Authorization: Bearer $MASTER" \
  -H 'content-type: application/json' -d '{"network":"base","token":"USDC","amount":"1"}'

# The quotes the fake made, newest last. Take the last deposit address
ADDRESS=$(curl -s http://127.0.0.1:8187/_test/quotes | jq -r '.[-1].depositAddress')

# Finish the swap
curl -s -X POST http://127.0.0.1:8187/_test/status -H 'content-type: application/json' \
  -d "{\"depositAddress\":\"$ADDRESS\",\"status\":\"SUCCESS\"}"

# 10 to 20 seconds later the balance has grown by about $0.999
curl -s http://localhost:8181/v1/balance -H "Authorization: Bearer $MASTER"
```

### 7. The website, against the stack

The stack prints these commands with its own addresses. From the repository root, in another shell:

```sh
export SITE_URL=http://localhost:3000 CONSOLE_URL=http://127.0.0.1:3000 API_URL=http://localhost:8181 PAY_URL=http://localhost:8180
npm run build -w @anyfare/web
cp -R packages/web/.next/static packages/web/.next/standalone/packages/web/.next/
PORT=3000 HOSTNAME=127.0.0.1 node packages/web/.next/standalone/packages/web/server.js
```

- The public site is `http://localhost:3000`. The console is `http://127.0.0.1:3000`: the same server under another name.
- The build took 5 seconds here. We opened the public pages this way.
- To see pages with data, fill the database: `npm run seed:local`. It writes a month of made-up calls. `npm run seed:local -- --empty` takes them away. Use the stack without `--scratch` for this.

## Tests

| Command | What runs | Tests | Time here |
|---|---|---|---|
| `npm test` | Unit tests. Need nothing | About 2,000 | 13 seconds |
| `npm run test:integration` | Each package against Postgres and Redis | About 700 | 2 minutes 40 seconds |
| `npm run test:functional` | Whole apps against fakes | About 1,100 | 2 minutes 30 seconds |
| `npm run test:all` | All three | — | — |

- Integration and functional tests need steps 2 and 3.
- Each test file makes its own database and drops it. Your `anyfare` database is not touched.
- No test uses the network.
- **A test can time out on a busy machine.** The limit is 5 seconds a test. On our loaded laptop, 2 to 4 tests of the integration and functional runs timed out in each run. Every one passed when its file ran again alone: `npx vitest run <path to the test file>`. CI runs them on Linux with no such failure.
- The demo apps have their own offline tests: `npm test` inside `demos/cli-client` and `demos/x402-near-wallet`.

## As a real service

The apps are the same. What changes is the platform config and the keys. Start from test mode's steps 1 and 2: install, build, Postgres and Redis.

**This moves real money. Start with small amounts.** The hosted demo runs this way, in containers.

### 1. Wallets and accounts

| What | Why |
|---|---|
| A NEAR account as the hot wallet, registered on the USDC contract, with some USDC | Buyers on NEAR pay it. APIs on NEAR are paid from it |
| A NEAR account as the relayer, with a little NEAR | It submits buyers' payments on NEAR and pays their gas |
| A NEAR account as the treasury, registered on the USDC contract | Top-ups are delivered to it |
| A wallet on Base, on Solana and on Tempo, each with some USDC | Buyers on that chain pay it. APIs on that chain are paid from it |
| Keys of the Coinbase CDP facilitator | It checks and settles payments on Base and Solana |

A chain you leave out is not offered to buyers and is not paid on. To start with NEAR alone, remove the other assets and the `cdp` facilitator from the config.

### 2. The platform config

Copy [config/production.yaml](../config/production.yaml) to a file of your own, such as `config/my.yaml`, and change:

- `urls`: your own HTTPS hosts for the website, the API, the pay host and the console.
- `assets`: each `payTo` is your wallet on that chain. Remove an asset you don't take.
- `signer.wallets`: the same wallets. `signer.maxPerCall` and the two per-network limits: what one call and one day may cost you.
- `mpp.recipient`: your Tempo wallet.
- `topups.recipient` and `topups.refundTo`: your treasury account.
- `facilitators`: the `near` one points at your own facilitator, `http://127.0.0.1:8084` on one machine.
- `freeCredits`: turn it off, or set what you are ready to give away.

Every setting is explained in [config/example.yaml](../config/example.yaml).

### 3. The environment

Copy [.env.example](../.env.example) to `.env`. It explains every variable. The ones a real run needs:

| Variable | What it is |
|---|---|
| `CONFIG_PATH` | Your config file |
| `DATABASE_URL`, `REDIS_URL` | Postgres and Redis |
| `INTERNAL_API_SECRET`, `SIGNER_SECRET`, `FACILITATOR_SECRET`, `MPP_SECRET_KEY` | Shared secrets between the apps. At least 32 characters each. Make them with `openssl rand -hex 32` |
| `SIGNER_NEAR_ACCOUNT`, `SIGNER_NEAR_KEY` | The NEAR hot wallet and its full-access key |
| `SIGNER_BASE_KEY`, `SIGNER_TEMPO_KEY`, `SIGNER_SOLANA_KEY` | The keys of the other hot wallets |
| `FACILITATOR_NEAR_ACCOUNT`, `FACILITATOR_NEAR_KEY` | The relayer and its key |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | The CDP facilitator's key |
| `SIGNER_URL`, `INTERNAL_API_URL` | Where the proxy finds the Signer and the internal API |
| `NEAR_RPC_URLS`, `SOLANA_RPC_URL`, `EVM_RPC_URLS` | Your RPCs. Optional: public ones are the default |

- `.env` is ignored by git. Never commit a key.
- No treasury key goes anywhere: no app needs it.

### 4. Start the apps

Each app is one Node process. Run each in its own shell, or as a service.

```sh
npm run db:migrate
node --env-file=.env packages/api/dist/main.js           # the Platform API, port 8081, internal 8082
node --env-file=.env packages/facilitator/dist/main.js   # the NEAR facilitator, port 8084
REDIS_URL=redis://:anyfare@127.0.0.1:6381 \
  node --env-file=.env packages/signer/dist/main.js      # the Signer, port 8083, with its own Redis
node --env-file=.env packages/proxy/dist/main.js         # the pay host, port 8080
node --env-file=.env packages/workers/dist/main.js       # the background jobs
```

- Put a reverse proxy with HTTPS in front of ports 8080 and 8081. Never expose 8082, 8083 or 8084.
- The website: `docker compose --profile web up --build web`, with `SITE_URL`, `CONSOLE_URL`, `API_URL` and `PAY_URL` set to your hosts.
- In containers: the [Dockerfile](../Dockerfile) builds one image for every app. Each service runs `node packages/<app>/dist/main.js`. Migrations run first, as `node packages/db/dist/migrate.js`.

### 5. Check it

```sh
curl -s http://127.0.0.1:8080/_/ready
curl -s "http://127.0.0.1:8080/_/check?url=pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest"
```

You see `"status":"ready"`, then `"payable":true` with the networks you set up. From here it works as the hosted demo does: the README's "Try it" steps, with your hosts.

## Clean up

```sh
docker compose down
rm -rf .tmp
```
