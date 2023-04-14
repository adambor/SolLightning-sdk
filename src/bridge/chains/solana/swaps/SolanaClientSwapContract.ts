import ClientSwapContract, {IntermediaryReputationType} from "../../../swaps/ClientSwapContract";
import SolanaSwapData from "./SolanaSwapData";
import {
    Ed25519Program,
    Keypair,
    PublicKey,
    Signer,
    SystemProgram,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    SYSVAR_RENT_PUBKEY, Transaction,
    TransactionInstruction
} from "@solana/web3.js";
import {AnchorProvider, Program} from "@coral-xyz/anchor";
import SolanaBtcRelay from "../btcrelay/SolanaBtcRelay";
import SolanaBtcRelaySynchronizer from "../btcrelay/synchronizer/SolanaBtcRelaySynchronizer";
import {createHash} from "crypto-browserify";
import {
    getAssociatedTokenAddressSync,
    getAccount,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction
} from "@solana/spl-token";
import {TokenAddress} from "../../../swaps/TokenAddress";
import * as BN from "bn.js";
import SwapCommitStatus from "../../../swaps/SwapCommitStatus";
import Utils from "../../../../Utils";
import {ConstantBTCLNtoSol, ConstantSoltoBTCLN, WSOL_ADDRESS} from "../../../../Constants";
import {sign} from "tweetnacl";
import ChainUtils from "../../../../ChainUtils";
import * as bitcoin from "bitcoinjs-lib";
import {programIdl} from "./programIdl";
import ChainSwapType from "../../../swaps/ChainSwapType";
import SignatureVerificationError from "../../../errors/SignatureVerificationError";
import ISwapPrice from "../../../swaps/ISwapPrice";

const STATE_SEED = "state";
const VAULT_SEED = "vault";
const USER_VAULT_SEED = "uservault";
const AUTHORITY_SEED = "authority";

class SolanaClientSwapContract extends ClientSwapContract<SolanaSwapData> {

    provider: AnchorProvider;
    program: Program;
    vaultAuthorityKey: PublicKey;

    btcRelay: SolanaBtcRelay;
    btcRelaySynchronizer: SolanaBtcRelaySynchronizer;

    getSwapDataKeyAlt(reversedTxId: Buffer, secretKey: Buffer): Signer {
        const buff = createHash("sha256").update(Buffer.concat([secretKey, reversedTxId])).digest();
        return Keypair.fromSeed(buff);
    }

    getUserVaultKey(wallet: PublicKey, token: PublicKey) {
        return PublicKey.findProgramAddressSync(
            [Buffer.from(USER_VAULT_SEED), wallet.toBuffer(), token.toBuffer()],
            this.program.programId
        )[0];
    }

    getEscrowStateKey(hash: Buffer) {
        return PublicKey.findProgramAddressSync(
            [Buffer.from(STATE_SEED), hash],
            this.program.programId
        )[0];
    }

    getVaultKey(token: PublicKey) {
        return PublicKey.findProgramAddressSync(
            [Buffer.from(VAULT_SEED), token.toBuffer()],
            this.program.programId
        )[0];
    }

    constructor(provider: AnchorProvider, wbtcToken?: PublicKey, swapPrice?: ISwapPrice) {
        super(wbtcToken, swapPrice);
        this.provider = provider;
        this.btcRelay = new SolanaBtcRelay(provider);
        this.btcRelaySynchronizer = new SolanaBtcRelaySynchronizer(this.provider, this.btcRelay);
        this.program = new Program(programIdl, programIdl.metadata.address, this.provider);
        this.vaultAuthorityKey = PublicKey.findProgramAddressSync(
            [Buffer.from(AUTHORITY_SEED)],
            this.program.programId
        )[0];
    }

    areWeClaimer(swapData: SolanaSwapData): boolean {
        if(swapData.isPayOut()) {
            const ourAta = getAssociatedTokenAddressSync(swapData.token, swapData.intermediary);

            if(!swapData.claimerTokenAccount.equals(ourAta)) {
                //Invalid ATA specified as our ATA
                return false;
            }
        }
        return swapData.intermediary.equals(this.provider.publicKey);
    }

    areWeOfferer(swapData: SolanaSwapData): boolean {
        return swapData.offerer.equals(this.provider.publicKey);
    }

    getAddress(): string {
        return this.provider.publicKey.toBase58();
    }

    getATARentExemptLamports(): Promise<BN> {
        return Promise.resolve(new BN(2039280));
    }

    async getBalance(token?: PublicKey): Promise<BN> {
        const ata: PublicKey = getAssociatedTokenAddressSync(token || this.WBTC_ADDRESS, this.provider.publicKey);
        let ataExists: boolean = false;
        let sum: BN = new BN(0);
        try {
            const account = await getAccount(this.provider.connection, ata);
            if(account!=null) {
                ataExists = true;
                sum = sum.add(new BN(account.amount.toString()));
            }
        } catch (e) {}

        if(token!=null && token.equals(WSOL_ADDRESS)) {
            let balanceLamports = new BN(await this.provider.connection.getBalance(this.provider.publicKey));
            if(!ataExists) balanceLamports = balanceLamports.sub(await this.getATARentExemptLamports());
            balanceLamports = balanceLamports.sub(this.getCommitFee()); //Discount commit fee
            balanceLamports = balanceLamports.sub(new BN(5000)); //Discount refund fee
            if(!balanceLamports.isNeg()) sum = sum.add(balanceLamports);
        }

        return sum;
    }

    async getCommitStatus(data: SolanaSwapData): Promise<SwapCommitStatus> {

        const escrowStateKey = this.getEscrowStateKey(Buffer.from(data.paymentHash, "hex"));
        try {
            const escrowState: any = await this.program.account.escrowState.fetch(escrowStateKey);

            if(
                !escrowState.offerer.equals(data.offerer) ||
                !escrowState.claimer.equals(data.intermediary) ||
                !escrowState.mint.equals(data.token) ||
                !escrowState.initializerAmount.eq(data.amount) ||
                !escrowState.expiry.eq(data.expiry)
            ) {
                if(this.areWeOfferer(data)) {
                    if(this.isExpired(data)) {
                        return SwapCommitStatus.EXPIRED;
                    }
                }

                return SwapCommitStatus.NOT_COMMITED;
            }

            if(this.areWeOfferer(data)) {
                if (this.isExpired(data)) {
                    return SwapCommitStatus.REFUNDABLE;
                }
            }

            return SwapCommitStatus.COMMITED;
        } catch (e) {
            //Check if paid or what
            const signatures = await this.provider.connection.getSignaturesForAddress(escrowStateKey, {
                limit: 500
            });
            for(let sig of signatures) {
                const tx = await this.provider.connection.getTransaction(sig.signature);
                if(tx.meta.err==null) {
                    const instructions = Utils.decodeInstructions(tx.transaction.message);
                    for(let ix of instructions) {
                        if(ix==null) continue;
                        if(ix.name==="claimerClaim" || ix.name==="claimerClaimPayOut" || ix.name==="claimerClaimWithExtData" || ix.name==="claimerClaimPayOutWithExtData") {
                            return SwapCommitStatus.PAID;
                        }
                        if(ix.name==="offererRefund" || ix.name==="offererRefundPayOut" || ix.name==="offererRefundWithSignature" || ix.name==="offererRefundWithSignaturePayOut") {
                            if(this.isExpired(data)) {
                                return SwapCommitStatus.EXPIRED;
                            }
                            return SwapCommitStatus.NOT_COMMITED;
                        }
                    }
                }
            }
            if(this.isExpired(data)) {
                return SwapCommitStatus.EXPIRED;
            }
            return SwapCommitStatus.NOT_COMMITED;
        }

    }

    async getPaymentHashStatus(paymentHash: string): Promise<SwapCommitStatus> {
        const escrowStateKey = this.getEscrowStateKey(Buffer.from(paymentHash, "hex"));
        try {
            const escrowState = await this.program.account.escrowState.fetch(escrowStateKey);
            if(escrowState!=null) {
                return SwapCommitStatus.COMMITED;
            }
        } catch (e) {
            console.log(e);
        }

        //Check if paid or what
        const signatures = await this.provider.connection.getSignaturesForAddress(escrowStateKey, {
            limit: 500
        });

        for(let sig of signatures) {
            const tx = await this.provider.connection.getTransaction(sig.signature);
            if(tx.meta.err==null) {
                const instructions = Utils.decodeInstructions(tx.transaction.message);
                for(let ix of instructions) {
                    if(ix.name==="claimerClaim" || ix.name==="claimerClaimPayOut") {
                        return SwapCommitStatus.PAID;
                    }
                    if(ix.name==="offererRefund" || ix.name==="offererRefundPayOut" || ix.name==="offererRefundWithSignature" || ix.name==="offererRefundWithSignaturePayOut") {
                        return SwapCommitStatus.NOT_COMMITED;
                    }
                }
            }
        }

        return SwapCommitStatus.NOT_COMMITED;
    }

    isClaimable(data: SolanaSwapData): Promise<boolean> {
        if(!this.areWeClaimer(data)) {
            return Promise.resolve(false);
        }

        if(this.isExpired(data)) {
            return Promise.resolve(false);
        }

        return this.isCommited(data);
    }

    async isCommited(data: SolanaSwapData): Promise<boolean> {
        const escrowStateKey = this.getEscrowStateKey(Buffer.from(data.paymentHash, "hex"));
        try {
            const escrowState: any = await this.program.account.escrowState.fetch(escrowStateKey);

            if(
                !escrowState.offerer.equals(data.offerer) ||
                !escrowState.claimer.equals(data.intermediary) ||
                !escrowState.mint.equals(data.token) ||
                !escrowState.initializerAmount.eq(data.amount) ||
                !escrowState.expiry.eq(data.expiry)
            ) {
                return false;
            }

            return true;
        } catch (e) {
            console.log(e);
            return false;
        }
    }

    isExpired(data: SolanaSwapData): boolean {
        let currentTimestamp: BN = new BN(0);
        if(this.areWeOfferer(data)) {
            currentTimestamp = new BN(Math.floor(Date.now()/1000)-ConstantSoltoBTCLN.refundGracePeriod);
        }
        if(this.areWeClaimer(data)) {
            const currentTimestamp = new BN(Math.floor(Date.now()/1000)+ConstantBTCLNtoSol.claimGracePeriod);
        }
        return data.expiry.lt(currentTimestamp);
    }

    isRequestRefundable(data: SolanaSwapData): Promise<boolean> {
        if(!this.areWeOfferer(data)) {
            return Promise.resolve(false);
        }

        const currentTimestamp = new BN(Math.floor(Date.now()/1000)-ConstantSoltoBTCLN.refundGracePeriod);

        const isExpired = data.expiry.lt(currentTimestamp);

        if(!isExpired) return Promise.resolve(false);

        return this.isCommited(data);
    }

    isValidAddress(address: string): boolean {
        try {
            return PublicKey.isOnCurve(address);
        } catch (e) {
            return false;
        }
    }

    isValidAuthorization(data: SolanaSwapData, timeout: string, prefix: string, signature: string): Promise<Buffer> {

        if(prefix!=="refund") {
            throw new SignatureVerificationError("Invalid prefix");
        }

        const expiryTimestamp = new BN(timeout);
        const currentTimestamp = new BN(Math.floor(Date.now() / 1000));

        const isExpired = expiryTimestamp.sub(currentTimestamp).lt(new BN(ConstantSoltoBTCLN.authorizationGracePeriod));

        if (isExpired) {
            throw new SignatureVerificationError("Authorization expired!");
        }

        const messageBuffers = [
            Buffer.from(prefix, "ascii"),
            Buffer.from(data.amount.toArray("le", 8)),
            Buffer.from(data.expiry.toArray("le", 8)),
            Buffer.from(data.paymentHash, "hex"),
            Buffer.from(expiryTimestamp.toArray("le", 8)),
        ];

        const signatureBuffer = Buffer.from(signature, "hex");
        const messageBuffer = createHash("sha256").update(Buffer.concat(messageBuffers)).digest();

        if(!sign.detached.verify(messageBuffer, signatureBuffer, data.intermediary.toBuffer())) {
            throw new SignatureVerificationError("Invalid signature!");
        }

        return Promise.resolve(messageBuffer);

    }

    isValidDataSignature(data: Buffer, signature: string, publicKey: string): Promise<boolean> {
        const hash = createHash("sha256").update(data).digest();
        return Promise.resolve(sign.detached.verify(hash, Buffer.from(signature, "hex"), new PublicKey(publicKey).toBuffer()));
    }

    async isValidInitPayInAuthorization(data: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number): Promise<Buffer> {

        if(prefix!=="claim_initialize") {
            throw new SignatureVerificationError("Invalid prefix");
        }

        const expiryTimestamp = new BN(timeout);
        const currentTimestamp = new BN(Math.floor(Date.now() / 1000));

        const isExpired = expiryTimestamp.sub(currentTimestamp).lt(new BN(ConstantSoltoBTCLN.authorizationGracePeriod));

        if (isExpired) {
            throw new SignatureVerificationError("Authorization expired!");
        }

        //Check correctness of nonce
        const userAccount: any = await this.program.account.userAccount.fetch(this.getUserVaultKey(data.intermediary, data.token));

        if(nonce<=userAccount.claimNonce.toNumber()) {
            throw new SignatureVerificationError("Invalid nonce!");
        }

        const messageBuffers = [
            Buffer.from(prefix, "ascii"),
            Buffer.from(new BN(nonce).toArray("le", 8)),
            data.token.toBuffer(),
            Buffer.from(data.amount.toArray("le", 8)),
            Buffer.from(data.expiry.toArray("le", 8)),
            Buffer.from(data.paymentHash, "hex"),
            Buffer.from([data.kind]),
            Buffer.from(new BN(data.confirmations).toArray("le", 2)),
            Buffer.from(expiryTimestamp.toArray("le", 8)),
        ];
        if(data.payOut) {
            const ata = getAssociatedTokenAddressSync(data.token, data.intermediary);
            messageBuffers.push(Buffer.alloc(1, 1));
            messageBuffers.push(ata.toBuffer())
        } else {
            messageBuffers.push(Buffer.alloc(1, 0));
        }

        const signatureBuffer = Buffer.from(signature, "hex");
        const messageBuffer = createHash("sha256").update(Buffer.concat(messageBuffers)).digest();

        if(!sign.detached.verify(messageBuffer, signatureBuffer, data.intermediary.toBuffer())) {
            throw new SignatureVerificationError("Invalid signature!");
        }

        return messageBuffer;

    }

    async isValidInitAuthorization(data: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number): Promise<Buffer> {

        if(prefix!=="initialize") {
            throw new SignatureVerificationError("Invalid prefix");
        }

        const expiryTimestamp = new BN(timeout);
        const currentTimestamp = new BN(Math.floor(Date.now() / 1000));

        const isExpired = expiryTimestamp.sub(currentTimestamp).lt(new BN(ConstantBTCLNtoSol.authorizationGracePeriod));

        if (isExpired) {
            throw new SignatureVerificationError("Authorization expired!");
        }

        const swapWillExpireTooSoon = data.expiry.sub(currentTimestamp).lt(new BN(ConstantBTCLNtoSol.authorizationGracePeriod).add(new BN(ConstantBTCLNtoSol.claimGracePeriod)));

        if (swapWillExpireTooSoon) {
            throw new SignatureVerificationError("Swap will expire too soon!");
        }

        //Check correctness of nonce
        const userAccount: any = await this.program.account.userAccount.fetch(this.getUserVaultKey(data.offerer, data.token));

        if(nonce<=userAccount.nonce.toNumber()) {
            throw new SignatureVerificationError("Invalid nonce!");
        }

        const messageBuffers = [
            Buffer.from(prefix, "ascii"),
            Buffer.from(new BN(nonce).toArray("le", 8)),
            data.token.toBuffer(),
            data.intermediary.toBuffer(),
            Buffer.from(data.amount.toArray("le", 8)),
            Buffer.from(data.expiry.toArray("le", 8)),
            Buffer.from(data.paymentHash, "hex"),
            Buffer.from(new BN(data.kind || 0).toArray("le", 1)),
            Buffer.from(new BN(data.confirmations || 0).toArray("le", 2)),
            Buffer.from(expiryTimestamp.toArray("le", 8)),
        ];

        const signatureBuffer = Buffer.from(signature, "hex");
        const messageBuffer = createHash("sha256").update(Buffer.concat(messageBuffers)).digest();

        if(!sign.detached.verify(messageBuffer, signatureBuffer, data.offerer.toBuffer())) {
            throw new SignatureVerificationError("Invalid signature!");
        }

        return messageBuffer;

    }

    async createPayWithAuthorizationIx(data: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number, txoHash?: Buffer): Promise<TransactionInstruction[]> {

        const messageBuffer = await this.isValidInitAuthorization(data, timeout, prefix, signature, nonce);

        const paymentHash = Buffer.from(data.paymentHash, "hex");
        const signatureBuffer = Buffer.from(signature, "hex");

        const claimerAta = getAssociatedTokenAddressSync(data.token, data.intermediary);

        let result = await this.program.methods
            .offererInitialize(new BN(nonce), data.amount, data.expiry, paymentHash, new BN(data.kind || 0), new BN(data.confirmations || 0), new BN(0), new BN(timeout), true, txoHash || Buffer.alloc(32, 0))
            .accounts({
                initializer: data.intermediary,
                offerer: data.offerer,
                claimer: data.intermediary,
                claimerTokenAccount: claimerAta,
                mint: data.token,
                userData: this.getUserVaultKey(data.offerer, data.token),
                escrowState: this.getEscrowStateKey(paymentHash),
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
            })
            .instruction();

        const signatureVerificationInstruction = Ed25519Program.createInstructionWithPublicKey({
            message: messageBuffer,
            publicKey: data.offerer.toBuffer(),
            signature: signatureBuffer
        });

        const ixs = [
            signatureVerificationInstruction,
            result
        ];

        try {
            const fetched = await getAccount(this.provider.connection, claimerAta);
        } catch (e) {
            const initATAix = createAssociatedTokenAccountInstruction(
                data.intermediary,
                claimerAta,
                data.intermediary,
                data.token
            );
            ixs.push(initATAix);
        }

        return ixs;

    }

    async createPayWithAuthorizationTx(data: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number, txoHash?: Buffer): Promise<Transaction> {

        const ixs = await this.createPayWithAuthorizationIx(data, timeout, prefix, signature, nonce, txoHash);

        const tx = new Transaction();
        for(let ix of ixs) {
            tx.add(ix);
        }

        return tx;

    }

    async createClaimIx(data: SolanaSwapData, secret: Buffer): Promise<TransactionInstruction> {
        const expiryTimestamp = data.expiry;
        const currentTimestamp = Math.floor(Date.now() / 1000);

        console.log("[EVM.PaymentRequest] Expiry time: ", expiryTimestamp.toString());

        if (expiryTimestamp.sub(new BN(currentTimestamp)).lt(new BN(ConstantBTCLNtoSol.claimGracePeriod))) {
            console.error("[EVM.PaymentRequest] Not enough time to reliably pay the invoice");
            throw new Error("Not enough time to reliably pay the invoice");
        }

        const ata = getAssociatedTokenAddressSync(data.token, data.intermediary);

        const claimIx = await this.program.methods
            .claimerClaim(secret)
            .accounts({
                signer: data.intermediary,
                escrowState: this.getEscrowStateKey(Buffer.from(data.paymentHash, "hex")),
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,

                claimerReceiveTokenAccount: ata,
                vault: this.getVaultKey(data.token),
                vaultAuthority: this.vaultAuthorityKey,
                tokenProgram: TOKEN_PROGRAM_ID,

                userData: null,
                data: null
            })
            .instruction();

        return claimIx;

    }

    async createClaimTx(data: SolanaSwapData, secret: Buffer): Promise<Transaction> {
        const claimIx = await this.createClaimIx(data, secret);

        const tx = new Transaction();
        tx.add(claimIx);

        return tx;
    }

    async createClaimTxs(data: SolanaSwapData, txId: string, vout: number, secretKey: Buffer): Promise<{
        tx: Transaction
        signers?: Signer[]
    }[]> {
        const reversedTxId = Buffer.from(txId, "hex").reverse();

        const merkleProof = await ChainUtils.getTransactionProof(txId);
        const btcBlockhash = await ChainUtils.getBlockHash(merkleProof.block_height);

        const btcRelayResponse = await this.btcRelay.retrieveBlockLogAndBlockheight(btcBlockhash);

        const requiredBlockheight = merkleProof.block_height+data.confirmations-1;

        const txs: {
            tx: Transaction
            signers?: Signer[]
        }[] = [];

        let commitedHeader = btcRelayResponse.header;
        if(btcRelayResponse.height<requiredBlockheight) {
            //Need to synchronize
            const resp = await this.btcRelaySynchronizer.syncToLatestTxs();
            resp.txs.forEach(tx => txs.push({tx}));
            console.log("BTC Relay not synchronized to required blockheight, synchronizing ourselves in "+resp.txs.length+" txs");
            console.log("BTC Relay computed header map: ",resp.computedHeaderMap);
            if(commitedHeader==null) {
                //Retrieve computed header
                commitedHeader = resp.computedHeaderMap[merkleProof.block_height];
            }
        }

        console.log("Target commit header ", commitedHeader);

        const swapDataKey = this.getSwapDataKeyAlt(reversedTxId, secretKey);

        try {
            const fetchedDataAccount = await this.provider.connection.getAccountInfo(swapDataKey.publicKey);
            if(fetchedDataAccount!=null) {
                console.log("Will erase previous data account");
                const eraseTx = await this.program.methods
                    .closeData()
                    .accounts({
                        signer: this.provider.publicKey,
                        data: swapDataKey.publicKey
                    })
                    .transaction();

                txs.push({
                    tx: eraseTx
                });
            }
        } catch (e) {}

        const witnessRawTxBuffer = await ChainUtils.getRawTransaction(txId);

        const btcTx = bitcoin.Transaction.fromBuffer(witnessRawTxBuffer);

        for(let txIn of btcTx.ins) {
            txIn.witness = []; //Strip witness data
        }

        const rawTxBuffer = btcTx.toBuffer();

        const writeData: Buffer = Buffer.concat([
            Buffer.from(new BN(vout).toArray("le", 4)),
            rawTxBuffer
        ]);

        {
            const dataSize = writeData.length;
            const accountSize = 32+dataSize;
            const lamports = await this.provider.connection.getMinimumBalanceForRentExemption(accountSize);

            const accIx = SystemProgram.createAccount({
                fromPubkey: this.provider.publicKey,
                newAccountPubkey: swapDataKey.publicKey,
                lamports,
                space: accountSize,
                programId: this.program.programId
            });

            const initIx = await this.program.methods
                .initData()
                .accounts({
                    signer: this.provider.publicKey,
                    data: swapDataKey.publicKey
                })
                .instruction();

            const initTx = new Transaction();
            initTx.add(accIx);
            initTx.add(initIx);

            txs.push({
                tx: initTx,
                signers: [swapDataKey]
            });
        }

        let pointer = 0;
        while(pointer<writeData.length) {
            const writeLen = Math.min(writeData.length-pointer, 1000);

            const writeTx = await this.program.methods
                .writeData(pointer, writeData.slice(pointer, writeLen))
                .accounts({
                    signer: this.provider.publicKey,
                    data: swapDataKey.publicKey,
                })
                .transaction();
            txs.push({
                tx: writeTx
            });

            pointer += writeLen;
        }

        const reversedMerkleProof: Buffer[] = merkleProof.merkle.map((e) => Buffer.from(e, "hex").reverse());

        const ata = getAssociatedTokenAddressSync(data.token, data.intermediary);

        const verifyIx = await this.btcRelay.createVerifyIx(reversedTxId, data.confirmations, merkleProof.pos, reversedMerkleProof, commitedHeader);
        const claimIx = await this.program.methods
            .claimerClaim(Buffer.alloc(0))
            .accounts({
                signer: data.intermediary,
                escrowState: this.getEscrowStateKey(Buffer.from(data.paymentHash, "hex")),
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,

                claimerReceiveTokenAccount: ata,
                vault: this.getVaultKey(data.token),
                vaultAuthority: this.vaultAuthorityKey,
                systemProgram: SystemProgram.programId,

                userData: null,

                data: swapDataKey.publicKey,
            })
            .instruction();

        const claimTx = new Transaction();
        claimTx.add(verifyIx);
        claimTx.add(claimIx);

        txs.push({
            tx: claimTx
        });

        return txs;

    }

    async init(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number, txoHash?: Buffer, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {

        const tx = await this.createPayWithAuthorizationTx(swapData, timeout, prefix, signature, nonce, txoHash);

        const {blockhash,lastValidBlockHeight} = await this.provider.connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = this.provider.publicKey;
        const signedTx = await this.provider.wallet.signTransaction(tx);
        const txResult = await this.provider.connection.sendRawTransaction(signedTx.serialize());

        if(waitForConfirmation) {
            const res = await this.provider.connection.confirmTransaction({
                signature: txResult,
                blockhash: blockhash,
                lastValidBlockHeight,
                abortSignal
            }, "confirmed");
            if(res.value.err!=null) throw res.value.err;
        }

        return txResult;

    }

    async claimWithSecret(swapData: SolanaSwapData, secret: string, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {

        const tx = await this.createClaimTx(swapData, Buffer.from(secret, "hex"));

        const {blockhash,lastValidBlockHeight} = await this.provider.connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = this.provider.publicKey;
        const signedTx = await this.provider.wallet.signTransaction(tx);
        const txResult = await this.provider.connection.sendRawTransaction(signedTx.serialize());

        if(waitForConfirmation) {
            const res = await this.provider.connection.confirmTransaction({
                signature: txResult,
                blockhash: blockhash,
                lastValidBlockHeight,
                abortSignal
            }, "confirmed");
            if(res.value.err!=null) throw res.value.err;
        }

        return txResult;

    }

    async claimWithTxData(swapData: SolanaSwapData, txid: string, vout: number, secret: string, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {

        const claimTxs = await this.createClaimTxs(swapData, txid, vout, Buffer.from(secret, "hex"));

        const {blockhash, lastValidBlockHeight} = await this.provider.connection.getLatestBlockhash();
        const txs = [];
        for(let tx of claimTxs) {
            tx.tx.recentBlockhash = blockhash;
            tx.tx.feePayer = this.provider.publicKey;
            if(tx.signers!=null) {
                for(let signer of tx.signers) {
                    tx.tx.sign(signer);
                }
            }
            txs.push(tx.tx);
        }
        //Maybe don't wait for TX but instead subscribe to logs, this would improve the experience when user speeds up the transaction by replacing it.
        const signedTxs = await this.provider.wallet.signAllTransactions(txs);

        //TODO: Any of these transactions may fail, due to other relayers syncing the blockchain themselves, or watchtowers claiming the swap for us,
        // however this doesn't mean that the claim request actually failed, should take it into account

        const lastTx = signedTxs.pop();

        for(let tx of signedTxs) {
            const txResult = await this.provider.connection.sendRawTransaction(tx.serialize());
            console.log("Send tx: ", tx);
            await this.provider.connection.confirmTransaction(txResult, "confirmed");
            console.log("Tx confirmed: ", txResult);
        }

        const txResult = await this.provider.connection.sendRawTransaction(lastTx.serialize());
        console.log("Send final tx: ", lastTx);
        console.log("Send final tx sig: ", txResult);

        if(waitForConfirmation) {
            const res = await this.provider.connection.confirmTransaction({
                signature: txResult,
                blockhash: blockhash,
                lastValidBlockHeight,
                abortSignal
            }, "confirmed");
            if(res.value.err!=null) throw res.value.err;
        }

        return txResult;

    }

    async createPayIxs(data: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number): Promise<TransactionInstruction[]> {
        const messageBuffer = await this.isValidInitPayInAuthorization(data, timeout, prefix, signature, nonce);

        const payStatus = await this.getPaymentHashStatus(data.paymentHash);

        if(payStatus!==SwapCommitStatus.NOT_COMMITED) {
            throw new Error("Invoice already being paid for or paid");
        }

        const paymentHash = Buffer.from(data.paymentHash, "hex");

        const ata = getAssociatedTokenAddressSync(data.token, data.offerer);
        const ataIntermediary = getAssociatedTokenAddressSync(data.token, data.intermediary);

        const ixs: TransactionInstruction[] = [];

        const signatureVerificationInstruction = Ed25519Program.createInstructionWithPublicKey({
            message: messageBuffer,
            publicKey: data.intermediary.toBuffer(),
            signature: Buffer.from(signature, "hex")
        });

        console.log("Sig verify: ", signatureVerificationInstruction);

        ixs.push(signatureVerificationInstruction);

        if(data.token.equals(WSOL_ADDRESS)) {
            let balance = new BN(0);
            let accountExists = false;
            try {
                const ataAcc = await getAccount(this.provider.connection, ata);
                if(ataAcc!=null) {
                    accountExists = true;
                    balance = balance.add(new BN(ataAcc.amount.toString()));
                }
            } catch (e) {}
            if(balance.lt(data.amount)) {
                //Need to wrap some more
                const remainder = data.amount.sub(balance);
                if(!accountExists) {
                    //Need to create account
                    ixs.push(createAssociatedTokenAccountInstruction(this.provider.publicKey, ata, this.provider.publicKey, data.token));
                }
                ixs.push(SystemProgram.transfer({
                    fromPubkey: this.provider.publicKey,
                    toPubkey: ata,
                    lamports: remainder.toNumber()
                }));
                ixs.push(createSyncNativeInstruction(ata));
            }
        }

        console.log("Authority key: ", this.vaultAuthorityKey);

        const ix = await this.program.methods
            .offererInitializePayIn(
                new BN(nonce),
                data.amount,
                data.expiry,
                paymentHash,
                new BN(data.kind),
                new BN(data.confirmations),
                new BN(timeout),
                data.nonce,
                data.payOut,
                Buffer.alloc(32, 0)
            )
            .accounts({
                initializer: data.offerer,
                initializerDepositTokenAccount: ata,
                claimer: data.intermediary,
                claimerTokenAccount: ataIntermediary,
                userData: this.getUserVaultKey(data.intermediary, data.token),
                escrowState: this.getEscrowStateKey(paymentHash),
                vault: this.getVaultKey(data.token),
                vaultAuthority: this.vaultAuthorityKey,
                mint: data.token,
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
                tokenProgram: TOKEN_PROGRAM_ID,
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
            })
            .instruction();

        console.log("Created init ix: ", ix);

        ixs.push(ix);

        return ixs;
    }

    async createPayTx(data: SolanaSwapData, authTimeout: string, prefix: string, signature: string, nonce: number): Promise<Transaction> {
        const ixs = await this.createPayIxs(data, authTimeout, prefix, signature, nonce);
        const tx = new Transaction();
        for(let ix of ixs) {
            tx.add(ix);
        }
        return tx;
    }

    async createRefundIx(data: SolanaSwapData, noCheck?: boolean): Promise<TransactionInstruction> {
        if(!noCheck) {
            if(!(await this.isRequestRefundable(data))) {
                throw new Error("Not refundable yet!");
            }
        }

        const ata = getAssociatedTokenAddressSync(data.token, data.offerer);

        let builder = this.program.methods
            .offererRefund(new BN(0))
            .accounts({
                offerer: data.offerer,
                initializer: data.offerer,
                escrowState: this.getEscrowStateKey(Buffer.from(data.paymentHash, "hex")),

                vault: this.getVaultKey(data.token),
                vaultAuthority: this.vaultAuthorityKey,
                initializerDepositTokenAccount: ata,
                tokenProgram: TOKEN_PROGRAM_ID,

                userData: null,

                ixSysvar: null
            });

        if(!data.payOut) {
            builder = builder.remainingAccounts([
                {
                    isSigner: false,
                    isWritable: true,
                    pubkey: this.getUserVaultKey(data.intermediary, data.token)
                }
            ])
        }

        const ix = await builder.instruction();

        return ix;
    }

    async createRefundTx(data: SolanaSwapData, noCheck?: boolean): Promise<Transaction> {
        const ix = await this.createRefundIx(data, noCheck);
        return new Transaction().add(ix);
    }

    async createRefundTxWithAuthorizationIx(data: SolanaSwapData, timeout: string, prefix: string, signature: string, noCheck?: boolean): Promise<TransactionInstruction[]> {
        if(!noCheck) {
            if(!(await this.isCommited(data))) {
                throw new Error("Not correctly committed");
            }
        }

        const messageBuffer = await this.isValidAuthorization(data, timeout, prefix, signature);

        const paymentHash = Buffer.from(data.paymentHash, "hex");
        const signatureBuffer = Buffer.from(signature, "hex");

        const ata = getAssociatedTokenAddressSync(data.token, data.offerer);

        let builder = this.program.methods
            .offererRefund(new BN(timeout))
            .accounts({
                offerer: data.offerer,
                initializer: data.offerer,
                escrowState: this.getEscrowStateKey(paymentHash),

                vault: this.getVaultKey(data.token),
                vaultAuthority: this.vaultAuthorityKey,
                initializerDepositTokenAccount: ata,
                tokenProgram: TOKEN_PROGRAM_ID,

                userData: null,

                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
            });

        if(!data.payOut) {
            builder = builder.remainingAccounts([
                {
                    isSigner: false,
                    isWritable: true,
                    pubkey: this.getUserVaultKey(data.intermediary, data.token)
                }
            ])
        }

        const result = await builder.instruction();

        const signatureVerificationInstruction = Ed25519Program.createInstructionWithPublicKey({
            message: messageBuffer,
            publicKey: data.intermediary.toBuffer(),
            signature: signatureBuffer
        });

        // console.log(signatureVerificationInstruction);

        return [
            signatureVerificationInstruction,
            result
        ];
    }

    async createRefundTxWithAuthorizationTx(data: SolanaSwapData, timeout: string, prefix: string, signature: string, noCheck?: boolean): Promise<Transaction> {

        const ixs = await this.createRefundTxWithAuthorizationIx(data, timeout, prefix, signature, noCheck);
        const tx = new Transaction();
        for(let ix of ixs) {
            tx.add(ix);
        }
        return tx;

    }

    async initPayIn(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {

        const tx = await this.createPayTx(swapData, timeout, prefix, signature, nonce);

        const {blockhash, lastValidBlockHeight} = await this.provider.connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = this.provider.publicKey;
        //Maybe don't wait for TX but instead subscribe to logs, this would improve the experience when user speeds up the transaction by replacing it.
        const signedTx = await this.provider.wallet.signTransaction(tx);
        const txResult = await this.provider.connection.sendRawTransaction(signedTx.serialize(), {
            skipPreflight: true
        });

        if(waitForConfirmation) {
            const res = await this.provider.connection.confirmTransaction({
                signature: txResult,
                blockhash: blockhash,
                lastValidBlockHeight,
                abortSignal
            }, "confirmed");
            if(res.value.err!=null) throw res.value.err;
        }

        return txResult;

    }

    async refund(swapData: SolanaSwapData, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {

        const tx = await this.createRefundTx(swapData);

        const {blockhash, lastValidBlockHeight} = await this.provider.connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = this.provider.publicKey;
        //Maybe don't wait for TX but instead subscribe to logs, this would improve the experience when user speeds up the transaction by replacing it.
        const signedTx = await this.provider.wallet.signTransaction(tx);
        const txResult = await this.provider.connection.sendRawTransaction(signedTx.serialize(), {
            skipPreflight: true
        });

        if(waitForConfirmation) {
            const res = await this.provider.connection.confirmTransaction({
                signature: txResult,
                blockhash: blockhash,
                lastValidBlockHeight,
                abortSignal
            }, "confirmed");
            if(res.value.err!=null) throw res.value.err;
        }

        return txResult;

    }

    async refundWithAuthorization(swapData: SolanaSwapData, timeout: string, prefix: string, signature: string, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {

        const tx = await this.createRefundTxWithAuthorizationTx(swapData, timeout, prefix, signature);

        const {blockhash, lastValidBlockHeight} = await this.provider.connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = this.provider.publicKey;
        //Maybe don't wait for TX but instead subscribe to logs, this would improve the experience when user speeds up the transaction by replacing it.
        const signedTx = await this.provider.wallet.signTransaction(tx);
        const txResult = await this.provider.connection.sendRawTransaction(signedTx.serialize(), {
            skipPreflight: true
        });

        if(waitForConfirmation) {
            const res = await this.provider.connection.confirmTransaction({
                signature: txResult,
                blockhash: blockhash,
                lastValidBlockHeight,
                abortSignal
            }, "confirmed");
            if(res.value.err!=null) throw res.value.err;
        }

        return txResult;

    }

    async initAndClaimWithSecret(data: SolanaSwapData, timeout: string, prefix: string, signature: string, nonce: number, secret: string, waitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string[]> {

        const txCommit = await this.createPayWithAuthorizationTx(data, timeout, prefix, signature, nonce);
        const txClaim = await this.createClaimTx(data, Buffer.from(secret, "hex"));

        const {blockhash, lastValidBlockHeight} = await this.provider.connection.getLatestBlockhash();
        txCommit.recentBlockhash = blockhash;
        txCommit.feePayer = this.provider.publicKey;
        txClaim.recentBlockhash = blockhash;
        txClaim.feePayer = this.provider.publicKey;

        const [signedTxClaim, signedTxCommit] = await this.provider.wallet.signAllTransactions([txClaim, txCommit]);

        console.log("Signed both transactions: ", [signedTxCommit, signedTxClaim]);

        const txResultCommit = await this.provider.connection.sendRawTransaction(signedTxCommit.serialize());

        console.log("Sent commit transaction: ", txResultCommit);

        let res = await this.provider.connection.confirmTransaction({
            signature: txResultCommit,
            blockhash: blockhash,
            lastValidBlockHeight,
            abortSignal
        }, "confirmed");
        if(res.value.err!=null) throw res.value.err;

        console.log("Commit tx confirmed!");

        const txResultClaim = await this.provider.connection.sendRawTransaction(signedTxClaim.serialize());

        console.log("Sent claim transaction: ", txResultClaim);

        if(waitForConfirmation) {
            res = await this.provider.connection.confirmTransaction({
                signature: txResultClaim,
                blockhash: blockhash,
                lastValidBlockHeight,
                abortSignal
            }, "confirmed");
            if(res.value.err!=null) throw res.value.err;
            console.log("Claim tx confirmed!");
            return [txResultCommit, txResultClaim];
        }

        return [txResultCommit, txResultClaim];

    }

    static typeToKind(type: ChainSwapType): number {
        switch (type) {
            case ChainSwapType.HTLC:
                return 0;
            case ChainSwapType.CHAIN:
                return 1;
            case ChainSwapType.CHAIN_NONCED:
                return 2;
        }

        return null;
    }

    createSwapData(type: ChainSwapType, offerer: string, claimer: string, token: TokenAddress, amount: BN, paymentHash: string, expiry: BN, escrowNonce: BN, confirmations: number, payOut: boolean): SolanaSwapData {
        return new SolanaSwapData(
            null,
            offerer==null ? null : new PublicKey(offerer),
            claimer==null ? null : new PublicKey(claimer),
            token,
            amount,
            paymentHash,
            expiry,
            escrowNonce,
            confirmations,
            payOut,
            SolanaClientSwapContract.typeToKind(type),
            null,
            null
        );
    }

    async getIntermediaryReputation(address: string, token?: TokenAddress): Promise<IntermediaryReputationType> {

        const data: any = await this.program.account.userAccount.fetch(this.getUserVaultKey(new PublicKey(address), token || this.WBTC_ADDRESS));

        const response: any = {};

        for(let i=0;i<3;i++) {
            response[i] = {
                successVolume: data.successVolume[i],
                successCount: data.successCount[i],
                failVolume: data.failVolume[i],
                failCount: data.failCount[i],
                coopCloseVolume: data.coopCloseVolume[i],
                coopCloseCount: data.coopCloseCount[i]
            };
        }

        return response;

    }

    async getIntermediaryBalance(address: string, token?: TokenAddress): Promise<BN> {
        const data: any = await this.program.account.userAccount.fetch(this.getUserVaultKey(new PublicKey(address), token || this.WBTC_ADDRESS));

        return data.amount;
    }

    toTokenAddress(address: string): TokenAddress {
        return new PublicKey(address);
    }

    getClaimFee(): BN {
        return new BN(-2707440+5000);
    }

    /**
     * Get the estimated solana fee of the commit transaction
     */
    getCommitFee(): BN {
        return new BN(2707440+10000);
    }

    /**
     * Get the estimated solana transaction fee of the refund transaction
     */
    getRefundFee(): BN {
        return new BN(-2707440+10000);
    }


}

export default SolanaClientSwapContract;