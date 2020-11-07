import { Data, Quantity, utils } from "@ganache/utils";
import { Definitions } from "@ganache/options";
import Address from "../things/address";
import { DatabaseOptions } from "./database-options";

export type MinerConfig = {
  options: {
    /**
     * Sets the `blockTime` in seconds for automatic mining. A blockTime of `0`
     * (default) enables "instamine mode", where new executable transactions
     * will be mined instantly.
     *
     * Using the `blockTime` option is discouraged unless you have tests which
     * require a specific mining interval.
     *
     * @default 0 // "instamine mode"
     */
    blockTime: {
      type: number;
      hasDefault: true;
      legacy: {
        /**
         * @deprecated Use miner.blockTime instead
         */
        blockTime: number;
      };
    };

    /**
     * Sets the default gas price in WEI for transactions if not otherwise specified.
     *
     * @default 2_000_000
     */
    gasPrice: {
      type: Quantity;
      rawType: string | number | bigint;
      hasDefault: true;
      legacy: {
        /**
         * @deprecated Use miner.gasPrice instead
         */
        gasPrice: string | number | bigint;
      };
    };

    /**
     * Sets the block gas limit in WEI.
     *
     * @default 12_000_000
     */
    blockGasLimit: {
      type: Quantity;
      rawType: string | number | bigint;
      hasDefault: true;
      legacy: {
        /**
         * @deprecated Use miner.blockGasLimit instead
         */
        gasLimit: string | number | bigint;
      };
    };

    /**
     * Sets the _default_ transaction gas limit in WEI.
     *
     * @default 9_000
     */
    defaultTransactionGasLimit: {
      type: Quantity;
      rawType: string | number | bigint;
      hasDefault: true;
    };

    /**
     * Sets the transaction gas limit in WEI for `eth_call` and
     * eth_estimateGas` calls.
     *
     * @default 9_007_199_254_740_991 // 2**53 - 1
     */
    callGasLimit: {
      type: Quantity;
      rawType: string | number | bigint;
      hasDefault: true;
      legacy: {
        /**
         * @deprecated Use miner.callGasLimit instead
         */
        callGasLimit: string | number | bigint;
      };
    };

    /**
     * Enables legacy instamine mode, where transactions are fully mined before
     * the transaction's hash is returned to the caller. If `legacyInstamine` is
     * `true`, `blockTime` must be `0` (default).
     *
     * @default false
     * @deprecated Will be removed in v4
     */
    legacyInstamine: {
      type: boolean;
      hasDefault: true;
    };

    /**
     * Sets the address where mining rewards will go.
     *
     * * `{string}` hex-encoded address
     * * `{number}` index of the account returned by `eth_getAccounts`
     *
     * @default "0x0000000000000000000000000000000000000000"
     */
    coinbase: {
      rawType: string | number;
      type: string | number | Address;
      hasDefault: true;
    };

    extraData: {
      type: string;
    };
  };
  exclusiveGroups: [];
};

const normalize = <T>(rawInput: T) => rawInput;

export const MinerOptions: Definitions<MinerConfig> = {
  blockTime: {
    normalize,
    default: () => 0,
    legacyName: "blockTime"
  },
  gasPrice: {
    normalize: Quantity.from,
    default: () => Quantity.from(2_000_000_000),
    legacyName: "gasPrice"
  },
  blockGasLimit: {
    normalize: Quantity.from,
    default: () => Quantity.from(12_000_000),
    legacyName: "gasLimit"
  },
  defaultTransactionGasLimit: {
    normalize: Quantity.from,
    default: () => Quantity.from(90000)
  },
  callGasLimit: {
    normalize: Quantity.from,
    default: () => Quantity.from(Number.MAX_SAFE_INTEGER),
    legacyName: "callGasLimit"
  },
  coinbase: {
    normalize,
    default: () => Address.from(utils.ACCOUNT_ZERO)
  },
  legacyInstamine: {
    normalize,
    default: () => false
  },
  extraData: {
    normalize: rawType => {
      if (rawType.length > 32) {
        throw new Error(`extra exceeds max length. ${rawType.length} > 32`);
      }
      return rawType;
    }
  }
};
