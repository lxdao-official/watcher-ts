import _ from 'lodash';
import debug from 'debug';

import { BlockProgressInterface, GraphDatabaseInterface } from './types';
import { jsonBigIntStringReplacer } from './misc';

const log = debug('vulcanize:ipld-helper');

export const updateStateForElementaryType = (initialObject: any, stateVariable: string, value: any): any => {
  const object = _.cloneDeep(initialObject);
  const path = ['state', stateVariable];

  return _.set(object, path, value);
};

export const updateStateForMappingType = (initialObject: any, stateVariable: string, keys: string[], value: any): any => {
  const object = _.cloneDeep(initialObject);
  keys.unshift('state', stateVariable);

  // Use _.setWith() with Object as customizer as _.set() treats numeric value in path as an index to an array.
  return _.setWith(object, keys, value, Object);
};

export const verifyCheckpointData = async (database: GraphDatabaseInterface, block: BlockProgressInterface, data: any) => {
  const { state } = data;

  for (const [entityName, idEntityMap] of Object.entries(state)) {
    for (const [id, ipldEntity] of Object.entries(idEntityMap as {[key: string]: any})) {
      const entityData = await database.getEntity(entityName, id, block.blockHash) as any;

      // Compare entities.
      const diffFound = Object.keys(ipldEntity)
        .some(key => {
          let ipldValue = ipldEntity[key];

          if (key === 'blockNumber') {
            entityData.blockNumber = entityData._blockNumber;
          }

          if (key === 'blockHash') {
            entityData.blockHash = entityData._blockHash;
          }

          if (typeof ipldEntity[key] === 'object' && ipldEntity[key]?.id) {
            ipldValue = ipldEntity[key].id;
          }

          if (
            Array.isArray(ipldEntity[key]) &&
            ipldEntity[key].length &&
            ipldEntity[key][0].id
          ) {
            // Map IPLD entity 1 to N relation field array to match DB entity.
            ipldValue = ipldEntity[key].map(({ id }: { id: string }) => id);

            // Sort DB entity 1 to N relation field array.
            entityData[key] = entityData[key].sort((a: string, b: string) => a.localeCompare(b));
          }

          return JSON.stringify(ipldValue) !== JSON.stringify(entityData[key], jsonBigIntStringReplacer);
        });

      if (diffFound) {
        const message = `Diff found for checkpoint at block ${block.blockNumber} in entity ${entityName} id ${id}`;
        log(message);
        throw new Error(message);
      }
    }
  }
};
