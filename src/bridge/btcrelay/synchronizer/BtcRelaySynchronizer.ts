import {AnchorProvider} from "@project-serum/anchor";
import BtcRelay from "../BtcRelay";


const MAX_HEADERS_PER_TX = 7;
const MAX_HEADERS_PER_TX_FORK = 6;

class BtcRelaySynchronizer {

    provider: AnchorProvider;
    btcRelay: BtcRelay;

    constructor(provider: AnchorProvider, btcRelay: BtcRelay) {
        this.provider = provider;
        this.btcRelay = btcRelay;
    }



}