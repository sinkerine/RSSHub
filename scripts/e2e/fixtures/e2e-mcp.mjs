export const namespace = { name: 'MCP E2E fixture', url: 'example.com' };

async function feed(ctx) {
    const response = await fetch(`${process.env.E2E_MCP_UPSTREAM}${ctx.req.path}`.replace('/e2e-mcp/', '/'));
    return response.json();
}

function fail(ctx) {
    const kind = ctx.req.param('kind');
    const error = new Error(
        {
            'rate-limit': 'Fetch failed: https://user:pass@example.com/source?token=hidden',
            'twitter-429': 'Twitter API error: 429',
            upstream: 'Twitter API error: 500',
            config: 'Fixture configuration missing',
            secret: `Source failed ${process.env.ACCESS_KEY} https://user:pass@example.com/source?api_key=hidden`,
        }[kind] || 'Fixture error'
    );
    if (kind === 'rate-limit') {
        Object.defineProperty(error, 'name', { value: 'FetchError' });
        error.statusCode = 429;
        error.response = new Response('', { status: 429, headers: { 'Retry-After': '120' } });
    } else if (kind === 'config') {
        Object.defineProperty(error, 'name', { value: 'ConfigNotFoundError' });
    }
    throw error;
}

export const routes = [
    { path: '/feed/:id', name: 'Feed', handler: feed },
    { path: '/hold/:id', name: 'Held feed', handler: feed },
    { path: '/fail/:kind', name: 'Failure', handler: fail },
    { path: '/empty', name: 'Empty', handler: () => ({ title: 'Empty', link: 'https://example.com', item: [] }) },
    { path: '/empty-ok', name: 'Allowed empty', handler: () => ({ title: 'Empty', link: 'https://example.com', item: [], allowEmpty: true }) },
    { path: '/raw', name: 'Raw', handler: () => new Response('raw') },
];

async function rootFeed() {
    const response = await fetch(`${process.env.E2E_MCP_UPSTREAM}/feed/root`);
    return response.json();
}

async function optionalFeed() {
    const response = await fetch(`${process.env.E2E_MCP_UPSTREAM}/feed/optional`);
    return response.json();
}

export const metadataDescription = `Visit "https://example.com"
See [site](https://example.com)
<a href="https://example.com/docs">docs</a>
Windows C:\\notes\\file
Credential: ${process.env.ACCESS_KEY}
(https://user:pass@example.com/private?api_key=hidden#fragment)`;

routes.push(
    { path: '/', name: 'Canonical root fixture', example: '/e2e-mcp', handler: rootFeed },
    { path: '/:id?', name: 'Optional overlap fixture', handler: optionalFeed },
    {
        path: '/metadata/:id?',
        name: 'Metadata formatting',
        description: metadataDescription,
        parameters: {
            id: {
                description: `Credential: ${process.env.ACCESS_KEY}`,
                default: process.env.ACCESS_KEY,
                options: [{ value: String.raw`C:\notes\file`, label: 'Public path' }],
            },
        },
        handler: () => ({ title: 'Metadata source data', link: 'https://example.com', item: [{ title: 'Source text', link: '/metadata-content', description: process.env.ACCESS_KEY }] }),
    }
);
