import { Contract, ethers, Signer } from 'ethers';
import assert from 'assert';

import { Client as UniClient } from '@vulcanize/uni-watcher';
import {
  getConfig
} from '@vulcanize/util';
import {
  deployWETH9Token,
  deployNFPM
} from '@vulcanize/util/test';
import {
  abi as FACTORY_ABI,
  bytecode as FACTORY_BYTECODE
} from '@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json';

import { Database } from '../src/database';
import { watchContract } from '../src/utils/index';

const NETWORK_RPC_URL = 'http://localhost:8545';

const deployFactoryContract = async (db: Database, signer: Signer): Promise<Contract> => {
  // Deploy factory from uniswap package.
  const Factory = new ethers.ContractFactory(FACTORY_ABI, FACTORY_BYTECODE, signer);
  const factory = await Factory.deploy();
  assert(factory.address, 'Factory contract not deployed.');

  // Watch factory contract.
  await watchContract(db, factory.address, 'factory', 100);

  return factory;
};

const deployNFPMContract = async (db: Database, signer: Signer, factory: Contract): Promise<void> => {
  // Deploy weth9 token.
  const weth9Address = await deployWETH9Token(signer);
  assert(weth9Address, 'WETH9 token not deployed.');

  // Deploy NonfungiblePositionManager.
  const nfpm = await deployNFPM(signer, factory, weth9Address);
  assert(nfpm.address, 'NFPM contract not deployed.');

  // Watch NFPM contract.
  await watchContract(db, nfpm.address, 'nfpm', 100);
};

const main = async () => {
  // Get config.
  const configFile = './environments/local.toml';
  const config = await getConfig(configFile);

  const { database: dbConfig, server: { host, port } } = config;
  assert(dbConfig, 'Missing dbConfig.');
  assert(host, 'Missing host.');
  assert(port, 'Missing port.');

  // Initialize uniClient.
  const endpoint = `http://${host}:${port}/graphql`;
  const gqlEndpoint = endpoint;
  const gqlSubscriptionEndpoint = endpoint;
  const uniClient = new UniClient({
    gqlEndpoint,
    gqlSubscriptionEndpoint
  });

  // Initialize database.
  const db = new Database(dbConfig);
  await db.init();

  const provider = new ethers.providers.JsonRpcProvider(NETWORK_RPC_URL);
  const signer = provider.getSigner();

  let factory: Contract;
  // Checking whether factory is deployed.
  const factoryContract = await uniClient.getContract('factory');
  if (factoryContract == null) {
    factory = await deployFactoryContract(db, signer);
  } else {
    factory = new Contract(factoryContract.address, FACTORY_ABI, signer);
  }

  // Checking whether NFPM is deployed.
  const nfpmContract = await uniClient.getContract('nfpm');
  if (nfpmContract == null) {
    await deployNFPMContract(db, signer, factory);
  }

  // Closing the database.
  await db.close();
};

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });