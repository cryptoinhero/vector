import { NodeError, NodeErrorContext, Values } from "@connext/vector-types";

type BrowserNodeErrorContext = NodeErrorContext & {
  publicIdentifier: string;
  routerPublicIdentifier: string;
  params: any;
  iframeSrc?: string;
};

export class BrowserNodeError extends NodeError {
  readonly type = "BrowserNodeError";

  static readonly reasons = {
    MethodNotImplemented: "Method not implemented in browser",
    MultinodeProhibitted: "Cannot configure multiple nodes for browser",
  } as const;

  readonly context: BrowserNodeErrorContext;

  constructor(
    public readonly msg: Values<typeof BrowserNodeError.reasons>,
    publicIdentifier: string,
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    params: any = {},
    context: any = {},
  ) {
    super(msg, { params, publicIdentifier, ...context });
  }
}

export class CrossChainTransferError extends NodeError {
  readonly type = "CrossChainTransferError";

  static readonly reasons = {
    MissingReceiverChannel: "Missing channel on receiver chain",
    MissingSenderChannel: "Missing channel on sender chain",
    MissingWithdrawalAmount: "Withdrawal amount not specified",
    MultinodeProhibitted: "Cannot configure multiple nodes for browser",
    ReceiverEventMissed: "Failed to get receiver event",
  } as const;

  readonly context: BrowserNodeErrorContext;

  constructor(
    public readonly msg: Values<typeof CrossChainTransferError.reasons>,
    publicIdentifier: string,
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    params: any,
    context: any = {},
  ) {
    super(msg, { params, publicIdentifier, ...context });
  }
}

type LockErrorContext = NodeErrorContext & {
  lockName: string;
  lockValue?: string;
};
export class BrowserNodeLockError extends NodeError {
  readonly type = "BrowserNodeLockError";

  static readonly reasons = {
    AcquireMessageFailed: "Could not send lock acquisition message",
    CannotBeAlice: "Browser node cannot be Alice",
    CounterpartyIdentifierMissing: "counterpartyPublicIdentifier is required",
    ReleaseMessageFailed: "Could not send lock release message",
    SentMessageAcquisitionFailed: "Could not acquire lock value, despite lock messsage",
  } as const;

  readonly context: LockErrorContext;

  constructor(
    public readonly msg: Values<typeof BrowserNodeLockError.reasons>,
    lockName: string,
    lockValue?: string,
    context: any = {},
  ) {
    super(msg, { ...context, lockName, lockValue });
  }
}
