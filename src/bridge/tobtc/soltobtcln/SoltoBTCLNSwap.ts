import * as bolt11 from "bolt11";
import SoltoBTCLNWrapper from "./SoltoBTCLNWrapper";
import ISolToBTCxSwap from "../tobtc/ISolToBTCxSwap";
import SwapType from "../SwapType";
import SwapData from "../swaps/SwapData";
import * as BN from "bn.js";

export default class SoltoBTCLNSwap<T extends SwapData> extends ISolToBTCxSwap<T> {

    readonly confidence: number;

    //State: PR_CREATED
    readonly pr: string;

    constructor(
        wrapper: SoltoBTCLNWrapper<T>,
        pr: string,
        data: T,
        prefix: string,
        timeout: string,
        signature: string,
        nonce: number,
        url: string,
        confidence: string
    );
    constructor(wrapper: SoltoBTCLNWrapper<T>, obj: any);

    constructor(
        wrapper: SoltoBTCLNWrapper<T>,
        prOrObject: string | any,
        data?: T,
        prefix?: string,
        timeout?: string,
        signature?: string,
        nonce?: number,
        url?: string,
        confidence?: string,
    ) {
        if(typeof(prOrObject)==="string") {
            super(wrapper, data, prefix, timeout, signature, nonce, url);
            this.confidence = parseFloat(confidence);
            this.pr = prOrObject;
        } else {
            super(wrapper, prOrObject);
            this.confidence = prOrObject.confidence;
            this.pr = prOrObject.pr;
        }
    }

    /**
     * Returns amount that will be sent on Solana
     */
    getInAmount(): BN {
        return this.data.getAmount();
    }

    /**
     * Returns amount that will be sent to recipient on Bitcoin LN
     */
    getOutAmount(): BN {
        const parsedPR = bolt11.decode(this.pr);
        return new BN(parsedPR.satoshis);
    }

    serialize(): any {
        const partialSerialized = super.serialize();
        partialSerialized.pr = this.pr;
        partialSerialized.confidence = this.confidence;
        return partialSerialized;
    }

    /**
     * Returns the confidence of the intermediary that this payment will succeed
     * Value between 0 and 1, where 0 is not likely and 1 is very likely
     */
    getConfidence(): number {
        return this.confidence;
    }

    getPaymentHash(): Buffer {
        const parsed = bolt11.decode(this.pr);
        return Buffer.from(parsed.tagsObject.payment_hash, "hex");
    }

    getAddress(): string {
        return this.pr;
    }

    getType(): SwapType {
        return SwapType.SOL_TO_BTCLN;
    }

}
