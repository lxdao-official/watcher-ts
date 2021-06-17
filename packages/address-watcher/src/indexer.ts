import assert from 'assert';
// import debug from 'debug';
import { ethers } from 'ethers';
import { PubSub } from 'apollo-server-express';

import { EthClient } from '@vulcanize/ipld-eth-client';
import { GetStorageAt } from '@vulcanize/solidity-mapper';

import { Database } from './database';

// const log = debug('vulcanize:indexer');

export class Indexer {
  _db: Database
  _ethClient: EthClient
  _pubsub: PubSub
  _getStorageAt: GetStorageAt

  constructor (db: Database, ethClient: EthClient, pubsub: PubSub) {
    assert(db);
    assert(ethClient);
    assert(pubsub);

    this._db = db;
    this._ethClient = ethClient;
    this._pubsub = pubsub;
    this._getStorageAt = this._ethClient.getStorageAt.bind(this._ethClient);
  }

  getEventIterator (): AsyncIterator<any> {
    return this._pubsub.asyncIterator(['event']);
  }

  async isWatchedAddress (address : string): Promise<boolean> {
    assert(address);

    return this._db.isWatchedAddress(ethers.utils.getAddress(address));
  }

  async watchAddress (address: string, startingBlock: number): Promise<boolean> {
    // Always use the checksum address (https://docs.ethers.io/v5/api/utils/address/#utils-getAddress).
    await this._db.saveAddress(ethers.utils.getAddress(address), startingBlock);

    return true;
  }
}