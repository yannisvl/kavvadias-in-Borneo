import { test, expect } from "bun:test";
import { getObjectId } from "../src/object";
import type { Block } from "../src/types";

test("Block hash can be smaller than target", () => {
  const genesisBlock: Block = {
    T: "00000000abc00000000000000000000000000000000000000000000000000000",
    created: 1771159355,
    miner: "Marabu",
    nonce: "00dd82159556175752d9ba7349df67bddd237b59183747383f7b720e85c32347",
    note: "Financial Times 2026-02-13: Crypto's battle with the banks is splitting Trump's base",
    previd: null,
    txids: [],
    type: "block"
  };

  const hash = getObjectId(genesisBlock);
  expect(hash < genesisBlock.T).toBe(true);
});
