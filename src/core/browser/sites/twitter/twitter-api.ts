export interface TwitterMedia {
	type: string;
	media_url_https?: string;
	video_info?: {
		variants: Array<{
			content_type: string;
			url: string;
			bitrate?: number;
		}>;
	};
}

export interface TwitterUser {
	rest_id: string;
	core: {
		screen_name: string;
		name: string;
	};
}

export interface TwitterTweet {
	rest_id: string;
	core: {
		user_results: {
			result: TwitterUser;
		};
	};
	legacy: {
		full_text: string;
		bookmarked: boolean;
		extended_entities?: {
			media: TwitterMedia[];
		};
	};
}

export interface TwitterItem {
	id: string;
	author: string;
	authorId: string;
	desc: string;
	media: TwitterMedia[];
	bookmarked: boolean;
	detailUrl: string;
	raw: Record<string, unknown>;
}

export interface TwitterApiResponse {
	data: {
		bookmark_timeline_v2: {
			timeline: {
				instructions: Array<{
					type: string;
					entries?: Array<{
						entryId: string;
						content: {
							entryType: string;
							itemContent?: {
								tweet_results: {
									result: TwitterTweet;
								};
							};
						};
					}>;
				}>;
			};
		};
	};
}

export function parseApiResponse(responseData: TwitterApiResponse): TwitterItem[] {
	const items: TwitterItem[] = [];
	try {
		const instructions = responseData?.data?.bookmark_timeline_v2?.timeline?.instructions || [];
		for (const inst of instructions) {
			const entries = inst.entries || [];
			for (const entry of entries) {
				const entryType = entry.content?.entryType;
				if (entryType !== 'TimelineTimelineItem') {
					continue;
				}
				let tweetResult: any = entry.content.itemContent?.tweet_results?.result;
				if (!tweetResult?.rest_id) {
					if (tweetResult?.__typename === 'TweetWithVisibilityResults' && tweetResult.tweet?.rest_id) {
						tweetResult = tweetResult.tweet;
					} else {
						continue;
					}
				}
				const tweet = tweetResult;
				const user = tweet.core?.user_results?.result;
				if (!user) continue;
				const media = tweet.legacy?.extended_entities?.media || [];
				const screenName = user.core?.screen_name || 'unknown';
				const tweetId: string = tweet.rest_id;
				const detailUrl = `https://x.com/${screenName}/status/${tweetId}`;
				items.push({
					id: tweetId,
					author: user.core?.name || screenName,
					authorId: screenName,
					desc: (tweet.legacy?.full_text || '').slice(0, 200),
					media,
					bookmarked: tweet.legacy?.bookmarked || false,
					detailUrl,
					raw: tweet
				});
			}
		}
	} catch (e) {
		console.error('[twitter] parseApiResponse error:', (e as Error).message);
	}
	return items;
}

export function getMediaUrls(item: TwitterItem): Array<{ filename: string; type: string; urls: string[] }> {
	const tasks: Array<{ filename: string; type: string; urls: string[] }> = [];
	const postId = item.id;
	let photoIdx = 0;

	for (const m of item.media) {
		if (m.type === 'video' || m.type === 'animated_gif') {
			const variants = m.video_info?.variants || [];
			const mp4s = variants
				.filter(v => v.content_type === 'video/mp4' && v.url)
				.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
			if (mp4s.length > 0) {
				tasks.push({
					filename: `${postId}_0.mp4`,
					type: 'video',
					urls: [mp4s[0].url]
				});
			}
		} else if (m.type === 'photo') {
			photoIdx++;
			const baseUrl = m.media_url_https || '';
			if (baseUrl) {
				const ext = baseUrl.split('.').pop()?.toLowerCase() || 'jpg';
				const format = ext === 'png' ? 'png' : 'jpg';
				const baseWithoutExt = baseUrl.replace(new RegExp('\\.' + ext + '$'), '');
				const url = baseWithoutExt + '?format=' + format + '&name=large';
				tasks.push({
					filename: `${postId}_${photoIdx}.${format}`,
					type: 'image',
					urls: [url]
				});
			}
		}
	}
	return tasks;
}
