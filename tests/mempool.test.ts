import { test, expect, beforeEach, mock } from "bun:test";
import { db, getObjectId } from "../src/object";
import { validateTransaction } from "../src/validation";
import { BlockSchema, type Transaction, TransactionSchema } from "../src/types";
import { processMempoolTransaction, clearMempool, mempool, mempoolState } from "../src/mempool";

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


// --- MOCK THE CRYPTO ---
// We don't want to generate real Ed25519 keypairs just to test the mempool state logic,
// so we mock the validation module to always return true for signatures.
mock.module("../src/validation", () => ({
    verifyTxSignature: () => true,
    longestChainTip: "dummy_tip"
}));

// Before every test, wipe the waiting room clean so tests don't interfere with each other
beforeEach(() => {
    clearMempool();
});

// =====================================================================
// PSET 5: PART 1 (FORMATTING)
// =====================================================================

test("Test Case 1a: Duplicate inputs throw INVALID_FORMAT via Zod", () => {
    const tx = {
        type: "transaction",
        inputs: [
            // Exact same outpoint spent twice in the same transaction!
            { outpoint: { txid: "0000000000000000000000000000000000000000000000000000000000000000", index: 0 }, sig: "aa" },
            { outpoint: { txid: "0000000000000000000000000000000000000000000000000000000000000000", index: 0 }, sig: "bb" }
        ],
        outputs: [{ pubkey: "abcdef", value: 10 }]
    };
    
    const result = TransactionSchema.safeParse(tx);
    expect(result.success).toBe(false);
});

test("Test Case 1b: Block with >128 char note throws INVALID_FORMAT via Zod", () => {
    const block = {
        type: "block",
        txids: [],
        nonce: "0000000000000000000000000000000000000000000000000000000000000000",
        previd: null,
        created: 1234567890,
        T: "00000000abc00000000000000000000000000000000000000000000000000000",
        note: "a".repeat(129) // 129 characters (Rule says max 128!)
    };
    
    const result = BlockSchema.safeParse(block);
    expect(result.success).toBe(false);
});


// =====================================================================
// PSET 5: PART 3 (MEMPOOL LOGIC)
// =====================================================================

test("Test Case 3b: Valid transaction is added to mempool and state updates", async () => {
    // 1. Give Alice 50 coins in our speculative parallel universe
    const dummyTxid = "1111111111111111111111111111111111111111111111111111111111111111";
    mempoolState[`${dummyTxid}:0`] = { pubkey: "alice", value: 50 };

    // 2. Alice sends 40 coins to Bob
    const newTx = {
        type: "transaction",
        inputs: [{ outpoint: { txid: dummyTxid, index: 0 }, sig: "aa" }],
        outputs: [{ pubkey: "bob", value: 40 }]
    };
    const newTxid = "2222222222222222222222222222222222222222222222222222222222222222";

    // 3. Process it!
    await processMempoolTransaction(newTx as any, newTxid);

    // 4. Verify the results
    expect(mempool.includes(newTxid)).toBe(true); // Is it in the waiting room?
    expect(mempoolState[`${dummyTxid}:0`]).toBeUndefined(); // Was Alice's input destroyed?
    expect(mempoolState[`${newTxid}:0`]).toEqual({ pubkey: "bob", value: 40 }); // Was Bob's output created?
});

test("Test Case 3c: Invalid transaction (missing outpoint) throws INVALID_TX_OUTPOINT", async () => {
    // Transaction tries to spend an outpoint that DOES NOT exist in mempoolState
    const tx = {
        type: "transaction",
        inputs: [{ outpoint: { txid: "3333333333333333333333333333333333333333333333333333333333333333", index: 0 }, sig: "aa" }],
        outputs: [{ pubkey: "bob", value: 40 }]
    };

    // The bouncer should reject it with the specific error from the assignment
    expect(processMempoolTransaction(tx as any, "txid")).rejects.toThrow("INVALID_TX_OUTPOINT");
    
    // The waiting room should remain empty
    expect(mempool.length).toBe(0);
});

test("Test Case 3d: Coinbase transaction is rejected from mempool", async () => {
    // A miner tries to illegally broadcast a block reward directly to the waiting room
    const coinbaseTx = {
        type: "transaction",
        height: 10,
        outputs: [{ pubkey: "miner", value: 50000000000000 }]
    };

    // The bouncer should throw INVALID_FORMAT because coinbase txs don't have inputs
    expect(processMempoolTransaction(coinbaseTx as any, "txid")).rejects.toThrow("INVALID_FORMAT");
    
    // The waiting room should remain empty
    expect(mempool.length).toBe(0);
});