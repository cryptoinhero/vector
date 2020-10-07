import {
  ConditionalTransferCreatedPayload,
  ConditionalTransferResolvedPayload,
  DepositReconciledPayload,
  WithdrawalCreatedPayload,
  WithdrawalResolvedPayload,
  WithdrawalReconciledPayload,
  CONDITIONAL_TRANSFER_CREATED_EVENT,
  CONDITIONAL_TRANSFER_RESOLVED_EVENT,
  DEPOSIT_RECONCILED_EVENT,
  WITHDRAWAL_CREATED_EVENT,
  WITHDRAWAL_RESOLVED_EVENT,
  WITHDRAWAL_RECONCILED_EVENT,
} from "@connext/vector-types";
import { Evt } from "evt";

import { EngineEvtContainer } from "./index";

export const getEngineEvtContainer = (): EngineEvtContainer => {
  return {
    [CONDITIONAL_TRANSFER_CREATED_EVENT]: Evt.create<ConditionalTransferCreatedPayload>(),
    [CONDITIONAL_TRANSFER_RESOLVED_EVENT]: Evt.create<ConditionalTransferResolvedPayload>(),
    [DEPOSIT_RECONCILED_EVENT]: Evt.create<DepositReconciledPayload>(),
    [WITHDRAWAL_CREATED_EVENT]: Evt.create<WithdrawalCreatedPayload>(),
    [WITHDRAWAL_RESOLVED_EVENT]: Evt.create<WithdrawalResolvedPayload>(),
    [WITHDRAWAL_RECONCILED_EVENT]: Evt.create<WithdrawalReconciledPayload>(),
  };
};
