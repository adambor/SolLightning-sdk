import {Wallet} from "@project-serum/anchor";
import {Keypair, PublicKey, Transaction} from "@solana/web3.js";

class KeypairWallet implements Wallet {

    readonly payer: Keypair;

    constructor(payer: Keypair) {
        this.payer = payer;
    }

    get publicKey(): PublicKey {
        return this.payer.publicKey;
    }

    signAllTransactions(txs: Transaction[]): Promise<Transaction[]> {
        txs.forEach((tx) => {
            tx.sign(this.payer);
        });
        return Promise.resolve(txs);
    }

    signTransaction(tx: Transaction): Promise<Transaction> {
        tx.sign(this.payer);
        return Promise.resolve(tx);
    }

}

export default KeypairWallet;