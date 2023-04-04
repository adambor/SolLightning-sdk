import SoltoBTCSwap from "./SoltoBTCSwap";
import ISolToBTCxWrapper from "../ISolToBTCxWrapper";
import IWrapperStorage from "../../../storage/IWrapperStorage";
import SwapData from "../../SwapData";
import ClientSwapContract from "../../ClientSwapContract";
import ChainEvents from "../../../events/ChainEvents";
import * as BN from "bn.js";

class SoltoBTCWrapper<T extends SwapData> extends ISolToBTCxWrapper<T> {


    /**
     * @param storage           Storage interface for the current environment
     * @param contract          Underlying contract handling the swaps
     * @param chainEvents       On-chain event emitter
     */
    constructor(storage: IWrapperStorage, contract: ClientSwapContract<T>, chainEvents: ChainEvents<T>) {
        super(storage, contract, chainEvents);
    }

    /**
     * Returns a newly created swap, paying for 'bolt11PayRequest' - a bitcoin LN invoice
     *
     * @param address               Bitcoin on-chain address you wish to pay to
     * @param amount                Amount of bitcoin to send, in base units - satoshis
     * @param confirmationTarget    Time preference of the transaction (in how many blocks should it confirm)
     * @param confirmations         Confirmations required for intermediary to claim the funds from PTLC (this determines the safety of swap)
     * @param url                   Intermediary/Counterparty swap service url
     * @param requiredKey           Required key of the Intermediary
     */
    async create(address: string, amount: BN, confirmationTarget: number, confirmations: number, url: string, requiredKey?: string): Promise<SoltoBTCSwap<T>> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const result = await this.contract.payOnchain(address, amount, confirmationTarget, confirmations, url, requiredKey);

        const swap = new SoltoBTCSwap(
            this,
            address,
            amount,
            confirmationTarget,
            result.networkFee,
            result.swapFee,
            result.totalFee,
            result.data,
            result.prefix,
            result.timeout,
            result.signature,
            result.nonce,
            url
        );

        await swap.save();
        this.swapData[result.data.getHash()] = swap;

        return swap;

    }

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are already refundable
     */
    async init() {
        return super.initWithConstructor(SoltoBTCSwap);
    }

}

export default SoltoBTCWrapper;