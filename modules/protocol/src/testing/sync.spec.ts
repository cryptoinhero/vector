/* eslint-disable @typescript-eslint/no-empty-function */
import {
  ChannelSigner,
  getRandomChannelSigner,
  createTestChannelUpdateWithSigners,
  createTestChannelStateWithSigners,
  createTestFullHashlockTransferState,
  createTestUpdateParams,
  mkAddress,
  mkSig,
  expect,
  MemoryStoreService,
  MemoryMessagingService,
  getTestLoggers,
  createTestChannelUpdate,
} from "@connext/vector-utils";
import {
  UpdateType,
  ChannelUpdate,
  Result,
  UpdateParams,
  FullChannelState,
  FullTransferState,
  IVectorChainReader,
} from "@connext/vector-types";
import { AddressZero } from "@ethersproject/constants";
import pino from "pino";
import Sinon from "sinon";
import { VectorChainReader } from "@connext/vector-contracts";

// Import as full module for easy sinon function mocking
import { QueuedUpdateError } from "../errors";
import * as vectorUtils from "../utils";
import * as vectorValidation from "../validate";
import { inbound, outbound } from "../sync";

import { env } from "./env";

describe("inbound", () => {
  const chainProviders = env.chainProviders;
  const [_, providerUrl] = Object.entries(chainProviders)[0] as string[];
  const logger = pino().child({
    testName: "inbound",
  });
  const externalValidation = {
    validateOutbound: (params: UpdateParams<any>, state: FullChannelState, activeTransfers: FullTransferState[]) =>
      Promise.resolve(Result.ok(undefined)),
    validateInbound: (update: ChannelUpdate<any>, state: FullChannelState, activeTransfers: FullTransferState[]) =>
      Promise.resolve(Result.ok(undefined)),
  };

  let signers: ChannelSigner[];
  let chainService: Sinon.SinonStubbedInstance<VectorChainReader>;

  let validationStub: Sinon.SinonStub;

  beforeEach(async () => {
    signers = Array(2)
      .fill(0)
      .map(() => getRandomChannelSigner(providerUrl));
    chainService = Sinon.createStubInstance(VectorChainReader);

    // Set the validation stub
    validationStub = Sinon.stub(vectorValidation, "validateAndApplyInboundUpdate");
  });

  afterEach(() => {
    Sinon.restore();
  });

  it("should return an error if the update does not advance state", async () => {
    // Set the stored values
    const activeTransfers = [];
    const channel = createTestChannelStateWithSigners(signers, UpdateType.setup, { nonce: 1 });

    // Generate an update at nonce = 1
    const update = createTestChannelUpdateWithSigners(signers, UpdateType.setup, { nonce: 1 });

    const result = await inbound(
      update,
      {} as any,
      activeTransfers,
      channel,
      chainService as IVectorChainReader,
      externalValidation,
      signers[1],
      logger,
    );
    expect(result.isError).to.be.true;
    const error = result.getError()!;
    expect(error.message).to.be.eq(QueuedUpdateError.reasons.StaleUpdate);
  });

  it("should fail if validating the update fails", async () => {
    // Set the stored values
    const activeTransfers = [];
    const channel = createTestChannelStateWithSigners(signers, UpdateType.setup, { nonce: 1 });

    // Generate the update
    const update: ChannelUpdate<typeof UpdateType.deposit> = createTestChannelUpdateWithSigners(
      signers,
      UpdateType.deposit,
      {
        nonce: 2,
      },
    );
    // Set the validation stub
    validationStub.resolves(
      Result.fail(new QueuedUpdateError(QueuedUpdateError.reasons.ExternalValidationFailed, update, {} as any)),
    );

    const result = await inbound(
      update,
      channel.latestUpdate,
      activeTransfers,
      channel,
      chainService as IVectorChainReader,
      externalValidation,
      signers[1],
      logger,
    );

    expect(result.isError).to.be.true;
    const error = result.getError()!;
    expect(error.message).to.be.eq(QueuedUpdateError.reasons.ExternalValidationFailed);
    // Make sure the calls were correctly performed
    expect(validationStub.callCount).to.be.eq(1);
  });

  it("should update if state is in sync", async () => {
    // Set the stored values
    const activeTransfers = [];
    const channel = createTestChannelStateWithSigners(signers, UpdateType.setup, {
      nonce: 1,
      latestUpdate: { nonce: 1 },
    });

    // Set the validation stub
    validationStub.resolves(Result.ok({ updatedChannel: { nonce: 3 } as any }));

    // Create the update to sync with (in this case, a deposit)
    const update = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, {
      nonce: 2,
    });

    // Call `inbound`
    const result = await inbound(
      update,
      channel.latestUpdate,
      activeTransfers,
      channel,
      chainService as IVectorChainReader,
      externalValidation,
      signers[1],
      logger,
    );
    expect(result.getError()).to.be.undefined;

    // Verify callstack
    expect(validationStub.callCount).to.be.eq(1);
  });

  describe("If our previous update is behind, it should try to sync", () => {
    it("should fail if there is no missed update", async () => {
      // Set the stored values
      const activeTransfers = [];
      const channel = createTestChannelStateWithSigners(signers, UpdateType.setup, { nonce: 1 });

      // Create the received update
      const update = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, { nonce: 4 });

      // Create the update to sync
      const result = await inbound(
        update,
        undefined as any,
        activeTransfers,
        channel,
        chainService as IVectorChainReader,
        externalValidation,
        signers[1],
        logger,
      );
      expect(result.getError()?.message).to.be.eq(QueuedUpdateError.reasons.StaleUpdate);
    });

    it("should fail if the update to sync is a setup update", async () => {
      // Set the stored values
      const activeTransfers = [];
      const channel = createTestChannelStateWithSigners(signers, UpdateType.setup, { nonce: 1 });

      // Create the received update
      const update = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, { nonce: 4 });

      // Create the update to sync
      const result = await inbound(
        update,
        channel.latestUpdate,
        activeTransfers,
        undefined,
        chainService as IVectorChainReader,
        externalValidation,
        signers[1],
        logger,
      );
      expect(result.getError()?.message).to.be.eq(QueuedUpdateError.reasons.CannotSyncSetup);
    });

    it("should fail if the missed update is not double signed", async () => {
      // Set the stored values
      const activeTransfers = [];
      const channel = createTestChannelStateWithSigners(signers, UpdateType.setup, { nonce: 1 });

      // Create the received update
      const update = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, { nonce: 4 });

      // Create previous update
      const toSync = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, {
        nonce: 2,
        aliceSignature: undefined,
      });

      // Create the update to sync
      const result = await inbound(
        update,
        toSync,
        activeTransfers,
        channel,
        chainService as IVectorChainReader,
        externalValidation,
        signers[1],
        logger,
      );
      expect(result.getError()?.message).to.be.eq(QueuedUpdateError.reasons.SyncSingleSigned);
    });

    it("should fail if the update to sync is not the next update (i.e. off by more than 1 transition)", async () => {
      // Set the stored values
      const activeTransfers = [];
      const channel = createTestChannelStateWithSigners(signers, UpdateType.setup, { nonce: 1 });

      // Create the received update
      const update = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, { nonce: 4 });

      // Create previous update
      const toSync = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, {
        nonce: 8,
      });

      // Create the update to sync
      const result = await inbound(
        update,
        toSync,
        activeTransfers,
        channel,
        chainService as IVectorChainReader,
        externalValidation,
        signers[1],
        logger,
      );
      expect(result.getError()?.message).to.be.eq(QueuedUpdateError.reasons.RestoreNeeded);
    });

    it("should fail if the missed update fails validation", async () => {
      // Set the stored values
      const activeTransfers = [];
      const channel = createTestChannelStateWithSigners(signers, UpdateType.setup, { nonce: 1 });

      // Create the received update
      const update = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, { nonce: 3 });

      // Create previous update
      const toSync = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, {
        nonce: vectorUtils.getNextNonceForUpdate(1, update.fromIdentifier === channel.aliceIdentifier),
      });

      // Set validation mock
      validationStub.resolves(Result.fail(new Error("fail")));

      // Create the update to sync
      const result = await inbound(
        update,
        toSync,
        activeTransfers,
        channel,
        chainService as IVectorChainReader,
        externalValidation,
        signers[1],
        logger,
      );
      expect(result.getError()!.message).to.be.eq("fail");
    });

    describe("should properly sync channel and apply update", async () => {
      // Declare params
      const runTest = async (proposedType: UpdateType, typeToSync: UpdateType) => {
        // Set the stored values
        const activeTransfers = [];
        const channel = createTestChannelStateWithSigners(signers, UpdateType.setup, {
          nonce: 1,
          latestUpdate: {} as any,
        });

        // Set validation mocks
        const toSyncNonce = vectorUtils.getNextNonceForUpdate(channel.nonce, true);
        const proposedNonce = vectorUtils.getNextNonceForUpdate(toSyncNonce, true);
        const proposed = createTestChannelUpdateWithSigners(signers, proposedType, {
          nonce: proposedNonce,
          fromIdentifier: channel.aliceIdentifier,
        });
        const toSync = createTestChannelUpdateWithSigners(signers, typeToSync, {
          nonce: toSyncNonce,
          fromIdentifier: channel.aliceIdentifier,
        });
        validationStub
          .onFirstCall()
          .resolves(Result.ok({ updatedChannel: { nonce: toSyncNonce, latestUpdate: toSync } }));
        validationStub
          .onSecondCall()
          .resolves(Result.ok({ updatedChannel: { nonce: proposedNonce, latestUpdate: proposed } }));

        const result = await inbound(
          proposed,
          toSync,
          activeTransfers,
          channel,
          chainService as IVectorChainReader,
          externalValidation,
          signers[1],
          logger,
        );
        expect(result.getError()).to.be.undefined;

        // Verify callstack
        expect(validationStub.callCount).to.be.eq(2);
        expect(validationStub.firstCall.args[3].nonce).to.be.eq(toSyncNonce);
        expect(validationStub.secondCall.args[3].nonce).to.be.eq(proposedNonce);
      };

      for (const proposalType of Object.keys(UpdateType)) {
        if (proposalType === UpdateType.setup) {
          continue;
        }
        describe(`initiator trying to ${proposalType}`, () => {
          for (const toSyncType of Object.keys(UpdateType)) {
            if (toSyncType === UpdateType.setup) {
              continue;
            }
            it(`missed ${toSyncType}, should work`, async () => {
              await runTest(proposalType as UpdateType, toSyncType as UpdateType);
            });
          }
        });
      }
    });
  });

  it("IFF update is invalid and channel is out of sync, should fail on retry, but sync properly", async () => {
    // Set the stored values
    const activeTransfers = [];
    const channel = createTestChannelStateWithSigners(signers, UpdateType.setup, {
      nonce: 1,
      latestUpdate: {} as any,
    });

    const toSyncNonce = vectorUtils.getNextNonceForUpdate(channel.nonce, true);
    const proposedNonce = vectorUtils.getNextNonceForUpdate(toSyncNonce, true);

    // Set update to sync
    const prevUpdate = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, {
      nonce: toSyncNonce,
      fromIdentifier: channel.aliceIdentifier,
    });
    validationStub
      .onFirstCall()
      .resolves(Result.ok({ updatedChannel: { nonce: toSyncNonce, latestUpdate: {} as any } }));

    const update: ChannelUpdate<typeof UpdateType.deposit> = createTestChannelUpdateWithSigners(
      signers,
      UpdateType.deposit,
      {
        nonce: proposedNonce,
        fromIdentifier: channel.aliceIdentifier,
      },
    );
    validationStub
      .onSecondCall()
      .resolves(
        Result.fail(new QueuedUpdateError(QueuedUpdateError.reasons.ExternalValidationFailed, update, {} as any)),
      );
    const result = await inbound(
      update,
      prevUpdate,
      activeTransfers,
      channel,
      chainService as IVectorChainReader,
      externalValidation,
      signers[1],
      logger,
    );

    expect(result.isError).to.be.true;
    const error = result.getError()!;
    expect(error.message).to.be.eq(QueuedUpdateError.reasons.ExternalValidationFailed);
    expect(validationStub.callCount).to.be.eq(2);
    expect(validationStub.firstCall.args[3].nonce).to.be.eq(toSyncNonce);
    expect(validationStub.secondCall.args[3].nonce).to.be.eq(proposedNonce);
  });

  it("should work if there is no channel state stored and you are receiving a setup update", async () => {
    // Set the stored values
    const activeTransfers = [];
    const channel = undefined;

    // Generate the update
    const update: ChannelUpdate<typeof UpdateType.setup> = createTestChannelUpdateWithSigners(
      signers,
      UpdateType.setup,
      {
        nonce: 1,
      },
    );
    // Set the validation stub
    validationStub.resolves(Result.ok({ updatedChannel: {} as any }));
    const result = await inbound(
      update,
      update,
      activeTransfers,
      channel,
      chainService as IVectorChainReader,
      externalValidation,
      signers[1],
      logger,
    );
    expect(result.getError()?.message).to.be.eq(QueuedUpdateError.reasons.CannotSyncSetup);
  });
});

describe("outbound", () => {
  const chainProviders = env.chainProviders;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const providerUrl = Object.values(chainProviders)[0] as string;
  const { log } = getTestLoggers("outbound", env.logLevel);
  const channelAddress = mkAddress("0xccc");
  const externalValidation = {
    validateOutbound: (params: UpdateParams<any>, state: FullChannelState, activeTransfers: FullTransferState[]) =>
      Promise.resolve(Result.ok(undefined)),
    validateInbound: (update: ChannelUpdate<any>, state: FullChannelState, activeTransfers: FullTransferState[]) =>
      Promise.resolve(Result.ok(undefined)),
  };

  let signers: ChannelSigner[];
  let store: Sinon.SinonStubbedInstance<MemoryStoreService>;
  let messaging: Sinon.SinonStubbedInstance<MemoryMessagingService>;
  let chainService: Sinon.SinonStubbedInstance<VectorChainReader>;

  let validateUpdateSignatureStub: Sinon.SinonStub;
  let validateParamsAndApplyStub: Sinon.SinonStub;
  // called during sync
  let validateAndApplyInboundStub: Sinon.SinonStub;
  let validateUpdateIdSignatureStub: Sinon.SinonStub;

  beforeEach(async () => {
    signers = Array(2)
      .fill(0)
      .map(() => getRandomChannelSigner(providerUrl));

    // Create all the services stubs
    store = Sinon.createStubInstance(MemoryStoreService);
    messaging = Sinon.createStubInstance(MemoryMessagingService);
    chainService = Sinon.createStubInstance(VectorChainReader);

    // Set the validation + generation mock
    validateParamsAndApplyStub = Sinon.stub(vectorValidation, "validateParamsAndApplyUpdate");
    validateAndApplyInboundStub = Sinon.stub(vectorValidation, "validateAndApplyInboundUpdate");

    // Stub out all signature validation
    validateUpdateSignatureStub = Sinon.stub(vectorUtils, "validateChannelSignatures").resolves(Result.ok(undefined));
    validateUpdateIdSignatureStub = Sinon.stub(vectorUtils, "validateChannelUpdateIdSignature").resolves(
      Result.ok(undefined),
    );
  });

  afterEach(() => {
    // Always restore stubs after tests
    Sinon.restore();
  });

  it("should fail if it fails to validate and apply the update", async () => {
    // Generate stored info
    const activeTransfers = [];
    const previousState = createTestChannelStateWithSigners(signers, UpdateType.deposit);

    // Generate params
    const params = createTestUpdateParams(UpdateType.deposit, { channelAddress: "0xfail" });

    // Stub the validation function
    const error = new QueuedUpdateError(QueuedUpdateError.reasons.InvalidParams, params);
    validateParamsAndApplyStub.resolves(Result.fail(error));

    const res = await outbound(
      params,
      activeTransfers,
      previousState,
      chainService as IVectorChainReader,
      messaging,
      externalValidation,
      signers[0],
      log,
    );
    expect(res.getError()).to.be.deep.eq(error);
  });

  it("should fail if it counterparty update fails for some reason other than update being out of date", async () => {
    // Generate stored info
    const activeTransfers = [];
    const previousState = createTestChannelStateWithSigners(signers, UpdateType.deposit, { channelAddress });

    // Create a setup update
    const params = createTestUpdateParams(UpdateType.setup, {
      channelAddress,
      details: { counterpartyIdentifier: signers[1].publicIdentifier },
    });
    // Create a messaging service stub
    const counterpartyError = new QueuedUpdateError(QueuedUpdateError.reasons.StoreFailure, {} as any);
    messaging.sendProtocolMessage.resolves(Result.fail(counterpartyError));

    // Stub the generation function
    validateParamsAndApplyStub.resolves(
      Result.ok({
        update: createTestChannelUpdateWithSigners(signers, UpdateType.deposit),
        updatedTransfer: undefined,
        updatedActiveTransfers: undefined,
        updatedChannel: createTestChannelStateWithSigners(signers, UpdateType.deposit),
      }),
    );

    // Call the outbound function
    const res = await outbound(
      params,
      activeTransfers,
      previousState,
      chainService as IVectorChainReader,
      messaging,
      externalValidation,
      signers[0],
      log,
    );

    // Verify the error is returned as an outbound error
    const error = res.getError();
    expect(error?.message).to.be.eq(QueuedUpdateError.reasons.CounterpartyFailure);
    expect(error?.context.counterpartyError.message).to.be.eq(counterpartyError.message);
    expect(error?.context.counterpartyError.context).to.be.ok;

    // Verify message only sent once by initiator
    expect(messaging.sendProtocolMessage.callCount).to.be.eq(1);
  });

  it("should fail if it the signature validation fails", async () => {
    // Generate stored info
    const activeTransfers = [];
    const previousState = createTestChannelStateWithSigners(signers, UpdateType.deposit, { channelAddress });

    // Stub generation function
    validateParamsAndApplyStub.resolves(
      Result.ok({
        update: createTestChannelUpdateWithSigners(signers, UpdateType.deposit),
        updatedChannel: createTestChannelStateWithSigners(signers, UpdateType.deposit),
      }),
    );

    // Stub messaging
    messaging.sendProtocolMessage.resolves(
      Result.ok({ update: createTestChannelUpdateWithSigners(signers, UpdateType.deposit) } as any),
    );

    // Stub update signature
    validateUpdateSignatureStub.resolves(Result.fail(new Error("fail")));

    // Make outbound call
    const res = await outbound(
      createTestUpdateParams(UpdateType.deposit),
      activeTransfers,
      previousState,
      chainService as IVectorChainReader,
      messaging,
      externalValidation,
      signers[0],
      log,
    );
    expect(res.getError()!.message).to.be.eq(QueuedUpdateError.reasons.BadSignatures);
  });

  it("should successfully initiate an update if channels are in sync", async () => {
    // Generate stored info
    const activeTransfers = [];
    const previousState = createTestChannelStateWithSigners(signers, UpdateType.deposit, { channelAddress, nonce: 1 });

    // Create the update (a user deposit on a setup channel)
    const assetId = AddressZero;
    const params: UpdateParams<typeof UpdateType.deposit> = createTestUpdateParams(UpdateType.deposit, {
      channelAddress,
      details: { assetId },
    });

    // Stub the generation results
    validateParamsAndApplyStub.onFirstCall().resolves(
      Result.ok({
        update: createTestChannelUpdateWithSigners(signers, UpdateType.deposit),
        updatedTransfer: undefined,
        updatedActiveTransfers: undefined,
        updatedChannel: { ...previousState, nonce: 4 },
      }),
    );

    // Set the messaging mocks to return the proper update from the counterparty
    messaging.sendProtocolMessage // fails returning update to sync from
      .onFirstCall()
      .resolves(Result.ok({ update: {}, previousUpdate: {} } as any));

    // Call the outbound function
    const res = await outbound(
      params,
      activeTransfers,
      previousState,
      chainService as IVectorChainReader,
      messaging,
      externalValidation,
      signers[0],
      log,
    );

    // Verify return values
    expect(res.getError()).to.be.undefined;
    expect(res.getValue().updatedChannel).to.containSubset({ nonce: 4 });

    // Verify message only sent once by initiator w/update to sync
    expect(messaging.sendProtocolMessage.callCount).to.be.eq(1);
    // Verify sync happened
    expect(validateParamsAndApplyStub.callCount).to.be.eq(1);
  });

  describe("counterparty returned a StaleUpdate error, indicating the channel should try to sync (hitting `syncStateAndRecreateUpdate`)", () => {
    it("should fail to sync setup update", async () => {
      // Generate stored info
      const activeTransfers = [];
      const previousState = createTestChannelStateWithSigners(signers, UpdateType.deposit, {
        channelAddress,
        nonce: 1,
      });

      const proposedParams = createTestUpdateParams(UpdateType.deposit);

      // Set generation stub
      validateParamsAndApplyStub.resolves(
        Result.ok({
          update: createTestChannelUpdateWithSigners(signers, UpdateType.deposit),
          updatedChannel: createTestChannelStateWithSigners(signers, UpdateType.deposit),
        }),
      );

      // Stub counterparty return
      const toSync = createTestChannelStateWithSigners(signers, UpdateType.setup);
      messaging.sendProtocolMessage.resolves(
        Result.fail(new QueuedUpdateError(QueuedUpdateError.reasons.StaleUpdate, toSync.latestUpdate, toSync)),
      );

      // Send request
      const result = await outbound(
        proposedParams,
        activeTransfers,
        previousState,
        chainService as IVectorChainReader,
        messaging,
        externalValidation,
        signers[0],
        log,
      );

      // Verify error
      expect(result.getError()?.message).to.be.eq(QueuedUpdateError.reasons.CannotSyncSetup);
      // Verify update was not retried
      expect(messaging.sendProtocolMessage.callCount).to.be.eq(1);
    });

    it("should fail if update to sync is single signed", async () => {
      // Generate stored info
      const activeTransfers = [];
      const previousState = createTestChannelStateWithSigners(signers, UpdateType.deposit, {
        channelAddress,
        nonce: 1,
      });

      const proposedParams = createTestUpdateParams(UpdateType.deposit);

      // Set generation stub
      validateParamsAndApplyStub.resolves(
        Result.ok({
          update: createTestChannelUpdateWithSigners(signers, UpdateType.deposit),
          updatedChannel: createTestChannelStateWithSigners(signers, UpdateType.deposit),
        }),
      );

      // Stub counterparty return
      const toSync = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, {
        aliceSignature: undefined,
        bobSignature: mkSig(),
      });
      messaging.sendProtocolMessage.resolves(
        Result.fail(
          new QueuedUpdateError(QueuedUpdateError.reasons.StaleUpdate, toSync, { latestUpdate: toSync } as any),
        ),
      );

      // Send request
      const result = await outbound(
        proposedParams,
        activeTransfers,
        previousState,
        chainService as IVectorChainReader,
        messaging,
        externalValidation,
        signers[0],
        log,
      );

      // Verify error
      expect(result.getError()?.message).to.be.eq(QueuedUpdateError.reasons.SyncSingleSigned);
      // Verify update was not retried
      expect(messaging.sendProtocolMessage.callCount).to.be.eq(1);
    });

    it("should fail if it fails to apply the inbound update", async () => {
      // Set store mocks
      // Generate stored info
      const activeTransfers = [];
      const previousState = createTestChannelStateWithSigners(signers, UpdateType.deposit, {
        channelAddress,
        nonce: 1,
      });

      // Set generation mock
      validateParamsAndApplyStub.resolves(
        Result.ok({
          update: createTestChannelUpdate(UpdateType.deposit),
          updatedChannel: createTestChannelUpdateWithSigners(signers, UpdateType.deposit, { nonce: 3 }),
        }),
      );

      // Stub counterparty return
      const toSync = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, {
        nonce: 4,
      });
      messaging.sendProtocolMessage.resolves(
        Result.fail(
          new QueuedUpdateError(QueuedUpdateError.reasons.StaleUpdate, toSync, { latestUpdate: toSync } as any),
        ),
      );

      // Stub the sync inbound function
      validateAndApplyInboundStub.resolves(Result.fail(new Error("fail")));

      // Send request
      const result = await outbound(
        createTestUpdateParams(UpdateType.deposit),
        activeTransfers,
        previousState,
        chainService as IVectorChainReader,
        messaging,
        externalValidation,
        signers[0],
        log,
      );

      // Verify error
      expect(result.getError()?.message).to.be.eq("fail");
      // Verify update was not retried
      expect(messaging.sendProtocolMessage.callCount).to.be.eq(1);
    });

    // responder nonce n, proposed update nonce by initiator is at n too.
    // then if update is valid for synced channel then initiator nonce is n+1
    describe("should properly sync channel and recreate update", async () => {
      // Declare test params
      let preSyncState;
      let preSyncUpdatedState;
      let params;
      let preSyncUpdate;

      // create a helper to create the proper counterparty error
      const createInboundError = (updateToSync: ChannelUpdate): any => {
        return Result.fail(
          new QueuedUpdateError(QueuedUpdateError.reasons.StaleUpdate, updateToSync, {
            latestUpdate: updateToSync,
          } as any),
        );
      };

      // create a helper to create a post-sync state
      const createUpdatedState = (update: ChannelUpdate): FullChannelState => {
        return createTestChannelStateWithSigners(signers, update.type, {
          latestUpdate: update,
          nonce: update.nonce,
        });
      };

      // create a helper to create a update to sync state
      const createUpdateToSync = (type: UpdateType): ChannelUpdate => {
        return createTestChannelUpdateWithSigners(signers, type, {
          nonce: 4,
        });
      };

      // create a helper to establish mocks
      const createTestEnv = (
        typeToSync: UpdateType,
      ): { activeTransfers: FullTransferState[]; previousState: FullChannelState; toSync: ChannelUpdate } => {
        // Create the missed update
        const toSync = createUpdateToSync(typeToSync);

        // Generate stored info
        const previousState = createTestChannelStateWithSigners(signers, UpdateType.deposit, {
          channelAddress,
          nonce: 1,
        });

        // If it is resolve, make sure the store returns this in the
        // active transfers + the proper transfer state
        let activeTransfers;
        if (typeToSync === UpdateType.resolve) {
          const transfer = createTestFullHashlockTransferState({ transferId: toSync.details.transferId });
          activeTransfers = [transfer];
          chainService.resolve.resolves(Result.ok(transfer.balance));
        } else {
          // otherwise, assume no other active transfers
          activeTransfers = [];
        }

        // Set messaging mocks:
        // - first call should return an error
        messaging.sendProtocolMessage.onFirstCall().resolves(createInboundError(toSync));

        // Stub apply-sync results
        validateAndApplyInboundStub.resolves(
          Result.ok({
            update: toSync,
            updatedChannel: createUpdatedState(toSync),
          }),
        );

        return { previousState, activeTransfers, toSync };
      };

      // create a helper to verify calling + code path
      const runTest = async (typeToSync: UpdateType): Promise<void> => {
        const { previousState, activeTransfers, toSync } = createTestEnv(typeToSync);

        // Call the outbound function
        const res = await outbound(
          params,
          activeTransfers,
          previousState,
          chainService as IVectorChainReader,
          messaging,
          externalValidation,
          signers[0],
          log,
        );

        // Verify the update was successfully sent + synced
        expect(res.getError()).to.be.undefined;
        expect(res.getValue().successfullyApplied).to.be.eq("synced");
        expect(res.getValue().updatedChannel).to.be.containSubset({
          nonce: toSync.nonce,
          latestUpdate: toSync,
        });
        expect(messaging.sendProtocolMessage.callCount).to.be.eq(1);
        expect(validateParamsAndApplyStub.callCount).to.be.eq(1);
        expect(validateAndApplyInboundStub.callCount).to.be.eq(1);
      };

      describe("initiator trying deposit", () => {
        beforeEach(() => {
          // Create the test params
          preSyncState = createTestChannelStateWithSigners(signers, UpdateType.deposit, { nonce: 1 });
          preSyncUpdatedState = createTestChannelStateWithSigners(signers, UpdateType.deposit, { nonce: 4 });

          params = createTestUpdateParams(UpdateType.deposit);
          preSyncUpdate = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, { nonce: 4 });

          // Set the stored state
          store.getChannelState.resolves(preSyncState);

          // Set the apply values on the first call
          validateParamsAndApplyStub.onFirstCall().resolves(
            Result.ok({
              update: preSyncUpdate,
              updatedChannel: preSyncUpdatedState,
            }),
          );
        });

        afterEach(() => {
          // Always restore stubs after tests
          Sinon.restore();
        });

        for (const type of Object.keys(UpdateType)) {
          // Dont sync setup
          if (type === UpdateType.setup) {
            continue;
          }
          it(`missed ${type}, should work`, async () => {
            await runTest(type as UpdateType);
          });
        }
      });

      describe("initiator trying create", () => {
        beforeEach(() => {
          // Create the test params
          preSyncState = createTestChannelStateWithSigners(signers, UpdateType.deposit, { nonce: 3 });
          preSyncUpdatedState = createTestChannelStateWithSigners(signers, UpdateType.create, { nonce: 4 });

          params = createTestUpdateParams(UpdateType.create);
          preSyncUpdate = createTestChannelUpdateWithSigners(signers, UpdateType.create, { nonce: 4 });

          // Set the stored state
          store.getChannelState.resolves(preSyncState);

          // Set the apply values on the first call
          validateParamsAndApplyStub.onFirstCall().resolves(
            Result.ok({
              update: preSyncUpdate,
              updatedChannel: preSyncUpdatedState,
            }),
          );
        });

        afterEach(() => {
          // Always restore stubs after tests
          Sinon.restore();
        });

        for (const type of Object.keys(UpdateType)) {
          // Dont sync setup
          if (type === UpdateType.setup) {
            continue;
          }
          it(`missed ${type}, should work`, async () => {
            await runTest(type as UpdateType);
          });
        }
      });

      describe("initiator trying resolve", () => {
        beforeEach(() => {
          // Create the test params
          preSyncState = createTestChannelStateWithSigners(signers, UpdateType.deposit, { nonce: 3 });
          preSyncUpdatedState = createTestChannelStateWithSigners(signers, UpdateType.resolve, { nonce: 4 });

          params = createTestUpdateParams(UpdateType.resolve);
          preSyncUpdate = createTestChannelUpdateWithSigners(signers, UpdateType.resolve, { nonce: 4 });

          // Set the stored state
          store.getChannelState.resolves(preSyncState);

          // Set the apply values on the first call
          validateParamsAndApplyStub.onFirstCall().resolves(
            Result.ok({
              update: preSyncUpdate,
              updatedChannel: preSyncUpdatedState,
            }),
          );
        });

        afterEach(() => {
          // Always restore stubs after tests
          Sinon.restore();
        });

        for (const type of Object.keys(UpdateType)) {
          // Dont sync setup
          if (type === UpdateType.setup) {
            continue;
          }
          it(`missed ${type}, should work`, async () => {
            await runTest(type as UpdateType);
          });
        }
      });
    });
  });
});
