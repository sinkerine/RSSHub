import { config } from '@/config';
import { parseToken } from '@/routes/xueqiu/cookies';
import type { Route } from '@/types';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';

export const route: Route = {
    path: '/snb/:id',
    categories: ['finance'],
    example: '/xueqiu/snb/ZH1288184',
    parameters: { id: '组合代码, 可在组合主页 URL 中找到.' },
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['xueqiu.com/P/:id', 'xueqiu.com/p/:id'],
        },
    ],
    name: '组合最新调仓信息',
    maintainers: ['ZhishanZhang'],
    handler,
};

async function handler(ctx) {
    const id = ctx.req.param('id');
    const url = `https://xueqiu.com/p/${id}`;
    const apiUrl = 'https://api.xueqiu.com';
    const configuredCookie = config.xueqiu.cookies;
    const cookie = configuredCookie ?? (await parseToken(url));
    const headers = {
        Cookie: cookie,
        Referer: url,
    };

    const quoteResponse = await ofetch(`${apiUrl}/cubes/quote.json`, {
        query: {
            code: id,
        },
        headers,
    });
    const quote = quoteResponse[id];

    let rebalancing;
    if (configuredCookie) {
        try {
            const history = await ofetch(`${apiUrl}/cubes/rebalancing/history.json`, {
                query: {
                    cube_symbol: id,
                    count: 1,
                    page: 1,
                },
                headers,
            });
            rebalancing = history.list?.[0];
        } catch {
            rebalancing = undefined;
        }
    }

    if (rebalancing) {
        const time = rebalancing.updated_at ?? rebalancing.created_at;
        const description = rebalancing.rebalancing_histories.map((item) => `${item.stock_name}: ${item.prev_weight_adjusted ?? 0}% → ${item.target_weight ?? 0}%`).join('<br>');

        return {
            title: `${quote.name} 的调仓历史`,
            link: url,
            description: `${quote.name} 的组合调仓历史`,
            item: [
                {
                    title: `${quote.name} 的上一笔调仓`,
                    description,
                    pubDate: parseDate(time),
                    link: url,
                    guid: `xueqiu::snb::${id}::${rebalancing.id ?? time}`,
                },
            ],
        };
    }

    const [nav] = await ofetch(`${apiUrl}/cubes/nav_daily/all.json`, {
        query: {
            cube_symbol: id,
        },
        headers,
    });
    const latest = nav.list.at(-1);
    const previous = nav.list.at(-2);
    const dailyChange = previous ? (((latest.value - previous.value) / previous.value) * 100).toFixed(2) : undefined;
    const description = [`净值：${latest.value}`, dailyChange === undefined ? undefined : `较前一日：${Number(dailyChange) >= 0 ? '+' : ''}${dailyChange}%`, `累计收益：${quote.total_gain}%`, `年化收益：${quote.annualized_gain}%`]
        .filter(Boolean)
        .join('<br>');

    return {
        title: `${quote.name} 的组合动态`,
        link: url,
        description: `${quote.name} 的组合动态；配置 XUEQIU_COOKIES 后可获取最新调仓信息。`,
        item: [
            {
                title: `${quote.name} ${latest.date} 净值 ${latest.value}`,
                description,
                pubDate: parseDate(latest.time),
                link: url,
                guid: `xueqiu::snb::${id}::nav::${latest.time}`,
            },
        ],
    };
}
