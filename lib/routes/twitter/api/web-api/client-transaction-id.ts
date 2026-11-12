import { ClientTransaction, fetchXDocument } from 'x-client-transaction-id';

import { config } from '@/config';

let clientTransaction: ClientTransaction | undefined;
let expiresAt = 0;
let initialization: Promise<ClientTransaction> | undefined;

// Keep the initialized instance: the library's private key layout is not a serialization API.
const getClientTransaction = async (refresh: boolean) => {
    if (!refresh && clientTransaction && Date.now() < expiresAt) {
        return clientTransaction;
    }
    initialization ??= (async () => {
        const document = await fetchXDocument();
        const transaction = await ClientTransaction.create(document);
        clientTransaction = transaction;
        expiresAt = Date.now() + config.cache.contentExpire * 1000;
        return transaction;
    })();
    try {
        return await initialization;
    } finally {
        // Failed initialization can be retried by the next request.
        initialization = undefined;
    }
};

// Refresh the instance after X rejects a transaction ID with 404.
export const getClientTransactionId = async (method: string, path: string, refresh = false) => {
    const transaction = await getClientTransaction(refresh);
    return transaction.generateTransactionId(method, path);
};
