import * as forge from 'node-forge';
import { hexToBytes } from '@noble/hashes/utils.js';
import canonicalize from 'canonicalize';
import type { Transaction } from './types';
import { db } from './object';

/**
 * Verifies a single Ed25519 signature within a transaction.
 */
export function verifyTxSignature(transaction: Transaction, pubKeyHex: string, sigHex: string): boolean {
    try {
        // Convert hex strings to byte arrays (Uint8Array)
        // The guidelines state we must convert the hex strings to Uint8 arrays for the package.
        const publicKeyBytes = hexToBytes(pubKeyHex);
        const signatureBytes = hexToBytes(sigHex);

        // Create a "deep copy" of the transaction so we don't accidentally modify the real one in memory
        const txCopy = JSON.parse(JSON.stringify(transaction));

        // Replace ALL 'sig' values with null before checking, exactly as the protocol demands
        if (txCopy.inputs) {
            for (const input of txCopy.inputs) {
                input.sig = null;
            }
        }

        // Canonicalize the modified transaction to get the exact string the user originally signed
        const messageString = canonicalize(txCopy);
        if (!messageString) return false;

        // Convert the canonical string into bytes
        const messageBytes = new TextEncoder().encode(messageString);

        // Ask node-forge to verify the cryptography!
        return forge.pki.ed25519.verify({
            message: messageBytes,
            signature: signatureBytes,
            publicKey: publicKeyBytes
        });
        
    } catch (error) {
        // If the hex is malformed, the length is wrong, or the signature is null, 
        // node-forge or hexToBytes will throw an error. We catch it and return false.
        return false;
    }
}


/**
 * Validates a transaction's outpoints, signatures, and conservation of value.
 * Throws an Error with the specific protocol error name if it fails.
 */
export async function validateTransaction(tx: Transaction): Promise<void> {
    // Coinbase Check
    // "For now, assume that a coinbase transaction is always valid."
    if (tx.height !== undefined && tx.inputs === undefined) {
        return; // It passes instantly!
    }

    let sumOutputs = 0;
    let sumInputs = 0;

    // Calculate total output value
    if (tx.outputs) {
        for (const output of tx.outputs) {
            sumOutputs += output.value;
        }
    }

    // Loop through every input and rigorously check it
    if (tx.inputs) {
        for (const input of tx.inputs) {
            // Ensure a valid transaction with the given txid exists in your object database
            const prevTxRaw = await db.get(input.outpoint.txid).catch(() => null);
            
            if (!prevTxRaw) {
                // If we can't find it, we throw this specific error
                throw new Error("UNKNOWN_OBJECT"); 
            }

            // Parse prevTx if it's a string
            const prevTxObj = typeof prevTxRaw === "string" ? JSON.parse(prevTxRaw) : prevTxRaw;

            // Ensure the given index is less than the number of outputs
            if (input.outpoint.index >= prevTxObj.outputs.length) {
                // If the index is too large, we throw this error
                throw new Error("INVALID_TX_OUTPOINT"); 
            }

            // Grab the specific output this input is trying to spend
            const prevOutput = prevTxObj.outputs[input.outpoint.index];
            sumInputs += prevOutput.value;

            // Verify the signature using the pubkey from the previous output
            const isValidSig = verifyTxSignature(tx, prevOutput.pubkey, input.sig);
            if (!isValidSig) {
                // If it is not a valid signature given the public key, throw this error
                throw new Error("INVALID_TX_SIGNATURE"); 
            }
        }
    }

    // The Weak Law of Conservation
    // The sum of all input values must be at least the sum of output values
    if (sumInputs < sumOutputs) {
        throw new Error("INVALID_TX_CONSERVATION"); //
    }

    // If we make it to the very bottom without throwing an error, the transaction is 100% valid!
}