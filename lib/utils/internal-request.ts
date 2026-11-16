import type { Context } from 'hono';

const internalRequestKey: unique symbol = Symbol('rsshub.internal-request');

export interface InternalRequestState {
    error?: unknown;
}
export type InternalRequestEnv = { readonly [internalRequestKey]: InternalRequestState };

export function createInternalRequestEnv(state: InternalRequestState): InternalRequestEnv {
    return { [internalRequestKey]: state };
}

export function getInternalRequestState(ctx: Context): InternalRequestState | undefined {
    return ctx.env?.[internalRequestKey];
}
