import { UTXOSet, Transaction } from "./types";
import { db } from "./object";
import { verifyTxSignature } from "./validation";
import { broadcast } from "./index";

// 1. The Waiting Room List
export let mempool: string[] = [];

// 2. The Speculative "What-If" Economy
export let mempoolState: UTXOSet = {};

// A helper function to easily wipe the mempool clean when we need to 
export function clearMempool() {
    mempool = [];
    mempoolState = {};
}

export async function initializeMempool() {
    clearMempool(); // Always start fresh

    // 1. Fetch the absolute current tip from the DB instead of importing it
    const tip = await db.get('longest_chain_tip').catch(() => null);

    if (tip !== null) {
        try {
            // Fetch the Official UTXO state of our current tip
            const tipState = await db.get(`utxo_STATE_${tip}`);
            
            // Deep copy it into our mempoolState so we have a fresh sandbox
            mempoolState = typeof tipState === "string" ? JSON.parse(tipState) : tipState;
            console.log(`[Mempool] Initialized state from chain tip: ${tip.substring(0, 8)}...`);
        } catch (e) {
            console.error("[Mempool] Failed to load tip state during initialization", e);
        }
    } else {
        console.log("[Mempool] Node has no longest chain yet. Starting with empty state.");
    }

    // 2. Ask peers for their mempools (Using your broadcast function from index.ts)
    broadcast({ type: "getmempool" });
    console.log("[Mempool] Broadcasted getmempool to peers.");
}


export async function processMempoolTransaction(tx: Transaction, txid: string) {
    // 1. Skip if we already have it in the waiting room
    if (mempool.includes(txid)) return;

    // 2. Reject Coinbase Transactions
    if (!tx.inputs || tx.inputs.length === 0 || tx.height !== undefined) {
        throw new Error("INVALID_FORMAT"); 
    }

    let inputSum = 0;
    const spentKeys: string[] = [];

    // 3. Validate Inputs against the Mempool State
    for (const input of tx.inputs) {
        const outpointKey = `${input.outpoint.txid}:${input.outpoint.index}`;
        const utxo = mempoolState[outpointKey];

        if (!utxo) {
            throw new Error("INVALID_TX_OUTPOINT"); 
        }

        // Verify cryptographic signature using your specific function name!
        const isValid = verifyTxSignature(tx, utxo.pubkey, input.sig);
        if (!isValid) throw new Error("INVALID_TX_SIGNATURE");

        inputSum += utxo.value;
        spentKeys.push(outpointKey);
    }

    // 4. Validate Outputs (Conservation of Value)
    let outputSum = 0;
    for (const output of tx.outputs || []) {
        outputSum += output.value;
    }

    if (inputSum < outputSum) {
        throw new Error("INVALID_TX_CONSERVATION");
    }

    // --- SUCCESS! The transaction is valid in our parallel universe ---

    // 5. Update the Mempool State (Destroy inputs, print outputs)
    for (const key of spentKeys) {
        delete mempoolState[key];
    }
    for (let i = 0; i < (tx.outputs?.length || 0); i++) {
        const output = tx.outputs![i];
        if (output) {
            mempoolState[`${txid}:${i}`] = output;
        }
    }

    // 6. Add it to the waiting room array
    mempool.push(txid);
    console.log(`[Mempool] Accepted new tx into waiting room: ${txid.substring(0,8)}...`);
}


export async function reloadMempool(oldTip: string | null, newTip: string) {
    console.log("[Mempool] Longest chain updated! Rebuilding waiting room...");

    // 1. Map out the new official timeline
    const newChainBlocks = new Set<string>();
    let currNode: string | null = newTip;
    while (currNode !== null) {
        newChainBlocks.add(currNode);
        const bRaw: unknown = await db.get(currNode).catch(() => null);
        if (!bRaw) break;
        const b = typeof bRaw === 'string' ? JSON.parse(bRaw) : bRaw;
        currNode = b.previd;
    }

    // 2. Walk backward down the old chain to rescue orphaned transactions!
    // We stop walking as soon as we hit a block that is in the new timeline (the fork point)
    let orphanedTxids: string[] = [];
    let orphanNode: string | null = oldTip;
    
    while (orphanNode !== null && !newChainBlocks.has(orphanNode)) {
        const bRaw: unknown = await db.get(orphanNode).catch(() => null);
        if (!bRaw) break;
        const b = typeof bRaw === 'string' ? JSON.parse(bRaw) : bRaw;
        
        orphanedTxids.push(...b.txids);
        orphanNode = b.previd;
    }

    // 3. Combine the existing waiting room with the rescued orphans
    const txsToReevaluate = [...mempool, ...orphanedTxids];
    clearMempool();

    // 4. Load the UTXO state of the NEW longest chain tip
    const tipStateRaw = await db.get(`utxo_STATE_${newTip}`).catch(() => null);
    if (!tipStateRaw) return;

    mempoolState = typeof tipStateRaw === "string" ? JSON.parse(tipStateRaw) : tipStateRaw;

    // 5. Re-evaluate every transaction against the new reality
    for (const txid of txsToReevaluate) {
        try {
            const txRaw = await db.get(txid);
            const tx = typeof txRaw === "string" ? JSON.parse(txRaw) : txRaw;

            // Our bouncer handles the rest! If the new chain already included it, 
            // the inputs will be missing, processMempoolTransaction throws an error, 
            // and it safely drops out of the mempool.
            await processMempoolTransaction(tx, txid);
        } catch (e) {
            // It was either already mined in the new chain, or the new chain made it invalid.
        }
    }
    
    console.log(`[Mempool] Rebuild complete. ${mempool.length} transactions survived.`);
}