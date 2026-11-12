import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    fetchDocument: vi.fn(),
    create: vi.fn(),
    generate: vi.fn(),
}));

vi.mock('x-client-transaction-id', () => ({
    fetchXDocument: mocks.fetchDocument,
    ClientTransaction: { create: mocks.create },
}));

beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.fetchDocument.mockResolvedValue({});
    mocks.create.mockResolvedValue({ generateTransactionId: mocks.generate });
    mocks.generate.mockResolvedValue('transaction-id');
});

it('initializes through the public API and reuses the initialized instance', async () => {
    const { getClientTransactionId } = await import('../lib/routes/twitter/api/web-api/client-transaction-id');
    await expect(getClientTransactionId('GET', '/first')).resolves.toBe('transaction-id');
    await getClientTransactionId('POST', '/second');
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(await mocks.fetchDocument.mock.results[0].value);
    expect(mocks.generate).toHaveBeenNthCalledWith(1, 'GET', '/first');
    expect(mocks.generate).toHaveBeenNthCalledWith(2, 'POST', '/second');
});

it('shares initialization between concurrent requests', async () => {
    const { getClientTransactionId } = await import('../lib/routes/twitter/api/web-api/client-transaction-id');
    await Promise.all([getClientTransactionId('GET', '/first'), getClientTransactionId('GET', '/second')]);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
});

it('reinitializes when explicitly refreshed or expired', async () => {
    const { config } = await import('../lib/config');
    const { getClientTransactionId } = await import('../lib/routes/twitter/api/web-api/client-transaction-id');
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
        await getClientTransactionId('GET', '/first');
        await getClientTransactionId('GET', '/refresh', true);
        expect(mocks.create).toHaveBeenCalledTimes(2);
        vi.setSystemTime(config.cache.contentExpire * 1000 + 1);
        await getClientTransactionId('GET', '/expired');
        expect(mocks.create).toHaveBeenCalledTimes(3);
    } finally {
        vi.useRealTimers();
    }
});

it('retries after failed initialization without caching the failure', async () => {
    mocks.create.mockRejectedValueOnce(new Error('Initialization failed'));
    const { getClientTransactionId } = await import('../lib/routes/twitter/api/web-api/client-transaction-id');
    await expect(getClientTransactionId('GET', '/first')).rejects.toThrow('Initialization failed');
    await expect(getClientTransactionId('GET', '/retry')).resolves.toBe('transaction-id');
    expect(mocks.create).toHaveBeenCalledTimes(2);
});
