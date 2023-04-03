import IBTCxtoSolSwap from "./IBTCxtoSolSwap";

interface IBTCxtoSolWrapper {

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are already refundable
     */
    init(): Promise<void>;

    /**
     * Stops the wrapper, unsubscribes from Solana events
     */
    stop(): Promise<void>;

    /**
     * Returns swaps that are claimable and that were initiated with the current provider's public key
     */
    getClaimableSwaps(): Promise<IBTCxtoSolSwap[]>;

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    getAllSwaps(): Promise<IBTCxtoSolSwap[]>;

}

export default IBTCxtoSolWrapper;