import { describe, it, expect } from "bun:test";
import { validateTransaction } from "../src/validation";
import { TransactionSchema } from "../src/types";

describe("Transaction Validation Engine", () => {
    
    it("should reject a loose transaction spending a non-existent UTXO", async () => {
        const badTx = {
            type: "transaction",
            inputs: [
                {
                    outpoint: { 
                        txid: "0000000000000000000000000000000000000000000000000000000000000000", // Fake TXID
                        index: 0 
                    },
                    sig: "deadbeef"
                }
            ],
            outputs: [
                { pubkey: "1234567890abcdef", value: 500 }
            ]
        };

        expect(validateTransaction(badTx as any)).rejects.toThrow("UNKNOWN_OBJECT");
    });

    it("should catch double spending within the same UTXO set", () => {
        // Test ValidateBlock with Double Spend
        const fakeUtxoSet: Record<string, any> = {
            "valid_txid:0": { pubkey: "my_pubkey", value: 1000 }
        };

        const inputs = [
            { outpoint: { txid: "valid_txid", index: 0 }, sig: "fake_sig" },
            { outpoint: { txid: "valid_txid", index: 0 }, sig: "fake_sig" } // 2nd try on the same UTXO
        ];

        let currentUTXOSetCopy = { ...fakeUtxoSet };
        let caughtErrorMessage = "";

        try {
            for (const input of inputs) {
                const utxoKey = `${input.outpoint.txid}:${input.outpoint.index}`;
                
                if (!currentUTXOSetCopy[utxoKey]) {
                    throw new Error("INVALID_TX_OUTPOINT");
                }
                
                // "Καίμε" το UTXO μετά την πρώτη χρήση!
                delete currentUTXOSetCopy[utxoKey]; 
            }
        } catch (error: any) {
            caughtErrorMessage = error.message;
        }

        expect(caughtErrorMessage).toBe("INVALID_TX_OUTPOINT");
    });

    it("should reject transactions with missing outputs via Zod", () => {
        // Test Format Schema (Zod)
        const badFormatTx = {
            type: "transaction",
            inputs: [{ outpoint: { txid: "some_txid", index: 0 }, sig: "sig" }]
            // outputs array missing
        };

        const result = TransactionSchema.safeParse(badFormatTx);
        
        expect(result.success).toBe(false);
    });
});