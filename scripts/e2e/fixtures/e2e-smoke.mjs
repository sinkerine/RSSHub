export const namespace = { name: 'E2E smoke', url: 'example.com' };

export const routes = [
    {
        path: '/feed',
        name: 'Fixture feed',
        maintainers: [],
        handler: () => ({
            title: 'RSSHub E2E fixture',
            link: 'https://example.com/',
            item: [
                {
                    title: 'Smoke test article',
                    link: 'https://example.com/article',
                    description: '<p>Local deterministic content</p>',
                },
            ],
        }),
    },
];
