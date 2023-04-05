# SolLightning SDK

An overview of the whole system is available [here](https://github.com/adambor/SolLightning-readme)

A javascript client for SolLightning bitcoin <-> solana trustlesss cross-chain swaps.

This project is intended to be used in web-browsers and browser-like environments, it uses browser's local storage to store swap data.

**NOTE: This library is hardcoded to use bitcoin testnet3 and solana devnet, as it is still in alpha stage and is not safe to use for live systems. MAY contain bugs and uncovered edge-cases**

## Installation
```
npm install sollightning-sdk
```

## Run the intermediary node
Is the node handling the Bitcoin <-> Solana cross-chain swaps. Implementation [here](https://github.com/adambor/SolLightning-Intermediary)

For now this SDK needs to configured as to which intermediary node to use. In the future there should be a registry containing all the nodes (with their reputation and swap fees) so client SDK can choose the desired node itself automatically, or try sending the swap request to multiple nodes, should one of them fail or not have enough liquidity.

## How to use?
### Initialization
1. Get the wallet and connection
    ```javascript
    //React, using solana wallet adapter
    const wallet = useAnchorWallet();
    const {connection} = useConnection();
    ```
    or
    ```javascript
    //Creating a wallet and connection from scratch
    const signer = Keypair.fromSecretKey(_privateKey); //Or Keypair.generate() to generate new one
    const wallet = new Wallet(signer);   
    const connection = new Connection(_solanaRpcUrl, "processed");
    ```
2. Create AnchorProvider and initialize swapper
    ```javascript
    //Create anchor provider
    const anchorProvider = new AnchorProvider(connection, wallet, {preflightCommitment: "processed"});
    //Create the swapper instance
    const swapper = new Swapper(anchorProvider, _urlOfIntermediary, _wbtcTokenPubkey); //URL of the running intermediary node instance, and token mint pubkey (address) of the WBTC token minted on devnet (see intermediary node's instructions)
    //Initialize the swapper
    await swapper.init();
    ```

### Swap Solana -> BTC
```javascript
//Create the swap
const swap = await swapper.createSolToBTCSwap(_address, _amount);
//Get the amount required to pay and fee
const amountToBePaid = swap.getInAmount();
const fee = swap.getFee();
//Pay for the swap
await swap.commit();
//Wait for the swap to conclude
const result = await swap.waitForPayment();
if(!result) {
    //Swap failed, money can be refunded
    await swap.refund();
} else {
    //Swap successful
}
```

### Swap Solana -> BTCLN
```javascript
//Create the swap
const swap = await swapper.createSolToBTCLNSwap(_lightningInvoice);
//Get the amount required to pay and fee
const amountToBePaid = swap.getInAmount();
const fee = swap.getFee();
//Pay for the swap
await swap.commit();
//Wait for the swap to conclude
const result = await swap.waitForPayment();
if(!result) {
    //Swap failed, money can be refunded
    await swap.refund();
} else {
    //Swap successful
}
```

### Swap BTC -> Solana
```javascript
//Create the swap
const swap = await swapper.createBTCtoSolSwap(_amount);
const amountToBePaidOnBitcoin = swap.getInAmount(); //The amount received MUST match
const amountToBeReceivedOnSolana = swap.getOutAmount(); //Get the amount we will receive on Solana
const fee = swap.getFee();

//Once client is happy with the fee
await swap.commit();

//Get the bitcoin address and amount required to be sent to that bitcoin address
const receivingAddressOnBitcoin = swap.getAddress();
//Get the QR code (contains the address and amount)
const qrCodeData = swap.getQrData(); //Data that can be displayed in the form of QR code
//Get the timeout (in UNIX millis), the transaction should be made in under this timestamp, and with high enough fee for the transaction to confirm quickly
const expiryTime = swap.getTimeoutTime();

try {
    //Wait for the payment to arrive
    await swap.waitForPayment(null, null, (txId: string, confirmations: number, targetConfirmations: number) => {
        //Updates about the swap state, txId, current confirmations of the transaction, required target confirmations, amount of the transaction received, updated totalFee (as on-chain fees may change), and resulting amount of token received.
    });
    //Claim the swap funds
    await swap.claim();
} catch(e) {
    //Error occurred while waiting for payment
}
```

### Swap BTCLN -> Solana
```javascript
//Create the swap
const swap = await swapper.createBTCLNtoSolSwap(_amount);
//Get the bitcoin lightning network invoice (the invoice contains pre-entered amount)
const receivingLightningInvoice = swap.getAddress();
//Get the QR code (contains the lightning network invoice)
const qrCodeData = swap.getQrData(); //Data that can be displayed in the form of QR code
//Get the amount we will receive on Solana
const amountToBeReceivedOnSolana = swap.getOutAmount();
const fee = swap.getFee();
try {
    //Wait for the payment to arrive
    await swap.waitForPayment();
    //Claim the swap funds
    await swap.commitAndClaim();
} catch(e) {
    //Error occurred while waiting for payment
}
```

### Get refundable swaps
You can refund the swaps in one of two cases:
* In case intermediary is non-cooperative and goes offline, you can claim the funds from the swap contract back after some time.
* In case intermediary tried to pay but was unsuccessful, so he sent you signed message with which you can refund now without waiting.

This call can be checked on every startup and periodically every few minutes.
```javascript
//Get the swaps
const refundableSwaps = await swapper.getRefundableSwaps();
//Refund all the swaps
for(let swap of refundableSwaps) {
    await swap.refund();
}
```

### Get claimable swaps
Returns swaps that are ready to be claimed by the client, this can happen if client closes the application when a swap is in-progress and the swap is concluded while the client is offline.

```javascript
//Get the swaps
const claimableSwaps = await swapper.getClaimableSwaps();
//Claim all the claimable swaps
for(let swap of claimableSwaps) {
    await swap.commitAndClaim();
}
```
