# solidity-mapper

Get value of state variable from storage for a solidity contract.

## Pre-requisites

* NodeJS and NPM

  https://nodejs.org/en/ or use https://github.com/nvm-sh/nvm

## Instructions

Run the tests using the following command
```bash
$ yarn test
```

## Different Types

* [ ] Value Types
  * [x] Booleans
  * [x] Integers
  * [ ] Fixed Point Numbers
  * [x] Address
  * [x] Contract Types
  * [x] Fixed-size byte arrays
  * [x] Enums
  * [ ] Function Types
* [ ] Reference Types
  * [ ] Arrays
    * [ ] Fixed size arrays
      * [x] Integer Type
      * [x] Boolean Type
      * [ ] Address Type
      * [ ] Fixed-size byte arrays
      * [ ] Enum type
      * [ ] Dynamically-sized byte array
      * [ ] Struct Type
      * [ ] Mapping Type
    * [ ] Dynamically-sized arrays
      * [ ] Integer Type
      * [ ] Boolean Type
      * [ ] Address Type
      * [ ] Fixed-size byte arrays
      * [ ] Enum Type
      * [ ] Dynamically-sized byte array
      * [ ] Struct Type
      * [ ] Mapping Type
    * [ ] Nested Arrays
      * [ ] Fixed size arrays
      * [ ] Dynamically-sized arrays
  * [ ] Dynamically-sized byte array
    * [ ] Bytes
    * [x] String
  * [ ] Structs
    * [ ] Value Types
    * [ ] Reference Types
  * [ ] Mapping Types
    * [ ] Value Type keys
    * [ ] Dynamically-sized byte array keys
    * [ ] Reference Type Mapping values
    * [ ] Nested Mapping

## Observations

* The storage layouts are formed according to the rules in https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html#layout-of-state-variables-in-storage

* Structs can occupy multiple slots depending on the size required by its members.

* Fixed arrays can occupy multiple slots according to the size of the array and the type of array.