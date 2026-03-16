import { expect, test, describe } from "bun:test";
import { MessageSchema } from "../src/types";
import { getObjectId, db } from "../src/object";
import { validateTransaction } from "../src/validation";

describe("=== PSET 1: Message Formatting (Zod) ===", () => {
    test("Accepts a valid Hello message", () => {
        const msg = { type: "hello", version: "0.10.5", agent: "TestAgent" };
        expect(() => MessageSchema.parse(msg)).not.toThrow();
    });

    test("Rejects a Hello message with the wrong version", () => {
        const msg = { type: "hello", version: "1.0.0" }; 
        expect(() => MessageSchema.parse(msg)).toThrow();
    });

    test("Rejects a missing ObjectId in GetObject", () => {
        const msg = { type: "getobject" }; // Missing objectid!
        expect(() => MessageSchema.parse(msg)).toThrow();
    });
});

describe("=== PSET 2: Object Hashing & Database ===", () => {
    test("Correctly hashes the Genesis Block", () => {
        // We use the exact Genesis block from the protocol document
        const genesisBlock = {
            "T": "00000000abc00000000000000000000000000000000000000000000000000000",
            "created": 1771159355,
            "miner": "Marabu",
            "nonce": "00dd82159556175752d9ba7349df67bddd237b59183747383f7b720e85c32347",
            "note": "Financial Times 2026-02-13: Crypto's battle with the banks is splitting Trump's base",
            "previd": null,
            "txids": [],
            "type": "block"
        };
        const expectedHash = "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6"; //
        expect(getObjectId(genesisBlock)).toBe(expectedHash);
    });
});

describe("=== PSET 2: Transaction Validation ===", () => {
    const coinbaseTx = {
        "height": 0,
        "outputs": [{"pubkey": "958f8add086cc348e229a3b6590c71b7d7754e42134a127a50648bf07969d9a0","value": 50000000000}], 
        "type": "transaction"
    };

    const spendTx = {
        "inputs": [{"outpoint":{"index":0,"txid": "b303d841891f91af118a319f99f5984def51091166ac73c062c98f86ea7371ee"}, "sig": "060bf7cbe141fecfebf6dafbd6ebbcff25f82e729a7770f4f3b1f81a7ec8a0ce4b287597e609b822111bbe1a83d682ef14f018f8a9143cef25ecc9a8b0c1c405"}], 
        "outputs": [{"pubkey": "958f8add086cc348e229a3b6590c71b7d7754e42134a127a50648bf07969d9a0","value":10}], 
        "type": "transaction"
    };

    test("Accepts valid coinbase transaction", async () => {
        // We just check that it resolves to undefined (meaning it didn't throw an error)
        await expect(validateTransaction(coinbaseTx as any)).resolves.toBeUndefined();
    });

    test("Accepts valid spend transaction", async () => {
        // First, we must "seed" the database with the coinbase so the spendTx can find it
        const coinbaseHash = getObjectId(coinbaseTx);
        await db.put(coinbaseHash, coinbaseTx);

        // Now, the spend transaction should succeed!
        await expect(validateTransaction(spendTx as any)).resolves.toBeUndefined();
    });

    test("Throws UNKNOWN_OBJECT for fake input", async () => {
        // Create a fake transaction pointing to a txid that doesn't exist
        const fakeTx = JSON.parse(JSON.stringify(spendTx));
        fakeTx.inputs[0].outpoint.txid = "0000000000000000000000000000000000000000000000000000000000000000";

        // It must throw the exact protocol error
        await expect(validateTransaction(fakeTx as any)).rejects.toThrow("UNKNOWN_OBJECT");
    });
});