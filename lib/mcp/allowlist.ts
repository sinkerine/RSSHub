import { RegExpRouter } from 'hono/router/reg-exp-router';
import { SmartRouter } from 'hono/router/smart-router';
import { TrieRouter } from 'hono/router/trie-router';

import type { NamespacesType } from '@/registry-helpers';
import { sortRoutes } from '@/registry-helpers';
import type { Namespace, Route } from '@/types';
import logger from '@/utils/logger';

export interface AllowedRoute {
    pattern: string;
    namespace: string;
    routePath: string;
    route: Route;
    namespaceInfo: Namespace;
}
export interface Allowlist {
    routes: AllowedRoute[];
    unresolved: string[];
    match(path: string): AllowedRoute | undefined;
}
export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

export function validateFeedPath(path: string): PathCheck {
    if (typeof path !== 'string' || path.length === 0 || path.length > 2048 || !path.startsWith('/') || /[?#\s\\]|\/\//.test(path)) {
        return { ok: false, reason: 'Use an absolute feed path without a query, fragment or whitespace.' };
    }
    try {
        if (new URL(path, 'http://localhost').pathname !== path) {
            return { ok: false, reason: 'Path normalization is not allowed.' };
        }
    } catch {
        return { ok: false, reason: 'Invalid feed path.' };
    }
    return { ok: true, path };
}

function mountedPath(namespace: string, routePath: string): string {
    return routePath === '/' ? `/${namespace}` : `/${namespace}${routePath}`;
}

export function resolveAllowlist(patterns: readonly string[], namespaces: NamespacesType): Allowlist {
    const routes: AllowedRoute[] = [];
    const unresolved: string[] = [];
    const names = Object.keys(namespaces).toSorted((a, b) => b.split('/').length - a.split('/').length);
    const namesByLength = names.toSorted((a, b) => b.length - a.length);
    const uniquePatterns = new Set(patterns);
    const resolvedPatterns = new Set<string>();
    for (const pattern of uniquePatterns) {
        const namespace = namesByLength.find((name) => {
            const routePath = pattern === `/${name}` ? '/' : pattern.startsWith(`/${name}/`) ? pattern.slice(name.length + 1) : undefined;
            return routePath !== undefined && Object.hasOwn(namespaces[name].routes || {}, routePath);
        });
        if (!namespace) {
            unresolved.push(pattern);
            continue;
        }
        const routePath = pattern === `/${namespace}` ? '/' : pattern.slice(namespace.length + 1);
        const canonicalPattern = mountedPath(namespace, routePath);
        if (resolvedPatterns.has(canonicalPattern)) {
            continue;
        }

        resolvedPatterns.add(canonicalPattern);
        routes.push({ pattern: canonicalPattern, namespace, routePath, route: namespaces[namespace].routes[routePath], namespaceInfo: namespaces[namespace] });
    }
    const byPattern = new Map(routes.map((route) => [route.pattern, route]));
    const routers = names
        .filter((name) => Object.keys(namespaces[name].routes || {}).length)
        .map((name) => {
            const router = new SmartRouter<string>({ routers: [new RegExpRouter(), new TrieRouter()] });
            const sortedRoutes = sortRoutes(namespaces[name].routes);
            for (const [routePath] of sortedRoutes) {
                const pattern = mountedPath(name, routePath);
                router.add('GET', pattern, pattern);
            }
            return router;
        });
    return {
        routes,
        unresolved,
        match(path) {
            if (!validateFeedPath(path).ok || ['/', '/mcp', '/healthz', '/metrics', '/robots.txt', '/api'].includes(path) || path.startsWith('/api/')) {
                return;
            }
            for (const router of routers) {
                const first = router.match('GET', path)?.[0][0]?.[0];
                if (first) {
                    return byPattern.get(first);
                }
            }
        },
    };
}

export function createAllowlistProvider(options: { patterns: readonly string[]; loadNamespaces: () => Promise<NamespacesType> }): () => Promise<Allowlist> {
    let resolved: Promise<Allowlist> | undefined;
    const load = async () => {
        const namespaces = await options.loadNamespaces();
        const allowlist = resolveAllowlist(options.patterns, namespaces);
        for (const pattern of allowlist.unresolved) {
            logger.warn(`MCP route not found in registry: ${pattern}`);
        }
        return allowlist;
    };
    return async () => {
        resolved ??= load();
        try {
            return await resolved;
        } catch (error) {
            resolved = undefined;
            throw error;
        }
    };
}
