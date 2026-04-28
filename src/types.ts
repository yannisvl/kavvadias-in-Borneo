import { z } from 'zod';

export const MINING_TARGET = "00000000abc00000000000000000000000000000000000000000000000000000";

// The ID Validator (BLAKE2s hashes are always exactly 64 hexadecimal characters)
// The network protocol expects hex strings for hashes
const ObjectIdSchema = z.string().regex(/^[0-9a-f]{64}$/, "Must be a 64-character lowercase hex string");

// Transaction Sub-components
const OutpointSchema = z.object({
    txid: ObjectIdSchema, // Must be a valid 64-char hex string
    index: z.number().int().nonnegative() // "natural number (zero-based)"
});

const InputSchema = z.object({
    outpoint: OutpointSchema,
    sig: z.string().regex(/^[0-9a-f]+$/, "Signature must be hex")
});

const OutputSchema = z.object({
    pubkey: z.string().regex(/^[0-9a-f]+$/, "Pubkey must be hex"),
    value: z.number().int().nonnegative() // "non-negative integer indicating how much value"
});

// The Transaction Object Itself
export const TransactionSchema = z.object({
    type: z.literal('transaction'),
    // Regular transactions have inputs and outputs
    inputs: z.array(InputSchema).optional(),
    outputs: z.array(OutputSchema).optional(),
    // Coinbase transactions have a height instead of inputs
    height: z.number().int().nonnegative().optional()
}).refine(tx => {
    // Custom validation: It must be EITHER a normal tx (has inputs) OR a coinbase tx (has height)
    const isCoinbase = tx.height !== undefined && tx.inputs === undefined;
    const isNormal = tx.inputs !== undefined && tx.inputs.length > 0 && tx.height === undefined;
    return isCoinbase || isNormal;
}, { message: "Transaction must be either a valid coinbase or have at least one input." });


// The Block Object Schema
export const BlockSchema = z.object({
    type: z.literal('block'),
    txids: z.array(ObjectIdSchema), // Array of exactly 64-char hex strings
    nonce: z.string().regex(/^[0-9a-f]{64}$/, "Nonce must be a 32-byte hex string"),
    previd: ObjectIdSchema.nullable(), // Nullable because the Genesis block has a null previd
    created: z.number().int(), // UNIX timestamp
    T: z.literal(MINING_TARGET),
    miner: z.string().max(128).optional(),
    note: z.string().max(128).optional(),
    studentids: z.array(z.string().max(128)).max(10).optional()
});

export const GetChainTipMessageSchema = z.object({
    type: z.literal('getchaintip')
});

export const ChainTipMessageSchema = z.object({
    type: z.literal('chaintip'),
    blockid: ObjectIdSchema
});

// Update the ObjectMessageSchema to use this new rule!
export const ObjectMessageSchema = z.object({
    type: z.literal('object'),
    object: z.union([TransactionSchema, BlockSchema])
});


// The Three New Object Exchange Messages
export const IHaveObjectMessageSchema = z.object({
    type: z.literal('ihaveobject'),
    objectid: ObjectIdSchema
});

export const GetObjectMessageSchema = z.object({
    type: z.literal('getobject'),
    objectid: ObjectIdSchema
});

// Messages from PSET 1
export const HelloMessageSchema = z.object({
    type: z.literal('hello'),
    version: z.string().regex(/^0\.10\.\d+$/, "Version must be 0.10.x"),
    agent: z.string().optional()
});

export const GetPeersMessageSchema = z.object({
    type: z.literal('getpeers')
});

export const PeersMessageSchema = z.object({
    type: z.literal('peers'),
    peers: z.array(z.string())
});

export const ErrorMessageSchema = z.object({
    type: z.literal('error'),
    name: z.string(),
    description: z.string()
});

// The Master Validator
// This checks any incoming message against ALL the rules above.
export const MessageSchema = z.discriminatedUnion('type', [
    HelloMessageSchema, 
    GetPeersMessageSchema, 
    PeersMessageSchema, 
    ErrorMessageSchema,
    IHaveObjectMessageSchema,
    GetObjectMessageSchema,
    ObjectMessageSchema,
    GetChainTipMessageSchema,
    ChainTipMessageSchema
]);


// --- UTXO TYPES ---
// A single Unspent Transaction Output
export type UTXO = {
    pubkey: string; //transaction id
    value: number; // output index
};


// TypeScript Types (so VS Code knows exactly what these look like)
export type Message = z.infer<typeof MessageSchema>;
export type NetworkObject = Record<string, any>;
export type Transaction = z.infer<typeof TransactionSchema>;
export type Block = z.infer<typeof BlockSchema>;

// The UTXO Set is a dictionary mapping "txid:index" to a UTXO
export type UTXOSet = Record<string, UTXO>;