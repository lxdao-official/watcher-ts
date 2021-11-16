//
// Copyright 2021 Vulcanize, Inc.
//

import assert from 'assert';
import debug from 'debug';
import { DeepPartial } from 'typeorm';
import JSONbig from 'json-bigint';
import { ethers } from 'ethers';
import { sha256 } from 'multiformats/hashes/sha2';
import { CID } from 'multiformats/cid';
import _ from 'lodash';

import { JsonFragment } from '@ethersproject/abi';
import { BaseProvider } from '@ethersproject/providers';
import * as codec from '@ipld/dag-cbor';
import { EthClient } from '@vulcanize/ipld-eth-client';
import { StorageLayout } from '@vulcanize/solidity-mapper';
import { EventInterface, Indexer as BaseIndexer, IndexerInterface, UNKNOWN_EVENT_NAME, ServerConfig } from '@vulcanize/util';
import { GraphWatcher } from '@vulcanize/graph-node';

import { Database } from './database';
import { Contract } from './entity/Contract';
import { Event } from './entity/Event';
import { SyncStatus } from './entity/SyncStatus';
import { HookStatus } from './entity/HookStatus';
import { BlockProgress } from './entity/BlockProgress';
import { IPLDBlock } from './entity/IPLDBlock';
import artifacts from './artifacts/EdenNetwork.json';
import { createInitialCheckpoint, handleEvent, createStateDiff, createStateCheckpoint } from './hooks';
import { IPFSClient } from './ipfs';

const log = debug('vulcanize:indexer');

const TRANSFER_EVENT = 'Transfer';
const APPROVAL_EVENT = 'Approval';
const AUTHORIZATIONUSED_EVENT = 'AuthorizationUsed';
const ADMINUPDATED_EVENT = 'AdminUpdated';
const TAXRATEUPDATED_EVENT = 'TaxRateUpdated';
const SLOTCLAIMED_EVENT = 'SlotClaimed';
const SLOTDELEGATEUPDATED_EVENT = 'SlotDelegateUpdated';
const STAKE_EVENT = 'Stake';
const UNSTAKE_EVENT = 'Unstake';
const WITHDRAW_EVENT = 'Withdraw';
const APPROVALFORALL_EVENT = 'ApprovalForAll';
const BLOCKPRODUCERADDED_EVENT = 'BlockProducerAdded';
const BLOCKPRODUCERREMOVED_EVENT = 'BlockProducerRemoved';
const BLOCKPRODUCERREWARDCOLLECTORCHANGED_EVENT = 'BlockProducerRewardCollectorChanged';
const REWARDSCHEDULECHANGED_EVENT = 'RewardScheduleChanged';
const CLAIMED_EVENT = 'Claimed';
const SLASHED_EVENT = 'Slashed';
const MERKLEROOTUPDATED_EVENT = 'MerkleRootUpdated';
const ACCOUNTUPDATED_EVENT = 'AccountUpdated';
const PERMANENTURI_EVENT = 'PermanentURI';
const GOVERNANCECHANGED_EVENT = 'GovernanceChanged';
const UPDATETHRESHOLDCHANGED_EVENT = 'UpdateThresholdChanged';
const ROLEADMINCHANGED_EVENT = 'RoleAdminChanged';
const ROLEGRANTED_EVENT = 'RoleGranted';
const ROLEREVOKED_EVENT = 'RoleRevoked';

export type ResultEvent = {
  block: {
    cid: string;
    hash: string;
    number: number;
    timestamp: number;
    parentHash: string;
  };
  tx: {
    hash: string;
    from: string;
    to: string;
    index: number;
  };

  contract: string;

  eventIndex: number;
  eventSignature: string;
  event: any;

  proof: string;
};

export type ResultIPLDBlock = {
  block: {
    cid: string;
    hash: string;
    number: number;
    timestamp: number;
    parentHash: string;
  };
  contractAddress: string;
  cid: string;
  kind: string;
  data: string;
};

export class Indexer implements IndexerInterface {
  _db: Database
  _ethClient: EthClient
  _ethProvider: BaseProvider
  _postgraphileClient: EthClient
  _baseIndexer: BaseIndexer
  _serverConfig: ServerConfig
  _graphWatcher: GraphWatcher;

  _abi: JsonFragment[]
  _storageLayout: StorageLayout
  _contract: ethers.utils.Interface

  _ipfsClient: IPFSClient

  constructor (serverConfig: ServerConfig, db: Database, ethClient: EthClient, postgraphileClient: EthClient, ethProvider: BaseProvider, graphWatcher: GraphWatcher) {
    assert(db);
    assert(ethClient);
    assert(postgraphileClient);

    this._db = db;
    this._ethClient = ethClient;
    this._postgraphileClient = postgraphileClient;
    this._ethProvider = ethProvider;
    this._serverConfig = serverConfig;
    this._baseIndexer = new BaseIndexer(this._db, this._ethClient, this._postgraphileClient, this._ethProvider);
    this._graphWatcher = graphWatcher;

    const { abi, storageLayout } = artifacts;

    assert(abi);
    assert(storageLayout);

    this._abi = abi;
    this._storageLayout = storageLayout;

    this._contract = new ethers.utils.Interface(this._abi);

    this._ipfsClient = new IPFSClient(this._serverConfig.ipfsApiAddr);
  }

  getResultEvent (event: Event): ResultEvent {
    const block = event.block;
    const eventFields = JSONbig.parse(event.eventInfo);
    const { tx, eventSignature } = JSON.parse(event.extraInfo);

    return {
      block: {
        cid: block.cid,
        hash: block.blockHash,
        number: block.blockNumber,
        timestamp: block.blockTimestamp,
        parentHash: block.parentHash
      },

      tx: {
        hash: event.txHash,
        from: tx.src,
        to: tx.dst,
        index: tx.index
      },

      contract: event.contract,

      eventIndex: event.index,
      eventSignature,
      event: {
        __typename: `${event.eventName}Event`,
        ...eventFields
      },

      // TODO: Return proof only if requested.
      proof: JSON.parse(event.proof)
    };
  }

  getResultIPLDBlock (ipldBlock: IPLDBlock): ResultIPLDBlock {
    const block = ipldBlock.block;

    const data = codec.decode(Buffer.from(ipldBlock.data)) as any;

    return {
      block: {
        cid: block.cid,
        hash: block.blockHash,
        number: block.blockNumber,
        timestamp: block.blockTimestamp,
        parentHash: block.parentHash
      },
      contractAddress: ipldBlock.contractAddress,
      cid: ipldBlock.cid,
      kind: ipldBlock.kind,
      data: JSON.stringify(data)
    };
  }

  async processCanonicalBlock (job: any): Promise<void> {
    const { data: { blockHash } } = job;

    // Finalize staged diff blocks if any.
    await this.finalizeDiffStaged(blockHash);

    // Call custom stateDiff hook.
    await createStateDiff(this, blockHash);
  }

  async createDiffStaged (contractAddress: string, blockHash: string, data: any): Promise<void> {
    const block = await this.getBlockProgress(blockHash);
    assert(block);

    // Create a staged diff block.
    const ipldBlock = await this.prepareIPLDBlock(block, contractAddress, data, 'diff_staged');
    await this.saveOrUpdateIPLDBlock(ipldBlock);
  }

  async finalizeDiffStaged (blockHash: string): Promise<void> {
    const block = await this.getBlockProgress(blockHash);
    assert(block);

    // Get all the staged diff blocks for the given blockHash.
    const stagedBlocks = await this._db.getIPLDBlocks({ block, kind: 'diff_staged' });

    // For each staged block, create a diff block.
    for (const stagedBlock of stagedBlocks) {
      const data = codec.decode(Buffer.from(stagedBlock.data));
      await this.createDiff(stagedBlock.contractAddress, stagedBlock.block.blockHash, data);
    }

    // Remove all the staged diff blocks for current blockNumber.
    await this.removeStagedIPLDBlocks(block.blockNumber);
  }

  async createDiff (contractAddress: string, blockHash: string, data: any): Promise<void> {
    const block = await this.getBlockProgress(blockHash);
    assert(block);

    // Fetch the latest checkpoint for the contract.
    const checkpoint = await this.getLatestIPLDBlock(contractAddress, 'checkpoint');

    // There should be an initial checkpoint at least.
    // Assumption: There should be no events for the contract at the starting block.
    assert(checkpoint, 'Initial checkpoint doesn\'t exist');

    // Check if the latest checkpoint is in the same block.
    assert(checkpoint.block.blockHash !== block.blockHash, 'Checkpoint already created for the block hash.');

    const ipldBlock = await this.prepareIPLDBlock(block, contractAddress, data, 'diff');
    await this.saveOrUpdateIPLDBlock(ipldBlock);
  }

  async processCheckpoint (job: any): Promise<void> {
    // Return if checkpointInterval is <= 0.
    const checkpointInterval = this._serverConfig.checkpointInterval;
    if (checkpointInterval <= 0) return;

    const { data: { blockHash, blockNumber } } = job;

    // Get all the contracts.
    const contracts = await this._db.getContracts({});

    // For each contract, merge the diff till now to create a checkpoint.
    for (const contract of contracts) {
      // Check if contract has checkpointing on.
      if (contract.checkpoint) {
        // If a checkpoint doesn't already exist and blockNumber is equal to startingBlock, create an initial checkpoint.
        const checkpointBlock = await this.getLatestIPLDBlock(contract.address, 'checkpoint');

        if (!checkpointBlock) {
          if (blockNumber === contract.startingBlock) {
            // Call initial checkpoint hook.
            await createInitialCheckpoint(this, contract.address, blockHash);
          }
        } else {
          await this.createCheckpoint(contract.address, blockHash, null, checkpointInterval);
        }
      }
    }
  }

  async processCLICheckpoint (contractAddress: string, blockHash?: string): Promise<string | undefined> {
    const checkpointBlockHash = await this.createCheckpoint(contractAddress, blockHash);
    assert(checkpointBlockHash);

    const block = await this.getBlockProgress(checkpointBlockHash);
    const checkpointIPLDBlocks = await this._db.getIPLDBlocks({ block, contractAddress, kind: 'checkpoint' });

    // There can be at most one IPLDBlock for a (block, contractAddress, kind) combination.
    assert(checkpointIPLDBlocks.length <= 1);
    const checkpointIPLDBlock = checkpointIPLDBlocks[0];

    const checkpointData = this.getIPLDData(checkpointIPLDBlock);

    await this.pushToIPFS(checkpointData);

    return checkpointBlockHash;
  }

  async createCheckpoint (contractAddress: string, blockHash?: string, data?: any, checkpointInterval?: number): Promise<string | undefined> {
    const syncStatus = await this.getSyncStatus();
    assert(syncStatus);

    // Getting the current block.
    let currentBlock;

    if (blockHash) {
      currentBlock = await this.getBlockProgress(blockHash);
    } else {
      // In case of empty blockHash from checkpoint CLI, get the latest canonical block for the checkpoint.
      currentBlock = await this.getBlockProgress(syncStatus.latestCanonicalBlockHash);
    }

    assert(currentBlock);

    // Data is passed in case of initial checkpoint and checkpoint hook.
    // Assumption: There should be no events for the contract at the starting block.
    if (data) {
      const ipldBlock = await this.prepareIPLDBlock(currentBlock, contractAddress, data, 'checkpoint');
      await this.saveOrUpdateIPLDBlock(ipldBlock);

      return;
    }

    // If data is not passed, create from previous checkpoint and diffs after that.

    // Make sure the block is marked complete.
    assert(currentBlock.isComplete, 'Block for a checkpoint should be marked as complete');

    // Make sure the block is in the pruned region.
    assert(currentBlock.blockNumber <= syncStatus.latestCanonicalBlockNumber, 'Block for a checkpoint should be in the pruned region');

    // Fetch the latest checkpoint for the contract.
    const checkpointBlock = await this.getLatestIPLDBlock(contractAddress, 'checkpoint', currentBlock.blockNumber);
    assert(checkpointBlock);

    // Check (only if checkpointInterval is passed) if it is time for a new checkpoint.
    if (checkpointInterval && checkpointBlock.block.blockNumber > (currentBlock.blockNumber - checkpointInterval)) {
      return;
    }

    // Call state checkpoint hook and check if default checkpoint is disabled.
    const disableDefaultCheckpoint = await createStateCheckpoint(this, contractAddress, currentBlock.blockHash);

    if (disableDefaultCheckpoint) {
      // Return if default checkpoint is disabled.
      // Return block hash for checkpoint CLI.
      return currentBlock.blockHash;
    }

    const { block: { blockNumber: checkpointBlockNumber } } = checkpointBlock;

    // Fetching all diff blocks after checkpoint.
    const diffBlocks = await this.getDiffIPLDBlocksByCheckpoint(contractAddress, checkpointBlockNumber);

    const checkpointBlockData = codec.decode(Buffer.from(checkpointBlock.data)) as any;
    data = {
      state: checkpointBlockData.state
    };

    for (const diffBlock of diffBlocks) {
      const diff = codec.decode(Buffer.from(diffBlock.data)) as any;
      data.state = _.merge(data.state, diff.state);
    }

    const ipldBlock = await this.prepareIPLDBlock(currentBlock, contractAddress, data, 'checkpoint');
    await this.saveOrUpdateIPLDBlock(ipldBlock);

    return currentBlock.blockHash;
  }

  getIPLDData (ipldBlock: IPLDBlock): any {
    return codec.decode(Buffer.from(ipldBlock.data));
  }

  async getIPLDBlocksByHash (blockHash: string): Promise<IPLDBlock[]> {
    const block = await this.getBlockProgress(blockHash);
    assert(block);

    return this._db.getIPLDBlocks({ block });
  }

  async getIPLDBlockByCid (cid: string): Promise<IPLDBlock | undefined> {
    const ipldBlocks = await this._db.getIPLDBlocks({ cid });

    // There can be only one IPLDBlock with a particular cid.
    assert(ipldBlocks.length <= 1);

    return ipldBlocks[0];
  }

  async getLatestIPLDBlock (contractAddress: string, kind: string | null, blockNumber?: number): Promise<IPLDBlock | undefined> {
    return this._db.getLatestIPLDBlock(contractAddress, kind, blockNumber);
  }

  async getPrevIPLDBlock (blockHash: string, contractAddress: string, kind?: string): Promise<IPLDBlock | undefined> {
    const dbTx = await this._db.createTransactionRunner();
    let res;

    try {
      res = await this._db.getPrevIPLDBlock(dbTx, blockHash, contractAddress, kind);
      await dbTx.commitTransaction();
    } catch (error) {
      await dbTx.rollbackTransaction();
      throw error;
    } finally {
      await dbTx.release();
    }
    return res;
  }

  async getDiffIPLDBlocksByCheckpoint (contractAddress: string, checkpointBlockNumber: number): Promise<IPLDBlock[]> {
    return this._db.getDiffIPLDBlocksByCheckpoint(contractAddress, checkpointBlockNumber);
  }

  async prepareIPLDBlock (block: BlockProgress, contractAddress: string, data: any, kind: string):Promise<any> {
    assert(_.includes(['diff', 'checkpoint', 'diff_staged'], kind));

    // Get an existing 'diff' | 'diff_staged' | 'checkpoint' IPLDBlock for current block, contractAddress.
    const currentIPLDBlocks = await this._db.getIPLDBlocks({ block, contractAddress, kind });

    // There can be at most one IPLDBlock for a (block, contractAddress, kind) combination.
    assert(currentIPLDBlocks.length <= 1);
    const currentIPLDBlock = currentIPLDBlocks[0];

    // Update currentIPLDBlock if it exists and is of same kind.
    let ipldBlock;
    if (currentIPLDBlock) {
      ipldBlock = currentIPLDBlock;

      // Update the data field.
      const oldData = codec.decode(Buffer.from(currentIPLDBlock.data));
      data = _.merge(oldData, data);
    } else {
      ipldBlock = new IPLDBlock();

      // Fetch the parent IPLDBlock.
      const parentIPLDBlock = await this.getLatestIPLDBlock(contractAddress, null, block.blockNumber);

      // Setting the meta-data for an IPLDBlock (done only once per block).
      data.meta = {
        id: contractAddress,
        kind,
        parent: {
          '/': parentIPLDBlock ? parentIPLDBlock.cid : null
        },
        ethBlock: {
          cid: {
            '/': block.cid
          },
          num: block.blockNumber
        }
      };
    }

    // Encoding the data using dag-cbor codec.
    const bytes = codec.encode(data);

    // Calculating sha256 (multi)hash of the encoded data.
    const hash = await sha256.digest(bytes);

    // Calculating the CID: v1, code: dag-cbor, hash.
    const cid = CID.create(1, codec.code, hash);

    // Update ipldBlock with new data.
    ipldBlock = Object.assign(ipldBlock, {
      block,
      contractAddress,
      cid: cid.toString(),
      kind: data.meta.kind,
      data: Buffer.from(bytes)
    });

    return ipldBlock;
  }

  async saveOrUpdateIPLDBlock (ipldBlock: IPLDBlock): Promise<IPLDBlock> {
    return this._db.saveOrUpdateIPLDBlock(ipldBlock);
  }

  async removeStagedIPLDBlocks (blockNumber: number): Promise<void> {
    const dbTx = await this._db.createTransactionRunner();

    try {
      await this._db.removeEntities(dbTx, IPLDBlock, { relations: ['block'], where: { block: { blockNumber }, kind: 'diff_staged' } });
      await dbTx.commitTransaction();
    } catch (error) {
      await dbTx.rollbackTransaction();
      throw error;
    } finally {
      await dbTx.release();
    }
  }

  async pushToIPFS (data: any): Promise<void> {
    await this._ipfsClient.push(data);
  }

  isIPFSConfigured (): boolean {
    const ipfsAddr = this._serverConfig.ipfsApiAddr;

    // Return false if ipfsAddr is undefined | null | empty string.
    return (ipfsAddr !== undefined && ipfsAddr !== null && ipfsAddr !== '');
  }

  async getSubgraphEntity<Entity> (entity: new () => Entity, id: string, blockHash: string): Promise<Entity | undefined> {
    return this._graphWatcher.getEntity(entity, id, blockHash);
  }

  async triggerIndexingOnEvent (event: Event): Promise<void> {
    const resultEvent = this.getResultEvent(event);

    // Call subgraph handler for event.
    await this._graphWatcher.handleEvent(resultEvent);

    // Call custom hook function for indexing on event.
    await handleEvent(this, resultEvent);
  }

  async processEvent (event: Event): Promise<void> {
    // Trigger indexing of data based on the event.
    await this.triggerIndexingOnEvent(event);
  }

  parseEventNameAndArgs (kind: string, logObj: any): any {
    let eventName = UNKNOWN_EVENT_NAME;
    let eventInfo = {};

    const { topics, data } = logObj;
    const logDescription = this._contract.parseLog({ data, topics });

    switch (logDescription.name) {
      case TRANSFER_EVENT: {
        eventName = logDescription.name;
        const { from, to, value } = logDescription.args;
        eventInfo = {
          from,
          to,
          value: BigInt(ethers.BigNumber.from(value).toString())
        };

        break;
      }
      case APPROVAL_EVENT: {
        eventName = logDescription.name;
        const { owner, spender, value } = logDescription.args;
        eventInfo = {
          owner,
          spender,
          value: BigInt(ethers.BigNumber.from(value).toString())
        };

        break;
      }
      case AUTHORIZATIONUSED_EVENT: {
        eventName = logDescription.name;
        const { authorizer, nonce } = logDescription.args;
        eventInfo = {
          authorizer,
          nonce
        };

        break;
      }
      case ADMINUPDATED_EVENT: {
        eventName = logDescription.name;
        const { newAdmin, oldAdmin } = logDescription.args;
        eventInfo = {
          newAdmin,
          oldAdmin
        };

        break;
      }
      case TAXRATEUPDATED_EVENT: {
        eventName = logDescription.name;
        const { newNumerator, newDenominator, oldNumerator, oldDenominator } = logDescription.args;
        eventInfo = {
          newNumerator,
          newDenominator,
          oldNumerator,
          oldDenominator
        };

        break;
      }
      case SLOTCLAIMED_EVENT: {
        eventName = logDescription.name;
        const { slot, owner, delegate, newBidAmount, oldBidAmount, taxNumerator, taxDenominator } = logDescription.args;
        eventInfo = {
          slot,
          owner,
          delegate,
          newBidAmount,
          oldBidAmount,
          taxNumerator,
          taxDenominator
        };

        break;
      }
      case SLOTDELEGATEUPDATED_EVENT: {
        eventName = logDescription.name;
        const { slot, owner, newDelegate, oldDelegate } = logDescription.args;
        eventInfo = {
          slot,
          owner,
          newDelegate,
          oldDelegate
        };

        break;
      }
      case STAKE_EVENT: {
        eventName = logDescription.name;
        const { staker, stakeAmount } = logDescription.args;
        eventInfo = {
          staker,
          stakeAmount: BigInt(ethers.BigNumber.from(stakeAmount).toString())
        };

        break;
      }
      case UNSTAKE_EVENT: {
        eventName = logDescription.name;
        const { staker, unstakedAmount } = logDescription.args;
        eventInfo = {
          staker,
          unstakedAmount: BigInt(ethers.BigNumber.from(unstakedAmount).toString())
        };

        break;
      }
      case WITHDRAW_EVENT: {
        eventName = logDescription.name;
        const { withdrawer, withdrawalAmount } = logDescription.args;
        eventInfo = {
          withdrawer,
          withdrawalAmount: BigInt(ethers.BigNumber.from(withdrawalAmount).toString())
        };

        break;
      }
      case APPROVALFORALL_EVENT: {
        eventName = logDescription.name;
        const { owner, operator, approved } = logDescription.args;
        eventInfo = {
          owner,
          operator,
          approved
        };

        break;
      }
      case BLOCKPRODUCERADDED_EVENT: {
        eventName = logDescription.name;
        const { producer } = logDescription.args;
        eventInfo = {
          producer
        };

        break;
      }
      case BLOCKPRODUCERREMOVED_EVENT: {
        eventName = logDescription.name;
        const { producer } = logDescription.args;
        eventInfo = {
          producer
        };

        break;
      }
      case BLOCKPRODUCERREWARDCOLLECTORCHANGED_EVENT: {
        eventName = logDescription.name;
        const { producer, collector } = logDescription.args;
        eventInfo = {
          producer,
          collector
        };

        break;
      }
      case REWARDSCHEDULECHANGED_EVENT: {
        eventName = logDescription.name;
        eventInfo = {};

        break;
      }
      case CLAIMED_EVENT: {
        eventName = logDescription.name;
        const { index, totalEarned, account, claimed } = logDescription.args;
        eventInfo = {
          index: BigInt(ethers.BigNumber.from(index).toString()),
          totalEarned: BigInt(ethers.BigNumber.from(totalEarned).toString()),
          account,
          claimed: BigInt(ethers.BigNumber.from(claimed).toString())
        };

        break;
      }
      case SLASHED_EVENT: {
        eventName = logDescription.name;
        const { account, slashed } = logDescription.args;
        eventInfo = {
          account,
          slashed: BigInt(ethers.BigNumber.from(slashed).toString())
        };

        break;
      }
      case MERKLEROOTUPDATED_EVENT: {
        eventName = logDescription.name;
        const { merkleRoot, distributionNumber, metadataURI } = logDescription.args;
        eventInfo = {
          merkleRoot,
          distributionNumber: BigInt(ethers.BigNumber.from(distributionNumber).toString()),
          metadataURI
        };

        break;
      }
      case ACCOUNTUPDATED_EVENT: {
        eventName = logDescription.name;
        const { account, totalClaimed, totalSlashed } = logDescription.args;
        eventInfo = {
          account,
          totalClaimed: BigInt(ethers.BigNumber.from(totalClaimed).toString()),
          totalSlashed: BigInt(ethers.BigNumber.from(totalSlashed).toString())
        };

        break;
      }
      case PERMANENTURI_EVENT: {
        eventName = logDescription.name;
        const { value, id } = logDescription.args;
        eventInfo = {
          value,
          id: BigInt(ethers.BigNumber.from(id).toString())
        };

        break;
      }
      case GOVERNANCECHANGED_EVENT: {
        eventName = logDescription.name;
        const { from, to } = logDescription.args;
        eventInfo = {
          from,
          to
        };

        break;
      }
      case UPDATETHRESHOLDCHANGED_EVENT: {
        eventName = logDescription.name;
        const { updateThreshold } = logDescription.args;
        eventInfo = {
          updateThreshold: BigInt(ethers.BigNumber.from(updateThreshold).toString())
        };

        break;
      }
      case ROLEADMINCHANGED_EVENT: {
        eventName = logDescription.name;
        const { role, previousAdminRole, newAdminRole } = logDescription.args;
        eventInfo = {
          role,
          previousAdminRole,
          newAdminRole
        };

        break;
      }
      case ROLEGRANTED_EVENT: {
        eventName = logDescription.name;
        const { role, account, sender } = logDescription.args;
        eventInfo = {
          role,
          account,
          sender
        };

        break;
      }
      case ROLEREVOKED_EVENT: {
        eventName = logDescription.name;
        const { role, account, sender } = logDescription.args;
        eventInfo = {
          role,
          account,
          sender
        };

        break;
      }
    }

    return {
      eventName,
      eventInfo,
      eventSignature: logDescription.signature
    };
  }

  async watchContract (address: string, kind: string, checkpoint: boolean, startingBlock?: number): Promise<boolean> {
    // Use the checksum address (https://docs.ethers.io/v5/api/utils/address/#utils-getAddress) if input to address is a contract address.
    // If a contract identifier is passed as address instead, no need to convert to checksum address.
    // Customize: use the kind input to filter out non-contract-address input to address.
    const formattedAddress = (kind === '__protocol__') ? address : ethers.utils.getAddress(address);

    if (!startingBlock) {
      const syncStatus = await this.getSyncStatus();
      assert(syncStatus);

      startingBlock = syncStatus.latestIndexedBlockNumber;
    }

    await this._db.saveContract(formattedAddress, kind, checkpoint, startingBlock);

    return true;
  }

  async getHookStatus (): Promise<HookStatus | undefined> {
    const dbTx = await this._db.createTransactionRunner();
    let res;

    try {
      res = await this._db.getHookStatus(dbTx);
      await dbTx.commitTransaction();
    } catch (error) {
      await dbTx.rollbackTransaction();
      throw error;
    } finally {
      await dbTx.release();
    }

    return res;
  }

  async updateHookStatusProcessedBlock (blockNumber: number, force?: boolean): Promise<HookStatus> {
    const dbTx = await this._db.createTransactionRunner();
    let res;

    try {
      res = await this._db.updateHookStatusProcessedBlock(dbTx, blockNumber, force);
      await dbTx.commitTransaction();
    } catch (error) {
      await dbTx.rollbackTransaction();
      throw error;
    } finally {
      await dbTx.release();
    }

    return res;
  }

  async getLatestCanonicalBlock (): Promise<BlockProgress | undefined> {
    const syncStatus = await this.getSyncStatus();
    assert(syncStatus);

    return this.getBlockProgress(syncStatus.latestCanonicalBlockHash);
  }

  async getEventsByFilter (blockHash: string, contract?: string, name?: string): Promise<Array<Event>> {
    return this._baseIndexer.getEventsByFilter(blockHash, contract, name);
  }

  async isWatchedContract (address : string): Promise<Contract | undefined> {
    return this._baseIndexer.isWatchedContract(address);
  }

  async getProcessedBlockCountForRange (fromBlockNumber: number, toBlockNumber: number): Promise<{ expected: number, actual: number }> {
    return this._baseIndexer.getProcessedBlockCountForRange(fromBlockNumber, toBlockNumber);
  }

  async getEventsInRange (fromBlockNumber: number, toBlockNumber: number): Promise<Array<Event>> {
    return this._baseIndexer.getEventsInRange(fromBlockNumber, toBlockNumber);
  }

  async getSyncStatus (): Promise<SyncStatus | undefined> {
    return this._baseIndexer.getSyncStatus();
  }

  async updateSyncStatusIndexedBlock (blockHash: string, blockNumber: number, force = false): Promise<SyncStatus> {
    return this._baseIndexer.updateSyncStatusIndexedBlock(blockHash, blockNumber, force);
  }

  async updateSyncStatusChainHead (blockHash: string, blockNumber: number): Promise<SyncStatus> {
    return this._baseIndexer.updateSyncStatusChainHead(blockHash, blockNumber);
  }

  async updateSyncStatusCanonicalBlock (blockHash: string, blockNumber: number, force = false): Promise<SyncStatus> {
    return this._baseIndexer.updateSyncStatusCanonicalBlock(blockHash, blockNumber, force);
  }

  async getBlock (blockHash: string): Promise<any> {
    return this._baseIndexer.getBlock(blockHash);
  }

  async getEvent (id: string): Promise<Event | undefined> {
    return this._baseIndexer.getEvent(id);
  }

  async getBlockProgress (blockHash: string): Promise<BlockProgress | undefined> {
    return this._baseIndexer.getBlockProgress(blockHash);
  }

  async getBlocksAtHeight (height: number, isPruned: boolean): Promise<BlockProgress[]> {
    return this._baseIndexer.getBlocksAtHeight(height, isPruned);
  }

  async getOrFetchBlockEvents (block: DeepPartial<BlockProgress>): Promise<Array<EventInterface>> {
    return this._baseIndexer.getOrFetchBlockEvents(block, this._fetchAndSaveEvents.bind(this));
  }

  async getBlockEvents (blockHash: string): Promise<Array<Event>> {
    return this._baseIndexer.getBlockEvents(blockHash);
  }

  async removeUnknownEvents (block: BlockProgress): Promise<void> {
    return this._baseIndexer.removeUnknownEvents(Event, block);
  }

  async markBlocksAsPruned (blocks: BlockProgress[]): Promise<void> {
    return this._baseIndexer.markBlocksAsPruned(blocks);
  }

  async updateBlockProgress (blockHash: string, lastProcessedEventIndex: number): Promise<void> {
    return this._baseIndexer.updateBlockProgress(blockHash, lastProcessedEventIndex);
  }

  async getAncestorAtDepth (blockHash: string, depth: number): Promise<string> {
    return this._baseIndexer.getAncestorAtDepth(blockHash, depth);
  }

  async _fetchAndSaveEvents ({ cid: blockCid, blockHash }: DeepPartial<BlockProgress>): Promise<void> {
    assert(blockHash);
    let { block, logs } = await this._ethClient.getLogs({ blockHash });

    const {
      allEthHeaderCids: {
        nodes: [
          {
            ethTransactionCidsByHeaderId: {
              nodes: transactions
            }
          }
        ]
      }
    } = await this._postgraphileClient.getBlockWithTransactions({ blockHash });

    const transactionMap = transactions.reduce((acc: {[key: string]: any}, transaction: {[key: string]: any}) => {
      acc[transaction.txHash] = transaction;
      return acc;
    }, {});

    const dbEvents: Array<DeepPartial<Event>> = [];

    for (let li = 0; li < logs.length; li++) {
      const logObj = logs[li];
      const {
        topics,
        data,
        index: logIndex,
        cid,
        ipldBlock,
        account: {
          address
        },
        transaction: {
          hash: txHash
        },
        receiptCID,
        status
      } = logObj;

      if (status) {
        let eventName = UNKNOWN_EVENT_NAME;
        let eventInfo = {};
        const tx = transactionMap[txHash];
        const extraInfo: { [key: string]: any } = { topics, data, tx };

        const contract = ethers.utils.getAddress(address);
        const watchedContract = await this.isWatchedContract(contract);

        if (watchedContract) {
          const eventDetails = this.parseEventNameAndArgs(watchedContract.kind, logObj);
          eventName = eventDetails.eventName;
          eventInfo = eventDetails.eventInfo;
          extraInfo.eventSignature = eventDetails.eventSignature;
        }

        dbEvents.push({
          index: logIndex,
          txHash,
          contract,
          eventName,
          eventInfo: JSONbig.stringify(eventInfo),
          extraInfo: JSONbig.stringify(extraInfo),
          proof: JSONbig.stringify({
            data: JSONbig.stringify({
              blockHash,
              receiptCID,
              log: {
                cid,
                ipldBlock
              }
            })
          })
        });
      } else {
        log(`Skipping event for receipt ${receiptCID} due to failed transaction.`);
      }
    }

    const dbTx = await this._db.createTransactionRunner();

    try {
      block = {
        cid: blockCid,
        blockHash,
        blockNumber: block.number,
        blockTimestamp: block.timestamp,
        parentHash: block.parent.hash
      };

      await this._db.saveEvents(dbTx, block, dbEvents);
      await dbTx.commitTransaction();
    } catch (error) {
      await dbTx.rollbackTransaction();
      throw error;
    } finally {
      await dbTx.release();
    }
  }
}