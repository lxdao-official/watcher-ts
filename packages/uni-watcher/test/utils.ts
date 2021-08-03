import { ethers, utils, Contract, Signer, BigNumber, ContractTransaction } from 'ethers';
import { expect } from 'chai';
import 'mocha';

import { Client as UniClient } from '@vulcanize/uni-watcher';

// https://github.com/ethers-io/ethers.js/issues/195
export function linkLibraries (
  {
    bytecode,
    linkReferences
  }: {
    bytecode: string
    linkReferences: { [fileName: string]: { [contractName: string]: { length: number; start: number }[] } }
  },
  libraries: { [libraryName: string]: string }): string {
  Object.keys(linkReferences).forEach((fileName) => {
    Object.keys(linkReferences[fileName]).forEach((contractName) => {
      if (!libraries.hasOwnProperty(contractName)) {
        throw new Error(`Missing link library name ${contractName}`);
      }
      const address = utils.getAddress(libraries[contractName]).toLowerCase().slice(2);
      linkReferences[fileName][contractName].forEach(({ start: byteStart, length: byteLength }) => {
        const start = 2 + byteStart * 2;
        const length = byteLength * 2;
        bytecode = bytecode
          .slice(0, start)
          .concat(address)
          .concat(bytecode.slice(start + length, bytecode.length));
      });
    });
  });
  return bytecode;
}

export async function testCreatePool (
  uniClient: UniClient,
  factory: Contract,
  token0Address: string,
  token1Address: string,
  fee: number,
  poolAbi: any,
  signer: Signer): Promise<Contract> {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        const subscription = await uniClient.watchEvents((value: any) => {
          // Function gets called with previous events. Check for PoolCreatedEvent.
          if (value.event.__typename === 'PoolCreatedEvent') {
            const expectedContract: string = factory.address;
            const poolAddress = checkPoolCreatedEvent(value, expectedContract, token0Address, token1Address, fee);

            const pool = new ethers.Contract(poolAddress, poolAbi, signer);

            if (subscription) {
              subscription.unsubscribe();
            }
            resolve(pool);
          }
        });

        // Create pool.
        const transaction: ContractTransaction = await factory.createPool(token0Address, token1Address, fee);
        await transaction.wait();
      } catch (error) {
        reject(error);
      }
    })();
  });
}

export function testInitialize (
  uniClient: UniClient,
  pool: Contract,
  sqrtPrice: string,
  tick: number): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      (async () => {
        // Subscribe using UniClient.
        const subscription = await uniClient.watchEvents((value: any) => {
          // Function gets called with previous events. Check for InitializeEvent.
          if (value.event.__typename === 'InitializeEvent') {
            const expectedContract: string = pool.address;
            checkInitializeEvent(value, expectedContract, sqrtPrice, tick);

            if (subscription) {
              subscription.unsubscribe();
            }
            resolve();
          }
        });

        // Pool initialize.
        const transaction: ContractTransaction = await pool.initialize(BigNumber.from(sqrtPrice));
        await transaction.wait();
      })();
    } catch (error) {
      reject(error);
    }
  });
}

function checkEventCommonValues (value: any, expectedContract: string) {
  expect(value.block).to.not.be.empty;
  expect(value.tx).to.not.be.empty;
  expect(value.contract).to.equal(expectedContract);
  expect(value.eventIndex).to.be.a('number');

  expect(value.proof).to.not.be.empty;
}

export function checkPoolCreatedEvent (
  value: any,
  expectedContract: string,
  token0Address: string,
  token1Address: string,
  fee: number): string {
  checkEventCommonValues(value, expectedContract);

  expect(value.event.__typename).to.equal('PoolCreatedEvent');
  const tokens = new Set([token0Address, token1Address]);
  expect(new Set([value.event.token0, value.event.token1])).to.eql(tokens);
  expect(value.event.fee).to.equal(fee.toString());
  expect(value.event.tickSpacing).to.not.be.empty;
  expect(value.event.pool).to.not.be.empty;

  return value.event.pool;
}

export function checkInitializeEvent (
  value: any,
  expectedContract: string,
  sqrtPrice: string,
  tick: number): void {
  checkEventCommonValues(value, expectedContract);

  expect(value.event.__typename).to.equal('InitializeEvent');
  expect(value.event.sqrtPriceX96).to.equal(sqrtPrice);
  expect(value.event.tick).to.equal(tick.toString());
}

export function checkMintEvent (
  value: any,
  expectedContract: string,
  expectedSender: string,
  exptectedOwner: string,
  tickLower: number,
  tickUpper: number,
  amount: number): void {
  checkEventCommonValues(value, expectedContract);

  expect(value.event.__typename).to.equal('MintEvent');
  expect(value.event.sender).to.equal(expectedSender);
  expect(value.event.owner).to.equal(exptectedOwner);
  expect(value.event.tickLower).to.equal(tickLower.toString());
  expect(value.event.tickUpper).to.equal(tickUpper.toString());
  expect(value.event.amount).to.equal(amount.toString());
  expect(value.event.amount0).to.not.be.empty;
  expect(value.event.amount1).to.not.be.empty;
}

export function checkBurnEvent (
  value: any,
  expectedContract: string,
  exptectedOwner: string,
  tickLower: number,
  tickUpper: number,
  amount: number): void {
  checkEventCommonValues(value, expectedContract);

  expect(value.event.__typename).to.equal('BurnEvent');
  expect(value.event.owner).to.equal(exptectedOwner);
  expect(value.event.tickLower).to.equal(tickLower.toString());
  expect(value.event.tickUpper).to.equal(tickUpper.toString());
  expect(value.event.amount).to.equal(amount.toString());
  expect(value.event.amount0).to.not.be.empty;
  expect(value.event.amount1).to.not.be.empty;
}

export function checkSwapEvent (
  value: any,
  expectedContract: string,
  expectedSender: string,
  recipient: string,
  sqrtPrice: string,
  tick: number
): void {
  checkEventCommonValues(value, expectedContract);

  expect(value.event.__typename).to.equal('SwapEvent');
  expect(value.event.sender).to.equal(expectedSender);
  expect(value.event.recipient).to.equal(recipient);
  expect(value.event.amount0).to.not.be.empty;
  expect(value.event.amount1).to.not.be.empty;
  expect(value.event.sqrtPriceX96).to.equal(sqrtPrice);
  expect(value.event.liquidity).to.not.be.empty;
  expect(value.event.tick).to.equal(tick.toString());
}

export function checkTransferEvent (
  value: any,
  expectedContract: string,
  from: string,
  recipient: string
): void {
  checkEventCommonValues(value, expectedContract);

  expect(value.event.__typename).to.equal('TransferEvent');
  expect(value.event.from).to.equal(from);
  expect(value.event.to).to.equal(recipient);
  expect(value.event.tokenId).to.equal('1');
}

export function checkIncreaseLiquidityEvent (
  value: any,
  expectedContract: string,
  amount1Desired: number
): void {
  checkEventCommonValues(value, expectedContract);

  expect(value.event.tokenId).to.equal('1');
  expect(value.event.liquidity).to.equal(amount1Desired.toString());
  expect(value.event.amount0).to.equal(amount1Desired.toString());
  expect(value.event.amount1).to.equal(amount1Desired.toString());
}

export function checkDecreaseLiquidityEvent (
  value: any,
  expectedContract: string,
  liquidity: number
): void {
  checkEventCommonValues(value, expectedContract);

  expect(value.event.__typename).to.equal('DecreaseLiquidityEvent');
  expect(value.event.tokenId).to.equal('1');
  expect(value.event.liquidity).to.equal(liquidity.toString());
  expect(value.event.amount0).to.not.be.empty;
  expect(value.event.amount1).to.not.be.empty;
}

export function checksCollectEvent (
  value: any,
  expectedContract: string,
  recipient: string
): void {
  checkEventCommonValues(value, expectedContract);

  expect(value.event.__typename).to.equal('CollectEvent');
  expect(value.event.tokenId).to.equal('1');
  expect(value.event.recipient).to.equal(recipient);
  expect(value.event.amount0).to.not.be.empty;
  expect(value.event.amount1).to.not.be.empty;
}