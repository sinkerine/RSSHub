import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';

import devApi from './developer-api/api';
// import mobileApi from './mobile-api/api';
import webApi from './web-api/api';
import type { ApiParams } from './web-api/utils';

const enableThirdPartyApi = config.twitter.thirdPartyApi;
// const enableMobileApi = config.twitter.username && config.twitter.password;
const enableWebApi = config.twitter.authToken;
const enableDeveloperApi = config.twitter.consumerKey && config.twitter.consumerSecret;

type ApiItem = (id: string, params?: ApiParams) => Promise<any> | null;

export interface TweetPage {
    tweets: any[];
    nextCursor?: string;
}
export interface TwitterApi {
    getSearchPage(query: string, options?: { cursor?: string }): Promise<TweetPage> | null;
    getUserTweetsPage(user: string, options?: { cursor?: string }): Promise<TweetPage> | null;
    getUserTweetsAndRepliesPage(user: string, options?: { cursor?: string }): Promise<TweetPage> | null;
    getTweetDetail(user: string, tweetId: string): Promise<any[]> | null;
    init: () => void | Promise<void>;
    getUser: ApiItem;
    getUserTweets: ApiItem;
    getUserTweetsAndReplies: ApiItem;
    getUserMedia: ApiItem;
    getUserLikes: ApiItem;
    getUserTweet: ApiItem;
    getSearch: ApiItem;
    getList: ApiItem;
    getHomeTimeline: ApiItem;
    getHomeLatestTimeline: ApiItem;
}

let api: TwitterApi = {
    getSearchPage: () => null,
    getUserTweetsPage: () => null,
    getUserTweetsAndRepliesPage: () => null,
    getTweetDetail: () => null,
    init: () => {
        throw new ConfigNotFoundError('Twitter API is not configured');
    },
    getUser: () => null,
    getUserTweets: () => null,
    getUserTweetsAndReplies: () => null,
    getUserMedia: () => null,
    getUserLikes: () => null,
    getUserTweet: () => null,
    getSearch: () => null,
    getList: () => null,
    getHomeTimeline: () => null,
    getHomeLatestTimeline: () => null,
};

if (enableThirdPartyApi || enableWebApi) {
    api = webApi;
} else if (enableDeveloperApi) {
    api = devApi;
}

export default api;
