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
export async function validateTransaction(tx: Transaction, utxoSet?: UTXOSet): Promise<number> {
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

    if (tx.inputs) {
        for (const input of tx.inputs) {
            let prevOutput;

            // CHECK IF UTXOSET EXISTS BEFORE TRYING TO USE IT!
            if (utxoSet !== undefined) {
                // Case 1: Block Validation (We have a UTXO set)
                const utxoKey = `${input.outpoint.txid}:${input.outpoint.index}`;
                prevOutput = utxoSet[utxoKey]; 

                // If we are inside a block and the UTXO is missing, 
                // we must check WHY it's missing to give the correct error.
                if (!prevOutput) {
                    const txExists = await db.get(input.outpoint.txid).catch(() => null);
                    if (!txExists) {
                        // The parent transaction doesn't even exist in our DB
                        throw new Error("UNKNOWN_OBJECT"); 
                    } else {
                        // The parent exists, but the output isn't in the UTXO set (Double Spend!)
                        throw new Error("INVALID_TX_OUTPOINT"); 
                    }
                }
            } else {
                // Case 2: Loose Transaction in index.ts (We must look in the DB)
                const prevTxRaw = await db.get(input.outpoint.txid).catch(() => null);
                
                if (!prevTxRaw) {
                    // Parent transaction not found in DB
                    throw new Error("UNKNOWN_OBJECT"); 
                }
                
                const prevTx = typeof prevTxRaw === "string" ? JSON.parse(prevTxRaw) : prevTxRaw;
                
                // Ensure the parent transaction actually has the index we are trying to spend
                if (!prevTx.outputs || !prevTx.outputs[input.outpoint.index]) {
                    throw new Error("INVALID_TX_OUTPOINT");
                }

                prevOutput = prevTx.outputs[input.outpoint.index];
            }

            // If we still can't find the output in either place, it's invalid
            if (!prevOutput) {
                throw new Error("INVALID_TX_OUTPOINT"); 
            }

            sumInputs += prevOutput.value;

            // Verify the signature
            const isValidSig = verifyTxSignature(tx, prevOutput.pubkey, input.sig);
            if (!isValidSig) {
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
    requestMissingObject: (obj: string) => void // A way to ask the network for help
): Promise<void> {
    
    // Calculate the blockid (the hash of the entire block object)
    const blockid = getObjectId(block);

    // Check the Proof-of-Work
    // The hash must be strictly less than the target. If it is greater than or equal, it fails!
    if (blockid >= block.T) {
        throw new Error("INVALID_BLOCK_POW"); // 
    }

    // TIMESTAMP CHECK, Must not be in the future
    const currentTime = Math.floor(Date.now() / 1000);
    if (block.created > currentTime) {
        throw new Error("INVALID_BLOCK_TIMESTAMP");
    }

    let currentUTXOSet: UTXOSet = {};
    let blockHeight = 0; // Genesis block defaults to height 0

    // If this is NOT the genesis block, we must inherit the parent's UTXO set.
    if (block.previd !== null) {
        // Try to load the parent's UTXO state
        let parentUTXORaw = await db.get(`utxo_STATE_${block.previd}`).catch(() => null);
        
        if (!parentUTXORaw) {
            // We don't have the validated parent! Ask the network for it.
            requestMissingObject(block.previd);
            
            // The Polling Loop (Patience for deep chains) ---
            // Instead of sleeping once, we check the database every 500ms 
            // for up to 10 seconds. This gives index.ts enough time to fetch 
            // and validate multiple missing parents recursively!
            let retries = 20; 
            while (retries > 0 && !parentUTXORaw) {
                await new Promise(resolve => setTimeout(resolve, 200));
                parentUTXORaw = await db.get(`utxo_STATE_${block.previd}`).catch(() => null);
                retries--;
            }
            
            if (!parentUTXORaw) {
                // If it's still missing or was invalid, this block is unfindable
                throw new Error("UNFINDABLE_OBJECT"); 
            }
        }

        // Copy the parent's state into our current state
        currentUTXOSet = typeof parentUTXORaw === "string" ? JSON.parse(parentUTXORaw) : parentUTXORaw;

        // TIMESTAMP CHECK, Must not be in the future
        const parentRaw = await db.get(block.previd).catch(() => null);
        if (!parentRaw) throw new Error("UNFINDABLE_OBJECT");
        const parentBlock: Block = typeof parentRaw === "string" ? JSON.parse(parentRaw) : parentRaw;

        if (block.created <= parentBlock.created) {
            throw new Error("INVALID_BLOCK_TIMESTAMP");
        }

        // HEIGHT CALCULATION
        const parentHeightRaw = await db.get(`height_${block.previd}`).catch(() => null);
        if (parentHeightRaw === null) throw new Error("UNFINDABLE_OBJECT");
        blockHeight = parseInt(parentHeightRaw as string) + 1;
    } 
    else {
        // --- PSET 4: FAKE GENESIS CHECK ---
        // If previd is null, it MUST be the exact official Marabu genesis block!
        const OFFICIAL_GENESIS_ID = "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6";
        if (blockid !== OFFICIAL_GENESIS_ID) {
            throw new Error("INVALID_GENESIS");
        }
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
            requestMissingObject(txid); // Broadcast the 'getobject' message
        }

        // Fast Polling Loop: Wait up to 2 seconds for missing transactions
        let txRetries = 10;
        let allFound = false;
        while (txRetries > 0 && !allFound) {
            await new Promise(resolve => setTimeout(resolve, 200));
            allFound = true;
            for (const txid of missingTxids) {
                const txRaw = await db.get(txid).catch(() => null);
                if (!txRaw) {
                    allFound = false;
                    break; // One is still missing, stop checking and sleep again
                }
            }
            txRetries--;
        }

        // Final check after the 2-second deadline
        for (const txid of missingTxids) {
            const txRaw = await db.get(txid).catch(() => null);
            if (!txRaw) {
                throw new Error("UNFINDABLE_OBJECT"); 
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
            
            if (i !== 0) throw new Error("INVALID_BLOCK_COINBASE");

            // COINBASE HEIGHT MATCH
            if (tx.height !== blockHeight) {
                throw new Error("INVALID_BLOCK_COINBASE");
            }

            const txid = block.txids[i];
            if (txid !== undefined) coinbaseTxid = txid;

            // Format checks
            if (tx.inputs !== undefined || !tx.outputs || tx.outputs.length !== 1 || tx.height === undefined) {
                throw new Error("INVALID_FORMAT"); //
            }

            // Save the value the miner is trying to claim so we can check it later!
            coinbaseOutputValue = tx.outputs[0]?.value ?? 0;

        } else {
            // Check for premature coinbase spending inside the same Block!
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

    // SAVE THE FINAL UTXO SET and height---
    // If we reach this line, the block is flawless. 
    // We save the final economy snapshot permanently to the database, tied exactly to this block's ID!
    
    // --- SAVE EVERYTHING IN STRICT ORDER ---
    // 1. Save the raw block object so child timestamp checks can find it instantly
    await db.put(blockid, block);

    // 2. Save the height
    await db.put(`height_${blockid}`, blockHeight.toString());

    // 3. Save the UTXO state LAST. That way, if a child block's polling loop
    // detects the UTXO state, it is mathematically guaranteed that the height
    // and raw block are already in the database!
    await db.put(`utxo_STATE_${blockid}`, currentUTXOSet);

    // THE LONGEST CHAIN RULE
    // Fetch our current absolute best tip from the database
    const currentTipRaw = await db.get('longest_chain_tip').catch(() => null);
    let currentTipHeight = -1; // If we don't have a tip yet, ANY valid block beats it

    if (currentTipRaw) {
        const currentTipHeightRaw = await db.get(`height_${currentTipRaw}`).catch(() => null);
        if (currentTipHeightRaw !== null) {
            currentTipHeight = parseInt(currentTipHeightRaw as string);
        }
    }

    // Consensus! If this new block is strictly taller, it is the new tip of our chain.
    // (If there is a tie, we stick with the one we saw first).
    if (blockHeight > currentTipHeight) {
        await db.put('longest_chain_tip', blockid);
        console.log(`Consensus Update: New longest chain tip! Block ${blockid.substring(0,8)}... at height ${blockHeight}`);
    }
}