import SwapType from "../swaps/SwapType";
import {SwapHandlerInfoType} from "./IntermediaryDiscovery";
import * as BN from "bn.js";
import ChainSwapType from "../swaps/ChainSwapType";

export type ServicesType = {
    [key in SwapType]?: SwapHandlerInfoType
};

type ReputationType = {
    [key in ChainSwapType]: {
        successVolume: BN,
        successCount: BN,
        failVolume: BN,
        failCount: BN,
        coopCloseVolume: BN,
        coopCloseCount: BN,
    }
};

class Intermediary {

    readonly url: string;
    readonly address: string;
    readonly services: ServicesType;
    readonly reputation: ReputationType;

    constructor(url: string, address: string, services: ServicesType, reputation: ReputationType) {
        this.url = url;
        this.address = address;
        this.services = services;
        this.reputation = reputation;
    }

}

export default Intermediary;