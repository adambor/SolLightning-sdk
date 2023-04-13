import IBTCxtoSolSwap from "./IBTCxtoSolSwap";
import IWrapperStorage from "../../storage/IWrapperStorage";
import ClientSwapContract from "../ClientSwapContract";
import ChainEvents from "../../events/ChainEvents";
import * as EventEmitter from "events";
import SwapData from "../SwapData";

abstract class IBTCxtoSolWrapper<T extends SwapData> {

    readonly storage: IWrapperStorage;
    readonly contract: ClientSwapContract<T>;
    readonly chainEvents: ChainEvents<T>;

    /**
     * Event emitter for all the swaps
     *
     * @event BTCLNtoSolSwap#swapState
     * @type {BTCLNtoSolSwap}
     */
    readonly events: EventEmitter;

    swapData: {[paymentHash: string]: IBTCxtoSolSwap<T>};

    isInitialized: boolean = false;

    /**
     * @param storage           Storage interface for the current environment
     * @param contract          Underlying contract handling the swaps
     * @param chainEvents       On-chain event emitter
     */
    protected constructor(storage: IWrapperStorage, contract: ClientSwapContract<T>, chainEvents: ChainEvents<T>) {
        this.storage = storage;
        this.contract = contract;
        this.chainEvents = chainEvents;
        this.events = new EventEmitter();
    }

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are already refundable
     */
    abstract init(): Promise<void>;

    /**
     * Un-subscribes from event listeners on Solana
     */
    async stop() {
        this.swapData = null;
        await this.chainEvents.stop();
        this.isInitialized = false;
    }

    /**
     * Returns swaps that are claimable and that were initiated with the current provider's public key
     */
    abstract getClaimableSwaps(): Promise<IBTCxtoSolSwap<T>[]>;

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    abstract getAllSwaps(): Promise<IBTCxtoSolSwap<T>[]>;

}

export default IBTCxtoSolWrapper;