import RuntimeError, { RETURN_TYPES } from "./errors/runtime-error";
import Miner, { BlockData } from "./miner/miner";
import Database from "./database";
import Emittery from "emittery";
import BlockManager, { Block } from "./data-managers/block-manager";
import BlockLogs from "./things/blocklogs";
import TransactionManager from "./data-managers/transaction-manager";
import CheckpointTrie from "merkle-patricia-tree";
import { BN } from "ethereumjs-util";
import Account from "./things/account";
import { promisify } from "util";
import { Quantity, Data } from "@ganache/utils";
import EthereumJsAccount from "ethereumjs-account";
import AccountManager from "./data-managers/account-manager";
import { utils } from "@ganache/utils";
import Transaction from "./things/transaction";
import Manager from "./data-managers/manager";
import TransactionReceipt from "./things/transaction-receipt";
import { encode as rlpEncode } from "rlp";
import Common from "ethereumjs-common";
import { Block as EthereumBlock } from "ethereumjs-block";
import VM from "ethereumjs-vm";
import Address from "./things/address";
import BlockLogManager from "./data-managers/blocklog-manager";
import { EVMResult } from "ethereumjs-vm/dist/evm/evm";
import { VmError, ERROR } from "ethereumjs-vm/dist/exceptions";
import { EthereumInternalOptions } from "./options";
import { Snapshots } from "./types/snapshots";

type SimulationTransaction = {
  /**
   * The address the transaction is sent from.
   */
  from: Address;
  /**
   * The address the transaction is directed to.
   */
  to?: Address;
  /**
   * Integer of the gas provided for the transaction execution. eth_call consumes zero gas, but this parameter may be needed by some executions.
   */
  gas: Quantity;
  /**
   * Integer of the gasPrice used for each paid gas
   */
  gasPrice: Quantity;
  /**
   * Integer of the value sent with this transaction
   */
  value?: Quantity;
  /**
   * Hash of the method signature and encoded parameters. For details see Ethereum Contract ABI in the Solidity documentation
   */
  data?: Data;
  block: Block;
};

const unref = utils.unref;

export enum Status {
  // Flags
  started = 1, // 0000 0001
  starting = 2, // 0000 0010
  stopped = 4, // 0000 0100
  stopping = 8, // 0000 1000
  paused = 16 // 0001 0000
}

type BlockchainTypedEvents = {
  block: Block;
  blockLogs: BlockLogs;
  pendingTransaction: Transaction;
};
type BlockchainEvents = "start" | "stop";

/**
 * Sets the provided VM state manager's state root *without* first
 * checking for checkpoints or flushing the existing cache.
 *
 * Useful if you know the state manager is not in a checkpoint and its internal
 * cache is safe to discard.
 *
 * @param stateManager
 * @param stateRoot
 */
function setStateRootSync(stateManager: VM["stateManager"], stateRoot: Buffer) {
  stateManager._trie.root = stateRoot;
  stateManager._cache.clear();
  stateManager._storageTries = {};
}

export default class Blockchain extends Emittery.Typed<
  BlockchainTypedEvents,
  BlockchainEvents
> {
  #state: Status = Status.starting;
  #miner: Miner;
  #blockBeingSavedPromise: Promise<{ block: Block; blockLogs: BlockLogs }>;
  public blocks: BlockManager;
  public blockLogs: BlockLogManager;
  public transactions: TransactionManager;
  public transactionReceipts: Manager<TransactionReceipt>;
  public accounts: AccountManager;
  public vm: VM;
  public trie: CheckpointTrie;

  readonly #database: Database;
  readonly #common: Common;
  readonly #options: EthereumInternalOptions;
  readonly #instamine: boolean;

  /**
   * Initializes the underlying Database and handles synchronization between
   * the API and the database.
   *
   * Emits a `ready` event once the database and all dependencies are fully
   * initialized.
   * @param options
   */
  constructor(
    options: EthereumInternalOptions,
    common: Common,
    initialAccounts: Account[],
    coinbaseAddress: Address
  ) {
    super();
    this.#options = options;
    this.#common = common;

    const instamine = (this.#instamine =
      !options.miner.blockTime || options.miner.blockTime <= 0);
    const legacyInstamine = options.miner.legacyInstamine;

    {
      // warnings
      if (legacyInstamine) {
        console.info(
          "Legacy instamining, where transactions are fully mined before the hash is returned, is deprecated and will be removed in the future."
        );
      }

      if (instamine === false) {
        if (legacyInstamine === true) {
          console.info(
            "Setting `legacyInstamine` to `true` has no effect when blockTime is non-zero"
          );
        }

        if (options.chain.vmErrorsOnRPCResponse) {
          console.info(
            "Setting `vmErrorsOnRPCResponse` to `true` has no effect on transactions when blockTime is non-zero"
          );
        }
      }
    }

    const database = (this.#database = new Database(options.database, this));
    database.once("ready").then(async () => {
      const blocks = (this.blocks = await BlockManager.initialize(
        common,
        database.blockIndexes,
        database.blocks
      ));

      // if we have a latest block, use it to set up the trie.
      const latest = blocks.latest;
      if (latest) {
        this.#blockBeingSavedPromise = Promise.resolve({
          block: latest,
          blockLogs: null
        });
        this.trie = new CheckpointTrie(
          database.trie,
          latest.value.header.stateRoot
        );
      } else {
        this.trie = new CheckpointTrie(database.trie, null);
      }

      this.blockLogs = new BlockLogManager(database.blockLogs);
      this.transactions = new TransactionManager(
        options.miner,
        common,
        this,
        database.transactions
      );
      this.transactionReceipts = new Manager(
        database.transactionReceipts,
        TransactionReceipt
      );
      this.accounts = new AccountManager(this, database.trie);

      this.coinbase = coinbaseAddress;

      // create VM and listen to step events
      this.vm = this.createVmFromStateTrie(
        this.trie,
        options.chain.allowUnlimitedContractSize
      );

      await this.#commitAccounts(initialAccounts);

      {
        // create first block
        let firstBlockTime: number;
        if (options.chain.time != null) {
          const t = +options.chain.time;
          firstBlockTime = Math.floor(t / 1000);
          this.setTime(t);
        } else {
          firstBlockTime = this.#currentTime();
        }

        // if we don't already have a latest block, create a genesis block!
        if (!latest) {
          this.#blockBeingSavedPromise = this.#initializeGenesisBlock(
            firstBlockTime,
            options.miner.blockGasLimit
          );
          blocks.earliest = blocks.latest = await this.#blockBeingSavedPromise.then(
            ({ block }) => block
          );
        }
      }

      {
        // configure and start miner
        const txPool = this.transactions.transactionPool;
        const minerOpts = options.miner;
        const miner = (this.#miner = new Miner(
          minerOpts,
          txPool.executables,
          instamine,
          this.vm,
          this.#readyNextBlock
        ));

        //#region automatic mining
        const nullResolved = Promise.resolve(null);
        const mineAll = (maxTransactions: number) =>
          this.#isPaused() ? nullResolved : this.mine(maxTransactions);
        if (instamine) {
          // insta mining
          // whenever the transaction pool is drained mine the txs into blocks
          txPool.on("drain", mineAll.bind(null, 1));
        } else {
          // interval mining
          const wait = () => unref(setTimeout(next, minerOpts.blockTime * 1e3));
          const next = () => mineAll(-1).then(wait);
          wait();
        }
        //#endregion

        miner.on("block", this.#handleNewBlockData);

        this.once("stop").then(() => miner.clearListeners());
      }

      this.#state = Status.started;
      this.emit("start");
    });
  }

  #fillNewBlock = (blockData: BlockData) => {
    const blocks = this.blocks;
    const options = this.#options;
    const prevBlock = blocks.latest;
    const prevHeader = prevBlock.value.header;
    const prevNumber = Quantity.from(prevHeader.number).toBigInt() || 0n;
    const block = blocks.createBlock({
      parentHash: prevHeader.hash(),
      number: Quantity.from(prevNumber + 1n).toBuffer(),
      coinbase: this.coinbase.toBuffer(),
      timestamp: blockData.timestamp,
      gasLimit: options.miner.blockGasLimit.toBuffer(),
      transactionsTrie: blockData.transactionsTrie.root,
      receiptTrie: blockData.receiptTrie.root,
      stateRoot: this.trie.root,
      gasUsed: Quantity.from(blockData.gasUsed).toBuffer()
    });
    block.value.transactions = blockData.blockTransactions;
    return block;
  };

  #saveNewBlock = (block: Block) => {
    const blocks = this.blocks;
    blocks.latest = block;
    const value = block.value;
    const header = value.header;
    return this.#database.batch(() => {
      const blockHash = value.hash();
      const blockNumber = header.number;
      const blockNumberQ = Quantity.from(blockNumber);
      const blockLogs = BlockLogs.create(blockHash);
      const timestamp = new Date(
        Quantity.from(header.timestamp).toNumber() * 1000
      ).toString();
      value.transactions.forEach((tx: Transaction, i: number) => {
        const hash = tx.hash();
        const index = Quantity.from(i).toBuffer();
        const txAndExtraData = [
          ...tx.raw,
          blockHash,
          blockNumber,
          index,
          Buffer.from([tx.type]),
          tx.from
        ];
        const encodedTx = rlpEncode(txAndExtraData);
        this.transactions.set(hash, encodedTx);

        const receipt = tx.getReceipt();
        const encodedReceipt = receipt.serialize(true);
        this.transactionReceipts.set(hash, encodedReceipt);

        tx.getLogs().forEach(blockLogs.append.bind(blockLogs, index, hash));

        const error = tx.execException;
        this.#logTransaction(hash, receipt, blockNumberQ, timestamp, error);
      });
      blockLogs.blockNumber = blockNumberQ;
      this.blockLogs.set(blockNumber, blockLogs.serialize());
      blocks.putBlock(block);
      return { block, blockLogs };
    });
  };

  #emitNewBlock = async (blockInfo: { block: Block; blockLogs: BlockLogs }) => {
    const options = this.#options;
    const vmErrorsOnRPCResponse = options.chain.vmErrorsOnRPCResponse;
    const { block, blockLogs } = blockInfo;

    // emit the block once everything has been fully saved to the database
    block.value.transactions.forEach(transaction => {
      const error = vmErrorsOnRPCResponse ? transaction.execException : null;
      transaction.finalize("confirmed", error);
    });

    if (this.#instamine && options.miner.legacyInstamine) {
      // in legacy instamine mode we must delay the broadcast of new blocks
      await new Promise(resolve => {
        process.nextTick(async () => {
          // emit block logs first so filters can pick them up before
          // block listeners are notified
          await Promise.all([
            this.emit("blockLogs", blockLogs),
            this.emit("block", block)
          ]);
          resolve(void 0);
        });
      });
    } else {
      // emit block logs first so filters can pick them up before
      // block listeners are notified
      await Promise.all([
        this.emit("blockLogs", blockLogs),
        this.emit("block", block)
      ]);
    }

    return blockInfo;
  };

  #logTransaction = (
    hash: Buffer,
    receipt: TransactionReceipt,
    blockNumber: Quantity,
    timestamp: string,
    error: RuntimeError | undefined
  ) => {
    const logger = this.#options.logging.logger;
    logger.log("");
    logger.log("  Transaction: " + Data.from(hash));

    const contractAddress = receipt.contractAddress;
    if (contractAddress != null) {
      logger.log("  Contract created: " + Address.from(contractAddress));
    }

    logger.log("  Gas usage: " + Quantity.from(receipt.raw[1]));
    logger.log("  Block Number: " + blockNumber);
    logger.log("  Block Time: " + timestamp);

    if (error) {
      logger.log("  Runtime Error: " + error.data.message);
      if ((error as any).reason) {
        logger.log("  Revert reason: " + (error as any).data.reason);
      }
    }

    logger.log("");
  };

  #handleNewBlockData = async (blockData: BlockData) => {
    this.#blockBeingSavedPromise = this.#blockBeingSavedPromise
      .then(() => this.#fillNewBlock(blockData))
      .then(this.#saveNewBlock)
      .then(this.#emitNewBlock);

    return this.#blockBeingSavedPromise;
  };

  coinbase: Address;

  #readyNextBlock = (previousBlock: EthereumBlock, timestamp?: number) => {
    const previousHeader = previousBlock.header;
    const previousNumber =
      Quantity.from(previousHeader.number).toBigInt() || 0n;
    return this.blocks.createBlock({
      number: Quantity.from(previousNumber + 1n).toBuffer(),
      gasLimit: this.#options.miner.blockGasLimit.toBuffer(),
      timestamp: timestamp == null ? this.#currentTime() : timestamp,
      parentHash: previousHeader.hash()
    }).value;
  };

  isStarted = () => {
    return this.#state === Status.started;
  };

  mine = async (
    maxTransactions: number,
    timestamp?: number,
    onlyOneBlock: boolean = false
  ) => {
    await this.#blockBeingSavedPromise;
    const nextBlock = this.#readyNextBlock(this.blocks.latest.value, timestamp);
    return this.#miner.mine(nextBlock, maxTransactions, onlyOneBlock);
  };

  #isPaused = () => {
    return (this.#state & Status.paused) !== 0;
  };

  pause() {
    this.#state |= Status.paused;
  }

  resume(_threads: number = 1) {
    if (!this.#isPaused()) {
      console.log("Warning: startMining called when miner was already started");
      return;
    }

    // toggles the `paused` bit
    this.#state ^= Status.paused;

    // if we are instamining mine a block right away
    if (this.#instamine) {
      return this.mine(-1);
    }
  }

  createVmFromStateTrie = (
    stateTrie: CheckpointTrie,
    allowUnlimitedContractSize: boolean
  ) => {
    const blocks = this.blocks;
    // ethereumjs vm doesn't use the callback style anymore
    const getBlock = class T {
      static async [promisify.custom](number: BN) {
        const block = await blocks.get(number.toBuffer()).catch(_ => null);
        return block ? block.value : null;
      }
    };

    return new VM({
      state: stateTrie,
      activatePrecompiles: true,
      common: this.#common,
      allowUnlimitedContractSize,
      blockchain: {
        getBlock
      } as any
    });
  };

  #commitAccounts = async (accounts: Account[]): Promise<void> => {
    const stateManager = this.vm.stateManager;
    const putAccount = promisify(stateManager.putAccount.bind(stateManager));
    const checkpoint = promisify(stateManager.checkpoint.bind(stateManager));
    const commit = promisify(stateManager.commit.bind(stateManager));
    await checkpoint();
    const l = accounts.length;
    const pendingAccounts = Array(l);
    for (let i = 0; i < l; i++) {
      const account = accounts[i];
      const ethereumJsAccount = new EthereumJsAccount();
      (ethereumJsAccount.nonce = account.nonce.toBuffer()),
        (ethereumJsAccount.balance = account.balance.toBuffer());
      pendingAccounts[i] = putAccount(
        account.address.toBuffer(),
        ethereumJsAccount
      );
    }
    await Promise.all(pendingAccounts);
    await commit();
  };

  #initializeGenesisBlock = async (
    timestamp: number,
    blockGasLimit: Quantity
  ) => {
    // create the genesis block
    const genesis = this.blocks.next({
      // If we were given a timestamp, use it instead of the `_currentTime`
      timestamp,
      gasLimit: blockGasLimit.toBuffer(),
      stateRoot: this.trie.root,
      number: "0x0"
    });

    // store the genesis block in the database
    return this.blocks.putBlock(genesis).then(block => ({
      block,
      blockLogs: BlockLogs.create(block.value.hash())
    }));
  };

  #timeAdjustment: number = 0;

  /**
   * Returns the timestamp, adjusted by the timeAdjustent offset, in seconds.
   */
  #currentTime = () => {
    return Math.floor((Date.now() + this.#timeAdjustment) / 1000);
  };

  /**
   * @param seconds
   * @returns the total time offset *in milliseconds*
   */
  public increaseTime(seconds: number) {
    if (seconds < 0) {
      seconds = 0;
    }
    return (this.#timeAdjustment += seconds);
  }

  /**
   * @param seconds
   * @returns the total time offset *in milliseconds*
   */
  public setTime(timestamp: number) {
    return (this.#timeAdjustment = timestamp - Date.now());
  }

  #deleteBlockData = (blocksToDelete: Block[]) => {
    return this.#database.batch(() => {
      const { blocks, transactions, transactionReceipts, blockLogs } = this;
      blocksToDelete.forEach(({ value }) => {
        value.transactions.forEach(tx => {
          const txHash = tx.hash();
          transactions.del(txHash);
          transactionReceipts.del(txHash);
        });
        blocks.del(value.header.number);
        blocks.del(value.header.hash());
        blockLogs.del(value.header.number);
      });
    });
  };

  // TODO(stability): this.#snapshots is a potential unbound memory suck. Caller
  // could call `evm_snapshot` over and over to grow the snapshot stack
  // indefinitely. `this.#snapshots.blocks` is even worse. To solve this we
  // might need to store in the db. An unlikely real problem, but possible.
  #snapshots: Snapshots = {
    snaps: [],
    blocks: null,
    unsubscribeFromBlocks: null
  };

  public snapshot() {
    const snapshots = this.#snapshots;
    const snaps = snapshots.snaps;

    // Subscription ids are based on the number of active snapshots. Weird? Yes.
    // But it's the way it's been since the beginning so it just hasn't been
    // changed. Feel free to change it so ids are unique if it bothers you
    // enough.
    const id = snaps.push({
      block: this.blocks.latest,
      timeAdjustment: this.#timeAdjustment
    });

    // start listening to new blocks if this is the first snapshot
    if (id === 1) {
      snapshots.unsubscribeFromBlocks = this.on("block", block => {
        snapshots.blocks = {
          current: block.value.hash(),
          next: snapshots.blocks
        };
      });
    }

    this.#options.logging.logger.log("Saved snapshot #" + id);

    return id;
  }

  public async revert(snapshotId: Quantity) {
    const rawValue = snapshotId.valueOf();
    if (rawValue === null || rawValue === undefined) {
      throw new Error("invalid snapshotId");
    }

    this.#options.logging.logger.log("Reverting to snapshot #" + snapshotId);

    // snapshot ids can't be < 1, so we do a quick sanity check here
    if (rawValue < 1n) {
      return false;
    }

    const snapshots = this.#snapshots;
    const snaps = snapshots.snaps;
    const snapshotIndex = Number(rawValue - 1n);
    const snapshot = snaps[snapshotIndex];

    if (!snapshot) {
      return false;
    }

    // pause processing new transactions...
    await this.transactions.pause();

    // then pause the miner, too.
    await this.#miner.pause();

    // wait for anything in the process of being saved to finish up
    await this.#blockBeingSavedPromise;

    // Pending transactions are always removed when you revert, even if they
    // were present before the snapshot was created. Ideally, we'd remove only
    // the new transactions.. but we'll leave that for another day.
    this.transactions.clear();

    const blocks = this.blocks;
    const currentHash = blocks.latest.value.header.hash();
    const snapshotBlock = snapshot.block;
    const snapshotHeader = snapshotBlock.value.header;
    const snapshotHash = snapshotHeader.hash();

    // remove this and all stored snapshots after this snapshot
    snaps.splice(snapshotIndex);

    // if there are no more listeners, stop listening to new blocks
    if (snaps.length === 0) {
      snapshots.unsubscribeFromBlocks();
    }

    // if the snapshot's hash is different than the latest block's hash we've
    // got new blocks to clean up.
    if (!currentHash.equals(snapshotHash)) {
      // if we've added blocks since we snapshotted we need to delete them and put
      // some things back the way they were.
      const blockPromises = [];
      let blockList = snapshots.blocks;
      while (blockList !== null) {
        if (blockList.current.equals(snapshotHash)) break;
        blockPromises.push(blocks.getByHash(blockList.current));
        blockList = blockList.next;
      }
      snapshots.blocks = blockList;

      await Promise.all(blockPromises).then(this.#deleteBlockData);

      setStateRootSync(this.vm.stateManager, snapshotHeader.stateRoot);
      blocks.latest = snapshotBlock;
    }

    // put our time adjustment back
    this.#timeAdjustment = snapshot.timeAdjustment;

    // resume mining
    this.#miner.resume();

    // resume processing transactions
    this.transactions.resume();

    return true;
  }

  public async queueTransaction(transaction: Transaction, secretKey?: Data) {
    // NOTE: this.transactions.add *must* be awaited before returning the
    // `transaction.hash()`, as the transactionPool may change the transaction
    // (and thus its hash!)
    // It may also throw Errors that must be returned to the caller.
    const isExecutable =
      (await this.transactions.add(transaction, secretKey)) === true;
    if (isExecutable) {
      process.nextTick(this.emit.bind(this), "pendingTransaction", transaction);
    }

    const hash = Data.from(transaction.hash(), 32);
    if (this.#isPaused() || !this.#instamine) {
      return hash;
    } else {
      if (this.#instamine && this.#options.miner.legacyInstamine) {
        const { error } = await transaction.once("finalized");
        if (error) throw error;
      }
      return hash;
    }
  }

  public async simulateTransaction(
    transaction: SimulationTransaction,
    parentBlock: Block
  ) {
    let result: EVMResult;
    const options = this.#options;

    const data = transaction.data;
    let gasLeft = transaction.gas.toBigInt();
    // subtract out the transaction's base fee from the gas limit before
    // simulating the tx, because `runCall` doesn't account for raw gas costs.
    gasLeft -= Transaction.calculateIntrinsicGas(
      data ? data.toBuffer() : null,
      options.chain.hardfork
    );

    if (gasLeft >= 0) {
      const stateTrie = new CheckpointTrie(
        this.#database.trie,
        parentBlock.value.header.stateRoot
      );
      const vm = this.createVmFromStateTrie(
        stateTrie,
        this.vm.allowUnlimitedContractSize
      );

      result = await vm.runCall({
        caller: transaction.from.toBuffer(),
        data: transaction.data && transaction.data.toBuffer(),
        gasPrice: transaction.gasPrice.toBuffer(),
        gasLimit: Quantity.from(gasLeft).toBuffer(),
        to: transaction.to && transaction.to.toBuffer(),
        value: transaction.value && transaction.value.toBuffer(),
        block: transaction.block.value
      });
    } else {
      result = {
        execResult: {
          runState: { programCounter: 0 },
          exceptionError: new VmError(ERROR.OUT_OF_GAS),
          returnValue: Buffer.allocUnsafe(0)
        }
      } as any;
    }
    if (result.execResult.exceptionError) {
      if (this.#options.chain.vmErrorsOnRPCResponse) {
        // eth_call transactions don't really have a transaction hash
        const hash = Buffer.allocUnsafe(0);
        throw new RuntimeError(hash, result, RETURN_TYPES.RETURN_VALUE);
      } else {
        return Data.from(result.execResult.returnValue || "0x");
      }
    } else {
      return Data.from(result.execResult.returnValue || "0x");
    }
  }

  /**
   * Gracefully shuts down the blockchain service and all of its dependencies.
   */
  public async stop() {
    // If the blockchain is still initalizing we don't want to shut down
    // yet because there may still be database calls in flight. Leveldb may
    // cause a segfault due to a race condition between a db write and the close
    // call.
    if (this.#state === Status.starting) {
      await this.once("start");
    }

    // clean up listeners
    this.vm.removeAllListeners();
    this.transactions.transactionPool.clearListeners();
    await this.emit("stop");

    if (this.#state === Status.started) {
      this.#state = Status.stopping;
      await this.#database.close();
      this.#state = Status.stopped;
    }
  }
}
