import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import type { TweetPage } from '@/routes/twitter/api';
import api from '@/routes/twitter/api';

import type { TwitterBackend } from './cursor';

export interface TwitterSource {
    backend: TwitterBackend;
    search(query: string, options?: { cursor?: string }): Promise<TweetPage>;
    userTweets(user: string, includeReplies: boolean, options?: { cursor?: string }): Promise<TweetPage & { user: any }>;
    getTweet(user: string, tweetId: string): Promise<any[]>;
}
export function createTwitterSource(): TwitterSource {
    const backend = config.twitter.thirdPartyApi || config.twitter.authToken?.length ? 'web' : config.twitter.consumerKey && config.twitter.consumerSecret ? 'developer' : 'web';
    return {
        backend,
        async search(query, options) {
            await api.init();
            return api.getSearchPage(query, options)!;
        },
        async userTweets(user, includeReplies, options) {
            await api.init();
            const profile = await api.getUser(user);
            const page = await (includeReplies ? api.getUserTweetsAndRepliesPage(user, options) : api.getUserTweetsPage(user, options))!;
            return { ...page, user: profile };
        },
        async getTweet(user, tweetId) {
            if (backend === 'web' && !config.twitter.authToken?.some(Boolean)) {
                throw new ConfigNotFoundError('No valid Twitter token found');
            }
            await api.init();
            return api.getTweetDetail(user, tweetId)!;
        },
    };
}
