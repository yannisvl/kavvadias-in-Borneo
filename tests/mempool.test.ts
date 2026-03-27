import { test, expect } from "bun:test";
import { db, getObjectId } from "../src/object";
import { validateTransaction } from "../src/validation";
import type { Transaction } from "../src/types";

// 1. The previous Coinbase transaction (created in Block 1)
const prevTx: Transaction = {
    "height": 1,
    "outputs": [
        {
            "pubkey": "bba40466a8bc7cf6ffd7e5d313668a35a0cbe530ab0999f86b474cda60c9e61c",
            "value": 50000000000000
        }
    ],
    "type": "transaction"
};

// 2. The Grader's loose transaction that caused the crash
const looseTx: Transaction = {
    "inputs": [
        {
            "outpoint": {
                "index": 0,
                // This points exactly to prevTx
                "txid": "e2e3d5919de1de1338217bfd1d364bf381c2c7336e0c85c46e4ae86232c26529"
            },
            // The Grader's valid signature
            "sig": "0e02a3b035ee3643bb046b8eeab0fe66b00857de1139a15566801f773399ee54fe9f387980b7d4b66555ac13ea831a5e04a94b6a0378003e20c4a55afc2f7804"
        }
    ],
    "outputs": [
        {
            "pubkey": "9862f5928090d4dffe2fe768e0f9f1647d44e6d98f70c626ae3ef7709b464a66",
            "value": 49000000000000
        }
    ],
    "type": "transaction"
};

test("Loose Transaction gracefully falls back to DB when utxoSet is undefined", async () => {
    // Step 1: Force the previous transaction into the DB so Mode 2 can find it
    const prevTxid = getObjectId(prevTx);
    await db.put(prevTxid, prevTx);
    
    // Quick sanity check to ensure the ID matches what the Grader expects
    expect(prevTxid).toBe("e2e3d5919de1de1338217bfd1d364bf381c2c7336e0c85c46e4ae86232c26529");

    // Step 2: The actual test!
    // We call validateTransaction on the looseTx WITHOUT passing the utxoSet argument.
    // If the patch worked, this will look up prevTx in the DB and return the fee.
    // If the patch failed, it will crash with "undefined is not an object".
    
    const fee = await validateTransaction(looseTx);
    
    // Step 3: Verify the math
    // Input is 50 bu, Output is 49 bu. Fee should be 1 bu (1,000,000,000,000 picabus).
    expect(fee).toBe(1000000000000); 
    console.log("✅ Loose transaction successfully fetched its parent from LevelDB and validated!");
});