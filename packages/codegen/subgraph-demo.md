# Subgraph watcher demo

* The following core services need to be running for the demo:
  * [ipld-eth-db](https://github.com/cerc-io/ipld-eth-db)
    * Version: [v4.2.3-alpha](https://github.com/cerc-io/ipld-eth-db/releases/tag/v4.2.3-alpha)
  * [geth](https://github.com/cerc-io/go-ethereum)
    * State diffing service should use `ipld-eth-db` for database.
    * Version: [v1.10.26-statediff-4.2.2-alpha](https://github.com/cerc-io/go-ethereum/releases/tag/v1.10.26-statediff-4.2.2-alpha)
    * Endpoint: http://127.0.0.1:8545
  * [ipld-eth-server](https://github.com/cerc-io/ipld-eth-server)
    * Should use `ipld-eth-db` for database.
    * Version: [v4.2.3-alpha](https://github.com/cerc-io/ipld-eth-server/releases/tag/v4.2.3-alpha)
    * Endpoints:
      * GQL: http://127.0.0.1:8082/graphql
      * RPC: http://127.0.0.1:8081

* In watcher-ts [packages/graph-node](../graph-node/), deploy an `Example` contract:

  ```bash
  yarn example:deploy
  ```

* Set the returned address to the variable `$EXAMPLE_ADDRESS`:

  ```bash
  export EXAMPLE_ADDRESS=<EXAMPLE_ADDRESS>
  ```

* In [packages/graph-node/test/subgraph/example1/subgraph.yaml](../graph-node/test/subgraph/example1/subgraph.yaml), set the source address for `Example1` datasource to the `EXAMPLE_ADDRESS`. Then in [packages/graph-node](../graph-node/) run:

  ```bash
  yarn build:example
  ```

* In [packages/codegen](./), create a `config.yaml` file:

  ```yaml
  # Example config.yaml
  # Contracts to watch (required).
  # Can pass empty array ([]) when using subgraphPath.
  contracts:
      # Contract name.
    - name: Example
      # Contract file path or an url.
      path: ../graph-node/test/contracts/Example.sol
      # Contract kind (should match that in {subgraphPath}/subgraph.yaml if subgraphPath provided)
      kind: Example1

  # Output folder path (logs output using `stdout` if not provided).
  outputFolder: ../test-watcher

  # Code generation mode [eth_call | storage | all | none] (default: none).
  mode: none

  # Kind of watcher [lazy | active] (default: active).
  kind: active

  # Watcher server port (default: 3008).
  port: 3008

  # Flatten the input contract file(s) [true | false] (default: true).
  flatten: true

  # Path to the subgraph build (optional).
  # Can set empty contracts array when using subgraphPath.
  subgraphPath: ../graph-node/test/subgraph/example1/build
  ```

* Run codegen to generate watcher:

  ```bash
  yarn codegen --config-file ./config.yaml
  ```

  The watcher should be generated in `packages/test-watcher`

* Create a postgres12 database for the watcher:

  ```bash
  sudo su - postgres

  # If database already exists
  # dropdb test-watcher

  createdb test-watcher
  ```

* Create database for the job queue and enable the `pgcrypto` extension on them (https://github.com/timgit/pg-boss/blob/master/docs/usage.md#intro):

  ```bash
  # If database already exists
  # dropdb test-watcher-job-queue

  createdb test-watcher-job-queue
  ```

  ```
  postgres@tesla:~$ psql -U postgres -h localhost test-watcher-job-queue
  Password for user postgres:
  psql (12.7 (Ubuntu 12.7-1.pgdg18.04+1))
  SSL connection (protocol: TLSv1.3, cipher: TLS_AES_256_GCM_SHA384, bits: 256, compression: off)
  Type "help" for help.

  test-watcher-job-queue=# CREATE EXTENSION pgcrypto;
  CREATE EXTENSION
  test-watcher-job-queue=# exit
  ```

* In `watcher-ts` repo, follow the instructions in [Setup](../../README.md#setup) for installing and building packages.

  ```bash
  # After setup
  yarn && yarn build
  ```

* In `packages/test-watcher`, run the job-runner:

  ```bash
  yarn job-runner
  ```

* Run the watcher:

  ```bash
  yarn server
  ```

## Operations

* Run the following GQL subscription at the [graphql endpoint](http://localhost:3008/graphql):

  ```graphql
  subscription {
    onEvent {
      event {
        __typename
        ... on TestEvent {
          param1
          param2
        },
      },
      block {
        number
        hash
      }
    }
  }
  ```

* In [packages/graph-node](../graph-node/), trigger the `Test` event by calling a example contract method:

  ```bash
  yarn example:test --address $EXAMPLE_ADDRESS
  ```

  * A `Test` event shall be visible in the subscription at endpoint.

  * The subgraph entity `Category` should be updated in the database.

  * An auto-generated `diff-staged` entry `State` should be added.

* Run the query for entity in at the endpoint:

  ```graphql
  query {
    category(
      block: { hash: "EVENT_BLOCK_HASH" },
      id: "1"
    ) {
      __typename
      id
      count
      name
    }
  }
  ```

* Run the `getState` query at the endpoint to get the latest `State` for `EXAMPLE_ADDRESS`:

  ```graphql
  query {
    getState (
      blockHash: "EVENT_BLOCK_HASH"
      contractAddress: "EXAMPLE_ADDRESS"
      # kind: "checkpoint"
      # kind: "diff"
      kind: "diff_staged"
    ) {
      cid
      block {
        cid
        hash
        number
        timestamp
        parentHash
      }
      contractAddress
      data
    }
  }
  ```

* `diff` states get created corresponding to the `diff_staged` states when their respective blocks reach the pruned region.

* In `packages/test-watcher`:

  * After the `diff` state has been created, create a `checkpoint`:

    ```bash
    yarn checkpoint create --address $EXAMPLE_ADDRESS
    ```

    * A `checkpoint` state should be created at the latest canonical block hash.

    * Run the `getState` query again at the endpoint with the output `blockHash` and kind `checkpoint`.
  
* All the `State` entries can be seen in `pg-admin` in table `state`.
