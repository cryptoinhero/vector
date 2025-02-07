import { Address } from "./basic";
import { BalanceEncoding } from "./contracts";
import { TransferResolver, TransferState } from "./transferDefinitions";
import { tidy } from "./utils";

export type ContextualAddress = {
  address: Address;
  chainId: number;
};

export type BasicMeta = any;

export type TransferMeta = BasicMeta & {
  createdAt: number;
  resolvedAt?: number;
};

// Method params
export type SetupParams = {
  counterpartyIdentifier: string;
  timeout: string;
  networkContext: NetworkContext;
  meta?: any;
};

export type DepositParams = {
  channelAddress: string;
  assetId: string;
  meta?: any;
};

export type CreateTransferParams = {
  channelAddress: string;
  balance: Balance;
  assetId: string;
  transferDefinition: string;
  transferInitialState: TransferState;
  timeout: string;
  meta?: BasicMeta;
};

export type ResolveTransferParams = {
  channelAddress: string;
  transferId: string;
  transferResolver: TransferResolver;
  meta?: any;
};

export const UpdateType = {
  create: "create",
  deposit: "deposit",
  resolve: "resolve",
  setup: "setup",
} as const;
export type UpdateType = typeof UpdateType[keyof typeof UpdateType];

export interface UpdateParamsMap {
  [UpdateType.create]: Omit<CreateTransferParams, "channelAddress">;
  [UpdateType.deposit]: Omit<DepositParams, "channelAddress">;
  [UpdateType.resolve]: Omit<ResolveTransferParams, "channelAddress">;
  [UpdateType.setup]: SetupParams;
}

// Not exactly a channel update, but another protocol method
export type RestoreParams = {
  counterpartyIdentifier: string;
  chainId: number;
};

// When generating an update from params, you need to create an
// identifier to make sure the update remains idempotent. Imagine
// without this and you are trying to apply a `create` update.
// In this case, there is no way to know whether or not you have
// already created the transfer (the `transferId` is not generated
// until you know the nonce the proposed update is executed at).
// This leads to an edgecase where a transfer is created by someone
// who does not hold priority, and installed by the responder. The
// responder then inserts their own update (thereby cancelling yours)
// and you reinsert your "create" update into the queue (causing the
// same transfer to be created 2x). You sign the update identifier so
// you dont run into this problem again when syncing an update and the
// id has been tampered with.
export type UpdateIdentifier = {
  id: string;
  signature: string;
};

// Protocol update
export type UpdateParams<T extends UpdateType = any> = {
  channelAddress: string;
  type: T;
  details: UpdateParamsMap[T];
  id: UpdateIdentifier;
};

export type Balance = {
  amount: string[];
  to: Address[];
};

export enum ChannelCommitmentTypes {
  ChannelState,
  WithdrawData,
}

export const CoreChannelStateEncoding = tidy(`tuple(
  address channelAddress,
  address alice,
  address bob,
  address[] assetIds,
  ${BalanceEncoding}[] balances,
  uint256[] processedDepositsA,
  uint256[] processedDepositsB,
  uint256[] defundNonces,
  uint256 timeout,
  uint256 nonce,
  bytes32 merkleRoot
)`);

export interface CoreChannelState {
  channelAddress: Address;
  alice: Address;
  bob: Address;
  assetIds: Address[];
  balances: Balance[]; // Indexed by assetId
  processedDepositsA: string[]; // Indexed by assetId
  processedDepositsB: string[]; // Indexed by assetId
  defundNonces: string[]; // Indexed by assetId
  timeout: string;
  nonce: number;
  merkleRoot: string;
}

// Includes any additional info that doesn't need to be sent to chain
export type FullChannelState<T extends UpdateType = any> = CoreChannelState & {
  aliceIdentifier: string;
  bobIdentifier: string;
  latestUpdate: ChannelUpdate<T>;
  networkContext: NetworkContext;
  inDispute: boolean;
};

export const CoreTransferStateEncoding = tidy(`tuple(
  address channelAddress,
  bytes32 transferId,
  address transferDefinition,
  address initiator,
  address responder,
  address assetId,
  ${BalanceEncoding} balance,
  uint256 transferTimeout,
  bytes32 initialStateHash
)`);
export interface CoreTransferState {
  channelAddress: Address;
  transferId: string;
  transferDefinition: Address;
  initiator: Address; // either alice or bob
  responder: Address; // either alice or bob
  assetId: Address;
  balance: Balance;
  transferTimeout: string;
  initialStateHash: string;
}

export type FullTransferState<M extends TransferMeta = any> = CoreTransferState & {
  channelFactoryAddress: string;
  chainId: number;
  transferEncodings: string[]; // Initial state encoding, resolver encoding
  transferState: any;
  transferResolver?: any; // undefined iff not resolved
  meta: M; // meta req. values assigned in protocol
  inDispute: boolean;
  channelNonce: number;
  initiatorIdentifier: string;
  responderIdentifier: string;
};

export interface TransferCommitmentData {
  state: CoreTransferState;
  channelFactoryAddress: Address;
  chainId: number;
  merkleProofData: string[];
}

export type ChainAddresses = {
  [chainId: number]: ContractAddresses;
};

export type ContractAddresses = {
  channelFactoryAddress: Address;
  transferRegistryAddress: Address;
};

export type NetworkContext = ContractAddresses & {
  chainId: number;
};

export type ChannelUpdate<T extends UpdateType = any> = {
  id: UpdateIdentifier; // signed by update.fromIdentifier
  channelAddress: string;
  fromIdentifier: string;
  toIdentifier: string;
  type: T;
  nonce: number;
  balance: Balance; // balance change for participants
  assetId: Address;
  details: ChannelUpdateDetailsMap[T];
  aliceSignature?: string;
  bobSignature?: string;
};

// ChannelUpdateDetails should include everything needed to
// apply an update to the channel synchronously. It is what is
// recieved + validated by an update responder
export interface ChannelUpdateDetailsMap {
  [UpdateType.create]: CreateUpdateDetails;
  [UpdateType.deposit]: DepositUpdateDetails;
  [UpdateType.resolve]: ResolveUpdateDetails;
  [UpdateType.setup]: SetupUpdateDetails;
}

export type CreateUpdateDetails = {
  transferId: string;
  balance: Balance; // balance in transfer
  transferDefinition: Address;
  transferTimeout: string;
  transferInitialState: TransferState;
  transferEncodings: string[]; // Included for `applyUpdate`
  merkleRoot: string;
  meta?: BasicMeta;
};

// NOTE: proof data can be reconstructed, do we need to pass it around?
// what does it mean
export type ResolveUpdateDetails = {
  transferId: string;
  transferDefinition: Address;
  transferResolver: TransferResolver;
  merkleRoot: string;
  meta?: BasicMeta;
};

export type DepositUpdateDetails = {
  totalDepositsAlice: string;
  totalDepositsBob: string;
  meta?: BasicMeta;
};

export type SetupUpdateDetails = {
  timeout: string;
  networkContext: NetworkContext;
  meta?: BasicMeta;
};
