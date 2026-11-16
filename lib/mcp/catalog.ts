import { createCatalog } from '@/magpie/catalog';
import type { Namespace, Route } from '@/types';

import type { AllowedRoute, Allowlist } from './allowlist';
import { clipText } from './text';

export interface RouteSummary {
    path: string;
    namespace: string;
    namespaceName: string;
    name: string;
    example?: string;
    description?: string;
    parameters: Array<{ name: string; optional: boolean; description?: string; default?: string; options?: string[] }>;
    requiresConfig: Array<{ name: string; optional: boolean }>;
}
export interface SearchResult {
    routes: RouteSummary[];
    total: number;
    nextOffset?: number;
}

function summarize({ pattern, namespace, namespaceInfo, route }: AllowedRoute): RouteSummary {
    const requiresConfig = route.features?.requireConfig;
    return {
        path: pattern,
        namespace,
        namespaceName: namespaceInfo.name,
        name: route.name,
        ...(route.example && { example: route.example }),
        ...(route.description && { description: clipText(route.description, 500) }),
        parameters: pattern
            .matchAll(/:(\w+)(\{[^}]+\})?(\?)?/g)
            .toArray()
            .map(([, name, , optional]) => {
                const info = route.parameters?.[name];
                return {
                    name,
                    optional: !!optional,
                    ...(typeof info === 'string'
                        ? { description: info }
                        : info && {
                              description: info.description,
                              ...(info.default !== undefined && { default: info.default }),
                              ...(info.options && { options: info.options.map((option) => option.value) }),
                          }),
                };
            }),
        requiresConfig: Array.isArray(requiresConfig) ? requiresConfig.map(({ name, optional }) => ({ name, optional: !!optional })) : [],
    };
}

export function searchAllowedRoutes(allowlist: Allowlist, { query = '', limit = 10, offset = 0 }: { query?: string; limit?: number; offset?: number }): SearchResult {
    let routes: AllowedRoute[];
    if (query.trim()) {
        const subset: Record<string, Namespace & { routes: Record<string, Route> }> = {};
        for (const entry of allowlist.routes) {
            subset[entry.namespace] ??= { ...entry.namespaceInfo, routes: {} };
            subset[entry.namespace].routes[entry.routePath] = entry.route;
        }
        const byPath = new Map(allowlist.routes.map((entry) => [`/${entry.namespace}${entry.routePath}`, entry]));
        routes = createCatalog(subset)
            .search(query, Infinity)
            .map((entry) => byPath.get(entry.path)!);
    } else {
        routes = allowlist.routes
            .map((entry) => entry.pattern)
            .toSorted()
            .map((pattern) => allowlist.routes.find((entry) => entry.pattern === pattern)!);
    }
    return {
        routes: routes.slice(offset, offset + limit).map((route) => summarize(route)),
        total: routes.length,
        ...(offset + limit < routes.length && { nextOffset: offset + limit }),
    };
}
