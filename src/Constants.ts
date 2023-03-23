import {BN} from "@project-serum/anchor";
import * as bitcoin from "bitcoinjs-lib";
import {PublicKey} from "@solana/web3.js";

export const ConstantSoltoBTCLN = {
    baseFee: new BN("10"), //Network fee for lightning payment
    fee: new BN("2000"), //Network fee for lightning payment
    min: new BN("1000"),
    max: new BN("1000000"),
    refundGracePeriod: 10*60,
    authorizationGracePeriod: 5*60
};

export const ConstantBTCLNtoSol = {
    min: new BN("1000"),
    max: new BN("1000000"),
    claimGracePeriod: 10*60,
    authorizationGracePeriod: 5*60
};

export const ConstantSoltoBTC = {
    baseFee: new BN("10"),
    fee: new BN("3000"),
    min: new BN("5000"),
    max: new BN("1000000"),
    refundGracePeriod: 10*60,
    authorizationGracePeriod: 5*60,
    network: bitcoin.networks.testnet
};

export const ConstantBTCtoSol = {
    baseFee: new BN("10"),
    fee: new BN("3000"),
    min: new BN("10000"),
    max: new BN("1000000"),
    safetyFactor: 2,
    blocksTillTxConfirms: 12,
    maxConfirmations: 6,
    minSendWindow: 30*60,
    refundGracePeriod: 10*60,
    authorizationGracePeriod: 5*60,
    network: bitcoin.networks.testnet
};

export const Bitcoin = {
    satsMultiplier: new BN("100000000"),
    blockTime: 10*60,
    wbtcToken: new PublicKey("Ag6gw668H9PLQFyP482whvGDoAseBWfgs5AfXCAK3aMj")
};