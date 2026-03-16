import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import * as net from 'net';
import canonicalize from 'canonicalize';

const PORT = 18018;
const HOST = '127.0.0.1';
let serverProcess: any;

describe("=== PSET 1: TCP Network Integration ===", () => {

    // SETUP: Before any tests run, start the actual server!
    beforeAll(async () => {
        console.log("Starting server in the background...");
        // Bun.spawn runs your server exactly like typing it in the terminal
        serverProcess = Bun.spawn(["bun", "run", "src/index.ts"]);
        
        // Wait 1 second to give the server time to fully open the port
        await new Promise(resolve => setTimeout(resolve, 1000));
    });

    // TEARDOWN: After tests finish, kill the server so it doesn't run forever.
    afterAll(() => {
        console.log("Shutting down server...");
        serverProcess.kill();
    });

    // --- THE TESTS ---

    test("1. Server rejects premature 'getpeers' and drops connection", async () => {
        return new Promise((resolve, reject) => {
            const client = new net.Socket();
            let receivedError = false;

            client.connect(PORT, HOST, () => {
                // Send getpeers before saying hello!
                client.write(canonicalize({ type: "getpeers" }) + "\n");
            });

            let buffer = "";
            client.on('data', (data) => {
                buffer += data.toString();
                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const msgStr = buffer.slice(0, newlineIndex);
                    buffer = buffer.slice(newlineIndex + 1);
                    
                    if (msgStr.trim()) {
                        const msg = JSON.parse(msgStr);
                        // Look through all replies to find the specific error
                        if (msg.type === "error" && msg.name === "INVALID_HANDSHAKE") {
                            receivedError = true;
                        }
                    }
                }
            });

            // We wait for the server to hang up the phone
            client.on('close', () => {
                expect(receivedError).toBe(true); // Did we get the error before the hangup?
                resolve(true);
            });

            client.on('error', () => { /* ignore normal socket hangup errors */ });
        });
    });

    test("2. Server accepts valid 'hello' and replies with its own", async () => {
        return new Promise((resolve, reject) => {
            const client = new net.Socket();
            let receivedHello = false;

            client.connect(PORT, HOST, () => {
                // This time, we follow the rules
                client.write(canonicalize({ type: "hello", version: "0.10.0", agent: "TestClient" }) + "\n");
            });

            client.on('data', (data) => {
                const messages = data.toString().split('\n').filter(m => m.trim() !== '');
                
                for (const msgStr of messages) {
                    const msg = JSON.parse(msgStr);
                    if (msg.type === "hello") {
                        receivedHello = true;
                        // Verify the server's version strictly matches the 0.10.x requirement
                        expect(msg.version).toMatch(/^0\.10\.\d+$/); 
                    }
                }

                if (receivedHello) {
                    client.destroy();
                    resolve(true);
                }
            });

            client.on('error', reject);
        });
    });

});