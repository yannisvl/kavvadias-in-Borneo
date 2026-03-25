import { test, expect } from "bun:test";
import { db, getObjectId } from "../src/object";
import { validateBlock } from "../src/validation";
import { BlockSchema } from "../src/types";
import type { Block, Transaction } from "../src/types";

// A dummy network function that never finds the missing objects
const dummyNetworkFail = async (txid: string) => {};

// A helper to make a "valid" block that passes PoW instantly for deep testing
const makeBypassBlock = (txids: string[]): Block => ({
    T: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as any, // Bypass Zod strict literal for deep testing
    created: Math.floor(Date.now() / 1000),
    nonce: "0000000000000000000000000000000000000000000000000000000000000000",
    previd: null, // Treat as Genesis for isolated UTXO testing
    txids: txids,
    type: "block"
});

test("Section 3a: Incorrect Target throws INVALID_FORMAT", () => {
    // We test Zod here, because Zod handles the front door!
    const badTargetBlock = {
        type: "block",
        txids: [],
        nonce: "b067391b9caf9821861e83cfc4d4656150ff2f1f800dbf37bdc76d211e76bf86",
        previd: null,
        created: 1772028037,
        T: "00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff" // Not the Marabu target!
    };

    const result = BlockSchema.safeParse(badTargetBlock);
    expect(result.success).toBe(false); // Zod should reject this immediately!
});

test("Section 3b: Invalid PoW throws INVALID_BLOCK_POW", async () => {
    const badPowBlock: Block = {
        type: "block",
        txids: [],
        nonce: "1111111111111111111111111111111111111111111111111111111111111111", // Bad nonce means bad hash!
        previd: null,
        created: 1772028037,
        T: "00000000abc00000000000000000000000000000000000000000000000000000" // Strict target
    };

    // The hash of this block will definitely be > 00000000abc...
    expect(validateBlock(badPowBlock, dummyNetworkFail)).rejects.toThrow("INVALID_BLOCK_POW");
});

test("Section 3c: Missing transaction throws UNFINDABLE_OBJECT", async () => {
    const fakeTxid = "9999999999999999999999999999999999999999999999999999999999999999";
    const unfindableBlock = makeBypassBlock([fakeTxid]);

    // Our dummy network won't find it, so it should throw!
    expect(validateBlock(unfindableBlock, dummyNetworkFail)).rejects.toThrow("UNFINDABLE_OBJECT");
});

test("Section 3f: Greedy Coinbase throws INVALID_BLOCK_COINBASE", async () => {
    // 1. Create a greedy coinbase asking for 100 bu instead of 50 bu
    const greedyTx: Transaction = {
        type: "transaction",
        height: 1,
        outputs: [{
            pubkey: "b6a95d7b410ae1eb924898ae584d21523b53aa5a78d1bc54abe964fd8e63f487",
            value: 100000000000000 // Too much!
        }]
    };
    
    // Save it to DB so validateBlock can find it
    const greedyTxid = getObjectId(greedyTx);
    await db.put(greedyTxid, greedyTx);

    // Put it in a block
    const greedyBlock = makeBypassBlock([greedyTxid]);

    // Test
    expect(validateBlock(greedyBlock, dummyNetworkFail)).rejects.toThrow("INVALID_BLOCK_COINBASE");
});