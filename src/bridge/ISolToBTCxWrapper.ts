import ISolToBTCxSwap from "./ISolToBTCxSwap";
import {BN} from "@project-serum/anchor";


interface ISolToBTCxWrapper {

    /**
     * Returns the WBTC token balance of the wallet
     */
    getWBTCBalance(): Promise<BN>;

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are already refundable
     */
    init(): Promise<void>;

    /**
     * Returns swaps that are refundable and that were initiated with the current provider's public key
     */
    getRefundableSwaps(): Promise<ISolToBTCxSwap[]>;

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    getAllSwaps(): Promise<ISolToBTCxSwap[]>;

    /**
     * Stops the wrapper, unsubscribes from Solana events
     */
    stop(): Promise<void>;

}

export default ISolToBTCxWrapper;