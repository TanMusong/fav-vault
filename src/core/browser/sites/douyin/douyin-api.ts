export interface FetchItem {
	id: string;
	type: number;
	desc: string;
	author: string;
	author_id: number;
	[key: string]: unknown;
}

export interface ApiItem {
	aweme_id: string;
	aweme_type: number;
	desc?: string;
	author_user_id: number;
	author?: { nickname?: string };
	video?: { play_addr?: { url_list?: string[] } };
	images?: Array<{ url_list?: string[]; video?: { play_addr?: { url_list?: string[] } } }>;
}

export interface ApiData {
	aweme_list?: ApiItem[];
	has_more?: 0 | 1;
}

export function getDetailUrl(item: FetchItem): string {
	return item.type === 68
		? `https://www.douyin.com/note/${item.id}`
		: `https://www.douyin.com/video/${item.id}`;
}

export function getDownloadUrls(item: FetchItem): Array<{ filename: string; type: string; urls: string[] }> {
	const tasks: Array<{ filename: string; type: string; urls: string[] }> = [];
	const postId = item.id;

	switch (item.type) {
		case 0:
		case 61:
			{
				const video = item.video as Record<string, unknown> | null;
				const playAddr = video?.play_addr as Record<string, unknown> | undefined;
				const urlList = playAddr?.url_list as string[] | undefined;
				tasks.push({ filename: `${postId}_0.mp4`, type: 'video', urls: urlList || [] });
				break;
			}
		case 68:
			{
				const images = (item.images || []) as Array<Record<string, unknown>>;
				for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
					const img = images[imgIdx];
					const n = imgIdx + 1;
					const imgUrls = (img.url_list as string[]) || [];
					if (imgUrls.length > 0) {
						tasks.push({ filename: `${postId}_${n}.webp`, type: 'image', urls: imgUrls });
					}
					const imgVideo = img.video as Record<string, unknown> | undefined;
					if (imgVideo) {
						const vidAddr = imgVideo.play_addr as Record<string, unknown> | undefined;
						const vidUrls = (vidAddr?.url_list as string[]) || [];
						if (vidUrls.length > 0) {
							tasks.push({ filename: `${postId}_${n}.mp4`, type: 'video', urls: vidUrls });
						}
					}
				}
				break;
			}
	}
	return tasks;
}
