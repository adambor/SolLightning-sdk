import fetch, {Response} from "cross-fetch";
import * as bitcoin from "bitcoinjs-lib";
import {ConstantSoltoBTC} from "./Constants";

const url = "https://mempool.space/testnet/api/";

type TxVout = {
    scriptpubkey: string,
    scriptpubkey_asm: string,
    scriptpubkey_type: string,
    scriptpubkey_address: string,
    value: number
};

type TxVin = {
    txid: string,
    vout: number,
    prevout: TxVout,
    scriptsig: string,
    scriptsig_asm: string,
    witness: string[],
    is_coinbase: boolean,
    sequence: number,
    inner_witnessscript_asm: string
};

export type BitcoinTransaction = {
    txid: string,
    version: number,
    locktime: number,
    vin: TxVin[],
    vout: TxVout[],
    size: number,
    weight: number,
    fee: number,
    status: {
        confirmed: boolean,
        block_height: number,
        block_hash: string,
        block_time: number
    }
};

class ChainUtils {

    static async getTransaction(txId: string): Promise<BitcoinTransaction> {

        const response: Response = await fetch(url+"tx/"+txId, {
            method: "GET"
        });

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new Error(response.statusText);
            }
            throw new Error(resp);
        }

        let jsonBody: any = await response.json();

        return jsonBody;

    }

    static transactionHasOutput(tx: BitcoinTransaction, address: string, amount: number) {

        const outputScript = bitcoin.address.toOutputScript(address, ConstantSoltoBTC.network);
        for(let vout of tx.vout) {
            if(Buffer.from(vout.scriptpubkey).equals(outputScript) && vout.value===amount) {
                return true;
            }
        }

        return false;

    }

}

export default ChainUtils;