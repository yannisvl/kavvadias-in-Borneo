import * as net from 'net';
import canonicalize from 'canonicalize';

const PORT = 18018;
const NODE_NAME = "kavvadias-in-Borneo";
const VERSION = "0.10.0"; // The required protocol version

// 1. Hard-code the bootstrapping peers provided by the course staff
const knownPeers = new Set<string>([
    "95.179.158.137:18018",
    "95.179.132.22:18018",
    "45.32.235.245:18018"
]);

const knownTypes = ["hello", "getpeers", "peers", "error"];

// Helper function to send messages in Canonical JSON format
function sendMessage(socket: net.Socket, messageObj: any) {
    const canonicalString = canonicalize(messageObj);
    if (canonicalString) {
        socket.write(canonicalString + '\n');
    }
}

const server = net.createServer((socket) => {
    console.log(`[+] New connection from ${socket.remoteAddress}:${socket.remotePort}`);

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

    socket.on('data', (data) => {
        // Add the newly arrived chunk of data to our waiting room
        buffer += data.toString();

        // The Loop: Check if we have at least one complete message (a newline)
        while (buffer.includes('\n')) {
            // Find where the first newline is
            const newlineIndex = buffer.indexOf('\n');
            
            // Extract everything up to the newline as our message string
            const messageString = buffer.slice(0, newlineIndex);
            
            // Keep everything after the newline in the buffer for next time
            buffer = buffer.slice(newlineIndex + 1); 

            // Ignore empty lines just in case
            if (messageString.trim() === "") continue;

            // The Parser: Try to read the message as JSON
            try {
                const parsedMessage = JSON.parse(messageString);

                // Every valid message must be a JSON object with a "type" string
                if (typeof parsedMessage !== 'object' || parsedMessage === null || typeof parsedMessage.type !== 'string') {
                    throw new Error("Missing type or not a valid dictionary");
                }

                if (!knownTypes.includes(parsedMessage.type)) {
                    throw new Error("Unknown message type");
                }

                // Verify version
                if (parsedMessage.type === 'hello') {
                    if (typeof parsedMessage.version !== 'string' || !parsedMessage.version.startsWith('0.10.')) {
                        throw new Error("Invalid hello version format");
                    }
                } else if (parsedMessage.type === 'peers') {
                    // Check if list of peers is an array of strings
                    if (!Array.isArray(parsedMessage.peers)) {
                        throw new Error("Invalid peers format");
                    }
                }

                // Handshake Validation Logic
                if (!hasSaidHello) {
                    if (parsedMessage.type !== 'hello') {
                        // They sent a valid JSON message, but it wasn't 'hello'
                        console.error(`[!] Invalid handshake from ${socket.remoteAddress}`);
                        sendMessage(socket, {
                            type: "error",
                            name: "INVALID_HANDSHAKE",
                            description: "First message must be a hello message."
                        });
                        socket.end();
                        return; // Stop processing this chunk
                    } else {
                        // Handshake is complete!
                        hasSaidHello = true;
                        console.log(`[✓] Handshake successful with ${socket.remoteAddress} (Agent: ${parsedMessage.agent || 'Unknown'})`);
                        continue; 
                    }
                }

                // Handle messages after handshake
                if (parsedMessage.type === 'getpeers') {
                    console.log(`[i] Peer requested our peer list. Sending ${knownPeers.size} peers.`);
                    sendMessage(socket, {
                        type: "peers",
                        peers: Array.from(knownPeers)
                    });
                } 
                else if (parsedMessage.type === 'peers') {
                    console.log(`[i] Received a list of ${parsedMessage.peers.length} peers.`);
                    // Add each received peer to our known list
                    parsedMessage.peers.forEach((peer: string) => {
                        if (typeof peer === 'string') {
                            knownPeers.add(peer);
                        }
                    });
                    console.log(`[i] We now know ${knownPeers.size} total peers.`);
                }                
            } 
            catch (e) {
                // The Error Handler: It wasn't valid JSON!
                console.error(`Invalid format received from ${socket.remoteAddress}. Disconnecting.`);
                
                // Create the exact error object required by the protocol
                sendMessage(socket, {
                    type: "error",
                    name: "INVALID_FORMAT",
                    description: "Message is not valid JSON or missing required fields."
                });
                socket.end();
            }
        }
    });

    socket.on('end', () => {
        console.log(`[-] Connection closed by ${socket.remoteAddress}`);
    });

    socket.on('error', (err) => {
        console.error(`[ERROR] Socket error: ${err.message}`);
    });
});

server.listen(PORT, () => {
    console.log(`🚀 ${NODE_NAME} is running and listening on port ${PORT}...`);
});