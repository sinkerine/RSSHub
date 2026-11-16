import type { InternalRequestState } from '@/utils/internal-request';
import { createInternalRequestEnv } from '@/utils/internal-request';

import type { AppFetch } from './index';

export type DispatchOutcome =
    | { kind: 'data'; data: Record<string, unknown> & { item: unknown[] }; cacheHit: boolean; completedAt: Date }
    | { kind: 'error'; error: unknown; status: number }
    | { kind: 'unsupported'; status: number; reason: string };
export interface FeedDispatcher {
    dispatch(path: string): Promise<DispatchOutcome>;
}

export function createFeedDispatcher(fetch: AppFetch): FeedDispatcher {
    return {
        async dispatch(path) {
            try {
                const state: InternalRequestState = {};
                const response = await fetch(new Request('http://localhost' + path, { method: 'GET' }), createInternalRequestEnv(state));
                if (state.error) {
                    return { kind: 'error', error: state.error, status: response.status };
                }
                if (response.status !== 200) {
                    return { kind: 'unsupported', status: response.status, reason: 'Non-success response' };
                }
                let data: unknown;
                try {
                    data = await response.json();
                } catch {
                    return { kind: 'unsupported', status: response.status, reason: 'Non-JSON response' };
                }
                if (!data || typeof data !== 'object' || !('item' in data) || !Array.isArray(data.item)) {
                    return { kind: 'unsupported', status: response.status, reason: 'No feed item array' };
                }
                return { kind: 'data', data: data as Record<string, unknown> & { item: unknown[] }, cacheHit: response.headers.get('RSSHub-Cache-Status') === 'HIT', completedAt: new Date() };
            } catch (error) {
                return { kind: 'error', error, status: 500 };
            }
        },
    };
}
