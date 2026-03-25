import { test, expect, beforeAll } from "bun:test";
import { db, getObjectId } from "../src/object";
import { validateBlock } from "../src/validation";
import type { Block, Transaction } from "../src/types";

// The Genesis Block
const genesisBlock: Block = {
  "T": "00000000abc00000000000000000000000000000000000000000000000000000",
  "created": 1771159355,
  "miner": "Marabu",
  "nonce": "00dd82159556175752d9ba7349df67bddd237b59183747383f7b720e85c32347",
  "note": "Financial Times 2026-02-13: Crypto's battle with the banks is splitting Trump's base",
  "previd": null,
  "txids": [],
  "type": "block"
};

// The valid transaction given in the assignment
const validTx: Transaction = {
  "height": 1,
  "outputs": [
    {
      "pubkey": "b6a95d7b410ae1eb924898ae584d21523b53aa5a78d1bc54abe964fd8e63f487",
      "value": 50000000000000
    }
  ],
  "type": "transaction"
};

// The valid Block #1 given in the assignment
const blockOne: Block = {
  "T": "00000000abc00000000000000000000000000000000000000000000000000000",
  "created": 1772028037,
  "miner": "kalaburi",
  "nonce": "b067391b9caf9821861e83cfc4d4656150ff2f1f800dbf37bdc76d211e76bf86",
  "previd": "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6",
  "txids": ["f0769c4452aec5979016ca16675e9cff0c602be973a365d4e951df6fb678624a"],
  "type": "block"
};

// A dummy network function since we have the data locally
const dummyRequestMissing = (txid: string) => {};

test("Block validation and UTXO Set generation", async () => {
    // PREPARATION: We must pre-load the transaction into our database so validateBlock finds it!
    const txid = getObjectId(validTx);
    await db.put(txid, validTx);
    expect(blockOne.txids[0]).toBe(txid); // Quick sanity check that hashes match

    // TEST 1: Validate Genesis Block
    const genesisId = getObjectId(genesisBlock);
    await validateBlock(genesisBlock, dummyRequestMissing);
    
    // Check if the empty Genesis UTXO set was saved!
    const genesisUTXO = await db.get(`utxo_STATE_${genesisId}`);
    expect(genesisUTXO).toEqual({}); 
    console.log("✅ Genesis block validated and empty UTXO set saved!");

    // TEST 2: Validate Block #1
    const blockOneId = getObjectId(blockOne);
    await validateBlock(blockOne, dummyRequestMissing);

    // Check if the new UTXO set contains the miner's 50 bu!
    const blockOneUTXO = await db.get(`utxo_STATE_${blockOneId}`);
    const expectedUtxoKey = `${txid}:0`;
    
    expect(blockOneUTXO).toHaveProperty(expectedUtxoKey);
    expect(blockOneUTXO[expectedUtxoKey].value).toBe(50000000000000);
    console.log(`✅ Block #1 validated and UTXO ${expectedUtxoKey} saved!`);
});