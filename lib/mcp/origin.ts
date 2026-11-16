import type { Config } from '@/config';

export function checkOrigin(request: Request, mcpConfig: Config['mcp']): Response | undefined {
    const origin = request.headers.get('Origin');
    if (origin !== null && !mcpConfig.allowedOrigins.includes(origin)) {
        return Response.json({ error: 'forbidden_origin' }, { status: 403 });
    }
}
