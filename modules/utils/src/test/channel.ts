import {
  UpdateType,
  ChannelUpdate,
  ChannelUpdateDetailsMap,
  FullChannelState,
  UpdateParams,
  UpdateParamsMap,
  CreateUpdateDetails,
  DepositUpdateDetails,
  ResolveUpdateDetails,
  SetupUpdateDetails,
  NetworkContext,
  IChannelSigner,
  HashlockTransferState,
  FullTransferState,
  DEFAULT_TRANSFER_TIMEOUT,
} from "@connext/vector-types";
import { v4 as uuidV4 } from "uuid";

import { ChannelSigner } from "../channelSigner";

import { createTestFullHashlockTransferState, createTestHashlockTransferState } from "./transfers";
import { mkAddress, mkPublicIdentifier, mkBytes32, mkHash, mkSig } from "./util";

// Helper partial types for test helpers
export type PartialChannelUpdate<T extends UpdateType> = Partial<
  Omit<ChannelUpdate<T>, "details"> & { details: Partial<ChannelUpdateDetailsMap[T]> }
>;

export type PartialFullChannelState<T extends UpdateType> = Partial<
  Omit<FullChannelState, "latestUpdate" | "networkContext"> & {
    latestUpdate: PartialChannelUpdate<T>;
    networkContext: Partial<NetworkContext>;
  }
>;

export type PartialUpdateParams<T extends UpdateType> = Partial<
  Omit<UpdateParams<T>, "details"> & { details?: Partial<UpdateParamsMap[T]> }
>;

export function createTestUpdateParams<T extends UpdateType>(
  type: T,
  overrides: PartialUpdateParams<T> = {},
): UpdateParams<T> {
  const base = {
    channelAddress: overrides.channelAddress ?? mkAddress("0xccc"),
    type,
    id: {
      id: uuidV4(),
      signature: mkSig("0xcceeffaa6655"),
      ...(overrides.id ?? {}),
    },
  };

  let details: any;
  switch (type) {
    case UpdateType.setup:
      details = {
        counterpartyIdentifier: mkPublicIdentifier("vectorBdea4"),
        timeout: "1200",
        networkContext: {
          chainId: 2,
          channelFactoryAddress: mkAddress("0xccccddddaaaaaffff"),
          transferRegistryAddress: mkAddress("0xdddeffff2222"),
        },
      } as SetupUpdateDetails;
      break;
    case UpdateType.deposit:
      details = {
        channelAddress: base.channelAddress,
        assetId: mkAddress(),
      };
      break;
    case UpdateType.create:
      details = {
        channelAddress: base.channelAddress,
        balance: { to: [mkAddress("0x111"), mkAddress("0x222")], amount: ["15", "0"] },
        assetId: mkAddress("0x0"),
        transferDefinition: mkAddress("0xdef"),
        transferInitialState: createTestHashlockTransferState(),
        timeout: "1",
        meta: { test: "meta" },
      };
      break;
    case UpdateType.resolve:
      details = {
        channelAddress: base.channelAddress,
        transferId: mkBytes32("0xabcdef"),
        transferResolver: { preImage: mkBytes32("0xcdef") },
        meta: { test: "meta" },
      };
      break;
  }

  const { details: detailOverrides, ...defaultOverrides } = overrides;

  return {
    ...base,
    details: {
      ...details,
      channelAddress: base.channelAddress,
      ...(detailOverrides ?? {}),
    },
    ...defaultOverrides,
  };
}

export function createTestChannelUpdate<T extends UpdateType>(
  type: T,
  overrides: PartialChannelUpdate<T> = {},
): ChannelUpdate<T> {
  // Generate the base update values
  const baseUpdate = {
    assetId: mkAddress("0x0"),
    balance: {
      amount: ["1", "0"],
      to: [mkAddress("0xaaa"), mkAddress("0xbbb")],
    },
    channelAddress: mkAddress("0xccc"),
    fromIdentifier: mkPublicIdentifier("vectorA"),
    nonce: 1,
    aliceSignature: mkSig("0x0001"),
    bobSignature: mkSig("0x0002"),
    toIdentifier: mkPublicIdentifier("vectorB"),
    type,
    id: {
      id: uuidV4(),
      signature: mkSig("0x00003"),
    },
  };

  // Get details from overrides
  const { details: detailOverrides, ...defaultOverrides } = overrides;

  // Assign detail defaults based on update
  let details: CreateUpdateDetails | DepositUpdateDetails | ResolveUpdateDetails | SetupUpdateDetails;
  switch (type) {
    case UpdateType.setup:
      details = {
        networkContext: {
          chainId: 1337,
          channelFactoryAddress: mkAddress("0xccccddddaaaaaffff"),
          transferRegistryAddress: mkAddress("0xffffeeeeeecccc"),
        },
        timeout: "1",
      } as SetupUpdateDetails;
      break;
    case UpdateType.deposit:
      details = {
        totalDepositsAlice: "10",
        totalDepositsBob: "5",
      } as DepositUpdateDetails;
      break;
    case UpdateType.create:
      const createDeets: CreateUpdateDetails = {
        merkleRoot: mkBytes32("0xeeeeaaaaa333344444"),
        transferDefinition: mkAddress("0xdef"),
        transferId: mkBytes32("0xaaaeee"),
        transferEncodings: ["state", "resolver"],
        balance: { to: [mkAddress("0x111"), mkAddress("0x222")], amount: ["7", "0"] },
        transferInitialState: {
          lockHash: mkBytes32("0xlockHash"),
          expiry: "0",
        },
        transferTimeout: DEFAULT_TRANSFER_TIMEOUT.toString(),
      };
      details = { ...createDeets };
      break;
    case UpdateType.resolve:
      const resolveDetails: ResolveUpdateDetails = {
        merkleRoot: mkBytes32("0xeeeaaa32333"),
        transferDefinition: mkAddress("0xdef"),
        transferId: mkBytes32("0xeee3332222111"),
        transferResolver: { preImage: mkBytes32("0xpre") },
      };
      details = { ...resolveDetails };
      break;
  }
  return {
    ...baseUpdate,
    details: {
      ...details,
      ...(detailOverrides ?? {}),
    },
    ...(defaultOverrides ?? {}),
  } as ChannelUpdate<T>;
}

export function createTestChannelState<T extends UpdateType = typeof UpdateType.setup>(
  type: T,
  overrides: PartialFullChannelState<T> = {},
  transferOverrides: Partial<FullTransferState> = {},
): { channel: FullChannelState<T>; transfer: FullTransferState } {
  // Get some default values that should be consistent between
  // the channel state and the channel update
  const publicIdentifiers = [
    overrides.aliceIdentifier ?? mkPublicIdentifier("vectorA"),
    overrides.bobIdentifier ?? mkPublicIdentifier("vectorB"),
  ];
  const participants = [overrides.alice ?? mkAddress("0xaaa"), overrides.bob ?? mkAddress("0xbbb")];
  const channelAddress = overrides.channelAddress ?? mkAddress("0xccc");
  const assetIds = overrides.assetIds ?? [mkAddress("0x0"), mkAddress("0x1")];
  const nonce = overrides.nonce ?? 1;
  const defundNonces = overrides.defundNonces ?? ["1", "1"];

  const {
    latestUpdate: latestUpdateOverrides,
    networkContext: networkContextOverride,
    inDispute: inDisputeOverride,
    ...rest
  } = overrides;

  const latestUpdate = createTestChannelUpdate(type, {
    channelAddress,
    fromIdentifier: publicIdentifiers[0],
    toIdentifier: publicIdentifiers[1],
    assetId: assetIds[0],
    nonce,
    ...latestUpdateOverrides,
  });

  latestUpdate.details = { ...latestUpdate.details, ...transferOverrides };

  const networkContext =
    type === UpdateType.setup
      ? { ...(latestUpdate.details as SetupUpdateDetails).networkContext }
      : {
          chainId: 1337,
          channelFactoryAddress: mkAddress("0xccccddddaaaaaffff"),
          transferRegistryAddress: mkAddress("0xcc22233323132"),
          ...(networkContextOverride ?? {}),
        };

  const inDispute = inDisputeOverride ?? false;
  let transfer: FullTransferState | undefined;
  if (type === "create" || type === "resolve") {
    transfer = createTestFullHashlockTransferState();
    transfer.balance = latestUpdate.balance ?? transfer.balance;
    transfer.meta = type === "create" ? (latestUpdate.details as any).meta : undefined;
    transfer.transferDefinition =
      type === "create" ? (latestUpdate.details as CreateUpdateDetails).transferDefinition : undefined;
    (latestUpdate.details as CreateUpdateDetails).meta =
      type === "create" ? (latestUpdate.details as any).meta : undefined;
    transfer.channelFactoryAddress = networkContext.channelFactoryAddress ?? transfer.channelFactoryAddress;
    transfer.inDispute = inDispute ?? transfer.inDispute;
    transfer.initiator = latestUpdate.fromIdentifier === publicIdentifiers[0] ? participants[0] : participants[1];
    transfer.responder = latestUpdate.toIdentifier === publicIdentifiers[0] ? participants[0] : participants[1];
    transfer.initiatorIdentifier =
      latestUpdate.fromIdentifier === publicIdentifiers[0] ? publicIdentifiers[0] : publicIdentifiers[1];
    transfer.responderIdentifier =
      latestUpdate.toIdentifier === publicIdentifiers[0] ? publicIdentifiers[0] : publicIdentifiers[1];
    transfer.transferDefinition =
      (latestUpdate.details as CreateUpdateDetails).transferDefinition ?? transfer.transferDefinition;
    transfer.transferEncodings =
      (latestUpdate.details as CreateUpdateDetails).transferEncodings ?? transfer.transferEncodings;
    transfer.initialStateHash = transferOverrides.initialStateHash ?? transfer.initialStateHash;
    transfer.transferId = (latestUpdate.details as CreateUpdateDetails).transferId ?? transfer.transferId;
    transfer.transferResolver =
      type === "resolve" ? (latestUpdate.details as ResolveUpdateDetails).transferResolver : undefined;
    transfer.transferState =
      {
        balance: (latestUpdate.details as CreateUpdateDetails).balance,
        ...(latestUpdate.details as CreateUpdateDetails).transferInitialState,
      } ?? transfer.transferState;
    transfer.transferTimeout =
      (latestUpdate.details as CreateUpdateDetails).transferTimeout ?? transfer.transferTimeout;
    transfer.chainId = networkContext.chainId;
    transfer.channelAddress = channelAddress;
  }

  return {
    channel: {
      assetIds,
      balances: [
        // assetId0
        {
          amount: ["1", "2"],
          to: [...participants],
        },
        // assetId1
        {
          amount: ["1", "2"],
          to: [...participants],
        },
      ],
      processedDepositsA: ["1", "2"],
      processedDepositsB: ["1", "2"],
      channelAddress,
      latestUpdate,
      merkleRoot: mkHash(),
      networkContext,
      nonce,
      alice: participants[0],
      bob: participants[1],
      aliceIdentifier: publicIdentifiers[0],
      bobIdentifier: publicIdentifiers[1],
      timeout: "1",
      defundNonces,
      inDispute,
      ...rest,
    },
    transfer,
  };
}

export function createTestChannelStateWithSigners<T extends UpdateType = typeof UpdateType.setup>(
  signers: IChannelSigner[],
  type: T,
  overrides: PartialFullChannelState<T> = {},
): FullChannelState {
  const signerOverrides = {
    aliceIdentifier: signers[0].publicIdentifier,
    bobIdentifier: signers[1].publicIdentifier,
    alice: signers[0].address,
    bob: signers[1].address,
    ...(overrides ?? {}),
  };
  return createTestChannelState(type, signerOverrides).channel as FullChannelState;
}

export function createTestChannelUpdateWithSigners<T extends UpdateType = typeof UpdateType.setup>(
  signers: ChannelSigner[],
  type: T,
  overrides: PartialChannelUpdate<T> = {},
): ChannelUpdate<T> {
  // The only update type where signers could matter
  // is when providing the transfer initial state to the
  // function
  const details: any = {};
  if (type === UpdateType.create) {
    details.transferInitialState = createTestHashlockTransferState({
      ...((((overrides as unknown) as ChannelUpdate<"create">).details?.transferInitialState ??
        {}) as HashlockTransferState),
    });
  }

  const signerOverrides = {
    balance: {
      to: signers.map((s) => s.address),
      amount: ["1", "0"],
    },
    fromIdentifier: signers[0].publicIdentifier,
    toIdentifier: signers[1].publicIdentifier,
    ...(overrides ?? {}),
  };

  return createTestChannelUpdate(type, signerOverrides);
}
