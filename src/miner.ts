import { db, getObjectId } from "./object";
import type { Block, Transaction } from "./types";
import { broadcast } from "./index";
import canonicalize from "canonicalize";
import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as crypto from "crypto";
import * as fs from 'fs';

const STUDENT_IDS: never[] = []; 

export async function startMiner(magicTxid: string) {
    console.log(`\n Miner starting! Target transaction: ${magicTxid}`);

    // 1. Get our current absolute best tip
    let currentTip = await db.get('longest_chain_tip').catch(() => null);
    let tipHeightRaw = currentTip ? await db.get(`height_${currentTip}`).catch(() => "0") : "0";
    let tipHeight = parseInt(tipHeightRaw);

    // 2. Build the Coinbase Transaction to get paid 50 BU
    const coinbaseTx: Transaction = {
        type: "transaction",
        height: tipHeight + 1,
        outputs: [{ 
            pubkey: "0000000000000000000000000000000000000000000000000000000000000000", 
            value: 50000000000000 
        }]
    };
    let coinbaseTxid = getObjectId(coinbaseTx);
    await db.put(coinbaseTxid, coinbaseTx);

    // 3. Build the Block Template
    const blockTemplate: Block = {
        type: "block",
        txids: [coinbaseTxid, magicTxid], // Include the reward + the required tx
        nonce: "",
        previd: currentTip,
        created: Math.floor(Date.now() / 1000),
        T: "00000000abc00000000000000000000000000000000000000000000000000000",
        miner: "kavvadias-in-Borneo",
        studentids: STUDENT_IDS
    };

    let hashes = 0;
    const targetHex = blockTemplate.T;

    // 4. The Infinite Hashing Loop
    while (true) {
        // Every 5,000 hashes, we pause to let the network breathe and check for chain reorgs
        if (hashes % 5000 === 0) {
            const freshTip = await db.get('longest_chain_tip').catch(() => null);
            
            // If the network advanced while we were mining, update the template!
            if (freshTip !== currentTip) {
                console.log(`\n[Miner] Chain advanced to ${freshTip?.substring(0,8)}... Updating template!`);
                currentTip = freshTip;
                tipHeightRaw = currentTip ? await db.get(`height_${currentTip}`).catch(() => "0") : "0";
                tipHeight = parseInt(tipHeightRaw);
                
                blockTemplate.previd = currentTip;
                blockTemplate.created = Math.floor(Date.now() / 1000);
                
                coinbaseTx.height = tipHeight + 1;
                coinbaseTxid = getObjectId(coinbaseTx);
                await db.put(coinbaseTxid, coinbaseTx);
                blockTemplate.txids[0] = coinbaseTxid;
            }
            
            process.stdout.write(`\r[Miner] Hashes computed: ${hashes}`);
            
            // Yield the event loop so index.ts can continue answering peers!
            await new Promise(resolve => setImmediate(resolve)); 
        }

        // Generate a random 32-byte (64 hex char) nonce
        blockTemplate.nonce = crypto.randomBytes(32).toString('hex');
        
        // Hash it
        const blockStr = canonicalize(blockTemplate);
        if (!blockStr) continue;
        const hash = bytesToHex(blake2s(new TextEncoder().encode(blockStr)));
        hashes++;

        // Did we win?
        if (hash < targetHex) {
            console.log(`\n\nBLOCK MINED!`);
            console.log(`Hash: ${hash}`);
            
            const blockId = getObjectId(blockTemplate);
            
            // Gossip to the net!
            broadcast({ type: "object", object: blockTemplate });
            
            console.log(`\n Submit this Block ID to Gradescope: ${blockId}\n`);

            const timeStr = new Date().toLocaleString();
            const logMessage = `\n--- MINED ON: ${timeStr} ---\nBlock ID (Submit to Gradescope): ${blockId}\nHash: ${hash}\n`;
            
            try {
                // appendFileSync will create the file if it doesn't exist, 
                // and add to the bottom of it if it does.
                fs.appendFileSync('mined_blocks.txt', logMessage);
                console.log(`Successfully saved Block ID to mined_blocks.txt`);
            } catch (err) {
                console.error("Could not write to file:", err);
            }
            
            break;
        }
    }
}