# SolLightning SDK

A javascript client for SolLightning bitcoin <-> solana trustlesss cross-chain swaps.

This project is intended to be used in web-browsers and browser-like environments, it uses browser's local storage to store swap data.

**NOTE: This library is hardcoded to use bitcoin testnet3 and solana devnet, as it is still in alpha stage and is not safe to use for live systems. MAY contain bugs and uncovered edge-cases**

## Installation
```
npm install sollightning-sdk
```

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
    const swapper = new Swapper(anchorProvider, _urlOfIntermediary); //Where URL is the address of the intermediary handling the swaps
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
await swap.commit(anchorProvider);
//Wait for the swap to conclude
const result = await swap.waitForPayment();
if(!result) {
    //Swap failed, money can be refunded
    await swap.refund(anchorProvider);
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
await swap.commit(anchorProvider);
//Wait for the swap to conclude
const result = await swap.waitForPayment();
if(!result) {
    //Swap failed, money can be refunded
    await swap.refund(anchorProvider);
} else {
    //Swap successful
}
```

### Swap BTC -> Solana
```javascript
//Create the swap
const swap = await swapper.createBTCtoSolSwap(_amount);
//Get the bitcoin address and amount required to be sent to that bitcoin address
const receivingAddressOnBitcoin = swap.getAddress();
const amountToBePaidOnBitcoin = swap.getInAmount(); //The amount received MUST match
//Get the QR code (contains the address and amount)
const qrCodeData = swap.getQrData(); //Data that can be displayed in the form of QR code
//Get the amount we will receive on Solana
const amountToBeReceivedOnSolana = swap.getOutAmount();
const fee = swap.getFee();
//Wait for the payment to arrive
await swap.waitForPayment();
//Pay for the swap
await swap.commitAndClaim(anchorProvider);
```

### Swap BTCLN -> Solana
```javascript
//Create the swap
const swap = await swapper.createBTCtoSolSwap(_amount);
//Get the bitcoin lightning network invoice (the invoice contains pre-entered amount)
const receivingLightningInvoice = swap.getAddress();
//Get the QR code (contains the lightning network invoice)
const qrCodeData = swap.getQrData(); //Data that can be displayed in the form of QR code
//Get the amount we will receive on Solana
const amountToBeReceivedOnSolana = swap.getOutAmount();
const fee = swap.getFee();
//Wait for the payment to arrive
await swap.waitForPayment();
//Pay for the swap
await swap.commitAndClaim(anchorProvider);
```