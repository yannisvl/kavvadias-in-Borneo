import { Level } from 'level';
import canonicalize from 'canonicalize';
import { blake2s } from '@noble/hashes/blake2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// Initialize the Database
// This creates a folder called 'marabu-db' in your project to save objects to the hard drive.
export const db = new Level<string, any>('./marabu-db', { valueEncoding: 'json' });

// Implement the ObjectID Function
// Takes any Javascript object, canonicalizes it, hashes it, and returns a hex string.
export function getObjectId(object: any): string {
    // Step A: Canonicalize the object so the formatting is strictly identical everywhere
    const canonicalString = canonicalize(object);
    
    if (!canonicalString) {
        throw new Error("Failed to canonicalize object");
    }

    // Step B: Convert the string into bytes, then hash it using BLAKE2s
    const hashBytes = blake2s(new TextEncoder().encode(canonicalString));

    // Step C: Convert the resulting bytes into a readable Hexadecimal string
    return bytesToHex(hashBytes);
}