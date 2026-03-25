import * as net from 'net';
import canonicalize from 'canonicalize';
import { MessageSchema } from './types';
import { db, getObjectId } from './object';
import { validateTransaction, validateBlock } from './validation';

const PORT = 18018;
const NODE_NAME = "kavvadias-in-Borneo";
const VERSION = "0.10.0"; // The required protocol version

// Hard-code the bootstrapping peers provided by the course
const knownPeers = new Set<string>([
    "95.179.158.137:18018",
    "95.179.132.22:18018",
    "45.32.235.245:18018"
]);

// This keeps track of the actual, live network pipes currently connected to us
const activeSockets = new Set<net.Socket>();

const knownTypes = ["hello", "getpeers", "peers", "error"];

// Helper function to send messages in Canonical JSON format
function sendMessage(socket: net.Socket, messageObj: any) {
    const canonicalString = canonicalize(messageObj);
    if (canonicalString) {
        socket.write(canonicalString + '\n');
    }
}

function broadcast(message: any, senderToExclude?: net.Socket) {
    for (const peerSocket of activeSockets) {
        // We don't want to send it back to the peer who just sent it to us!
        if (peerSocket !== senderToExclude) {
            sendMessage(peerSocket, message);
        }
    }
}

const server = net.createServer((socket) => {
    console.log(`[+] New connection from ${socket.remoteAddress}:${socket.remotePort}`);

    // Add the socket to our guestbook immediately!
    activeSockets.add(socket);

    // The Buffer: Our waiting room for incoming data fragments
    let buffer = "";
    // State to track if this specific peer has completed the handshake
    let hasSaidHello = false;

    // Send 'hello' AND 'getpeers' immediately upon connection
    sendMessage(socket, {
        type: "hello",
        version: VERSION,
        agent: NODE_NAME
    });
    sendMessage(socket, {
        type: "getpeers"
    });

    socket.on('data', async (data) => {
        // Add the newly arrived chunk of data to our waiting room
        buffer += data.toString();

        // The Loop: Check if we have at least one complete message (a newline)
        while (buffer.includes('\n')) {
            const newlineIndex = buffer.indexOf('\n');
            const messageString = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);

            if (messageString.trim() === "") continue;

            try {
                // Structural Validation (Replaces all old if/else checks!)
                const rawJson = JSON.parse(messageString);
                const parsedMessage = MessageSchema.parse(rawJson); // Zod checks the rules here!

                // --- THE HANDSHAKE BOUNCER ---
                // If they haven't said hello yet, and this current message IS NOT a hello, kick them out!
                if (!hasSaidHello && parsedMessage.type !== 'hello') {
                    sendMessage(socket, { 
                        type: "error", 
                        name: "INVALID_HANDSHAKE", 
                        description: "You must send a hello message first." 
                    });
                    socket.destroy(); // Hang up the connection
                    return; // Stop processing
                }

                // If they just said hello, update their status so they can send other things!
                if (parsedMessage.type === 'hello') {
                    hasSaidHello = true;
                }

                switch (parsedMessage.type) {
                    case 'hello':
                        break;

                    case 'getpeers':
                        sendMessage(socket, { type: "peers", peers: Array.from(knownPeers) });
                        break;

                    case 'peers':
                        parsedMessage.peers.forEach(peer => knownPeers.add(peer));
                        break;

                    // --- PSET 2: OBJECT EXCHANGE ---
                    case 'ihaveobject':
                        // Check if we already have it in our database
                        const existingObjForIHave = await db.get(parsedMessage.objectid).catch(() => null);

                        // If we don't have it, ask for it!
                        if (!existingObjForIHave) {
                            console.log(`[i] Peer has new object ${parsedMessage.objectid}. Requesting it...`);
                            sendMessage(socket, { type: "getobject", objectid: parsedMessage.objectid });
                        }
                        break;

                    case 'getobject':
                        // Check if we have the requested object
                        const requestedObj = await db.get(parsedMessage.objectid).catch(() => null);

                        // If we have it, send it!
                        if (requestedObj) {
                            sendMessage(socket, { type: "object", object: requestedObj });
                        }
                        break;

                    case 'object':
                        const incomingObject = parsedMessage.object;
                        const newObjectId = getObjectId(incomingObject);
                        const existingObj = await db.get(newObjectId).catch(() => null);

                        // Ignore objects that are already in your database
                        if (!existingObj) {
                            
                            // VALIDATION CHECK ---
                            // If the object is a transaction, it must pass the gauntlet before we save it!
                            if (incomingObject.type === 'transaction') {
                                try {
                                    // This will throw an error if anything is wrong
                                    await validateTransaction(incomingObject);
                                    console.log(`[+] Transaction ${newObjectId} passed validation!`);
                                } catch (error: any) {
                                    console.error(`[!] Invalid transaction received: ${error.message}`);
                                    
                                    // Send the specific error message to the node who sent it
                                    // (error.message will be exactly "INVALID_TX_SIGNATURE", "UNKNOWN_OBJECT", etc.)
                                    sendMessage(socket, { 
                                        type: "error", 
                                        name: error.message, 
                                        description: "Transaction validation failed." 
                                    });
                                    
                                    // BREAK out of the switch statement! 
                                    // Do NOT save it to the database, and do NOT gossip it.
                                    break; 
                                }
                            }
                            else if (incomingObject.type === 'block') {
                                try {
                                    // Use our block validator, and give it the power to ask the network!
                                    await validateBlock(incomingObject, (txid) => {
                                        console.log(`[i] Block is missing tx ${txid}. Asking network...`);
                                        // We use your existing broadcast function to ask everyone!
                                        broadcast({ type: "getobject", objectid: txid }); 
                                    });
                                    
                                    console.log(`[+] Block ${newObjectId} passed validation!`);
                                } catch (error: any) {
                                    console.error(`[!] Invalid block received: ${error.message}`);
                                    sendMessage(socket, { type: "error", name: error.message, description: "Block validation failed." });
                                    break; 
                                }
                            }
                            // -----------------------------

                            // If it's a valid transaction or a block, save it!
                            console.log(`[+] Saving new object: ${newObjectId}`);
                            await db.put(newObjectId, incomingObject); 
                            
                            // Gossip: Broadcast the knowledge of newly received valid objects
                            console.log(`[*] Gossiping new object ${newObjectId} to all peers...`);
                            broadcast({ type: "ihaveobject", objectid: newObjectId }, socket);
                        }
                        break;
                }

            } catch (e) {
                // Zod will automatically throw an error here if the JSON is malformed, 
                // missing fields, or has the wrong variable types!
                console.error(`[!] Validation failed:`, e);
                sendMessage(socket, { type: "error", name: "INVALID_FORMAT", description: "Invalid message format." });
                socket.end();
            }
        }
    });

    socket.on('end', () => {
        console.log(`[-] Connection closed by ${socket.remoteAddress}`);
    });

    // Remove them from the guestbook if they disconnect naturally
    socket.on('close', () => {
        console.log(`[-] Connection closed: ${socket.remoteAddress}:${socket.remotePort}`);
        activeSockets.delete(socket);
    });

    // Remove them from the guestbook if the connection crashes
    socket.on('error', (err) => {
        console.error(`[!] Socket error from ${socket.remoteAddress}:${socket.remotePort} - ${err.message}`);
        activeSockets.delete(socket);
    });
});

server.listen(PORT, () => {
    console.log(`${NODE_NAME} is running and listening on port ${PORT}...`);
});