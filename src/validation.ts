import * as forge from 'node-forge';
import { hexToBytes } from '@noble/hashes/utils.js';
import canonicalize from 'canonicalize';
import type { Transaction, Block, UTXOSet } from './types';
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
export async function validateTransaction(tx: Transaction, utxoSet: UTXOSet): Promise<number> {
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
            // Create the dictionary key: "txid:index"
            const utxoKey = `${input.outpoint.txid}:${input.outpoint.index}`;

            // Look it up in our live UTXO memory instead of the database!
            const prevOutput = utxoSet[utxoKey];
            
            // If the output is not present in the UTXO set, send INVALID_TX_OUTPOINT
            if (!prevOutput) {
                throw new Error("INVALID_TX_OUTPOINT"); //
            }

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
    requestMissingTx: (txid: string) => void // A way to ask the network for help
): Promise<void> {
    
    // Calculate the blockid (the hash of the entire block object)
    const blockid = getObjectId(block);

    // Check the Proof-of-Work
    // The hash must be strictly less than the target. If it is greater than or equal, it fails!
    if (blockid >= block.T) {
        throw new Error("INVALID_BLOCK_POW"); // 
    }

    let currentUTXOSet: UTXOSet = {};

    // If this is NOT the genesis block, we must inherit the parent's UTXO set.
    if (block.previd !== null) {
        // Look up the parent's UTXO state in the database
        // Save UTXO of block as "utxo_STATE_blockId"
        const parentUTXORaw = await db.get(`utxo_STATE_${block.previd}`).catch(() => null);
        
        if (!parentUTXORaw) {
            // "For now, you may assume that the previous block was sent to you beforehand... 
            // You may ignore the block if you do not have its previous block."
            throw new Error("UNFINDABLE_OBJECT"); 
        }

        // Copy the parent's state into our current state
        currentUTXOSet = typeof parentUTXORaw === "string" ? JSON.parse(parentUTXORaw) : parentUTXORaw;
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
        const txid = block.txids[i]; // We need the txid to create new UTXO keys!
        
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
            const txFee = await validateTransaction(tx, currentUTXOSet);
            // If it's a normal transaction, add its fee to our total block pool
            if (!isCoinbase) {
                totalBlockFees += txFee;
            }
        } catch (error: any) {
            // We can throw the specific error that validateTransaction gives us!
            throw new Error(error.message); //
        }

        // Destroy spent bills
        if (!isCoinbase && tx.inputs) {
            for (const input of tx.inputs) {
                const utxoKey = `${input.outpoint.txid}:${input.outpoint.index}`;
                delete currentUTXOSet[utxoKey]; // Remove from memory
            }
        }

        // Print new bills
        if (tx.outputs) {
            for (let outIndex = 0; outIndex < tx.outputs.length; outIndex++) {
                const output = tx.outputs[outIndex];
                if (!output) continue;

                const newUtxoKey = `${txid}:${outIndex}`;
                
                // Add the newly created output to memory
                currentUTXOSet[newUtxoKey] = {
                    pubkey: output.pubkey,
                    value: output.value
                };
            }
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

    // SAVE THE FINAL UTXO SET ---
    // If we reach this line, the block is flawless. 
    // We save the final economy snapshot permanently to the database, tied exactly to this block's ID!
    await db.put(`utxo_STATE_${blockid}`, currentUTXOSet);
}