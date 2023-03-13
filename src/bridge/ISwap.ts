import {BN} from "@project-serum/anchor";
import SwapType from "./SwapType";

interface ISwap {

    serialize(): any;

    /**
     * Returns hash identifier of the swap
     */
    getPaymentHash(): Buffer;

    /**
     * Returns the bitcoin address or bitcoin lightning network invoice
     */
    getAddress(): string;

    /**
     * Returns amount that will be received
     */
    getOutAmount(): BN;

    /**
     * Returns amount that will be sent out
     */
    getInAmount(): BN;

    /**
     * Returns calculated fee for the swap
     */
    getFee(): BN;

    /**
     * Returns the type of the swap
     */
    getType(): SwapType;

}

export default ISwap;