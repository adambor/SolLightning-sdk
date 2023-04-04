import {TokenAddress} from "./TokenAddress";
import * as BN from "bn.js";
import ChainSwapType from "./ChainSwapType";
import Serializable from "../serialization/Serializable";

abstract class SwapData implements Serializable {

    static deserializationList: {
        [type: string]: new (data: any) => SwapData
    } = {};

    static deserialize<T extends SwapData>(data: any): T {
        const deserializer = this.deserializationList[data.type];
        if(deserializer!=null) {
            return new deserializer(data) as unknown as T;
        }
        return null;
    }

    abstract getOfferer(): string;
    abstract setOfferer(newOfferer: string);

    abstract getClaimer(): string;
    abstract setClaimer(newClaimer: string);

    abstract serialize(): any;

    abstract getType(): ChainSwapType;

    abstract getAmount(): BN;

    abstract getToken(): TokenAddress;

    abstract isToken(token: TokenAddress): boolean;

    abstract getExpiry(): BN;

    abstract getConfirmations(): number;

    abstract getEscrowNonce(): BN;

    abstract isPayOut(): boolean;

    abstract isPayIn(): boolean;

    abstract getHash(): string;

}

export default SwapData;