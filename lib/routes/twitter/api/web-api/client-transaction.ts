import { ClientTransaction, handleXMigration } from '@lami/x-client-transaction-id';

import logger from '@/utils/logger';

let clientTransactionPromise: Promise<ClientTransaction> | undefined;

const buildClientTransaction = async () => ClientTransaction.create(await handleXMigration());

const getClientTransaction = async () => {
    clientTransactionPromise ??= buildClientTransaction().catch((error) => {
        clientTransactionPromise = undefined;
        throw error;
    });
    return clientTransactionPromise;
};

export const getClientTransactionId = async (method: string, path: string) => {
    try {
        const clientTransaction = await getClientTransaction();
        return await clientTransaction.generateTransactionId(method, path);
    } catch (error) {
        clientTransactionPromise = undefined;
        logger.debug(`twitter debug: failed to generate X-Client-Transaction-Id for ${method} ${path}: ${error instanceof Error ? error.message : error}`);
    }
};
