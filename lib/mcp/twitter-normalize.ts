import { z } from 'zod';

import { clipText } from './text';

export const authorSchema = z.strictObject({ id: z.string().optional(), username: z.string().optional(), name: z.string().optional() });
export const mediaSchema = z.strictObject({ type: z.enum(['photo', 'video', 'animated_gif']), url: z.string(), previewUrl: z.string().optional(), width: z.number().optional(), height: z.number().optional() });
const quotedShape = {
    id: z.string(),
    url: z.string(),
    text: z.string().max(4000),
    textTruncated: z.boolean(),
    createdAt: z.string().optional(),
    author: authorSchema.optional(),
    media: z.array(mediaSchema),
    links: z.array(z.string()),
};
export const quotedSchema = z.strictObject(quotedShape);
export const tweetSchema = z.strictObject({
    ...quotedShape,
    lang: z.string().optional(),
    isRetweet: z.boolean(),
    isReply: z.boolean(),
    isQuote: z.boolean(),
    isPinned: z.boolean().optional(),
    retweetedBy: authorSchema.optional(),
    replyTo: z.strictObject({ tweetId: z.string(), username: z.string().optional() }).optional(),
    quoted: quotedSchema.optional(),
    hashtags: z.array(z.string()),
    mentions: z.array(z.string()),
    metrics: z.strictObject({ likes: z.number().optional(), retweets: z.number().optional(), replies: z.number().optional(), quotes: z.number().optional() }),
});
export type Tweet = z.infer<typeof tweetSchema>;
export const profileSchema = z.strictObject({ id: z.string(), username: z.string(), name: z.string().optional(), description: z.string().optional(), profileImageUrl: z.string().optional(), url: z.string() });

const string = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
function author(user: any): z.infer<typeof authorSchema> | undefined {
    if (!user) {
        return;
    }
    const result = { ...(string(user.id_str) && { id: user.id_str }), ...(string(user.screen_name) && { username: user.screen_name }), ...(string(user.name) && { name: user.name }) };
    return Object.keys(result).length ? result : undefined;
}
function media(items: any[] = []): Array<z.infer<typeof mediaSchema>> {
    return items.flatMap((item) => {
        if (!['photo', 'video', 'animated_gif'].includes(item.type)) {
            return [];
        }
        const url = item.type === 'photo' ? string(item.media_url_https) : item.video_info?.variants?.filter((v) => v.content_type === 'video/mp4' && string(v.url)).toSorted((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]?.url;
        if (!url) {
            return [];
        }
        const size = item.original_info || item.sizes?.large;
        return {
            type: item.type,
            url,
            ...(item.type !== 'photo' && string(item.media_url_https) && { previewUrl: item.media_url_https }),
            ...(number(size?.width ?? size?.w) !== undefined && { width: size.width ?? size.w }),
            ...(number(size?.height ?? size?.h) !== undefined && { height: size.height ?? size.h }),
        };
    });
}
function core(tweet: any): z.infer<typeof quotedSchema> {
    let text = typeof tweet.full_text === 'string' ? tweet.full_text : typeof tweet.text === 'string' ? tweet.text : '';
    const links: string[] = [];
    const urls = tweet.entities?.urls || [];
    for (const entity of urls) {
        if (!(string(entity.url) && string(entity.expanded_url))) {
            continue;
        }

        text = text.replaceAll(entity.url, () => entity.expanded_url);
        links.push(entity.expanded_url);
    }
    const attachments = tweet.extended_entities?.media || tweet.entities?.media || [];
    for (const item of attachments) {
        if (string(item.url)) {
            text = text.replaceAll(item.url, '');
        }
    }
    text = text.replaceAll(/&(amp|lt|gt);/g, (match) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>' })[match]!);
    const clipped = clipText(text, 4000);
    const user = author(tweet.user);
    const date = tweet.created_at ? new Date(tweet.created_at) : undefined;
    return {
        id: String(tweet.id_str),
        url: `https://x.com/${user?.username || 'i'}/status/${tweet.id_str}`,
        text: clipped,
        textTruncated: clipped.length < text.length,
        ...(date && Number.isFinite(date.getTime()) && { createdAt: date.toISOString() }),
        ...(user && { author: user }),
        media: media(attachments),
        links: [...new Set(links)],
    };
}
export function normalizeTweet(entry: any, pinnedIds?: string[]): Tweet {
    const tweet = entry.retweeted_status || entry;
    const reposter = entry.retweeted_status && author(entry.user);
    return {
        ...core(tweet),
        ...(string(tweet.lang) && { lang: tweet.lang }),
        isRetweet: Boolean(entry.retweeted_status),
        isReply: Boolean(tweet.in_reply_to_status_id_str),
        isQuote: Boolean(tweet.is_quote_status || tweet.quoted_status),
        ...(pinnedIds && { isPinned: pinnedIds.includes(entry.id_str) }),
        ...(reposter && { retweetedBy: reposter }),
        ...(string(tweet.in_reply_to_status_id_str) && { replyTo: { tweetId: tweet.in_reply_to_status_id_str, ...(string(tweet.in_reply_to_screen_name) && { username: tweet.in_reply_to_screen_name }) } }),
        ...(tweet.quoted_status && { quoted: core(tweet.quoted_status) }),
        hashtags: (tweet.entities?.hashtags || []).flatMap((tag) => (string(tag.text) ? [tag.text] : [])),
        mentions: (tweet.entities?.user_mentions || []).flatMap((mention) => (string(mention.screen_name) ? [mention.screen_name] : [])),
        metrics: Object.fromEntries(Object.entries({ likes: tweet.favorite_count, retweets: tweet.retweet_count, replies: tweet.reply_count, quotes: tweet.quote_count }).filter(([, value]) => number(value) !== undefined)),
    };
}
export function normalizeProfile(user: any): z.infer<typeof profileSchema> {
    return {
        id: user.id_str,
        username: user.screen_name,
        ...(string(user.name) && { name: user.name }),
        ...(string(user.description) && { description: user.description }),
        ...(string(user.profile_image_url_https || user.profile_image_url) && { profileImageUrl: user.profile_image_url_https || user.profile_image_url }),
        url: `https://x.com/${user.screen_name}`,
    };
}
