import * as forge from 'node-forge';
import { hexToBytes } from '@noble/hashes/utils.js';
import canonicalize from 'canonicalize';
import { type Transaction, type Block, TransactionSchema } from './types';
import { db, getObjectId } from './object';

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
export async function validateTransaction(tx: Transaction): Promise<number> {
    // Coinbase Check
    // "For now, assume that a coinbase transaction is always valid."
    if (tx.height !== undefined && tx.inputs === undefined) {
        return 0; // It passes instantly!
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
    return sumInputs - sumOutputs;
}


/**
 * Validates a block's Proof of Work and its contained transactions.
 * Throws an Error with the specific protocol error name if it fails.
 */
export async function validateBlock(
    block: Block, 
    requestMissingTx: (txid: string) => void // NEW: A way to ask the network for help
): Promise<void> {
    
    // Calculate the blockid (the hash of the entire block object)
    const blockid = getObjectId(block);

    // Check the Proof-of-Work
    // The hash must be strictly less than the target. If it is greater than or equal, it fails!
    if (blockid >= block.T) {
        throw new Error("INVALID_BLOCK_POW"); // 
    }

    const missingTxids: string[] = [];
    
    // First pass: look in our database
    for (const txid of block.txids) {
        const txRaw = await db.get(txid).catch(() => null);
        if (!txRaw) {
            missingTxids.push(txid);
        }
    }

    // If we are missing anything, ask the network!
    if (missingTxids.length > 0) {
        for (const txid of missingTxids) {
            requestMissingTx(txid); // Broadcast the 'getobject' message
        }

        // We must pause and wait for peers to send us the objects.
        // Let's give them 3 seconds to respond and save it to our database.
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Second pass: check the database ONE MORE TIME
        for (const txid of missingTxids) {
            const txRaw = await db.get(txid).catch(() => null);
            if (!txRaw) {
                // If it's STILL missing, the block is invalid!
                throw new Error("UNFINDABLE_OBJECT"); //
            }
        }
    }

    // Load all the actual transaction objects into memory
    const transactions: Transaction[] = [];
    for (const txid of block.txids) {
        const txRaw = await db.get(txid); // We know it exists in the DB now!
        const txObj = typeof txRaw === "string" ? JSON.parse(txRaw) : txRaw;
        transactions.push(txObj);
    }

    // Loop through them to check validity, Coinbase rules, and spending
    let coinbaseCount = 0;
    let coinbaseTxid: string | null = null; 
    let coinbaseOutputValue = 0; // Track the miner's requested paycheck
    let totalBlockFees = 0;      // Track the fees we collect from normal transactions

    for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        
        if (!tx) throw new Error("UNFINDABLE_OBJECT");
        
        const isCoinbase = tx.height !== undefined && tx.inputs === undefined;

        if (isCoinbase) {
            coinbaseCount++;
            
            if (i !== 0) throw new Error("INVALID_BLOCK_COINBASE"); //

            const txid = block.txids[i];
            if (txid !== undefined) coinbaseTxid = txid;

            // Format checks
            if (tx.inputs !== undefined || !tx.outputs || tx.outputs.length !== 1 || tx.height === undefined) {
                throw new Error("INVALID_FORMAT"); //
            }

            // Save the value the miner is trying to claim so we can check it later!
            coinbaseOutputValue = tx.outputs[0]?.value ?? 0;

        } else {
            // Check for premature coinbase spending
            if (coinbaseTxid !== null && tx.inputs) {
                for (const input of tx.inputs) {
                    if (input.outpoint.txid === coinbaseTxid) throw new Error("INVALID_TX_OUTPOINT"); //
                }
            }
        }

        // Validate the transaction AND collect its fee!
        try {
            const txFee = await validateTransaction(tx);
            // If it's a normal transaction, add its fee to our total block pool
            if (!isCoinbase) {
                totalBlockFees += txFee;
            }
        } catch (error) {
            throw new Error("UNFINDABLE_OBJECT"); //
        }
    }

    // There can be AT MOST ONE coinbase transaction
    if (coinbaseCount > 1) {
        throw new Error("INVALID_BLOCK_COINBASE"); //
    }

    // Validate the Coinbase Math
    if (coinbaseCount === 1) {
        const BLOCK_REWARD = 50000000000000; // 50 * 10^12 picabu
        const maxAllowedCoinbase = BLOCK_REWARD + totalBlockFees;

        // If the miner asked for more money than they are allowed, reject the block!
        if (coinbaseOutputValue > maxAllowedCoinbase) {
            throw new Error("INVALID_BLOCK_COINBASE"); //
        }
    }

    // There can be AT MOST ONE coinbase transaction
    if (coinbaseCount > 1) {
        throw new Error("INVALID_BLOCK_COINBASE"); // 
    }
}