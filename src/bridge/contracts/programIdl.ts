export const programIdl: any = {
    "version": "0.1.0",
    "name": "test_anchor",
    "instructions": [
        {
            "name": "deposit",
            "accounts": [
                {
                    "name": "initializer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "initializerDepositTokenAccount",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "userData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "mint",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "rent",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "amount",
                    "type": "u64"
                }
            ]
        },
        {
            "name": "withdraw",
            "accounts": [
                {
                    "name": "initializer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "initializerDepositTokenAccount",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "userData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "mint",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "rent",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "amount",
                    "type": "u64"
                }
            ]
        },
        {
            "name": "offererInitializePayIn",
            "accounts": [
                {
                    "name": "initializer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "initializerDepositTokenAccount",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "claimer",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimerTokenAccount",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "mint",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "rent",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "initializerAmount",
                    "type": "u64"
                },
                {
                    "name": "expiry",
                    "type": "u64"
                },
                {
                    "name": "hash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    }
                },
                {
                    "name": "kind",
                    "type": "u8"
                },
                {
                    "name": "confirmations",
                    "type": "u16"
                },
                {
                    "name": "nonce",
                    "type": "u64"
                },
                {
                    "name": "payOut",
                    "type": "bool"
                },
                {
                    "name": "txoHash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    }
                }
            ]
        },
        {
            "name": "offererInitialize",
            "accounts": [
                {
                    "name": "initializer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "userData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "offerer",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimer",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimerTokenAccount",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "mint",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "rent",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "nonce",
                    "type": "u64"
                },
                {
                    "name": "initializerAmount",
                    "type": "u64"
                },
                {
                    "name": "expiry",
                    "type": "u64"
                },
                {
                    "name": "hash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    }
                },
                {
                    "name": "kind",
                    "type": "u8"
                },
                {
                    "name": "confirmations",
                    "type": "u16"
                },
                {
                    "name": "escrowNonce",
                    "type": "u64"
                },
                {
                    "name": "authExpiry",
                    "type": "u64"
                },
                {
                    "name": "signature",
                    "type": {
                        "array": [
                            "u8",
                            64
                        ]
                    }
                },
                {
                    "name": "payOut",
                    "type": "bool"
                },
                {
                    "name": "txoHash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    }
                }
            ]
        },
        {
            "name": "offererRefundPayOut",
            "accounts": [
                {
                    "name": "offerer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "initializer",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "initializerDepositTokenAccount",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": []
        },
        {
            "name": "offererRefund",
            "accounts": [
                {
                    "name": "offerer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "initializer",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "userData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                }
            ],
            "args": []
        },
        {
            "name": "offererRefundWithSignaturePayOut",
            "accounts": [
                {
                    "name": "offerer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "initializer",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "claimer",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "initializerDepositTokenAccount",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "authExpiry",
                    "type": "u64"
                },
                {
                    "name": "signature",
                    "type": {
                        "array": [
                            "u8",
                            64
                        ]
                    }
                }
            ]
        },
        {
            "name": "offererRefundWithSignature",
            "accounts": [
                {
                    "name": "offerer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "initializer",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "claimer",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "userData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "authExpiry",
                    "type": "u64"
                },
                {
                    "name": "signature",
                    "type": {
                        "array": [
                            "u8",
                            64
                        ]
                    }
                }
            ]
        },
        {
            "name": "claimerClaimPayOut",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "offerer",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimerReceiveTokenAccount",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "secret",
                    "type": "bytes"
                }
            ]
        },
        {
            "name": "claimerClaim",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "offerer",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimer",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "userData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "secret",
                    "type": "bytes"
                }
            ]
        },
        {
            "name": "claimerClaimPayOutWithExtData",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "offerer",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimerReceiveTokenAccount",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "data",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultAuthority",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "reversedTxId",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    }
                }
            ]
        },
        {
            "name": "claimerClaimWithExtData",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "offerer",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "claimer",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "userData",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "escrowState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "data",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "reversedTxId",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    }
                }
            ]
        },
        {
            "name": "writeData",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "data",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "reversedTxId",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    }
                },
                {
                    "name": "size",
                    "type": "u32"
                },
                {
                    "name": "data",
                    "type": "bytes"
                }
            ]
        },
        {
            "name": "closeData",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "data",
                    "isMut": true,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "reversedTxId",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    }
                }
            ]
        }
    ],
    "accounts": [
        {
            "name": "EscrowState",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "kind",
                        "type": "u8"
                    },
                    {
                        "name": "confirmations",
                        "type": "u16"
                    },
                    {
                        "name": "nonce",
                        "type": "u64"
                    },
                    {
                        "name": "hash",
                        "type": {
                            "array": [
                                "u8",
                                32
                            ]
                        }
                    },
                    {
                        "name": "initializerKey",
                        "type": "publicKey"
                    },
                    {
                        "name": "payIn",
                        "type": "bool"
                    },
                    {
                        "name": "payOut",
                        "type": "bool"
                    },
                    {
                        "name": "offerer",
                        "type": "publicKey"
                    },
                    {
                        "name": "initializerDepositTokenAccount",
                        "type": "publicKey"
                    },
                    {
                        "name": "claimer",
                        "type": "publicKey"
                    },
                    {
                        "name": "claimerTokenAccount",
                        "type": "publicKey"
                    },
                    {
                        "name": "initializerAmount",
                        "type": "u64"
                    },
                    {
                        "name": "mint",
                        "type": "publicKey"
                    },
                    {
                        "name": "expiry",
                        "type": "u64"
                    }
                ]
            }
        },
        {
            "name": "UserAccount",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "nonce",
                        "type": "u64"
                    },
                    {
                        "name": "amount",
                        "type": "u64"
                    }
                ]
            }
        },
        {
            "name": "Data",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "data",
                        "type": "bytes"
                    }
                ]
            }
        }
    ],
    "events": [
        {
            "name": "InitializeEvent",
            "fields": [
                {
                    "name": "hash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                },
                {
                    "name": "txoHash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                },
                {
                    "name": "nonce",
                    "type": "u64",
                    "index": false
                },
                {
                    "name": "kind",
                    "type": "u8",
                    "index": false
                }
            ]
        },
        {
            "name": "RefundEvent",
            "fields": [
                {
                    "name": "hash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                }
            ]
        },
        {
            "name": "ClaimEvent",
            "fields": [
                {
                    "name": "hash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                },
                {
                    "name": "secret",
                    "type": "bytes",
                    "index": false
                }
            ]
        }
    ],
    "errors": [
        {
            "code": 6000,
            "name": "NotExpiredYet",
            "msg": "Request not expired yet."
        },
        {
            "code": 6001,
            "name": "AlreadyExpired",
            "msg": "Request already expired."
        },
        {
            "code": 6002,
            "name": "InvalidSecret",
            "msg": "Invalid secret provided."
        },
        {
            "code": 6003,
            "name": "InsufficientFunds",
            "msg": "Not enough funds."
        },
        {
            "code": 6004,
            "name": "SignatureVerificationFailed",
            "msg": "Signature verification failed."
        },
        {
            "code": 6005,
            "name": "KindUnknown",
            "msg": "Unknown type of the contract."
        },
        {
            "code": 6006,
            "name": "InvalidTxVerifyProgramId",
            "msg": "Invalid program id for transaction verification."
        },
        {
            "code": 6007,
            "name": "InvalidTxVerifyIx",
            "msg": "Invalid instruction for transaction verification."
        },
        {
            "code": 6008,
            "name": "InvalidTxVerifyTxid",
            "msg": "Invalid txid for transaction verification."
        },
        {
            "code": 6009,
            "name": "InvalidTxVerifyConfirmations",
            "msg": "Invalid confirmations for transaction verification."
        },
        {
            "code": 6010,
            "name": "InvalidnSequence",
            "msg": "Invalid nSequence in tx inputs"
        },
        {
            "code": 6011,
            "name": "InvalidNonce",
            "msg": "Invalid nonce used"
        },
        {
            "code": 6012,
            "name": "InvalidDataAccount",
            "msg": "Invalid data account"
        }
    ],
    "metadata": {
        "address": "4xdY2JN9aBisRCrpz11wEWjosAjLoidxoVRvivJUMuNU"
    }
};