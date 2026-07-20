export interface InstagramMedia {
	type: 'image' | 'video';
	url: string;
}

export interface InstagramItem {
	id: string;
	shortcode: string;
	author: string;
	authorId: string;
	desc: string;
	media: InstagramMedia[];
	bookmarked: boolean;
	detailUrl: string;
	raw: Record<string, unknown>;
}

interface MediaNode {
	code: string;
	pk: string;
	id: string;
	caption?: { text?: string } | null;
	video_versions?: Array<{ url: string; type?: string }>;
	image_versions2?: { candidates?: Array<{ url: string }> };
	media_type?: number;
	user?: { username?: string; pk?: string };
	owner_id?: string;
	has_viewer_saved?: boolean;
	__typename?: string;
}

export interface NewApiResponse {
	data: {
		xdt_api__v1__feed__user_timeline_graphql_connection?: {
			edges: Array<{ node: MediaNode }>;
			page_info?: { has_next_page?: boolean; end_cursor?: string };
		};
		user?: {
			edge_saved_media?: {
				edges: Array<{ node: any }>;
				page_info?: { has_next_page?: boolean; end_cursor?: string };
			};
		};
	};
}

export function parseApiResponse(responseData: NewApiResponse, username: string): { items: InstagramItem[]; endCursor: string | null; hasNextPage: boolean } {
	const items: InstagramItem[] = [];
	let endCursor: string | null = null;
	let hasNextPage = false;

	try {
		// Try multiple possible connection keys
		const data = responseData?.data as any || {};
		let conn = null;
		for (const key of Object.keys(data)) {
			if (data[key]?.edges && Array.isArray(data[key].edges)) {
				conn = data[key];
				break;
			}
		}

		const edges = conn?.edges || [];

		// Legacy format fallback
		const legacyEdges = responseData?.data?.user?.edge_saved_media?.edges || [];
		const legacyPageInfo = responseData?.data?.user?.edge_saved_media?.page_info;

		const allEdges = edges.length > 0 ? edges : legacyEdges;

		endCursor = conn?.page_info?.end_cursor || legacyPageInfo?.end_cursor || null;
		hasNextPage = conn?.page_info?.has_next_page || legacyPageInfo?.has_next_page || false;

		for (const edge of allEdges) {
			// Handle nested node.media structure
			const node = edge.node?.media || edge.node;
			if (!node?.code && !node?.pk) continue;

			const media: InstagramMedia[] = [];

			// Video
			if (node.video_versions?.length) {
				const bestVideo = node.video_versions.sort((a: any, b: any) => (b.type === 'video/mp4' ? 1 : 0) - (a.type === 'video/mp4' ? 1 : 0))[0];
				if (bestVideo?.url) media.push({ type: 'video', url: bestVideo.url });
			}

			// Carousel
			if (node.carousel_media?.length) {
				for (const child of node.carousel_media) {
					if (child.video_versions?.length) {
						const bestChild = child.video_versions.sort((a: any, b: any) => (b.type === 'video/mp4' ? 1 : 0) - (a.type === 'video/mp4' ? 1 : 0))[0];
						if (bestChild?.url) media.push({ type: 'video', url: bestChild.url });
					} else if (child.image_versions2?.candidates?.length) {
						media.push({ type: 'image', url: child.image_versions2.candidates[0].url });
					}
				}
			}
			// Single image
			else if (node.image_versions2?.candidates?.length && media.length === 0) {
				media.push({ type: 'image', url: node.image_versions2.candidates[0].url });
			}

			const desc = node.caption?.text || '';

			items.push({
				id: node.code || String(node.pk),
				shortcode: node.code || String(node.pk),
				author: node.user?.username || username,
				authorId: username,
				desc: desc.slice(0, 200),
				media,
				bookmarked: true,
				detailUrl: `https://www.instagram.com/p/${node.code || node.pk}/`,
				raw: node as unknown as Record<string, unknown>
			});
		}
	} catch (e) {
		console.error('[instagram] parseApiResponse error:', (e as Error).message);
	}

	return { items, endCursor, hasNextPage };
}

export function getMediaUrls(item: InstagramItem): Array<{ filename: string; type: string; urls: string[] }> {
	const tasks: Array<{ filename: string; type: string; urls: string[] }> = [];
	const shortcode = item.shortcode;

	if (item.media.length === 0) return tasks;

	if (item.media.length === 1) {
		const m = item.media[0];
		const ext = m.type === 'video' ? 'mp4' : 'jpg';
		tasks.push({
			filename: `${shortcode}.${ext}`,
			type: m.type,
			urls: [m.url]
		});
	} else {
		let idx = 0;
		for (const m of item.media) {
			idx++;
			const ext = m.type === 'video' ? 'mp4' : 'jpg';
			tasks.push({
				filename: `${shortcode}_${idx}.${ext}`,
				type: m.type,
				urls: [m.url]
			});
		}
	}

	return tasks;
}

export interface SavedPostsApiResponse {
	num_results: number;
	more_available: boolean;
	items: Array<{
		media: {
			media_type: number;
			code: string;
			pk: string;
			user?: { username?: string; full_name?: string; pk?: string };
			caption?: { text?: string } | null;
			video_versions?: Array<{ url: string }>;
			image_versions2?: { candidates?: Array<{ url: string }> };
			carousel_media?: Array<{
				video_versions?: Array<{ url: string }>;
				image_versions2?: { candidates?: Array<{ url: string }> };
			}>;
		};
	}>;
}

export function parseSavedPostsResponse(responseData: SavedPostsApiResponse, username: string): { items: InstagramItem[]; hasMore: boolean } {
	const items: InstagramItem[] = [];

	try {
		const savedItems = responseData?.items || [];

		for (const savedItem of savedItems) {
			const media = savedItem.media;
			if (!media?.code) continue;

			const mediaList: InstagramMedia[] = [];

			// Video
			if (media.video_versions?.length) {
				const bestVideo = media.video_versions.sort((a: any, b: any) => (b.type === 'video/mp4' ? 1 : 0) - (a.type === 'video/mp4' ? 1 : 0))[0];
				if (bestVideo?.url) mediaList.push({ type: 'video', url: bestVideo.url });
			}

			// Carousel
			if (media.carousel_media?.length) {
				for (const child of media.carousel_media) {
					if (child.video_versions?.length) {
						const bestChild = child.video_versions.sort((a: any, b: any) => (b.type === 'video/mp4' ? 1 : 0) - (a.type === 'video/mp4' ? 1 : 0))[0];
						if (bestChild?.url) mediaList.push({ type: 'video', url: bestChild.url });
					} else if (child.image_versions2?.candidates?.length) {
						const bestImg = child.image_versions2.candidates.sort((a: any, b: any) => (b.width || 0) - (a.width || 0))[0];
						if (bestImg?.url) mediaList.push({ type: 'image', url: bestImg.url });
					}
				}
			}
			// Single image
			else if (media.image_versions2?.candidates?.length && mediaList.length === 0) {
				const bestImg = media.image_versions2.candidates.sort((a: any, b: any) => (b.width || 0) - (a.width || 0))[0];
				if (bestImg?.url) mediaList.push({ type: 'image', url: bestImg.url });
			}

			const desc = media.caption?.text || '';

			items.push({
				id: media.code,
				shortcode: media.code,
				author: media.user?.full_name || media.user?.username || username,
				authorId: media.user?.username || username,
				desc: desc.slice(0, 200),
				media: mediaList,
				bookmarked: true,
				detailUrl: `https://www.instagram.com/p/${media.code}/`,
				raw: media as unknown as Record<string, unknown>
			});
		}
	} catch (e) {
		console.error('[instagram] parseSavedPostsResponse error:', (e as Error).message);
	}

	return { items, hasMore: responseData?.more_available || false };
}
