import puppeteer from "../../../lib/puppeteer/puppeteer.js";
import PickSongList from "../model/pick-song.js";
import { formatTime } from '../utils/other.js'
import { COMMON_USER_AGENT, REDIS_YUNZAI_SONGINFO } from "../constants/constant.js";
import { downloadAudio } from "../utils/common.js";
import { redisGetKey, redisSetKey } from "../utils/redis-util.js";
import { checkAndRemoveFile } from "../utils/file.js";
import { sendCustomMusicCard } from "../utils/yunzai-util.js";
import { qqmusic_search, getQQMusicUrl } from "../utils/qqmusic-util.js";
import config from "../model/config.js";

export class qqMusicRequest extends plugin {
    constructor() {
        super({
            name: "R插件-QQ音乐",
            dsc: "QQ音乐点歌专门版",
            priority: 300,
            rule: [
                {
                    reg: '^#(qq|QQ)点歌\\s*(.+?)(?:\\s+([12]))?$|^#(qq|QQ)听([1-9][0-9]*)$',
                    fnc: 'qqPickSong'
                },
                {
                    reg: "^#(qq|QQ)播放\\s*(.+?)(?:\\s+([12]))?$",
                    fnc: "qqPlaySong"
                }
            ]
        });

        this.toolsConfig = config.getConfig("tools");
        // 加载是否转化群语音
        this.isSendVocal = this.toolsConfig.isSendVocal;
        // 是否开启QQ音乐点歌功能
        this.useQQMusicSongRequest = this.toolsConfig.useQQMusicSongRequest;
        this.qqmusicCookie = this.toolsConfig.qqmusicCookie;
        this.qqmusicAudioQuality = this.toolsConfig.qqmusicAudioQuality || 'size_flac';
        // 加载点歌列表长度
        this.songRequestMaxList = this.toolsConfig.songRequestMaxList;
        // 视频保存路径
        this.defaultPath = this.toolsConfig.defaultPath;
    }

    /**
     * 获取下载路径
     */
    getCurDownloadPath(e = null) {
        if (!e) return this.defaultPath;
        if (e.isGroup) {
            return `${this.defaultPath}${e.group_id}`;
            // return `data/rcmp4/${e.group_id}`;
        }
        return `${this.defaultPath}${e.user_id}`;
    }

    async uploadGroupFile(e, path) {
        try {
            await e.bot.sendApi("upload_group_file", {
                group_id: e.group_id,
                file: path,
                name: path.split('/').pop()
            });
        } catch (error) {
            logger.error('上传群文件失败', error);
        }
    }

    async qqPickSong(e) {
        if (!this.useQQMusicSongRequest) {
            logger.info('当前未开启QQ音乐点歌');
            return false;
        }

        let group_id = e.group_id;
        if (!group_id) return;

        let songInfo = await redisGetKey(REDIS_YUNZAI_SONGINFO) || [];
        const saveId = songInfo.findIndex(item => item.group_id === e.group_id);
        let musicDate = { 'group_id': group_id, data: [] };

        const match = e.msg.match(/^#(qq|QQ)点歌\s*(.+?)(?:\s+([12]))?$|^#(qq|QQ)听([1-9][0-9]*)$/);
        if (match && match[2]) {
            const songKeyWord = match[2];
            let searchCount = this.songRequestMaxList;

            let res = await qqmusic_search(songKeyWord, 1, searchCount, this.qqmusicCookie);
            if (res && res.data && res.data.length > 0) {
                for (const info of res.data) {
                    musicDate.data.push({
                        'id': info.mid,
                        'songName': info.name || info.title,
                        'singerName': info.singer?.[0]?.name,
                        'duration': formatTime(info.interval),
                        'cover': `http://y.gtimg.cn/music/photo_new/T002R300x300M000${info.album?.mid}.jpg`,
                        'type': 'qqmusic',
                        'raw': info
                    });
                }

                if (saveId == -1) {
                    songInfo.push(musicDate);
                } else {
                    songInfo[saveId] = musicDate;
                }

                await redisSetKey(REDIS_YUNZAI_SONGINFO, songInfo);
                const data = await new PickSongList(e).getData(musicDate.data);
                let img = await puppeteer.screenshot("pick-song", data);
                e.reply(img);
            } else {
                e.reply('暂未找到你想听的歌哦~');
            }
        } else if (await redisGetKey(REDIS_YUNZAI_SONGINFO) != []) {
            let pickNumberMatch = e.msg.replace(/\s+/g, "").match(/^#(qq|QQ)听(\d+)/);
            if (pickNumberMatch) {
                const pickNumber = pickNumberMatch[2] - 1;
                let songInfo = await redisGetKey(REDIS_YUNZAI_SONGINFO);
                const saveId = songInfo.findIndex(item => item.group_id === e.group_id);

                if (saveId !== -1 && songInfo[saveId].data[pickNumber]) {
                    const selectedSong = songInfo[saveId].data[pickNumber];
                    if (selectedSong.type !== 'qqmusic') {
                        e.reply('你选择的不是QQ音乐，请重新搜索或使用对应的播放指令');
                        return;
                    }
                    this.qqMusicPlay(e, selectedSong.raw, songInfo[saveId].data, pickNumber);
                }
            }
        }
    }

    async qqPlaySong(e) {
        if (!this.useQQMusicSongRequest) {
            logger.info('当前未开启QQ音乐点歌');
            return;
        }

        let group_id = e.group_id;
        if (!group_id) return;

        let songInfo = [];
        const match = e.msg.match(/^#(qq|QQ)播放\s*(.+?)(?:\s+([12]))?$/);
        if (match) {
            const songKeyWord = match[2];
            let res = await qqmusic_search(songKeyWord, 1, 1, this.qqmusicCookie);
            if (res && res.data && res.data.length > 0) {
                const info = res.data[0];
                songInfo.push({
                    'id': info.mid,
                    'songName': info.name || info.title,
                    'singerName': info.singer?.[0]?.name,
                    'duration': formatTime(info.interval),
                    'cover': `http://y.gtimg.cn/music/photo_new/T002R300x300M000${info.album?.mid}.jpg`,
                    'type': 'qqmusic',
                    'raw': info
                });
                this.qqMusicPlay(e, info, songInfo, 0);
            } else {
                e.reply('暂未找到你想听的歌哦~')
            }
        }
    }

    async qqMusicPlay(e, rawInfo, songInfo, pickNumber = 0) {
        const title = songInfo[pickNumber].singerName + '-' + songInfo[pickNumber].songName;
        let ext = 'mp3';
        let url = '';

        try {
            let resp = await getQQMusicUrl(rawInfo, this.qqmusicCookie, this.qqmusicAudioQuality, String(e.user_id || "0"));
            if (resp.url) {
                url = resp.url;
                ext = resp.ext;
            } else {
                logger.error("未能获取到QQ音乐播放链接");
                e.reply("未能获取到QQ音乐播放链接，可能是CK已失效或由于版权下架！");
                return;
            }
        } catch (error) {
            logger.error(error);
            e.reply("获取QQ音乐失败！");
            return;
        }

        let cardSentSuccessfully = false;
        try {
            const jumpUrl = `https://y.qq.com/n/ryqq/songDetail/${rawInfo.mid}`;
            await sendCustomMusicCard(e, jumpUrl, url, songInfo[pickNumber].songName, songInfo[pickNumber].cover);
            cardSentSuccessfully = true;
        } catch (error) {
            logger.error("发送QQ音乐卡片失败，将尝试发送文件/语音", error);
            cardSentSuccessfully = false;
        }

        downloadAudio(url, this.getCurDownloadPath(e), title, 'follow', ext)
            .then(async path => {
                if (!cardSentSuccessfully) {
                    try {
                        await this.uploadGroupFile(e, path);
                        if (ext != 'mp4' && ext != 'flac' && this.isSendVocal) {
                            await e.reply(segment.record(path));
                        }
                    } finally {
                        await checkAndRemoveFile(path);
                    }
                }
            })
            .catch(err => {
                logger.error(`下载QQ音乐失败，错误信息为: ${err}`);
            });
    }
}
