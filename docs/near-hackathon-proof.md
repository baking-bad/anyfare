# Proof for the judges of the NEAR Hackathon

**What this is.** Real payments made through Anyfare on mainnet, with their transactions, and how to check each one yourself.

**For whom.** The judges of the NEAR Hackathon and their agents. Anyone who wants proof, not a claim.

We read each transaction below from a public explorer or RPC, and each was successful. Amounts are small on purpose.

## Our accounts

| Account | Chain | What it is |
|---|---|---|
| `pay.anyfare.near` | NEAR | Our hot wallet. Buyers on NEAR pay it. We pay NEAR APIs from it |
| `relay.anyfare.near` | NEAR | The relayer of our facilitator. It submits a buyer's signed payment and pays the gas |
| `treasury.anyfare.near` | NEAR | Top-ups are delivered here |
| `0xf82B4B95a063CFd5F56B3395978d02278E583550` | Base, Tempo | Our hot wallet on Base and Tempo |
| `AzG7Gmu8t6r54JbdAxZBNHNvCzbf5QDZcdKe7Aho78Xj` | Solana | Our hot wallet on Solana |

They are in [config/production.yaml](../config/production.yaml).

## The payments

### 1. A buyer on NEAR paid an API on Base. Both transactions

- **When.** 2026-11-10, 23:54:50 UTC.
- **The API.** 3Route, `api.3route.io`. It asked $0.001 in USDC on Base. 3Route is our own API.
- **The buyer paid** 0.001 USDC on NEAR to `pay.anyfare.near`. Transaction [`8JRQ2sLqpW1ZedZ26DtsTDqrmykUdfu2w59LZvgFkB2u`](https://nearblocks.io/txns/8JRQ2sLqpW1ZedZ26DtsTDqrmykUdfu2w59LZvgFkB2u), submitted by `relay.anyfare.near`.
- **We paid the API** 0.001 USDC on Base, from `0xf82B…3550` to `0x5D89…07Eb`. Transaction [`0x6ea3f0f2a71009ee6477406a41e42e2ab66696be1ed073f73847df8d9f12d673`](https://basescan.org/tx/0x6ea3f0f2a71009ee6477406a41e42e2ab66696be1ed073f73847df8d9f12d673), block 55822580.
- **Receipt.** [`pay_675d67f6-63f4-430a-bea2-a3af70c901b6`](https://anyfare.agents.bakingbad.dev/calls/pay_675d67f6-63f4-430a-bea2-a3af70c901b6)

### 2. A buyer on NEAR paid CoinMarketCap, which takes Base

- **When.** 2026-11-12, 18:20:02 UTC.
- **The API.** `pro-api.coinmarketcap.com`. It asked $0.01 in USDC on Base.
- **The buyer paid** 0.01 USDC on NEAR. Transaction [`CakvbtDhy969UTmrY5EbBAM3BwLea5MQNne9Yv13pvUC`](https://nearblocks.io/txns/CakvbtDhy969UTmrY5EbBAM3BwLea5MQNne9Yv13pvUC).
- **Time.** 6.7 seconds end to end. The API took 1.2 seconds of it. The settlement on NEAR took 5.1 seconds. One call, not an average.
- **We paid the API** on Base. That transaction is not on the receipt.
- **Receipt.** [`pay_a8d9b92d-a9e6-4b5a-af18-1ed38dae0d2f`](https://anyfare.agents.bakingbad.dev/calls/pay_a8d9b92d-a9e6-4b5a-af18-1ed38dae0d2f)

### 3. A buyer on NEAR paid an API that takes only NEAR

- **When.** 2026-11-11, 23:44:28 UTC.
- **The API.** The evidence API, `merchant-near.mikedotexe.com`. It asked 0.001 USDC on NEAR. It is not ours.
- **The buyer paid** 0.001 USDC to `pay.anyfare.near`. Transaction [`5ia35fx6LKs88AZDAijdneHdPyh3X6nqXt2bHsiqMV5u`](https://nearblocks.io/txns/5ia35fx6LKs88AZDAijdneHdPyh3X6nqXt2bHsiqMV5u).
- **We paid the API** 0.001 USDC from `pay.anyfare.near` to `count.mike.near`. Transaction [`4MTfGQVju1zcVtqd1DqsMwLWXTHeqcdXzupo8tqaspYJ`](https://nearblocks.io/txns/4MTfGQVju1zcVtqd1DqsMwLWXTHeqcdXzupo8tqaspYJ).
- **Receipt.** [`pay_630189b7-8eb1-42ae-adf1-61b546524f0b`](https://anyfare.agents.bakingbad.dev/calls/pay_630189b7-8eb1-42ae-adf1-61b546524f0b)

### 4. A key with Credits paid an API that takes only NEAR

- **When.** 2026-11-12, 18:23:23 UTC.
- **The buyer paid** $0.001 of Credits, with a payment key. Nothing on chain.
- **We paid the API** 0.001 USDC from `pay.anyfare.near` to `count.mike.near`. Transaction [`3om8UZ5pkFyae3r9Qo71zzDX8qyqpCwiYcx6vbVhGnhL`](https://nearblocks.io/txns/3om8UZ5pkFyae3r9Qo71zzDX8qyqpCwiYcx6vbVhGnhL).
- **Time.** 15.5 seconds. The API itself took 15.2 of them.
- **Receipt.** [`pay_bf125b6d-63af-407a-9409-c02ed2237c9a`](https://anyfare.agents.bakingbad.dev/calls/pay_bf125b6d-63af-407a-9409-c02ed2237c9a)

### 5. A top-up through NEAR Intents

- **When.** 2026-11-09, 22:12 UTC.
- **Sent.** 1 USDC on Arbitrum, to a deposit address from the 1Click API.
- **Delivered.** USDC on NEAR, to `treasury.anyfare.near`. Transaction [`BLBZC6BuFpGVn6gFTYuhXvnYAYFYwpfkpafniguxYK4Y`](https://nearblocks.io/txns/BLBZC6BuFpGVn6gFTYuhXvnYAYFYwpfkpafniguxYK4Y).
- **Credited.** $0.999798. The swap cost $0.000202.

## The totals

They change with every call, so they are not copied here. Read them live:

- The numbers: `GET https://api.anyfare.agents.bakingbad.dev/v1/stats`, or the website's home page.
- Every call: `GET https://api.anyfare.agents.bakingbad.dev/v1/calls`, or [the Calls page](https://anyfare.agents.bakingbad.dev/calls).

Most of the first calls are our own tests. We don't claim users.

## Check it yourself

All free. No account. The examples use `curl` and `jq`.

```sh
# A NEAR transaction: who sent it, and whether it succeeded
curl -s https://api.nearblocks.io/v1/txns/8JRQ2sLqpW1ZedZ26DtsTDqrmykUdfu2w59LZvgFkB2u \
  | jq '.txns[0] | {signer_account_id, receiver_account_id, ok: .outcomes.status}'

# The Base transaction of the same call: status 0x1 is success
curl -s -X POST https://mainnet.base.org -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0x6ea3f0f2a71009ee6477406a41e42e2ab66696be1ed073f73847df8d9f12d673"]}' \
  | jq '.result | {status, to}'

# The receipt of that call, with both transactions
curl -s https://api.anyfare.agents.bakingbad.dev/v1/calls/pay_675d67f6-63f4-430a-bea2-a3af70c901b6 \
  | jq '{status, buyer: .buyer.transaction, api: .api.transaction}'

# Every call, newest first
curl -s "https://api.anyfare.agents.bakingbad.dev/v1/calls?size=20"

# Our NEAR wallet's USDC, from a public RPC
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"query","params":{
    "request_type":"call_function","finality":"final",
    "account_id":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "method_name":"ft_balance_of",
    "args_base64":"eyJhY2NvdW50X2lkIjoicGF5LmFueWZhcmUubmVhciJ9"}}'
```

- The last command answers `result.result`: the bytes of a number in quotes. It is in millionths of a USDC.
- `17208628…33a1` is the contract of native USDC on NEAR.
