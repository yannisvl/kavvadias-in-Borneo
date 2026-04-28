import { test, expect, beforeAll } from "bun:test";
import { db, getObjectId } from "../src/object";
import { validateBlock } from "../src/validation";
import type { Block } from "../src/types";

// The Official Genesis Block
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

// A valid Block #1
const blockOne: Block = {
  "T": "00000000abc00000000000000000000000000000000000000000000000000000",
  "created": 1772028037,
  "miner": "kalaburi",
  "nonce": "b067391b9caf9821861e83cfc4d4656150ff2f1f800dbf37bdc76d211e76bf86",
  "previd": "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6",
  "txids": ["f0769c4452aec5979016ca16675e9cff0c602be973a365d4e951df6fb678624a"],
  "type": "block"
};

const dummyRequestMissing = (id: string) => {};

beforeAll(async () => {
    // Make sure genesis is in the DB so Block 1 can find it
    await db.put(getObjectId(genesisBlock), genesisBlock);
    await db.put(`utxo_STATE_${getObjectId(genesisBlock)}`, {});
    await db.put(`height_${getObjectId(genesisBlock)}`, "0");
});

test("PSET 4 - 1c: Block in the year 2077 throws INVALID_BLOCK_TIMESTAMP", async () => {
    const futureBlock = JSON.parse(JSON.stringify(blockOne));
    futureBlock.created = 3382224000; // Year 2077
    futureBlock.T = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"; // Bypass PoW for test

    await expect(validateBlock(futureBlock, dummyRequestMissing))
        .rejects.toThrow("INVALID_BLOCK_TIMESTAMP");
});

test("PSET 4 - 1b: Non-increasing timestamps throws INVALID_BLOCK_TIMESTAMP", async () => {
    const pastBlock = JSON.parse(JSON.stringify(blockOne));
    pastBlock.created = 1771159350; // Older than Genesis (1771159355)
    pastBlock.T = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"; // Bypass PoW for test

    await expect(validateBlock(pastBlock, dummyRequestMissing))
        .rejects.toThrow("INVALID_BLOCK_TIMESTAMP");
});

test("PSET 4 - 1e: Fake Genesis throws INVALID_GENESIS", async () => {
    const fakeGenesis = JSON.parse(JSON.stringify(genesisBlock));
    fakeGenesis.note = "I am a malicious genesis block!"; // Changes the hash
    fakeGenesis.T = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"; // Bypass PoW

    await expect(validateBlock(fakeGenesis, dummyRequestMissing))
        .rejects.toThrow("INVALID_GENESIS");
});

test("PSET 4 - 1a: Unfindable parent times out and throws UNFINDABLE_OBJECT", async () => {
    const orphanBlock = JSON.parse(JSON.stringify(blockOne));
    orphanBlock.previd = "0000000000000000000000000000000000000000000000000000000000000000"; // Parent doesn't exist
    orphanBlock.T = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"; 

    // This will take about 10 seconds because our polling loop tries to fetch it!
    await expect(validateBlock(orphanBlock, dummyRequestMissing))
        .rejects.toThrow("UNFINDABLE_OBJECT");
}, 15000); // Give the test 15 seconds before timing out