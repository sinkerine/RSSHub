export class CapacityError extends Error {
    override name = 'McpCapacityError' as const;
    constructor() {
        super('MCP capacity exceeded');
    }
}

export class LimiterAbortError extends Error {
    override name = 'McpLimiterAbortError' as const;
    constructor(
        readonly phase: 'queued' | 'running',
        readonly reason: unknown
    ) {
        super(`MCP call aborted while ${phase}`);
    }
}

export interface LimiterStats {
    active: number;
    queued: number;
    maxConcurrency: number;
    maxQueue: number;
}
export interface Limiter {
    run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T>;
    stats(): LimiterStats;
}
interface Entry {
    start(): void;
}

export function createLimiter({ maxConcurrency, maxQueue }: { maxConcurrency: number; maxQueue: number }): Limiter {
    let active = 0;
    const queue: Entry[] = [];
    const release = () => {
        active--;
        queue.shift()?.start();
    };
    return {
        stats: () => ({ active, queued: queue.length, maxConcurrency, maxQueue }),
        run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
            if (signal.aborted) {
                return Promise.reject(new LimiterAbortError('queued', signal.reason));
            }
            if (active >= maxConcurrency && queue.length >= maxQueue) {
                return Promise.reject(new CapacityError());
            }
            return new Promise<T>((resolve, reject) => {
                let phase: 'queued' | 'running' = 'queued';
                const abort = () => {
                    if (phase === 'queued') {
                        const index = queue.indexOf(entry);
                        if (index !== -1) {
                            queue.splice(index, 1);
                        }
                    }
                    signal.removeEventListener('abort', abort);
                    reject(new LimiterAbortError(phase, signal.reason));
                };
                const execute = async () => {
                    try {
                        resolve(await task());
                    } catch (error) {
                        reject(error);
                    } finally {
                        signal.removeEventListener('abort', abort);
                        release();
                    }
                };
                const entry: Entry = {
                    start() {
                        phase = 'running';
                        active++;
                        // Caller cancellation cannot stop the RSS pipeline. Retain its slot until settlement.
                        void execute();
                    },
                };
                signal.addEventListener('abort', abort, { once: true });
                if (active < maxConcurrency) {
                    entry.start();
                } else {
                    queue.push(entry);
                }
            });
        },
    };
}
