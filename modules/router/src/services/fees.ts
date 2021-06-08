import {
  FullChannelState,
  IVectorChainReader,
  jsonifyError,
  Result,
  REDUCED_GAS_PRICE,
  SIMPLE_WITHDRAWAL_GAS_ESTIMATE,
  GAS_ESTIMATES,
} from "@connext/vector-types";
import {
  calculateExchangeAmount,
  getBalanceForAssetId,
  getParticipant,
  getRandomBytes32,
  getSignerAddressFromPublicIdentifier,
  TESTNETS_WITH_FEES,
  toWad,
} from "@connext/vector-utils";
import { BigNumber } from "@ethersproject/bignumber";
import { AddressZero, Zero } from "@ethersproject/constants";
import { BaseLogger } from "pino";

import { FeeError } from "../errors";
import { getDecimals } from "../metrics";

import { getRebalanceProfile, getSwapFees, onSwapGivenIn } from "./config";
import { getSwappedAmount } from "./swap";
import { normalizeGasFees } from "./utils";

// Takes in some proposed amount in toAssetId and returns the
// fees in the toAssetId. Will *NOT* return an error if fees > amount
export const calculateFeeAmount = async (
  transferAmount: BigNumber,
  receiveExactAmount: boolean,
  fromAssetId: string,
  fromChainId: number,
  toAssetId: string,
  toChainId: number,
  ethReader: IVectorChainReader,
  routerPublicIdentifier: string,
  logger: BaseLogger,
  // channels are optional, if not provided automatically assume fee needs to include channel creations
  fromChannel?: FullChannelState,
  toChannel?: FullChannelState,
): Promise<Result<{ fee: BigNumber; amount: BigNumber }, FeeError>> => {
  const method = "calculateFeeAmount";
  const methodId = getRandomBytes32();
  logger.info(
    {
      method,
      methodId,
      startingAmount: transferAmount.toString(),
      fromAssetId,
      fromChainId,
      fromChannel: fromChannel?.channelAddress,
      toChainId,
      toAssetId,
      toChannel: toChannel?.channelAddress,
    },
    "Method start",
  );

  const onSwapGivenInRes = await onSwapGivenIn(
    transferAmount,
    fromAssetId,
    fromChainId,
    toAssetId,
    toChainId,
    fromChannel?.alice ?? getSignerAddressFromPublicIdentifier(routerPublicIdentifier), // assume alice if channel does not exist
    ethReader,
    logger,
  );

  if (onSwapGivenInRes.isError) {
    return Result.fail(
      new FeeError(FeeError.reasons.AmmError, {
        toChainId,
        toAssetId,
        fromChainId,
        fromAssetId,
        conversionError: jsonifyError(onSwapGivenInRes.getError()!),
      }),
    );
  }
  const amountOut = onSwapGivenInRes.getValue().amountOut;
  // If recipient is router, i.e. fromChannel ===  toChannel, then the
  // fee amount is 0 because no fees are taken without forwarding
  if ((toChannel || fromChannel) && toChannel?.channelAddress === fromChannel?.channelAddress) {
    return Result.ok({ fee: Zero, amount: amountOut });
  }

  // Get fee values from config
  const fees = getSwapFees(fromAssetId, fromChainId, toAssetId, toChainId);
  if (fees.isError) {
    return Result.fail(
      new FeeError(FeeError.reasons.ConfigError, {
        getFeesError: jsonifyError(fees.getError()!),
      }),
    );
  }
  const { flatFee, percentageFee, gasSubsidyPercentage } = fees.getValue();
  logger.info(
    {
      method,
      methodId,
      flatFee,
      percentageFee,
      dynamicGasFee: gasSubsidyPercentage,
    },
    "Got fee rates",
  );
  if (flatFee === "0" && percentageFee === 0 && gasSubsidyPercentage === 100) {
    // No fees configured
    return Result.ok({ fee: Zero, amount: amountOut });
  }
  const isSwap = fromChainId !== toChainId || fromAssetId !== toAssetId;

  // Properly calculate the percentage fee / amount to send based on
  // static (non-gas) fees:
  // receivedAmt = [(100 - fee) * amt] / 100
  // ie. fee = 20%, amt = 10, receivedAmt = (80 * 10) / 100 = 8
  // If we want to set received as constant, you have
  // (received * 100) / (100 - fee) = amt
  // ie. fee = 20%, receivedAmt = 8, amt = (100 * 8) / (100 - 20) = 10
  //
  // fee = 0.1%, transferAmt = 1000, exact = false, receivedAmt = (1000 * 0.01) / 100 + 1000

  // Calculate fees only on starting amount and update
  let amtToTransfer = transferAmount;
  if (receiveExactAmount) {
    // use calculateExchangeAmount to do the following calc
    // received = (100 * toTransfer) / (100 - pctFee)
    let exchanged = calculateExchangeAmount(transferAmount.mul(100).toString(), (1 / (100 - percentageFee)).toString());
    exchanged = exchanged.split(".")[0];
    amtToTransfer = BigNumber.from(exchanged);
  }
  let feeFromPercent = calculateExchangeAmount(amtToTransfer.toString(), (percentageFee / 100).toString());
  feeFromPercent = feeFromPercent.split(".")[0];
  const staticFees = BigNumber.from(feeFromPercent).add(flatFee);
  if (gasSubsidyPercentage === 100) {
    // gas is fully subsidized
    logger.info(
      {
        method,
        methodId,
        startingAmount: transferAmount.toString(),
        staticFees: staticFees.toString(),
        withStaticFees: staticFees.add(amountOut).toString(),
        gasSubsidyPercentage,
      },
      "Method complete, gas is subsidized",
    );

    return Result.ok({ fee: staticFees, amount: receiveExactAmount ? amountOut.add(flatFee) : amountOut });
  }

  logger.debug(
    {
      method,
      methodId,
      startingAmount: transferAmount.toString(),
      staticFees: staticFees.toString(),
    },
    "Calculating gas fee",
  );

  // Calculate gas fees for transfer
  const gasFeesRes = await calculateEstimatedGasFee(
    transferAmount, // in fromAsset
    fromAssetId,
    fromChainId,
    toAssetId,
    toChainId,
    ethReader,
    routerPublicIdentifier,
    logger,
    fromChannel,
    toChannel,
  );
  if (gasFeesRes.isError) {
    return Result.fail(gasFeesRes.getError()!);
  }
  const gasFees = gasFeesRes.getValue();
  logger.debug(
    {
      reclaimGasFees: gasFees[0].toString(),
      collateralizeGasFees: gasFees[1].toString(),
    },
    "Calculated gas fees",
  );

  // Get decimals for base asset + fees
  let fromAssetDecimals: number | undefined = undefined;
  let baseAssetFromChainDecimals: number | undefined = undefined;
  let toAssetDecimals: number | undefined = undefined;
  let baseAssetToChainDecimals: number | undefined = undefined;
  try {
    fromAssetDecimals = await getDecimals(fromChainId.toString(), fromAssetId);
    baseAssetFromChainDecimals = await getDecimals(fromChainId.toString(), AddressZero);
    toAssetDecimals = await getDecimals(toChainId.toString(), toAssetId);
    baseAssetToChainDecimals = await getDecimals(toChainId.toString(), AddressZero);
  } catch (e) {
    logger.error(
      {
        fromAssetDecimals,
        baseAssetFromChainDecimals,
        toAssetDecimals,
        baseAssetToChainDecimals,
        error: jsonifyError(e),
      },
      "Failed getting decimals",
    );
    return Result.fail(
      new FeeError(FeeError.reasons.ExchangeRateError, {
        message: "Could not get decimals",
        fromAssetDecimals,
        baseAssetFromChainDecimals,
        toAssetDecimals,
        baseAssetToChainDecimals,
        error: jsonifyError(e),
      }),
    );
  }

  // After getting the gas fees for reclaim and for collateral, we
  // must convert them to the proper value in the `fromAsset` (the same asset
  // that the transfer amount is given in).
  // NOTE: only *mainnet* gas fees are assessed here. If you are reclaiming
  // on chain1, include reclaim fees. If you are collateralizing on chain1,
  // include collateral fees
  const normalizedReclaimFromAsset =
    fromChainId === 1 || TESTNETS_WITH_FEES.includes(fromChainId) // fromAsset MUST be on mainnet or hardcoded
      ? await normalizeGasFees(
          gasFees[0], // fromChannel fees
          baseAssetFromChainDecimals,
          fromAssetId,
          fromAssetDecimals,
          fromChainId,
          ethReader,
          logger,
          REDUCED_GAS_PRICE, // assume reclaim actions happen at reduced price
        )
      : Result.ok(Zero);
  const normalizedCollateralToAsset =
    toChainId === 1 || TESTNETS_WITH_FEES.includes(toChainId) // toAsset MUST be on mainnet or hardcoded
      ? await normalizeGasFees(
          gasFees[1], // toChannel fees
          baseAssetToChainDecimals,
          toAssetId,
          toAssetDecimals,
          toChainId,
          ethReader,
          logger,
        )
      : Result.ok(Zero);

  if (normalizedReclaimFromAsset.isError || normalizedCollateralToAsset.isError) {
    return Result.fail(
      new FeeError(FeeError.reasons.ExchangeRateError, {
        message: "Could not normalize fees",
        fromChainId,
        toChainId,
        toAssetId,
        normalizedCollateralToAsset: normalizedReclaimFromAsset.isError
          ? jsonifyError(normalizedReclaimFromAsset.getError())
          : normalizedReclaimFromAsset.getValue().toString(),
        normalizedCollateral: normalizedCollateralToAsset.isError
          ? jsonifyError(normalizedCollateralToAsset.getError())
          : normalizedCollateralToAsset.getValue().toString(),
      }),
    );
  }

  // Now that you have the normalized collateral values, you must use the
  // swap config to get the normalized collater in the desired `fromAsset`.
  // We know the to/from swap is supported, and we do *not* know if they are
  // both on mainnet (i.e. we do not have an oracle)
  const normalizedCollateralFromAsset = isSwap
    ? await getSwappedAmount(
        normalizedCollateralToAsset.getValue().toString(),
        fromAssetId,
        fromChainId,
        toAssetId,
        toChainId,
      )
    : Result.ok(normalizedCollateralToAsset.getValue().toString());
  if (normalizedCollateralFromAsset.isError) {
    return Result.fail(
      new FeeError(FeeError.reasons.ConversionError, {
        toChainId,
        toAssetId,
        fromChainId,
        fromAssetId,
        conversionError: jsonifyError(normalizedCollateralFromAsset.getError()!),
        normalizedCollateralToAsset: normalizedCollateralToAsset.getValue().toString(),
      }),
    );
  }

  const normalizedGasFees = normalizedReclaimFromAsset.getValue().add(normalizedCollateralFromAsset.getValue());
  // take the subsidy percentage of the normalized fees
  const dynamic = normalizedGasFees.mul(100 - gasSubsidyPercentage).div(100);
  const totalFees = staticFees.add(dynamic);
  logger.info(
    {
      method,
      methodId,
      startingAmount: transferAmount.toString(),
      staticFees: staticFees.toString(),
      dynamicGasFees: dynamic.toString(),
      normalizedGasFees: normalizedGasFees.toString(),
      totalFees: totalFees.toString(),
      withFees: BigNumber.from(transferAmount).sub(totalFees).toString(),
    },
    "Method complete",
  );

  // returns the total fees applied to transfer
  return Result.ok({
    fee: totalFees,
    amount: receiveExactAmount ? amountOut.add(flatFee).add(dynamic) : amountOut,
  });
};

// This function returns the cost in wei units. it is in the `normalize`
// function where this is properly converted to the `toAsset` units
// NOTE: it will return an object keyed on chain id to indicate which
// chain the fees are charged on. these fees will have to be normalized
// separately, then added together.

// E.g. consider the case where transferring from mainnet --> matic
// the fees there are:
// (1) collateralizing on matic
// (2) reclaiming on mainnet
// Because we don't have l2 prices of tokens/l2 base assets, we cannot
// normalize the collateralization fees. However, we can normalize the
// reclaim fees
export const calculateEstimatedGasFee = async (
  amountToSend: BigNumber, // in fromAsset
  fromAssetId: string,
  fromChainId: number,
  toAssetId: string,
  toChainId: number,
  ethReader: IVectorChainReader,
  routerPublicIdentifier: string,
  logger: BaseLogger,
  fromChannel?: FullChannelState,
  toChannel?: FullChannelState,
): Promise<Result<[fromFee: BigNumber, toFee: BigNumber], FeeError>> => {
  const method = "calculateEstimatedGasFee";
  const methodId = getRandomBytes32();
  logger.debug(
    {
      method,
      methodId,
      amountToSend: amountToSend.toString(),
      toChannel: toChannel?.channelAddress,
    },
    "Method start",
  );

  let fromChannelFee = Zero; // start with no actions

  // the sender channel will have the following possible actions:
  // (1) IFF current balance + transfer amount > reclaimThreshold, reclaim
  // (2) IFF current balance + transfer amount < collateralThreshold, collateralize
  // (3) IFF channel has not been deployed, deploy

  // Get the rebalance profile
  const rebalanceFromProfile = getRebalanceProfile(fromChainId, fromAssetId);
  if (rebalanceFromProfile.isError) {
    return Result.fail(
      new FeeError(FeeError.reasons.ConfigError, {
        message: "Failed to get rebalance profile",
        assetId: fromAssetId,
        chainId: fromChainId,
        error: jsonifyError(rebalanceFromProfile.getError()!),
      }),
    );
  }
  const fromProfile = rebalanceFromProfile.getValue();
  if (!fromChannel) {
    // if no fromChannel, assume all actions take place
    if (amountToSend.gt(fromProfile.reclaimThreshold)) {
      // There will be a post-resolution reclaim of funds
      fromChannelFee = GAS_ESTIMATES.createChannel.add(SIMPLE_WITHDRAWAL_GAS_ESTIMATE);
    } else if (amountToSend.lt(fromProfile.collateralizeThreshold)) {
      // There will be a post-resolution sender collateralization
      // NOTE: we are assuming router is Alice for a non-created channel because we have no way to know
      // if they are not. this is a safe assumption since likely multihop will not be there for a while
      // revisit this if we decide to implement multihop
      fromChannelFee = GAS_ESTIMATES.createChannelAndDepositAlice;
    }
  } else {
    const participantFromChannel = getParticipant(fromChannel, routerPublicIdentifier);
    if (!participantFromChannel) {
      return Result.fail(
        new FeeError(FeeError.reasons.ChannelError, {
          message: "Not in channel",
          publicIdentifier: routerPublicIdentifier,
          alice: fromChannel.aliceIdentifier,
          bob: fromChannel.bobIdentifier,
          channelAddress: fromChannel.channelAddress,
        }),
      );
    }
    // Determine final balance (assuming successful transfer resolution)
    const finalFromBalance = amountToSend.add(getBalanceForAssetId(fromChannel, fromAssetId, participantFromChannel));

    // Actions in channel will depend on contract being deployed, so get that
    const fromChannelCode = await ethReader.getCode(fromChannel.channelAddress, fromChannel.networkContext.chainId);
    if (fromChannelCode.isError) {
      return Result.fail(
        new FeeError(FeeError.reasons.ChainError, {
          fromChainId: fromChannel.networkContext.chainId,
          fromChannel: fromChannel.channelAddress,
          getCodeError: jsonifyError(fromChannelCode.getError()!),
        }),
      );
    }

    if (finalFromBalance.gt(fromProfile.reclaimThreshold)) {
      // There will be a post-resolution reclaim of funds
      fromChannelFee =
        fromChannelCode.getValue() === "0x"
          ? GAS_ESTIMATES.createChannel.add(SIMPLE_WITHDRAWAL_GAS_ESTIMATE)
          : SIMPLE_WITHDRAWAL_GAS_ESTIMATE;
    } else if (finalFromBalance.lt(fromProfile.collateralizeThreshold)) {
      // There will be a post-resolution sender collateralization
      // gas estimates are participant sensitive, so this is safe to do
      fromChannelFee =
        participantFromChannel === "alice" && fromChannelCode.getValue() === "0x"
          ? GAS_ESTIMATES.createChannelAndDepositAlice
          : participantFromChannel === "alice"
          ? GAS_ESTIMATES.depositAlice
          : GAS_ESTIMATES.depositBob;
    }
  }

  // when forwarding a transfer, the only immediate costs on the receiver-side
  // are the ones needed to properly collateralize the transfer

  // there are several conditions that would affect the collateral costs
  // (1) channel has sufficient collateral: none
  // (2) participant == alice && contract not deployed: createChannelAndDeposit
  // (3) participant == alice && contract deployed: depositAlice
  // (4) participant == bob && contract not deployed: depositBob (channel does
  //     not need to be created for a deposit to be recognized offchain)
  // (5) participant == bob && contract deployed: depositBob

  // reclaimation cases:
  // (1) channel balance > reclaimThreshold after transfer: withdraw

  // Get the rebalance profile
  const rebalanceToProfile = getRebalanceProfile(toChainId, toAssetId);
  if (rebalanceToProfile.isError) {
    return Result.fail(
      new FeeError(FeeError.reasons.ConfigError, {
        message: "Failed to get rebalance profile",
        assetId: toAssetId,
        chainId: toChainId,
        error: jsonifyError(rebalanceToProfile.getError()!),
      }),
    );
  }
  const toProfile = rebalanceToProfile.getValue();

  if (!toChannel) {
    // if no channel exists, we need to account for the full channel deployment always
    // NOTE: same assumption as above for alice
    return Result.ok([fromChannelFee, GAS_ESTIMATES.createChannelAndDepositAlice]);
  } else {
    const participantToChannel = getParticipant(toChannel, routerPublicIdentifier);
    if (!participantToChannel) {
      return Result.fail(
        new FeeError(FeeError.reasons.ChannelError, {
          message: "Not in channel",
          publicIdentifier: routerPublicIdentifier,
          alice: toChannel.aliceIdentifier,
          bob: toChannel.bobIdentifier,
          channelAddress: toChannel.channelAddress,
        }),
      );
    }
    const routerBalance = getBalanceForAssetId(toChannel, toAssetId, participantToChannel);
    // get the amount you would send
    const isSwap = fromAssetId !== toAssetId || fromChainId !== toChainId;
    const converted = isSwap
      ? await getSwappedAmount(amountToSend.toString(), fromAssetId, fromChainId, toAssetId, toChainId)
      : Result.ok(amountToSend.toString());
    if (converted.isError) {
      return Result.fail(
        new FeeError(FeeError.reasons.ConversionError, {
          swapError: jsonifyError(converted.getError()!),
        }),
      );
    }

    if (BigNumber.from(routerBalance).gte(converted.getValue())) {
      // channel has balance, no extra gas required to facilitate transfer
      logger.info(
        { method, methodId, routerBalance: routerBalance.toString(), amountToSend: amountToSend.toString() },
        "Channel is collateralized",
      );
      logger.debug(
        {
          method,
          methodId,
        },
        "Method complete",
      );
      // check for reclaim, reclaim if end balance after in-channel transger
      let toChannelFee = GAS_ESTIMATES.depositBob;
      if (BigNumber.from(routerBalance).sub(converted.getValue()).gt(toProfile.reclaimThreshold)) {
        toChannelFee = toChannelFee.add(GAS_ESTIMATES.withdraw);
      }
      return Result.ok([fromChannelFee, toChannelFee]);
    }
    logger.info(
      {
        method,
        methodId,
        routerBalance: routerBalance.toString(),
        amountToSend: amountToSend.toString(),
        participant: participantToChannel,
      },
      "Channel is undercollateralized",
    );

    // If participant is bob, then you don't need to worry about deploying
    // the channel contract
    if (participantToChannel === "bob") {
      logger.debug(
        {
          method,
          methodId,
        },
        "Method complete",
      );

      return Result.ok([fromChannelFee, GAS_ESTIMATES.depositBob]);
    }

    // Determine if channel needs to be deployed to properly calculate the
    // collateral fee
    const toChannelCode = await ethReader.getCode(toChannel.channelAddress, toChannel.networkContext.chainId);
    if (toChannelCode.isError) {
      return Result.fail(
        new FeeError(FeeError.reasons.ChainError, {
          toChainId: toChannel.networkContext.chainId,
          getCodeError: jsonifyError(toChannelCode.getError()!),
        }),
      );
    }

    logger.debug(
      {
        method,
        methodId,
      },
      "Method complete",
    );

    return Result.ok([
      fromChannelFee,
      toChannelCode.getValue() === "0x" ? GAS_ESTIMATES.createChannelAndDepositAlice : GAS_ESTIMATES.depositAlice,
    ]);
  }
};
