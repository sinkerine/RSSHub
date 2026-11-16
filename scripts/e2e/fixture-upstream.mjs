import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const read = async (name) => JSON.parse(await readFile(new URL(`fixtures/twitter-graphql/${name}.json`, import.meta.url), 'utf8'));

export async function startTwitterFixtureUpstream() {
    const [user, testUser, timeline, searchPages, userPages] = await Promise.all([
        read('user'),
        read('test-user'),
        read('user-tweets'),
        Promise.all([1, 2, 3].map((n) => read(`search-page-${n}`))),
        Promise.all([1, 2, 3].map((n) => read(`user-page-${n}`))),
    ]);
    const requests = [];
    const holds = new Map();
    const failures = new Map();
    const waiters = new Set();
    const server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const operation = url.pathname.split('/').at(-1);
        let variables;
        try {
            variables = JSON.parse(url.searchParams.get('variables'));
        } catch {
            res.writeHead(400).end();
            return;
        }
        const tag = variables?.rawQuery || variables?.userId || variables?.screen_name;
        requests.push({ path: url.pathname, operation, variables, tag, at: Date.now() });
        for (const waiter of waiters) {
            if (!(requests.filter((entry) => entry.tag === waiter.tag).length >= waiter.count)) {
                continue;
            }

            waiters.delete(waiter);
            clearTimeout(waiter.timer);
            waiter.resolve();
        }
        const hold = holds.get(tag);
        if (hold && (!hold.once || !hold.claimed)) {
            hold.claimed = true;
            await hold.promise;
        }
        const failure = failures.get(tag);
        if (failure) {
            res.writeHead(failure, { 'content-type': 'application/json', ...(failure === 429 && { 'retry-after': '120' }) });
            res.end(JSON.stringify({ error: 'Synthetic upstream failure' }));
            return;
        }
        let body;
        const requested = operation === 'UserByScreenName' ? variables?.screen_name : variables?.userId;
        const fixtureProfile = requested === 'rsshub_fixture' || requested === user.data.user.result.rest_id;
        const testProfile = requested === 'rsshub_test' || requested === testUser.data.user.result.rest_id;
        const page = variables?.cursor === undefined ? 0 : variables.cursor === 'page-2' ? 1 : 2;
        if (['UserByScreenName', 'UserByRestId'].includes(operation)) {
            body = fixtureProfile ? user : testProfile ? testUser : { data: { user: { result: null } } };
        } else if (['UserTweets', 'UserTweetsAndReplies'].includes(operation)) {
            body = fixtureProfile ? timeline : testProfile ? userPages[page] : undefined;
        } else if (operation === 'SearchTimeline') {
            body = searchPages[page];
        }
        res.writeHead(body ? 200 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body || { error: 'Unexpected fixture request' }));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        log: () => [...requests],
        hits: (tag) => (tag ? requests.filter((entry) => entry.tag === tag || entry.operation === tag).length : requests.length),
        hold(tag, once = false) {
            holds.set(tag, { ...Promise.withResolvers(), once, claimed: false });
        },
        release(tag) {
            holds.get(tag)?.resolve();
            holds.delete(tag);
        },
        fail(tag, status) {
            if (status) {
                failures.set(tag, status);
            } else {
                failures.delete(tag);
            }
        },
        waitFor(tag, count = 1) {
            if (requests.filter((entry) => entry.tag === tag).length >= count) {
                return Promise.resolve();
            }
            return new Promise((resolve, reject) => {
                const waiter = {
                    tag,
                    count,
                    resolve,
                    timer: setTimeout(() => {
                        waiters.delete(waiter);
                        reject(new Error(`Fixture did not receive ${tag}`));
                    }, 5000),
                };
                waiters.add(waiter);
            });
        },
        async close() {
            for (const hold of holds.values()) {
                hold.resolve();
            }
            for (const waiter of waiters) {
                clearTimeout(waiter.timer);
                waiter.resolve();
            }
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}
