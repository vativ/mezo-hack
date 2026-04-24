/**
 * Minimal ABI fragments for the three Mezo testnet contracts the server reads.
 *
 * Only the methods this demo actually calls are listed — we don't need the
 * full ABIs. If you extend the demo (e.g. to compute pending redistribution
 * rewards), pull the full ABI from explorer.test.mezo.org or the Mezo
 * subgraphs repo.
 */

export const skipOracleAbi = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export const sortedTrovesAbi = [
  {
    name: "getFirst",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "getLast",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "getNext",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_id", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "getPrev",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_id", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "getSize",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const troveManagerAbi = [
  {
    name: "getCurrentICR",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "_borrower", type: "address" },
      { name: "_price", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getEntireDebtAndColl",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_borrower", type: "address" }],
    outputs: [
      { name: "debt", type: "uint256" },
      { name: "coll", type: "uint256" },
      { name: "pendingMUSDDebtReward", type: "uint256" },
      { name: "pendingCollateralReward", type: "uint256" },
    ],
  },
] as const;
